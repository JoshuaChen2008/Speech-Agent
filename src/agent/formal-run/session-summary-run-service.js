'use strict'

const { sha256Canonical } = require('../../runtime/storage-worker/canonical-json')
const runContract = require('../contracts/agent-run-ui')
const c = require('../contracts/session-summary-run-ui')

const SUMMARY_PROMPT = '请基于这场已结束的会话生成会话总结，包含主要内容、决定、待办和需要注意。'
const REQUEST_TARGETS = Object.freeze(['qa.answer'])
const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled'])

function header () {
  return { contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION }
}

function errorResponse (code, nextAction = 'retry') {
  const safeCode = c.ERROR_CODES.includes(code) ? code : 'AGENT_RUN_UNAVAILABLE'
  return {
    ...header(), ok: false, error: { code: safeCode, next_action: nextAction }, result: null
  }
}

function publicSnapshot (row) {
  const activityAge = row.elapsedMs > 0 && row.elapsedMs >= row.lastActivityElapsedMs
    ? row.elapsedMs - row.lastActivityElapsedMs
    : null
  return c.assertRequestSnapshot({
    request_id: row.requestId,
    generation: row.generation,
    revision: row.revision,
    action: row.action,
    state: row.state,
    phase: row.phase,
    attempt: row.attempt,
    elapsed_ms: row.elapsedMs,
    last_activity_age_ms: activityAge,
    validated_chunk_count: row.validatedChunkCount,
    total_chunk_count: row.totalChunkCount,
    memory_state: row.memoryState,
    error_code: row.errorCode,
    budget: row.budget,
    freshness: 'unknown',
    cancel_requested: row.cancelRequested,
    resume_required: row.resumeRequired,
    diagnostics_available: row.diagnosticsAvailable,
    route_run_id: row.routeRunId,
    target_run_id: row.targetRunId,
    interaction_id: row.targetInteractionId || null,
    recipe_id: row.targetRecipeId || null,
    routing_mode: row.targetRoutingMode || null
  })
}

function requestIdentity (request) {
  const clientKeyDigest = sha256Canonical(request.client_request_key)
  const requestId = `request.summary.${sha256Canonical({ clientKeyDigest }).slice(0, 48)}`
  const scopeDigest = sha256Canonical(request.scope)
  const prompt = request.action === 'summary' ? SUMMARY_PROMPT : request.prompt
  return {
    clientKeyDigest,
    requestId,
    scopeDigest,
    prompt,
    promptDigest: sha256Canonical(prompt)
  }
}

function requestDigestFor (request, identity, summaryUseMemory, frozen) {
  return sha256Canonical({
    action: request.action,
    scopeDigest: identity.scopeDigest,
    promptDigest: identity.promptDigest,
    summaryUseMemory,
    transcriptVersion: frozen.transcriptVersion,
    inputWatermark: frozen.inputWatermark,
    inputDigest: frozen.inputDigest
  })
}

function frozenInput (row) {
  if (row?.transcriptVersion === null || row?.inputWatermark === null || row?.inputDigest === null) return null
  return {
    transcriptVersion: row.transcriptVersion,
    inputWatermark: row.inputWatermark,
    inputDigest: row.inputDigest
  }
}

function identityConflict () {
  const error = new Error('request identity conflicts with persisted acceptance')
  error.code = 'AGENT_REQUEST_IDENTITY_CONFLICT'
  return error
}

function stableErrorCode (error) {
  if (c.ERROR_CODES.includes(error?.code)) return error.code
  if (error?.code === 'AGENT_REQUEST_INVALID' || error?.code === 'AGENT_REQUEST_IDENTITY_CONFLICT') return 'AGENT_RUN_INVALID'
  if (error?.code === 'AGENT_CANCELLED') return 'AGENT_CANCELLED'
  return 'AGENT_RUN_UNAVAILABLE'
}

class SessionSummaryRunService {
  constructor (options = {}) {
    if (!options.storage || typeof options.storage.acceptSessionSummaryRequest !== 'function' ||
        typeof options.storage.getSessionSummaryRequest !== 'function' ||
        typeof options.storage.cancelSessionSummaryRequest !== 'function' ||
        typeof options.storage.updateSessionSummaryRequest !== 'function' ||
        typeof options.storage.derivePersonalContextSessionSource !== 'function') {
      throw new TypeError('summary request storage is required')
    }
    if (!options.runService || typeof options.runService.getEligibility !== 'function') {
      throw new TypeError('AgentRunService is required')
    }
    this.storage = options.storage
    this.runService = options.runService
    this.routeOrchestrator = options.routeOrchestrator || null
    this.scheduler = options.scheduler || null
    this.getConfig = typeof options.getConfig === 'function' ? options.getConfig : null
    this.promptStore = options.promptStore instanceof Map ? options.promptStore : null
    this.defer = typeof options.defer === 'function' ? options.defer : (callback) => setImmediate(callback)
    this.onChanged = typeof options.onChanged === 'function' ? options.onChanged : () => {}
    this.listeners = new Set()
    this.controllers = new Map()
    this.dispatches = new Map()
    this.runRequests = new Map()
  }

  subscribeChanged (listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emitChanged (row) {
    if (!row) return null
    const event = c.assertChangedEvent({
      ...header(), request_id: row.requestId, generation: row.generation, revision: row.revision
    })
    try { this.onChanged(event) } catch { /* observers do not change persisted state */ }
    for (const listener of [...this.listeners]) {
      try { listener(event) } catch { /* observers do not change persisted state */ }
    }
    return event
  }

  async readRow (requestId) {
    return this.storage.getSessionSummaryRequest({ requestId })
  }

  async readAndEmit (requestId) {
    const row = await this.readRow(requestId)
    this.emitChanged(row)
    return row
  }

  async accept (request) {
    try {
      c.assertAcceptRequest(request)
      const identity = requestIdentity(request)
      let previous = null
      try { previous = await this.readRow(identity.requestId) } catch (error) {
        if (error?.code !== 'AGENT_RUN_NOT_FOUND') throw error
      }

      if (previous) {
        if (previous.clientKeyDigest !== identity.clientKeyDigest || previous.scopeDigest !== identity.scopeDigest ||
            previous.promptDigest !== identity.promptDigest || previous.action !== request.action) throw identityConflict()
        const frozen = frozenInput(previous)
        const summaryUseMemory = request.action === 'summary'
          ? previous.summaryUseMemory
          : null
        if (request.action === 'summary' && typeof summaryUseMemory !== 'boolean') throw identityConflict()
        if (frozen) {
          const digest = requestDigestFor(request, identity, summaryUseMemory, frozen)
          if (previous.requestDigest !== digest) throw identityConflict()
          await this.storage.acceptSessionSummaryRequest({
            requestId: identity.requestId,
            sessionId: request.scope.reference,
            clientKeyDigest: identity.clientKeyDigest,
            requestDigest: digest,
            scopeDigest: identity.scopeDigest,
            promptDigest: identity.promptDigest,
            action: request.action,
            summaryUseMemory,
            ...frozen
          })
        }
        const row = await this.readRow(identity.requestId)
        if (frozen && !row.cancelRequested && !TERMINAL_STATES.has(row.state)) {
          this.scheduleDispatch({
            requestId: row.requestId,
            generation: row.generation,
            action: row.action,
            summaryUseMemory: row.summaryUseMemory,
            scope: request.scope,
            ...frozen,
            clientIdempotencyKey: `${row.requestId}.generation.${row.generation}`,
            prompt: identity.prompt
          })
        }
        this.emitChanged(row)
        return c.assertAcceptResponse({
          ...header(), ok: true, error: null,
          result: { accepted: true, replayed: true, snapshot: publicSnapshot(row) }
        })
      }

      const eligibility = await this.runService.getEligibility({
        contract_id: runContract.CONTRACT_ID,
        contract_version: runContract.CONTRACT_VERSION,
        scope: request.scope
      })
      if (!eligibility?.ok || eligibility.snapshot?.eligibility !== 'ready') {
        return c.assertAcceptResponse(errorResponse('AGENT_RUN_UNAVAILABLE', eligibility?.error?.next_action || 'settings'))
      }

      const frozen = await this.storage.derivePersonalContextSessionSource({
        sessionId: request.scope.reference,
        transcriptVersion: 'raw'
      })
      const inputWatermark = Number.isSafeInteger(frozen.inputWatermark)
        ? { throughEventOrder: frozen.inputWatermark }
        : frozen.inputWatermark
      if (!inputWatermark || !Number.isSafeInteger(inputWatermark.throughEventOrder) ||
          typeof frozen.inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(frozen.inputDigest)) {
        const error = new Error('frozen input identity is invalid')
        error.code = 'AGENT_REQUEST_INVALID'
        throw error
      }

      const settings = this.getConfig ? this.getConfig() : null
      const summaryUseMemory = request.action === 'summary'
        ? (!settings || (settings.agentEnabled === true && settings.memoryEnabled === true && settings.summaryUseMemory !== false))
        : null
      const frozenIdentity = {
        transcriptVersion: frozen.transcriptVersion || 'raw',
        inputWatermark,
        inputDigest: frozen.inputDigest
      }
      const requestDigest = requestDigestFor(request, identity, summaryUseMemory, frozenIdentity)
      const accepted = await this.storage.acceptSessionSummaryRequest({
        requestId: identity.requestId,
        sessionId: request.scope.reference,
        clientKeyDigest: identity.clientKeyDigest,
        requestDigest,
        scopeDigest: identity.scopeDigest,
        promptDigest: identity.promptDigest,
        action: request.action,
        summaryUseMemory,
        ...frozenIdentity
      })
      const row = await this.readRow(identity.requestId)
      const response = c.assertAcceptResponse({
        ...header(), ok: true, error: null,
        result: { accepted: true, replayed: accepted.replayed === true, snapshot: publicSnapshot(row) }
      })
      if (!row.cancelRequested && !TERMINAL_STATES.has(row.state)) {
        this.scheduleDispatch({
          requestId: row.requestId,
          generation: row.generation,
          action: row.action,
          summaryUseMemory: row.summaryUseMemory,
          scope: request.scope,
          ...frozenIdentity,
          clientIdempotencyKey: `${row.requestId}.generation.${row.generation}`,
          prompt: identity.prompt
        })
      }
      this.emitChanged(row)
      return response
    } catch (error) {
      return c.assertAcceptResponse(errorResponse(stableErrorCode(error), error?.code === 'AGENT_REQUEST_INVALID' ? 'correct_input' : 'retry'))
    }
  }

  scheduleDispatch (input) {
    if (this.dispatches.has(input.requestId)) return this.dispatches.get(input.requestId)
    const task = new Promise((resolve) => {
      this.defer(() => resolve(this.dispatchAccepted(input)))
    })
    this.dispatches.set(input.requestId, task)
    void task.finally(() => {
      if (this.dispatches.get(input.requestId) === task) this.dispatches.delete(input.requestId)
    })
    return task
  }

  async dispatchAccepted (input) {
    const controller = new AbortController()
    this.controllers.set(input.requestId, controller)
    try {
      const current = await this.readRow(input.requestId)
      if (current.cancelRequested || TERMINAL_STATES.has(current.state)) return
      if (!this.routeOrchestrator) throw Object.assign(new Error('route unavailable'), { code: 'AGENT_RUN_UNAVAILABLE' })
      const routeInput = {
        scope: input.scope,
        prompt: input.prompt,
        transcriptVersion: input.transcriptVersion,
        inputWatermark: input.inputWatermark,
        inputDigest: input.inputDigest,
        clientIdempotencyKey: input.clientIdempotencyKey,
        signal: controller.signal,
        requestId: input.requestId,
        requestGeneration: input.generation
      }
      const routed = input.action === 'summary'
        ? await this.routeOrchestrator.submitFixedTarget({ ...routeInput, summaryUseMemory: input.summaryUseMemory })
        : await this.routeOrchestrator.submit({ ...routeInput, permittedTargetRecipes: [...REQUEST_TARGETS] })
      if (routed?.unsupported === true || routed?.eligibility !== 'ready' || typeof routed?.runId !== 'string' || typeof routed?.interactionId !== 'string') {
        throw Object.assign(new Error('target route unavailable'), { code: 'AGENT_RUN_UNAVAILABLE' })
      }
      const latest = await this.readRow(input.requestId)
      if (latest.cancelRequested || TERMINAL_STATES.has(latest.state)) {
        if (this.scheduler && typeof this.scheduler.cancel === 'function') this.scheduler.cancel(routed.runId)
        return
      }
      if (this.promptStore) this.promptStore.set(routed.runId, input.prompt)
      this.runRequests.set(routed.runId, { requestId: input.requestId, generation: input.generation })
      if (this.scheduler && typeof this.scheduler.wake === 'function') this.scheduler.wake('submit')
      await this.readAndEmit(input.requestId)
    } catch (error) {
      await this.recordDispatchFailure(input, error)
    } finally {
      if (this.controllers.get(input.requestId) === controller) this.controllers.delete(input.requestId)
    }
  }

  async recordDispatchFailure (input, error) {
    try {
      const row = await this.readRow(input.requestId)
      if (row.cancelRequested || TERMINAL_STATES.has(row.state)) return
      if (error?.code === 'AGENT_CANCELLED' && !row.cancelRequested) {
        this.emitChanged(row)
        return
      }
      if (row.routeRunId || row.targetRunId) {
        this.emitChanged(row)
        return
      }
      await this.storage.updateSessionSummaryRequest({
        requestId: input.requestId,
        generation: input.generation,
        expectedRevision: row.revision,
        state: 'failed',
        phase: 'terminal',
        errorCode: stableErrorCode(error)
      })
      await this.readAndEmit(input.requestId)
    } catch { /* cancellation, deletion, or a concurrent terminal write remains authoritative */ }
  }

  async get (request) {
    try {
      c.assertControlRequest(request)
      const row = await this.readRow(request.request_id)
      return c.assertGetResponse({
        ...header(), ok: true, error: null,
        result: { snapshot: publicSnapshot(row) }
      })
    } catch (error) {
      return c.assertGetResponse(errorResponse(stableErrorCode(error), 'retry'))
    }
  }

  async cancel (request) {
    try {
      c.assertCancelRequest(request)
      this.controllers.get(request.request_id)?.abort()
      const row = await this.storage.cancelSessionSummaryRequest({
        requestId: request.request_id,
        generation: request.generation
      })
      const linkedRunId = row.targetRunId || row.routeRunId
      if (linkedRunId && this.scheduler && typeof this.scheduler.cancel === 'function') this.scheduler.cancel(linkedRunId)
      const latest = await this.readRow(request.request_id)
      this.emitChanged(latest)
      return c.assertCancelResponse({
        ...header(), ok: true, error: null,
        result: { snapshot: publicSnapshot(latest) }
      })
    } catch (error) {
      const nextAction = error?.code === 'AGENT_CONTEXT_REVISION_CONFLICT' ? 'refresh_status' : 'verify_state'
      return c.assertCancelResponse(errorResponse(stableErrorCode(error), nextAction))
    }
  }

  requestForRun (runId) {
    return this.runRequests.get(runId) || null
  }
}

module.exports = { REQUEST_TARGETS, SUMMARY_PROMPT, SessionSummaryRunService, publicSnapshot, requestIdentity }
