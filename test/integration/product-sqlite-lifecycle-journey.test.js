'use strict'

/*
 * This is the product composition journey, deliberately one layer above the
 * StorageGateway and SessionCoordinator journeys.  On the storage side only
 * Electron's utility process is substituted: the same StorageWorkerService
 * and SqliteSubtitleStore execute in-process, while every durable SQLite
 * operation still crosses the production gateway.  Physical capture and ASR
 * remain the existing CaptionEvent contract boundary through FakeRuntimeAdapter.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { SubtitleApplicationRuntime } = require('../../src/main/services/subtitle-application-runtime')
const { JsonlSqliteMigrator } = require('../../src/main/services/jsonl-sqlite-migrator')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { FakeRuntimeAdapter } = require('../../src/main/session/fake-runtime-adapter')
const { SessionCoordinator } = require('../../src/main/session/session-coordinator')
const { DEV_MODEL_VALUE, resolveRuntimeOptions } = require('../../src/main/runtime-options')
const {
  OPERATIONS,
  PROTOCOL_VERSION,
  StorageError,
  makeCaptionEventId,
  makeCloseSessionKey,
  makeLegacyImportKey,
  makeOpenSessionKey
} = require('../../src/runtime/storage-worker/protocol')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')

const DEV_RUNTIME = resolveRuntimeOptions({ LIVE_SUBTITLE_DEV_MODEL: DEV_MODEL_VALUE })

function temporaryDirectory () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'product-sqlite-lifecycle-'))
}

function audioFilesUnder (directory) {
  const found = []
  const visit = (current) => {
    if (!fs.existsSync(current)) return
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (/\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)$/i.test(entry.name)) found.push(target)
    }
  }
  visit(directory)
  return found
}

function serviceBackedHost (service, databasePath) {
  let sequence = 0
  let started = false

  function call (operation, payload, idempotencyKey) {
    const response = service.handle({
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId: `product-lifecycle-${++sequence}`,
      operation,
      payload,
      ...(idempotencyKey ? { idempotencyKey } : {})
    })
    if (!response.ok) throw new StorageError(response.error.code)
    return response.result
  }

  return {
    async start () {
      if (started) return
      call(OPERATIONS.INITIALIZE, { databasePath })
      started = true
    },
    async openSession (input) {
      return call(OPERATIONS.OPEN_SESSION, input, makeOpenSessionKey(input.sessionId))
    },
    async appendCaption (event) {
      return call(OPERATIONS.APPEND_CAPTION, { event }, makeCaptionEventId(event))
    },
    async closeSession (input) {
      return call(OPERATIONS.CLOSE_SESSION, input, makeCloseSessionKey(input.sessionId))
    },
    async recoverStaleSessions (input) {
      return call(OPERATIONS.RECOVER_STALE_SESSIONS, input)
    },
    async importLegacyJsonl (input) {
      return call(OPERATIONS.IMPORT_LEGACY_JSONL, input, makeLegacyImportKey(input.sourceSha256))
    },
    async getSessionTranscript (sessionId) {
      return call(OPERATIONS.GET_SESSION, { sessionId })
    },
    async getStats () {
      return call(OPERATIONS.GET_STATS, {})
    },
    async shutdown () {
      if (!service.shuttingDown) call(OPERATIONS.SHUTDOWN, {})
    },
    async terminateAndWait () {
      if (!service.shuttingDown) call(OPERATIONS.SHUTDOWN, {})
      return 0
    }
  }
}

function createGateway (databasePath) {
  const service = new StorageWorkerService({
    storeFactory: (options) => new SqliteSubtitleStore(options)
  })
  const gateway = new StorageGateway({
    databasePath,
    hostFactory: () => serviceBackedHost(service, databasePath),
    maxRestarts: 0
  })
  return { service, gateway }
}

async function inspectDatabase (databasePath, assertion) {
  const { gateway } = createGateway(databasePath)
  try {
    await gateway.start()
    return await assertion(gateway)
  } finally {
    await gateway.shutdown().catch(() => gateway.terminate())
  }
}

function writeLegacySession (directory, startedAt) {
  fs.mkdirSync(directory, { recursive: true })
  const records = [
    JSON.stringify({ v: 1, event: 'session.open', sessionId: 'legacy-session', at: new Date(startedAt).toISOString() }),
    JSON.stringify({
      v: 1,
      event: 'segment.final',
      sessionId: 'legacy-session',
      sourceId: 'loopback',
      segmentId: 'legacy-segment',
      sequence: 1,
      revision: 1,
      t0: 0,
      t1: 1,
      text: '旧版会话在首次 SQLite 启动时迁移。'
    }),
    JSON.stringify({ v: 1, event: 'session.close', sessionId: 'legacy-session', at: new Date(startedAt + 1000).toISOString() }),
    ''
  ]
  fs.writeFileSync(path.join(directory, 'legacy-meeting.jsonl'), records.join('\n'), 'utf8')
}

function caption (sessionId, sourceId, overrides) {
  return {
    schemaVersion: 1,
    sessionId,
    sourceId,
    segmentId: 'live-segment',
    sequence: 1,
    revision: 1,
    kind: 'final',
    t0: 0,
    t1: 1,
    text: '实时字幕已落盘。',
    translation: null,
    ...overrides
  }
}

function makeRuntime (options) {
  const {
    userDataDir,
    now,
    sourceId,
    sessionId,
    startupOrder,
    gateways,
    coordinators,
    adapters
  } = options
  const expectedDatabasePath = path.join(userDataDir, 'data', 'speech-agent.sqlite3')
  const expectedLegacyDirectory = path.join(userDataDir, 'sessions')

  return new SubtitleApplicationRuntime({
    userDataDir,
    now,
    gatewayFactory: (input) => {
      const databasePath = typeof input === 'string' ? input : input.databasePath
      assert.equal(databasePath, expectedDatabasePath, 'SQLite must live under userData/data by default')
      const { gateway } = createGateway(databasePath)
      const originalStart = gateway.start.bind(gateway)
      const originalRecover = gateway.recoverStaleSessions.bind(gateway)
      gateway.start = async () => {
        startupOrder.push('gateway.start')
        return originalStart()
      }
      gateway.recoverStaleSessions = async (input) => {
        startupOrder.push('gateway.recoverStaleSessions')
        return originalRecover(input)
      }
      gateways.push(gateway)
      return gateway
    },
    migratorFactory: (input) => {
      assert.equal(input.gateway, gateways.at(-1), 'the migrator must use the started storage gateway')
      const migrator = new JsonlSqliteMigrator({ gateway: input.gateway, now })
      const migrateDirectory = migrator.migrateDirectory.bind(migrator)
      migrator.migrateDirectory = async (directory) => {
        startupOrder.push('migrator.migrateDirectory')
        assert.equal(directory, expectedLegacyDirectory, 'only userData/sessions is the legacy migration source')
        return migrateDirectory(directory)
      }
      return migrator
    },
    recorderFactory: (input) => {
      startupOrder.push('recorderFactory')
      assert.equal(input.gateway, gateways.at(-1), 'one recorder must own the runtime gateway')
      const recorder = new SqliteSessionRecorder({ gateway: input.gateway, now })
      assert.ok(recorder instanceof SqliteSessionRecorder)
      return recorder
    },
    coordinatorFactory: (input) => {
      startupOrder.push('coordinatorFactory')
      assert.ok(input.persistenceSink instanceof SqliteSessionRecorder,
        'the coordinator must receive the SQLite recorder rather than a JSONL recorder')
      const adapter = new FakeRuntimeAdapter({ autoEmit: false })
      const coordinator = new SessionCoordinator({
        adapter,
        persistenceSink: input.persistenceSink,
        runtimeOptions: DEV_RUNTIME,
        configuration: {
          onboardingCompleted: true,
          onboardingPreset: sourceId === 'mic' ? 'dictation' : 'meeting',
          mic: sourceId === 'mic',
          loopback: sourceId === 'loopback'
        },
        idFactory: () => sessionId
      })
      coordinators.push(coordinator)
      adapters.push(adapter)
      return coordinator
    }
  })
}

test('CI journey: product SQLite cold start recovers, migrates and quits without JSONL dual-write', async (t) => {
  const root = temporaryDirectory()
  const userDataDir = path.join(root, 'userData')
  const databasePath = path.join(userDataDir, 'data', 'speech-agent.sqlite3')
  const legacyDirectory = path.join(userDataDir, 'sessions')
  const crashStartedAt = 1775001000000
  const recoveryAt = crashStartedAt + 8000
  let clock = recoveryAt
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  /* Simulate an interrupted prior process: it opens the real SQLite session,
     then its host is gone without a terminal close. */
  const crashed = createGateway(databasePath)
  await crashed.gateway.start()
  await crashed.gateway.openSession({
    sessionId: 'crashed-active-session',
    sourceId: 'loopback',
    startedAt: crashStartedAt
  })
  await crashed.gateway.flush()
  await crashed.gateway.shutdown()
  writeLegacySession(legacyDirectory, crashStartedAt + 1000)

  const firstOrder = []
  const firstGateways = []
  const firstCoordinators = []
  const firstAdapters = []
  const firstRuntime = makeRuntime({
    userDataDir,
    now: () => clock,
    sourceId: 'mic',
    sessionId: 'mic-after-migration',
    startupOrder: firstOrder,
    gateways: firstGateways,
    coordinators: firstCoordinators,
    adapters: firstAdapters
  })
  const firstStarted = await firstRuntime.start()

  assert.deepEqual(firstOrder, [
    'gateway.start',
    'gateway.recoverStaleSessions',
    'migrator.migrateDirectory',
    'recorderFactory',
    'coordinatorFactory'
  ], 'cold-start ordering makes stale recovery visible before any legacy import or live writer exists')
  assert.equal(firstStarted.databasePath, databasePath)
  assert.equal(firstStarted.legacyDirectory, legacyDirectory)
  assert.deepEqual(firstStarted.recoveryReport, { status: 'committed', recoveredSessionCount: 1 })
  assert.equal(firstStarted.migrationReports.length, 1)
  assert.equal(firstStarted.migrationReports[0].status, 'imported')
  assert.equal(firstStarted.coordinator, firstCoordinators[0])

  const recovered = await firstGateways[0].getSessionTranscript('crashed-active-session')
  assert.equal(recovered.session.state, 'interrupted')
  assert.equal(recovered.session.endedAt, recoveryAt)
  const legacy = await firstGateways[0].getSessionTranscript('legacy-session')
  assert.equal(legacy.session.state, 'closed')
  assert.deepEqual(legacy.segments.map((segment) => [segment.segmentId, segment.text]), [
    ['legacy-segment', '旧版会话在首次 SQLite 启动时迁移。']
  ])

  const firstCoordinator = firstCoordinators[0]
  const firstAdapter = firstAdapters[0]
  assert.equal((await firstCoordinator.command('start')).ok, true)
  const micSessionId = firstCoordinator.getSnapshot().sessionId
  assert.equal(micSessionId, 'mic-after-migration')
  assert.deepEqual(
    firstCoordinator.getSnapshot().sources.filter((source) => source.state !== 'unavailable').map((source) => source.id),
    ['mic'],
    'the live session is XOR microphone-only'
  )
  firstAdapter.emitCaption(caption(micSessionId, 'mic', {
    kind: 'partial', text: '正在识别', sequence: 1, revision: 1
  }))
  firstAdapter.emitCaption(caption(micSessionId, 'mic', {
    kind: 'final', text: '实时字幕已落盘', sequence: 2, revision: 2
  }))
  firstAdapter.emitCaption(caption(micSessionId, 'mic', {
    kind: 'refined', text: '实时字幕已落盘。', sequence: 3, revision: 3
  }))
  await firstGateways[0].flush()
  clock += 2000

  const firstShutdown = await firstRuntime.shutdownWithin(1000)
  assert.deepEqual(firstShutdown, { graceful: true, reason: null })
  assert.equal(firstCoordinator.getSnapshot().phase, 'idle', 'before-quit shutdown must close a live session before disposal')
  assert.deepEqual(fs.readdirSync(legacyDirectory).sort(), ['legacy-meeting.jsonl'],
    'live sessions must not create a second JSONL projection')
  assert.deepEqual(audioFilesUnder(userDataDir), [], 'SQLite history and lifecycle shutdown must not persist raw audio')

  await inspectDatabase(databasePath, async (gateway) => {
    assert.deepEqual(await gateway.getStats(), {
      sessions: 3,
      activeSessions: 0,
      captionEvents: 3,
      segments: 2,
      legacyImports: 1,
      journalMode: 'wal',
      integrity: 'ok'
    }, 'one legacy fact set plus one final/refined live projection is retained exactly once')
    const mic = await gateway.getSessionTranscript(micSessionId)
    assert.equal(mic.session.state, 'interrupted',
      'an operating-system quit closes the durable session as interrupted, never as a normal user stop')
    assert.deepEqual(mic.segments.map((segment) => [segment.segmentId, segment.text]), [
      ['live-segment', '实时字幕已落盘。']
    ])
  })

  const secondOrder = []
  const secondGateways = []
  const secondCoordinators = []
  const secondAdapters = []
  clock += 1000
  const secondRuntime = makeRuntime({
    userDataDir,
    now: () => clock,
    sourceId: 'loopback',
    sessionId: 'loopback-after-idempotent-migration',
    startupOrder: secondOrder,
    gateways: secondGateways,
    coordinators: secondCoordinators,
    adapters: secondAdapters
  })
  const secondStarted = await secondRuntime.start()
  assert.deepEqual(secondOrder, [
    'gateway.start',
    'gateway.recoverStaleSessions',
    'migrator.migrateDirectory',
    'recorderFactory',
    'coordinatorFactory'
  ])
  assert.deepEqual(secondStarted.recoveryReport, { status: 'none', recoveredSessionCount: 0 })
  assert.deepEqual(secondStarted.migrationReports.map((report) => report.status), ['already_processed'],
    'the same legacy SHA cannot create a second session, event, segment or audit row')

  const secondCoordinator = secondCoordinators[0]
  const secondAdapter = secondAdapters[0]
  assert.equal((await secondCoordinator.command('start')).ok, true)
  const loopbackSessionId = secondCoordinator.getSnapshot().sessionId
  assert.deepEqual(
    secondCoordinator.getSnapshot().sources.filter((source) => source.state !== 'unavailable').map((source) => source.id),
    ['loopback'],
    'after the restart, loopback is independently startable and remains XOR-safe'
  )
  secondAdapter.emitCaption(caption(loopbackSessionId, 'loopback', {
    segmentId: 'loopback-segment', sequence: 1, revision: 1, text: '第二次冷启动后系统音频正常工作。'
  }))
  await secondGateways[0].flush()
  clock += 1000
  assert.deepEqual(await secondRuntime.shutdownWithin(1000), { graceful: true, reason: null })

  await inspectDatabase(databasePath, async (gateway) => {
    assert.deepEqual(await gateway.getStats(), {
      sessions: 4,
      activeSessions: 0,
      captionEvents: 4,
      segments: 3,
      legacyImports: 1,
      journalMode: 'wal',
      integrity: 'ok'
    })
    const loopback = await gateway.getSessionTranscript(loopbackSessionId)
    assert.equal(loopback.session.state, 'interrupted')
    assert.deepEqual(loopback.segments.map((segment) => [segment.sourceId, segment.text]), [
      ['loopback', '第二次冷启动后系统音频正常工作。']
    ])
  })
  assert.deepEqual(fs.readdirSync(legacyDirectory).sort(), ['legacy-meeting.jsonl'])
  assert.deepEqual(audioFilesUnder(userDataDir), [])
})
