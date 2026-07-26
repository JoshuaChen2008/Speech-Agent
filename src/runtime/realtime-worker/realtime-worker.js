'use strict'

/* realtime worker（utilityProcess 入口，B2.3）。
   接线职责：B2.2 credit 协议（ready → 初始授信 → 窗口式回授带 consumed
   确认）+ 帧路由到 WorkerCore + 事件/指标经 parentPort 低频上报。
   推理与分段逻辑全部在 worker-core.js（可脱离 Electron 测试）。
   Gate 0B 未通过：默认 recognizer profile 是 'null'，只验证结构，
   不产出任何字幕文本。 */

const { WorkerCore } = require('./worker-core')

const state = {
  port: null,
  core: null,
  paused: false,
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
      sources: state.core ? state.core.metrics() : {}
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
    if (state.core) {
      for (const event of state.core.flush()) publish({ type: 'caption', event })
    }
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
      state.core = new WorkerCore({
        sessionId: config.sessionId,
        sourceIds: config.sourceIds,
        recognizerProfile: config.recognizerProfile,
        vadOptions: config.vadOptions,
        attempt: config.attempt,
        sequenceBases: config.sequenceBases
      })
      publish({ type: 'configured' })
    } catch (error) {
      publish({ type: 'configure-failed', message: String(error?.message || error).slice(0, 200) })
    }
  } else if (message?.type === 'pcm-port') {
    if (event.ports && event.ports[0]) attachPort(event.ports[0])
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
    publish({ type: 'resumed' })
  } else if (message?.type === 'report') {
    reportStats()
  }
})
