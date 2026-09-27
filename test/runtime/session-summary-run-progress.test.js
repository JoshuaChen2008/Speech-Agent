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

function progressService (initialRow, clock, { cancelState = 'cancelled' } = {}) {
  let row = { ...initialRow }
  const updates = []
  const cancellations = []
  const changed = []
  const storage = {
    async acceptSessionSummaryRequest () { throw new Error('not used') },
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
        revision: row.revision + 1
      }
      return { ...row }
    }
  }
  const service = new SessionSummaryRunService({
    storage,
    runService: { async getEligibility () { return { ok: true } } },
    monotonicNow: () => clock.value,
    onChanged: (event) => changed.push(event)
  })
  return { service, storage, updates, cancellations, changed, getRow: () => ({ ...row }) }
}

test('SEM-F38/J30-PROGRESS: snapshots advance elapsed time without inventing activity or revisions', async () => {
  const clock = { value: 0 }
  const { service, updates } = progressService(snapshotRow(), clock)
  await service.recordProgress({
    requestId: 'request.progress.one', generation: 1, runId: 'run.progress.one',
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
