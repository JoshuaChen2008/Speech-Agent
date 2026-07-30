'use strict'

// @ts-check

/* realtime worker 的主进程宿主（B2.3）。
   职责：fork utilityProcess、configure、转移 PCM 端口、把 worker 的
   caption/stats 消息路由给订阅者（caption 在边界用契约校验，非法即弃），
   观测退出。不做的事：不接 SessionCoordinator（I2 接线时由 runtime
   adapter 组合本类）、不做自动重启策略（那是 coordinator 的恢复语义）。 */

const path = require('node:path')
const { assertSingleSourceIds, isCaptionEvent } = require('../../contracts')

const WORKER_PATH = path.join(__dirname, 'realtime-worker.js')
const SERVICE_NAME = 'Speech Agent realtime ASR'
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2000

function positiveTimeout (value) {
  if (!Number.isInteger(value) || value < 1) throw new RangeError('timeoutMs must be a positive integer')
  return value
}

function waitWithTimeout (promise, timeoutMs, message) {
  let timer = null
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    })
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

class RealtimeWorkerHost {
  constructor (options = {}) {
    this.electron = options.electron || require('electron')
    this.child = null
    this.captionListeners = new Set()
    this.statsListeners = new Set()
    this.exitListeners = new Set()
    this.lastStats = null
    this.exited = null
    this.childExit = null
    this.shutdownPromise = null
    this.terminatePromise = null
    this.onFatalError = typeof options.onFatalError === 'function' ? options.onFatalError : () => {}
    /* 边界丢弃必须可观测：isCaptionEvent 拒绝的事件计数。 */
    this.droppedCaptionCount = 0
    this.disposed = false
  }

  installChild (child) {
    let resolveExit
    const exitPromise = new Promise((resolve) => { resolveExit = resolve })
    this.childExit = { child, promise: exitPromise }
    /* Electron 的 UtilityProcess error 不是普通业务错误，而是即将终止的
       V8 fatal。必须注册 listener，避免 EventEmitter 把未监听的 error
       继续抛向主进程；diagnostic 只保留固定角色/类型，绝不转存 report、
       location、路径、字幕或 PCM。最终状态仍由紧随其后的 exit 统一收束。 */
    child.on('error', () => {
      try { this.onFatalError(Object.freeze({ role: 'realtime-asr', type: 'FatalError' })) } catch { /* observer isolation */ }
    })
    child.once('exit', (code) => {
      this.exited = { code }
      if (this.child === child) this.child = null
      this.emit(this.exitListeners, { code })
      resolveExit(code)
    })
    return this.childExit
  }

  onCaption (listener) {
    this.captionListeners.add(listener)
    return () => this.captionListeners.delete(listener)
  }

  onStats (listener) {
    this.statsListeners.add(listener)
    return () => this.statsListeners.delete(listener)
  }

  onExit (listener) {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  emit (listeners, value) {
    for (const listener of listeners) {
      try { listener(value) } catch { /* observer failures stay isolated */ }
    }
  }

  /**
   * fork + configure。@returns {Promise<void>} configure 完成
   */
  async start (config) {
    if (this.disposed) throw new Error('worker host is disposed')
    if (this.child) throw new Error('worker is already running')
    if (!config || typeof config.sessionId !== 'string' || config.sessionId.length === 0) {
      throw new TypeError('sessionId is required')
    }
    assertSingleSourceIds(config.sourceIds)
    const child = this.electron.utilityProcess.fork(WORKER_PATH, [], { serviceName: SERVICE_NAME })
    this.child = child
    this.installChild(child)
    child.on('message', (message) => {
      if (message?.type === 'caption') {
        /* 契约边界：worker 是独立进程，事件先过 isCaptionEvent 再进主进程
           路由；非法事件丢弃并计数（coordinator 的 acceptCaption 还会再守一层）。 */
        if (isCaptionEvent(message.event)) this.emit(this.captionListeners, message.event)
        else this.droppedCaptionCount += 1
        return
      }
      if (message?.type === 'stats') {
        this.lastStats = message.stats
        this.emit(this.statsListeners, message.stats)
      }
    })
    /* 真实 recognizer 的 configure 包含同步模型载入（int8 encoder 秒级），
       超时相应放宽；结构/null 路径维持快失败。 */
    const configureTimeoutMs = Number.isInteger(config?.configureTimeoutMs)
      ? config.configureTimeoutMs
      : (config?.recognizer ? 30000 : 5000)
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('worker configure timed out')), configureTimeoutMs)
        const onExit = (code) => {
          clearTimeout(timer)
          reject(new Error(`worker exited before configuring (code ${code})`))
        }
        child.once('exit', onExit)
        child.once('message', (message) => {
          clearTimeout(timer)
          child.removeListener('exit', onExit)
          if (message?.type === 'configured') resolve()
          else reject(new Error(`worker configure failed: ${String(message?.message || message?.type || 'unknown').slice(0, 200)}`))
        })
        child.postMessage({ type: 'configure', ...config })
      })
    } catch (error) {
      /* 配置失败也要等待旧世代退出；否则下一次 start 或应用退出可能与
         尚在释放 sherpa/ONNX 原生资源的旧进程重叠。原始配置错误优先。 */
      try { await this.terminateChildAndWait(child, DEFAULT_SHUTDOWN_TIMEOUT_MS) } catch { /* original error wins */ }
      throw error
    }
  }

  /** 把 MessagePortMain 转移给 worker（PCM 直通端）。 */
  attachPort (port) {
    if (!this.child) throw new Error('worker is not running')
    this.child.postMessage({ type: 'pcm-port' }, [port])
  }

  /** 把精修 MessagePortMain 转移给 worker（B3：与 refine worker 直连）。 */
  attachRefinePort (port) {
    if (!this.child) throw new Error('worker is not running')
    this.child.postMessage({ type: 'refine-port' }, [port])
  }

  requestStats () {
    if (this.child) this.child.postMessage({ type: 'report' })
  }

  /**
   * v1 暂停语义透传：worker 先 flush 当前段（final 经有序的 parentPort 先于
   * ack 到达并在 listening 相位被接受），再回 ack——await ack 保证 coordinator
   * 发布 paused 快照时定稿已交付，不会被 paused 相位拒收。
   * 死 worker 时抛错，让 coordinator 的迁移失败路径接管（不静默"成功"）。
   */
  pause () {
    return this.transact('pause', 'paused')
  }

  resume () {
    return this.transact('resume', 'resumed')
  }

  transact (type, ack, timeoutMs = 2000) {
    const child = this.child
    if (!child) return Promise.reject(new Error(`worker is not running (${type})`))
    return new Promise((resolve, reject) => {
      const onMessage = (message) => {
        if (message?.type === ack) { cleanup(); resolve() }
      }
      const onExit = (code) => { cleanup(); reject(new Error(`worker exited during ${type} (code ${code})`)) }
      const timer = setTimeout(() => { cleanup(); reject(new Error(`worker ${type} timed out`)) }, timeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        child.removeListener('message', onMessage)
        child.removeListener('exit', onExit)
      }
      child.on('message', onMessage)
      child.once('exit', onExit)
      child.postMessage({ type })
    })
  }

  /** stop 收尾的确定性信号：worker 处理完 'end'（flush 完毕）会上报
      endReceived=true 的 stats；等它（带上限）而不是猜一个 sleep。 */
  waitForEnd (timeoutMs = 800) {
    if (this.lastStats?.endReceived) return Promise.resolve(true)
    const child = this.child
    if (!child) return Promise.resolve(false)
    return new Promise((resolve) => {
      const onMessage = (message) => {
        if (message?.type === 'stats' && message.stats?.endReceived) { cleanup(); resolve(true) }
      }
      const onExit = () => { cleanup(); resolve(false) }
      const timer = setTimeout(() => { cleanup(); resolve(false) }, timeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        child.removeListener('message', onMessage)
        child.removeListener('exit', onExit)
      }
      child.on('message', onMessage)
      child.once('exit', onExit)
    })
  }

  waitForChildExit (child, timeoutMs) {
    const record = this.childExit?.child === child ? this.childExit : null
    if (!record) return Promise.resolve(this.exited?.code ?? null)
    return waitWithTimeout(record.promise, positiveTimeout(timeoutMs), 'realtime worker exit timed out')
  }

  async terminateChildAndWait (child, timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) {
    const record = this.childExit?.child === child ? this.childExit : null
    if (!record) return this.exited?.code ?? null
    try { child.kill() } catch { /* exit promise decides the outcome */ }
    return this.waitForChildExit(child, timeoutMs)
  }

  shutdown (timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) {
    if (this.shutdownPromise) return this.shutdownPromise
    this.disposed = true
    this.shutdownPromise = this.shutdownGeneration(positiveTimeout(timeoutMs))
    return this.shutdownPromise
  }

  async shutdownGeneration (timeoutMs) {
    const child = this.child
    if (!child) {
      this.clearListeners()
      return Object.freeze({ graceful: true, reason: null, exitCode: this.exited?.code ?? null })
    }
    let reason = null
    let exitCode = null
    try {
      child.postMessage({ type: 'shutdown' })
      exitCode = await this.waitForChildExit(child, timeoutMs)
      if (exitCode !== 0) reason = 'WORKER_EXITED'
    } catch (error) {
      reason = /timed out/i.test(String(error?.message || ''))
        ? 'SHUTDOWN_TIMEOUT'
        : 'SHUTDOWN_REQUEST_FAILED'
    }
    if (reason && this.child === child) {
      try {
        exitCode = await this.terminateChildAndWait(child, timeoutMs)
      } catch {
        reason = 'TERMINATION_TIMEOUT'
      }
    }
    if (reason === 'TERMINATION_TIMEOUT') {
      this.clearListeners()
      const error = new Error('realtime worker termination timed out')
      error.code = 'UTILITY_TERMINATION_TIMEOUT'
      throw error
    }
    this.clearListeners()
    return Object.freeze({ graceful: reason === null, reason, exitCode })
  }

  terminateAndWait (timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) {
    if (this.terminatePromise) return this.terminatePromise
    this.disposed = true
    const timeout = positiveTimeout(timeoutMs)
    this.terminatePromise = (async () => {
      const child = this.child
      const exitCode = child ? await this.terminateChildAndWait(child, timeout) : (this.exited?.code ?? null)
      this.clearListeners()
      return exitCode
    })()
    return this.terminatePromise
  }

  clearListeners () {
    this.captionListeners.clear()
    this.statsListeners.clear()
    this.exitListeners.clear()
  }

  dispose () {
    return this.terminateAndWait()
  }
}

module.exports = {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  RealtimeWorkerHost,
  SERVICE_NAME,
  WORKER_PATH
}
