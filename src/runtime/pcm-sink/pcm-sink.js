'use strict'

/* B2.2 的最小 PCM 消费端（utilityProcess 入口）。
   职责：接收 MessagePort、按 credit 协议消费帧、统计连续性并低频上报。
   B2.3 的 realtime worker 将取代它，但必须沿用同一 credit 协议：
   - 等生产端在端口上宣告 {type:'ready', sourceIds} 后，逐源授予
     initialCredits（不能在 attach 时就授——那会在生产端注册 source 前
     到达而被丢弃）；
   - 正常模式：每消费 creditBatch 帧回授同数 credit（窗口式流控）；
   - 慢速模式（consumeDelayMs>0）：ready 后按固定节奏授信，模拟慢于实时
     的消费端；
   - crashAfterFrames>0：收满即 exit(13)，供 port-replacement 演练。
   PCM 内容在本模块只统计不存储。 */

const state = {
  port: null,
  config: {
    sourceIds: [],
    initialCredits: 25,
    creditBatch: 10,
    consumeDelayMs: 0,
    crashAfterFrames: 0
  },
  perSource: new Map(),
  grantedInitial: new Set(),
  totalFrames: 0,
  endReceived: false,
  slowTimer: null,
  statsTimer: null
}

function sourceStats (sourceId) {
  let stats = state.perSource.get(sourceId)
  if (!stats) {
    stats = {
      framesReceived: 0,
      samplesReceived: 0,
      firstSequence: null,
      lastSequence: null,
      sequenceGapCount: 0,
      missedFrames: 0,
      creditDebt: 0
    }
    state.perSource.set(sourceId, stats)
  }
  return stats
}

function grantCredits (sourceId, count, consumed = 0) {
  if (!state.port || count <= 0) return
  try {
    /* consumed 向生产端确认「已消费 n 帧」，供在途损失核算。 */
    state.port.postMessage({ type: 'credits', sourceId, count, consumed })
  } catch { /* port may be closing */ }
}

function snapshot () {
  const sources = {}
  for (const [sourceId, stats] of state.perSource) {
    sources[sourceId] = {
      framesReceived: stats.framesReceived,
      samplesReceived: stats.samplesReceived,
      firstSequence: stats.firstSequence,
      lastSequence: stats.lastSequence,
      sequenceGapCount: stats.sequenceGapCount,
      missedFrames: stats.missedFrames
    }
  }
  return { totalFrames: state.totalFrames, endReceived: state.endReceived, sources }
}

function reportStats () {
  process.parentPort.postMessage({ type: 'stats', stats: snapshot() })
}

function onPortMessage (message) {
  if (message?.type === 'ready') {
    /* 生产端宣告就绪：此刻（且只有此刻）授初始信用。更早授信会在
       host 的 source 注册完成前到达而被丢弃。同一 session+source 的
       重复 ready（replacePort 与启动竞态）不得把初始信用翻倍。 */
    const sessionId = String(message.sessionId || '')
    const ready = Array.isArray(message.sourceIds) ? message.sourceIds.map(String) : []
    for (const sourceId of ready) {
      if (!state.config.sourceIds.includes(sourceId)) continue
      const key = `${sessionId}:${sourceId}`
      if (state.grantedInitial.has(key)) continue
      state.grantedInitial.add(key)
      grantCredits(sourceId, state.config.initialCredits)
    }
    if (state.config.consumeDelayMs > 0 && !state.slowTimer) {
      state.slowTimer = setInterval(() => {
        for (const sourceId of state.config.sourceIds) {
          const stats = sourceStats(sourceId)
          grantCredits(sourceId, state.config.creditBatch, stats.creditDebt)
          stats.creditDebt = 0
        }
      }, state.config.consumeDelayMs)
    }
    return
  }
  if (message?.type === 'end') {
    state.endReceived = true
    reportStats()
    return
  }
  if (message?.type !== 'frame') return
  /* 只认 configure 声明过的 source：未知 sourceId 不回授 credit——那是
     配置失配，应当以流控饥饿显性化，不能静默吞掉。 */
  const sourceId = String(message.sourceId || '')
  if (!state.config.sourceIds.includes(sourceId)) return
  const stats = sourceStats(sourceId)

  /* canonical 语义：帧一经送达即视为消费——字段畸形的帧也回授 credit，
     否则生产端流控被坏帧永久饿死；统计只收合法帧。realtime worker 同。 */
  const fieldsValid = Number.isInteger(message.sequence) && message.sequence >= 0 &&
    Number.isInteger(message.sampleCount) && message.sampleCount > 0
  if (fieldsValid) {
    if (stats.firstSequence === null) stats.firstSequence = message.sequence
    if (stats.lastSequence !== null && message.sequence > stats.lastSequence + 1) {
      stats.sequenceGapCount += 1
      stats.missedFrames += message.sequence - stats.lastSequence - 1
    }
    stats.lastSequence = message.sequence
    stats.framesReceived += 1
    stats.samplesReceived += message.sampleCount
    state.totalFrames += 1
    if (state.config.crashAfterFrames > 0 && state.totalFrames >= state.config.crashAfterFrames) {
      process.exit(13)
    }
  }
  stats.creditDebt += 1
  if (state.config.consumeDelayMs === 0 && stats.creditDebt >= state.config.creditBatch) {
    /* 正常模式：窗口式流控，消费一批回授一批（count 兼确认）。 */
    grantCredits(sourceId, stats.creditDebt, stats.creditDebt)
    stats.creditDebt = 0
  }
}

function attachPort (port) {
  if (state.port) { try { state.port.close() } catch { /* already closed */ } }
  state.port = port
  /* 初始授信去重按【端口世代】而非进程生命周期：同进程重连新端口后，
     生产端会重发 ready，此时必须重新授信，否则永久停摆。同一端口上的
     重复 ready（replacePort 竞态）仍被去重。 */
  state.grantedInitial.clear()
  port.on('message', (event) => onPortMessage(event.data))
  port.start()
  if (!state.statsTimer) state.statsTimer = setInterval(reportStats, 500)
}

process.parentPort.on('message', (event) => {
  const message = event.data
  if (message?.type === 'configure') {
    const config = state.config
    if (Array.isArray(message.sourceIds)) config.sourceIds = message.sourceIds.map(String)
    for (const key of ['initialCredits', 'creditBatch', 'consumeDelayMs', 'crashAfterFrames']) {
      if (Number.isInteger(message[key]) && message[key] >= 0) config[key] = message[key]
    }
    process.parentPort.postMessage({ type: 'configured' })
  } else if (message?.type === 'pcm-port') {
    if (event.ports && event.ports[0]) attachPort(event.ports[0])
  } else if (message?.type === 'report') {
    reportStats()
  }
})
