'use strict'

// @ts-check

/* 默认产品组合根的可测试生命周期。
   -------------------------------------------------------------------------
   冷启动顺序被冻结为：storage worker 就绪 → 收束上次崩溃会话 → 迁移旧
   JSONL → 创建 SQLite recorder → 创建 SessionCoordinator。默认运行期只写
   SQLite；legacyDirectory 只作为只读迁移输入，不创建 JSONL 双写器。 */

const path = require('node:path')
const { JsonlSqliteMigrator } = require('./jsonl-sqlite-migrator')
const { SqliteSessionRecorder } = require('./sqlite-session-recorder')
const { StorageGateway } = require('./storage-gateway')

/* Approved model transitions and native utility graceful shutdown each allow
   up to 30 seconds.  The application deadline must also cover the separate
   five-second exact-child reap phase plus storage/renderer handoff margin. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 45000

function epochMilliseconds (value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be epoch milliseconds`)
  }
  return value
}

function positiveTimeout (value) {
  if (!Number.isInteger(value) || value < 1 || value > 60000) {
    throw new RangeError('shutdown timeout must be between 1 and 60000 milliseconds')
  }
  return value
}

function assertGateway (gateway) {
  const methods = [
    'start',
    'recoverStaleSessions',
    'importLegacyJsonl',
    'getSessionTranscript',
    'openSession',
    'appendCaption',
    'closeSession',
    'flush',
    'retry',
    'shutdown',
    'terminate'
  ]
  if (!gateway || methods.some((method) => typeof gateway[method] !== 'function')) {
    throw new TypeError('gatewayFactory must return a complete StorageGateway-compatible object')
  }
  return gateway
}

function assertRecorder (recorder) {
  const methods = ['openSession', 'acceptCaption', 'closeSession', 'retry', 'flush']
  if (!recorder || methods.some((method) => typeof recorder[method] !== 'function')) {
    throw new TypeError('recorderFactory must return a SQLite persistence sink')
  }
  return recorder
}

function assertCoordinator (coordinator) {
  if (!coordinator || typeof coordinator.shutdownForAppQuit !== 'function' ||
      typeof coordinator.dispose !== 'function') {
    throw new TypeError('coordinatorFactory must return an application-lifecycle coordinator')
  }
  return coordinator
}

class SubtitleApplicationRuntime {
  constructor (options = {}) {
    if (typeof options.userDataDir !== 'string' || !path.isAbsolute(options.userDataDir)) {
      throw new TypeError('userDataDir must be absolute')
    }
    if (typeof options.coordinatorFactory !== 'function') {
      throw new TypeError('coordinatorFactory is required')
    }
    for (const name of ['gatewayFactory', 'migratorFactory', 'recorderFactory']) {
      if (options[name] !== undefined && typeof options[name] !== 'function') {
        throw new TypeError(`${name} must be a function`)
      }
    }

    this.userDataDir = path.resolve(options.userDataDir)
    this.databasePath = options.databasePath || path.join(this.userDataDir, 'data', 'speech-agent.sqlite3')
    this.legacyDirectory = options.legacyDirectory || path.join(this.userDataDir, 'sessions')
    if (!path.isAbsolute(this.databasePath) || !path.isAbsolute(this.legacyDirectory)) {
      throw new TypeError('databasePath and legacyDirectory must be absolute')
    }
    this.coordinatorFactory = options.coordinatorFactory
    this.gatewayFactory = options.gatewayFactory || ((gatewayOptions) => new StorageGateway(gatewayOptions))
    this.migratorFactory = options.migratorFactory || ((migratorOptions) => new JsonlSqliteMigrator(migratorOptions))
    this.recorderFactory = options.recorderFactory || ((recorderOptions) => new SqliteSessionRecorder(recorderOptions))
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.onError = typeof options.onError === 'function' ? options.onError : () => {}
    this.onStorageUtilityFatal = typeof options.onStorageUtilityFatal === 'function'
      ? options.onStorageUtilityFatal
      : () => {}

    this.state = 'new'
    this.gateway = null
    this.recorder = null
    this.coordinator = null
    this.recoveryReport = null
    this.migrationReports = Object.freeze([])
    this.startPromise = null
    this.shutdownPromise = null
    this.terminationPromise = null
    this.terminationRequested = false
  }

  assertStartupActive () {
    if (this.terminationRequested || this.state === 'stopping' || this.state === 'stopped') {
      const error = new Error('subtitle application startup was terminated')
      error.code = 'APPLICATION_START_ABORTED'
      throw error
    }
  }

  start () {
    if (this.startPromise) return this.startPromise
    if (this.state !== 'new') return Promise.reject(new Error('subtitle application runtime cannot be restarted'))
    this.state = 'starting'
    this.startPromise = this.startApplication()
    return this.startPromise
  }

  async startApplication () {
    try {
      this.assertStartupActive()
      const recoveredAt = epochMilliseconds(this.now(), 'startup clock')
      this.gateway = assertGateway(this.gatewayFactory({
        databasePath: this.databasePath,
        onFatalError: this.onStorageUtilityFatal
      }))
      await this.gateway.start()
      this.assertStartupActive()
      this.recoveryReport = structuredClone(await this.gateway.recoverStaleSessions({ recoveredAt }))
      this.assertStartupActive()

      const migrator = this.migratorFactory({ gateway: this.gateway, now: this.now })
      if (!migrator || typeof migrator.migrateDirectory !== 'function') {
        throw new TypeError('migratorFactory must return a JsonlSqliteMigrator-compatible object')
      }
      this.migrationReports = Object.freeze(
        structuredClone(await migrator.migrateDirectory(this.legacyDirectory))
      )
      this.assertStartupActive()

      this.recorder = assertRecorder(this.recorderFactory({
        gateway: this.gateway,
        now: this.now,
        onError: this.onError
      }))
      this.coordinator = assertCoordinator(this.coordinatorFactory({
        persistenceSink: this.recorder
      }))
      this.assertStartupActive()
      this.state = 'running'
      return Object.freeze({
        coordinator: this.coordinator,
        databasePath: this.databasePath,
        legacyDirectory: this.legacyDirectory,
        recoveryReport: structuredClone(this.recoveryReport),
        migrationReports: structuredClone(this.migrationReports)
      })
    } catch (error) {
      try { this.onError(error) } catch { /* observer failures stay isolated */ }
      await this.terminate()
      throw error
    }
  }

  shutdown () {
    /* Quit is monotonic even when it arrives during startup.  Every awaited
       startup stage checks this flag before it can publish a recorder or
       coordinator, so a fast migration cannot briefly revive product roots. */
    this.terminationRequested = true
    if (this.shutdownPromise) return this.shutdownPromise
    if (this.state === 'stopped') return Promise.resolve()
    this.shutdownPromise = this.shutdownApplication()
    return this.shutdownPromise
  }

  async shutdownApplication () {
    if (this.state === 'starting' && this.startPromise) {
      try {
        await this.startPromise
      } catch (error) {
        if (this.terminationRequested && error?.code === 'APPLICATION_START_ABORTED') {
          if (this.terminationPromise) await this.terminationPromise
          return
        }
        throw error
      }
    }
    if (this.state === 'stopped') return
    this.state = 'stopping'
    if (this.coordinator) await this.coordinator.shutdownForAppQuit()
    /* A bounded shutdown may have escalated while the coordinator was still
       yielding from native work.  Join that one termination instead of later
       running flush/shutdown a second time against already terminated roots. */
    if (this.terminationPromise) {
      await this.terminationPromise
      return
    }
    if (this.recorder) await this.recorder.flush()
    if (this.terminationPromise) {
      await this.terminationPromise
      return
    }
    if (this.gateway) await this.gateway.shutdown()
    this.state = 'stopped'
  }

  async shutdownWithin (timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS) {
    const timeout = positiveTimeout(timeoutMs)
    let timer = null
    let timedOut = false
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        const error = new Error('subtitle application shutdown timed out')
        error.code = 'SHUTDOWN_TIMEOUT'
        reject(error)
      }, timeout)
    })
    try {
      await Promise.race([this.shutdown(), deadline])
      return Object.freeze({ graceful: true, reason: null })
    } catch (error) {
      try { this.onError(error) } catch { /* observer failures stay isolated */ }
      await this.terminate()
      return Object.freeze({
        graceful: false,
        reason: timedOut ? 'SHUTDOWN_TIMEOUT' : 'SHUTDOWN_FAILED'
      })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  terminate () {
    this.terminationRequested = true
    if (this.terminationPromise) return this.terminationPromise
    if (this.state !== 'stopped') this.state = 'stopping'
    this.terminationPromise = this.terminateApplication()
    return this.terminationPromise
  }

  async terminateApplication () {
    const tasks = []
    if (this.gateway) tasks.push(Promise.resolve().then(() => this.gateway.terminate()))
    if (this.coordinator) tasks.push(Promise.resolve().then(() => this.coordinator.dispose()))
    const results = await Promise.allSettled(tasks)
    const rejected = results.filter((result) => result.status === 'rejected')
    for (const result of rejected) {
      try { this.onError(result.reason) } catch { /* observer failures stay isolated */ }
    }
    /* An unreaped exact child is not a completed termination.  Propagate the
       first failure so main must keep before-quit prevented; state stays
       stopping and no replacement/start path can treat this runtime as dead. */
    if (rejected.length > 0) throw rejected[0].reason
    this.state = 'stopped'
    return Object.freeze({ terminated: true, errorCount: 0 })
  }
}

module.exports = {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  SubtitleApplicationRuntime
}
