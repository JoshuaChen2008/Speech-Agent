'use strict'

const { canonicalize, sha256Canonical } = require('../../runtime/storage-worker/canonical-json')
const { assertModelUsage } = require('../contracts/model-access-core')
const { getRecipe, validateRecipeOutput } = require('../contracts/recipes')
const { createControlledToolRuntime } = require('./controlled-tool-runtime')
const { createToolAuditRuntime } = require('./tool-audit-runtime')
const { questionSource } = require('../personal-context/question-memory-source')
const { executeSessionExperiences } = require('./session-experience-executor')

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

function assertSchedulerActive (signal) {
  if (['AGENT_SCHEDULER_STOPPED', 'AGENT_LEASE_LOST'].includes(signal?.reason?.code)) {
    throw signal.reason
  }
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

function promptForInput (input, recipeVersion = '1') {
  if (Array.isArray(input?.memories) && Array.isArray(input?.episodes)) {
    const prompt = canonicalize(input)
    if (Buffer.byteLength(prompt, 'utf8') > 15000) throw codedError('AGENT_BUDGET_EXCEEDED')
    return prompt
  }
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
  if (input?.interactionId !== undefined) payload.interactionId = input.interactionId
  if (input?.signalKind !== undefined) payload.signalKind = input.signalKind
  if (input?.signalIdempotencyKey !== undefined) payload.signalIdempotencyKey = input.signalIdempotencyKey
  if (input?.signal !== undefined) {
    if (recipeVersion === '2' && input.sourceKind === 'interaction') Object.assign(payload, questionSource(input.signal))
    else payload.signal = input.signal
  }
  if (recipeVersion === '2' && input.sourceKind === 'session') payload.confirmedMemories = input.confirmedMemories || []
  let prompt
  try { prompt = canonicalize(payload) } catch { throw codedError('AGENT_REQUEST_INVALID') }
  // AgentLoop's prompt contract is intentionally bounded in S3.  Do not
  // truncate a frozen source: a future budget/chunking seam must handle it.
  if (Buffer.byteLength(prompt, 'utf8') > 15000) throw codedError('AGENT_BUDGET_EXCEEDED')
  return prompt
}

function errorCode (error) {
  if (['AGENT_INPUT_CHANGED', 'AGENT_INPUT_EMPTY'].includes(error?.code)) return 'AGENT_REQUEST_INVALID'
  if (error?.code === 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED') return 'AGENT_BUDGET_EXCEEDED'
  const code = error?.code
  if (RETRYABLE_ERRORS.has(code) || TERMINAL_ERRORS.has(code) || code === 'AGENT_CANCELLED') return code
  return 'AGENT_INTERNAL_FAILURE'
}

class ContextIngestSessionRunner {
  constructor (options = {}) {
    this.personalContext = options.personalContext || null
    this.storage = options.storage || null
    this.ingestRecipeVersion = options.ingestRecipeVersion || '1'
    if (!['1', '2', '3'].includes(this.ingestRecipeVersion)) throw codedError('AGENT_REQUEST_INVALID')
    const loopFactory = typeof options.loopFactory === 'function'
      ? options.loopFactory
      : options.loop && typeof options.loop.agentLoop === 'function'
        ? () => options.loop
        : null
    this.s3 = Boolean(this.personalContext &&
      typeof this.personalContext.prepareSessionIngest === 'function' &&
      typeof this.personalContext.commitSessionIngest === 'function' &&
      options.modelAccess && typeof options.modelAccess.bind === 'function' &&
      options.interactions && typeof options.interactions.create === 'function' &&
      typeof options.interactions.terminalize === 'function' &&
      loopFactory)
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
    this.loopFactory = loopFactory
    this.resolveModel = typeof options.resolveModel === 'function' ? options.resolveModel : async (binding) => binding
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.monotonicNow = typeof options.monotonicNow === 'function' ? options.monotonicNow : () => performance.now()
    this.interactionPayloadProvider = typeof options.interactionPayloadProvider === 'function'
      ? options.interactionPayloadProvider
      : async () => null
    this.onSettled = typeof options.onSettled === 'function' ? options.onSettled : async () => {}
    this.nextInteractionId = typeof options.nextInteractionId === 'function'
      ? options.nextInteractionId
      : (runId) => `interaction.${runId}`
  }

  async prepare (source) {
    if (!this.s3) throw new TypeError('S3 context ingest seams are unavailable')
    if (source?.sourceKind === 'interaction') {
      if (typeof this.personalContext.prepareInteractionIngest !== 'function') throw codedError('AGENT_REQUEST_INVALID')
      const request = {
        interactionId: source.interactionId,
        signalKind: source.signalKind,
        payloadDigest: source.payloadDigest || null
      }
      if (source.signalIdempotencyKey !== undefined) request.signalIdempotencyKey = source.signalIdempotencyKey
      if (this.ingestRecipeVersion !== '1') request.ingestRecipeVersion = '2'
      return this.personalContext.prepareInteractionIngest(request)
    }
    const prepared = await this.personalContext.prepareSessionIngest(this.ingestRecipeVersion !== '1'
      ? { ...source, ingestRecipeVersion: this.ingestRecipeVersion } : source)
    if (prepared.recipeVersion === '3' && !['succeeded', 'failed', 'cancelled'].includes(prepared.state)) {
      // Freeze the selected model before the first automatic claim creates its
      // durable attempt budget. All later ranges and retries reuse this binding.
      await this.modelAccess.bind({ runId: prepared.runId, recipeId: prepared.recipeId, recipeVersion: '3', executionForm: 'agent_loop' })
    }
    return prepared
  }

  async failAttempt (attemptIdentity, code, signal) {
    if (this.storage && typeof this.storage.failFormalAgentRun === 'function') {
      return this.storage.failFormalAgentRun({ attemptIdentity, errorCode: code }, signal)
    }
    return null
  }

  async terminalizeFailure (interactionId, attemptIdentity, code, durationMs, signal, wallClockElapsedMs) {
    try {
      return await this.interactions.terminalize({
        interactionId, attemptIdentity: { ...attemptIdentity }, terminalReason: 'failed', errorCode: code,
        result: null, usage: null, durationMs,
        ...(wallClockElapsedMs === undefined ? {} : { wallClockElapsedMs })
      }, signal)
    } catch {
      return null
    }
  }

  async toolsForRun (recipe, binding, interactionId, attemptIdentity, signal) {
    // Interaction memory ingestion is intentionally tool-free.  The signal
    // source is already frozen by storage and passive context lookup would
    // turn a user action into an unbounded telemetry channel.
    if (recipe.recipeId === 'context.ingest.interaction' || recipe.toolGrants.length === 0) return undefined
    if (typeof this.personalContext.readToolContext !== 'function' ||
        typeof this.interactions.startToolCall !== 'function' ||
        typeof this.interactions.finishToolCall !== 'function' ||
        !binding?.budget) {
      return undefined
    }
    const context = await this.personalContext.readToolContext({ runId: attemptIdentity.runId }, signal)
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
      now: this.now
    })
    return audited.tools()
  }

  async runLegacy (job) {
    try {
      const result = await this.personalContext.ingest(job.source)
      const summary = { episodeCount: result.episodeCount, memoryCount: result.memoryCount }
      await this.storage.completeFormalAgentRun({
        attemptIdentity: job.attemptIdentity,
        resultDigest: sha256Canonical(summary),
        resultSummary: summary
      }, job.signal)
      return result
    } catch {
      await this.storage.failFormalAgentRun({
        attemptIdentity: job.attemptIdentity,
        errorCode: 'AGENT_INTERNAL_FAILURE'
      }, job.signal)
      return null
    }
  }

  async runS3 (job) {
    exactObject(job, ['recipeId', 'source', 'attemptIdentity'], ['recipeVersion', 'interactionId', 'requestedBy', 'signal', 'runId',
      'getRemainingWallClockMs', 'getWallClockElapsedMs', 'remainingWallClockMs', 'requestCount', 'requestLimit'])
    if (!['context.ingest.session', 'context.ingest.interaction', 'context.synthesize'].includes(job.recipeId)) throw codedError('AGENT_REQUEST_INVALID')
    if (job.recipeVersion !== undefined && !['1', '2', '3'].includes(job.recipeVersion)) throw codedError('AGENT_REQUEST_INVALID')
    if (job.requestedBy !== undefined && job.requestedBy !== 'automatic') throw codedError('AGENT_REQUEST_INVALID')
    if (job.recipeId === 'context.ingest.interaction' && job.source?.sourceKind !== 'interaction') throw codedError('AGENT_REQUEST_INVALID')
    if (job.recipeId === 'context.ingest.session' && job.source?.sourceKind !== 'session') throw codedError('AGENT_REQUEST_INVALID')
    const attemptIdentity = job.attemptIdentity
    if (job.runId !== undefined && job.runId !== attemptIdentity.runId) throw codedError('AGENT_REQUEST_INVALID')
    const interactionId = job.interactionId || this.nextInteractionId(attemptIdentity.runId)
    const startedAt = this.now()
    const startedMonotonic = this.monotonicNow()
    const elapsed = () => typeof job.getWallClockElapsedMs === 'function' ? job.getWallClockElapsedMs()
      : Math.max(0, Math.floor(this.monotonicNow() - startedMonotonic))
    let interactionCreated = false
    let terminalReason = null
    try {
      assertSchedulerActive(job.signal)
      const recipe = getRecipe(job.recipeId, job.recipeVersion || '1')
      const binding = await this.modelAccess.bind({
        runId: attemptIdentity.runId,
        recipeId: recipe.recipeId,
        recipeVersion: recipe.recipeVersion,
        executionForm: 'agent_loop'
      })
      assertSchedulerActive(job.signal)
      await this.interactions.create({
        runId: attemptIdentity.runId,
        interactionId,
        routingMode: 'preset',
        promptDigest: null
      }, job.signal)
      interactionCreated = true
      assertSchedulerActive(job.signal)
      const experienceRun = recipe.recipeId === 'context.ingest.session' && recipe.recipeVersion === '3'
      let result
      if (experienceRun) {
        const loop = await this.loopFactory(binding)
        if (!loop || typeof loop.agentLoop !== 'function') throw codedError('AGENT_INTERNAL_FAILURE')
        result = await executeSessionExperiences({ personalContext: this.personalContext, storage: this.storage,
          loop, binding, resolvedModel: await this.resolveModel(binding), job })
      } else {
        const input = job.recipeId === 'context.synthesize'
          ? await this.storage.personalContextManage({ type: 'synthesize', action: 'read', runId: attemptIdentity.runId })
          : job.recipeId === 'context.ingest.interaction'
          ? (typeof this.personalContext.readInteractionInput === 'function'
              ? await this.personalContext.readInteractionInput(
                  job.source, await this.interactionPayloadProvider(attemptIdentity.runId), job.signal
                )
              : job.source)
          : (typeof this.personalContext.readSessionInput === 'function'
              ? await this.personalContext.readSessionInput(job.source, job.signal)
              : job.source)
        assertSchedulerActive(job.signal)
        const prompt = promptForInput(input, recipe.recipeVersion)
        const resolvedModel = await this.resolveModel(binding)
        assertSchedulerActive(job.signal)
        const tools = await this.toolsForRun(recipe, binding, interactionId, attemptIdentity, job.signal)
        assertSchedulerActive(job.signal)
        const loop = await this.loopFactory(binding)
        assertSchedulerActive(job.signal)
        if (!loop || typeof loop.agentLoop !== 'function') throw codedError('AGENT_INTERNAL_FAILURE')
        result = await loop.agentLoop({
          recipeId: recipe.recipeId,
          recipeVersion: recipe.recipeVersion,
          prompt,
          resolvedModel,
          signal: job.signal,
          budget: binding?.budget,
          ...(tools === undefined ? {} : { tools }),
          usageReporting: binding?.capabilities?.usageReporting !== false
        })
        assertSchedulerActive(job.signal)
        const output = outputValue(result)
        validateRecipeOutput(recipe.recipeId, recipe.recipeVersion, output)
        assertSchedulerActive(job.signal)
        if (job.recipeId === 'context.synthesize') {
          await this.storage.personalContextManage({ type: 'synthesize', action: 'commit', runId: attemptIdentity.runId, attemptIdentity, output })
        } else if (job.recipeId === 'context.ingest.interaction') {
          if (typeof this.personalContext.commitInteractionIngest !== 'function') throw codedError('AGENT_REQUEST_INVALID')
          await this.personalContext.commitInteractionIngest({
            runId: attemptIdentity.runId, attemptIdentity, output,
            ...(recipe.recipeVersion === '2' ? { userText: questionSource(input.signal).userText } : {})
          }, job.signal)
        } else {
          await this.personalContext.commitSessionIngest({ runId: attemptIdentity.runId, attemptIdentity, output }, job.signal)
        }
      }
      const output = outputValue(result)
      validateRecipeOutput(recipe.recipeId, recipe.recipeVersion, output)
      assertSchedulerActive(job.signal)
      const durationMs = Math.max(0, this.now() - startedAt)
      const terminal = await this.interactions.terminalize({
        interactionId,
        attemptIdentity: { ...attemptIdentity },
        terminalReason: 'succeeded',
        errorCode: null,
        result: output,
        usage: usageValue(result?.usage, binding?.capabilities?.usageReporting),
        durationMs,
        ...(recipe.recipeId === 'context.ingest.session' && recipe.recipeVersion === '3' ? { wallClockElapsedMs: elapsed() } : {})
      }, job.signal)
      terminalReason = 'succeeded'
      return { ...terminal, state: 'succeeded', output }
    } catch (error) {
      if (['AGENT_SCHEDULER_STOPPED', 'AGENT_LEASE_LOST'].includes(job.signal?.reason?.code)) return null
      const code = errorCode(error)
      const durationMs = Math.max(0, this.now() - startedAt)
      if (code === 'AGENT_CANCELLED') {
        if (interactionCreated) {
          try {
            await this.interactions.terminalize({
              interactionId, attemptIdentity: { ...attemptIdentity }, terminalReason: 'cancelled', errorCode: null,
              result: null, usage: null, durationMs,
              ...(job.recipeId === 'context.ingest.session' && job.recipeVersion === '3' ? { wallClockElapsedMs: elapsed() } : {})
            }, job.signal?.reason?.code === 'AGENT_CANCELLED' ? undefined : job.signal)
          } catch { /* cancelRun may already have terminalized the row */ }
          terminalReason = 'cancelled'
        }
        return null
      }
      if (TERMINAL_ERRORS.has(code)) {
        if (interactionCreated) {
          await this.terminalizeFailure(interactionId, attemptIdentity, code, durationMs, job.signal,
            job.recipeId === 'context.ingest.session' && job.recipeVersion === '3' ? elapsed() : undefined)
          terminalReason = 'failed'
        } else {
          const settlement = await this.failAttempt(attemptIdentity, code, job.signal)
          if (settlement?.state === 'failed' && job.recipeId === 'context.ingest.interaction') terminalReason = 'failed'
        }
        return null
      }
      const settlement = await this.failAttempt(attemptIdentity, code, job.signal)
      // A retryable error keeps the pending interaction and skeleton intact.
      // Once S1 exhausts attempts, close the pending interaction as failed.
      if (settlement?.state === 'failed' && interactionCreated) {
        await this.terminalizeFailure(interactionId, attemptIdentity, code, durationMs, job.signal)
        terminalReason = 'failed'
      } else if (settlement?.state === 'failed' && job.recipeId === 'context.ingest.interaction') {
        terminalReason = 'failed'
      }
      return null
    } finally {
      if (terminalReason) {
        try { await this.onSettled(attemptIdentity.runId, terminalReason, interactionId) } catch { /* observer isolation */ }
      }
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
