'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createState, applyEvent, hydrateState, selectFlow } = require('../../src/ui/shared/caption-reducer')
const { resolveRuntimeOptions, DEV_MODEL_VALUE } = require('../../src/main/runtime-options')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { FakeRuntimeAdapter } = require('../../src/main/session/fake-runtime-adapter')
const { SessionCoordinator } = require('../../src/main/session/session-coordinator')
const { ConfigStore } = require('../../src/main/services/config-store')
const { RealtimeRuntimeAdapter } = require('../../src/runtime/realtime-runtime-adapter')
const { AudioHostController } = require('../../src/runtime/audio-host/audio-host-controller')
const { RealtimeWorkerHost, sanitizeCaptionTiming } = require('../../src/runtime/realtime-worker/worker-host')
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
const DEV_RUNTIME_WITH_REFINEMENT = Object.freeze({ ...DEV_RUNTIME, refinementAvailable: true })

function tempDirectory (scenario) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `caption-journey-${scenario}-`))
}

function audioFilesUnder (directory) {
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

/* The production gateway still crosses the storage-worker protocol here. Only
   Electron's utility-process boundary is substituted so the J1/J2/J4/J5/J6
   journeys can deterministically use a temporary SQLite database. */
function serviceBackedHost (service, databasePath) {
  let sequence = 0
  let started = false

  function call (operation, payload, idempotencyKey) {
    const response = service.handle({
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId: `caption-journey-${++sequence}`,
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
    async getSessionPage (input) {
      return call(OPERATIONS.GET_SESSION_PAGE, input)
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

function createGateway (directory) {
  const databasePath = path.join(directory, 'data', 'speech-agent.sqlite3')
  const service = new StorageWorkerService({
    storeFactory: (options) => new SqliteSubtitleStore(options)
  })
  const gateway = new StorageGateway({
    databasePath,
    hostFactory: () => serviceBackedHost(service, databasePath),
    maxRestarts: 0
  })
  return { gateway, databasePath }
}

/* Production runtime composition with only the non-deterministic Electron,
   utility-process and physical-device boundary simulated. The real
   RealtimeRuntimeAdapter, RealtimeWorkerHost and AudioHostController are
   constructed by the test. */
function simulatedElectronRuntime () {
  const children = []
  const captureStarts = []
  const captureStops = []
  const pcmTransfers = []
  let portSequence = 0

  function MessageChannelMain () {
    portSequence += 1
    this.port1 = { id: `pcm-host-${portSequence}`, postMessage () {} }
    this.port2 = { id: `pcm-worker-${portSequence}`, postMessage () {} }
  }

  const electron = {
    MessageChannelMain,
    utilityProcess: {
      fork (workerPath) {
        const child = new EventEmitter()
        child.workerPath = workerPath
        child.messages = []
        child.killed = false
        /* Test-only utility IPC ingress. This deliberately enters through the
           production child.on('message') listener installed by
           RealtimeWorkerHost; it is not an adapter/coordinator caption fake. */
        child.emitUtilityMessage = (message) => child.emit('message', message)
        child.postMessage = (message, ports = []) => {
          child.messages.push({ message, ports })
          if (message?.type === 'configure') {
            child.configuration = message
            setImmediate(() => child.emit('message', { type: 'configured' }))
          } else if (message?.type === 'pause') {
            setImmediate(() => child.emit('message', { type: 'paused' }))
          } else if (message?.type === 'resume') {
            setImmediate(() => child.emit('message', { type: 'resumed' }))
          } else if (message?.type === 'report') {
            setImmediate(() => child.emit('message', {
              type: 'stats',
              stats: { endReceived: false, badSampleTypeFrames: 0, sources: {} }
            }))
          } else if (message?.type === 'shutdown') {
            /* Match the real utility worker protocol: stopped is diagnostic,
               while the exact exit event is the lifecycle completion barrier. */
            setImmediate(() => {
              child.emit('message', { type: 'stopped' })
              child.emit('exit', 0)
            })
          }
        }
        child.kill = () => {
          if (child.killed) return
          child.killed = true
          setImmediate(() => child.emit('exit', 0))
        }
        children.push(child)
        return child
      }
    },
    ipcMain: {
      handle () {},
      on () {},
      removeHandler () {},
      removeListener () {}
    },
    session: {
      fromPartition: () => ({
        setPermissionCheckHandler () {},
        setPermissionRequestHandler () {},
        setDisplayMediaRequestHandler () {}
      })
    },
    desktopCapturer: { getSources: async () => [] },
    screen: { getPrimaryDisplay: () => ({ id: 1 }) },
    BrowserWindow: function () {
      const win = Object.assign(new EventEmitter(), {
        destroyed: false,
        webContents: {
          mainFrame: 'main',
          setWindowOpenHandler () {},
          on () {},
          postMessage (channel, payload, ports) {
            pcmTransfers.push({ channel, payload, ports })
          },
          async executeJavaScript (script) {
            const startPrefix = 'globalThis.startAudioCapture('
            if (script.startsWith(startPrefix)) {
              const invocation = JSON.parse(script.slice(startPrefix.length, -1))
              captureStarts.push(invocation)
              return { started: true }
            }
            if (script === 'globalThis.stopAudioCapture()') {
              const sessionId = captureStarts.at(-1)?.sessionId || null
              captureStops.push(sessionId)
              const child = children.at(-1)
              if (child) child.emit('message', { type: 'stats', stats: { endReceived: true } })
              return { stopped: true, metrics: {} }
            }
            throw new Error(`unexpected audio-host script: ${script}`)
          }
        },
        async loadFile () {},
        isVisible: () => false,
        isDestroyed: () => win.destroyed,
        destroy: () => { win.destroyed = true }
      })
      return win
    }
  }

  return { electron, children, captureStarts, captureStops, pcmTransfers }
}

function caption (sessionId, sourceId, overrides) {
  return {
    schemaVersion: 1,
    sessionId,
    sourceId,
    segmentId: `segment-${sourceId}-1`,
    sequence: 1,
    revision: 1,
    kind: 'partial',
    t0: 0.4,
    t1: 2.8,
    text: '正在识别',
    translation: null,
    ...overrides
  }
}

function captionTiming (event, base) {
  return {
    schemaVersion: 2,
    sourceId: event.sourceId,
    segmentId: event.segmentId,
    sequence: event.sequence,
    audioHostClockId: 'audio-host-performance-v1',
    vadStartAudioTimestampMs: base,
    vadStartFrameAudioHostClockMs: base + 10,
    partialTriggerAudioEndMs: base + 300,
    partialTriggerFrameAudioHostClockMs: base + 310,
    utilityClockId: 'realtime-utility-performance-v1',
    partialTriggerUtilityIngressClockMs: base + 320,
    partialPublishUtilityClockMs: base + 340
  }
}

async function runCaptionJourney (t, scenario) {
  const directory = tempDirectory(scenario.id)
  const { gateway } = createGateway(directory)
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  let clock = 1785396000000
  const recorder = new SqliteSessionRecorder({ gateway, now: () => clock++ })
  const coordinator = new SessionCoordinator({
    adapter,
    persistenceSink: recorder,
    runtimeOptions: DEV_RUNTIME_WITH_REFINEMENT,
    configuration: scenario.configuration,
    idFactory: () => `ci-${scenario.id}-session`
  })
  const liveRendererState = createState()
  const delivered = []
  const unsubscribeRenderer = coordinator.onCaption((event) => {
    delivered.push(event)
    applyEvent(liveRendererState, event)
  })

  t.after(async () => {
    unsubscribeRenderer()
    await coordinator.dispose().catch(() => {})
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await gateway.start()
  assert.equal((await coordinator.command('start')).ok, true)
  const sessionId = coordinator.getSnapshot().sessionId
  assert.equal(sessionId, `ci-${scenario.id}-session`)
  assert.deepEqual(
    coordinator.getSnapshot().sources.filter((source) => source.state !== 'unavailable').map((source) => source.id),
    [scenario.sourceId]
  )

  adapter.emitCaption(caption(sessionId, scenario.sourceId, {
    sequence: 1,
    revision: 1,
    kind: 'partial',
    text: scenario.partial
  }))
  adapter.emitCaption(caption(sessionId, scenario.sourceId, {
    sequence: 2,
    revision: 2,
    kind: 'final',
    text: scenario.final
  }))
  adapter.emitCaption(caption(sessionId, scenario.sourceId, {
    sequence: 3,
    revision: 3,
    kind: 'refined',
    text: scenario.refined
  }))
  adapter.emitCaption(caption(sessionId, scenario.sourceId, {
    sequence: 4,
    revision: 4,
    kind: 'translated',
    text: scenario.refined,
    translation: {
      language: 'en',
      text: scenario.translation,
      basedOnRevision: 3
    }
  }))

  assert.deepEqual(delivered.map((event) => event.kind), ['partial', 'final', 'refined', 'translated'])
  const canonical = coordinator.getCaptionState()
  const reloadedRendererState = hydrateState(canonical)
  assert.deepEqual(reloadedRendererState, liveRendererState, 'reload 后字幕视图必须与实时视图一致')
  const reloadedFlow = selectFlow(reloadedRendererState)
  assert.equal(reloadedFlow.length, 1, '同一段的多次修订不得在字幕流里叠成多行')
  assert.deepEqual(reloadedFlow.at(-1), {
    segmentId: reloadedRendererState.segments.at(-1).segmentId,
    text: scenario.refined,
    isPartial: false
  })

  assert.equal((await coordinator.command('stop')).ok, true)
  await gateway.flush()
  const durable = await gateway.getSessionTranscript(sessionId)
  assert.deepEqual(durable.session, {
    sessionId,
    mode: scenario.sourceId === 'mic' ? 'dictation' : 'meeting',
    sourceId: scenario.sourceId,
    startedAt: 1785396000000,
    endedAt: 1785396000001,
    state: 'closed'
  })
  /* 版本隔离（SEM-F04）：默认正文恒为首次 `final` 的原始转写，精修稿独立保存。
     精修覆盖原文的旧语义已由 ADR 0004 作废。 */
  assert.deepEqual(durable.segments.map((segment) => ({
    segmentId: segment.segmentId,
    sourceId: segment.sourceId,
    text: segment.text,
    refinedText: segment.refinedText,
    textRevision: segment.textRevision,
    t0Ms: segment.t0Ms,
    t1Ms: segment.t1Ms
  })), [{
    segmentId: `segment-${scenario.sourceId}-1`,
    sourceId: scenario.sourceId,
    text: scenario.final,
    refinedText: scenario.refined,
    textRevision: 2,
    t0Ms: 400,
    t1Ms: 2800
  }], 'partial and translated events must not enter the SQLite subtitle facts')
  assert.deepEqual(audioFilesUnder(directory), [], '字幕、历史和导出旅程不得生成现场音频文件')
}

const scenarios = [
  {
    id: 'meeting-loopback',
    sourceId: 'loopback',
    configuration: {
      onboardingCompleted: true,
      onboardingPreset: 'meeting',
      mic: false,
      loopback: true,
      refinementEnabled: true
    },
    partial: '系统音频正在转写',
    final: '系统音频已经完成转写',
    refined: '系统音频已经完成转写。',
    translation: 'System audio transcription is complete.'
  },
  {
    id: 'dictation-microphone',
    sourceId: 'mic',
    configuration: {
      onboardingCompleted: true,
      onboardingPreset: 'dictation',
      mic: true,
      loopback: false,
      refinementEnabled: true
    },
    partial: '麦克风正在听写',
    final: '麦克风已经完成听写',
    refined: '麦克风已经完成听写。',
    translation: 'Microphone dictation is complete.'
  }
]

for (const scenario of scenarios) {
  test(`CI journey: ${scenario.id} keeps caption UI and durable session in sync`, async (t) => {
    await runCaptionJourney(t, scenario)
  })
}

test('CI journey J4/J12: source switch requires stop, creates a new isolated text-only session', async (t) => {
  const directory = tempDirectory('xor-source-switch')
  const { gateway } = createGateway(directory)
  const configStore = new ConfigStore(path.join(directory, 'config.json'))
  configStore.load()
  configStore.applyPreset('meeting')

  const sessionIds = ['ci-xor-loopback', 'ci-xor-mic']
  const runtimeBoundary = simulatedElectronRuntime()
  const adapter = new RealtimeRuntimeAdapter({ electron: runtimeBoundary.electron })
  const coordinator = new SessionCoordinator({
    adapter,
    persistenceSink: new SqliteSessionRecorder({ gateway, now: () => 1785396100000 }),
    runtimeOptions: DEV_RUNTIME,
    configuration: configStore.get(),
    idFactory: () => sessionIds.shift()
  })
  t.after(async () => {
    await coordinator.dispose().catch(() => {})
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await gateway.start()

  assert.throws(
    () => configStore.update({ mic: true }),
    /exactly one/,
    '持久化配置不能形成 mic + loopback'
  )

  assert.equal((await coordinator.command('start')).ok, true)
  const loopbackSessionId = coordinator.getSnapshot().sessionId
  assert.deepEqual(runtimeBoundary.children[0].configuration.sourceIds, ['loopback'])
  assert.deepEqual(runtimeBoundary.captureStarts[0].sourceIds, ['loopback'])
  assert.equal(runtimeBoundary.captureStarts[0].sessionId, loopbackSessionId)
  assert.throws(
    () => coordinator.updateConfiguration({
      onboardingCompleted: true,
      onboardingPreset: 'dictation',
      mic: true,
      loopback: false
    }),
    /active session/,
    '活动会话不能直接换源'
  )
  runtimeBoundary.children[0].emit('message', { type: 'caption', event: caption(loopbackSessionId, 'loopback', {
    kind: 'final',
    text: '会议会话只属于系统音频。'
  }) })
  assert.equal((await coordinator.command('stop')).ok, true)

  configStore.applyPreset('dictation')
  coordinator.updateConfiguration(configStore.get())
  assert.equal((await coordinator.command('start')).ok, true)
  const micSessionId = coordinator.getSnapshot().sessionId
  assert.notEqual(micSessionId, loopbackSessionId)
  assert.deepEqual(runtimeBoundary.children[1].configuration.sourceIds, ['mic'])
  assert.deepEqual(runtimeBoundary.captureStarts[1].sourceIds, ['mic'])
  assert.equal(runtimeBoundary.captureStarts[1].sessionId, micSessionId)
  runtimeBoundary.children[1].emit('message', { type: 'caption', event: caption(micSessionId, 'mic', {
    kind: 'final',
    text: '听写会话只属于麦克风。'
  }) })
  assert.equal((await coordinator.command('stop')).ok, true)

  assert.deepEqual(runtimeBoundary.captureStops, [loopbackSessionId, micSessionId])
  assert.equal(runtimeBoundary.pcmTransfers.length, 2, '每个会话都必须把独立 PCM port 交给 audio host')
  assert.deepEqual(
    runtimeBoundary.children.map((child) => child.messages.some(({ message }) => message?.type === 'pcm-port')),
    [true, true],
    '每个会话都必须把 PCM port 交给 realtime worker'
  )

  await gateway.flush()
  const transcripts = await Promise.all([loopbackSessionId, micSessionId]
    .map((id) => gateway.getSessionTranscript(id)))
  const segments = transcripts.flatMap((transcript) => transcript.segments.map((segment) => ({
    sessionId: transcript.session.sessionId,
    sourceId: segment.sourceId,
    text: segment.text
  })))
  assert.deepEqual(
    segments.map((segment) => [segment.sessionId, segment.sourceId, segment.text]).sort(),
    [
      [loopbackSessionId, 'loopback', '会议会话只属于系统音频。'],
      [micSessionId, 'mic', '听写会话只属于麦克风。']
    ].sort()
  )
  assert.deepEqual(audioFilesUnder(directory), [], '配置切换和两次持久化后仍不得出现音频文件')
})

test('CI journey I2: production runtime composition retains timing only for the Coordinator-accepted partial', async (t) => {
  const runtimeBoundary = simulatedElectronRuntime()
  const adapter = new RealtimeRuntimeAdapter({ electron: runtimeBoundary.electron })
  const coordinator = new SessionCoordinator({
    adapter,
    runtimeOptions: DEV_RUNTIME,
    configuration: {
      onboardingCompleted: true,
      onboardingPreset: 'meeting',
      mic: false,
      loopback: true
    },
    idFactory: () => 'ci-timing-session'
  })
  const observed = []
  const unsubscribe = coordinator.onCaption((event) => observed.push(event))
  t.after(async () => {
    unsubscribe()
    await coordinator.dispose()
  })

  assert.equal((await coordinator.command('start')).ok, true)
  const sessionId = coordinator.getSnapshot().sessionId
  const child = runtimeBoundary.children[0]

  /* The simulated boundary is intentionally limited to Electron's renderer,
     physical capture and native inference. The controllers, MessagePort
     composition, utility message validation/dispatch, adapter and Coordinator
     acceptance path below are all production implementations. Real
     PCM -> native ASR remains covered by the tracked machine evidence. */
  assert.ok(adapter.session.host instanceof AudioHostController)
  assert.ok(adapter.session.worker instanceof RealtimeWorkerHost)
  assert.deepEqual(child.configuration.sourceIds, ['loopback'])
  assert.deepEqual(runtimeBoundary.captureStarts, [{
    sessionId,
    sourceIds: ['loopback'],
    maxQueueMs: 2000,
    micLabelSha256: null
  }])
  assert.equal(runtimeBoundary.pcmTransfers.length, 1)
  assert.equal(runtimeBoundary.pcmTransfers[0].payload.sessionId, sessionId)
  assert.deepEqual(runtimeBoundary.pcmTransfers[0].ports.map((port) => port.id), ['pcm-host-1'])
  const workerPcmTransfer = child.messages.find(({ message }) => message?.type === 'pcm-port')
  assert.ok(workerPcmTransfer, 'RealtimeWorkerHost must transfer the other MessagePort endpoint')
  assert.deepEqual(workerPcmTransfer.ports.map((port) => port.id), ['pcm-worker-1'])

  const rejected = caption('ci-other-session', 'loopback', {
    segmentId: 'segment-rejected-by-coordinator',
    sequence: 1,
    revision: 1,
    kind: 'partial',
    text: 'private rejected caption text'
  })
  const accepted = caption(sessionId, 'loopback', {
    segmentId: 'segment-accepted-by-coordinator',
    sequence: 1,
    revision: 1,
    kind: 'partial',
    text: 'private accepted caption text'
  })
  const rejectedTiming = captionTiming(rejected, 1000)
  const acceptedTiming = captionTiming(accepted, 3000)
  assert.ok(sanitizeCaptionTiming(rejectedTiming, rejected, 2000),
    'the first timing payload must be contract-valid before Coordinator rejects its session')
  assert.ok(sanitizeCaptionTiming(acceptedTiming, accepted, 4000),
    'the accepted timing payload must pass the same utility boundary contract')
  const privateEnvelopeFields = {
    deviceName: 'Private USB Headset',
    localPath: 'C:\\private-audio-file.wav',
    pcm: new Float32Array([0.1234567, -0.7654321])
  }

  child.emitUtilityMessage({
    type: 'caption',
    event: rejected,
    timing: rejectedTiming,
    ...privateEnvelopeFields
  })
  assert.deepEqual(observed, [], 'contract-valid captions can still be rejected by Coordinator session semantics')
  assert.equal(adapter.session.acceptedCaptionTimings.length, 0)
  assert.equal(adapter.session.worker.captionTimings.size, 0,
    'timing for a Coordinator-rejected caption must be consumed instead of leaking into a later key reuse')

  child.emitUtilityMessage({
    type: 'caption',
    event: accepted,
    timing: acceptedTiming,
    ...privateEnvelopeFields
  })
  assert.deepEqual(observed, [accepted])
  assert.equal((await coordinator.command('stop')).ok, true)

  const diagnostics = adapter.getLastRunDiagnostics()
  assert.equal(diagnostics.droppedCaptionCount, 0, 'both partial events were valid at the utility contract boundary')
  assert.deepEqual(Object.keys(diagnostics.workerHost), ['acceptedCaptionTimings'],
    'diagnostics must expose no pre-Coordinator caption-arrival side channel')
  assert.equal(diagnostics.workerHost.acceptedCaptionTimings.length, 1)
  const recorded = diagnostics.workerHost.acceptedCaptionTimings[0]
  const {
    workerHostMainClockMs,
    coordinatorAcceptedReturnMainClockMs,
    ...stableTiming
  } = recorded
  assert.ok(Number.isFinite(workerHostMainClockMs))
  assert.ok(Number.isFinite(coordinatorAcceptedReturnMainClockMs))
  assert.deepEqual(stableTiming, {
    ...acceptedTiming,
    mainClockId: 'electron-main-performance-v1'
  }, 'diagnostics must retain the exact accepted source/segment/sequence timing and no rejected timing')

  const serializedDiagnostics = JSON.stringify(diagnostics)
  for (const forbiddenValue of [
    rejected.text,
    accepted.text,
    'Private USB Headset',
    'private-audio-file.wav'
  ]) {
    assert.equal(serializedDiagnostics.includes(forbiddenValue), false,
      `diagnostics must not retain private value: ${forbiddenValue}`)
  }
  assert.doesNotMatch(serializedDiagnostics, /"(?:pcm|samples|deviceName|devicePath|localPath)"\s*:/i,
    'diagnostics must not retain PCM, device-name or local-path fields from the utility envelope')
})

test('CI journey J5/J6/J12: pause-refine and worker recovery preserve one durable session', async (t) => {
  const directory = tempDirectory('pause-fault-recovery')
  const { gateway } = createGateway(directory)
  const runtimeBoundary = simulatedElectronRuntime()
  const adapters = []
  const coordinator = new SessionCoordinator({
    adapterFactory: () => {
      const adapter = new RealtimeRuntimeAdapter({ electron: runtimeBoundary.electron })
      adapters.push(adapter)
      return adapter
    },
    runtimeOptions: DEV_RUNTIME_WITH_REFINEMENT,
    persistenceSink: new SqliteSessionRecorder({ gateway, now: () => 1785396200000 }),
    configuration: {
      onboardingCompleted: true,
      onboardingPreset: 'meeting',
      mic: false,
      loopback: true,
      refinementEnabled: true
    },
    idFactory: () => 'ci-pause-fault-session'
  })
  t.after(async () => {
    await coordinator.dispose().catch(() => {})
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await gateway.start()
  assert.equal((await coordinator.command('start')).ok, true)
  const sessionId = coordinator.getSnapshot().sessionId
  const firstChild = runtimeBoundary.children[0]
  firstChild.emit('message', { type: 'caption', event: caption(sessionId, 'loopback', {
    segmentId: 'segment-before-pause',
    sequence: 1,
    revision: 1,
    kind: 'final',
    text: '暂停前的一遍定稿'
  }) })

  assert.equal((await coordinator.command('pause')).ok, true)
  assert.equal(coordinator.getSnapshot().phase, 'paused')
  assert.equal(coordinator.getSnapshot().sessionId, sessionId, 'pause must retain the session')
  assert.equal((await coordinator.command('resume')).ok, true)
  firstChild.emit('message', { type: 'caption', event: caption(sessionId, 'loopback', {
    segmentId: 'segment-before-pause',
    sequence: 2,
    revision: 2,
    kind: 'refined',
    text: '暂停前的一遍定稿。'
  }) })

  firstChild.emit('exit', 13)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(coordinator.getSnapshot().phase, 'error')
  assert.equal(coordinator.getSnapshot().lastError.code, 'REALTIME_WORKER_EXITED')
  assert.equal(coordinator.getSnapshot().sessionId, sessionId, 'worker fault must retain the session')
  assert.deepEqual(runtimeBoundary.captureStops, [sessionId], 'fault must stop hidden capture without waiting for retry')

  assert.equal((await coordinator.command('retry')).ok, true)
  assert.equal(coordinator.getSnapshot().phase, 'listening')
  assert.equal(coordinator.getSnapshot().sessionId, sessionId, 'retry must not create a second session')
  const replacementChild = runtimeBoundary.children[1]
  assert.equal(replacementChild.configuration.attempt, 0, 'same adapter retry keeps its epoch and resumes by sequence cursor')
  assert.deepEqual(replacementChild.configuration.sequenceBases, { loopback: 2 })
  replacementChild.emit('message', { type: 'caption', event: caption(sessionId, 'loopback', {
    segmentId: 'segment-after-recovery',
    sequence: 3,
    revision: 1,
    kind: 'final',
    text: '恢复后的字幕继续保存。'
  }) })

  assert.equal((await coordinator.command('stop')).ok, true)
  assert.equal(adapters.length, 1, 'recoverable worker faults reuse the adapter while replacing its worker/host session')
  assert.equal(runtimeBoundary.children.length, 2, 'fault recovery must fork a fresh realtime worker')
  assert.equal(runtimeBoundary.captureStops.length, 2, 'final stop closes only the replacement capture')
  assert.deepEqual(adapters[0].getLastRunDiagnostics().sourceIds, ['loopback'])

  await gateway.flush()
  const durable = await gateway.getSessionTranscript(sessionId)
  assert.equal(durable.session.state, 'closed')
  assert.deepEqual(durable.segments.map((segment) => [segment.segmentId, segment.text]), [
    /* 默认正文是首次 final；暂停期间到达的精修稿不覆盖它（SEM-F04）。 */
    ['segment-before-pause', '暂停前的一遍定稿'],
    ['segment-after-recovery', '恢复后的字幕继续保存。']
  ])
  assert.deepEqual(audioFilesUnder(directory), [], 'pause/recovery diagnostics and history must remain text-only')
})
