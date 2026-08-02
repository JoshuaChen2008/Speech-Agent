'use strict'

/* Deterministic J15c journey. Physical capture/ASR and Electron utilityProcess
   are the only substituted boundaries; coordinator, reducer, gateway protocol,
   SQLite store, history projection, notice formatter, and log writer are real. */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { HistoryService } = require('../../src/main/services/history-service')
const { RefinementFaultLog } = require('../../src/main/services/refinement-fault-log')
const { RefinementNoticeStore } = require('../../src/main/services/refinement-notice')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { DEV_MODEL_VALUE, resolveRuntimeOptions } = require('../../src/main/runtime-options')
const { FakeRuntimeAdapter } = require('../../src/main/session/fake-runtime-adapter')
const { SessionCoordinator } = require('../../src/main/session/session-coordinator')
const {
  applyEvent,
  createState,
  evictCaptionPrefix,
  hydrateState
} = require('../../src/ui/shared/caption-reducer')
const {
  OPERATIONS,
  PROTOCOL_VERSION,
  StorageError,
  makeCaptionEventId,
  makeCloseSessionKey,
  makeOpenSessionKey,
  makeRefinementFaultKey
} = require('../../src/runtime/storage-worker/protocol')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')

function serviceBackedHost (service, databasePath) {
  let sequence = 0
  const call = (operation, payload, idempotencyKey) => {
    const response = service.handle({
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId: `refinement-fallback-${++sequence}`,
      operation,
      payload,
      ...(idempotencyKey ? { idempotencyKey } : {})
    })
    if (!response.ok) throw new StorageError(response.error.code)
    return response.result
  }
  return {
    async start () { call(OPERATIONS.INITIALIZE, { databasePath }) },
    async openSession (input) { return call(OPERATIONS.OPEN_SESSION, input, makeOpenSessionKey(input.sessionId)) },
    async appendCaption (event) { return call(OPERATIONS.APPEND_CAPTION, { event }, makeCaptionEventId(event)) },
    async recordRefinementFault (input) {
      return call(OPERATIONS.RECORD_REFINEMENT_FAULT, input,
        makeRefinementFaultKey(input.sessionId, input.faultCode))
    },
    async closeSession (input) { return call(OPERATIONS.CLOSE_SESSION, input, makeCloseSessionKey(input.sessionId)) },
    async getSessionTranscript (sessionId) { return call(OPERATIONS.GET_SESSION, { sessionId }) },
    async getSessionPage (input) { return call(OPERATIONS.GET_SESSION_PAGE, input) },
    async listSessions (input) { return call(OPERATIONS.LIST_SESSIONS, input) },
    async getStats () { return call(OPERATIONS.GET_STATS, {}) },
    async shutdown () { if (!service.shuttingDown) call(OPERATIONS.SHUTDOWN, {}) },
    async terminateAndWait () { if (!service.shuttingDown) call(OPERATIONS.SHUTDOWN, {}); return 0 }
  }
}

function createGateway (databasePath) {
  const service = new StorageWorkerService({
    storeFactory: (options) => new SqliteSubtitleStore(options)
  })
  return new StorageGateway({
    databasePath,
    maxRestarts: 0,
    hostFactory: () => serviceBackedHost(service, databasePath)
  })
}

function event (sessionId, sequence, index, kind, text, revision = 1) {
  return {
    schemaVersion: 1,
    sessionId,
    sourceId: 'mic',
    segmentId: `segment-${index}`,
    sequence,
    revision,
    kind,
    t0: index,
    t1: index + 0.8,
    text,
    translation: null
  }
}

function audioArtifacts (directory) {
  const found = []
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (/\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)$/i.test(entry.name)) found.push(target)
    }
  }
  visit(directory)
  return found
}

test('J15c: refinement failure restores visible originals, persists truth, and reports only after normal stop', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-agent-j15c-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const databasePath = path.join(root, 'data', 'speech-agent.sqlite3')
  const logDirectory = path.join(root, 'logs', 'refinement')
  const sessionId = 'j15c-refinement-session'
  let now = 1_785_650_000_000

  const gateway = createGateway(databasePath)
  const recorder = new SqliteSessionRecorder({ gateway, now: () => now })
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  const runtime = resolveRuntimeOptions({ LIVE_SUBTITLE_DEV_MODEL: DEV_MODEL_VALUE })
  const coordinator = new SessionCoordinator({
    adapter,
    persistenceSink: recorder,
    runtimeOptions: { ...runtime, refinementAvailable: true },
    configuration: {
      onboardingCompleted: true,
      onboardingPreset: 'dictation',
      mic: true,
      loopback: false,
      refinementEnabled: true
    },
    idFactory: () => sessionId
  })
  const logger = new RefinementFaultLog({ directory: logDirectory, now: () => now })
  let rendered = createState()
  let logTask = Promise.resolve()
  coordinator.onCaption((caption) => { rendered = applyEvent(rendered, caption) })
  coordinator.onCaptionState((state) => { rendered = hydrateState(state, rendered) })
  coordinator.onRefinementFault((fault) => {
    logTask = logger.record({ code: fault.code, stage: fault.stage, faultAtMs: fault.faultAtMs })
  })

  assert.equal((await coordinator.command('start')).ok, true)
  assert.equal(recorder.getActiveSession().refinementEnabled, true)
  let sequence = 0
  for (let index = 1; index <= 10; index += 1) {
    adapter.emitCaption(event(sessionId, ++sequence, index, 'final', `原始字幕 ${index}`))
    if (index <= 6) {
      adapter.emitCaption(event(sessionId, ++sequence, index, 'refined', `精修字幕 ${index}`, 2))
    }
  }
  /* 真实 renderer 在 segment-1 的最后一条视觉行退出后先本地墓碑，再把
     身份水位闭合给 canonical fold；权威 SQLite 字幕事实不受影响。 */
  assert.equal(evictCaptionPrefix(rendered, 'segment-1'), true)
  assert.equal(coordinator.acceptCaptionViewportEviction({
    schemaVersion: 1,
    sessionId,
    throughSegmentId: 'segment-1'
  }), true)
  adapter.emitCaption(event(sessionId, ++sequence, 11, 'partial', '当前仍在实时识别'))
  const partialBefore = structuredClone(rendered.segments.at(-1))
  assert.ok(rendered.segments.some((segment) => segment.text === '精修字幕 6'))

  assert.equal(adapter.emitRefinementFault({
    code: 'REFINE_DECODE_FAILED',
    stage: 'decode',
    faultAtMs: 640
  }), true)
  await logTask

  assert.equal(coordinator.getSnapshot().phase, 'listening')
  assert.deepEqual(rendered.segments.at(-1), partialBefore)
  assert.equal(rendered.segments.some((segment) => segment.text.startsWith('精修字幕')), false)
  assert.equal(rendered.segments.some((segment) => segment.segmentId === 'segment-1'), false,
    'an evicted segment is never revived by fallback')
  assert.equal(rendered.segments.find((segment) => segment.segmentId === 'segment-6').text, '原始字幕 6')

  adapter.emitCaption(event(sessionId, ++sequence, 10, 'refined', '故障后的迟到精修', 2))
  assert.equal(rendered.segments.some((segment) => segment.text === '故障后的迟到精修'), false)

  now += 10_000
  assert.equal((await coordinator.command('stop')).ok, true)
  await coordinator.dispose()

  const history = new HistoryService({
    gateway,
    showSaveDialog: async () => ({ canceled: true })
  })
  const page = await history.getSessionPage({ sessionId, limit: 50, cursor: null })
  assert.deepEqual(page.refinement, {
    segmentCount: 10,
    refinedSegmentCount: 6,
    refinementResultStatus: 'known',
    refinementEnabled: true,
    refinementFaultCode: 'REFINE_DECODE_FAILED'
  })

  const notice = new RefinementNoticeStore()
  assert.equal(notice.get(), null, 'no running-session notice is shown')
  notice.setFromResult(sessionId, page.refinement)
  assert.equal(notice.get().message, '精修异常，已精修 6/10 段，其余保留原字幕')
  await logger.close()

  const logFiles = fs.readdirSync(logDirectory)
  assert.equal(logFiles.length, 1)
  const logText = fs.readFileSync(path.join(logDirectory, logFiles[0]), 'utf8')
  assert.deepEqual(JSON.parse(logText.trim()), {
    schemaVersion: 1,
    type: 'refinement-fault',
    code: 'REFINE_DECODE_FAILED',
    stage: 'decode',
    faultAtMs: 640,
    count: 1
  })
  assert.doesNotMatch(logText, /原始字幕|精修字幕|当前仍在|sessionId|stack|audio|path/i)
  await gateway.shutdown()

  const restartedGateway = createGateway(databasePath)
  const restartedHistory = new HistoryService({
    gateway: restartedGateway,
    showSaveDialog: async () => ({ canceled: true })
  })
  const restarted = await restartedHistory.getSessionPage({ sessionId, limit: 50, cursor: null })
  assert.deepEqual(restarted.refinement, page.refinement)
  assert.equal(new RefinementNoticeStore().get(), null, 'application restart does not replay the toolbar notice')
  await restartedGateway.shutdown()
  assert.deepEqual(audioArtifacts(root), [])
})
