'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { PersonalContextRuntime } = require('../../src/agent/personal-context/runtime')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')
const { OPERATIONS, PROTOCOL_VERSION, makeCaptionEventId, makeCloseSessionKey, makeOpenSessionKey, StorageError } = require('../../src/runtime/storage-worker/protocol')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { ConfigStore } = require('../../src/main/services/config-store')

function hostFactory (service, databasePath) {
  let sequence = 0
  const call = (operation, payload, idempotencyKey) => {
    const response = service.handle({ version: PROTOCOL_VERSION, type: 'storage:request', requestId: `s3.${++sequence}`, operation, payload, ...(idempotencyKey ? { idempotencyKey } : {}) })
    if (!response.ok) throw new StorageError(response.error.code)
    return response.result
  }
  return {
    state: 'stopped',
    async start () { call(OPERATIONS.INITIALIZE, { databasePath }); this.state = 'ready' },
    async openSession (v) { return call(OPERATIONS.OPEN_SESSION, v, makeOpenSessionKey(v.sessionId)) },
    async appendCaption (v) { return call(OPERATIONS.APPEND_CAPTION, { event: v }, makeCaptionEventId(v)) },
    async closeSession (v) { return call(OPERATIONS.CLOSE_SESSION, v, makeCloseSessionKey(v.sessionId)) },
    async personalContextIngest (v) { return call(OPERATIONS.PERSONAL_CONTEXT_INGEST, { source: v }) },
    async personalContextResolve (v) { return call(OPERATIONS.PERSONAL_CONTEXT_RESOLVE, { request: v }) },
    async personalContextManage (v) { return call(OPERATIONS.PERSONAL_CONTEXT_MANAGE, { command: v }) },
    async preparePersonalContextSessionIngest (v) { return call(OPERATIONS.PERSONAL_CONTEXT_PREPARE_SESSION_INGEST, { request: v }) },
    async readPersonalContextSessionInput (v) { return call(OPERATIONS.PERSONAL_CONTEXT_READ_SESSION_INPUT, { source: v }) },
    async commitPersonalContextSessionIngest (v) { return call(OPERATIONS.PERSONAL_CONTEXT_COMMIT_SESSION_INGEST, { request: v }) },
    async claimNextFormalAgentRun (v) { return call(OPERATIONS.FORMAL_AGENT_CLAIM_RUN, { request: v }) },
    async nextFormalAgentRunAt () { return call(OPERATIONS.FORMAL_AGENT_NEXT_RUN_AT, {}) },
    async failFormalAgentRun (v) { return call(OPERATIONS.FORMAL_AGENT_FAIL_RUN, { request: v }) },
    async shutdown () { if (!service.shuttingDown) call(OPERATIONS.SHUTDOWN, {}); this.state = 'closed' },
    async terminateAndWait () { await this.shutdown(); return 0 }
  }
}

function tick () { return new Promise((resolve) => setImmediate(resolve)) }

test('SEM-F28/SEM-F30/SEM-T10/SEM-T15/J22/J24: terminal session ingest uses real SQLite worker, lease claim and scheduler wake', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's3-session-journey-'))
  const databasePath = path.join(root, 'speech-agent.sqlite3')
  const service = new StorageWorkerService()
  const gateway = new StorageGateway({ databasePath, hostFactory: () => hostFactory(service, databasePath), maxRestarts: 0 })
  await gateway.start()
  const recorder = new SqliteSessionRecorder({ gateway, now: () => 1000 })
  const config = new ConfigStore(path.join(root, 'config.json'), { now: () => 1000 })
  config.load()
  const calls = []
  const runtime = new PersonalContextRuntime({
    gateway,
    executionAdapter: {
      prepareSessionIngest: (request) => gateway.preparePersonalContextSessionIngest(request),
      readSessionInput: async (value) => ({ ...value, events: [{ eventOrder: 1, segmentId: 'segment.1', text: 'decision' }] }),
      commitSessionIngest: (request) => gateway.commitPersonalContextSessionIngest(request)
    },
    config: { get: () => config.get(), updateAgentSettings: () => ({}) },
    modelAccess: { bind: async (request) => { calls.push(['bind', request]); return { capabilities: { usageReporting: false } } } },
    loop: { agentLoop: async () => { calls.push(['loop']); return { text: JSON.stringify({ schemaVersion: 1, experiences: [], memoryCandidates: [] }) } } },
    interactions: {
      create: async (request) => { calls.push(['interaction:create', request]); return request },
      terminalize: async (request) => { calls.push(['interaction:terminalize', request]); return request }
    },
    getAutomaticEligibility: async () => 'ready'
  })
  runtime.start(recorder)
  t.after(async () => { await runtime.stop(); await gateway.shutdown().catch(() => gateway.terminate()); fs.rmSync(root, { recursive: true, force: true }) })

  await recorder.openSession({ sessionId: 'session.s3.journey', sourceId: 'mic', refinementEnabled: false })
  await recorder.acceptCaption({ schemaVersion: 1, sessionId: 'session.s3.journey', sourceId: 'mic', segmentId: 'segment.1', sequence: 1, revision: 1, kind: 'final', t0: 0, t1: 1, text: 'decision', translation: null })
  await recorder.closeSession({ sessionId: 'session.s3.journey', sourceId: 'mic', state: 'closed' })
  recorder.notifyTerminalCommitted('session.s3.journey')
  for (let i = 0; i < 20 && !calls.some(([name]) => name === 'loop'); i++) await tick()
  assert.equal(calls.some(([name]) => name === 'bind'), true)
  assert.equal(calls.some(([name]) => name === 'loop'), true)
  const database = service.requireStore().database
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM formal_agent_runs').get().count, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM personal_context_episodes').get().count, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM personal_context_items').get().count, 0)
})
