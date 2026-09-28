'use strict'

const { performance } = require('node:perf_hooks')
const { canonicalize, sha256Canonical } = require('../../runtime/storage-worker/canonical-json')
const runContract = require('../contracts/agent-run-ui')
const c = require('../contracts/session-summary-run-ui')
const diagnosticsContract = require('../contracts/agent-run-diagnostics')
const { assertDiagnosticMetrics } = diagnosticsContract
const { BUDGET_AXES } = require('../contracts/budget-axes')

const SUMMARY_PROMPT = '请基于这场已结束的会话生成会话总结，包含主要内容、决定、待办和需要注意。'
const SUMMARY_PROMPTS_BY_DIGEST = new Map([[sha256Canonical(SUMMARY_PROMPT), SUMMARY_PROMPT]])
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

function publicSnapshot (row, elapsedMs = row.elapsedMs, diagnosticsAvailable = row.diagnosticsAvailable) {
  const activityAge = row.lastActivityElapsedMs > 0 && elapsedMs >= row.lastActivityElapsedMs
    ? elapsedMs - row.lastActivityElapsedMs
    : null
  return c.assertRequestSnapshot({
    request_id: row.requestId,
    generation: row.generation,
    revision: row.revision,
    action: row.action,
    state: row.state,
    phase: row.phase,
    attempt: row.attempt,
    elapsed_ms: elapsedMs,
    last_activity_age_ms: activityAge,
    validated_chunk_count: row.validatedChunkCount,
    total_chunk_count: row.totalChunkCount,
    memory_state: row.memoryState,
    error_code: row.errorCode,
    budget: row.budget,
    freshness: 'fresh',
    cancel_requested: row.cancelRequested,
    resume_required: row.resumeRequired,
    diagnostics_available: diagnosticsAvailable,
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
    inputDigest: frozen.inputDigest,
    ...(request.resubmits_request_id ? { resubmitsRequestId: request.resubmits_request_id } : {})
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

function diagnosticUnitForAxis (axis) {
  if (!axis) return null
  if (axis.includes('Bytes')) return 'bytes'
  if (axis.includes('WallClock') || axis === 'toolTimeoutMs') return 'duration_ms'
  return 'count'
}

function diagnosticEventForProgress (event) {
  if (diagnosticsContract.DIAGNOSTIC_EVENTS.includes(event.diagnosticEvent)) return event.diagnosticEvent
  if (event.phase === 'retry_wait') return 'backoff'
  if (event.phase === 'preparing') return 'planning'
  return null
}

class SessionSummaryRunService {
  constructor (options = {}) {
    if (!options.storage || typeof options.storage.acceptSessionSummaryRequest !== 'function' ||
        typeof options.storage.getSessionSummaryRequest !== 'function' ||
        typeof options.storage.cancelSessionSummaryRequest !== 'function' ||
        typeof options.storage.updateSessionSummaryRequest !== 'function' ||
        typeof options.storage.recoverSessionSummaryRequests !== 'function' ||
        typeof options.storage.listRecoverableSessionSummaryRequests !== 'function' ||
        typeof options.storage.resumeSessionSummaryRequest !== 'function' ||
        typeof options.storage.failUnrecoverableSessionSummaryRequest !== 'function' ||
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
    this.diagnostics = options.diagnostics && typeof options.diagnostics.record === 'function' ? options.diagnostics : null
    this.defer = typeof options.defer === 'function' ? options.defer : (callback) => setImmediate(callback)
    this.onChanged = typeof options.onChanged === 'function' ? options.onChanged : () => {}
    this.monotonicNow = typeof options.monotonicNow === 'function' ? options.monotonicNow : () => performance.now()
    this.listeners = new Set()
    this.controllers = new Map()
    this.dispatches = new Map()
    this.runRequests = new Map()
    this.progressClocks = new Map()
    this.progressQueues = new Map()
    this.diagnosticRequests = new Map()
    this.terminalDiagnosticKeys = new Map()
  }

  rememberDiagnosticRequest (row) {
    if (!row || typeof row.requestId !== 'string') return
    this.diagnosticRequests.delete(row.requestId)
    this.diagnosticRequests.set(row.requestId, {
      requestDigest: /^[a-f0-9]{64}$/.test(row.requestDigest || '') ? row.requestDigest : null,
      generation: row.generation
    })
    while (this.diagnosticRequests.size > 256) this.diagnosticRequests.delete(this.diagnosticRequests.keys().next().value)
  }

  recordDiagnostic (row, event, options = {}) {
    if (!this.diagnostics || !row || typeof row.requestId !== 'string') return false
    const metadata = this.diagnosticRequests.get(row.requestId)
    const budget = options.budget || row.budget || null
    const elapsedMs = Number.isSafeInteger(options.elapsedMs)
      ? options.elapsedMs
      : this.elapsedFor(row)
    const lastActivityAgeMs = row.lastActivityElapsedMs > 0 && elapsedMs >= row.lastActivityElapsedMs
      ? elapsedMs - row.lastActivityElapsedMs
      : null
    const actual = Number.isSafeInteger(budget?.actual) && budget.actual >= 0 ? budget.actual : null
    const limit = Number.isSafeInteger(budget?.limit) && budget.limit >= 0 ? budget.limit : null
    const axis = budget && BUDGET_AXES.includes(budget.axis)
      ? budget.axis
      : null
    const metrics = actual !== null && limit !== null
      ? { actual, limit, unit: diagnosticUnitForAxis(axis) }
      : { actual: null, limit: null, unit: null }
    return this.diagnostics.record({
      requestId: row.requestId,
      requestDigest: metadata?.requestDigest || ( /^[a-f0-9]{64}$/.test(row.requestDigest || '') ? row.requestDigest : null),
      runId: options.runId !== undefined ? options.runId : row.targetRunId || row.routeRunId || null,
      attempt: Number.isSafeInteger(options.attempt) ? options.attempt : row.attempt,
      phase: options.phase || row.phase,
      event,
      elapsedMs: elapsedMs ?? null,
      lastActivityAgeMs,
      errorCode: options.errorCode !== undefined ? options.errorCode : row.errorCode || null,
      budgetAxis: options.budgetAxis !== undefined ? options.budgetAxis : axis,
      metrics: options.metrics || metrics,
      modelBindingDigest: options.modelBindingDigest || null,
      planDigest: options.planDigest || null
    })
  }

  async setDiagnosticsAvailability (available) {
    if (typeof available !== 'boolean') return 0
    let rows
    try { rows = await this.storage.listRecoverableSessionSummaryRequests() } catch { return 0 }
    let updatedCount = 0
    const changedIds = new Set()
    for (const row of rows) {
      if (row.diagnosticsAvailable === available) continue
      try {
        const updated = await this.updateDiagnosticsAvailabilityForRow(row, available)
        if (updated === row) continue
        this.emitChanged(updated)
        changedIds.add(row.requestId)
        updatedCount += 1
      } catch { /* terminal/cancelled or concurrently changed requests remain authoritative */ }
    }
    for (const [requestId, metadata] of this.diagnosticRequests) {
      if (changedIds.has(requestId)) continue
      try {
        const row = await this.readRow(requestId)
        if (row.generation === metadata.generation) this.emitChanged(row)
      } catch { /* deleted requests have no visible diagnostic status */ }
    }
    return updatedCount
  }

  async updateDiagnosticsAvailabilityForRow (row, available) {
    if (!row || row.diagnosticsAvailable === available || TERMINAL_STATES.has(row.state)) return row
    try {
      return await this.storage.updateSessionSummaryRequest({
        requestId: row.requestId,
        generation: row.generation,
        expectedRevision: row.revision,
        diagnosticsAvailable: available
      })
    } catch { return row }
  }

  recordTerminalDiagnostic (row) {
    if (!row || !TERMINAL_STATES.has(row.state)) return false
    const key = `${row.requestId}:${row.generation}:${row.revision}`
    if (this.terminalDiagnosticKeys.has(key)) return false
    this.terminalDiagnosticKeys.set(key, true)
    while (this.terminalDiagnosticKeys.size > 256) this.terminalDiagnosticKeys.delete(this.terminalDiagnosticKeys.keys().next().value)
    return this.recordDiagnostic(row, row.state === 'cancelled' ? 'cancelled' : 'terminal', {
      phase: 'terminal',
      errorCode: row.errorCode || null
    })
  }

  recordProgressDiagnostic (event) {
    if (!this.diagnostics) return false
    const diagnosticEvent = diagnosticEventForProgress(event)
    if (!diagnosticEvent) return false
    const metadata = this.diagnosticRequests.get(event.requestId)
    if (metadata && metadata.generation !== event.generation) return false
    const elapsedMs = this.elapsedForRequest(event.requestId, event.generation)
    const metrics = event.metrics || { actual: null, limit: null, unit: null }
    try { assertDiagnosticMetrics(metrics) } catch { return false }
    const errorCode = event.errorCode || null
    const budgetAxis = event.budgetAxis || null
    if (errorCode !== null && !c.ERROR_CODES.includes(errorCode) || budgetAxis !== null && !BUDGET_AXES.includes(budgetAxis)) return false
    if (event.diagnosticEvent === 'budget_rejected' && errorCode === null) return false
    return this.diagnostics.record({
      requestId: event.requestId,
      requestDigest: metadata?.requestDigest || null,
      runId: event.runId,
      attempt: event.attempt,
      phase: event.phase,
      event: diagnosticEvent,
      elapsedMs,
      lastActivityAgeMs: event.activity === true ? 0 : null,
      errorCode,
      budgetAxis,
      metrics,
      modelBindingDigest: event.modelBindingDigest || null,
      planDigest: null
    })
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

  async recoverAfterRestart () {
    const rows = await this.storage.recoverSessionSummaryRequests()
    for (const row of rows) {
      this.rememberDiagnosticRequest(row)
      this.recordDiagnostic(row, 'recovery', { phase: row.phase })
      if (row.action === 'summary' && row.resumeRequired && !SUMMARY_PROMPTS_BY_DIGEST.has(row.promptDigest)) {
        const failed = await this.storage.failUnrecoverableSessionSummaryRequest({
          requestId: row.requestId,
          generation: row.generation,
          expectedRevision: row.revision
        })
        this.recordTerminalDiagnostic(failed)
        this.emitChanged(failed)
        continue
      }
      if (row.action === 'summary' && row.resumeRequired && row.targetRunId && this.promptStore) {
        const prompt = SUMMARY_PROMPTS_BY_DIGEST.get(row.promptDigest)
        if (prompt) this.promptStore.set(row.targetRunId, prompt)
      }
      this.emitChanged(row)
    }
    return rows.length
  }

  async listRecoverable (request) {
    try {
      c.assertListRecoverableRequest(request)
      const rows = await this.storage.listRecoverableSessionSummaryRequests()
      return c.assertListRecoverableResponse({
        ...header(), ok: true, error: null,
        result: {
          requests: rows.map((row) => ({
            scope: row.scope,
            snapshot: this.snapshotFor(row)
          }))
        }
      })
    } catch (error) {
      return c.assertListRecoverableResponse(errorResponse(stableErrorCode(error), 'retry'))
    }
  }

  async resume (request) {
    try {
      c.assertResumeRequest(request)
      const row = await this.readRow(request.request_id)
      if (row.generation !== request.generation || row.revision !== request.expected_revision ||
          row.state !== 'retry_wait' || !row.resumeRequired || row.cancelRequested) {
        const conflict = new Error('request is no longer waiting for explicit continuation')
        conflict.code = 'AGENT_CONTEXT_REVISION_CONFLICT'
        throw conflict
      }
      if (row.action !== 'summary') throw Object.assign(new Error('question prompt is not recoverable'), { code: 'AGENT_REQUEST_INVALID' })
      const prompt = SUMMARY_PROMPTS_BY_DIGEST.get(row.promptDigest)
      if (!prompt) throw Object.assign(new Error('fixed prompt version is not recoverable'), { code: 'AGENT_REQUEST_INVALID' })
      if (row.targetRunId && !this.promptStore) {
        throw Object.assign(new Error('fixed prompt store is unavailable'), { code: 'AGENT_RUN_UNAVAILABLE' })
      }
      const frozen = frozenInput(row)
      if (!frozen) throw Object.assign(new Error('frozen source identity is unavailable'), { code: 'AGENT_REQUEST_INVALID' })
      const current = await this.storage.derivePersonalContextSessionSource({
        sessionId: row.scope.reference,
        transcriptVersion: frozen.transcriptVersion
      })
      const currentWatermark = Number.isSafeInteger(current.inputWatermark)
        ? { throughEventOrder: current.inputWatermark }
        : current.inputWatermark
      if ((current.transcriptVersion || 'raw') !== frozen.transcriptVersion ||
          canonicalize(currentWatermark) !== canonicalize(frozen.inputWatermark) || current.inputDigest !== frozen.inputDigest) {
        throw Object.assign(new Error('frozen source changed before continuation'), { code: 'AGENT_REQUEST_INVALID' })
      }
      if (row.targetRunId && this.promptStore) this.promptStore.set(row.targetRunId, prompt)
      const resumed = await this.storage.resumeSessionSummaryRequest({
        requestId: row.requestId,
        generation: row.generation,
        expectedRevision: row.revision
      })
      this.rememberDiagnosticRequest(resumed)
      this.recordDiagnostic(resumed, 'recovery', { phase: resumed.phase })
      this.startClock(resumed)
      if (resumed.targetRunId) {
        this.runRequests.set(resumed.targetRunId, { requestId: resumed.requestId, generation: resumed.generation })
        if (this.scheduler && typeof this.scheduler.wake === 'function') this.scheduler.wake('resume')
      } else {
        this.scheduleDispatch({
          requestId: resumed.requestId,
          generation: resumed.generation,
          action: resumed.action,
          summaryUseMemory: resumed.summaryUseMemory,
          scope: row.scope,
          ...frozen,
          clientIdempotencyKey: `${resumed.requestId}.generation.${resumed.generation}`,
          prompt
        })
      }
      this.emitChanged(resumed)
      return c.assertResumeResponse({
        ...header(), ok: true, error: null,
        result: { snapshot: this.snapshotFor(resumed) }
      })
    } catch (error) {
      const nextAction = error?.code === 'AGENT_CONTEXT_REVISION_CONFLICT' ? 'refresh_status' :
        error?.code === 'AGENT_REQUEST_INVALID' ? 'resubmit' : 'retry'
      return c.assertResumeResponse(errorResponse(stableErrorCode(error), nextAction))
    }
  }

  startClock (row) {
    if (!row || TERMINAL_STATES.has(row.state)) return
    const current = this.progressClocks.get(row.requestId)
    if (current?.generation === row.generation) return
    this.progressClocks.set(row.requestId, {
      generation: row.generation,
      baseElapsedMs: row.elapsedMs,
      monotonicAt: this.monotonicNow()
    })
  }

  elapsedFor (row) {
    if (!row || TERMINAL_STATES.has(row.state) || row.state === 'cancelling') return row?.elapsedMs ?? 0
    const clock = this.progressClocks.get(row.requestId)
    if (!clock || clock.generation !== row.generation) return row.elapsedMs
    return Math.max(row.elapsedMs, clock.baseElapsedMs + Math.max(0, Math.floor(this.monotonicNow() - clock.monotonicAt)))
  }

  elapsedForRequest (requestId, generation) {
    const clock = this.progressClocks.get(requestId)
    if (!clock || clock.generation !== generation) return null
    return Math.max(clock.baseElapsedMs, clock.baseElapsedMs + Math.max(0, Math.floor(this.monotonicNow() - clock.monotonicAt)))
  }

  snapshotFor (row) {
    const diagnosticsStatus = this.diagnostics?.getStatus?.()
    const diagnosticsAvailable = typeof diagnosticsStatus?.available === 'boolean'
      ? diagnosticsStatus.available
      : row.diagnosticsAvailable
    return publicSnapshot(row, this.elapsedFor(row), diagnosticsAvailable)
  }

  recordProgress (event, signal) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return Promise.resolve(null)
    const allowed = new Set([
      'requestId', 'generation', 'runId', 'attemptIdentity', 'attempt', 'phase', 'state', 'activity', 'memoryState',
      'diagnosticEvent', 'modelBindingDigest', 'errorCode', 'budgetAxis', 'metrics'
    ])
    const actual = Object.keys(event)
    if (actual.some((key) => !allowed.has(key)) ||
        typeof event.requestId !== 'string' || !Number.isSafeInteger(event.generation) || event.generation < 1 ||
        !(event.runId === null || typeof event.runId === 'string') ||
        !Number.isSafeInteger(event.attempt) || event.attempt < 0 ||
        !c.PHASES.includes(event.phase) ||
        event.state !== undefined && !c.STATES.includes(event.state) ||
        event.activity !== undefined && typeof event.activity !== 'boolean' ||
        event.memoryState !== undefined && !c.MEMORY_STATES.includes(event.memoryState) ||
        event.diagnosticEvent !== undefined && !diagnosticsContract.DIAGNOSTIC_EVENTS.includes(event.diagnosticEvent) ||
        event.modelBindingDigest !== undefined && !/^[a-f0-9]{64}$/.test(event.modelBindingDigest) ||
        event.errorCode !== undefined && !c.ERROR_CODES.includes(event.errorCode) ||
        event.budgetAxis !== undefined && event.budgetAxis !== null && !BUDGET_AXES.includes(event.budgetAxis)) return Promise.resolve(null)
    if (event.metrics !== undefined) {
      try { assertDiagnosticMetrics(event.metrics) } catch { return Promise.resolve(null) }
    }
    if (event.diagnosticEvent === 'budget_rejected' && (event.errorCode === undefined || event.metrics === undefined)) {
      return Promise.resolve(null)
    }
    if (event.runId !== null && event.attempt > 0) {
      const identity = event.attemptIdentity
      if (!identity || Object.keys(identity).sort().join(',') !== 'attempt,leaseExpiresAt,owner,runId' ||
          identity.runId !== event.runId || identity.attempt !== event.attempt ||
          typeof identity.owner !== 'string' || !Number.isSafeInteger(identity.leaseExpiresAt) || identity.leaseExpiresAt < 0) return Promise.resolve(null)
    } else if (event.attemptIdentity !== undefined) return Promise.resolve(null)
    const prior = this.progressQueues.get(event.requestId) || Promise.resolve()
    const task = prior.catch(() => null).then(() => {
      if (signal?.aborted) return null
      return this.persistProgress(event, signal).then((updated) => {
        if (updated) this.recordProgressDiagnostic(event)
        return updated
      })
    })
    this.progressQueues.set(event.requestId, task)
    return task.finally(() => {
      if (this.progressQueues.get(event.requestId) === task) this.progressQueues.delete(event.requestId)
    })
  }

  async persistProgress (event, signal) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (signal?.aborted) return null
      let row
      try { row = await this.readRow(event.requestId) } catch { return null }
      if (signal?.aborted) return null
      if (row.generation !== event.generation || row.cancelRequested || TERMINAL_STATES.has(row.state)) return null
      if (event.runId !== null && event.runId !== row.routeRunId && event.runId !== row.targetRunId) return null
      if (event.attempt < row.attempt) return null
      this.startClock(row)
      let elapsedMs = this.elapsedFor(row)
      const newAttempt = event.attempt > row.attempt
      let memoryState = event.memoryState
      if (memoryState === undefined) {
        memoryState = newAttempt
          ? row.summaryUseMemory === false ? 'not_used' : 'not_read'
          : row.memoryState
      }
      let lastActivityElapsedMs = row.lastActivityElapsedMs
      if (event.activity === true) {
        lastActivityElapsedMs = Math.max(1, elapsedMs)
        elapsedMs = Math.max(elapsedMs, lastActivityElapsedMs)
      }
      const update = {
        requestId: event.requestId,
        generation: event.generation,
        expectedRevision: row.revision,
        phase: event.phase,
        attempt: event.attempt,
        elapsedMs,
        lastActivityElapsedMs,
        memoryState
      }
      if (event.state !== undefined) update.state = event.state
      if (event.attemptIdentity !== undefined) update.attemptIdentity = { ...event.attemptIdentity }
      if (newAttempt) {
        update.validatedChunkCount = null
        update.totalChunkCount = null
      }
      try {
        const updated = await this.storage.updateSessionSummaryRequest(update, signal)
        this.emitChanged(updated)
        return updated
      } catch (error) {
        if (error?.code !== 'AGENT_CONTEXT_REVISION_CONFLICT') return null
      }
    }
    return null
  }

  async notifyRunChanged (event) {
    if (!event || typeof event.requestId !== 'string' || !Number.isSafeInteger(event.generation) ||
        typeof event.runId !== 'string') return null
    try {
      const row = await this.readRow(event.requestId)
      if (row.generation !== event.generation || (row.targetRunId !== event.runId && row.routeRunId !== event.runId)) return null
      this.rememberDiagnosticRequest(row)
      this.recordTerminalDiagnostic(row)
      this.emitChanged(row)
      return row
    } catch { return null }
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
            ...(request.resubmits_request_id ? { resubmitsRequestId: request.resubmits_request_id } : {}),
            ...frozen
          })
        }
        const row = await this.readRow(identity.requestId)
        this.rememberDiagnosticRequest(row)
        if (frozen && !row.cancelRequested && !row.resumeRequired && !TERMINAL_STATES.has(row.state)) {
          this.startClock(row)
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
          result: { accepted: true, replayed: true, snapshot: this.snapshotFor(row) }
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
        ...(request.resubmits_request_id ? { resubmitsRequestId: request.resubmits_request_id } : {}),
        ...frozenIdentity
      })
      let row = await this.readRow(identity.requestId)
      const diagnosticsStatus = this.diagnostics?.getStatus?.()
      if (typeof diagnosticsStatus?.available === 'boolean') {
        row = await this.updateDiagnosticsAvailabilityForRow(row, diagnosticsStatus.available)
      }
      this.rememberDiagnosticRequest(row)
      if (accepted.replayed !== true) this.recordDiagnostic(row, 'accepted', { phase: 'accepted' })
      if (!row.cancelRequested && !TERMINAL_STATES.has(row.state)) this.startClock(row)
      const response = c.assertAcceptResponse({
        ...header(), ok: true, error: null,
        result: { accepted: true, replayed: accepted.replayed === true, snapshot: this.snapshotFor(row) }
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
      if (current.cancelRequested || current.resumeRequired || TERMINAL_STATES.has(current.state)) return
      await this.recordProgress({
        requestId: input.requestId,
        generation: input.generation,
        runId: null,
        attempt: 0,
        phase: 'preparing',
        state: input.action === 'question' ? 'routing' : 'preparing',
        activity: false,
        diagnosticEvent: 'planning'
      })
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
        requestGeneration: input.generation,
        ...(input.action === 'question' ? { onProgress: (event) => this.recordProgress({
          requestId: input.requestId,
          generation: input.generation,
          runId: event?.runId ?? null,
          attempt: 0,
          phase: 'waiting_model',
          activity: true
        }, controller.signal) } : {})
      }
      const routed = input.action === 'summary'
        ? await this.routeOrchestrator.submitFixedTarget({ ...routeInput, summaryUseMemory: input.summaryUseMemory })
        : await this.routeOrchestrator.submit({ ...routeInput, permittedTargetRecipes: [...REQUEST_TARGETS] })
      if (routed?.unsupported === true || routed?.eligibility !== 'ready' || typeof routed?.runId !== 'string' || typeof routed?.interactionId !== 'string') {
        throw Object.assign(new Error('target route unavailable'), { code: 'AGENT_RUN_UNAVAILABLE' })
      }
      const latest = await this.readRow(input.requestId)
      if (latest.cancelRequested || latest.resumeRequired || TERMINAL_STATES.has(latest.state)) {
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
      this.rememberDiagnosticRequest(row)
      const failureCode = stableErrorCode(error)
      if (failureCode === 'AGENT_BUDGET_EXCEEDED' || failureCode === 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED') {
        const suppliedBudget = error?.budget && typeof error.budget === 'object' ? error.budget : null
        const suppliedAxis = BUDGET_AXES.includes(error?.budgetAxis) ? error.budgetAxis :
          suppliedBudget && BUDGET_AXES.includes(suppliedBudget.axis) ? suppliedBudget.axis : null
        const actual = Number.isSafeInteger(error?.actual) && error.actual >= 0 ? error.actual :
          Number.isSafeInteger(suppliedBudget?.actual) && suppliedBudget.actual >= 0 ? suppliedBudget.actual : null
        const limit = Number.isSafeInteger(error?.limit) && error.limit >= 0 ? error.limit :
          Number.isSafeInteger(suppliedBudget?.limit) && suppliedBudget.limit >= 0 ? suppliedBudget.limit : null
        const unit = diagnosticUnitForAxis(suppliedAxis) ||
          (failureCode === 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED' && actual !== null && limit !== null ? 'bytes' : null)
        this.recordDiagnostic(row, 'budget_rejected', {
          errorCode: failureCode,
          budgetAxis: suppliedAxis,
          metrics: actual !== null && limit !== null
            ? { actual, limit, unit }
            : { actual: null, limit: null, unit: null }
        })
      }
      if (error?.code === 'AGENT_CANCELLED' && !row.cancelRequested) {
        this.emitChanged(row)
        return
      }
      if (row.routeRunId || row.targetRunId) {
        this.emitChanged(row)
        return
      }
      await this.recordProgress({
        requestId: input.requestId,
        generation: input.generation,
        runId: null,
        attempt: row.attempt,
        phase: c.PHASES.includes(row.phase) ? row.phase : 'preparing',
        activity: false
      })
      const latest = await this.readRow(input.requestId)
      if (latest.cancelRequested || TERMINAL_STATES.has(latest.state)) return
      await this.storage.updateSessionSummaryRequest({
        requestId: input.requestId,
        generation: input.generation,
        expectedRevision: latest.revision,
        state: 'failed',
        phase: 'terminal',
        errorCode: failureCode
      })
      const failed = await this.readRow(input.requestId)
      this.recordTerminalDiagnostic(failed)
      this.emitChanged(failed)
    } catch { /* cancellation, deletion, or a concurrent terminal write remains authoritative */ }
  }

  async get (request) {
    try {
      c.assertControlRequest(request)
      const row = await this.readRow(request.request_id)
      return c.assertGetResponse({
        ...header(), ok: true, error: null,
        result: { snapshot: this.snapshotFor(row) }
      })
    } catch (error) {
      return c.assertGetResponse(errorResponse(stableErrorCode(error), 'retry'))
    }
  }

  async cancel (request) {
    try {
      c.assertCancelRequest(request)
      const elapsedMs = this.elapsedForRequest(request.request_id, request.generation)
      this.controllers.get(request.request_id)?.abort()
      this.cancelScheduledRuns(request.request_id, request.generation)
      const cancelRequest = {
        requestId: request.request_id,
        generation: request.generation
      }
      if (elapsedMs !== null) cancelRequest.elapsedMs = elapsedMs
      const row = await this.storage.cancelSessionSummaryRequest(cancelRequest)
      const linkedRunId = row.targetRunId || row.routeRunId
      if (linkedRunId && this.scheduler && typeof this.scheduler.cancel === 'function') this.scheduler.cancel(linkedRunId)
      const latest = await this.readRow(request.request_id)
      this.rememberDiagnosticRequest(latest)
      this.recordDiagnostic(latest, 'cancel_requested', { phase: 'cancelling' })
      this.recordTerminalDiagnostic(latest)
      this.emitChanged(latest)
      return c.assertCancelResponse({
        ...header(), ok: true, error: null,
        result: { snapshot: this.snapshotFor(latest) }
      })
    } catch (error) {
      const nextAction = error?.code === 'AGENT_CONTEXT_REVISION_CONFLICT' ? 'refresh_status' : 'verify_state'
      return c.assertCancelResponse(errorResponse(stableErrorCode(error), nextAction))
    }
  }

  cancelScheduledRuns (requestId, generation) {
    if (!this.scheduler || typeof this.scheduler.cancel !== 'function') return
    for (const [runId, identity] of this.runRequests) {
      if (identity.requestId !== requestId || identity.generation !== generation) continue
      this.scheduler.cancel(runId)
    }
  }

  requestForRun (runId) {
    return this.runRequests.get(runId) || null
  }
}

module.exports = { REQUEST_TARGETS, SUMMARY_PROMPT, SessionSummaryRunService, publicSnapshot, requestIdentity }
