'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { AgentExecutionStore } = require('../../src/runtime/storage-worker/agent-execution-store')
const { publicSnapshot } = require('../../src/agent/formal-run/session-summary-run-service')
const { FORMAL_AGENT_MIGRATIONS } = require('../../src/runtime/storage-worker/schema')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')
const { sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')
const { SessionDeletionStore } = require('../../src/runtime/storage-worker/session-deletion-store')

const SESSION_SUMMARY_MIGRATIONS = FORMAL_AGENT_MIGRATIONS.filter((migration) => migration.version < 15)

function fixture (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-request-store-'))
  const subtitleStore = new SqliteSubtitleStore({
    databasePath: path.join(root, 'speech-agent.sqlite3'),
    migrations: FORMAL_AGENT_MIGRATIONS,
    now: () => 1000
  })
  const store = new AgentExecutionStore({ subtitleStore, now: () => 2000 })
  t.after(() => {
    try { subtitleStore.close() } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { subtitleStore, store }
}

function acceptedRequest (overrides = {}) {
  return {
    requestId: 'request.p1.one',
    sessionId: 'session.p1',
    clientKeyDigest: '1'.repeat(64),
    requestDigest: '2'.repeat(64),
    scopeDigest: sha256Canonical({ kind: 'session', reference: 'session.p1' }),
    promptDigest: '4'.repeat(64),
    inputWatermark: { throughEventOrder: 5 },
    transcriptVersion: 'raw',
    inputDigest: '6'.repeat(64),
    action: 'summary',
    summaryUseMemory: true,
    ...overrides
  }
}

test('SEM-F38/DB1/J30-ACCEPT: accepted identity is durable, digest-only and idempotent', (t) => {
  const { subtitleStore, store } = fixture(t)
  const accepted = acceptedRequest()
  const first = store.acceptSessionSummaryRequest(accepted)
  assert.equal(first.requestId, accepted.requestId)
  assert.equal(first.state, 'accepted')
  assert.equal(first.revision, 0)
  assert.equal(first.diagnosticsAvailable, false)
  assert.deepEqual(store.acceptSessionSummaryRequest(accepted), { ...first, replayed: true })
  const row = subtitleStore.database.prepare('SELECT * FROM formal_agent_requests').get()
  assert.equal(row.prompt_digest, accepted.promptDigest)
  assert.equal(row.input_watermark_json, '{"throughEventOrder":5}')
  assert.equal(row.transcript_version, 'raw')
  assert.equal(row.input_digest, accepted.inputDigest)
  assert.equal(row.diagnostics_available, 0)
  assert.equal(Object.hasOwn(row, 'prompt'), false)
  assert.throws(() => store.acceptSessionSummaryRequest({ ...accepted, requestDigest: '5'.repeat(64) }), (error) => error.code === 'AGENT_REQUEST_IDENTITY_CONFLICT')
  assert.throws(() => store.acceptSessionSummaryRequest({ ...accepted, inputDigest: '7'.repeat(64) }), (error) => error.code === 'AGENT_REQUEST_IDENTITY_CONFLICT')
})

test('SEM-F38/DB1/J30-ACCEPT: linked run must use the accepted input version, watermark and digest', (t) => {
  const { store } = fixture(t)
  const accepted = acceptedRequest({ action: 'question', summaryUseMemory: null })
  store.acceptSessionSummaryRequest(accepted)
  assert.throws(() => store.createRun({
    runId: 'run.request.changed-input', recipeId: 'qa.answer', recipeVersion: '1',
    scope: { kind: 'session', reference: accepted.sessionId }, transcriptVersion: 'raw',
    inputWatermark: { throughEventOrder: accepted.inputWatermark.throughEventOrder + 1 },
    inputDigest: accepted.inputDigest, requestedBy: 'user', clientIdempotencyKey: 'request.changed-input',
    requestId: accepted.requestId, requestGeneration: 1
  }), (error) => error.code === 'AGENT_REQUEST_IDENTITY_CONFLICT')
  assert.equal(store.getSessionSummaryRequest({ requestId: accepted.requestId }).targetRunId, null)
})

test('SEM-F38/DB1/J30-CANCEL: request cancellation blocks a later target run', (t) => {
  const { store } = fixture(t)
  const accepted = acceptedRequest()
  store.acceptSessionSummaryRequest(accepted)
  const cancelled = store.cancelSessionSummaryRequest({ requestId: accepted.requestId, generation: 1, elapsedMs: 321 })
  assert.equal(cancelled.state, 'cancelled')
  assert.equal(cancelled.cancelRequested, true)
  assert.equal(cancelled.elapsedMs, 321)
  assert.throws(() => store.createRun({
    runId: 'run.cancelled.request', recipeId: 'qa.answer', recipeVersion: '1',
    scope: { kind: 'session', reference: 'session.p1' }, transcriptVersion: 'raw',
    inputWatermark: accepted.inputWatermark, inputDigest: accepted.inputDigest,
    requestedBy: 'user', clientIdempotencyKey: 'request.digest.key', requestId: accepted.requestId, requestGeneration: 1
  }), (error) => error.code === 'AGENT_INTERACTION_STATE_CONFLICT')
  assert.equal(store.getSessionSummaryRequest({ requestId: accepted.requestId }).state, 'cancelled')
})

test('SEM-F38/DB1/J30-PROGRESS: request revisions reject stale phase updates', (t) => {
  const { store } = fixture(t)
  const accepted = store.acceptSessionSummaryRequest(acceptedRequest())
  const preparing = store.updateSessionSummaryRequest({
    requestId: accepted.requestId, generation: 1, expectedRevision: 0,
    state: 'preparing', phase: 'preparing'
  })
  assert.equal(preparing.revision, 1)
  assert.throws(() => store.updateSessionSummaryRequest({
    requestId: accepted.requestId, generation: 1, expectedRevision: 0,
    state: 'routing', phase: 'waiting_model'
  }), (error) => error.code === 'AGENT_CONTEXT_REVISION_CONFLICT')
})

test('SEM-F28/SEM-F38/DB1/J30-RECOVERY: a replaced lease attempt cannot update summary progress', (t) => {
  const { subtitleStore, store } = fixture(t)
  const accepted = acceptedRequest()
  store.acceptSessionSummaryRequest(accepted)
  store.createRun({
    runId: 'run.request.progress-fence', recipeId: 'summary.minutes', recipeVersion: '1',
    scope: { kind: 'session', reference: accepted.sessionId }, transcriptVersion: 'raw',
    inputWatermark: accepted.inputWatermark, inputDigest: accepted.inputDigest,
    requestedBy: 'user', clientIdempotencyKey: 'request.progress-fence',
    requestId: accepted.requestId, requestGeneration: 1, summaryUseMemory: true
  })
  subtitleStore.database.prepare(`
    UPDATE formal_agent_runs
    SET state='running',attempt_count=1,lease_owner='owner.first',lease_expires_at=5000
    WHERE run_id='run.request.progress-fence'
  `).run()
  const linked = store.getSessionSummaryRequest({ requestId: accepted.requestId })
  const firstProgress = store.updateSessionSummaryRequest({
    requestId: accepted.requestId, generation: 1, expectedRevision: linked.revision,
    state: 'running', phase: 'reading_context', attempt: 1,
    attemptIdentity: { runId: 'run.request.progress-fence', attempt: 1, owner: 'owner.first', leaseExpiresAt: 5000 }
  })
  subtitleStore.database.prepare(`
    UPDATE formal_agent_runs
    SET attempt_count=2,lease_owner='owner.current',lease_expires_at=7000
    WHERE run_id='run.request.progress-fence'
  `).run()

  assert.throws(() => store.updateSessionSummaryRequest({
    requestId: accepted.requestId, generation: 1, expectedRevision: firstProgress.revision,
    state: 'running', phase: 'waiting_model', attempt: 1,
    attemptIdentity: { runId: 'run.request.progress-fence', attempt: 1, owner: 'owner.first', leaseExpiresAt: 5000 }
  }), (error) => error.code === 'AGENT_CONTEXT_OPERATION_FAILED')
  const currentProgress = store.updateSessionSummaryRequest({
    requestId: accepted.requestId, generation: 1, expectedRevision: firstProgress.revision,
    state: 'running', phase: 'waiting_model', attempt: 2,
    attemptIdentity: { runId: 'run.request.progress-fence', attempt: 2, owner: 'owner.current', leaseExpiresAt: 7000 }
  })
  assert.equal(currentProgress.attempt, 2)
  assert.equal(currentProgress.phase, 'waiting_model')
})

test('SEM-F38/DB1/J30-PROGRESS: routing links begin in preparation without claiming activity', (t) => {
  const { store } = fixture(t)
  const accepted = acceptedRequest({ action: 'question', summaryUseMemory: null })
  store.acceptSessionSummaryRequest(accepted)
  store.createRun({
    runId: 'run.request.route-progress', recipeId: 'intent.route', recipeVersion: '1',
    scope: { kind: 'session', reference: accepted.sessionId }, transcriptVersion: 'raw',
    inputWatermark: accepted.inputWatermark, inputDigest: accepted.inputDigest,
    requestedBy: 'user', clientIdempotencyKey: 'request.route-progress', requestId: accepted.requestId,
    requestGeneration: 1
  })
  const request = store.getSessionSummaryRequest({ requestId: accepted.requestId })
  assert.equal(request.phase, 'preparing')
  assert.equal(request.lastActivityElapsedMs, 0)
  assert.equal(publicSnapshot(request).last_activity_age_ms, null)
})

test('SEM-F38/DB1/J30-ACCEPT: summary acceptance requires a frozen memory preference', (t) => {
  const { store } = fixture(t)
  assert.throws(() => store.acceptSessionSummaryRequest(acceptedRequest({ summaryUseMemory: null })), (error) => error.code === 'AGENT_REQUEST_INVALID')
  const request = acceptedRequest({ summaryUseMemory: false })
  assert.equal(store.acceptSessionSummaryRequest(request).memoryState, 'not_used')
  assert.throws(() => store.createRun({
    runId: 'run.request.memory-conflict', recipeId: 'summary.minutes', recipeVersion: '1',
    scope: { kind: 'session', reference: request.sessionId }, transcriptVersion: 'raw',
    inputWatermark: request.inputWatermark, inputDigest: request.inputDigest,
    requestedBy: 'user', clientIdempotencyKey: 'request.memory.conflict', requestId: request.requestId,
    requestGeneration: 1, summaryUseMemory: true
  }), (error) => error.code === 'AGENT_REQUEST_IDENTITY_CONFLICT')
})

test('SEM-F38/DB1/J30-ACCEPT: invalid scope digest is rejected before persisting request identity', (t) => {
  const { subtitleStore, store } = fixture(t)
  assert.throws(() => store.acceptSessionSummaryRequest(acceptedRequest({ scopeDigest: '9'.repeat(64) })), (error) => error.code === 'AGENT_REQUEST_INVALID')
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_requests').get().count, 0)
})

test('SEM-F38/DB1/J30-ACCEPT: deleted session removes request metadata and tombstones its idempotency digest', (t) => {
  const { subtitleStore, store } = fixture(t)
  const request = acceptedRequest()
  subtitleStore.openSession({ sessionId: request.sessionId, sourceId: 'mic', startedAt: 1, refinementEnabled: false })
  subtitleStore.closeSession({ sessionId: request.sessionId, sourceId: 'mic', endedAt: 2, state: 'closed' })
  store.acceptSessionSummaryRequest(request)
  const deleted = new SessionDeletionStore({ subtitleStore, now: () => 3000 }).deleteSessionData({
    sessionId: request.sessionId,
    deletionIdempotencyKey: 'delete.summary.request.1'
  })
  assert.equal(deleted.deletedSummaryRequestCount, 1)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_requests').get().count, 0)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_request_tombstones').get().count, 1)
  assert.throws(() => store.acceptSessionSummaryRequest(request), (error) => error.code === 'AGENT_SESSION_DELETED')
  assert.throws(() => store.getSessionSummaryRequest({ requestId: request.requestId }), (error) => error.code === 'AGENT_SESSION_DELETED')
})

test('SEM-F38/DB1/J30-CANCEL: cancelling a queued target prevents it from remaining claimable', (t) => {
  const { subtitleStore, store } = fixture(t)
  const accepted = acceptedRequest({ action: 'question', summaryUseMemory: null })
  store.acceptSessionSummaryRequest(accepted)
  store.createRun({
    runId: 'run.queued.request', recipeId: 'qa.answer', recipeVersion: '1',
    scope: { kind: 'session', reference: accepted.sessionId }, transcriptVersion: 'raw',
    inputWatermark: accepted.inputWatermark, inputDigest: accepted.inputDigest,
    requestedBy: 'user', clientIdempotencyKey: 'request.digest.key', requestId: accepted.requestId, requestGeneration: 1
  })
  const cancelled = store.cancelSessionSummaryRequest({ requestId: accepted.requestId, generation: 1 })
  const run = subtitleStore.database.prepare('SELECT state,cancel_requested_at FROM formal_agent_runs WHERE run_id=?').get('run.queued.request')
  assert.equal(cancelled.state, 'cancelled')
  assert.equal(run.state, 'cancelled')
  assert.notEqual(run.cancel_requested_at, null)
})

test('SEM-F38/DB1/J30-CANCEL: repeated cancellation while a target is running replays one control fact', (t) => {
  const { subtitleStore, store } = fixture(t)
  const accepted = acceptedRequest({ action: 'question', summaryUseMemory: null })
  store.acceptSessionSummaryRequest(accepted)
  store.createRun({
    runId: 'run.running.request', recipeId: 'qa.answer', recipeVersion: '1',
    scope: { kind: 'session', reference: accepted.sessionId }, transcriptVersion: 'raw',
    inputWatermark: accepted.inputWatermark, inputDigest: accepted.inputDigest,
    requestedBy: 'user', clientIdempotencyKey: 'request.running.key', requestId: accepted.requestId, requestGeneration: 1
  })
  subtitleStore.database.prepare("UPDATE formal_agent_runs SET state='running',attempt_count=1,lease_owner='worker.test',lease_expires_at=5000 WHERE run_id=?").run('run.running.request')
  const first = store.cancelSessionSummaryRequest({ requestId: accepted.requestId, generation: 1, elapsedMs: 321 })
  const activeReplay = store.cancelSessionSummaryRequest({ requestId: accepted.requestId, generation: 1, elapsedMs: 999 })
  assert.equal(first.state, 'cancelling')
  assert.equal(first.elapsedMs, 321)
  assert.equal(activeReplay.revision, first.revision)
  assert.equal(activeReplay.elapsedMs, 321)
  assert.equal(activeReplay.replayed, true)

  subtitleStore.database.prepare("UPDATE formal_agent_runs SET state='cancelled',lease_owner=NULL,lease_expires_at=NULL,updated_at=2001 WHERE run_id=?").run('run.running.request')
  const terminalReplay = store.cancelSessionSummaryRequest({ requestId: accepted.requestId, generation: 1, elapsedMs: 1500 })
  assert.equal(terminalReplay.state, 'cancelled')
  assert.equal(terminalReplay.elapsedMs, 321)
  assert.ok(terminalReplay.revision > first.revision)
  assert.equal(subtitleStore.database.prepare('SELECT cancel_requested_at FROM formal_agent_runs WHERE run_id=?').get('run.running.request').cancel_requested_at, 2000)
})

test('SEM-F38/DB1/J30-CANCEL: cancellation after route failure preserves the failed terminal fact', (t) => {
  const { subtitleStore, store } = fixture(t)
  const accepted = acceptedRequest({ action: 'question', summaryUseMemory: null })
  store.acceptSessionSummaryRequest(accepted)
  store.createRun({
    runId: 'run.failed.route', recipeId: 'intent.route', recipeVersion: '1',
    scope: { kind: 'session', reference: accepted.sessionId }, transcriptVersion: 'raw',
    inputWatermark: accepted.inputWatermark, inputDigest: accepted.inputDigest,
    requestedBy: 'user', clientIdempotencyKey: 'request.failed.route', requestId: accepted.requestId, requestGeneration: 1
  })
  subtitleStore.database.prepare("UPDATE formal_agent_runs SET state='failed',error_code='AGENT_INTERNAL_FAILURE' WHERE run_id=?").run('run.failed.route')
  const result = store.cancelSessionSummaryRequest({ requestId: accepted.requestId, generation: 1 })
  assert.equal(result.state, 'failed')
  assert.equal(result.errorCode, 'AGENT_INTERNAL_FAILURE')
  assert.equal(result.cancelRequested, false)
})

test('DB1: migration v14 to v16 preserves existing rows and old checksums and rolls back failed application', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-request-migration-'))
  const databasePath = path.join(root, 'speech-agent.sqlite3')
  let subtitleStore
  t.after(() => {
    try { subtitleStore?.close() } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  })
  subtitleStore = new SqliteSubtitleStore({ databasePath, migrations: SESSION_SUMMARY_MIGRATIONS, now: () => 1000 })
  subtitleStore.openSession({ sessionId: 'session.migration', sourceId: 'mic', startedAt: 1, refinementEnabled: false })
  subtitleStore.closeSession({ sessionId: 'session.migration', sourceId: 'mic', endedAt: 2, state: 'closed' })
  const priorHistory = subtitleStore.database.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all()
  assert.equal(priorHistory.length, 14)
  subtitleStore.database.exec('CREATE TABLE formal_agent_request_tombstones (collision INTEGER) STRICT')
  subtitleStore.close()
  assert.throws(() => new SqliteSubtitleStore({ databasePath, migrations: FORMAL_AGENT_MIGRATIONS, now: () => 2000 }))

  subtitleStore = new SqliteSubtitleStore({ databasePath, migrations: SESSION_SUMMARY_MIGRATIONS, now: () => 3000 })
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = ?').get('formal_agent_requests').count, 0)
  subtitleStore.database.exec('DROP TABLE formal_agent_request_tombstones')
  subtitleStore.close()

  subtitleStore = new SqliteSubtitleStore({ databasePath, migrations: FORMAL_AGENT_MIGRATIONS, now: () => 4000 })
  const upgradedHistory = subtitleStore.database.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all()
  assert.deepEqual(upgradedHistory.slice(0, 14), priorHistory)
  assert.equal(upgradedHistory.length, 16)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM sessions WHERE session_id = ?').get('session.migration').count, 1)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = ?').get('formal_agent_requests').count, 1)
  assert.equal(subtitleStore.database.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('session_deletion_tombstones') WHERE name = 'deleted_summary_request_count'").get().count, 1)
})

test('DB1/J30-RECOVERY: v15 accepted requests without a linked run fail closed when v16 adds frozen input identity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-request-v15-recovery-'))
  const databasePath = path.join(root, 'speech-agent.sqlite3')
  let subtitleStore
  t.after(() => {
    try { subtitleStore?.close() } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  })
  subtitleStore = new SqliteSubtitleStore({ databasePath, migrations: FORMAL_AGENT_MIGRATIONS.slice(0, 15), now: () => 1000 })
  subtitleStore.database.prepare(`
    INSERT INTO formal_agent_requests(
      request_id,session_id,client_key_digest,request_digest,scope_digest,prompt_digest,action,summary_use_memory,
      state,phase,generation,revision,route_run_id,target_run_id,cancel_requested,resume_required,
      attempt,elapsed_ms,last_activity_elapsed_ms,validated_chunk_count,total_chunk_count,memory_state,
      error_code,budget_axis,budget_actual,budget_limit,diagnostics_available,created_at,updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'summary', 1, 'accepted', 'accepted', 1, 0, NULL, NULL, 0, 0,
      0, 0, 0, NULL, NULL, 'not_read', NULL, NULL, NULL, NULL, 0, 1000, 1000)
  `).run('request.v15.unlinked', 'session.v15.unlinked', '1'.repeat(64), '2'.repeat(64), '3'.repeat(64), '4'.repeat(64))
  subtitleStore.close()

  subtitleStore = new SqliteSubtitleStore({ databasePath, migrations: FORMAL_AGENT_MIGRATIONS, now: () => 2000 })
  const row = subtitleStore.database.prepare('SELECT state,phase,error_code,revision,input_digest FROM formal_agent_requests WHERE request_id=?').get('request.v15.unlinked')
  assert.equal(row.state, 'failed')
  assert.equal(row.phase, 'terminal')
  assert.equal(row.error_code, 'AGENT_RUN_UNAVAILABLE')
  assert.equal(row.revision, 1)
  assert.equal(row.input_digest, null)
})
