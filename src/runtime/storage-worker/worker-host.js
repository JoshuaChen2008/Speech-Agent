'use strict'

// @ts-check

/* Electron main 侧的单-generation storage utility host。
   --------------------------------------------------------------------------
   本类只负责一个时刻至多一个精确子进程、严格 request/response 关联、单 FIFO
   和可等待清理。跨 generation 的自动重启与幂等重放由上层 StorageGateway
   负责；因此任何结果未知的传输故障都会使当前 generation fail closed。 */

const path = require('node:path')
const {
  OPERATIONS,
  PROTOCOL_VERSION,
  SAFE_ERROR_MESSAGES,
  StorageError,
  isPlainObject,
  makeCaptionEventId,
  makeCloseSessionKey,
  makeLegacyImportKey,
  makeOpenSessionKey,
  makeRefinementFaultKey
} = require('./protocol')

const WORKER_PATH = path.join(__dirname, 'storage-worker.js')
const SERVICE_NAME = 'Speech Agent subtitle storage'

class StorageTransportError extends Error {
  constructor (code, message, options = {}) {
    super(message)
    this.name = 'StorageTransportError'
    this.code = code
    this.transport = true
    this.outcome = options.outcome || 'unknown'
    if (options.cause !== undefined) this.cause = options.cause
  }
}

function isStorageTransportError (error) {
  return error instanceof StorageTransportError
}

function hasExactKeys (value, expected) {
  if (!isPlainObject(value)) return false
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function responseError (operation, cause) {
  return new StorageTransportError(
    'INVALID_RESPONSE',
    `Storage worker returned an invalid response (${operation}).`,
    { outcome: 'unknown', cause }
  )
}

function validateResponse (message, requestId, operation) {
  if (!isPlainObject(message) ||
      message.version !== PROTOCOL_VERSION ||
      message.type !== 'storage:response' ||
      message.requestId !== requestId ||
      typeof message.ok !== 'boolean') {
    throw responseError(operation)
  }

  if (message.ok) {
    if (!hasExactKeys(message, ['version', 'type', 'requestId', 'ok', 'result'])) {
      throw responseError(operation)
    }
    return { ok: true, result: message.result }
  }

  if (!hasExactKeys(message, ['version', 'type', 'requestId', 'ok', 'error']) ||
      !hasExactKeys(message.error, ['code', 'message']) ||
      typeof message.error.code !== 'string' ||
      typeof message.error.message !== 'string' ||
      !Object.hasOwn(SAFE_ERROR_MESSAGES, message.error.code) ||
      message.error.message !== SAFE_ERROR_MESSAGES[message.error.code]) {
    throw responseError(operation)
  }
  return { ok: false, error: new StorageError(message.error.code) }
}

function positiveTimeout (value, fallback) {
  const timeout = value === undefined ? fallback : value
  if (!Number.isInteger(timeout) || timeout < 1) {
    throw new RangeError('timeoutMs must be a positive integer')
  }
  return timeout
}

function waitWithTimeout (promise, timeoutMs, errorFactory) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(errorFactory())
    }, timeoutMs)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

class StorageWorkerHost {
  constructor (options = {}) {
    if (typeof options.databasePath !== 'string' || !path.isAbsolute(options.databasePath)) {
      throw new TypeError('databasePath must be absolute')
    }
    this.electron = options.electron || require('electron')
    this.databasePath = options.databasePath
    this.workerPath = options.workerPath || WORKER_PATH
    this.requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, 5000)
    this.child = null
    this.childExit = null
    this.exitPromise = null
    this.tail = Promise.resolve()
    this.counter = 0
    this.generation = 0
    this.state = 'stopped'
    this.closing = false
    this.startPromise = null
    this.shutdownPromise = null
    this.terminatePromise = null
    this.terminationChild = null
    this.onFatalError = typeof options.onFatalError === 'function' ? options.onFatalError : () => {}
  }

  stateError (code = 'HOST_NOT_READY') {
    const messages = {
      HOST_NOT_READY: 'Storage worker host is not ready.',
      HOST_SHUTTING_DOWN: 'Storage worker host is shutting down.',
      HOST_GENERATION_FAILED: 'Storage worker generation must be replaced.'
    }
    return new StorageTransportError(code, messages[code], { outcome: 'not_sent' })
  }

  noteTransportFailure (child) {
    if (this.child !== child) return
    const previousState = this.state
    this.state = 'failed'
    /* start 中的所有并发调用仍需共享原 initialize Promise；ready generation
       的 promise 则必须失效，避免后续 start() 把旧世代当成已就绪。 */
    if (this.startPromise && previousState !== 'starting') this.startPromise = null
  }

  installChild (child) {
    let resolveExit
    const exitPromise = new Promise((resolve) => { resolveExit = resolve })
    const record = { child, promise: exitPromise }
    this.childExit = record
    this.exitPromise = exitPromise
    /* A UtilityProcess V8 fatal emits `error` before `exit`. Consume the
       EventEmitter error so it cannot escape into the Electron main process;
       never retain Electron's diagnostic report or source location because it
       may include user paths or transcript memory. */
    child.on('error', () => {
      try { this.onFatalError(Object.freeze({ role: 'subtitle-storage', type: 'FatalError' })) } catch { /* observer isolation */ }
    })
    child.once('exit', (code) => {
      if (this.child === child) {
        const previousState = this.state
        this.child = null
        this.state = this.closing ? 'stopped' : 'failed'
        if (previousState !== 'starting') this.startPromise = null
      }
      resolveExit(code)
    })
    return record
  }

  start () {
    if (this.closing) return Promise.reject(this.stateError('HOST_SHUTTING_DOWN'))
    if (this.startPromise) return this.startPromise
    if (this.child) return Promise.reject(this.stateError('HOST_GENERATION_FAILED'))

    const promise = this.startGeneration()
    this.startPromise = promise
    promise.then(
      () => {},
      () => {
        if (this.startPromise === promise) this.startPromise = null
      }
    )
    return promise
  }

  async startGeneration () {
    this.state = 'starting'
    let child
    try {
      child = this.electron.utilityProcess.fork(this.workerPath, [], {
        serviceName: SERVICE_NAME
      })
    } catch (cause) {
      this.state = 'failed'
      throw new StorageTransportError(
        'WORKER_FORK_FAILED',
        'Storage worker could not be started.',
        { outcome: 'not_sent', cause }
      )
    }

    this.child = child
    this.generation += 1
    this.installChild(child)
    try {
      await this.perform(OPERATIONS.INITIALIZE, { databasePath: this.databasePath })
      if (this.child !== child) {
        throw new StorageTransportError(
          'WORKER_EXITED',
          'Storage worker exited while initializing.',
          { outcome: 'unknown' }
        )
      }
      this.state = 'ready'
    } catch (error) {
      this.state = 'failed'
      try {
        /* Startup failure and application quit may race while SQLite is still
           initializing.  Share the one exact-child termination promise so
           neither path can issue a second kill or outlive the other. */
        await this.terminateAndWait(this.requestTimeoutMs)
      } catch (terminationError) {
        if (isStorageTransportError(terminationError)) {
          terminationError.cause = error
          throw terminationError
        }
        throw error
      }
      throw error
    }
  }

  enqueue (operation, payload, idempotencyKey) {
    if (this.closing) return Promise.reject(this.stateError('HOST_SHUTTING_DOWN'))
    const readiness = this.state === 'starting' ? this.startPromise : null
    const task = this.tail.then(async () => {
      if (readiness) await readiness
      if (!this.child || this.state !== 'ready') throw this.stateError()
      return this.perform(operation, payload, idempotencyKey)
    })
    this.tail = task.catch(() => {})
    return task
  }

  perform (operation, payload, idempotencyKey) {
    const child = this.child
    const allowed = child && (
      this.state === 'ready' ||
      (this.state === 'starting' && operation === OPERATIONS.INITIALIZE) ||
      (this.state === 'stopping' && operation === OPERATIONS.SHUTDOWN)
    )
    if (!allowed) return Promise.reject(this.stateError())

    const requestId = `storage-${this.generation}-${++this.counter}`
    return new Promise((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timer)
        child.removeListener('message', onMessage)
        child.removeListener('exit', onExit)
      }
      const failTransport = (error) => {
        if (settled) return
        settled = true
        cleanup()
        this.noteTransportFailure(child)
        reject(error)
      }
      const timer = setTimeout(() => {
        failTransport(new StorageTransportError(
          'REQUEST_TIMEOUT',
          `Storage worker request timed out (${operation}).`,
          { outcome: 'unknown' }
        ))
      }, this.requestTimeoutMs)
      const onMessage = (message) => {
        if (settled) return
        let response
        try {
          response = validateResponse(message, requestId, operation)
        } catch (error) {
          failTransport(error)
          return
        }
        settled = true
        cleanup()
        if (response.ok) resolve(response.result)
        else reject(response.error)
      }
      const onExit = (code) => {
        failTransport(new StorageTransportError(
          'WORKER_EXITED',
          `Storage worker exited during ${operation} (code ${code}).`,
          { outcome: 'unknown' }
        ))
      }
      child.on('message', onMessage)
      child.once('exit', onExit)
      const request = {
        version: PROTOCOL_VERSION,
        type: 'storage:request',
        requestId,
        operation,
        payload
      }
      if (idempotencyKey !== undefined) request.idempotencyKey = idempotencyKey
      try {
        child.postMessage(request)
      } catch (cause) {
        failTransport(new StorageTransportError(
          'POST_MESSAGE_FAILED',
          `Storage worker request could not be sent (${operation}).`,
          { outcome: 'not_sent', cause }
        ))
      }
    })
  }

  openSession (input) {
    return this.enqueue(OPERATIONS.OPEN_SESSION, input, makeOpenSessionKey(input?.sessionId))
  }

  appendCaption (event) {
    return this.enqueue(OPERATIONS.APPEND_CAPTION, { event }, makeCaptionEventId(event || {}))
  }

  closeSession (input) {
    return this.enqueue(OPERATIONS.CLOSE_SESSION, input, makeCloseSessionKey(input?.sessionId))
  }

  recordRefinementFault (input) {
    return this.enqueue(
      OPERATIONS.RECORD_REFINEMENT_FAULT,
      input,
      makeRefinementFaultKey(input?.sessionId, input?.faultCode)
    )
  }

  recoverStaleSessions (input) {
    return this.enqueue(OPERATIONS.RECOVER_STALE_SESSIONS, input)
  }

  importLegacyJsonl (input) {
    return this.enqueue(OPERATIONS.IMPORT_LEGACY_JSONL, input, makeLegacyImportKey(input?.sourceSha256))
  }

  getSessionTranscript (sessionId) {
    return this.enqueue(OPERATIONS.GET_SESSION, { sessionId })
  }

  getSessionPage (input) {
    return this.enqueue(OPERATIONS.GET_SESSION_PAGE, input)
  }

  listSessions (input) {
    return this.enqueue(OPERATIONS.LIST_SESSIONS, input)
  }

  getStats () {
    return this.enqueue(OPERATIONS.GET_STATS, {})
  }

  evaluateAgentEligibility (input) {
    return this.enqueue(OPERATIONS.AGENT_EVALUATE_ELIGIBILITY, input)
  }

  reconcileTerminalAgentSession (input) {
    return this.enqueue(OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION, input)
  }

  readAgentInputSnapshot (input) {
    return this.enqueue(OPERATIONS.AGENT_READ_INPUT_SNAPSHOT, input)
  }

  requestAgentJob (input) {
    return this.enqueue(OPERATIONS.AGENT_REQUEST_JOB, input)
  }

  claimNextAgentJob (input) {
    return this.enqueue(OPERATIONS.AGENT_CLAIM_NEXT_JOB, input)
  }

  renewAgentJobLease (input) {
    return this.enqueue(OPERATIONS.AGENT_RENEW_JOB_LEASE, input)
  }

  markAgentJobRetry (input) {
    return this.enqueue(OPERATIONS.AGENT_MARK_JOB_RETRY, input)
  }

  markAgentJobFailed (input) {
    return this.enqueue(OPERATIONS.AGENT_MARK_JOB_FAILED, input)
  }

  requestAgentCancel (input) {
    return this.enqueue(OPERATIONS.AGENT_REQUEST_CANCEL, input)
  }

  markAgentJobCancelled (input) {
    return this.enqueue(OPERATIONS.AGENT_MARK_JOB_CANCELLED, input)
  }

  commitAgentArtifact (input) {
    return this.enqueue(OPERATIONS.AGENT_COMMIT_ARTIFACT, input)
  }

  commitAgentMemoryCandidates (input) {
    return this.enqueue(OPERATIONS.AGENT_COMMIT_MEMORY_CANDIDATES, input)
  }

  readAgentMemoryContext (input) {
    return this.enqueue(OPERATIONS.AGENT_READ_MEMORY_CONTEXT, input)
  }

  deleteAgentMemoryItem (input) {
    return this.enqueue(OPERATIONS.AGENT_DELETE_MEMORY_ITEM, input)
  }

  applyAgentTaskPolicy (input) {
    return this.enqueue(OPERATIONS.AGENT_APPLY_TASK_POLICY, input)
  }

  getAgentSessionDetail (input) {
    return this.enqueue(OPERATIONS.AGENT_GET_SESSION_DETAIL, input)
  }

  deleteAgentSessionData (input) {
    return this.enqueue(OPERATIONS.AGENT_DELETE_SESSION_DATA, input)
  }

  personalContextIngest (source) {
    return this.enqueue(OPERATIONS.PERSONAL_CONTEXT_INGEST, { source })
  }

  personalContextResolve (request) {
    return this.enqueue(OPERATIONS.PERSONAL_CONTEXT_RESOLVE, { request })
  }

  personalContextManage (command) {
    return this.enqueue(OPERATIONS.PERSONAL_CONTEXT_MANAGE, { command })
  }

  shutdown () {
    if (this.shutdownPromise) return this.shutdownPromise
    this.closing = true
    const promise = this.shutdownGeneration()
    this.shutdownPromise = promise
    return promise
  }

  async shutdownGeneration () {
    if (this.state === 'starting' && this.startPromise) await this.startPromise
    await this.tail
    const child = this.child
    if (!child) {
      if (this.state === 'failed') throw this.stateError('HOST_GENERATION_FAILED')
      this.state = 'closed'
      return
    }
    if (this.state !== 'ready') throw this.stateError('HOST_GENERATION_FAILED')

    const exitPromise = this.childExit?.child === child ? this.childExit.promise : null
    if (!exitPromise) throw this.stateError('HOST_GENERATION_FAILED')
    this.state = 'stopping'
    await this.perform(OPERATIONS.SHUTDOWN, {})
    const exitCode = await waitWithTimeout(
      exitPromise,
      this.requestTimeoutMs,
      () => new StorageTransportError(
        'WORKER_EXIT_TIMEOUT',
        'Storage worker did not exit after shutdown.',
        { outcome: 'unknown' }
      )
    )
    if (exitCode !== 0) {
      this.state = 'failed'
      throw new StorageTransportError(
        'WORKER_EXITED',
        `Storage worker exited after shutdown (code ${exitCode}).`,
        { outcome: 'unknown' }
      )
    }
    this.state = 'closed'
  }

  async terminateChildAndWait (child, timeoutMs) {
    const record = this.childExit?.child === child ? this.childExit : null
    if (!record) return null
    let killCause
    if (this.terminationChild !== child) {
      try {
        child.kill()
        this.terminationChild = child
      } catch (cause) { killCause = cause }
    }
    return waitWithTimeout(
      record.promise,
      timeoutMs,
      () => new StorageTransportError(
        'TERMINATION_TIMEOUT',
        'Storage worker did not exit after termination.',
        { outcome: 'unknown', cause: killCause }
      )
    )
  }

  waitForExactExit () {
    return this.childExit?.promise || Promise.resolve(null)
  }

  terminateAndWait (timeoutMs) {
    if (this.terminatePromise) return this.terminatePromise
    const timeout = positiveTimeout(timeoutMs, this.requestTimeoutMs)
    this.closing = true
    const promise = (async () => {
      const child = this.child
      if (!child) {
        this.state = 'stopped'
        return null
      }
      this.state = 'stopping'
      try {
        const exitCode = await this.terminateChildAndWait(child, timeout)
        this.state = 'stopped'
        return exitCode
      } catch (error) {
        this.state = 'failed'
        throw error
      }
    })()
    this.terminatePromise = promise
    promise.then(
      () => { if (this.terminatePromise === promise) this.terminatePromise = null },
      () => { if (this.terminatePromise === promise) this.terminatePromise = null }
    )
    return promise
  }

  terminate () {
    void this.terminateAndWait(this.requestTimeoutMs).catch(() => {})
  }
}

module.exports = {
  SERVICE_NAME,
  StorageTransportError,
  StorageWorkerHost,
  WORKER_PATH,
  isStorageTransportError
}
