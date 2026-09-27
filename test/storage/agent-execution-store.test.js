'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { AgentExecutionStore } = require('../../src/runtime/storage-worker/agent-execution-store')
const { canonicalize, sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')
const { FORMAL_AGENT_MIGRATIONS } = require('../../src/runtime/storage-worker/schema')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')
const { buildExportSnapshot } = require('../../src/agent/formal-run/agent-interaction-exporter')
const { SUMMARY_PROMPT } = require('../../src/agent/formal-run/session-summary-run-service')

const providerUsage = {
  inputTokens: 10,
  outputTokens: 4,
  usageSource: 'provider',
  cacheHitInputTokens: null,
  cacheMissInputTokens: null
}

function fixture (t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-execution-store-'))
  const now = typeof options.now === 'function' ? options.now : () => 2000
  const subtitleStore = new SqliteSubtitleStore({
    databasePath: path.join(root, 'speech-agent.sqlite3'),
    migrations: FORMAL_AGENT_MIGRATIONS,
    now: () => 1000
  })
  const store = new AgentExecutionStore({ subtitleStore, now })
  t.after(() => {
    try { subtitleStore.close() } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { subtitleStore, store }
}

function insertRun (database, {
  runId,
  recipeId = 'qa.answer',
  requestedBy = 'user',
  attempt = 1,
  state = 'running',
  usageReporting = true,
  supportsToolCalling = true,
  scopeReference = `session.${runId}`,
  summaryUseMemory,
  sessionSummaryRequestId = null
}) {
  const scope = { kind: 'session', reference: scopeReference }
  const inputWatermark = { throughEventOrder: 3 }
  const inputDigest = sha256Canonical({ input: runId })
  const scopeDigest = sha256Canonical(scope)
  database.prepare(`
    INSERT INTO formal_agent_runs(
      run_id, dedupe_key, client_idempotency_key, request_digest, recipe_id, recipe_version,
      scope_json, scope_digest, transcript_version, input_watermark_json, input_digest,
      requested_by, state, attempt_count, max_attempts, next_attempt_at,
      lease_owner, lease_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '1', ?, ?, 'raw', ?, ?, ?, ?, ?, 3, 0, ?, ?, 1, 1)
  `).run(
    runId,
    sha256Canonical({ runId }),
    requestedBy === 'user' ? `client.${runId}` : null,
    sha256Canonical({ request: runId }),
    recipeId,
    canonicalize(scope),
    scopeDigest,
    canonicalize(inputWatermark),
    inputDigest,
    requestedBy,
    state,
    attempt,
    state === 'running' ? 'worker' : null,
    state === 'running' ? 5000 : null
  )
  if (sessionSummaryRequestId !== null) {
    database.prepare('UPDATE formal_agent_runs SET session_summary_request_id=? WHERE run_id=?')
      .run(sessionSummaryRequestId, runId)
  }
  database.prepare(`
    INSERT INTO agent_model_run_bindings(
      run_id, execution_form, purpose, assignment_mode, profile_id, profile_revision,
      adapter_id, api_style, https_origin, base_path, model_id, capability_json,
      budget_json, provider_kind, credential_slot_id, created_at
    ) VALUES (?, 'agent_loop', ?, 'direct', 'profile.test', 1,
      'openai-compatible', 'chat-completions', 'https://provider.test', '/v1',
      'model.test', ?, ?, 'cloud', 'slot.test.00000001', 1)
  `).run(
    runId,
    recipeId === 'summary.minutes' ? 'summary' : 'default',
    canonicalize({
      maxInputTokens: 64000,
      maxOutputTokens: 4096,
      supportsToolCalling,
      supportsStructuredOutput: true,
      supportsStreaming: true,
      usageReporting
    }),
    canonicalize({ maxTurns: recipeId === 'report.analysis' ? 6 : 3 })
  )
  if (recipeId === 'summary.minutes' && typeof summaryUseMemory === 'boolean') {
    database.prepare('UPDATE formal_agent_runs SET summary_use_memory=? WHERE run_id=?').run(summaryUseMemory ? 1 : 0, runId)
  }
}

function acceptSummaryRequest (store, { requestId, sessionId, action = 'summary', summaryUseMemory = true, resubmitsRequestId }) {
  const scope = { kind: 'session', reference: sessionId }
  const prompt = action === 'summary' ? SUMMARY_PROMPT : '一次性自由问题，不持久化正文'
  return store.acceptSessionSummaryRequest({
    requestId,
    sessionId,
    clientKeyDigest: sha256Canonical({ requestId, client: true }),
    requestDigest: sha256Canonical({ requestId, request: true }),
    scopeDigest: sha256Canonical(scope),
    promptDigest: sha256Canonical(prompt),
    action,
    summaryUseMemory: action === 'summary' ? summaryUseMemory : null,
    inputWatermark: { throughEventOrder: 3 },
    transcriptVersion: 'raw',
    inputDigest: sha256Canonical({ requestId, input: true }),
    ...(resubmitsRequestId ? { resubmitsRequestId } : {})
  })
}

function attachSummaryTarget (database, requestId, runId, { state = 'running', attempt = 1 } = {}) {
  database.prepare(`
    UPDATE formal_agent_requests SET target_run_id=?,state=?,phase=?,attempt=?,updated_at=2000 WHERE request_id=?
  `).run(runId, state, state === 'running' ? 'reading_context' : 'retry_wait', attempt, requestId)
}

function qaResult () {
  return { schemaVersion: 1, answer: 'answer', sourceRefs: [], memoryRefs: [], unresolved: [] }
}

function attemptIdentity (runId, attempt = 1, owner = 'worker', leaseExpiresAt = 5000) {
  return { runId, attempt, owner, leaseExpiresAt }
}

test('SEM-F28/SEM-F34/J22/J24: interaction writer derives the recipe snapshot and rejects caller-owned facts', (t) => {
  const { subtitleStore, store } = fixture(t)
  insertRun(subtitleStore.database, { runId: 'run.interaction' })
  const created = store.createInteraction({
    runId: 'run.interaction',
    interactionId: 'interaction.one',
    routingMode: 'model',
    promptDigest: 'a'.repeat(64)
  })
  assert.equal(created.maxTurns, 3)
  assert.deepEqual(created.toolGrants, ['search_context'])
  assert.equal(created.requestedBy, 'user')
  assert.equal(created.comparisonGroupId, sha256Canonical([
    'qa.answer', '1', created.scopeDigest, created.inputDigest
  ]))
  assert.equal(created.terminalReason, null)
  assert.equal(created.usage, null)
  assert.throws(() => store.createInteraction({
    runId: 'run.interaction', interactionId: 'interaction.two', routingMode: 'model',
    promptDigest: 'a'.repeat(64), executionForm: 'agent_loop'
  }), (error) => error.code === 'AGENT_REQUEST_INVALID')
  assert.deepEqual(store.createInteraction({
    runId: 'run.interaction', interactionId: 'interaction.one', routingMode: 'model', promptDigest: 'a'.repeat(64)
  }), { ...created, replayed: true })
})

test('SEM-F28/SEM-F33/J22: terminal success/cancel are atomic, usage is nullable and late results are refused', (t) => {
  const { subtitleStore, store } = fixture(t)
  insertRun(subtitleStore.database, { runId: 'run.success' })
  insertRun(subtitleStore.database, { runId: 'run.cancel' })
  store.createInteraction({ runId: 'run.success', interactionId: 'interaction.success', routingMode: 'preset', promptDigest: 'b'.repeat(64) })
  store.createInteraction({ runId: 'run.cancel', interactionId: 'interaction.cancel', routingMode: 'rules', promptDigest: 'c'.repeat(64) })
  const success = store.terminalizeInteraction({
    interactionId: 'interaction.success', attemptIdentity: attemptIdentity('run.success'), terminalReason: 'succeeded', errorCode: null,
    result: qaResult(), usage: providerUsage, durationMs: 25
  })
  assert.equal(success.terminalReason, 'succeeded')
  assert.equal(success.result.answer, 'answer')
  assert.deepEqual(success.usage, providerUsage)
  assert.equal(subtitleStore.database.prepare("SELECT state FROM formal_agent_runs WHERE run_id='run.success'").get().state, 'succeeded')
  assert.equal(subtitleStore.database.prepare("SELECT lease_owner FROM formal_agent_runs WHERE run_id='run.success'").get().lease_owner, null)
  assert.deepEqual(store.terminalizeInteraction({
    interactionId: 'interaction.success', attemptIdentity: attemptIdentity('run.success'), terminalReason: 'succeeded', errorCode: null,
    result: qaResult(), usage: providerUsage, durationMs: 25
  }), { ...success, replayed: true })
  assert.throws(() => store.terminalizeInteraction({
    interactionId: 'interaction.success', attemptIdentity: attemptIdentity('run.success'), terminalReason: 'failed', errorCode: 'AGENT_INTERNAL_FAILURE',
    result: null, usage: null, durationMs: 26
  }), (error) => error.code === 'AGENT_INTERACTION_STATE_CONFLICT')
  const cancelRequested = store.cancelRun({ runId: 'run.cancel' })
  assert.equal(cancelRequested.state, 'running')
  assert.equal(cancelRequested.cancelRequested, true)
  assert.throws(() => store.terminalizeInteraction({
    interactionId: 'interaction.cancel', attemptIdentity: attemptIdentity('run.cancel'), terminalReason: 'succeeded', errorCode: null,
    result: qaResult(), usage: null, durationMs: 1
  }), (error) => error.code === 'AGENT_INTERACTION_STATE_CONFLICT')
  const cancelled = store.terminalizeInteraction({
    interactionId: 'interaction.cancel', attemptIdentity: attemptIdentity('run.cancel'), terminalReason: 'cancelled', errorCode: null,
    result: null, usage: null, durationMs: 0
  })
  assert.equal(cancelled.terminalReason, 'cancelled')
  assert.equal(cancelled.result, null)
  assert.equal(cancelled.usage, null)
  assert.equal(subtitleStore.database.prepare("SELECT state FROM formal_agent_runs WHERE run_id='run.cancel'").get().state, 'cancelled')
  assert.throws(() => store.terminalizeInteraction({
    interactionId: 'interaction.cancel', attemptIdentity: attemptIdentity('run.cancel'), terminalReason: 'succeeded', errorCode: null,
    result: qaResult(), usage: null, durationMs: 1
  }), (error) => error.code === 'AGENT_INTERACTION_STATE_CONFLICT')
})

test('SEM-F28/J30-RECOVERY: owner and attempt independently fence an older target attempt', (t) => {
  const { subtitleStore, store } = fixture(t)
  insertRun(subtitleStore.database, { runId: 'run.lease.fenced' })
  store.createInteraction({ runId: 'run.lease.fenced', interactionId: 'interaction.lease.fenced', routingMode: 'preset', promptDigest: 'c'.repeat(64) })
  const oldAttempt = attemptIdentity('run.lease.fenced')
  subtitleStore.database.prepare(`
    UPDATE formal_agent_runs SET attempt_count=2,lease_owner='worker',lease_expires_at=7000
    WHERE run_id='run.lease.fenced'
  `).run()
  assert.throws(() => store.terminalizeInteraction({
    interactionId: 'interaction.lease.fenced', attemptIdentity: oldAttempt,
    terminalReason: 'succeeded', errorCode: null, result: qaResult(), usage: null, durationMs: 4
  }), (error) => error.code === 'AGENT_CONTEXT_OPERATION_FAILED')
  assert.equal(subtitleStore.database.prepare('SELECT terminal_reason FROM formal_agent_interactions WHERE interaction_id=?').get('interaction.lease.fenced').terminal_reason, null)
  subtitleStore.database.prepare(`
    UPDATE formal_agent_runs SET attempt_count=1,lease_owner='worker.replacement',lease_expires_at=7000
    WHERE run_id='run.lease.fenced'
  `).run()
  assert.throws(() => store.terminalizeInteraction({
    interactionId: 'interaction.lease.fenced', attemptIdentity: oldAttempt,
    terminalReason: 'succeeded', errorCode: null, result: qaResult(), usage: null, durationMs: 4
  }), (error) => error.code === 'AGENT_CONTEXT_OPERATION_FAILED')
  subtitleStore.database.prepare(`
    UPDATE formal_agent_runs SET attempt_count=2,lease_owner='worker.replacement',lease_expires_at=7000
    WHERE run_id='run.lease.fenced'
  `).run()
  const current = store.terminalizeInteraction({
    interactionId: 'interaction.lease.fenced',
    attemptIdentity: attemptIdentity('run.lease.fenced', 2, 'worker.replacement', 7000),
    terminalReason: 'succeeded', errorCode: null, result: qaResult(), usage: null, durationMs: 4
  })
  assert.equal(current.terminalReason, 'succeeded')
})

test('SEM-F28/J30-RECOVERY: an expired lease token remains valid while the renewed lease is active', (t) => {
  let now = 2000
  const { subtitleStore, store } = fixture(t, { now: () => now })
  insertRun(subtitleStore.database, { runId: 'run.lease.renewed' })
  store.createInteraction({ runId: 'run.lease.renewed', interactionId: 'interaction.lease.renewed', routingMode: 'preset', promptDigest: 'd'.repeat(64) })
  const originalAttempt = attemptIdentity('run.lease.renewed')
  subtitleStore.database.prepare(`
    UPDATE formal_agent_runs SET lease_renewed_from_expires_at=lease_expires_at,lease_expires_at=9000
    WHERE run_id='run.lease.renewed'
  `).run()

  now = 6000
  const terminal = store.terminalizeInteraction({
    interactionId: 'interaction.lease.renewed', attemptIdentity: originalAttempt,
    terminalReason: 'succeeded', errorCode: null, result: qaResult(), usage: null, durationMs: 4
  })
  assert.equal(terminal.terminalReason, 'succeeded')
})

test('SEM-F38/SEM-T04/J30-RECOVERY: restart fences a running summary and explicit resume reuses its run without resetting attempts', (t) => {
  const { subtitleStore, store } = fixture(t)
  acceptSummaryRequest(store, { requestId: 'request.recovery.summary', sessionId: 'session.recovery.summary' })
  insertRun(subtitleStore.database, {
    runId: 'run.recovery.summary', recipeId: 'summary.minutes', summaryUseMemory: true,
    scopeReference: 'session.recovery.summary', sessionSummaryRequestId: 'request.recovery.summary'
  })
  attachSummaryTarget(subtitleStore.database, 'request.recovery.summary', 'run.recovery.summary')
  store.createInteraction({
    runId: 'run.recovery.summary', interactionId: 'interaction.recovery.summary',
    routingMode: 'preset', promptDigest: sha256Canonical(SUMMARY_PROMPT)
  })

  const recovered = store.recoverSessionSummaryRequests()
  assert.equal(recovered.length, 1)
  assert.equal(recovered[0].state, 'retry_wait')
  assert.equal(recovered[0].resumeRequired, true)
  assert.equal(recovered[0].targetRunId, 'run.recovery.summary')
  assert.equal(recovered[0].attempt, 1)
  assert.deepEqual({ ...subtitleStore.database.prepare(`
    SELECT state,attempt_count,resume_required,lease_owner,lease_expires_at
    FROM formal_agent_runs WHERE run_id='run.recovery.summary'
  `).get() }, {
    state: 'retry_wait', attempt_count: 1, resume_required: 1, lease_owner: null, lease_expires_at: null
  })
  assert.throws(() => store.createRun({
    runId: 'run.recovery.duplicate', recipeId: 'summary.minutes', recipeVersion: '1',
    scope: { kind: 'session', reference: 'session.recovery.summary' }, transcriptVersion: 'raw',
    inputWatermark: { throughEventOrder: 3 }, inputDigest: sha256Canonical({ requestId: 'request.recovery.summary', input: true }),
    requestedBy: 'user', clientIdempotencyKey: 'request.recovery.summary.generation.1', summaryUseMemory: true,
    requestId: 'request.recovery.summary', requestGeneration: 1
  }), (error) => error.code === 'AGENT_INTERACTION_STATE_CONFLICT')

  const resumed = store.resumeSessionSummaryRequest({
    requestId: 'request.recovery.summary', generation: recovered[0].generation, expectedRevision: recovered[0].revision
  })
  assert.equal(resumed.generation, 2)
  assert.equal(resumed.resumeRequired, false)
  assert.equal(resumed.targetRunId, 'run.recovery.summary')
  assert.deepEqual({ ...subtitleStore.database.prepare(`
    SELECT run_id,state,attempt_count,resume_required FROM formal_agent_runs WHERE session_summary_request_id=?
  `).get('request.recovery.summary') }, {
    run_id: 'run.recovery.summary', state: 'retry_wait', attempt_count: 1, resume_required: 0
  })
})

test('SEM-F38/SEM-T04/J30-RECOVERY: an unavailable fixed prompt terminalizes its run and interaction atomically', (t) => {
  const { subtitleStore, store } = fixture(t)
  acceptSummaryRequest(store, { requestId: 'request.recovery.prompt', sessionId: 'session.recovery.prompt' })
  insertRun(subtitleStore.database, {
    runId: 'run.recovery.prompt', recipeId: 'summary.minutes', summaryUseMemory: true,
    scopeReference: 'session.recovery.prompt', sessionSummaryRequestId: 'request.recovery.prompt'
  })
  attachSummaryTarget(subtitleStore.database, 'request.recovery.prompt', 'run.recovery.prompt')
  store.createInteraction({
    runId: 'run.recovery.prompt', interactionId: 'interaction.recovery.prompt',
    routingMode: 'preset', promptDigest: sha256Canonical(SUMMARY_PROMPT)
  })
  subtitleStore.database.prepare('UPDATE formal_agent_requests SET prompt_digest=? WHERE request_id=?')
    .run('f'.repeat(64), 'request.recovery.prompt')

  const [recovered] = store.recoverSessionSummaryRequests()
  assert.equal(recovered.state, 'retry_wait')
  const failed = store.failUnrecoverableSessionSummaryRequest({
    requestId: recovered.requestId, generation: recovered.generation, expectedRevision: recovered.revision
  })

  assert.equal(failed.state, 'failed')
  assert.equal(failed.errorCode, 'AGENT_REQUEST_INVALID')
  assert.equal(failed.resumeRequired, false)
  assert.deepEqual({ ...subtitleStore.database.prepare(`
    SELECT state,error_code,resume_required FROM formal_agent_runs WHERE run_id=?
  `).get('run.recovery.prompt') }, {
    state: 'failed', error_code: 'AGENT_REQUEST_INVALID', resume_required: 0
  })
  assert.equal(subtitleStore.database.prepare(`
    SELECT terminal_reason FROM formal_agent_interactions WHERE interaction_id=?
  `).get('interaction.recovery.prompt').terminal_reason, 'failed')
  assert.equal(store.listRecoverableSessionSummaryRequests().some((row) => row.requestId === recovered.requestId), false)
})

test('SEM-F38/J30-RECOVERY: restart reconciliation preserves durable cancellation and requires a lost question to be resubmitted', (t) => {
  const { subtitleStore, store } = fixture(t)
  acceptSummaryRequest(store, { requestId: 'request.recovery.cancel', sessionId: 'session.recovery.cancel' })
  insertRun(subtitleStore.database, {
    runId: 'run.recovery.cancel', recipeId: 'summary.minutes', summaryUseMemory: true,
    scopeReference: 'session.recovery.cancel', sessionSummaryRequestId: 'request.recovery.cancel'
  })
  attachSummaryTarget(subtitleStore.database, 'request.recovery.cancel', 'run.recovery.cancel')
  store.createInteraction({
    runId: 'run.recovery.cancel', interactionId: 'interaction.recovery.cancel',
    routingMode: 'preset', promptDigest: sha256Canonical(SUMMARY_PROMPT)
  })
  subtitleStore.database.prepare(`
    UPDATE formal_agent_requests SET cancel_requested=1,state='cancelling',phase='cancelling' WHERE request_id=?
  `).run('request.recovery.cancel')
  subtitleStore.database.prepare('UPDATE formal_agent_runs SET cancel_requested_at=1999 WHERE run_id=?')
    .run('run.recovery.cancel')

  const cancelled = store.recoverSessionSummaryRequests()[0]
  assert.equal(cancelled.state, 'cancelled')
  assert.equal(cancelled.resumeRequired, false)
  assert.equal(subtitleStore.database.prepare('SELECT state FROM formal_agent_runs WHERE run_id=?').get('run.recovery.cancel').state, 'cancelled')
  assert.equal(subtitleStore.database.prepare('SELECT terminal_reason FROM formal_agent_interactions WHERE interaction_id=?').get('interaction.recovery.cancel').terminal_reason, 'cancelled')

  acceptSummaryRequest(store, {
    requestId: 'request.recovery.question', sessionId: 'session.recovery.question', action: 'question'
  })
  insertRun(subtitleStore.database, {
    runId: 'run.recovery.question', recipeId: 'qa.answer', scopeReference: 'session.recovery.question',
    sessionSummaryRequestId: 'request.recovery.question'
  })
  attachSummaryTarget(subtitleStore.database, 'request.recovery.question', 'run.recovery.question')
  store.createInteraction({
    runId: 'run.recovery.question', interactionId: 'interaction.recovery.question', routingMode: 'model',
    promptDigest: sha256Canonical('一次性自由问题，不持久化正文')
  })

  const question = store.recoverSessionSummaryRequests().find((row) => row.requestId === 'request.recovery.question')
  assert.equal(question.state, 'failed')
  assert.equal(question.errorCode, 'AGENT_REQUEST_INVALID')
  assert.equal(question.resumeRequired, true)
  assert.equal(subtitleStore.database.prepare('SELECT state FROM formal_agent_runs WHERE run_id=?').get('run.recovery.question').state, 'failed')
})

test('SEM-F38/SEM-T04/J30-RECOVERY: accepted question resubmission durably clears the lost request reminder', (t) => {
  const { subtitleStore, store } = fixture(t)
  const lost = acceptSummaryRequest(store, {
    requestId: 'request.recovery.question-lost', sessionId: 'session.recovery.question-lost', action: 'question'
  })
  store.recoverSessionSummaryRequests()
  const recoverable = store.getSessionSummaryRequest({ requestId: lost.requestId })
  assert.equal(recoverable.state, 'failed')
  assert.equal(recoverable.resumeRequired, true)

  const resubmitted = acceptSummaryRequest(store, {
    requestId: 'request.recovery.question-resubmitted',
    sessionId: 'session.recovery.question-lost',
    action: 'question',
    resubmitsRequestId: lost.requestId
  })
  assert.equal(resubmitted.state, 'accepted')
  const acknowledged = store.getSessionSummaryRequest({ requestId: lost.requestId })
  assert.equal(acknowledged.state, 'failed')
  assert.equal(acknowledged.errorCode, 'AGENT_REQUEST_INVALID')
  assert.equal(acknowledged.resumeRequired, false)
  assert.equal(subtitleStore.database.prepare('SELECT revision FROM formal_agent_requests WHERE request_id=?').get(lost.requestId).revision, recoverable.revision + 1)
  assert.equal(store.listRecoverableSessionSummaryRequests().some((row) => row.requestId === lost.requestId), false)

  const replayed = acceptSummaryRequest(store, {
    requestId: 'request.recovery.question-resubmitted',
    sessionId: 'session.recovery.question-lost',
    action: 'question',
    resubmitsRequestId: lost.requestId
  })
  assert.equal(replayed.replayed, true)
  assert.throws(() => acceptSummaryRequest(store, {
    requestId: 'request.recovery.question-invalid-resubmission',
    sessionId: 'session.recovery.question-lost',
    action: 'question',
    resubmitsRequestId: 'request.recovery.missing-question'
  }), (error) => error.code === 'AGENT_REQUEST_INVALID')
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_requests').get().count, 2)
})

test('SEM-F38/SEM-T04/J30-RECOVERY: a completed route run does not stand in for a lost question result', (t) => {
  const { subtitleStore, store } = fixture(t)
  acceptSummaryRequest(store, {
    requestId: 'request.recovery.route-only', sessionId: 'session.recovery.route-only', action: 'question'
  })
  insertRun(subtitleStore.database, {
    runId: 'run.recovery.route-only', recipeId: 'intent.route', state: 'running',
    scopeReference: 'session.recovery.route-only'
  })
  subtitleStore.database.prepare(`
    UPDATE formal_agent_runs SET state='succeeded',lease_owner=NULL,lease_expires_at=NULL,result_digest=?,result_summary_json=? WHERE run_id=?
  `).run(
    sha256Canonical({ recipeId: 'qa.answer' }),
    canonicalize({ schemaVersion: 1, recipeId: 'qa.answer' }),
    'run.recovery.route-only'
  )
  subtitleStore.database.prepare(`
    UPDATE formal_agent_requests SET route_run_id=?,state='routing',phase='waiting_model' WHERE request_id=?
  `).run('run.recovery.route-only', 'request.recovery.route-only')

  const recovered = store.recoverSessionSummaryRequests().find((row) => row.requestId === 'request.recovery.route-only')
  assert.equal(recovered.state, 'failed')
  assert.equal(recovered.errorCode, 'AGENT_REQUEST_INVALID')
  assert.equal(recovered.resumeRequired, true)
  assert.equal(recovered.targetRunId, null)
  assert.equal(recovered.routeRunId, 'run.recovery.route-only')
})

test('SEM-F38/SEM-T04/J29: summary memory revocation rejects late output and preserves an explicit failure projection', (t) => {
  const { subtitleStore, store } = fixture(t)
  insertRun(subtitleStore.database, {
    runId: 'run.summary-revoked', recipeId: 'summary.minutes', requestedBy: 'user', scopeReference: 'session.summary-revoked'
  })
  store.createInteraction({
    runId: 'run.summary-revoked', interactionId: 'interaction.summary-revoked', routingMode: 'preset', promptDigest: 'a'.repeat(64)
  })
  subtitleStore.database.prepare('UPDATE personal_context_projection_state SET content_revision=1 WHERE singleton_key=1').run()
  assert.throws(() => store.terminalizeInteraction({
    interactionId: 'interaction.summary-revoked', attemptIdentity: attemptIdentity('run.summary-revoked'), terminalReason: 'succeeded', errorCode: null,
    result: { schemaVersion: 1, summary: 'late', decisions: [], actionItems: [], risks: [], sourceRefs: [], memoryRefs: [] },
    usage: null, durationMs: 2
  }), (error) => error.code === 'AGENT_INPUT_CHANGED')
  const failed = store.terminalizeInteraction({
    interactionId: 'interaction.summary-revoked', attemptIdentity: attemptIdentity('run.summary-revoked'), terminalReason: 'failed',
    errorCode: 'AGENT_SUMMARY_MEMORY_READ_FAILED', result: null, usage: null, durationMs: 3
  })
  assert.equal(failed.errorCode, 'AGENT_SUMMARY_MEMORY_READ_FAILED')
  assert.equal(subtitleStore.database.prepare('SELECT error_code FROM formal_agent_interactions WHERE interaction_id=?').get('interaction.summary-revoked').error_code, 'AGENT_INTERNAL_FAILURE')
  assert.equal(subtitleStore.database.prepare('SELECT summary_memory_error FROM formal_agent_interactions WHERE interaction_id=?').get('interaction.summary-revoked').summary_memory_error, 1)
})

test('SEM-F38/SEM-T04/J31-SIZE: legacy summary input-limit failure is distinct in durable run and interaction projections', (t) => {
  const { subtitleStore, store } = fixture(t)
  insertRun(subtitleStore.database, {
    runId: 'run.summary.input-limit', recipeId: 'summary.minutes', summaryUseMemory: true,
    scopeReference: 'session.summary-input-limit'
  })
  store.createInteraction({
    runId: 'run.summary.input-limit', interactionId: 'interaction.summary.input-limit', routingMode: 'preset', promptDigest: 'b'.repeat(64)
  })
  const failed = store.terminalizeInteraction({
    interactionId: 'interaction.summary.input-limit', attemptIdentity: attemptIdentity('run.summary.input-limit'), terminalReason: 'failed',
    errorCode: 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED', result: null, usage: null, durationMs: 1
  })
  assert.equal(failed.errorCode, 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED')
  assert.equal(store.getInteraction({ interactionId: 'interaction.summary.input-limit' }).interaction.errorCode, 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED')
  assert.equal(store.listInteractions({ limit: 10, cursor: null }).items[0].errorCode, 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED')
  assert.equal(subtitleStore.database.prepare('SELECT error_code, summary_input_limit_error FROM formal_agent_interactions WHERE interaction_id=?').get('interaction.summary.input-limit').error_code, 'AGENT_INTERNAL_FAILURE')
  assert.equal(subtitleStore.database.prepare('SELECT error_code, summary_input_limit_error FROM formal_agent_runs WHERE run_id=?').get('run.summary.input-limit').summary_input_limit_error, 1)
})

test('SEM-F38/J29: frozen summary policy survives storage detail, history and versioned export', (t) => {
  const { subtitleStore, store } = fixture(t)
  insertRun(subtitleStore.database, {
    runId: 'run.summary.policy', recipeId: 'summary.minutes', summaryUseMemory: true,
    scopeReference: 'session.summary-policy'
  })
  store.createInteraction({
    runId: 'run.summary.policy', interactionId: 'interaction.summary.policy', routingMode: 'preset', promptDigest: 'a'.repeat(64)
  })
  const summaryResult = {
    schemaVersion: 1,
    overview: '受控总结。',
    conclusions: [],
    todos: [],
    risks: []
  }
  store.terminalizeInteraction({
    interactionId: 'interaction.summary.policy', attemptIdentity: attemptIdentity('run.summary.policy'), terminalReason: 'succeeded', errorCode: null,
    result: summaryResult, usage: null, durationMs: 4
  })
  const detail = store.getInteraction({ interactionId: 'interaction.summary.policy' })
  assert.equal(detail.summaryUseMemory, true)
  const page = store.listInteractions({ limit: 10, cursor: null })
  assert.equal(page.items[0].summaryUseMemory, true)
  assert.equal(page.items[0].memoryReferenceCount, 0)
  const snapshot = buildExportSnapshot(detail, 'interaction.summary.policy')
  assert.equal(snapshot.schema_version, 2)
  assert.equal(snapshot.summary_use_memory, true)
  assert.equal(snapshot.memory_reference_count, 0)
})

test('SEM-F28/SEM-F34/J22: tool calls enforce grants, exact state/error binding, byte budgets and attempt order', (t) => {
  const { subtitleStore, store } = fixture(t)
  insertRun(subtitleStore.database, { runId: 'run.tools' })
  store.createInteraction({ runId: 'run.tools', interactionId: 'interaction.tools', routingMode: 'model', promptDigest: 'd'.repeat(64) })
  const started = store.startToolCall({
    callId: 'call.one', interactionId: 'interaction.tools', attemptIdentity: attemptIdentity('run.tools'), attempt: 1, callOrder: 1,
    toolName: 'search_context', startedOffsetMs: 5, args: { query: 'q' }
  })
  assert.equal(started.status, 'started')
  const finished = store.finishToolCall({
    callId: 'call.one', attemptIdentity: attemptIdentity('run.tools'), status: 'succeeded', result: { sourceRefs: [] },
    errorCode: null, endedOffsetMs: 15, sourceRefs: [], counts: { matches: 0 }
  })
  assert.equal(finished.status, 'succeeded')
  assert.equal(finished.resultDigest, sha256Canonical({ sourceRefs: [] }))
  assert.deepEqual(store.startToolCall({
    callId: 'call.one', interactionId: 'interaction.tools', attemptIdentity: attemptIdentity('run.tools'), attempt: 1, callOrder: 1,
    toolName: 'search_context', startedOffsetMs: 5, args: { query: 'q' }
  }), { ...finished, replayed: true })
  const denied = store.startToolCall({
    callId: 'call.denied', interactionId: 'interaction.tools', attemptIdentity: attemptIdentity('run.tools'), attempt: 1, callOrder: 2,
    toolName: 'read_sources', startedOffsetMs: 20, args: { urls: [] }
  })
  assert.equal(denied.status, 'failed')
  assert.equal(denied.errorCode, 'TOOL_NOT_AVAILABLE_FOR_RECIPE')
  assert.throws(() => store.startToolCall({
    callId: 'call.too-large', interactionId: 'interaction.tools', attemptIdentity: attemptIdentity('run.tools'), attempt: 1, callOrder: 3,
    toolName: 'search_context', startedOffsetMs: 30, args: { text: 'x'.repeat(9000) }
  }), (error) => error.code === 'TOOL_BUDGET_EXCEEDED')
  assert.throws(() => store.finishToolCall({
    callId: 'call.one', attemptIdentity: attemptIdentity('run.tools'), status: 'failed', result: null, errorCode: 'TOOL_INTERNAL_FAILURE',
    endedOffsetMs: 16, sourceRefs: [], counts: {}
  }), (error) => error.code === 'AGENT_TOOL_STATE_CONFLICT')
  store.startToolCall({
    callId: 'call.inflight', interactionId: 'interaction.tools', attemptIdentity: attemptIdentity('run.tools'), attempt: 1, callOrder: 4,
    toolName: 'search_context', startedOffsetMs: 35, args: {}
  })
  subtitleStore.database.prepare("UPDATE formal_agent_runs SET attempt_count=2,lease_owner='worker.retry',lease_expires_at=7000 WHERE run_id='run.tools'").run()
  assert.throws(() => store.startToolCall({
    callId: 'call.stale', interactionId: 'interaction.tools', attemptIdentity: attemptIdentity('run.tools'), attempt: 1, callOrder: 1,
    toolName: 'search_context', startedOffsetMs: 36, args: {}
  }), (error) => error.code === 'AGENT_CONTEXT_OPERATION_FAILED')
  assert.throws(() => store.finishToolCall({
    callId: 'call.inflight', attemptIdentity: attemptIdentity('run.tools'), status: 'failed', result: null, errorCode: 'TOOL_INTERNAL_FAILURE',
    endedOffsetMs: 37, sourceRefs: [], counts: {}
  }), (error) => error.code === 'AGENT_CONTEXT_OPERATION_FAILED')
  const retry = store.startToolCall({
    callId: 'call.retry', interactionId: 'interaction.tools', attemptIdentity: attemptIdentity('run.tools', 2, 'worker.retry', 7000), attempt: 2, callOrder: 1,
    toolName: 'search_context', startedOffsetMs: 1, args: {}
  })
  assert.equal(retry.attempt, 2)
  assert.equal(subtitleStore.database.prepare("SELECT COUNT(*) AS count FROM formal_agent_tool_calls WHERE interaction_id='interaction.tools'").get().count, 4)
})

test('SEM-F28/SEM-F34/J22: presentations are one receipt per session and history is opaque keyset pagination', (t) => {
  const { subtitleStore, store } = fixture(t)
  insertRun(subtitleStore.database, { runId: 'run.presentation', recipeId: 'summary.minutes', requestedBy: 'automatic', state: 'queued', attempt: 0, scopeReference: 'session.report' })
  const first = store.createPresentation({ sessionId: 'session.report', runId: 'run.presentation' })
  assert.equal(first.presentedAt, null)
  assert.deepEqual(store.createPresentation({ sessionId: 'session.report', runId: 'run.presentation' }), { ...first, replayed: true })
  const marked = store.markPresentation({ sessionId: 'session.report', presentedAt: 2500 })
  assert.equal(marked.presentedAt, 2500)
  assert.deepEqual(store.markPresentation({ sessionId: 'session.report', presentedAt: 2500 }), { ...marked, replayed: true })

  for (const [runId, interactionId, terminalAt] of [
    ['run.history.a', 'interaction.history.a', 10],
    ['run.history.b', 'interaction.history.b', 10],
    ['run.history.route', 'interaction.history.route', 12]
  ]) {
    insertRun(subtitleStore.database, { runId, recipeId: interactionId.endsWith('.route') ? 'intent.route' : 'qa.answer', state: 'queued', attempt: 0 })
    if (!interactionId.endsWith('.route')) {
      subtitleStore.database.prepare("UPDATE formal_agent_runs SET state='running',attempt_count=1,lease_owner='worker',lease_expires_at=5000 WHERE run_id=?").run(runId)
    }
    store.createInteraction({ runId, interactionId, routingMode: 'rules', promptDigest: 'e'.repeat(64) })
    store.terminalizeInteraction({
      interactionId,
      ...(interactionId.endsWith('.route') ? {} : { attemptIdentity: attemptIdentity(runId) }),
      terminalReason: 'cancelled', errorCode: null, result: null, usage: null, durationMs: 0
    })
    subtitleStore.database.prepare('UPDATE formal_agent_interactions SET terminal_at=? WHERE interaction_id=?').run(2000 + terminalAt, interactionId)
  }
  const page = store.listInteractions({ limit: 1, cursor: null })
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].recipeId, 'qa.answer')
  assert.equal(page.hasMore, true)
  assert.equal(page.nextCursor !== null, true)
  const next = store.listInteractions({ limit: 2, cursor: page.nextCursor })
  assert.equal(next.items.length, 1)
  assert.equal(next.items[0].interactionId, 'interaction.history.b')
  assert.equal(next.hasMore, false)
  assert.equal(next.nextCursor, null)
  assert.throws(() => store.listInteractions({ limit: 1, cursor: 'offset_1' }), (error) => error.code === 'AGENT_REQUEST_INVALID')
})

test('SEM-F33/J22: usageReporting=false rejects provider usage instead of estimating tokens', (t) => {
  const { subtitleStore, store } = fixture(t)
  insertRun(subtitleStore.database, { runId: 'run.unknown-usage', usageReporting: false })
  store.createInteraction({ runId: 'run.unknown-usage', interactionId: 'interaction.unknown-usage', routingMode: 'preset', promptDigest: 'f'.repeat(64) })
  assert.throws(() => store.terminalizeInteraction({
    interactionId: 'interaction.unknown-usage', attemptIdentity: attemptIdentity('run.unknown-usage'), terminalReason: 'succeeded', errorCode: null,
    result: qaResult(), usage: providerUsage, durationMs: 1
  }), (error) => error.code === 'AGENT_REQUEST_INVALID')
  const row = subtitleStore.database.prepare("SELECT usage_json, terminal_reason FROM formal_agent_interactions WHERE interaction_id='interaction.unknown-usage'").get()
  assert.equal(row.usage_json, null)
  assert.equal(row.terminal_reason, null)
})
