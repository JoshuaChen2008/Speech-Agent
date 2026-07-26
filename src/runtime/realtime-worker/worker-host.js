'use strict'

// @ts-check

/* realtime worker 的主进程宿主（B2.3）。
   职责：fork utilityProcess、configure、转移 PCM 端口、把 worker 的
   caption/stats 消息路由给订阅者（caption 在边界用契约校验，非法即弃），
   观测退出。不做的事：不接 SessionCoordinator（I2 接线时由 runtime
   adapter 组合本类）、不做自动重启策略（那是 coordinator 的恢复语义）。 */

const path = require('node:path')
const { isCaptionEvent } = require('../../contracts')

const WORKER_PATH = path.join(__dirname, 'realtime-worker.js')

class RealtimeWorkerHost {
  constructor (options = {}) {
    this.electron = options.electron || require('electron')
    this.child = null
    this.captionListeners = new Set()
    this.statsListeners = new Set()
    this.exitListeners = new Set()
    this.lastStats = null
    this.exited = null
    /* 边界丢弃必须可观测：isCaptionEvent 拒绝的事件计数。 */
    this.droppedCaptionCount = 0
    this.disposed = false
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
    const child = this.electron.utilityProcess.fork(WORKER_PATH)
    this.child = child
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
    child.on('exit', (code) => {
      this.exited = { code }
      if (this.child === child) this.child = null
      this.emit(this.exitListeners, { code })
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
      /* 失败路径不留孤儿进程：kill 并复位占位，调用方可重试 start()。 */
      if (this.child === child) this.child = null
      try { child.kill() } catch { /* already exited */ }
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

  kill () {
    if (this.child) {
      try { this.child.kill() } catch { /* already exited */ }
      this.child = null
    }
  }

  dispose () {
    if (this.disposed) return
    this.disposed = true
    this.kill()
    this.captionListeners.clear()
    this.statsListeners.clear()
    this.exitListeners.clear()
  }
}

module.exports = { RealtimeWorkerHost, WORKER_PATH }
