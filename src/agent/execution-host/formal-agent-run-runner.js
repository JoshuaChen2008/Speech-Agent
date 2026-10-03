'use strict'
const { executeQuestionEvidence, nodeCount: questionNodeCount } = require('./question-evidence-executor')

// @ts-check

const { canonicalize, sha256Canonical } = require('../../runtime/storage-worker/canonical-json')
const { assertModelUsage } = require('../contracts/model-access-core')
const { getRecipe, validateRecipeOutput } = require('../contracts/recipes')
const { deriveRecipeRequestCapacity, usesModelWindowCapacity } = require('../contracts/budget-axes')
const { createControlledToolRuntime } = require('./controlled-tool-runtime')
const { createToolAuditRuntime } = require('./tool-audit-runtime')
const { AgentLoopExecutor } = require('./agent-loop')
const { readFrozenSummaryInput, readFrozenQuestionInput } = require('./summary-input-source')
const { planSummaryInputAsync, planQuestionInputAsync } = require('./summary-input-plan')
const { executeInputPlan } = require('./summary-plan-executor')

const TARGET_RECIPES = new Set(['summary.minutes', 'qa.answer'])
const RETRYABLE_ERRORS = new Set([
  'AGENT_PROVIDER_RATE_LIMITED', 'AGENT_PROVIDER_UNAVAILABLE', 'AGENT_PROVIDER_TIMEOUT',
  'AGENT_WORKER_EXITED', 'AGENT_INTERNAL_FAILURE'
])
const TERMINAL_ERRORS = new Set([
  'AGENT_PROVIDER_AUTH_FAILED', 'AGENT_OUTPUT_INVALID', 'AGENT_BUDGET_EXCEEDED', 'AGENT_PERMISSION_DENIED', 'AGENT_REQUEST_INVALID',
  'AGENT_SUMMARY_MEMORY_READ_FAILED', 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED', 'AGENT_QA_INPUT_LIMIT_EXCEEDED'
])

function codedError (code) {
  const error = new Error(code)
  error.code = code
  return error
}

function schedulerInterrupted (signal) {
  return ['AGENT_SCHEDULER_STOPPED', 'AGENT_LEASE_LOST'].includes(signal?.reason?.code)
}

async function awaitWithCancellation (operation, signal) {
  if (signal?.aborted) throw codedError('AGENT_CANCELLED')
  const pending = Promise.resolve().then(() => {
    if (signal?.aborted) throw codedError('AGENT_CANCELLED')
    return operation()
  })
  pending.catch(() => {})
  if (!signal) return pending
  let removeAbortListener = null
  let rejectCancelled
  const cancelled = new Promise((resolve, reject) => { rejectCancelled = reject })
  const abort = () => rejectCancelled(codedError('AGENT_CANCELLED'))
  if (signal.aborted) abort()
  else {
    signal.addEventListener('abort', abort, { once: true })
    removeAbortListener = () => signal.removeEventListener('abort', abort)
  }
  try { return await Promise.race([pending, cancelled]) } finally {
    try { removeAbortListener?.() } catch {}
  }
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

function collectSourceRefs (value, found = []) {
  if (!value || typeof value !== 'object') return found
  if (Array.isArray(value)) {
    for (const item of value) collectSourceRefs(item, found)
    return found
  }
  if (Object.keys(value).length === 4 &&
      ['fromEventOrder', 'sessionId', 'throughEventOrder', 'transcriptVersion']
        .every((key) => Object.hasOwn(value, key))) {
    found.push(value)
    return found
  }
  for (const key of Object.keys(value)) collectSourceRefs(value[key], found)
  return found
}

// Every transcript reference in a target-recipe result must stay inside the
// frozen session input range with the same session identity — the same rule
// the storage layer enforces for ingest evidence. A reference outside the
// authorized range is invalid output, never a repairable result.
function assertAuthorizedSourceRefs (input, output) {
  if (!Number.isSafeInteger(input.fromEventOrder) || !Number.isSafeInteger(input.throughEventOrder)) {
    throw codedError('AGENT_REQUEST_INVALID')
  }
  for (const ref of collectSourceRefs(output)) {
    if (ref.sessionId !== input.sessionId || ref.transcriptVersion !== input.transcriptVersion ||
        ref.fromEventOrder < input.fromEventOrder || ref.throughEventOrder > input.throughEventOrder) {
      throw codedError('AGENT_OUTPUT_INVALID')
    }
  }
}

function promptForInput (input, userPrompt, recipeId = 'summary.minutes', recipeVersion = '1', requestCapacity = null) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.events) || typeof userPrompt !== 'string') {
    throw codedError('AGENT_REQUEST_INVALID')
  }
  const windowedInput = usesModelWindowCapacity(recipeId, recipeVersion)
  let promptLimit
  if (windowedInput) {
    // The v2 window precheck enforces the registered request capacity derived
    // once from the frozen binding. Missing derivation fails closed.
    if (!requestCapacity || !Number.isSafeInteger(requestCapacity.promptByteLimit) || requestCapacity.promptByteLimit < 0) {
      throw codedError('AGENT_REQUEST_INVALID')
    }
    promptLimit = requestCapacity.promptByteLimit
  } else {
    promptLimit = 15000
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
  const promptBytes = Buffer.byteLength(prompt, 'utf8')
  if (promptBytes > promptLimit) {
    // Both summary versions reject oversized frozen input with the dedicated
    // stable code: the window precheck is an input-capacity rejection before
    // any model call, not a generic budget-axis exhaustion.
    const code = recipeId === 'summary.minutes'
      ? 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED'
      : windowedInput ? 'AGENT_QA_INPUT_LIMIT_EXCEEDED' : 'AGENT_BUDGET_EXCEEDED'
    const error = codedError(code)
    error.diagnosticMetrics = { actual: promptBytes, limit: promptLimit, unit: 'bytes' }
    throw error
  }
  return prompt
}

function normalizedErrorCode (error) {
  if (['AGENT_INPUT_CHANGED', 'AGENT_REQUEST_IDENTITY_CONFLICT', 'AGENT_INPUT_EMPTY'].includes(error?.code)) return 'AGENT_REQUEST_INVALID'
  if (error?.code === 'AGENT_CANCELLED' || error?.code === 'TOOL_CANCELLED') return 'AGENT_CANCELLED'
  if (error?.code === 'TOOL_BUDGET_EXCEEDED') return 'AGENT_BUDGET_EXCEEDED'
  if (error?.code === 'TOOL_SCOPE_DENIED') return 'AGENT_PERMISSION_DENIED'
  if (error?.code === 'TOOL_TIMEOUT') return 'AGENT_PROVIDER_TIMEOUT'
  if (RETRYABLE_ERRORS.has(error?.code) || TERMINAL_ERRORS.has(error?.code)) return error.code
  return 'AGENT_INTERNAL_FAILURE'
}

function summaryMemoryReadError (error) {
  return [
    'AGENT_INPUT_CHANGED', 'AGENT_CONTEXT_NOT_FOUND', 'AGENT_RUN_NOT_FOUND',
    'AGENT_SESSION_NOT_FOUND', 'AGENT_BUDGET_EXCEEDED', 'AGENT_REQUEST_INVALID',
    'STORAGE_COMMAND_FAILED'
  ].includes(error?.code)
}

function diagnosticEventForProgress (event) {
  if (event.type === 'budget_rejected') return 'budget_rejected'
  if (event.type === 'retry_wait' || event.phase === 'retry_wait') return 'backoff'
  if (event.type === 'request_started') return 'model_request_started'
  if (event.type === 'response_received' || event.type === 'request_failed') return 'model_request_ended'
  if (event.type === 'tool_started') return 'tool_started'
  if (event.type === 'tool_result_received' || event.type === 'tool_failed') return 'tool_ended'
  if (event.type === 'plan_created') return 'planned'
  if (event.phase === 'preparing') return 'planning'
  return null
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
    this.onChanged = typeof options.onChanged === 'function' ? options.onChanged : () => {}
    this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {}
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.progressPhases = new Map()
    this.bindingDigests = new Map()
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

  async toolsForRun (recipe, binding, interactionId, attemptIdentity, signal, contextOverride = undefined, onProgress = undefined, onResult = undefined, memoryQuery = undefined) {
    const context = contextOverride === undefined
      ? await awaitWithCancellation(() => this.personalContext.readToolContext({ runId: attemptIdentity.runId, ...(recipe.recipeVersion === '5' && recipe.recipeId === 'qa.answer' ? { schemaVersion: 2, query: memoryQuery } : {}) }, signal), signal)
      : contextOverride
    const controlled = createControlledToolRuntime({ context, signal })
    const audited = createToolAuditRuntime({
      interactionId,
      recipeId: recipe.recipeId,
      recipeVersion: recipe.recipeVersion,
      attempt: attemptIdentity.attempt,
      attemptIdentity,
      tools: controlled.toolsForRecipe(recipe.recipeId, recipe.recipeVersion),
      budget: binding.budget,
      interactions: this.interactions,
      signal,
      onProgress,
      now: this.now
    })
    const tools = audited.tools()
    return typeof onResult !== 'function' ? tools : tools.map(tool => ({ ...tool, execute: async (args) => {
      const result = await tool.execute(args)
      onResult(result)
      return result
    } }))
  }

  async reportProgress (job, event = {}) {
    const identity = job.sessionSummaryRequest
    if (!identity) return
    const phase = event.phase || (['request_started', 'response_received', 'request_failed'].includes(event.type) ? 'waiting_model' : null)
    if (!phase) return
    this.progressPhases.set(`${identity.requestId}:${identity.generation}`, phase)
    const update = {
      requestId: identity.requestId,
      generation: identity.generation,
      runId: job.attemptIdentity.runId,
      attemptIdentity: { ...job.attemptIdentity },
      attempt: job.attemptIdentity.attempt,
      phase,
      activity: event.activity === true || ['request_started', 'response_received', 'request_failed'].includes(event.type)
    }
    if (Number.isSafeInteger(event.validatedChunkCount) && Number.isSafeInteger(event.totalChunkCount)) {
      update.validatedChunkCount = event.validatedChunkCount
      update.totalChunkCount = event.totalChunkCount
    }
    if (event.state === 'retry_wait') update.state = 'retry_wait'
    const diagnosticEvent = diagnosticEventForProgress(event)
    if (diagnosticEvent) update.diagnosticEvent = diagnosticEvent
    if (diagnosticEvent === 'budget_rejected') {
      update.errorCode = event.errorCode
      update.budgetAxis = event.budgetAxis
      update.metrics = event.metrics
    }
    if (diagnosticEvent === 'backoff' && event.type === 'retry_wait') {
      if (RETRYABLE_ERRORS.has(event.reason)) update.errorCode = event.reason
      if (Number.isSafeInteger(event.nextAttempt) && event.nextAttempt >= 2 && event.nextAttempt <= 5) {
        update.metrics = { actual: event.nextAttempt, limit: 5, unit: 'count' }
        if (['AGENT_PROVIDER_RATE_LIMITED', 'AGENT_PROVIDER_UNAVAILABLE', 'AGENT_PROVIDER_TIMEOUT'].includes(event.reason) &&
            Number.isSafeInteger(event.waitMs) && event.waitMs >= 0 && event.waitMs <= 1000) {
          update.retry = { requestAttempt: event.nextAttempt, waitMs: event.waitMs, reason: event.reason }
        }
      }
    }
    const bindingDigest = this.bindingDigests.get(`${job.attemptIdentity.runId}:${job.attemptIdentity.attempt}`)
    if (bindingDigest) update.modelBindingDigest = bindingDigest
    if (['not_read', 'not_used', 'empty', 'referenced', 'failed', 'unknown'].includes(event.memoryState)) {
      update.memoryState = event.memoryState
    }
    try { await awaitWithCancellation(() => this.onProgress(Object.freeze(update), job.signal), job.signal) } catch { /* snapshot observers do not change Agent execution */ }
  }

  async flushProgress (job) {
    const identity = job.sessionSummaryRequest
    if (!identity) return
    const phase = this.progressPhases.get(`${identity.requestId}:${identity.generation}`)
    if (phase) await this.reportProgress(job, { phase, activity: false })
  }

  async terminalizeFailure (interactionId, attemptIdentity, code, durationMs, signal, wallClockElapsedMs = undefined) {
    try {
      await this.interactions.terminalize({
        interactionId, attemptIdentity: { ...attemptIdentity }, terminalReason: 'failed', errorCode: code,
        result: null, usage: null, durationMs,
        ...(wallClockElapsedMs === undefined ? {} : { wallClockElapsedMs })
      }, signal)
      return true
    } catch (error) {
      if (error?.code === 'AGENT_INTERACTION_STATE_CONFLICT' || error?.code === 'AGENT_CANCELLED') return false
      throw codedError('AGENT_RUN_UNAVAILABLE')
    }
  }

  async run (job) {
    exactObject(job, ['recipeId', 'source', 'attemptIdentity'], [
      'recipeVersion', 'summaryInputPolicy',
      'interactionId', 'requestedBy', 'signal', 'runId', 'summaryUseMemory', 'sessionSummaryRequest',
      'getRemainingWallClockMs', 'getWallClockElapsedMs', 'remainingWallClockMs', 'requestCount', 'requestLimit'
    ])
    if (!TARGET_RECIPES.has(job.recipeId) || job.requestedBy !== undefined && job.requestedBy !== 'user') {
      throw codedError('AGENT_REQUEST_INVALID')
    }
    if (job.summaryUseMemory !== undefined && typeof job.summaryUseMemory !== 'boolean') throw codedError('AGENT_REQUEST_INVALID')
    if (job.requestCount !== undefined && (!Number.isSafeInteger(job.requestCount) || job.requestCount < 0) ||
        job.requestLimit !== undefined && (!Number.isSafeInteger(job.requestLimit) || job.requestLimit < 1) ||
        job.requestCount !== undefined && job.requestLimit !== undefined && job.requestCount > job.requestLimit) {
      throw codedError('AGENT_REQUEST_INVALID')
    }
    if (job.remainingWallClockMs !== undefined && (!Number.isSafeInteger(job.remainingWallClockMs) || job.remainingWallClockMs < 0)) {
      throw codedError('AGENT_REQUEST_INVALID')
    }
    if (job.runId !== undefined && job.runId !== job.attemptIdentity.runId) throw codedError('AGENT_REQUEST_INVALID')
    if (job.sessionSummaryRequest !== undefined && (!job.sessionSummaryRequest || typeof job.sessionSummaryRequest !== 'object' ||
        Array.isArray(job.sessionSummaryRequest) || Object.keys(job.sessionSummaryRequest).sort().join(',') !== 'generation,requestId' ||
        typeof job.sessionSummaryRequest.requestId !== 'string' || !Number.isSafeInteger(job.sessionSummaryRequest.generation) ||
        job.sessionSummaryRequest.generation < 1)) throw codedError('AGENT_REQUEST_INVALID')
    if (typeof job.interactionId !== 'string' || job.interactionId.length === 0) {
      await this.storage.failFormalAgentRun({ attemptIdentity: job.attemptIdentity, errorCode: 'AGENT_REQUEST_INVALID' }, job.signal)
      return null
    }
    if (job.summaryInputPolicy !== undefined && job.summaryInputPolicy !== 'summary-long-input@1') throw codedError('AGENT_REQUEST_INVALID')
    const startedAt = this.now()
    const startedMonotonic = performance.now()
    let activePlan = null
    let terminalReason = null
    try {
      await this.reportProgress(job, { phase: 'preparing', activity: false })
      const recipe = getRecipe(job.recipeId, job.recipeVersion || '1')
      const userPrompt = this.promptProvider(job.attemptIdentity.runId)
      if (typeof userPrompt !== 'string' || userPrompt.length === 0) throw codedError('AGENT_REQUEST_INVALID')
      if (job.signal?.aborted) throw codedError(job.signal.reason?.code === 'AGENT_BUDGET_EXCEEDED' ? 'AGENT_BUDGET_EXCEEDED' : 'AGENT_CANCELLED')
      const binding = await awaitWithCancellation(() => this.modelAccess.bind({
        runId: job.attemptIdentity.runId,
        recipeId: recipe.recipeId,
        recipeVersion: recipe.recipeVersion,
        executionForm: 'agent_loop'
      }), job.signal)
      const remaining = () => typeof job.getRemainingWallClockMs === 'function' ? job.getRemainingWallClockMs()
        : Math.max(0, (job.remainingWallClockMs ?? binding.budget.maxWallClockMs) - Math.floor(performance.now() - startedMonotonic))
      try {
        this.bindingDigests.set(
          `${job.attemptIdentity.runId}:${job.attemptIdentity.attempt}`,
          sha256Canonical(binding)
        )
      } catch { /* a diagnostic digest cannot change model execution */ }
      let useMemory = job.recipeId !== 'summary.minutes' || job.summaryUseMemory !== false
      await this.reportProgress(job, {
        phase: 'reading_context', activity: false,
        ...(job.recipeId === 'summary.minutes' && !useMemory ? { memoryState: 'not_used' } : {})
      })
      const longQuestion = recipe.recipeId === 'qa.answer' && recipe.recipeVersion === '3'
      const retrievalQuestion = recipe.recipeId === 'qa.answer' && ['4', '5'].includes(recipe.recipeVersion)
      const longInput = job.summaryInputPolicy === 'summary-long-input@1' || longQuestion
      const readInput = longQuestion ? readFrozenQuestionInput : readFrozenSummaryInput
      const requestCapacity = usesModelWindowCapacity(recipe.recipeId, recipe.recipeVersion)
        ? deriveRecipeRequestCapacity({ recipeId: recipe.recipeId, recipeVersion: recipe.recipeVersion, capabilities: binding.capabilities, budget: binding.budget }) : null
      if (retrievalQuestion && requestCapacity.promptByteLimit < 1024) throw codedError('AGENT_BUDGET_EXCEEDED')
      const retrieved = retrievalQuestion ? await awaitWithCancellation(() => this.personalContext.questionEvidence({ action: 'retrieve',
        attemptIdentity: job.attemptIdentity, query: userPrompt, maxPromptBytes: Math.min(256 * 1024, requestCapacity.promptByteLimit) }, job.signal), job.signal) : null
      if (retrieved?.memoryAllowed === false) useMemory = false
      const input = retrieved ? { ...job.source, fromEventOrder: 1, throughEventOrder: job.source.inputWatermark, events: [] } : await awaitWithCancellation(() => longInput
        ? readInput(this.personalContext, job.source, job.signal)
        : this.personalContext.readSessionInput(job.source, job.signal), job.signal)

      const windowedInput = usesModelWindowCapacity(recipe.recipeId, recipe.recipeVersion)
      const planInput = longQuestion ? planQuestionInputAsync : planSummaryInputAsync
      const plan = retrieved ? { ...retrieved, policyVersion: 'question-retrieval@1', bindingDigest: sha256Canonical(binding),
        planDigest: sha256Canonical({ evidenceDigest: retrieved.evidenceDigest, bindingDigest: sha256Canonical(binding) }),
        leaves: retrieved.leaves || [{ prompt: retrieved.prompt }], nodeCount: retrieved.leaves ? questionNodeCount(retrieved.leaves.length) : 1 } : longInput ? await planInput(input, userPrompt, binding, job.signal) : null
      activePlan = plan
      let prompt = plan ? plan.leaves[0].prompt : promptForInput(input, userPrompt, recipe.recipeId, recipe.recipeVersion, requestCapacity)
      if (plan) {
        const { planDigest, inputDigest, bindingDigest, nodeCount, segmentCount, rawTextBytes, canonicalBytes } = plan
        await this.storage.summaryInputPlan({ action: 'register', attemptIdentity: job.attemptIdentity,
          plan: { planDigest, inputDigest, bindingDigest, nodeCount, segmentCount, rawTextBytes, canonicalBytes, leafCount: plan.leaves.length } })
        await this.reportProgress(job, { type: 'plan_created', phase: 'preparing', validatedChunkCount: 0, totalChunkCount: plan.leaves.length })
      }
      let tools
      const readMemoryRefs = new Set()
      try {
        tools = await this.toolsForRun(
          recipe, binding, job.interactionId, job.attemptIdentity, job.signal,
          useMemory ? undefined : { scope: { registeredAliasKeys: [], memoryRefs: [], sourceRefs: [] }, entries: [], sources: [] },
          (event) => this.reportProgress(job, {
            ...event,
            ...(job.recipeId === 'summary.minutes' && !useMemory ? { memoryState: 'not_used' } : {})
          }),
          longQuestion || retrievalQuestion ? (result) => {
            for (const match of result.matches || []) for (const entry of match.entries) readMemoryRefs.add(canonicalize(entry.memoryRef))
          } : undefined, userPrompt
        )
      } catch (error) {
        if (job.recipeId === 'summary.minutes' && useMemory && summaryMemoryReadError(error)) {
          await this.reportProgress(job, { phase: 'reading_context', activity: true, memoryState: 'failed' })
          throw codedError('AGENT_SUMMARY_MEMORY_READ_FAILED')
        }
        throw error
      }
      const loop = await awaitWithCancellation(() => this.loopFactory(binding), job.signal)
      if (!loop || typeof loop.agentLoop !== 'function') throw codedError('AGENT_INTERNAL_FAILURE')
      let requestSequence = Number.isSafeInteger(job.requestCount) ? job.requestCount : 0
      const beforeRequest = async ({ turn } = {}) => {
        if (job.signal?.aborted) throw codedError(job.signal.reason?.code === 'AGENT_BUDGET_EXCEEDED' ? 'AGENT_BUDGET_EXCEEDED' : 'AGENT_CANCELLED')
        if (remaining() <= 0) {
          throw codedError('AGENT_BUDGET_EXCEEDED')
        }
        if (typeof this.storage.reserveFormalAgentModelRequest !== 'function') throw codedError('AGENT_RUN_UNAVAILABLE')
        requestSequence += 1
        await awaitWithCancellation(() => this.storage.reserveFormalAgentModelRequest({
          attemptIdentity: { ...job.attemptIdentity },
          requestSequence,
          operationDigest: sha256Canonical({ recipeId: recipe.recipeId, recipeVersion: recipe.recipeVersion,
            input: prompt, turn: Number.isSafeInteger(turn) ? turn : 1 })
        }), job.signal)
      }
      const remainingWallClockMs = remaining()
      if (remainingWallClockMs <= 0) throw codedError('AGENT_BUDGET_EXCEEDED')
      const invoke = async (nodePrompt) => {
        prompt = nodePrompt
        return loop.agentLoop({
          recipeId: recipe.recipeId,
          recipeVersion: recipe.recipeVersion,
          prompt,
          resolvedModel: binding,
          tools,
          signal: job.signal,
          timeoutMs: Math.min(plan ? 180000 : binding.budget.maxWallClockMs, Math.max(1, remaining())),
          beforeRequest,
          ...(plan ? {
            getRunUsage: () => this.storage.summaryInputPlan({ action: 'read', attemptIdentity: job.attemptIdentity }),
            onRequestUsage: (usage) => this.storage.summaryInputPlan({ action: 'receipt', attemptIdentity: job.attemptIdentity, requestSequence, usage })
          } : {}),
          onProgress: (event) => this.reportProgress(job, event),
          budget: binding.budget,
          ...(windowedInput ? { requestCapacity } : {}),
          usageReporting: binding?.capabilities?.usageReporting !== false
        })
      }
      const result = retrieved?.leaves ? await executeQuestionEvidence({ evidence: retrieved, invoke, signal: job.signal,
        promptByteLimit: requestCapacity.promptByteLimit, validateMemoryRefs: output => {
          if (output.memoryRefs.some(ref => !readMemoryRefs.has(canonicalize(ref)))) throw codedError('AGENT_OUTPUT_INVALID')
        } }) : plan && !retrievalQuestion ? await executeInputPlan({ input, plan, invoke, signal: job.signal,
        ...(longQuestion ? { validateReferences: (output) => {
          if (output.memoryRefs.some(ref => !readMemoryRefs.has(canonicalize(ref)))) throw codedError('AGENT_OUTPUT_INVALID')
        } } : {}),
        onProgress: event => this.reportProgress(job, event) }) : await invoke(prompt)
      if (plan) {
        if (retrievalQuestion) await awaitWithCancellation(() => this.personalContext.questionEvidence({ action: 'verify', attemptIdentity: job.attemptIdentity }, job.signal), job.signal)
        else await readInput(this.personalContext, job.source, job.signal, { collect: false })
        if (longQuestion || retrievalQuestion && useMemory) await awaitWithCancellation(() => this.personalContext.readToolContext({ runId: job.attemptIdentity.runId, ...(recipe.recipeVersion === '5' ? { schemaVersion: 2, query: userPrompt } : {}) }, job.signal), job.signal)
        const totals = await this.storage.summaryInputPlan({ action: 'read', attemptIdentity: job.attemptIdentity })
        result.usage = totals.known ? { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens,
          usageSource: 'provider', cacheHitInputTokens: totals.cacheHitInputTokens ?? null,
          cacheMissInputTokens: totals.cacheMissInputTokens ?? null } : null
      }
      if (job.signal?.aborted) throw codedError('AGENT_CANCELLED')
      if (remaining() <= 0) throw codedError('AGENT_BUDGET_EXCEEDED')
      await this.reportProgress(job, { phase: 'validating', activity: false })
      const output = outputValue(result)
      validateRecipeOutput(recipe.recipeId, recipe.recipeVersion, output)
      if (retrievalQuestion) {
        if (output.coverage !== null || output.memoryRefs.some(ref => !readMemoryRefs.has(canonicalize(ref))) ||
            output.sourceRefs.some(ref => !retrieved.sourceRefs.some(allowed => canonicalize(allowed) === canonicalize(ref)))) throw codedError('AGENT_OUTPUT_INVALID')
        output.coverage = retrieved.coverage
        validateRecipeOutput(recipe.recipeId, recipe.recipeVersion, output)
      }
      if (!retrievalQuestion) assertAuthorizedSourceRefs(input, output)
      if (job.signal?.aborted) throw codedError('AGENT_CANCELLED')
      await this.flushProgress(job)
      if (schedulerInterrupted(job.signal)) return null
      const durationMs = Math.max(0, this.now() - startedAt)
      try {
        const terminal = await this.interactions.terminalize({
          interactionId: job.interactionId,
          attemptIdentity: { ...job.attemptIdentity },
          terminalReason: 'succeeded',
          errorCode: null,
          result: output,
          usage: usageValue(result?.usage, binding?.capabilities?.usageReporting),
          durationMs,
          ...(typeof job.getWallClockElapsedMs === 'function'
            ? { wallClockElapsedMs: job.getWallClockElapsedMs() }
            : {})
        }, job.signal)
        terminalReason = 'succeeded'
        return terminal
      } catch (error) {
        if (job.recipeId === 'summary.minutes' && useMemory && summaryMemoryReadError(error)) {
          throw codedError('AGENT_SUMMARY_MEMORY_READ_FAILED')
        }
        throw error
      }
    } catch (error) {
      if (['AGENT_SCHEDULER_STOPPED', 'AGENT_LEASE_LOST'].includes(job.signal?.reason?.code)) return null
      const code = job.signal?.reason?.code === 'AGENT_BUDGET_EXCEEDED'
        ? 'AGENT_BUDGET_EXCEEDED'
        : normalizedErrorCode(error)
      if (error?.diagnosticMetrics && job.sessionSummaryRequest) {
        await this.reportProgress(job, {
          type: 'budget_rejected', phase: 'preparing', activity: false,
          errorCode: code, budgetAxis: null, metrics: error.diagnosticMetrics
        })
      }
      const durationMs = Math.max(0, this.now() - startedAt)
      if (code === 'AGENT_CANCELLED') {
        await this.flushProgress(job)
        if (schedulerInterrupted(job.signal)) return null
        try {
          await this.interactions.terminalize({
            interactionId: job.interactionId,
            attemptIdentity: { ...job.attemptIdentity },
            terminalReason: 'cancelled',
            errorCode: null, result: null, usage: null, durationMs,
            ...(typeof job.getWallClockElapsedMs === 'function'
              ? { wallClockElapsedMs: job.getWallClockElapsedMs() }
              : {})
          }, job.signal?.reason?.code === 'AGENT_CANCELLED' ? undefined : job.signal)
          terminalReason = 'cancelled'
        } catch { /* cancelRun may have already terminalized the interaction */ }
      } else if (TERMINAL_ERRORS.has(code) || error?.retryExhausted === true) {
        await this.flushProgress(job)
        if (schedulerInterrupted(job.signal)) return null
        const writeSignal = job.signal?.reason?.code === 'AGENT_BUDGET_EXCEEDED' ? undefined : job.signal
        if (await this.terminalizeFailure(
          job.interactionId, job.attemptIdentity, code, durationMs, writeSignal,
          typeof job.getWallClockElapsedMs === 'function' ? job.getWallClockElapsedMs() : undefined
        )) terminalReason = 'failed'
      } else {
        let settlement
        try { settlement = await this.storage.failFormalAgentRun({
          attemptIdentity: job.attemptIdentity,
          errorCode: code,
          ...(typeof job.getWallClockElapsedMs === 'function'
            ? { elapsedMs: job.getWallClockElapsedMs() }
            : {})
        }, job.signal?.reason?.code === 'AGENT_BUDGET_EXCEEDED' ? undefined : job.signal) } catch {
          // Let the scheduler report an unconfirmed settlement. The lease can
          // be reconciled later; this attempt cannot claim a terminal result.
          throw codedError('AGENT_RUN_UNAVAILABLE')
        }
        if (settlement?.state === 'failed') {
          await this.flushProgress(job)
          if (schedulerInterrupted(job.signal)) return null
          terminalReason = 'failed'
        } else if (settlement?.state === 'retry_wait') {
          await this.reportProgress(job, { phase: 'retry_wait', state: 'retry_wait', activity: false })
        }
      }
      return null
    } finally {
      if (activePlan) for (const leaf of activePlan.leaves) leaf.prompt = ''
      this.bindingDigests.delete(`${job.attemptIdentity.runId}:${job.attemptIdentity.attempt}`)
      if (job.sessionSummaryRequest) this.progressPhases.delete(`${job.sessionSummaryRequest.requestId}:${job.sessionSummaryRequest.generation}`)
      if (terminalReason) {
        try { this.onChanged({
          runId: job.attemptIdentity.runId, interactionId: job.interactionId, terminalReason,
          ...(job.sessionSummaryRequest ? { requestId: job.sessionSummaryRequest.requestId, generation: job.sessionSummaryRequest.generation } : {})
        }) } catch { /* state notifications are observational */ }
        try { await this.onSettled(job.attemptIdentity.runId, terminalReason, job.interactionId) } catch { /* observer isolation */ }
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
