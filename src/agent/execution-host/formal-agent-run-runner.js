'use strict'

// @ts-check

const { canonicalize } = require('../../runtime/storage-worker/canonical-json')
const { assertModelUsage } = require('../contracts/model-access-core')
const { getRecipe, validateRecipeOutput } = require('../contracts/recipes')
const { createControlledToolRuntime } = require('./controlled-tool-runtime')
const { createToolAuditRuntime } = require('./tool-audit-runtime')
const { AgentLoopExecutor } = require('./agent-loop')

const TARGET_RECIPES = new Set(['summary.minutes', 'qa.answer'])
const RETRYABLE_ERRORS = new Set([
  'AGENT_PROVIDER_RATE_LIMITED', 'AGENT_PROVIDER_UNAVAILABLE', 'AGENT_PROVIDER_TIMEOUT',
  'AGENT_WORKER_EXITED', 'AGENT_INTERNAL_FAILURE'
])
const TERMINAL_ERRORS = new Set([
  'AGENT_OUTPUT_INVALID', 'AGENT_BUDGET_EXCEEDED', 'AGENT_PERMISSION_DENIED', 'AGENT_REQUEST_INVALID'
])

function codedError (code) {
  const error = new Error(code)
  error.code = code
  return error
}

function exactObject (value, keys, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw codedError('AGENT_REQUEST_INVALID')
  const allowed = new Set([...keys, ...optional])
  const actual = Object.keys(value)
  if (actual.some((key) => !allowed.has(key)) || keys.some((key) => !Object.hasOwn(value, key))) {
    throw codedError('AGENT_REQUEST_INVALID')
  }
  return value
}

function outputValue (value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Object.hasOwn(value, 'output')) return value.output
    if (Object.hasOwn(value, 'result')) return value.result
    if (typeof value.text === 'string') {
      try { return JSON.parse(value.text) } catch { throw codedError('AGENT_OUTPUT_INVALID') }
    }
    if (Object.hasOwn(value, 'schemaVersion')) return value
  }
  throw codedError('AGENT_OUTPUT_INVALID')
}

function usageValue (value, enabled) {
  if (enabled === false || value === undefined || value === null) return null
  try {
    assertModelUsage(value)
    return value
  } catch {
    return null
  }
}

function promptForInput (input, userPrompt) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.events) || typeof userPrompt !== 'string') {
    throw codedError('AGENT_REQUEST_INVALID')
  }
  const payload = {
    userPrompt,
    transcript: {
      sourceKind: input.sourceKind || 'session',
      sessionId: input.sessionId,
      transcriptVersion: input.transcriptVersion,
      inputWatermark: input.inputWatermark,
      inputDigest: input.inputDigest,
      events: input.events.map((event) => ({
        eventOrder: event.eventOrder,
        segmentId: event.segmentId,
        text: event.text
      }))
    }
  }
  let prompt
  try { prompt = canonicalize(payload) } catch { throw codedError('AGENT_REQUEST_INVALID') }
  if (Buffer.byteLength(prompt, 'utf8') > 15000) throw codedError('AGENT_BUDGET_EXCEEDED')
  return prompt
}

function normalizedErrorCode (error) {
  if (error?.code === 'AGENT_CANCELLED' || error?.code === 'TOOL_CANCELLED') return 'AGENT_CANCELLED'
  if (error?.code === 'TOOL_BUDGET_EXCEEDED') return 'AGENT_BUDGET_EXCEEDED'
  if (error?.code === 'TOOL_SCOPE_DENIED') return 'AGENT_PERMISSION_DENIED'
  if (error?.code === 'TOOL_TIMEOUT') return 'AGENT_PROVIDER_TIMEOUT'
  if (RETRYABLE_ERRORS.has(error?.code) || TERMINAL_ERRORS.has(error?.code)) return error.code
  return 'AGENT_INTERNAL_FAILURE'
}

class FormalAgentRunRunner {
  constructor (options = {}) {
    if (!options.storage || typeof options.storage.failFormalAgentRun !== 'function') {
      throw new TypeError('formal Agent storage adapter is required')
    }
    if (!options.personalContext || typeof options.personalContext.readSessionInput !== 'function' ||
        typeof options.personalContext.readToolContext !== 'function') {
      throw new TypeError('personal-context execution adapter is required')
    }
    if (!options.modelAccess || typeof options.modelAccess.bind !== 'function') {
      throw new TypeError('model access runtime is required')
    }
    if (!options.interactions || typeof options.interactions.terminalize !== 'function' ||
        typeof options.interactions.startToolCall !== 'function' ||
        typeof options.interactions.finishToolCall !== 'function') {
      throw new TypeError('interaction execution adapter is required')
    }
    this.storage = options.storage
    this.personalContext = options.personalContext
    this.modelAccess = options.modelAccess
    this.interactions = options.interactions
    this.promptProvider = typeof options.promptProvider === 'function' ? options.promptProvider : () => null
    this.onSettled = typeof options.onSettled === 'function' ? options.onSettled : () => {}
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.resolveContext = typeof this.personalContext.resolve === 'function' ? this.personalContext.resolve : null
    if (typeof options.loopFactory === 'function') {
      this.loopFactory = options.loopFactory
    } else if (typeof this.modelAccess.createLoopAdapter === 'function') {
      this.loopFactory = (binding) => new AgentLoopExecutor({ adapter: this.modelAccess.createLoopAdapter(binding) })
    } else if (options.loop && typeof options.loop.agentLoop === 'function') {
      this.loopFactory = () => options.loop
    } else {
      throw new TypeError('agent loop factory is required')
    }
  }

  async toolsForRun (recipe, binding, interactionId, attemptIdentity, signal) {
    const context = await this.personalContext.readToolContext({ runId: attemptIdentity.runId })
    const controlled = createControlledToolRuntime({ context, signal })
    const audited = createToolAuditRuntime({
      interactionId,
      recipeId: recipe.recipeId,
      recipeVersion: recipe.recipeVersion,
      attempt: attemptIdentity.attempt,
      tools: controlled.toolsForRecipe(recipe.recipeId, recipe.recipeVersion),
      budget: binding.budget,
      interactions: this.interactions,
      signal,
      now: this.now
    })
    return audited.tools()
  }

  async terminalizeFailure (interactionId, code, durationMs) {
    try {
      return await this.interactions.terminalize({
        interactionId, terminalReason: 'failed', errorCode: code,
        result: null, usage: null, durationMs
      })
    } catch {
      return null
    }
  }

  async run (job) {
    exactObject(job, ['recipeId', 'source', 'attemptIdentity'], ['interactionId', 'requestedBy', 'signal', 'runId'])
    if (!TARGET_RECIPES.has(job.recipeId) || job.requestedBy !== undefined && job.requestedBy !== 'user') {
      throw codedError('AGENT_REQUEST_INVALID')
    }
    if (job.runId !== undefined && job.runId !== job.attemptIdentity.runId) throw codedError('AGENT_REQUEST_INVALID')
    if (typeof job.interactionId !== 'string' || job.interactionId.length === 0) {
      await this.storage.failFormalAgentRun({ attemptIdentity: job.attemptIdentity, errorCode: 'AGENT_REQUEST_INVALID' })
      return null
    }
    const startedAt = this.now()
    let terminalReason = null
    try {
      const recipe = getRecipe(job.recipeId, '1')
      const userPrompt = this.promptProvider(job.attemptIdentity.runId)
      if (typeof userPrompt !== 'string' || userPrompt.length === 0) throw codedError('AGENT_REQUEST_INVALID')
      if (job.signal?.aborted) throw codedError('AGENT_CANCELLED')
      const binding = await this.modelAccess.bind({
        runId: job.attemptIdentity.runId,
        recipeId: recipe.recipeId,
        recipeVersion: recipe.recipeVersion,
        executionForm: 'agent_loop'
      })
      const input = await this.personalContext.readSessionInput(job.source)

      if (this.resolveContext) {
        await this.resolveContext({
          scope: { kind: 'session', reference: input.sessionId },
          semantic_keys: [],
          aliases: []
        })
      }
      const prompt = promptForInput(input, userPrompt)
      const tools = await this.toolsForRun(recipe, binding, job.interactionId, job.attemptIdentity, job.signal)
      const loop = await this.loopFactory(binding)
      if (!loop || typeof loop.agentLoop !== 'function') throw codedError('AGENT_INTERNAL_FAILURE')
      const result = await loop.agentLoop({
        recipeId: recipe.recipeId,
        recipeVersion: recipe.recipeVersion,
        prompt,
        resolvedModel: binding,
        tools,
        signal: job.signal,
        budget: binding.budget,
        usageReporting: binding?.capabilities?.usageReporting !== false
      })
      if (job.signal?.aborted) throw codedError('AGENT_CANCELLED')
      const output = outputValue(result)
      validateRecipeOutput(recipe.recipeId, recipe.recipeVersion, output)
      if (job.signal?.aborted) throw codedError('AGENT_CANCELLED')
      terminalReason = 'succeeded'
      const durationMs = Math.max(0, this.now() - startedAt)
      return await this.interactions.terminalize({
        interactionId: job.interactionId,
        terminalReason,
        errorCode: null,
        result: output,
        usage: usageValue(result?.usage, binding?.capabilities?.usageReporting),
        durationMs
      })
    } catch (error) {
      const code = normalizedErrorCode(error)
      const durationMs = Math.max(0, this.now() - startedAt)
      if (code === 'AGENT_CANCELLED') {
        terminalReason = 'cancelled'
        try {
          await this.interactions.terminalize({
            interactionId: job.interactionId, terminalReason: 'cancelled',
            errorCode: null, result: null, usage: null, durationMs
          })
        } catch { /* cancelRun may have already terminalized the interaction */ }
      } else if (TERMINAL_ERRORS.has(code)) {
        terminalReason = 'failed'
        await this.terminalizeFailure(job.interactionId, code, durationMs)
      } else {
        const settlement = await this.storage.failFormalAgentRun({
          attemptIdentity: job.attemptIdentity,
          errorCode: code
        }).catch(() => null)
        if (settlement?.state === 'failed') {
          terminalReason = 'failed'
          await this.terminalizeFailure(job.interactionId, code, durationMs)
        }
      }
      return null
    } finally {
      if (terminalReason) {
        try { this.onSettled(job.attemptIdentity.runId, terminalReason) } catch { /* observer isolation */ }
      }
    }
  }
}

module.exports = {
  FormalAgentRunRunner,
  RETRYABLE_ERRORS,
  TERMINAL_ERRORS,
  normalizedErrorCode,
  promptForInput
}
