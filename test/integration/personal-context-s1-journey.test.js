'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { CONTRACT_ID, CONTRACT_VERSION } = require('../../src/agent/contracts/agent-context-ui')
const { PersonalContextRuntime } = require('../../src/agent/personal-context/runtime')
const { ConfigStore } = require('../../src/main/services/config-store')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')
const {
  OPERATIONS, PROTOCOL_VERSION, StorageError,
  makeCaptionEventId, makeCloseSessionKey, makeOpenSessionKey, makeRefinementFaultKey
} = require('../../src/runtime/storage-worker/protocol')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')

function nextTurn () {
  return new Promise((resolve) => setImmediate(resolve))
}

function serviceBackedHost (service, databasePath) {
  let sequence = 0
  return {
    state: 'stopped',
    call (operation, payload, idempotencyKey) {
      const response = service.handle({
        version: PROTOCOL_VERSION, type: 'storage:request',
        requestId: `s1-journey.${++sequence}`, operation, payload,
        ...(idempotencyKey ? { idempotencyKey } : {})
      })
      if (!response.ok) throw new StorageError(response.error.code)
      return response.result
    },
    async start () { this.call(OPERATIONS.INITIALIZE, { databasePath }); this.state = 'ready' },
    async openSession (value) { return this.call(OPERATIONS.OPEN_SESSION, value, makeOpenSessionKey(value.sessionId)) },
    async appendCaption (event) { return this.call(OPERATIONS.APPEND_CAPTION, { event }, makeCaptionEventId(event)) },
    async closeSession (value) { return this.call(OPERATIONS.CLOSE_SESSION, value, makeCloseSessionKey(value.sessionId)) },
    async recordRefinementFault (value) {
      return this.call(OPERATIONS.RECORD_REFINEMENT_FAULT, value, makeRefinementFaultKey(value.sessionId, value.faultCode))
    },
    async personalContextIngest (source) { return this.call(OPERATIONS.PERSONAL_CONTEXT_INGEST, { source }) },
    async personalContextResolve (request) { return this.call(OPERATIONS.PERSONAL_CONTEXT_RESOLVE, { request }) },
    async personalContextManage (command) { return this.call(OPERATIONS.PERSONAL_CONTEXT_MANAGE, { command }) },
    async claimNextFormalAgentRun (request) { return this.call(OPERATIONS.FORMAL_AGENT_CLAIM_RUN, { request }) },
    async nextFormalAgentRunAt () { return this.call(OPERATIONS.FORMAL_AGENT_NEXT_RUN_AT, {}) },
    async completeFormalAgentRun (request) { return this.call(OPERATIONS.FORMAL_AGENT_COMPLETE_RUN, { request }) },
    async failFormalAgentRun (request) { return this.call(OPERATIONS.FORMAL_AGENT_FAIL_RUN, { request }) },
    async shutdown () {
      if (!service.shuttingDown) this.call(OPERATIONS.SHUTDOWN, {})
      this.state = 'closed'
    },
    async terminateAndWait () {
      if (!service.shuttingDown) this.call(OPERATIONS.SHUTDOWN, {})
      this.state = 'closed'
      return 0
    }
  }
}

function frozenSource (database, sessionId) {
  const events = database.prepare(`
    SELECT first_event.event_order, segment.segment_id, first_event.text
    FROM segments AS segment
    JOIN caption_events AS first_event ON first_event.event_order = segment.first_event_order
    WHERE segment.session_id = ? ORDER BY first_event.event_order
  `).all(sessionId).map((row) => ({
    eventOrder: Number(row.event_order), segmentId: row.segment_id, text: row.text
  }))
  const inputWatermark = Number(database.prepare(
    'SELECT MAX(event_order) AS watermark FROM caption_events WHERE session_id = ?'
  ).get(sessionId).watermark)
  return {
    sourceKind: 'session', sessionId, transcriptVersion: 'raw', inputWatermark,
    inputDigest: sha256Canonical({ sessionId, transcriptVersion: 'raw', inputWatermark, events })
  }
}

test('SEM-F00/SEM-F26/SEM-F28/SEM-F30/J21: S1 real subtitle commit reaches personal context seams while automatic product path stays ineligible', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-context-s1-journey-'))
  const databasePath = path.join(root, 'speech-agent.sqlite3')
  const service = new StorageWorkerService()
  const gateway = new StorageGateway({
    databasePath,
    hostFactory: () => serviceBackedHost(service, databasePath),
    maxRestarts: 0
  })
  await gateway.start()
  const database = service.requireStore().database
  let clock = 946684800000
  const recorder = new SqliteSessionRecorder({ gateway, now: () => clock++ })
  const config = new ConfigStore(path.join(root, 'config.json'), { now: () => clock++ })
  config.load()
  const changedListeners = new Set()
  const runtime = new PersonalContextRuntime({
    gateway,
    config: {
      get: () => config.get(),
      updateAgentSettings: (request) => config.updateAgentSettings(request)
    },
    onChanged: (event) => {
      for (const listener of [...changedListeners]) {
        try { listener(event) } catch { /* consumer isolation */ }
      }
    },
    onDiagnostic: () => { throw new Error('diagnostic observer failure') }
  })
  runtime.start(recorder)
  t.after(async () => {
    await runtime.stop()
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(root, { recursive: true, force: true })
  })

  await recorder.openSession({ sessionId: 'session.s1.journey', sourceId: 'mic', refinementEnabled: false })
  await recorder.acceptCaption({
    schemaVersion: 1, sessionId: 'session.s1.journey', sourceId: 'mic', segmentId: 'segment.1',
    sequence: 1, revision: 1, kind: 'final', t0: 0, t1: 10,
    text: 'synthetic committed journey', translation: null
  })
  const closeReceipt = await recorder.closeSession({ sessionId: 'session.s1.journey', sourceId: 'mic', state: 'closed' })
  await nextTurn()
  assert.equal(closeReceipt.state, 'closed')
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM formal_agent_runs').get().count, 0,
    'S2 absence must create no automatic run')
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM agent_artifacts').get().count, 0,
    'S2 absence must create no report')

  const source = frozenSource(database, 'session.s1.journey')
  const ingested = await runtime.module.ingest(source)
  assert.deepEqual({ episodes: ingested.episodeCount, memories: ingested.memoryCount }, { episodes: 1, memories: 0 })
  const resolved = await runtime.module.resolve({
    scope: { kind: 'session', reference: 'session.s1.journey' }, semantic_keys: [], aliases: []
  })
  assert.equal(resolved.eligibility, 'ready')
  assert.equal(resolved.episodes.length, 1)

  let localRevision = -1
  const applied = []
  changedListeners.add((event) => {
    if (event.revision > localRevision) {
      localRevision = event.revision
      applied.push(event.revision)
    }
  })
  const overview = await runtime.getOverview({ contract_id: CONTRACT_ID, contract_version: CONTRACT_VERSION })
  localRevision = overview.snapshot.revision
  const remembered = await runtime.manage({
    contract_id: CONTRACT_ID, contract_version: CONTRACT_VERSION, request_id: 'journey.remember.1',
    command: {
      type: 'remember', expected_revision: localRevision,
      entry: {
        display_text: 'Project codename is Polaris.', kind: 'term',
        scope: { kind: 'global', reference: null }, semantic_key: 'project:codename'
      }
    }
  })
  assert.equal(remembered.ok, true)
  assert.deepEqual(applied, [remembered.revision])
  for (const duplicate of [remembered.revision, remembered.revision - 1]) {
    for (const listener of changedListeners) listener({
      contract_id: CONTRACT_ID, contract_version: CONTRACT_VERSION, revision: duplicate
    })
  }
  assert.deepEqual(applied, [remembered.revision], 'consumer applies only higher changed revisions')
  assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
})
