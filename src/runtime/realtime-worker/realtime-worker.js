'use strict'

/* realtime worker（utilityProcess 入口，B2.3；模型轨 M4 后接真实 recognizer）。
   接线职责：B2.2 credit 协议（ready → 初始授信 → 窗口式回授带 consumed
   确认）+ 帧路由到 WorkerCore + 事件/指标经 parentPort 低频上报。
   推理/分段及精修响应状态机分别在 worker-core.js、refinement-controller.js
   （均可脱离 Electron 测试）。
   默认 recognizer profile 仍是 'null'（只验证结构，不产文本）；configure
   携带 recognizer 选项时才注册真实 sherpa adapter——模型在回 'configured'
   前同步载入，宿主的 configure 超时因此覆盖模型载入。 */

const {
  DEFAULT_PRE_ROLL_FRAMES,
  DEFAULT_PROVISIONAL_FEED_FRAMES,
  WorkerCore
} = require('./worker-core')
const { RefinementController } = require('./refinement-controller')
const { performance } = require('node:perf_hooks')

const UTILITY_CLOCK_ID = 'realtime-utility-performance-v1'

const state = {
  port: null,
  core: null,
  refine: null,
  config: {
    sessionId: null,
    sourceIds: [],
    recognizerProfile: 'null',
    vadOptions: undefined,
    attempt: 0,
    sequenceBases: {},
    initialCredits: 25,
    creditBatch: 10
  },
  grantedInitial: new Set(),
  creditDebt: new Map(),
  endReceived: false,
  statsTimer: null,
  shuttingDown: false,
  /* samples 跨进程反序列化后不是 Float32Array 的帧数——传输层类型回归
     的哨兵指标（B2.2 已证明这条桥会有非标准行为）。 */
  badSampleTypeFrames: 0,
  sampleTypeObserved: null
}

state.timing = new Map()
state.segmentTiming = new Map()
state.currentFrameTiming = null

function sourceTiming (sourceId) {
  let timing = state.timing.get(sourceId)
  if (!timing) {
    timing = {
      firstFrameIngressUtilityClockMs: null,
      firstPartialPublishUtilityClockMs: null,
      firstPartialFrameSequence: null,
      firstPartialFrameAudioEndMs: null,
      firstPartialFrameAudioHostClockMs: null,
      firstPartialFrameIngressUtilityClockMs: null
    }
    state.timing.set(sourceId, timing)
  }
  return timing
}

/* B3 精修：请求方一侧的有界队列与响应状态机。上限 3——积压即跳过
   （段保持 final），绝不反压实时；CaptionEvent 序号仍由 WorkerCore 分配。 */
state.refine = new RefinementController({
  emitRefined: (info, text) => state.core ? state.core.emitRefined(info, text) : null,
  publish,
  publishFault: (fault) => publish({
    type: 'refinement-fault',
    code: fault.code,
    stage: fault.stage
  })
})

function grantCredits (sourceId, count, consumed = 0) {
  if (!state.port || count <= 0) return
  try {
    state.port.postMessage({ type: 'credits', sourceId, count, consumed })
  } catch { /* port may be closing */ }
}

function publish (message) {
  try { process.parentPort.postMessage(message) } catch { /* parent gone */ }
}

function reportStats () {
  const timing = {}
  for (const [sourceId, values] of state.timing) timing[sourceId] = { ...values }
  publish({
    type: 'stats',
    stats: {
      endReceived: state.endReceived,
      badSampleTypeFrames: state.badSampleTypeFrames,
      sampleTypeObserved: state.sampleTypeObserved,
      refine: state.refine.enabled
        ? state.refine.metrics()
        : null,
      sources: state.core ? state.core.metrics() : {},
      timing
    }
  })
}

function onPortMessage (message) {
  if (message?.type === 'ready') {
    const sessionId = String(message.sessionId || '')
    const ready = Array.isArray(message.sourceIds) ? message.sourceIds.map(String) : []
    for (const sourceId of ready) {
      if (!state.config.sourceIds.includes(sourceId)) continue
      const key = `${sessionId}:${sourceId}`
      if (state.grantedInitial.has(key)) continue
      state.grantedInitial.add(key)
      grantCredits(sourceId, state.config.initialCredits)
    }
    return
  }
  if (message?.type === 'end') {
    state.endReceived = true
    /* 停止路径：end 收束的段不再发起精修（响应必然晚于收尾，白解码；
       直接保持 final 并计入 skipped）；更早的在途请求作废——晚到响应因
       pending 查不到而被忽略。暂停期缓冲的精修补发（stopping 仍接受）。 */
    state.refine.end(() => {
      if (state.core) {
        for (const event of state.core.flush()) publish({ type: 'caption', event })
      }
    })
    reportStats()
    return
  }
  if (message?.type !== 'frame' || !state.core) return
  const sourceId = String(message.sourceId || '')
  if (!state.config.sourceIds.includes(sourceId)) return
  const ingressUtilityClockMs = performance.now()
  const timing = sourceTiming(sourceId)
  if (timing.firstFrameIngressUtilityClockMs === null) {
    timing.firstFrameIngressUtilityClockMs = Number(ingressUtilityClockMs.toFixed(3))
  }
  /* 暂停：不向 recognizer 送帧（v1 语义），但帧仍按「送达即消费」回授 credit。 */
  if (state.refine.paused) {
    const pausedDebt = (state.creditDebt.get(sourceId) || 0) + 1
    if (pausedDebt >= state.config.creditBatch) {
      grantCredits(sourceId, pausedDebt, pausedDebt)
      state.creditDebt.set(sourceId, 0)
    } else {
      state.creditDebt.set(sourceId, pausedDebt)
    }
    return
  }

  /* 反序列化类型回退时按底层字节重建；重建不了才计入坏帧。
     sampleTypeObserved 记录首个观测类型，坏帧类型覆盖记录（排查用）。 */
  let samples = message.samples
  if (samples instanceof Float32Array) {
    if (state.sampleTypeObserved === null) state.sampleTypeObserved = 'Float32Array'
  } else if (samples instanceof ArrayBuffer) {
    samples = new Float32Array(samples)
    if (state.sampleTypeObserved === null) state.sampleTypeObserved = 'ArrayBuffer(rebuilt)'
  } else if (ArrayBuffer.isView(samples)) {
    samples = new Float32Array(samples.buffer, samples.byteOffset, Math.floor(samples.byteLength / 4))
    if (state.sampleTypeObserved === null) state.sampleTypeObserved = 'TypedArray(rebuilt)'
  } else {
    state.badSampleTypeFrames += 1
    state.sampleTypeObserved = Object.prototype.toString.call(samples)
    samples = new Float32Array(0)
  }
  state.currentFrameTiming = {
    sourceId,
    sequence: message.sequence,
    frameAudioHostClockMs: Number.isFinite(message.captureAudioHostClockMs)
      ? Number(message.captureAudioHostClockMs.toFixed(3))
      : null,
    workerIngressUtilityClockMs: Number(ingressUtilityClockMs.toFixed(3))
  }
  let events
  try {
    events = state.core.ingestFrame({
      sourceId,
      sequence: message.sequence,
      timestampSeconds: message.timestampSeconds,
      sampleCount: message.sampleCount,
      samples
    })
  } finally {
    state.currentFrameTiming = null
  }
  for (const event of events) {
    const publishedAtUtilityClockMs = performance.now()
    if (event.kind === 'partial' && timing.firstPartialPublishUtilityClockMs === null) {
      timing.firstPartialPublishUtilityClockMs = Number(publishedAtUtilityClockMs.toFixed(3))
      timing.firstPartialFrameSequence = message.sequence
      timing.firstPartialFrameAudioEndMs = Number((
        (message.timestampSeconds + (message.sampleCount / 16000)) * 1000
      ).toFixed(3))
      timing.firstPartialFrameAudioHostClockMs = Number.isFinite(message.captureAudioHostClockMs)
        ? Number(message.captureAudioHostClockMs.toFixed(3))
        : null
      timing.firstPartialFrameIngressUtilityClockMs = Number(ingressUtilityClockMs.toFixed(3))
    }
    const segmentTiming = state.segmentTiming.get(event.segmentId)
    const trace = event.kind === 'partial' && segmentTiming &&
      typeof message.audioHostClockId === 'string' && message.audioHostClockId.length > 0 &&
      Number.isFinite(message.captureAudioHostClockMs)
      ? {
          schemaVersion: 2,
          sourceId: event.sourceId,
          segmentId: event.segmentId,
          sequence: event.sequence,
          audioHostClockId: message.audioHostClockId,
          vadStartAudioTimestampMs: segmentTiming.vadStartAudioTimestampMs,
          vadStartFrameAudioHostClockMs: segmentTiming.vadStartFrameAudioHostClockMs,
          partialTriggerAudioEndMs: Number((
            (message.timestampSeconds + (message.sampleCount / 16000)) * 1000
          ).toFixed(3)),
          partialTriggerFrameAudioHostClockMs: Number(message.captureAudioHostClockMs.toFixed(3)),
          utilityClockId: UTILITY_CLOCK_ID,
          partialTriggerUtilityIngressClockMs: Number(ingressUtilityClockMs.toFixed(3)),
          partialPublishUtilityClockMs: Number(publishedAtUtilityClockMs.toFixed(3))
        }
      : null
    publish({ type: 'caption', event, timing: trace })
    if (event.kind === 'final') state.segmentTiming.delete(event.segmentId)
  }

  const debt = (state.creditDebt.get(sourceId) || 0) + 1
  if (debt >= state.config.creditBatch) {
    grantCredits(sourceId, debt, debt)
    state.creditDebt.set(sourceId, 0)
  } else {
    state.creditDebt.set(sourceId, debt)
  }
}

function attachPort (port) {
  if (state.port) { try { state.port.close() } catch { /* already closed */ } }
  state.port = port
  /* 初始授信按端口世代去重（同 pcm-sink：同端口上的重复 ready 去重，
     新端口世代重新授信）。 */
  state.grantedInitial.clear()
  port.on('message', (event) => onPortMessage(event.data))
  port.start()
  if (!state.statsTimer) state.statsTimer = setInterval(reportStats, 500)
}

function shutdown () {
  if (state.shuttingDown) return
  state.shuttingDown = true
  if (state.statsTimer) {
    clearInterval(state.statsTimer)
    state.statsTimer = null
  }
  const port = state.port
  state.port = null
  if (port) {
    try { port.close() } catch { /* already closed */ }
  }
  try { state.refine.dispose() } catch { /* best effort */ }
  try { if (state.core) state.core.dispose() } catch { /* best effort */ }
  state.core = null
  publish({ type: 'stopped' })
  setImmediate(() => process.exit(0))
}

process.parentPort.on('message', (event) => {
  const message = event.data
  if (message?.type === 'clock-probe') {
    const r1 = performance.now()
    const r2 = performance.now()
    publish({
      type: 'clock-probe-result',
      probeId: message.probeId,
      clockId: UTILITY_CLOCK_ID,
      r1,
      r2
    })
  } else if (message?.type === 'shutdown') {
    shutdown()
  } else if (message?.type === 'disable-refinement') {
    state.refine.disable()
  } else if (state.shuttingDown) {
    return
  } else if (message?.type === 'configure') {
    /* 二次 configure 会把 sequence/segmentId 归零，旧游标下所有新事件都会
       被 coordinator 拒绝——按编程错误拒绝，重配置应当重启 worker。 */
    if (state.core) {
      publish({ type: 'configure-failed', message: 'worker is already configured; fork a new worker instead' })
      return
    }
    const config = state.config
    if (typeof message.sessionId === 'string' && message.sessionId.length > 0) config.sessionId = message.sessionId
    if (Array.isArray(message.sourceIds)) config.sourceIds = message.sourceIds.map(String)
    if (typeof message.recognizerProfile === 'string') config.recognizerProfile = message.recognizerProfile
    if (message.vadOptions && typeof message.vadOptions === 'object') config.vadOptions = message.vadOptions
    if (Number.isInteger(message.attempt) && message.attempt >= 0) config.attempt = message.attempt
    if (message.sequenceBases && typeof message.sequenceBases === 'object' && !Array.isArray(message.sequenceBases)) {
      config.sequenceBases = message.sequenceBases
    }
    for (const key of ['initialCredits', 'creditBatch']) {
      if (Number.isInteger(message[key]) && message[key] > 0) config[key] = message[key]
    }
    try {
      /* 真实模型：先注册（内部同步载入模型），后建 WorkerCore；失败走
         configure-failed。null profile 不 require 原生模块。 */
      let adapterFactory
      if (config.recognizerProfile !== 'null') {
        const { registerSherpaRecognizer } = require('./sherpa-recognizer')
        const {
          createRecognizerAdapter,
          createTwoStageRecognizerAdapter,
          requireTwoStageRecognizerConfiguration
        } = require('./recognizer-adapter')
        const twoStage = requireTwoStageRecognizerConfiguration(message.recognizer, message.draftRecognizer)
        const draftProfile = `${config.recognizerProfile}:draft`
        try {
          registerSherpaRecognizer(draftProfile, twoStage.draftRecognizer)
        } catch {
          const error = new Error('draft recognizer failed to start')
          error.code = 'DRAFT_RECOGNIZER_START_FAILED'
          throw error
        }
        registerSherpaRecognizer(config.recognizerProfile, twoStage.recognizer)
        adapterFactory = () => createTwoStageRecognizerAdapter({
          createDraft: () => createRecognizerAdapter(draftProfile),
          createAuthoritative: () => createRecognizerAdapter(config.recognizerProfile),
          onDraftFault: (fault) => publish({
            type: 'draft-recognizer-fault',
            code: fault.code,
            stage: fault.stage,
            count: fault.count
          })
        })
      }
      /* 真实 VAD（silero）：有选项才 require 原生实现；否则 EnergyVad 兜底。
         段前缓冲固定为 4 帧（400ms），候选预热独立限于 12 帧
         （1200ms），不改变 Silero 的时间阈值。 */
      let vadFactory
      let preRollLimit
      let provisionalFeedLimit
      if (message.vad && typeof message.vad === 'object') {
        const { SileroVad } = require('./silero-vad')
        const vadConfig = message.vad
        vadFactory = () => new SileroVad(vadConfig)
        preRollLimit = DEFAULT_PRE_ROLL_FRAMES
        provisionalFeedLimit = DEFAULT_PROVISIONAL_FEED_FRAMES
      }
      /* 精修：configure 声明 refinement 才保留段音频（结构/无精修模式零
         额外内存）；实际请求还要等 refine-port 到达。 */
      state.refine.enabled = message.refinement === true
      state.core = new WorkerCore({
        sessionId: config.sessionId,
        sourceIds: config.sourceIds,
        recognizerProfile: config.recognizerProfile,
        adapterFactory,
        vadOptions: config.vadOptions,
        vadFactory,
        preRollLimit,
        provisionalFeedLimit,
        onSegmentStarted: (info) => {
          const current = state.currentFrameTiming
          if (!current || current.sourceId !== info.sourceId || current.sequence !== info.frameSequence) return
          if (!Number.isFinite(current.frameAudioHostClockMs)) return
          state.segmentTiming.set(info.segmentId, {
            vadStartAudioTimestampMs: Number((info.frameTimestampSeconds * 1000).toFixed(3)),
            vadStartFrameAudioHostClockMs: current.frameAudioHostClockMs,
            vadStartUtilityIngressClockMs: current.workerIngressUtilityClockMs
          })
        },
        onSegmentFinalized: state.refine.enabled ? (info) => state.refine.request(info) : undefined,
        attempt: config.attempt,
        sequenceBases: config.sequenceBases
      })
      publish({ type: 'configured' })
    } catch (error) {
      const code = error?.code === 'DRAFT_RECOGNIZER_START_FAILED' ? error.code : undefined
      publish({
        type: 'configure-failed',
        code,
        message: code ? 'draft recognizer failed to start' : String(error?.message || error).slice(0, 200)
      })
    }
  } else if (message?.type === 'pcm-port') {
    if (event.ports && event.ports[0]) attachPort(event.ports[0])
  } else if (message?.type === 'refine-port') {
    if (event.ports && event.ports[0]) {
      state.refine.attachPort(event.ports[0])
    }
  } else if (message?.type === 'pause') {
    /* v1 暂停语义：flush 当前段为定稿，之后不再向 recognizer 送帧。 */
    if (!state.refine.paused && state.core) {
      state.refine.pause()
      for (const captionEvent of state.core.flush()) publish({ type: 'caption', event: captionEvent })
    }
    publish({ type: 'paused' })
  } else if (message?.type === 'resume') {
    state.refine.resume(() => {
      if (state.core) state.core.reanchor()
      publish({ type: 'resumed' })
    })
  } else if (message?.type === 'report') {
    reportStats()
  }
})
