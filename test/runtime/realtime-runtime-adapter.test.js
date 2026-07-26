'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { RealtimeRuntimeAdapter } = require('../../src/runtime/realtime-runtime-adapter')
const { FakeRuntimeAdapter } = require('../../src/main/session/fake-runtime-adapter')
const { SessionCoordinator } = require('../../src/main/session/session-coordinator')
const { DEV_MODEL_VALUE, resolveRuntimeOptions } = require('../../src/main/runtime-options')

const DEV_MODEL = resolveRuntimeOptions({ LIVE_SUBTITLE_DEV_MODEL: DEV_MODEL_VALUE })
const DICTATION = { onboardingCompleted: true, onboardingPreset: 'dictation', mic: true, loopback: false }

function fakeWorker () {
  const worker = {
    calls: [],
    captionListeners: new Set(),
    exitListeners: new Set(),
    disposed: false,
    exited: null,
    async start (config) { worker.calls.push(['start', config]) },
    attachPort (port) { worker.calls.push(['attachPort', port]) },
    attachRefinePort (port) { worker.calls.push(['attachRefinePort', port]) },
    async pause () { worker.calls.push(['pause']) },
    async resume () { worker.calls.push(['resume']) },
    async waitForEnd () { worker.calls.push(['waitForEnd']); return true },
    onCaption (listener) { worker.captionListeners.add(listener); return () => worker.captionListeners.delete(listener) },
    onStats () { return () => {} },
    onExit (listener) { worker.exitListeners.add(listener); return () => worker.exitListeners.delete(listener) },
    emitCaption (event) { for (const listener of worker.captionListeners) listener(event) },
    emitExit (code) { for (const listener of worker.exitListeners) listener({ code }) },
    dispose () { worker.disposed = true }
  }
  return worker
}

function fakeHost () {
  const host = {
    calls: [],
    controlListeners: new Set(),
    disposed: false,
    async startCapture (options) { host.calls.push(['startCapture', options]) },
    async stopCapture () { host.calls.push(['stopCapture']); return { stopped: true, metrics: {} } },
    onControl (listener) { host.controlListeners.add(listener); return () => host.controlListeners.delete(listener) },
    emitControl (message) { for (const listener of host.controlListeners) listener(message) },
    dispose () { host.disposed = true }
  }
  return host
}

function fakeRefineWorker () {
  const refine = {
    calls: [],
    exitListeners: new Set(),
    disposed: false,
    failStart: false,
    async start (config) {
      refine.calls.push(['start', config])
      if (refine.failStart) throw new Error('refine model load failed')
    },
    attachPort (port) { refine.calls.push(['attachPort', port]) },
    onExit (listener) { refine.exitListeners.add(listener); return () => refine.exitListeners.delete(listener) },
    emitExit (code) { for (const listener of refine.exitListeners) listener({ code }) },
    dispose () { refine.disposed = true }
  }
  return refine
}

function makeAdapterWith (extraOptions = {}) {
  const worker = fakeWorker()
  const host = fakeHost()
  const refineWorker = fakeRefineWorker()
  const degraded = []
  const adapter = new RealtimeRuntimeAdapter({
    electron: { MessageChannelMain: function () { this.port1 = { id: 'p1' }; this.port2 = { id: 'p2' } } },
    workerFactory: () => worker,
    hostFactory: () => host,
    refineWorkerFactory: () => refineWorker,
    onDegraded: (message) => degraded.push(message),
    ...extraOptions
  })
  return { adapter, worker, host, refineWorker, degraded }
}

function makeAdapter () {
  return makeAdapterWith()
}

const START_CONTEXT = {
  sessionId: 'session-1',
  sourceIds: ['mic'],
  profile: 'balanced',
  resume: { attempt: 2, sourceSequences: { mic: 9 } }
}

test('recognizer options reach the worker only for non-null profile mappings', async () => {
  const recognizer = { kind: 'sherpa-online-transducer', modelDir: 'model-dir', numThreads: 4, modelType: 'zipformer2' }
  const vad = { kind: 'silero', modelPath: 'vad-model' }

  const real = makeAdapterWith({ profileMap: { fast: 'x-asr-160ms' }, recognizer, vad })
  await real.adapter.start({ sessionId: 'session-1', sourceIds: ['mic'], profile: 'fast' })
  const realStart = real.worker.calls.find(([name]) => name === 'start')[1]
  assert.equal(realStart.recognizerProfile, 'x-asr-160ms')
  assert.deepEqual(realStart.recognizer, recognizer)
  assert.deepEqual(realStart.vad, vad)
  real.adapter.dispose()

  /* 结构模式：即使注入了 recognizer/vad 选项，null profile 也不得携带——
     结构 worker 不加载任何原生模块。 */
  const structural = makeAdapterWith({ recognizer, vad })
  await structural.adapter.start(START_CONTEXT)
  const structuralStart = structural.worker.calls.find(([name]) => name === 'start')[1]
  assert.equal(structuralStart.recognizerProfile, 'null')
  assert.equal(structuralStart.recognizer, undefined)
  assert.equal(structuralStart.vad, undefined)
  structural.adapter.dispose()
})

const REFINEMENT = { kind: 'sherpa-offline-transducer', modelDir: 'refine-dir', numThreads: 3 }

test('refinement worker wires only for real profiles and degrades without failing the session', async () => {
  /* 正常接线：refine 配置 + 双端口 + worker 声明 refinement。 */
  const wired = makeAdapterWith({ profileMap: { fast: 'x-asr-160ms' }, recognizer: { kind: 'sherpa-online-transducer', modelDir: 'm', numThreads: 4 }, refinement: REFINEMENT })
  await wired.adapter.start({ sessionId: 'session-1', sourceIds: ['mic'], profile: 'fast' })
  assert.deepEqual(wired.refineWorker.calls.find(([name]) => name === 'start')[1], { model: REFINEMENT })
  assert.equal(wired.worker.calls.find(([name]) => name === 'start')[1].refinement, true)
  const refinePort = wired.worker.calls.find(([name]) => name === 'attachRefinePort')[1]
  const refineSide = wired.refineWorker.calls.find(([name]) => name === 'attachPort')[1]
  assert.equal(refinePort.id, 'p1')
  assert.equal(refineSide.id, 'p2')
  /* 精修中途退出：降级而非会话故障。 */
  const faults = []
  wired.adapter.onError((event) => faults.push(event))
  wired.refineWorker.emitExit(9)
  assert.equal(faults.length, 0, 'refine exit must not fault the session')
  assert.equal(wired.degraded.length, 1)
  await wired.adapter.stop()
  assert.equal(wired.refineWorker.disposed, true)
  wired.adapter.dispose()

  /* 精修配置失败：会话照常启动，refine 丢弃并告警。 */
  const failing = makeAdapterWith({ profileMap: { fast: 'x-asr-160ms' }, recognizer: { kind: 'sherpa-online-transducer', modelDir: 'm', numThreads: 4 }, refinement: REFINEMENT })
  failing.refineWorker.failStart = true
  await failing.adapter.start({ sessionId: 'session-2', sourceIds: ['mic'], profile: 'fast' })
  assert.equal(failing.degraded.length, 1)
  assert.equal(failing.refineWorker.disposed, true)
  assert.equal(failing.worker.calls.some(([name]) => name === 'attachRefinePort'), false)
  await failing.adapter.stop()
  failing.adapter.dispose()

  /* 结构模式：null profile 不 fork 精修。 */
  const structural = makeAdapterWith({ refinement: REFINEMENT })
  await structural.adapter.start(START_CONTEXT)
  assert.equal(structural.refineWorker.calls.length, 0)
  assert.equal(structural.worker.calls.find(([name]) => name === 'start')[1].refinement, false)
  structural.adapter.dispose()
})

test('start orchestrates worker-first wiring and maps the resume cursor', async () => {
  const { adapter, worker, host } = makeAdapter()
  await adapter.start(START_CONTEXT)

  const workerStart = worker.calls.find(([name]) => name === 'start')[1]
  assert.equal(workerStart.recognizerProfile, 'null', 'Gate 0B 未过：profile 映射到 null')
  assert.equal(workerStart.attempt, 2)
  assert.deepEqual(workerStart.sequenceBases, { mic: 9 })

  const order = [...worker.calls.map(([name]) => `worker.${name}`), ...host.calls.map(([name]) => `host.${name}`)]
  assert.deepEqual(order, ['worker.start', 'worker.attachPort', 'host.startCapture'])
  const capture = host.calls.find(([name]) => name === 'startCapture')[1]
  assert.equal(capture.port.id, 'p1')
  assert.equal(worker.calls.find(([name]) => name === 'attachPort')[1].id, 'p2')

  await assert.rejects(adapter.start(START_CONTEXT), /already running/)
  adapter.dispose()
})

test('captions pass through only while the session is current and faults are reported', async () => {
  const { adapter, worker, host } = makeAdapter()
  const captions = []
  const faults = []
  adapter.onCaption((event) => captions.push(event))
  adapter.onError((event) => faults.push(event))
  await adapter.start(START_CONTEXT)

  worker.emitCaption({ any: 'event' })
  assert.equal(captions.length, 1)

  worker.emitExit(13)
  host.emitControl({ type: 'track-ended', sessionId: 'session-1', sourceId: 'mic' })
  assert.deepEqual(faults.map((fault) => fault.code), ['REALTIME_WORKER_EXITED', 'AUDIO_TRACK_ENDED'])
  assert.ok(faults.every((fault) => fault.recoverable === true))

  await adapter.stop()
  worker.emitCaption({ late: true })
  worker.emitExit(1)
  assert.equal(captions.length, 1, '停止后事件不再透传')
  assert.equal(faults.length, 2, '停止后的退出不算故障')
  assert.equal(worker.disposed, true)
  assert.equal(host.disposed, true)
  adapter.dispose()
})

test('stop is capture-first and start failures tear down cleanly', async () => {
  const { adapter, worker, host } = makeAdapter()
  await adapter.start(START_CONTEXT)
  await adapter.stop()
  assert.deepEqual(host.calls.map(([name]) => name), ['startCapture', 'stopCapture'])

  const failing = makeAdapter()
  failing.host.startCapture = async () => { throw new Error('capture denied') }
  const faults = []
  failing.adapter.onError((event) => faults.push(event))
  await assert.rejects(failing.adapter.start(START_CONTEXT), /capture denied/)
  assert.equal(failing.worker.disposed, true)
  assert.equal(failing.host.disposed, true)
  assert.deepEqual(faults, [], '启动失败走异常路径，不重复上报故障')
  /* 失败后可重试。 */
  const retry = fakeWorker()
  failing.adapter.workerFactory = () => retry
  failing.adapter.hostFactory = () => fakeHost()
  await failing.adapter.start(START_CONTEXT)
  failing.adapter.dispose()
  adapter.dispose()
})

test('profile mapping is explicit and pause/resume reach the worker', async () => {
  const { adapter, worker } = makeAdapter()
  await assert.rejects(adapter.start({ ...START_CONTEXT, profile: 'turbo' }), /no recognizer mapping/)
  await adapter.start(START_CONTEXT)
  await adapter.pause()
  await adapter.resume()
  assert.deepEqual(worker.calls.filter(([name]) => name === 'pause' || name === 'resume').map(([name]) => name), ['pause', 'resume'])
  adapter.dispose()
  await assert.rejects(adapter.pause(), /disposed/)
})

test('fault-retry worker generations cannot collide on segment ids or corrupt finalized text', async (t) => {
  /* §12.3 回归关闭点：同 adapter（attempt 恒 0）fault-retry 后 fork 的新
     worker 世代，其 segmentId 必须与上一代不冲突——事件全被接受，且上一代
     已定稿段不可被回改。 */
  const { WorkerCore } = require('../../src/runtime/realtime-worker/worker-core')
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  const coordinator = new SessionCoordinator({
    adapter,
    runtimeOptions: DEV_MODEL,
    configuration: DICTATION,
    idFactory: () => 'session-gen-1'
  })
  t.after(() => coordinator.dispose())
  await coordinator.command('start')
  const delivered = []
  coordinator.onCaption((event) => delivered.push(event))

  const scripted = () => {
    let buffered = 0
    return {
      acceptFrame () { buffered += 1 },
      poll () { return `听到 ${buffered} 帧` },
      endSegment () { const text = `定稿 ${buffered} 帧。`; buffered = 0; return text },
      dispose () {}
    }
  }
  const vad = { threshold: 0.05, voicedFramesToStart: 1, silentFramesToEnd: 2 }
  const feed = (core, startSequence) => {
    const events = []
    const make = (sequence, amplitude) => ({
      sourceId: 'mic',
      sequence,
      timestampSeconds: sequence * 0.1,
      sampleCount: 1600,
      samples: new Float32Array(1600).fill(amplitude)
    })
    events.push(...core.ingestFrame(make(startSequence, 0.3)))
    events.push(...core.ingestFrame(make(startSequence + 1, 0)))
    events.push(...core.ingestFrame(make(startSequence + 2, 0)))
    return events
  }

  const gen1 = new WorkerCore({ sessionId: 'session-gen-1', sourceIds: ['mic'], adapterFactory: scripted, vadOptions: vad })
  const gen1Events = feed(gen1, 0)
  for (const event of gen1Events) adapter.emitCaption(event)
  assert.equal(delivered.length, gen1Events.length, 'gen1 事件全部被接受')
  const gen1SegmentIds = new Set(gen1Events.map((event) => event.segmentId))
  const finalizedText = coordinator.getCaptionState().segments.at(-1).text
  assert.ok(finalizedText.startsWith('定稿'), 'gen1 段已定稿')

  /* fault-retry：同 session、attempt 0（epoch 未变）、sequence 游标 = 已接受最大值。 */
  const cursor = Math.max(...gen1Events.map((event) => event.sequence))
  const gen2 = new WorkerCore({
    sessionId: 'session-gen-1',
    sourceIds: ['mic'],
    adapterFactory: scripted,
    vadOptions: vad,
    attempt: 0,
    sequenceBases: { mic: cursor }
  })
  const gen2Events = feed(gen2, 100)
  assert.ok(gen2Events.length >= 2)
  for (const event of gen2Events) {
    assert.equal(gen1SegmentIds.has(event.segmentId), false, `segmentId ${event.segmentId} 与上一代冲突`)
  }
  const before = delivered.length
  for (const event of gen2Events) adapter.emitCaption(event)
  assert.equal(delivered.length, before + gen2Events.length, 'gen2 事件全部被接受（无一被旧游标拒绝）')

  const state = coordinator.getCaptionState()
  const gen1Segment = state.segments.find((segment) => gen1SegmentIds.has(segment.segmentId))
  assert.equal(gen1Segment.text, finalizedText, 'gen1 定稿文本不可被 gen2 回改')
  assert.equal(gen1Segment.kind, 'final')
})

test('worker host pause awaits the ack after flushed captions and fails on dead workers', async () => {
  const { EventEmitter } = require('node:events')
  const { RealtimeWorkerHost } = require('../../src/runtime/realtime-worker/worker-host')

  const child = new EventEmitter()
  child.kill = () => {}
  const order = []
  child.postMessage = (message) => {
    if (message?.type === 'configure') setImmediate(() => child.emit('message', { type: 'configured' }))
    if (message?.type === 'pause') {
      setImmediate(() => {
        child.emit('message', {
          type: 'caption',
          event: {
            schemaVersion: 1,
            sessionId: 's',
            sourceId: 'mic',
            segmentId: 'seg-mic-1',
            sequence: 1,
            revision: 1,
            kind: 'final',
            t0: 0,
            t1: 0.4,
            text: '暂停定稿。',
            translation: null
          }
        })
        child.emit('message', { type: 'paused' })
      })
    }
  }
  const host = new RealtimeWorkerHost({ electron: { utilityProcess: { fork: () => child } } })
  host.onCaption(() => order.push('caption'))
  await host.start({ sessionId: 's', sourceIds: ['mic'] })
  await host.pause().then(() => order.push('ack'))
  assert.deepEqual(order, ['caption', 'ack'], '定稿必须先于 pause ack 交付')

  /* 死 worker：pause 必须失败而不是静默成功。 */
  child.emit('exit', 9)
  await assert.rejects(host.pause(), /not running/)
  const timing = new RealtimeWorkerHost({
    electron: { utilityProcess: { fork: () => { const c = new EventEmitter(); c.kill = () => {}; c.postMessage = (m) => { if (m?.type === 'configure') setImmediate(() => c.emit('message', { type: 'configured' })); if (m?.type === 'pause') setImmediate(() => c.emit('exit', 5)) }; return c } } }
  })
  await timing.start({ sessionId: 's', sourceIds: ['mic'] })
  await assert.rejects(timing.pause(), /exited during pause/)
})

test('coordinator enters error from an adapter fault and recovers via retry', async (t) => {
  /* 用支持 onError 的 stub adapter 驱动真实 coordinator。 */
  function stubAdapter () {
    const stub = new FakeRuntimeAdapter({ autoEmit: false })
    stub.errorHandler = null
    stub.onError = (handler) => { stub.errorHandler = handler; return () => { stub.errorHandler = null } }
    stub.emitFault = (event) => { if (stub.errorHandler) stub.errorHandler(event) }
    return stub
  }
  const adapter = stubAdapter()
  const replacements = []
  const coordinator = new SessionCoordinator({
    adapter,
    adapterFactory: () => { const r = stubAdapter(); replacements.push(r); return r },
    runtimeOptions: DEV_MODEL,
    configuration: DICTATION,
    idFactory: () => 'session-fault-1',
    transitionTimeoutMs: 200
  })
  t.after(() => coordinator.dispose())

  assert.equal((await coordinator.command('start')).ok, true)
  assert.equal(adapter.emitFault({ scope: 'worker', code: 'REALTIME_WORKER_EXITED', message: '识别进程退出（13）', recoverable: true }), undefined)
  const snapshot = coordinator.getSnapshot()
  assert.equal(snapshot.phase, 'error')
  assert.equal(snapshot.lastError.code, 'REALTIME_WORKER_EXITED')
  assert.equal(snapshot.capabilities.canRetry, true)

  assert.equal((await coordinator.command('retry')).ok, true)
  assert.equal(coordinator.getSnapshot().phase, 'listening')
  assert.equal(coordinator.getSnapshot().sessionId, 'session-fault-1')
})

test('coordinator ignores faults from stale adapters, busy transitions, and sanitizes junk', async (t) => {
  function stubAdapter (overrides = {}) {
    const stub = new FakeRuntimeAdapter({ autoEmit: false })
    stub.onError = (handler) => { stub.errorHandler = handler; return () => { stub.errorHandler = null } }
    stub.emitFault = (event) => { if (stub.errorHandler) stub.errorHandler(event) }
    Object.assign(stub, overrides)
    return stub
  }
  let releaseStart
  const adapter = stubAdapter({
    start: async () => { await new Promise((resolve) => { releaseStart = resolve }) }
  })
  const replacement = stubAdapter()
  const coordinator = new SessionCoordinator({
    adapter,
    adapterFactory: () => replacement,
    runtimeOptions: DEV_MODEL,
    configuration: DICTATION,
    idFactory: () => 'session-fault-2',
    transitionTimeoutMs: 50
  })
  t.after(() => coordinator.dispose())

  /* busy（start 挂起中）时的故障被忽略——由迁移自己的超时路径接管。 */
  const pending = coordinator.command('start')
  adapter.emitFault({ code: 'IGNORED_WHILE_BUSY', message: 'x', recoverable: true })
  assert.notEqual(coordinator.getSnapshot().phase, 'error')
  assert.equal((await pending).code, 'ADAPTER_START_TIMEOUT')
  releaseStart()

  /* 超时后旧 adapter 已被隔离：它的迟到故障不得改变状态。 */
  assert.equal((await coordinator.command('retry')).ok, true)
  assert.equal(coordinator.getSnapshot().phase, 'listening')
  adapter.emitFault({ code: 'STALE_FAULT', message: 'x', recoverable: true })
  assert.equal(coordinator.getSnapshot().phase, 'listening')

  /* 垃圾字段被清洗：坏 code → RUNTIME_FAULT，超长消息截断，默认可恢复。 */
  replacement.emitFault({ code: 'not-a-code!', message: 'y'.repeat(500) })
  const snapshot = coordinator.getSnapshot()
  assert.equal(snapshot.phase, 'error')
  assert.equal(snapshot.lastError.code, 'RUNTIME_FAULT')
  assert.ok(snapshot.lastError.message.length <= 120)
  assert.equal(snapshot.lastError.recoverable, true)
})
