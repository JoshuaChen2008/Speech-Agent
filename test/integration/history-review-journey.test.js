'use strict'

/*
 * History review is composed from the production durability and session
 * layers.  The only seams here are Electron's utility process (the
 * service-backed host below), physical capture/ASR (FakeRuntimeAdapter), and
 * the operating-system save dialog.  StorageGateway still speaks the real
 * protocol to StorageWorkerService, which owns the real SqliteSubtitleStore.
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { HistoryService } = require('../../src/main/services/history-service')
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
  makeOpenSessionKey
} = require('../../src/runtime/storage-worker/protocol')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')

const DEV_RUNTIME = resolveRuntimeOptions({ LIVE_SUBTITLE_DEV_MODEL: DEV_MODEL_VALUE })

function temporaryDirectory () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'history-review-journey-'))
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

/* This is the same in-process Electron utility-process substitute used by
   product-sqlite-lifecycle-journey.  Keeping the wire envelope here proves
   that history:list-sessions has been added to the actual worker protocol. */
function serviceBackedHost (service, databasePath, operations) {
  let sequence = 0
  let started = false

  function call (operation, payload, idempotencyKey) {
    operations.push(operation)
    const response = service.handle({
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId: `history-review-${++sequence}`,
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
    async getSessionTranscript (sessionId) {
      return call(OPERATIONS.GET_SESSION, { sessionId })
    },
    async listSessions (input) {
      return call(OPERATIONS.LIST_SESSIONS, input)
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

function createGateway (databasePath, operations) {
  const service = new StorageWorkerService({
    storeFactory: (options) => new SqliteSubtitleStore(options)
  })
  const gateway = new StorageGateway({
    databasePath,
    hostFactory: () => serviceBackedHost(service, databasePath, operations),
    maxRestarts: 0
  })
  return { gateway, service }
}

function caption (sessionId, sourceId, overrides) {
  return {
    schemaVersion: 1,
    sessionId,
    sourceId,
    segmentId: 'segment-1',
    sequence: 1,
    revision: 1,
    kind: 'final',
    t0: 0,
    t1: 1,
    text: 'final transcript body',
    translation: null,
    ...overrides
  }
}

test('CI journey: review completed SQLite sessions, their detail, and text-only exports', async (t) => {
  const root = temporaryDirectory()
  const databasePath = path.join(root, 'data', 'speech-agent.sqlite3')
  const exportDirectory = path.join(root, 'exports')
  const txtPath = path.join(exportDirectory, 'mic-session.txt')
  const mdPath = path.join(exportDirectory, 'mic-session.md')
  const srtPath = path.join(exportDirectory, 'mic-session.srt')
  const operations = []
  const { gateway } = createGateway(databasePath, operations)
  let clock = 1777700000000
  const sessionIds = ['mic-review-session', 'loopback-review-session']
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  const recorder = new SqliteSessionRecorder({ gateway, now: () => clock })
  const coordinator = new SessionCoordinator({
    adapter,
    persistenceSink: recorder,
    runtimeOptions: DEV_RUNTIME,
    configuration: {
      onboardingCompleted: true,
      onboardingPreset: 'dictation',
      mic: true,
      loopback: false
    },
    idFactory: () => sessionIds.shift()
  })
  const saveDialogCalls = []
  const chosenPaths = [txtPath, mdPath, srtPath]
  const ownerWindow = { role: 'history-window' }
  const history = new HistoryService({
    gateway,
    /* The production main-process service chooses this returned OS path; no
       renderer- or transcript-supplied destination path exists in the API. */
    showSaveDialog: async (owner, options) => {
      saveDialogCalls.push({ owner, options })
      return { canceled: false, filePath: chosenPaths.shift() }
    }
  })

  fs.mkdirSync(exportDirectory, { recursive: true })
  t.after(async () => {
    await coordinator.dispose().catch(() => {})
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(root, { recursive: true, force: true })
  })

  await gateway.start()
  assert.equal((await coordinator.command('start')).ok, true)
  const micSessionId = coordinator.getSnapshot().sessionId
  assert.equal(micSessionId, 'mic-review-session')
  assert.deepEqual(
    coordinator.getSnapshot().sources.filter((source) => source.state !== 'unavailable').map((source) => source.id),
    ['mic'],
    'the first session is microphone-only'
  )

  assert.deepEqual(await history.listSessions({ limit: 10, cursor: null }), {
    items: [],
    nextCursor: null
  }, 'active sessions do not enter the history list')

  adapter.emitCaption(caption(micSessionId, 'mic', {
    kind: 'partial', sequence: 1, revision: 1, text: 'recognizing interim words'
  }))
  adapter.emitCaption(caption(micSessionId, 'mic', {
    kind: 'final', sequence: 2, revision: 2, text: 'final transcript body'
  }))
  adapter.emitCaption(caption(micSessionId, 'mic', {
    kind: 'refined', sequence: 3, revision: 3, text: 'refined transcript body'
  }))
  await gateway.flush()

  clock += 2500
  assert.equal((await coordinator.command('stop')).ok, true)
  assert.equal(coordinator.getSnapshot().phase, 'idle')

  const closedMic = await history.listSessions({ limit: 10, cursor: null })
  assert.deepEqual(closedMic, {
    items: [{
      sessionId: micSessionId,
      mode: 'dictation',
      sourceId: 'mic',
      startedAt: 1777700000000,
      endedAt: 1777700002500,
      state: 'closed',
      segmentCount: 1
    }],
    nextCursor: null
  })

  const micDetail = await history.getSession(micSessionId)
  assert.deepEqual(micDetail.session, {
    sessionId: micSessionId,
    mode: 'dictation',
    sourceId: 'mic',
    startedAt: 1777700000000,
    endedAt: 1777700002500,
    state: 'closed'
  }, 'detail retains terminal state and both durable timestamps')
  assert.deepEqual(micDetail.segments, [{
    segmentId: 'segment-1',
    sourceId: 'mic',
    text: 'refined transcript body',
    textRevision: 3,
    t0Ms: 0,
    t1Ms: 1000,
    firstEventOrder: 1,
    updatedEventOrder: 2
  }], 'partial captions are not persisted and refined text projects as the body')
  assert.equal(Object.hasOwn(micDetail, 'translation'), false)
  assert.equal(Object.hasOwn(micDetail, 'audioPath'), false)
  assert.equal(Object.hasOwn(micDetail.session, 'audioPath'), false)
  assert.equal(Object.hasOwn(micDetail.segments[0], 'translation'), false)
  assert.equal(Object.hasOwn(micDetail.segments[0], 'audioPath'), false)

  clock += 1000
  coordinator.updateConfiguration({
    onboardingCompleted: true,
    onboardingPreset: 'meeting',
    mic: false,
    loopback: true
  })
  assert.equal((await coordinator.command('start')).ok, true)
  const loopbackSessionId = coordinator.getSnapshot().sessionId
  assert.equal(loopbackSessionId, 'loopback-review-session')
  assert.deepEqual(
    coordinator.getSnapshot().sources.filter((source) => source.state !== 'unavailable').map((source) => source.id),
    ['loopback'],
    'the second session remains XOR loopback-only'
  )
  assert.deepEqual(
    (await history.listSessions({ limit: 10, cursor: null })).items.map((item) => item.sessionId),
    [micSessionId],
    'a second active session is also excluded from review'
  )
  adapter.emitCaption(caption(loopbackSessionId, 'loopback', {
    segmentId: 'loopback-segment', text: 'loopback final body'
  }))
  await gateway.flush()

  clock += 1000
  assert.equal((await coordinator.command('stop')).ok, true)

  const terminalSessions = await history.listSessions({ limit: 10, cursor: null })
  assert.deepEqual(terminalSessions.items.map((item) => item.sessionId), [
    loopbackSessionId,
    micSessionId
  ], 'completed sessions are stably newest-first')
  const newestOnly = await history.listSessions({ limit: 1, cursor: null })
  assert.equal(newestOnly.items[0].sessionId, loopbackSessionId)
  assert.deepEqual(newestOnly.nextCursor, {
    startedAt: 1777700003500,
    sessionId: loopbackSessionId
  })
  assert.deepEqual(
    (await history.listSessions({ limit: 1, cursor: newestOnly.nextCursor })).items.map((item) => item.sessionId),
    [micSessionId],
    'the keyset cursor preserves the same reverse ordering'
  )

  const txtResult = await history.exportSession({ sessionId: micSessionId, format: 'txt' }, ownerWindow)
  const mdResult = await history.exportSession({ sessionId: micSessionId, format: 'md' }, ownerWindow)
  const srtResult = await history.exportSession({ sessionId: micSessionId, format: 'srt' }, ownerWindow)
  assert.deepEqual(txtResult, { status: 'saved', format: 'txt' })
  assert.deepEqual(mdResult, { status: 'saved', format: 'md' })
  assert.deepEqual(srtResult, { status: 'saved', format: 'srt' })
  assert.equal(JSON.stringify(txtResult).includes(txtPath), false)
  assert.equal(JSON.stringify(mdResult).includes(mdPath), false)
  assert.equal(JSON.stringify(srtResult).includes(srtPath), false)
  assert.deepEqual(saveDialogCalls.map(({ owner }) => owner), [ownerWindow, ownerWindow, ownerWindow])
  assert.deepEqual(saveDialogCalls.map(({ options }) => options.filters[0].extensions), [['txt'], ['md'], ['srt']])
  assert.equal(fs.readFileSync(txtPath, 'utf8'), 'refined transcript body\n')
  assert.match(fs.readFileSync(mdPath, 'utf8'), /- refined transcript body\n$/)
  assert.equal(fs.readFileSync(srtPath, 'utf8'),
    '1\n00:00:00,000 --> 00:00:01,000\nrefined transcript body\n')

  assert.ok(operations.includes(OPERATIONS.LIST_SESSIONS),
    'HistoryService listing must cross the real storage-worker list-sessions operation')
  assert.deepEqual(audioFilesUnder(root), [], 'history review and exports do not create raw-audio files')
})
