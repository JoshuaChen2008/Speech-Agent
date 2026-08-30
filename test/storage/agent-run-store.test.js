'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { AgentExecutionStore } = require('../../src/runtime/storage-worker/agent-execution-store')
const { FORMAL_AGENT_MIGRATIONS } = require('../../src/runtime/storage-worker/schema')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')
const { sha256Canonical, canonicalize } = require('../../src/runtime/storage-worker/canonical-json')

function fixture (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-store-'))
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

function createRequest (overrides = {}) {
  const scope = { kind: 'session', reference: 'session.run' }
  return {
    runId: 'run.agent.one',
    recipeId: 'qa.answer',
    recipeVersion: '1',
    scope,
    transcriptVersion: 'raw',
    inputWatermark: { throughEventOrder: 3 },
    inputDigest: sha256Canonical({ scope, input: 'frozen' }),
    requestedBy: 'user',
    clientIdempotencyKey: 'client.agent.one',
    ...overrides
  }
}

test('SEM-F16/SEM-F28/J22/J24: run creation freezes recipe/scope/input identity and is idempotent', (t) => {
  const { subtitleStore, store } = fixture(t)
  const request = createRequest()
  const first = store.createRun(request)
  assert.equal(first.runId, request.runId)
  assert.equal(first.recipeId, 'qa.answer')
  assert.equal(first.state, 'queued')
  assert.equal(first.attemptCount, 0)
  assert.equal(first.scopeDigest, sha256Canonical(request.scope))
  assert.equal(first.inputDigest, request.inputDigest)
  const replay = store.createRun(request)
  assert.deepEqual(replay, { ...first, replayed: true })
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_runs').get().count, 1)
  assert.throws(() => store.createRun({ ...request, runId: 'run.agent.other', recipeId: 'report.analysis' }), (error) => error.code === 'AGENT_REQUEST_INVALID')
  assert.throws(() => store.createRun({ ...request, inputDigest: 'f'.repeat(64) }), (error) => error.code === 'AGENT_REQUEST_INVALID')
  const raw = subtitleStore.database.prepare('SELECT scope_json, input_watermark_json, request_digest FROM formal_agent_runs WHERE run_id=?').get(request.runId)
  assert.equal(raw.scope_json, canonicalize(request.scope))
  assert.equal(raw.input_watermark_json, canonicalize(request.inputWatermark))
  assert.doesNotMatch(raw.request_digest, /frozen|prompt/i)
})

test('SEM-F29/SEM-F28/J22: queued cancellation is terminal and running cancellation is a request until the interaction barrier', (t) => {
  const { subtitleStore, store } = fixture(t)
  const queued = store.createRun(createRequest({ runId: 'run.queued', clientIdempotencyKey: 'client.queued' }))
  const cancelled = store.cancelRun({ runId: queued.runId })
  assert.equal(cancelled.state, 'cancelled')
  assert.equal(cancelled.errorCode, null)
  assert.deepEqual(store.cancelRun({ runId: queued.runId }), { ...cancelled, replayed: true })

  const running = store.createRun(createRequest({ runId: 'run.running', clientIdempotencyKey: 'client.running' }))
  subtitleStore.database.prepare(`UPDATE formal_agent_runs SET state='running', attempt_count=1, lease_owner='worker', lease_expires_at=5000 WHERE run_id=?`).run(running.runId)
  const requested = store.cancelRun({ runId: running.runId })
  assert.equal(requested.state, 'running')
  assert.equal(requested.cancelRequested, true)
  assert.equal(subtitleStore.database.prepare('SELECT state, error_code FROM formal_agent_runs WHERE run_id=?').get(running.runId).state, 'running')
})

