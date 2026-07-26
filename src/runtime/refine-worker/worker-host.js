'use strict'

// @ts-check

/* refine worker 的主进程宿主（B3）。
   职责：fork utilityProcess、configure（同步模型载入由超时覆盖）、把精修
   MessagePort 转移给 worker、观测退出、按需拉取 stats。
   不做的事：不接 SessionCoordinator（由 RealtimeRuntimeAdapter 组合）、
   不做自动重启（精修是增强路径，会话内退出即降级，实时字幕不受影响）。 */

const path = require('node:path')

const WORKER_PATH = path.join(__dirname, 'refine-worker.js')

class RefineWorkerHost {
  constructor (options = {}) {
    this.electron = options.electron || require('electron')
    this.child = null
    this.statsListeners = new Set()
    this.exitListeners = new Set()
    this.lastStats = null
    this.exited = null
    this.disposed = false
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

  /** fork + configure（含同步模型载入）。 */
  async start (config) {
    if (this.disposed) throw new Error('refine worker host is disposed')
    if (this.child) throw new Error('refine worker is already running')
    const child = this.electron.utilityProcess.fork(WORKER_PATH)
    this.child = child
    child.on('message', (message) => {
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
    const configureTimeoutMs = Number.isInteger(config?.configureTimeoutMs) ? config.configureTimeoutMs : 30000
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('refine worker configure timed out')), configureTimeoutMs)
        const onExit = (code) => {
          clearTimeout(timer)
          reject(new Error(`refine worker exited before configuring (code ${code})`))
        }
        child.once('exit', onExit)
        child.once('message', (message) => {
          clearTimeout(timer)
          child.removeListener('exit', onExit)
          if (message?.type === 'configured') resolve()
          else reject(new Error(`refine worker configure failed: ${String(message?.message || message?.type || 'unknown').slice(0, 200)}`))
        })
        child.postMessage({ type: 'configure', model: config.model })
      })
    } catch (error) {
      if (this.child === child) this.child = null
      try { child.kill() } catch { /* already exited */ }
      throw error
    }
  }

  /** 把精修 MessagePortMain 转移给 worker。 */
  attachPort (port) {
    if (!this.child) throw new Error('refine worker is not running')
    this.child.postMessage({ type: 'refine-port' }, [port])
  }

  requestStats () {
    if (this.child) this.child.postMessage({ type: 'report' })
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
    this.statsListeners.clear()
    this.exitListeners.clear()
  }
}

module.exports = { RefineWorkerHost, WORKER_PATH }
