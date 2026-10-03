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
  CONTROL_MESSAGES,
  PROTOCOL_VERSION,
  SAFE_ERROR_MESSAGES,
  StorageError,
  isPlainObject,
  makeCaptionEventId,
  makeCloseSessionKey,
  makeLegacyImportKey,
  makeOpenSessionKey,
  makeRefinementFaultKey,
  makeRecognitionStatusKey
} = require('./protocol')

const WORKER_PATH = path.join(__dirname, 'storage-worker.js')
const SERVICE_NAME = 'Speech Agent subtitle storage'
const CANCELLABLE_PERSONAL_CONTEXT_READS = new Set([
  OPERATIONS.PERSONAL_CONTEXT_READ_SESSION_INPUT,
  OPERATIONS.PERSONAL_CONTEXT_READ_TOOL_CONTEXT
])

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
    this.childEnvironment = options.childEnvironment ? { ...options.childEnvironment } : null
    this.requestTimeoutMs = positiveTimeout(options.requestTimeoutMs, 5000)
    this.child = null
    this.childExit = null
    this.exitPromise = null
    this.tail = Promise.resolve()
    this.counter = 0
    this.pendingRequests = new Set()
    this.responsesInDispatch = new Set()
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
        serviceName: SERVICE_NAME,
        ...(this.childEnvironment ? { env: { ...this.childEnvironment } } : {})
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
      const initialized = await this.perform(OPERATIONS.INITIALIZE, { databasePath: this.databasePath })
      this.retirementFailure = initialized.retirementFailure || null
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

  enqueue (operation, payload, idempotencyKey, options = {}) {
    if (this.closing) return Promise.reject(this.stateError('HOST_SHUTTING_DOWN'))
    if (options.signal?.aborted) return Promise.reject(new StorageError('AGENT_CANCELLED'))
    const readiness = this.state === 'starting' ? this.startPromise : null
    const task = this.tail.then(async () => {
      if (readiness) await readiness
      if (!this.child || this.state !== 'ready') throw this.stateError()
      if (options.signal?.aborted) throw new StorageError('AGENT_CANCELLED')
      return this.perform(operation, payload, idempotencyKey, options)
    })
    this.tail = task.catch(() => {})
    return task
  }

  perform (operation, payload, idempotencyKey, options = {}) {
    const child = this.child
    const allowed = child && (
      this.state === 'ready' ||
      (this.state === 'starting' && operation === OPERATIONS.INITIALIZE) ||
      (this.state === 'stopping' && operation === OPERATIONS.SHUTDOWN)
    )
    if (!allowed) return Promise.reject(this.stateError())
    if (options.signal?.aborted) return Promise.reject(new StorageError('AGENT_CANCELLED'))

    const requestId = `storage-${this.generation}-${++this.counter}`
    return new Promise((resolve, reject) => {
      let settled = false
      let cancellationSent = false
      let requestSent = false
      const cleanup = () => {
        clearTimeout(timer)
        this.pendingRequests.delete(requestId)
        options.signal?.removeEventListener('abort', onAbort)
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
      }, operation === OPERATIONS.INITIALIZE ? 300000 : this.requestTimeoutMs)
      const onMessage = (message) => {
        if (settled) return
        if (message?.requestId !== requestId) {
          if (this.pendingRequests.has(message?.requestId) || this.responsesInDispatch.has(message?.requestId)) return
          failTransport(responseError(operation))
          return
        }
        this.responsesInDispatch.add(requestId)
        setImmediate(() => this.responsesInDispatch.delete(requestId))
        let response
        try {
          response = validateResponse(message, requestId, operation)
        } catch (error) {
          failTransport(error)
          return
        }
        settled = true
        cleanup()
        if (options.signal?.aborted && CANCELLABLE_PERSONAL_CONTEXT_READS.has(operation)) {
          reject(new StorageError('AGENT_CANCELLED'))
        } else if (response.ok) resolve(response.result)
        else reject(response.error)
      }
      const onExit = (code) => {
        failTransport(new StorageTransportError(
          'WORKER_EXITED',
          `Storage worker exited during ${operation} (code ${code}).`,
          { outcome: 'unknown' }
        ))
      }
      const onAbort = () => {
        // The signal can withdraw queued work before postMessage; after send,
        // it cannot retract the request already handed to the worker.
        if (settled || !CANCELLABLE_PERSONAL_CONTEXT_READS.has(operation)) return
        if (!requestSent) {
          settled = true
          cleanup()
          reject(new StorageError('AGENT_CANCELLED'))
          return
        }
        if (cancellationSent) return
        cancellationSent = true
        try {
          child.postMessage({
            version: PROTOCOL_VERSION,
            type: 'storage:cancel-personal-context-read',
            requestId
          })
        } catch (cause) {
          failTransport(new StorageTransportError(
            'POST_MESSAGE_FAILED',
            'Storage worker cancellation could not be sent.',
            { outcome: 'unknown', cause }
          ))
        }
      }
      child.on('message', onMessage)
      child.once('exit', onExit)
      this.pendingRequests.add(requestId)
      if (options.signal) {
        options.signal.addEventListener('abort', onAbort, { once: true })
        if (options.signal.aborted) {
          onAbort()
          return
        }
      }
      const request = options.priorityControl
        ? {
            version: PROTOCOL_VERSION,
            type: CONTROL_MESSAGES.RENEW_FORMAL_AGENT_RUN_LEASE,
            requestId,
            request: payload.request
          }
        : {
            version: PROTOCOL_VERSION,
            type: 'storage:request',
            requestId,
            operation,
            payload
          }
      if (idempotencyKey !== undefined) request.idempotencyKey = idempotencyKey
      try {
        requestSent = true
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

  recordRecognitionStatus (input) {
    return this.enqueue(OPERATIONS.RECORD_RECOGNITION_STATUS, input, makeRecognitionStatusKey(input))
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

















  personalContextIngest (source) {
    return this.enqueue(OPERATIONS.PERSONAL_CONTEXT_INGEST, { source })
  }

  personalContextResolve (request) {
    return this.enqueue(OPERATIONS.PERSONAL_CONTEXT_RESOLVE, { request })
  }

  personalContextManage (command) {
    return this.enqueue(OPERATIONS.PERSONAL_CONTEXT_MANAGE, { command })
  }

  deletePersonalContextSessionData (input) {
    return this.enqueue(OPERATIONS.PERSONAL_CONTEXT_DELETE_SESSION_DATA, input)
  }

  preparePersonalContextSessionIngest (request) {
    return this.enqueue(OPERATIONS.PERSONAL_CONTEXT_PREPARE_SESSION_INGEST, { request })
  }

  applyPersonalContextAutomaticPolicy (request) {
    return this.enqueue(OPERATIONS.PERSONAL_CONTEXT_APPLY_AUTOMATIC_POLICY, { request })
  }

  cancelPersonalContextSessionIngest (request) {
    return this.enqueue(OPERATIONS.PERSONAL_CONTEXT_CANCEL_SESSION_INGEST, { request })
  }

  derivePersonalContextSessionSource (request) {
    return this.enqueue(OPERATIONS.PERSONAL_CONTEXT_DERIVE_SESSION_SOURCE, { request })
  }

  readPersonalContextSessionInput (source, signal) {
    return this.enqueue(OPERATIONS.PERSONAL_CONTEXT_READ_SESSION_INPUT, { source }, undefined, { signal })
  }

  readPersonalContextSessionRangePage (request, signal) {
    return this.enqueue(OPERATIONS.PERSONAL_CONTEXT_READ_SESSION_RANGE_PAGE, { request }, undefined, { signal })
  }

  readPersonalContextToolContext (request, signal) {
    return this.enqueue(OPERATIONS.PERSONAL_CONTEXT_READ_TOOL_CONTEXT, { request }, undefined, { signal })
  }

  commitPersonalContextSessionIngest (request, signal) {
    return this.enqueue(OPERATIONS.PERSONAL_CONTEXT_COMMIT_SESSION_INGEST, { request }, undefined, { signal })
  }
  personalMemoryFiles (command) {
    return this.enqueue(OPERATIONS.PERSONAL_MEMORY_FILES, { command })
  }
  personalMemoryIndex (command) {
    return this.enqueue(OPERATIONS.PERSONAL_MEMORY_INDEX, { command })
  }

  personalContextSessionExperiences (request, signal) {
    return this.enqueue(OPERATIONS.PERSONAL_CONTEXT_SESSION_EXPERIENCES, { request }, undefined, { signal })
  }

  personalContextQuestionEvidence (request, signal) {
    return this.enqueue(OPERATIONS.PERSONAL_CONTEXT_QUESTION_EVIDENCE, { request }, undefined, { signal })
  }

  preparePersonalContextInteractionIngest (request) {
    return this.enqueue(OPERATIONS.PERSONAL_CONTEXT_PREPARE_INTERACTION_INGEST, { request })
  }

  readPersonalContextInteractionInput (source, ephemeral = null, signal) {
    return this.enqueue(OPERATIONS.PERSONAL_CONTEXT_READ_INTERACTION_INPUT, { source, ephemeral }, undefined, { signal })
  }

  commitPersonalContextInteractionIngest (request, signal) {
    return this.enqueue(OPERATIONS.PERSONAL_CONTEXT_COMMIT_INTERACTION_INGEST, { request }, undefined, { signal })
  }

  cancelPersonalContextInteractionIngest (request) {
    return this.enqueue(OPERATIONS.PERSONAL_CONTEXT_CANCEL_INTERACTION_INGEST, { request })
  }

  claimNextFormalAgentRun (request) {
    return this.enqueue(OPERATIONS.FORMAL_AGENT_CLAIM_RUN, { request })
  }

  renewFormalAgentRun (request) {
    if (this.closing) return Promise.reject(this.stateError('HOST_SHUTTING_DOWN'))
    if (this.state !== 'ready' || !this.child) return Promise.reject(this.stateError())
    return this.perform(OPERATIONS.FORMAL_AGENT_RENEW_RUN_LEASE, { request }, undefined, { priorityControl: true })
  }

  summaryInputPlan (request) {
    return this.enqueue(OPERATIONS.SUMMARY_INPUT_PLAN, { request })
  }

  reserveFormalAgentModelRequest (request) {
    return this.enqueue(OPERATIONS.FORMAL_AGENT_RESERVE_MODEL_REQUEST, { request })
  }

  nextFormalAgentRunAt (request = {}) {
    return this.enqueue(OPERATIONS.FORMAL_AGENT_NEXT_RUN_AT, request)
  }

  completeFormalAgentRun (request, signal) {
    return this.enqueue(OPERATIONS.FORMAL_AGENT_COMPLETE_RUN, { request }, undefined, { signal })
  }

  failFormalAgentRun (request, signal) {
    return this.enqueue(OPERATIONS.FORMAL_AGENT_FAIL_RUN, { request }, undefined, { signal })
  }

  createAgentInteraction (request, signal) {
    return this.enqueue(OPERATIONS.AGENT_CREATE_INTERACTION, { request }, undefined, { signal })
  }

  createAgentRun (request) {
    return this.enqueue(OPERATIONS.AGENT_CREATE_RUN, { request })
  }

  cancelAgentRun (request) {
    return this.enqueue(OPERATIONS.AGENT_CANCEL_RUN, { request })
  }

  terminalizeAgentInteraction (request, signal) {
    return this.enqueue(OPERATIONS.AGENT_TERMINALIZE_INTERACTION, { request }, undefined, { signal })
  }

  startAgentToolCall (request, signal) {
    return this.enqueue(OPERATIONS.AGENT_START_TOOL_CALL, { request }, undefined, { signal })
  }

  finishAgentToolCall (request, signal) {
    return this.enqueue(OPERATIONS.AGENT_FINISH_TOOL_CALL, { request }, undefined, { signal })
  }

  createAgentReportPresentation (request) {
    return this.enqueue(OPERATIONS.AGENT_CREATE_PRESENTATION, { request })
  }

  markAgentReportPresentation (request) {
    return this.enqueue(OPERATIONS.AGENT_MARK_PRESENTATION, { request })
  }

  listAgentInteractions (request) {
    return this.enqueue(OPERATIONS.AGENT_LIST_INTERACTIONS, { request })
  }

  getAgentInteraction (request) {
    return this.enqueue(OPERATIONS.AGENT_GET_INTERACTION, { request })
  }

  acceptSessionSummaryRequest (request) {
    return this.enqueue(OPERATIONS.SUMMARY_REQUEST_ACCEPT, { request })
  }

  getSessionSummaryRequest (request) {
    return this.enqueue(OPERATIONS.SUMMARY_REQUEST_GET, { request })
  }

  updateSessionSummaryRequest (request, signal) {
    return this.enqueue(OPERATIONS.SUMMARY_REQUEST_UPDATE, { request }, undefined, { signal })
  }

  cancelSessionSummaryRequest (request) {
    return this.enqueue(OPERATIONS.SUMMARY_REQUEST_CANCEL, { request })
  }

  resumeSessionSummaryRequest (request) {
    return this.enqueue(OPERATIONS.SUMMARY_REQUEST_RESUME, { request })
  }

  failUnrecoverableSessionSummaryRequest (request) {
    return this.enqueue(OPERATIONS.SUMMARY_REQUEST_FAIL_UNRECOVERABLE, { request })
  }

  recoverSessionSummaryRequests () {
    return this.enqueue(OPERATIONS.SUMMARY_REQUEST_RECOVER, {})
  }

  listRecoverableSessionSummaryRequests () {
    return this.enqueue(OPERATIONS.SUMMARY_REQUEST_LIST_RECOVERABLE, {})
  }

  modelAccessCatalog () {
    return this.perform(OPERATIONS.MODEL_ACCESS_CATALOG, {})
  }

  modelAccessConfigure (input) {
    return this.perform(OPERATIONS.MODEL_ACCESS_CONFIGURE, { input })
  }

  modelAccessBind (request, availableSlotIds = []) {
    return this.perform(OPERATIONS.MODEL_ACCESS_BIND, { request, availableSlotIds })
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
