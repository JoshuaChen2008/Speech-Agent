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
    async listSessions (value) { return this.call(OPERATIONS.LIST_SESSIONS, value) },
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

async function createS1JourneyFixture (t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-context-s1-failure-'))
  const databasePath = path.join(root, 'speech-agent.sqlite3')
  const service = new StorageWorkerService({
    ...(options.agentStoreFactory ? { agentStoreFactory: options.agentStoreFactory } : {}),
    ...(options.personalContextStoreFactory
      ? { personalContextStoreFactory: options.personalContextStoreFactory }
      : {})
  })
  const gateway = new StorageGateway({
    databasePath,
    hostFactory: () => serviceBackedHost(service, databasePath),
    maxRestarts: 0
  })
  await gateway.start()
  let clock = 946684800000
  const recorder = new SqliteSessionRecorder({ gateway, now: () => clock++ })
  const config = new ConfigStore(path.join(root, 'config.json'), { now: () => clock++ })
  config.load()
  const runtime = new PersonalContextRuntime({
    gateway,
    config: {
      get: () => config.get(),
      updateAgentSettings: (request) => config.updateAgentSettings(request)
    },
    onDiagnostic: options.onDiagnostic
  })
  runtime.start(recorder)
  t.after(async () => {
    await runtime.stop()
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { database: service.requireStore().database, gateway, recorder, runtime }
}

async function commitTerminalSession (recorder, sessionId) {
  await recorder.openSession({ sessionId, sourceId: 'mic', refinementEnabled: false })
  await recorder.acceptCaption({
    schemaVersion: 1, sessionId, sourceId: 'mic', segmentId: `${sessionId}.segment`,
    sequence: 1, revision: 1, kind: 'final', t0: 0, t1: 10,
    text: 'synthetic committed journey', translation: null
  })
  return recorder.closeSession({ sessionId, sourceId: 'mic', state: 'closed' })
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
        scope: { kind: 'global', reference: null }
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

test('SEM-F00/SEM-F28/SEM-F30/SEM-T04/J21: S1 failure matrix preserves subtitle persistence and automatic zero writes', async (t) => {
  await t.test('personal-context store initialization failure leaves caption persistence independent', async (t) => {
    let factoryCalls = 0
    let oldAgentFactoryCalls = 0
    const fixture = await createS1JourneyFixture(t, {
      agentStoreFactory: () => {
        oldAgentFactoryCalls += 1
        throw new Error('old Agent store must stay lazy')
      },
      personalContextStoreFactory: () => {
        factoryCalls += 1
        throw new Error('injected personal-context store initialization failure')
      }
    })
    await assert.rejects(fixture.runtime.module.resolve({
      scope: { kind: 'session', reference: 'session.store-failure' }, semantic_keys: [], aliases: []
    }))
    await commitTerminalSession(fixture.recorder, 'session.store-failure')
    const history = await fixture.gateway.listSessions({ limit: 10, cursor: null })
    await nextTurn()

    assert.equal(factoryCalls, 1)
    assert.equal(oldAgentFactoryCalls, 0)
    assert.equal(history.items.length, 1)
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1)
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_runs').get().count, 0)
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM agent_artifacts').get().count, 0)
  })

  await t.test('personal-context transaction rollback leaves no run or episode and a later caption session persists', async (t) => {
    const fixture = await createS1JourneyFixture(t)
    await commitTerminalSession(fixture.recorder, 'session.rollback')
    const source = frozenSource(fixture.database, 'session.rollback')
    fixture.database.exec(`
      CREATE TRIGGER inject_s1_episode_failure BEFORE INSERT ON personal_context_episodes
      BEGIN SELECT RAISE(ABORT, 'injected episode failure'); END;
    `)

    await assert.rejects(
      fixture.runtime.module.ingest(source),
      (error) => error?.code === 'STORAGE_COMMAND_FAILED'
    )
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_runs').get().count, 0)
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM personal_context_episodes').get().count, 0)
    await commitTerminalSession(fixture.recorder, 'session.after-rollback')
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 2)
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM agent_artifacts').get().count, 0)
  })

  await t.test('duplicate terminal notifications and a lost ingest reply replay without automatic work', async (t) => {
    const fixture = await createS1JourneyFixture(t)
    await commitTerminalSession(fixture.recorder, 'session.replay')
    fixture.recorder.notifyTerminalCommitted('session.replay')
    fixture.recorder.notifyTerminalCommitted('session.replay')
    await nextTurn()
    await nextTurn()

    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_runs').get().count, 0)
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM agent_artifacts').get().count, 0)
    const source = frozenSource(fixture.database, 'session.replay')
    await fixture.runtime.module.ingest(source) // Simulates a committed reply that the caller did not receive.
    const replay = await fixture.runtime.module.ingest(source)
    assert.equal(replay.replayed, true)
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_runs').get().count, 1)
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM personal_context_episodes').get().count, 1)
    await commitTerminalSession(fixture.recorder, 'session.after-replay')
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 2)
  })

  await t.test('scheduler observer failure is isolated while qualification remains provider_not_configured', async (t) => {
    let diagnosticCalls = 0
    const fixture = await createS1JourneyFixture(t, {
      onDiagnostic: () => {
        diagnosticCalls += 1
        throw new Error('injected scheduler observer failure')
      }
    })
    fixture.gateway.claimNextFormalAgentRun = async () => {
      throw new Error('injected scheduler storage failure')
    }
    fixture.runtime.scheduler.start()
    await nextTurn()

    assert.ok(diagnosticCalls > 0)
    assert.deepEqual(await fixture.runtime.reconciler.reconcile({ sessionId: 'session.observer-failure' }), {
      eligibility: 'provider_not_configured', createdRunCount: 0, createdReportCount: 0
    })
    await commitTerminalSession(fixture.recorder, 'session.after-observer-failure')
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1)
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_runs').get().count, 0)
    assert.equal(fixture.database.prepare('SELECT COUNT(*) AS count FROM agent_artifacts').get().count, 0)
  })
})
