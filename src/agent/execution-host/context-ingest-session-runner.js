'use strict'

const { canonicalize, sha256Canonical } = require('../../runtime/storage-worker/canonical-json')
const { assertModelUsage } = require('../contracts/model-access-core')
const { getRecipe, validateRecipeOutput } = require('../contracts/recipes')

const RETRYABLE_ERRORS = new Set([
  'AGENT_PROVIDER_AUTH_FAILED',
  'AGENT_PROVIDER_RATE_LIMITED',
  'AGENT_PROVIDER_UNAVAILABLE',
  'AGENT_PROVIDER_TIMEOUT',
  'AGENT_WORKER_EXITED',
  'AGENT_INTERNAL_FAILURE'
])

const TERMINAL_ERRORS = new Set([
  'AGENT_OUTPUT_INVALID',
  'AGENT_BUDGET_EXCEEDED',
  'AGENT_PERMISSION_DENIED',
  'AGENT_REQUEST_INVALID'
])

function codedError (code) {
  const error = new Error(code)
  error.code = code
  return error
}

function exactObject (value, keys, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw codedError('AGENT_REQUEST_INVALID')
  const expected = [...keys].sort()
  const actual = Object.keys(value).sort()
  const allowed = new Set([...keys, ...optional])
  if (actual.some((key) => !allowed.has(key)) || expected.some((key) => !Object.hasOwn(value, key))) {
    throw codedError('AGENT_REQUEST_INVALID')
  }
  return value
}

function outputValue (value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (Object.hasOwn(value, 'output')) return value.output
    if (typeof value.text === 'string') {
      try { return JSON.parse(value.text) } catch { throw codedError('AGENT_OUTPUT_INVALID') }
    }
    if (Object.hasOwn(value, 'schemaVersion')) return value
  }
  throw codedError('AGENT_OUTPUT_INVALID')
}

function usageValue (value, usageReporting) {
  if (usageReporting === false || value === undefined || value === null) return null
  try {
    assertModelUsage(value)
    return value
  } catch {
    // Provider usage is optional.  An adapter that cannot provide the exact
    // ModelUsageV1 shape is projected to unknown rather than estimated.
    return null
  }
}

function promptForInput (input) {
  if (typeof input?.prompt === 'string') return input.prompt
  const events = Array.isArray(input?.events) ? input.events : []
  const payload = {
    sourceKind: input?.sourceKind,
    sessionId: input?.sessionId,
    transcriptVersion: input?.transcriptVersion,
    inputWatermark: input?.inputWatermark,
    inputDigest: input?.inputDigest,
    events: events.map((event) => ({
      eventOrder: event.eventOrder,
      segmentId: event.segmentId,
      text: event.text
    }))
  }
  let prompt
  try { prompt = canonicalize(payload) } catch { throw codedError('AGENT_REQUEST_INVALID') }
  // AgentLoop's prompt contract is intentionally bounded in S3.  Do not
  // truncate a frozen source: a future budget/chunking seam must handle it.
  if (Buffer.byteLength(prompt, 'utf8') > 15000) throw codedError('AGENT_BUDGET_EXCEEDED')
  return prompt
}

function errorCode (error) {
  const code = error?.code
  if (RETRYABLE_ERRORS.has(code) || TERMINAL_ERRORS.has(code) || code === 'AGENT_CANCELLED') return code
  return 'AGENT_INTERNAL_FAILURE'
}

class ContextIngestSessionRunner {
  constructor (options = {}) {
    this.personalContext = options.personalContext || null
    this.storage = options.storage || null
    this.s3 = Boolean(this.personalContext &&
      typeof this.personalContext.prepareSessionIngest === 'function' &&
      typeof this.personalContext.commitSessionIngest === 'function' &&
      options.modelAccess && typeof options.modelAccess.bind === 'function' &&
      options.interactions && typeof options.interactions.create === 'function' &&
      typeof options.interactions.terminalize === 'function' &&
      options.loop && typeof options.loop.agentLoop === 'function')
    if (!this.s3) {
      if (!this.personalContext || typeof this.personalContext.ingest !== 'function') {
        throw new TypeError('personalContext ingest seam is required')
      }
      if (!this.storage || typeof this.storage.completeFormalAgentRun !== 'function' ||
          typeof this.storage.failFormalAgentRun !== 'function') {
        throw new TypeError('formal Agent settlement adapter is required')
      }
      return
    }
    this.modelAccess = options.modelAccess
    this.interactions = options.interactions
    this.loop = options.loop
    this.resolveModel = typeof options.resolveModel === 'function' ? options.resolveModel : async (binding) => binding
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.nextInteractionId = typeof options.nextInteractionId === 'function'
      ? options.nextInteractionId
      : (runId) => `interaction.${runId}`
  }

  async prepare (source) {
    if (!this.s3) throw new TypeError('S3 context ingest seams are unavailable')
    return this.personalContext.prepareSessionIngest(source)
  }

  async failAttempt (attemptIdentity, code) {
    if (this.storage && typeof this.storage.failFormalAgentRun === 'function') {
      return this.storage.failFormalAgentRun({ attemptIdentity, errorCode: code })
    }
    return null
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

  async runLegacy (job) {
    try {
      const result = await this.personalContext.ingest(job.source)
      const summary = { episodeCount: result.episodeCount, memoryCount: result.memoryCount }
      await this.storage.completeFormalAgentRun({
        attemptIdentity: job.attemptIdentity,
        resultDigest: sha256Canonical(summary),
        resultSummary: summary
      })
      return result
    } catch {
      await this.storage.failFormalAgentRun({
        attemptIdentity: job.attemptIdentity,
        errorCode: 'AGENT_INTERNAL_FAILURE'
      })
      return null
    }
  }

  async runS3 (job) {
    exactObject(job, ['recipeId', 'source', 'attemptIdentity'], ['interactionId', 'signal', 'runId'])
    if (job.recipeId !== 'context.ingest.session') throw codedError('AGENT_REQUEST_INVALID')
    const attemptIdentity = job.attemptIdentity
    if (job.runId !== undefined && job.runId !== attemptIdentity.runId) throw codedError('AGENT_REQUEST_INVALID')
    const interactionId = job.interactionId || this.nextInteractionId(attemptIdentity.runId)
    const startedAt = this.now()
    let interactionCreated = false
    try {
      const recipe = getRecipe('context.ingest.session', '1')
      const binding = await this.modelAccess.bind({
        runId: attemptIdentity.runId,
        recipeId: recipe.recipeId,
        recipeVersion: recipe.recipeVersion,
        executionForm: 'agent_loop'
      })
      await this.interactions.create({
        runId: attemptIdentity.runId,
        interactionId,
        routingMode: 'preset',
        promptDigest: null
      })
      interactionCreated = true
      const input = typeof this.personalContext.readSessionInput === 'function'
        ? await this.personalContext.readSessionInput(job.source)
        : job.source
      const prompt = promptForInput(input)
      const resolvedModel = await this.resolveModel(binding)
      const result = await this.loop.agentLoop({
        recipeId: recipe.recipeId,
        recipeVersion: recipe.recipeVersion,
        prompt,
        resolvedModel,
        signal: job.signal,
        budget: binding?.budget,
        usageReporting: binding?.capabilities?.usageReporting !== false
      })
      const output = outputValue(result)
      validateRecipeOutput(recipe.recipeId, recipe.recipeVersion, output)
      await this.personalContext.commitSessionIngest({ runId: attemptIdentity.runId, attemptIdentity, output })
      const durationMs = Math.max(0, this.now() - startedAt)
      const terminal = await this.interactions.terminalize({
        interactionId,
        terminalReason: 'succeeded',
        errorCode: null,
        result: output,
        usage: usageValue(result?.usage, binding?.capabilities?.usageReporting),
        durationMs
      })
      return { ...terminal, state: 'succeeded', output }
    } catch (error) {
      const code = errorCode(error)
      const durationMs = Math.max(0, this.now() - startedAt)
      if (code === 'AGENT_CANCELLED') {
        if (interactionCreated) {
          try {
            await this.interactions.terminalize({
              interactionId, terminalReason: 'cancelled', errorCode: null,
              result: null, usage: null, durationMs
            })
          } catch { /* cancelRun may already have terminalized the row */ }
        }
        return null
      }
      if (TERMINAL_ERRORS.has(code)) {
        if (interactionCreated) await this.terminalizeFailure(interactionId, code, durationMs)
        else await this.failAttempt(attemptIdentity, code)
        return null
      }
      const settlement = await this.failAttempt(attemptIdentity, code)
      // A retryable error keeps the pending interaction and skeleton intact.
      // Once S1 exhausts attempts, close the pending interaction as failed.
      if (settlement?.state === 'failed' && interactionCreated) {
        await this.terminalizeFailure(interactionId, code, durationMs)
      }
      return null
    }
  }

  async run (job) {
    if (this.s3) return this.runS3(job)
    if (!job || job.recipeId !== 'context.ingest.session' || !job.source || !job.attemptIdentity) {
      throw new TypeError('unsupported formal Agent job')
    }
    return this.runLegacy(job)
  }
}

module.exports = { ContextIngestSessionRunner, RETRYABLE_ERRORS, TERMINAL_ERRORS }
