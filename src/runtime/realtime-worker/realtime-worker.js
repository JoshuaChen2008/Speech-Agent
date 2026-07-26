'use strict'

/* realtime worker（utilityProcess 入口，B2.3；模型轨 M4 后接真实 recognizer）。
   接线职责：B2.2 credit 协议（ready → 初始授信 → 窗口式回授带 consumed
   确认）+ 帧路由到 WorkerCore + 事件/指标经 parentPort 低频上报。
   推理与分段逻辑全部在 worker-core.js（可脱离 Electron 测试）。
   默认 recognizer profile 仍是 'null'（只验证结构，不产文本）；configure
   携带 recognizer 选项时才注册真实 sherpa adapter——模型在回 'configured'
   前同步载入，宿主的 configure 超时因此覆盖模型载入。 */

const { WorkerCore } = require('./worker-core')

const state = {
  port: null,
  core: null,
  paused: false,
  /* B3 精修：请求方一侧的有界队列与序号权威。上限 3——积压即跳过
     （段保持 final），绝不反压实时。 */
  refine: {
    enabled: false,
    accepting: true,
    port: null,
    nextRequestId: 1,
    pending: new Map(),
    maxPending: 3,
    skipped: 0,
    failed: 0,
    emptyResults: 0,
    bufferedWhilePaused: []
  },
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
  /* samples 跨进程反序列化后不是 Float32Array 的帧数——传输层类型回归
     的哨兵指标（B2.2 已证明这条桥会有非标准行为）。 */
  badSampleTypeFrames: 0,
  sampleTypeObserved: null
}

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
  publish({
    type: 'stats',
    stats: {
      endReceived: state.endReceived,
      badSampleTypeFrames: state.badSampleTypeFrames,
      sampleTypeObserved: state.sampleTypeObserved,
      refine: state.refine.enabled
        ? {
            pending: state.refine.pending.size,
            skipped: state.refine.skipped,
            failed: state.refine.failed,
            emptyResults: state.refine.emptyResults
          }
        : null,
      sources: state.core ? state.core.metrics() : {}
    }
  })
}

/* ---- B3 精修请求/响应（realtime worker 是 CaptionEvent 的唯一序号权威） ---- */

function requestRefinement (info) {
  const refine = state.refine
  if (!refine.accepting || !refine.port || refine.pending.size >= refine.maxPending) {
    refine.skipped += 1
    return
  }
  let sampleCount = 0
  for (const chunk of info.chunks) sampleCount += chunk.length
  const samples = new Float32Array(sampleCount)
  let offset = 0
  for (const chunk of info.chunks) { samples.set(chunk, offset); offset += chunk.length }
  const requestId = refine.nextRequestId++
  refine.pending.set(requestId, {
    sourceId: info.sourceId,
    segmentId: info.segmentId,
    baseRevision: info.baseRevision,
    t0: info.t0,
    t1: info.t1
  })
  try {
    refine.port.postMessage({ type: 'refine', requestId, sampleCount, samples })
  } catch {
    refine.pending.delete(requestId)
    refine.skipped += 1
  }
}

function onRefineMessage (message) {
  const refine = state.refine
  if (message?.type === 'refined') {
    const info = refine.pending.get(message.requestId)
    refine.pending.delete(message.requestId)
    if (!info || !state.core) return
    const text = typeof message.text === 'string' ? message.text.trim() : ''
    if (text.length === 0) {
      refine.emptyResults += 1
      return
    }
    const event = state.core.emitRefined(info, text)
    if (!event) return
    /* 暂停期缓冲：paused 相位的 caption 会被 coordinator 拒收，恢复后补发。 */
    if (state.paused) refine.bufferedWhilePaused.push(event)
    else publish({ type: 'caption', event })
  } else if (message?.type === 'refine-failed') {
    refine.pending.delete(message.requestId)
    refine.failed += 1
  }
}

function flushBufferedRefined () {
  for (const event of state.refine.bufferedWhilePaused) publish({ type: 'caption', event })
  state.refine.bufferedWhilePaused = []
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
    state.refine.accepting = false
    if (state.core) {
      for (const event of state.core.flush()) publish({ type: 'caption', event })
    }
    flushBufferedRefined()
    state.refine.pending.clear()
    reportStats()
    return
  }
  if (message?.type !== 'frame' || !state.core) return
  const sourceId = String(message.sourceId || '')
  if (!state.config.sourceIds.includes(sourceId)) return
  /* 暂停：不向 recognizer 送帧（v1 语义），但帧仍按「送达即消费」回授 credit。 */
  if (state.paused) {
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
  const events = state.core.ingestFrame({
    sourceId,
    sequence: message.sequence,
    timestampSeconds: message.timestampSeconds,
    sampleCount: message.sampleCount,
    samples
  })
  for (const event of events) publish({ type: 'caption', event })

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

process.parentPort.on('message', (event) => {
  const message = event.data
  if (message?.type === 'configure') {
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
      if (config.recognizerProfile !== 'null' && message.recognizer && typeof message.recognizer === 'object') {
        const { registerSherpaRecognizer } = require('./sherpa-recognizer')
        registerSherpaRecognizer(config.recognizerProfile, message.recognizer)
      }
      /* 真实 VAD（silero）：有选项才 require 原生实现；否则 EnergyVad 兜底。
         段前缓冲放宽到 6 帧（600ms）补偿 silero 的起点判定滞后。 */
      let vadFactory
      let preRollLimit
      if (message.vad && typeof message.vad === 'object') {
        const { SileroVad } = require('./silero-vad')
        const vadConfig = message.vad
        vadFactory = () => new SileroVad(vadConfig)
        preRollLimit = 6
      }
      /* 精修：configure 声明 refinement 才保留段音频（结构/无精修模式零
         额外内存）；实际请求还要等 refine-port 到达。 */
      state.refine.enabled = message.refinement === true
      state.core = new WorkerCore({
        sessionId: config.sessionId,
        sourceIds: config.sourceIds,
        recognizerProfile: config.recognizerProfile,
        vadOptions: config.vadOptions,
        vadFactory,
        preRollLimit,
        onSegmentFinalized: state.refine.enabled ? requestRefinement : undefined,
        attempt: config.attempt,
        sequenceBases: config.sequenceBases
      })
      publish({ type: 'configured' })
    } catch (error) {
      publish({ type: 'configure-failed', message: String(error?.message || error).slice(0, 200) })
    }
  } else if (message?.type === 'pcm-port') {
    if (event.ports && event.ports[0]) attachPort(event.ports[0])
  } else if (message?.type === 'refine-port') {
    if (event.ports && event.ports[0]) {
      if (state.refine.port) { try { state.refine.port.close() } catch { /* already closed */ } }
      const port = event.ports[0]
      state.refine.port = port
      port.on('message', (portEvent) => onRefineMessage(portEvent.data))
      /* 对端死亡（refine worker 退出）：立刻置空并作废在途——后续段直接
         计入 skipped，不再复制音频发进死端口。 */
      port.on('close', () => {
        if (state.refine.port === port) {
          state.refine.port = null
          state.refine.pending.clear()
        }
      })
      port.start()
    }
  } else if (message?.type === 'pause') {
    /* v1 暂停语义：flush 当前段为定稿，之后不再向 recognizer 送帧。 */
    if (!state.paused && state.core) {
      state.paused = true
      for (const captionEvent of state.core.flush()) publish({ type: 'caption', event: captionEvent })
    }
    publish({ type: 'paused' })
  } else if (message?.type === 'resume') {
    state.paused = false
    if (state.core) state.core.reanchor()
    /* 先 ack 后补发：coordinator 收到 ack 才回 listening 相位，缓冲的精修
       必须落在 listening 里才会被接受（与 pause 的「定稿先于 ack」对称）。 */
    publish({ type: 'resumed' })
    flushBufferedRefined()
  } else if (message?.type === 'report') {
    reportStats()
  }
})
