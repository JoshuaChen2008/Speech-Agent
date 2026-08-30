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

const providerUsage = {
  inputTokens: 10,
  outputTokens: 4,
  usageSource: 'provider',
  cacheHitInputTokens: null,
  cacheMissInputTokens: null
}

function fixture (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-execution-store-'))
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

function insertRun (database, {
  runId,
  recipeId = 'qa.answer',
  requestedBy = 'user',
  attempt = 1,
  state = 'running',
  usageReporting = true,
  supportsToolCalling = true,
  scopeReference = `session.${runId}`
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
  database.prepare(`
    INSERT INTO agent_model_run_bindings(
      run_id, execution_form, purpose, assignment_mode, profile_id, profile_revision,
      adapter_id, api_style, https_origin, base_path, model_id, capability_json,
      budget_json, provider_kind, credential_slot_id, created_at
    ) VALUES (?, 'agent_loop', 'default', 'direct', 'profile.test', 1,
      'openai-compatible', 'chat-completions', 'https://provider.test', '/v1',
      'model.test', ?, ?, 'cloud', 'slot.test.00000001', 1)
  `).run(
    runId,
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
}

function qaResult () {
  return { schemaVersion: 1, answer: 'answer', sourceRefs: [], memoryRefs: [], unresolved: [] }
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
    interactionId: 'interaction.success', terminalReason: 'succeeded', errorCode: null,
    result: qaResult(), usage: providerUsage, durationMs: 25
  })
  assert.equal(success.terminalReason, 'succeeded')
  assert.equal(success.result.answer, 'answer')
  assert.deepEqual(success.usage, providerUsage)
  assert.equal(subtitleStore.database.prepare("SELECT state FROM formal_agent_runs WHERE run_id='run.success'").get().state, 'succeeded')
  assert.equal(subtitleStore.database.prepare("SELECT lease_owner FROM formal_agent_runs WHERE run_id='run.success'").get().lease_owner, null)
  assert.deepEqual(store.terminalizeInteraction({
    interactionId: 'interaction.success', terminalReason: 'succeeded', errorCode: null,
    result: qaResult(), usage: providerUsage, durationMs: 25
  }), { ...success, replayed: true })
  assert.throws(() => store.terminalizeInteraction({
    interactionId: 'interaction.success', terminalReason: 'failed', errorCode: 'AGENT_INTERNAL_FAILURE',
    result: null, usage: null, durationMs: 26
  }), (error) => error.code === 'AGENT_INTERACTION_STATE_CONFLICT')
  const cancelled = store.terminalizeInteraction({
    interactionId: 'interaction.cancel', terminalReason: 'cancelled', errorCode: null,
    result: null, usage: null, durationMs: 0
  })
  assert.equal(cancelled.terminalReason, 'cancelled')
  assert.equal(cancelled.result, null)
  assert.equal(cancelled.usage, null)
  assert.equal(subtitleStore.database.prepare("SELECT state FROM formal_agent_runs WHERE run_id='run.cancel'").get().state, 'cancelled')
  assert.throws(() => store.terminalizeInteraction({
    interactionId: 'interaction.cancel', terminalReason: 'succeeded', errorCode: null,
    result: qaResult(), usage: null, durationMs: 1
  }), (error) => error.code === 'AGENT_INTERACTION_STATE_CONFLICT')
})

test('SEM-F28/SEM-F34/J22: tool calls enforce grants, exact state/error binding, byte budgets and attempt order', (t) => {
  const { subtitleStore, store } = fixture(t)
  insertRun(subtitleStore.database, { runId: 'run.tools' })
  store.createInteraction({ runId: 'run.tools', interactionId: 'interaction.tools', routingMode: 'model', promptDigest: 'd'.repeat(64) })
  const started = store.startToolCall({
    callId: 'call.one', interactionId: 'interaction.tools', attempt: 1, callOrder: 1,
    toolName: 'search_context', startedOffsetMs: 5, args: { query: 'q' }
  })
  assert.equal(started.status, 'started')
  const finished = store.finishToolCall({
    callId: 'call.one', status: 'succeeded', result: { sourceRefs: [] },
    errorCode: null, endedOffsetMs: 15, sourceRefs: [], counts: { matches: 0 }
  })
  assert.equal(finished.status, 'succeeded')
  assert.equal(finished.resultDigest, sha256Canonical({ sourceRefs: [] }))
  assert.deepEqual(store.startToolCall({
    callId: 'call.one', interactionId: 'interaction.tools', attempt: 1, callOrder: 1,
    toolName: 'search_context', startedOffsetMs: 5, args: { query: 'q' }
  }), { ...finished, replayed: true })
  const denied = store.startToolCall({
    callId: 'call.denied', interactionId: 'interaction.tools', attempt: 1, callOrder: 2,
    toolName: 'read_sources', startedOffsetMs: 20, args: { urls: [] }
  })
  assert.equal(denied.status, 'failed')
  assert.equal(denied.errorCode, 'TOOL_NOT_AVAILABLE_FOR_RECIPE')
  assert.throws(() => store.startToolCall({
    callId: 'call.too-large', interactionId: 'interaction.tools', attempt: 1, callOrder: 3,
    toolName: 'search_context', startedOffsetMs: 30, args: { text: 'x'.repeat(9000) }
  }), (error) => error.code === 'TOOL_BUDGET_EXCEEDED')
  assert.throws(() => store.finishToolCall({
    callId: 'call.one', status: 'failed', result: null, errorCode: 'TOOL_INTERNAL_FAILURE',
    endedOffsetMs: 16, sourceRefs: [], counts: {}
  }), (error) => error.code === 'AGENT_TOOL_STATE_CONFLICT')
  const retry = store.startToolCall({
    callId: 'call.retry', interactionId: 'interaction.tools', attempt: 2, callOrder: 1,
    toolName: 'search_context', startedOffsetMs: 1, args: {}
  })
  assert.equal(retry.attempt, 2)
  assert.equal(subtitleStore.database.prepare("SELECT COUNT(*) AS count FROM formal_agent_tool_calls WHERE interaction_id='interaction.tools'").get().count, 3)
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
    store.createInteraction({ runId, interactionId, routingMode: 'rules', promptDigest: 'e'.repeat(64) })
    store.terminalizeInteraction({
      interactionId, terminalReason: 'cancelled', errorCode: null, result: null, usage: null, durationMs: 0
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
    interactionId: 'interaction.unknown-usage', terminalReason: 'succeeded', errorCode: null,
    result: qaResult(), usage: providerUsage, durationMs: 1
  }), (error) => error.code === 'AGENT_REQUEST_INVALID')
  const row = subtitleStore.database.prepare("SELECT usage_json, terminal_reason FROM formal_agent_interactions WHERE interaction_id='interaction.unknown-usage'").get()
  assert.equal(row.usage_json, null)
  assert.equal(row.terminal_reason, null)
})
