'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { createState, applyEvent, hydrateState, selectLines } = require('../../src/ui/shared/caption-reducer')
const { resolveRuntimeOptions, DEV_MODEL_VALUE } = require('../../src/main/runtime-options')
const { SessionTranscriptRecorder } = require('../../src/main/services/session-transcript-recorder')
const {
  TranscriptStore,
  exportMarkdown,
  exportSrt,
  exportText,
  foldSegments,
  readSessionFile
} = require('../../src/main/services/transcript-store')
const { FakeRuntimeAdapter } = require('../../src/main/session/fake-runtime-adapter')
const { SessionCoordinator } = require('../../src/main/session/session-coordinator')
const { ConfigStore } = require('../../src/main/services/config-store')
const { RealtimeRuntimeAdapter } = require('../../src/runtime/realtime-runtime-adapter')

const DEV_RUNTIME = resolveRuntimeOptions({ LIVE_SUBTITLE_DEV_MODEL: DEV_MODEL_VALUE })

function tempDirectory (t, scenario) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `caption-journey-${scenario}-`))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
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

async function runCaptionJourney (t, scenario) {
  const directory = tempDirectory(t, scenario.id)
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  const coordinator = new SessionCoordinator({
    adapter,
    runtimeOptions: DEV_RUNTIME,
    configuration: scenario.configuration,
    idFactory: () => `ci-${scenario.id}-session`
  })
  const store = new TranscriptStore({
    directory,
    now: () => new Date(2026, 6, 30, 10, 0, 0)
  })
  const recorder = new SessionTranscriptRecorder({ coordinator, store })
  const liveRendererState = createState()
  const delivered = []
  const unsubscribeRenderer = coordinator.onCaption((event) => {
    delivered.push(event)
    applyEvent(liveRendererState, event)
  })

  t.after(async () => {
    unsubscribeRenderer()
    recorder.dispose()
    store.dispose()
    await coordinator.dispose()
  })

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
  assert.deepEqual(selectLines(reloadedRendererState, { bilingual: true }), {
    previous: '',
    current: scenario.refined,
    isPartial: false,
    translation: scenario.translation
  })

  assert.equal((await coordinator.command('stop')).ok, true)
  const files = fs.readdirSync(directory).filter((name) => name.endsWith('.jsonl'))
  assert.equal(files.length, 1)
  const report = readSessionFile(path.join(directory, files[0]))
  assert.equal(report.corruptLineCount, 0)
  assert.equal(report.truncatedTail, false)
  assert.deepEqual(report.events.map((event) => event.event), [
    'session.open',
    'segment.final',
    'segment.refined',
    'segment.translated',
    'session.close'
  ], 'partial 只用于实时 UI，不能进入会话档案')

  const durableSegments = foldSegments(report.events)
  assert.equal(durableSegments.length, 1)
  assert.equal(durableSegments[0].sourceId, scenario.sourceId)
  assert.equal(durableSegments[0].text, scenario.refined)
  assert.equal(durableSegments[0].translation.text, scenario.translation)
  assert.equal(exportText(durableSegments), `${scenario.refined}\n`)
  assert.ok(exportMarkdown(durableSegments, { title: scenario.id }).includes(scenario.translation))
  assert.ok(exportSrt(durableSegments).includes(scenario.refined))
  assert.deepEqual(audioFilesUnder(directory), [], '字幕、历史和导出旅程不得生成现场音频文件')
}

const scenarios = [
  {
    id: 'meeting-loopback',
    sourceId: 'loopback',
    configuration: { onboardingCompleted: true, onboardingPreset: 'meeting', mic: false, loopback: true },
    partial: '系统音频正在转写',
    final: '系统音频已经完成转写',
    refined: '系统音频已经完成转写。',
    translation: 'System audio transcription is complete.'
  },
  {
    id: 'dictation-microphone',
    sourceId: 'mic',
    configuration: { onboardingCompleted: true, onboardingPreset: 'dictation', mic: true, loopback: false },
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
  const directory = tempDirectory(t, 'xor-source-switch')
  const configStore = new ConfigStore(path.join(directory, 'config.json'))
  configStore.load()
  configStore.applyPreset('meeting')

  const sessionIds = ['ci-xor-loopback', 'ci-xor-mic']
  const runtimeBoundary = simulatedElectronRuntime()
  const adapter = new RealtimeRuntimeAdapter({ electron: runtimeBoundary.electron })
  const coordinator = new SessionCoordinator({
    adapter,
    runtimeOptions: DEV_RUNTIME,
    configuration: configStore.get(),
    idFactory: () => sessionIds.shift()
  })
  const transcriptStore = new TranscriptStore({ directory })
  const recorder = new SessionTranscriptRecorder({ coordinator, store: transcriptStore })
  t.after(async () => {
    recorder.dispose()
    transcriptStore.dispose()
    await coordinator.dispose()
  })

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

  const reports = fs.readdirSync(directory)
    .filter((name) => name.endsWith('.jsonl'))
    .map((name) => readSessionFile(path.join(directory, name)))
  assert.equal(reports.length, 2)
  const segments = reports.flatMap((report) => {
    const sessionId = report.events.find((event) => event.event === 'session.open')?.sessionId
    return foldSegments(report.events).map((segment) => ({ ...segment, sessionId }))
  })
  assert.deepEqual(
    segments.map((segment) => [segment.sessionId, segment.sourceId, segment.text]).sort(),
    [
      [loopbackSessionId, 'loopback', '会议会话只属于系统音频。'],
      [micSessionId, 'mic', '听写会话只属于麦克风。']
    ].sort()
  )
  assert.deepEqual(audioFilesUnder(directory), [], '配置切换和两次持久化后仍不得出现音频文件')
})

test('CI journey J5/J6/J12: pause-refine and worker recovery preserve one durable session', async (t) => {
  const directory = tempDirectory(t, 'pause-fault-recovery')
  const runtimeBoundary = simulatedElectronRuntime()
  const adapters = []
  const coordinator = new SessionCoordinator({
    adapterFactory: () => {
      const adapter = new RealtimeRuntimeAdapter({ electron: runtimeBoundary.electron })
      adapters.push(adapter)
      return adapter
    },
    runtimeOptions: DEV_RUNTIME,
    configuration: { onboardingCompleted: true, onboardingPreset: 'meeting', mic: false, loopback: true },
    idFactory: () => 'ci-pause-fault-session'
  })
  const transcriptStore = new TranscriptStore({ directory })
  const recorder = new SessionTranscriptRecorder({ coordinator, store: transcriptStore })
  t.after(async () => {
    recorder.dispose()
    transcriptStore.dispose()
    await coordinator.dispose()
  })

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

  const files = fs.readdirSync(directory).filter((name) => name.endsWith('.jsonl'))
  assert.equal(files.length, 1, 'pause/retry must not split one session into multiple archives')
  const report = readSessionFile(path.join(directory, files[0]))
  assert.equal(report.corruptLineCount, 0)
  assert.equal(report.truncatedTail, false)
  const segments = foldSegments(report.events)
  assert.deepEqual(segments.map((segment) => [segment.segmentId, segment.text]), [
    ['segment-before-pause', '暂停前的一遍定稿。'],
    ['segment-after-recovery', '恢复后的字幕继续保存。']
  ])
  assert.equal(report.events.filter((event) => event.event === 'session.open').length, 1)
  assert.equal(report.events.filter((event) => event.event === 'session.close').length, 1)
  assert.deepEqual(audioFilesUnder(directory), [], 'pause/recovery diagnostics and history must remain text-only')
})
