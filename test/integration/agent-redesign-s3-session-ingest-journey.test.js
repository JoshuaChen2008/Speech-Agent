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
    if (response && typeof response.then === 'function') {
      return response.then((resolved) => {
        if (!resolved.ok) throw new StorageError(resolved.error.code)
        return resolved.result
      })
    }
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
    async applyPersonalContextAutomaticPolicy (v) { return call(OPERATIONS.PERSONAL_CONTEXT_APPLY_AUTOMATIC_POLICY, { request: v }) },
    async cancelPersonalContextSessionIngest (v) { return call(OPERATIONS.PERSONAL_CONTEXT_CANCEL_SESSION_INGEST, { request: v }) },
    async readPersonalContextSessionInput (v) { return call(OPERATIONS.PERSONAL_CONTEXT_READ_SESSION_INPUT, { source: v }) },
    async readPersonalContextToolContext (v) { return call(OPERATIONS.PERSONAL_CONTEXT_READ_TOOL_CONTEXT, { request: v }) },
    async commitPersonalContextSessionIngest (v) { return call(OPERATIONS.PERSONAL_CONTEXT_COMMIT_SESSION_INGEST, { request: v }) },
    async claimNextFormalAgentRun (v) { return call(OPERATIONS.FORMAL_AGENT_CLAIM_RUN, { request: v }) },
    async nextFormalAgentRunAt (v = {}) { return call(OPERATIONS.FORMAL_AGENT_NEXT_RUN_AT, v) },
    async failFormalAgentRun (v) { return call(OPERATIONS.FORMAL_AGENT_FAIL_RUN, { request: v }) },
    async shutdown () { if (!service.shuttingDown) call(OPERATIONS.SHUTDOWN, {}); this.state = 'closed' },
    async terminateAndWait () { await this.shutdown(); return 0 }
  }
}

function tick () { return new Promise((resolve) => setTimeout(resolve, 10)) }

test('SEM-F28/SEM-F30/SEM-T10/SEM-T15/J21/J22/J24: terminal session ingest uses real SQLite worker, lease claim and scheduler wake', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's3-session-journey-'))
  const databasePath = path.join(root, 'speech-agent.sqlite3')
  const service = new StorageWorkerService()
  const gateway = new StorageGateway({ databasePath, hostFactory: () => hostFactory(service, databasePath), maxRestarts: 0 })
  await gateway.start()
  const recorder = new SqliteSessionRecorder({ gateway, now: () => 1000 })
  const config = new ConfigStore(path.join(root, 'config.json'), { now: () => 1000 })
  config.load()
  config.updateAgentSettings({
    expectedRevision: 0, agentEnabled: true, memoryEnabled: true, cloudDisclosureAccepted: false
  })
  const calls = []
  const runtime = new PersonalContextRuntime({
    gateway,
    ingestRecipeVersion: '1',
    config: { get: () => config.get(), updateAgentSettings: (request) => config.updateAgentSettings(request) },
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
  for (let i = 0; i < 200 && !calls.some(([name]) => name === 'loop'); i++) await tick()
  const runState = service.requireStore().database.prepare('SELECT state,error_code FROM formal_agent_runs LIMIT 1').get()
  assert.equal(calls.some(([name]) => name === 'bind'), true,
    `expected model bind; observed calls=${JSON.stringify(calls.map(([name]) => name))} run=${JSON.stringify(runState || null)}`)
  assert.equal(calls.some(([name]) => name === 'loop'), true)
  const database = service.requireStore().database
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM formal_agent_runs').get().count, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM personal_context_episodes').get().count, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM personal_context_items').get().count, 0)
  const episode = database.prepare(`
    SELECT source_kind, session_id, interaction_id, transcript_version,
      input_watermark, from_event_order, through_event_order, length(input_digest) AS input_digest_length,
      lifecycle
    FROM personal_context_episodes
  `).get()
  assert.deepEqual({ ...episode }, {
    source_kind: 'session',
    session_id: 'session.s3.journey',
    interaction_id: null,
    transcript_version: 'raw',
    input_watermark: 1,
    from_event_order: 1,
    through_event_order: 1,
    input_digest_length: 64,
    lifecycle: 'active'
  })
})

test('SEM-F28/SEM-F30/J24: personal context automatic policy lets the empty queue stay idle', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's3-scheduler-idle-'))
  const databasePath = path.join(root, 'speech-agent.sqlite3')
  const service = new StorageWorkerService()
  const gateway = new StorageGateway({ databasePath, hostFactory: () => hostFactory(service, databasePath), maxRestarts: 0 })
  await gateway.start()
  const config = new ConfigStore(path.join(root, 'config.json'), { now: () => 1000 })
  config.load()
  config.updateAgentSettings({
    expectedRevision: 0, agentEnabled: true, memoryEnabled: true, cloudDisclosureAccepted: false
  })
  const diagnostics = []
  const runtime = new PersonalContextRuntime({ gateway, config, onDiagnostic: (value) => diagnostics.push(value) })
  t.after(async () => {
    await runtime.stop()
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(root, { recursive: true, force: true })
  })
  runtime.start(new SqliteSessionRecorder({ gateway, now: () => 1000 }))
  await runtime.policyPromise
  assert.equal(runtime.policyReady, true)
  runtime.scheduler.start()
  await new Promise((resolve) => setImmediate(resolve))

  const receiptCount = () => service.requireStore().database.prepare(
    'SELECT COUNT(*) AS count FROM formal_agent_run_claim_receipts'
  ).get().count
  assert.deepEqual(diagnostics, [], 'empty queue must not emit AGENT_SCHEDULER_FAILED')
  assert.equal(runtime.scheduler.draining, false)
  assert.equal(runtime.scheduler.timer, null)
  assert.equal(receiptCount(), 1)
  await new Promise((resolve) => setTimeout(resolve, 1100))
  assert.deepEqual(diagnostics, [])
  assert.equal(runtime.scheduler.timer, null)
  assert.equal(receiptCount(), 1, 'idle queue must not keep writing empty claim receipts')
})
