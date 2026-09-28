'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { SessionSummaryRunService } = require('../../src/agent/formal-run/session-summary-run-service')

function snapshotRow (overrides = {}) {
  return {
    requestId: 'request.progress.one',
    generation: 1,
    revision: 0,
    action: 'summary',
    state: 'running',
    phase: 'preparing',
    attempt: 1,
    elapsedMs: 0,
    lastActivityElapsedMs: 0,
    validatedChunkCount: null,
    totalChunkCount: null,
    memoryState: 'not_read',
    errorCode: null,
    budget: null,
    cancelRequested: false,
    resumeRequired: false,
    diagnosticsAvailable: false,
    routeRunId: null,
    targetRunId: 'run.progress.one',
    targetInteractionId: 'interaction.progress.one',
    targetRecipeId: 'summary.minutes',
    targetRoutingMode: 'preset',
    summaryUseMemory: true,
    ...overrides
  }
}

function progressService (initialRow, clock, { cancelState = 'cancelled', diagnostics = null } = {}) {
  let row = { ...initialRow }
  const updates = []
  const cancellations = []
  const changed = []
  const storage = {
    async acceptSessionSummaryRequest () { throw new Error('not used') },
    async recoverSessionSummaryRequests () { return [] },
    async listRecoverableSessionSummaryRequests () { return row.state === 'succeeded' || row.state === 'failed' || row.state === 'cancelled' ? [] : [{ ...row }] },
    async resumeSessionSummaryRequest () { throw new Error('not used') },
    async failUnrecoverableSessionSummaryRequest () { throw new Error('not used') },
    async getSessionSummaryRequest () { return { ...row } },
    async cancelSessionSummaryRequest (input) {
      cancellations.push({ ...input })
      if (row.state === 'cancelling' && row.cancelRequested) return { ...row, replayed: true }
      row = {
        ...row,
        state: cancelState,
        phase: cancelState === 'cancelling' ? 'cancelling' : 'terminal',
        cancelRequested: true,
        elapsedMs: input.elapsedMs ?? row.elapsedMs,
        revision: row.revision + 1
      }
      return { ...row }
    },
    async derivePersonalContextSessionSource () { throw new Error('not used') },
    async updateSessionSummaryRequest (input) {
      updates.push({ ...input })
      assert.equal(input.expectedRevision, row.revision)
      row = {
        ...row,
        state: input.state ?? row.state,
        phase: input.phase ?? row.phase,
        attempt: input.attempt ?? row.attempt,
        elapsedMs: input.elapsedMs ?? row.elapsedMs,
        lastActivityElapsedMs: input.lastActivityElapsedMs ?? row.lastActivityElapsedMs,
        validatedChunkCount: input.validatedChunkCount === undefined ? row.validatedChunkCount : input.validatedChunkCount,
        totalChunkCount: input.totalChunkCount === undefined ? row.totalChunkCount : input.totalChunkCount,
        memoryState: input.memoryState ?? row.memoryState,
        diagnosticsAvailable: input.diagnosticsAvailable === undefined ? row.diagnosticsAvailable : input.diagnosticsAvailable,
        revision: row.revision + 1
      }
      return { ...row }
    }
  }
  const service = new SessionSummaryRunService({
    storage,
    runService: { async getEligibility () { return { ok: true } } },
    diagnostics,
    monotonicNow: () => clock.value,
    onChanged: (event) => changed.push(event)
  })
  return { service, storage, updates, cancellations, changed, getRow: () => ({ ...row }) }
}

const attemptIdentity = Object.freeze({
  runId: 'run.progress.one', attempt: 1, owner: 'owner.progress.one', leaseExpiresAt: 30000
})

test('SEM-F40/J30-DIAG: diagnostic availability updates the active request snapshot and emits a refresh', async () => {
  const clock = { value: 0 }
  const { service, changed, getRow } = progressService(snapshotRow(), clock)
  assert.equal(await service.setDiagnosticsAvailability(true), 1)
  assert.equal(getRow().diagnosticsAvailable, true)
  assert.equal(getRow().revision, 1)
  assert.equal(changed.at(-1).revision, 1)

  const available = await service.get({
    contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0',
    request_id: 'request.progress.one'
  })
  assert.equal(available.result.snapshot.diagnostics_available, true)
  await service.setDiagnosticsAvailability(false)
  const unavailable = await service.get({
    contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0',
    request_id: 'request.progress.one'
  })
  assert.equal(unavailable.result.snapshot.diagnostics_available, false)
})

test('SEM-F40/J30-DIAG: initializing diagnostics are reported unavailable until ready', async () => {
  const clock = { value: 0 }
  let status = { available: false, state: 'initializing' }
  const diagnostics = {
    getStatus: () => status,
    record: () => true
  }
  const { service } = progressService(snapshotRow({ diagnosticsAvailable: true }), clock, { diagnostics })
  const initializing = await service.get({
    contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0',
    request_id: 'request.progress.one'
  })
  assert.equal(initializing.result.snapshot.diagnostics_available, false)

  status = { available: true, state: 'available' }
  const ready = await service.get({
    contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0',
    request_id: 'request.progress.one'
  })
  assert.equal(ready.result.snapshot.diagnostics_available, true)
})

test('SEM-F40/J30-DIAG: known budget rejection persists actual/limit bytes through the summary service', async () => {
  const clock = { value: 0 }
  const diagnostics = []
  const { service } = progressService(snapshotRow(), clock, {
    diagnostics: { record: (input) => { diagnostics.push(input); return true } }
  })
  await service.recordProgress({
    requestId: 'request.progress.one', generation: 1, runId: 'run.progress.one',
    attemptIdentity, attempt: 1, phase: 'preparing', activity: false,
    diagnosticEvent: 'budget_rejected', errorCode: 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED',
    budgetAxis: null, metrics: { actual: 15001, limit: 15000, unit: 'bytes' }
  })
  assert.equal(diagnostics.length, 1)
  assert.equal(diagnostics[0].event, 'budget_rejected')
  assert.equal(diagnostics[0].errorCode, 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED')
  assert.equal(diagnostics[0].metrics.actual, 15001)
  assert.equal(diagnostics[0].metrics.limit, 15000)
})

test('SEM-F40/J30-DIAG: stale attempts rejected by storage do not write progress diagnostics', async () => {
  const clock = { value: 0 }
  const diagnostics = []
  const { service } = progressService(snapshotRow({ attempt: 2 }), clock, {
    diagnostics: { record: (input) => { diagnostics.push(input); return true } }
  })
  const persisted = await service.recordProgress({
    requestId: 'request.progress.one', generation: 1, runId: 'run.progress.one',
    attemptIdentity, attempt: 1, phase: 'waiting_model', activity: true,
    diagnosticEvent: 'model_request_started'
  })
  assert.equal(persisted, null)
  assert.equal(diagnostics.length, 0)
})

test('SEM-F40/J30-DIAG: token budget measurements use the registered count unit', () => {
  const diagnostics = []
  const { service } = progressService(snapshotRow({
    budget: { axis: 'maxRequestInputTokens', actual: 1201, limit: 1200 }
  }), { value: 0 }, {
    diagnostics: { record: (input) => { diagnostics.push(input); return true } }
  })
  service.recordDiagnostic(snapshotRow({
    budget: { axis: 'maxRequestInputTokens', actual: 1201, limit: 1200 }
  }), 'budget_rejected', { errorCode: 'AGENT_BUDGET_EXCEEDED' })
  assert.equal(diagnostics[0].metrics.unit, 'count')
  assert.equal(diagnostics[0].budgetAxis, 'maxRequestInputTokens')
})

test('SEM-F38/J30-PROGRESS: snapshots advance elapsed time without inventing activity or revisions', async () => {
  const clock = { value: 0 }
  const { service, updates } = progressService(snapshotRow(), clock)
  await service.recordProgress({
    requestId: 'request.progress.one', generation: 1, runId: 'run.progress.one',
    attemptIdentity,
    attempt: 1, phase: 'waiting_model', activity: false
  })

  clock.value = 100
  const waiting = await service.get({
    contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0',
    request_id: 'request.progress.one'
  })
  assert.equal(waiting.ok, true)
  assert.equal(waiting.result.snapshot.phase, 'waiting_model')
  assert.equal(waiting.result.snapshot.elapsed_ms, 100)
  assert.equal(waiting.result.snapshot.last_activity_age_ms, null)
  assert.equal(waiting.result.snapshot.revision, 1)
  assert.equal(updates.length, 1)

  clock.value = 300
  await service.recordProgress({
    requestId: 'request.progress.one', generation: 1, runId: 'run.progress.one',
    attemptIdentity,
    attempt: 1, phase: 'waiting_model', activity: true
  })
  clock.value = 450
  const active = await service.get({
    contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0',
    request_id: 'request.progress.one'
  })
  assert.equal(active.result.snapshot.elapsed_ms, 450)
  assert.equal(active.result.snapshot.last_activity_age_ms, 150)
  assert.equal(active.result.snapshot.revision, 2)
  assert.equal(updates.length, 2)
})

test('SEM-F38/J30-RECOVERY: scheduler stop drops progress already queued behind an earlier snapshot', async () => {
  const clock = { value: 0 }
  const { service, storage, updates } = progressService(snapshotRow(), clock)
  let releaseFirst
  let firstUpdateStarted
  const firstStarted = new Promise((resolve) => { firstUpdateStarted = resolve })
  const gate = new Promise((resolve) => { releaseFirst = resolve })
  const persistUpdate = storage.updateSessionSummaryRequest.bind(storage)
  let updateCalls = 0
  storage.updateSessionSummaryRequest = async (input, signal) => {
    updateCalls += 1
    if (updateCalls === 1) {
      firstUpdateStarted()
      await gate
    }
    return persistUpdate(input, signal)
  }

  const first = service.recordProgress({
    requestId: 'request.progress.one', generation: 1, runId: 'run.progress.one',
    attemptIdentity, attempt: 1, phase: 'waiting_model', activity: false
  })
  await firstStarted
  const controller = new AbortController()
  const queued = service.recordProgress({
    requestId: 'request.progress.one', generation: 1, runId: 'run.progress.one',
    attemptIdentity, attempt: 1, phase: 'validating', activity: false
  }, controller.signal)
  const reason = new Error('scheduler stopped')
  reason.code = 'AGENT_SCHEDULER_STOPPED'
  controller.abort(reason)
  releaseFirst()

  await Promise.all([first, queued])
  assert.equal(updateCalls, 1)
  assert.equal(updates.length, 1)
  assert.equal(updates[0].phase, 'waiting_model')
})

test('SEM-F38/J30-PROGRESS: a new attempt clears prior chunk and memory observations', async () => {
  const clock = { value: 1000 }
  const { service, updates } = progressService(snapshotRow({
    attempt: 1,
    validatedChunkCount: 2,
    totalChunkCount: 4,
    memoryState: 'referenced'
  }), clock)
  await service.recordProgress({
    requestId: 'request.progress.one', generation: 1, runId: 'run.progress.one',
    attemptIdentity: { ...attemptIdentity, attempt: 2, leaseExpiresAt: 31000 },
    attempt: 2, phase: 'preparing', activity: false
  })

  assert.equal(updates[0].attempt, 2)
  assert.equal(updates[0].validatedChunkCount, null)
  assert.equal(updates[0].totalChunkCount, null)
  assert.equal(updates[0].memoryState, 'not_read')
})

test('SEM-F38/J30-PROGRESS: cancellation freezes the current elapsed time in the terminal snapshot', async () => {
  const clock = { value: 0 }
  const { service, cancellations } = progressService(snapshotRow(), clock)
  await service.recordProgress({
    requestId: 'request.progress.one', generation: 1, runId: 'run.progress.one',
    attemptIdentity,
    attempt: 1, phase: 'waiting_model', activity: true
  })
  clock.value = 1250

  const cancelled = await service.cancel({
    contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0',
    request_id: 'request.progress.one', generation: 1
  })
  assert.equal(cancellations.length, 1)
  assert.equal(cancellations[0].elapsedMs, 1250)
  assert.equal(cancelled.result.snapshot.state, 'cancelled')
  assert.equal(cancelled.result.snapshot.elapsed_ms, 1250)
})

test('SEM-F38/J30-CANCEL: scheduler abort precedes the persistent cancellation transaction', async () => {
  let releaseCancellation
  const cancellationGate = new Promise((resolve) => { releaseCancellation = resolve })
  const order = []
  const clock = { value: 0 }
  const { service, storage } = progressService(snapshotRow({ targetRunId: 'run.current' }), clock)
  const persistCancel = storage.cancelSessionSummaryRequest.bind(storage)
  storage.cancelSessionSummaryRequest = async (input) => {
    order.push('storage.cancel.begin')
    await cancellationGate
    return persistCancel(input)
  }
  service.scheduler = {
    cancel (runId) { order.push(`scheduler.cancel:${runId}`) }
  }
  service.runRequests.set('run.current', { requestId: 'request.progress.one', generation: 1 })
  service.runRequests.set('run.old-generation', { requestId: 'request.progress.one', generation: 0 })
  service.runRequests.set('run.other-request', { requestId: 'request.other', generation: 1 })

  const pending = service.cancel({
    contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0',
    request_id: 'request.progress.one', generation: 1
  })
  assert.deepEqual(order, ['scheduler.cancel:run.current', 'storage.cancel.begin'])
  releaseCancellation()
  const response = await pending
  assert.equal(response.ok, true)
  assert.equal(response.result.snapshot.state, 'cancelled')
})

test('SEM-F38/J30-PROGRESS: cancelling snapshots freeze elapsed and repeated cancellation replays the first value', async () => {
  const clock = { value: 0 }
  const { service, cancellations } = progressService(snapshotRow(), clock, { cancelState: 'cancelling' })
  await service.recordProgress({
    requestId: 'request.progress.one', generation: 1, runId: 'run.progress.one',
    attemptIdentity,
    attempt: 1, phase: 'waiting_model', activity: true
  })
  clock.value = 1250

  const cancelling = await service.cancel({
    contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0',
    request_id: 'request.progress.one', generation: 1
  })
  assert.equal(cancelling.result.snapshot.state, 'cancelling')
  assert.equal(cancelling.result.snapshot.elapsed_ms, 1250)

  clock.value = 1900
  const refreshed = await service.get({
    contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0',
    request_id: 'request.progress.one'
  })
  assert.equal(refreshed.result.snapshot.elapsed_ms, 1250)

  const replay = await service.cancel({
    contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0',
    request_id: 'request.progress.one', generation: 1
  })
  assert.equal(cancellations.length, 2)
  assert.equal(cancellations[0].elapsedMs, 1250)
  assert.equal(cancellations[1].elapsedMs, 1900)
  assert.equal(replay.result.snapshot.elapsed_ms, 1250)
})
