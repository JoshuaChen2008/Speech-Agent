'use strict'

/* refine worker（utilityProcess 入口，B3）。
   职责：configure 时同步载入离线识别器（回 'configured' 前完成，宿主超时
   覆盖）；经主进程转移的 MessagePort 接收 realtime worker 的精修请求
   （{type:'refine', requestId, sampleCount, samples}），逐个同步解码后把
   纯文本结果回给 realtime worker（{type:'refined', requestId, text}）。

   边界（PLAN §4.3）：
   - 本进程只做离线解码。CaptionEvent 的组装、sequence/revision 分配都在
     realtime worker——单一序号权威，精修晚到不会与实时流打架。
   - 队列上限由请求方（realtime worker）持有：它知道积压并可跳过；本进程
     serial 处理到达的请求即可（RTF 0.02，8.6s 音频约 174ms）。
   - 本进程崩溃只丢精修：实时字幕不受影响（adapter 不把 refine 退出算作
     会话故障）。 */

const { assertRefinementOptions, loadOfflineRecognizer, refineSamples } = require('./offline-recognizer')

const state = {
  recognizer: null,
  port: null,
  shuttingDown: false,
  stats: { refined: 0, failed: 0, emptyResults: 0, lastDecodeMs: null }
}

function publish (message) {
  try { process.parentPort.postMessage(message) } catch { /* parent gone */ }
}

function toFloat32 (samples, sampleCount) {
  if (samples instanceof Float32Array) return samples
  if (samples instanceof ArrayBuffer) return new Float32Array(samples)
  if (ArrayBuffer.isView(samples)) {
    return new Float32Array(samples.buffer, samples.byteOffset, Math.floor(samples.byteLength / 4))
  }
  throw new TypeError(`unusable samples payload (${Object.prototype.toString.call(samples)}, expected ${sampleCount} samples)`)
}

function onPortMessage (message) {
  if (message?.type !== 'refine' || !state.recognizer || !state.port) return
  const requestId = message.requestId
  try {
    const samples = toFloat32(message.samples, message.sampleCount)
    const startedAt = Date.now()
    const text = refineSamples(state.recognizer, samples)
    state.stats.lastDecodeMs = Date.now() - startedAt
    if (text.length === 0) state.stats.emptyResults += 1
    state.stats.refined += 1
    state.port.postMessage({ type: 'refined', requestId, text })
  } catch (error) {
    state.stats.failed += 1
    try {
      state.port.postMessage({ type: 'refine-failed', requestId, message: String(error?.message || error).slice(0, 200) })
    } catch { /* port closing */ }
  }
}

function shutdown () {
  if (state.shuttingDown) return
  state.shuttingDown = true
  const port = state.port
  state.port = null
  if (port) {
    try { port.close() } catch { /* already closed */ }
  }
  /* sherpa 的 JS wrapper 没有显式 destroy；释放最后一个 JS 引用后由
     utility process 的正常 teardown 回收 native handle。 */
  state.recognizer = null
  publish({ type: 'stopped' })
  setImmediate(() => process.exit(0))
}

process.parentPort.on('message', (event) => {
  const message = event.data
  if (message?.type === 'shutdown') {
    shutdown()
  } else if (state.shuttingDown) {
    return
  } else if (message?.type === 'configure') {
    if (state.recognizer) {
      publish({ type: 'configure-failed', message: 'refine worker is already configured' })
      return
    }
    try {
      const options = assertRefinementOptions(message.model)
      state.recognizer = loadOfflineRecognizer(options)
      publish({ type: 'configured' })
    } catch (error) {
      publish({ type: 'configure-failed', message: String(error?.message || error).slice(0, 200) })
    }
  } else if (message?.type === 'refine-port') {
    if (event.ports && event.ports[0]) {
      if (state.port) { try { state.port.close() } catch { /* already closed */ } }
      state.port = event.ports[0]
      state.port.on('message', (portEvent) => onPortMessage(portEvent.data))
      state.port.start()
    }
  } else if (message?.type === 'report') {
    publish({ type: 'stats', stats: { ...state.stats } })
  }
})
