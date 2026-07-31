'use strict'

// @ts-check

/* refine worker 的主进程宿主（B3）。
   职责：fork utilityProcess、configure（同步模型载入由超时覆盖）、把精修
   MessagePort 转移给 worker、观测退出、按需拉取 stats。
   不做的事：不接 SessionCoordinator（由 RealtimeRuntimeAdapter 组合）、
   不做自动重启（精修是增强路径，会话内退出即降级，实时字幕不受影响）。 */

const path = require('node:path')

const WORKER_PATH = path.join(__dirname, 'refine-worker.js')
const SERVICE_NAME = 'Speech Agent offline refinement'
/* Offline decode is synchronous in the utility process.  Give it a bounded
   chance to yield and consume the shutdown message before escalating to an
   exact-child kill and reap. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30000
const DEFAULT_FORCE_KILL_TIMEOUT_MS = 5000

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

class RefineWorkerHost {
  constructor (options = {}) {
    this.electron = options.electron || require('electron')
    this.child = null
    this.statsListeners = new Set()
    this.exitListeners = new Set()
    this.lastStats = null
    this.exited = null
    this.childExit = null
    this.shutdownPromise = null
    this.terminatePromise = null
    this.terminationChild = null
    this.onFatalError = typeof options.onFatalError === 'function' ? options.onFatalError : () => {}
    this.disposed = false
  }

  installChild (child) {
    let resolveExit
    const exitPromise = new Promise((resolve) => { resolveExit = resolve })
    this.childExit = { child, promise: exitPromise }
    child.on('error', () => {
      try { this.onFatalError(Object.freeze({ role: 'offline-refinement', type: 'FatalError' })) } catch { /* observer isolation */ }
    })
    child.once('exit', (code) => {
      this.exited = { code }
      if (this.child === child) this.child = null
      this.emit(this.exitListeners, { code })
      resolveExit(code)
    })
    return this.childExit
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
    const child = this.electron.utilityProcess.fork(WORKER_PATH, [], { serviceName: SERVICE_NAME })
    this.child = child
    this.installChild(child)
    child.on('message', (message) => {
      if (message?.type === 'stats') {
        this.lastStats = message.stats
        this.emit(this.statsListeners, message.stats)
      }
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
      try {
        await this.shutdown()
      } catch (cleanupError) {
        if (cleanupError instanceof Error && cleanupError.cause === undefined) {
          try { cleanupError.cause = error } catch { /* immutable error */ }
        }
        throw cleanupError
      }
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

  waitForChildExit (child, timeoutMs) {
    const record = this.childExit?.child === child ? this.childExit : null
    if (!record) return Promise.resolve(this.exited?.code ?? null)
    return waitWithTimeout(record.promise, positiveTimeout(timeoutMs), 'refine worker exit timed out')
  }

  async terminateChildAndWait (child, timeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS) {
    const record = this.childExit?.child === child ? this.childExit : null
    if (!record) return this.exited?.code ?? null
    if (this.terminationChild !== child) {
      try {
        child.kill()
        this.terminationChild = child
      } catch { /* a later join may retry an unissued termination */ }
    }
    return this.waitForChildExit(child, timeoutMs)
  }

  waitForExactExit () {
    return this.childExit?.promise || Promise.resolve(this.exited?.code ?? null)
  }

  shutdown (timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS, forceKillTimeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS) {
    if (this.shutdownPromise) return this.shutdownPromise
    this.disposed = true
    this.shutdownPromise = this.shutdownGeneration(
      positiveTimeout(timeoutMs),
      positiveTimeout(forceKillTimeoutMs)
    )
    return this.shutdownPromise
  }

  async shutdownGeneration (timeoutMs, forceKillTimeoutMs) {
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
        exitCode = await this.terminateAndWait(forceKillTimeoutMs)
      } catch {
        reason = 'TERMINATION_TIMEOUT'
      }
    }
    if (reason === 'TERMINATION_TIMEOUT') {
      this.clearListeners()
      const error = new Error('refine worker termination timed out')
      error.code = 'UTILITY_TERMINATION_TIMEOUT'
      throw error
    }
    this.clearListeners()
    return Object.freeze({ graceful: reason === null, reason, exitCode })
  }

  terminateAndWait (timeoutMs = DEFAULT_FORCE_KILL_TIMEOUT_MS) {
    if (this.terminatePromise) return this.terminatePromise
    this.disposed = true
    const timeout = positiveTimeout(timeoutMs)
    const promise = (async () => {
      const child = this.child
      const exitCode = child ? await this.terminateChildAndWait(child, timeout) : (this.exited?.code ?? null)
      this.clearListeners()
      return exitCode
    })()
    this.terminatePromise = promise
    promise.then(
      () => { if (this.terminatePromise === promise) this.terminatePromise = null },
      () => { if (this.terminatePromise === promise) this.terminatePromise = null }
    )
    return promise
  }

  clearListeners () {
    this.statsListeners.clear()
    this.exitListeners.clear()
  }

  dispose () {
    return this.shutdown()
  }
}

module.exports = {
  DEFAULT_FORCE_KILL_TIMEOUT_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  RefineWorkerHost,
  SERVICE_NAME,
  WORKER_PATH
}
