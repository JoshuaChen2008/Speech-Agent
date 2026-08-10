'use strict'

const path = require('node:path')
const { AgentCoreError } = require('../../agent-core/errors')
const {
  OPERATIONS,
  PROTOCOL_VERSION,
  cancelResult,
  clearCredentialBytes,
  executeJobPayload,
  initializeResult,
  pluginResultForJob,
  responseEnvelope,
  shutdownResult
} = require('./protocol')
const { credentialEnvironmentKey } = require('./service')

const WORKER_PATH = path.join(__dirname, 'agent-utility-worker.js')
const SERVICE_NAME = 'Speech Agent model utility'

function workerExited () {
  return new AgentCoreError('AGENT_WORKER_EXITED', { retryable: true })
}

function positiveTimeout (value, fallback) {
  const timeout = value === undefined ? fallback : value
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120000) {
    throw new AgentCoreError('AGENT_REQUEST_INVALID')
  }
  return timeout
}

function childEnvironment (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentCoreError('AGENT_REQUEST_INVALID')
  }
  const entries = Object.entries(value)
  if (entries.some(([key, entry]) => credentialEnvironmentKey(key) || typeof entry !== 'string')) {
    throw new AgentCoreError('AGENT_REQUEST_INVALID')
  }
  return Object.freeze(Object.fromEntries(entries))
}

function workerArguments (value) {
  if (!Array.isArray(value) || value.length > 16 ||
      value.some((entry) => typeof entry !== 'string' || entry.length > 240)) {
    throw new AgentCoreError('AGENT_REQUEST_INVALID')
  }
  return [...value]
}

function workerStdio (value) {
  if (value === undefined || value === 'ignore') return 'ignore'
  if (Array.isArray(value) && JSON.stringify(value) === JSON.stringify(['ignore', 'pipe', 'pipe'])) {
    return [...value]
  }
  throw new AgentCoreError('AGENT_REQUEST_INVALID')
}

function callerSignal (value) {
  if (value === undefined) return value
  if (!value || typeof value !== 'object' || typeof value.aborted !== 'boolean' ||
      typeof value.addEventListener !== 'function' || typeof value.removeEventListener !== 'function') {
    throw new AgentCoreError('AGENT_REQUEST_INVALID')
  }
  return value
}

function waitWithTimeout (promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(workerExited())
    }, timeoutMs)
    promise.then(
      (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(workerExited())
      }
    )
  })
}

class AgentUtilityWorkerHost {
  constructor ({
    electron = require('electron'),
    environment,
    workerPath = WORKER_PATH,
    workerArgs = [],
    requestTimeoutMs = 65000,
    stdio,
    onFatalError = () => {}
  } = {}) {
    if (!electron?.utilityProcess || typeof electron.utilityProcess.fork !== 'function' ||
        typeof workerPath !== 'string' || !path.isAbsolute(workerPath) ||
        typeof onFatalError !== 'function') {
      throw new AgentCoreError('AGENT_REQUEST_INVALID')
    }
    this.electron = electron
    this.environment = childEnvironment(environment)
    this.workerPath = workerPath
    this.workerArgs = workerArguments(workerArgs)
    this.requestTimeoutMs = positiveTimeout(requestTimeoutMs, 65000)
    this.stdio = workerStdio(stdio)
    this.onFatalError = onFatalError
    this.child = null
    this.childExit = null
    this.exitPromise = Promise.resolve(null)
    this.pending = new Map()
    this.counter = 0
    this.generation = 0
    this.state = 'stopped'
    this.hasStarted = false
    this.closing = false
    this.expectedExitChild = null
    this.terminationChild = null
    this.startPromise = null
    this.shutdownPromise = null
    this.failurePromise = null
    this.failureNotified = false
    this.failureObservers = new Set()
    this.availableKinds = []
    this.activeRunId = null
  }

  observeGenerationFailure (listener) {
    if (typeof listener !== 'function' || this.hasStarted) {
      throw new AgentCoreError('AGENT_REQUEST_INVALID')
    }
    this.failureObservers.add(listener)
    return () => this.failureObservers.delete(listener)
  }

  notifyGenerationFailure () {
    if (this.failureNotified) return
    this.failureNotified = true
    this.availableKinds = []
    for (const listener of this.failureObservers) {
      try { listener() } catch { /* observer isolation */ }
    }
  }

  installChild (child) {
    let resolveExit
    const promise = new Promise((resolve) => { resolveExit = resolve })
    this.childExit = { child, promise }
    this.exitPromise = promise
    child.on('message', (message) => this.handleMessage(child, message))
    child.on('error', () => {
      try { this.onFatalError(Object.freeze({ role: 'agent-model-utility', type: 'FatalError' })) } catch { /* observer isolation */ }
      void this.failGeneration(child)
    })
    child.once('exit', (code) => {
      const expected = this.expectedExitChild === child
      if (this.child === child) {
        this.child = null
        this.availableKinds = []
        this.state = expected ? 'stopped' : 'failed'
      }
      resolveExit(code)
      this.rejectPending(child, workerExited())
      if (!expected) this.notifyGenerationFailure()
    })
  }

  rejectPending (child, error) {
    for (const [requestId, pending] of this.pending) {
      if (pending.child !== child) continue
      clearTimeout(pending.timer)
      this.pending.delete(requestId)
      pending.reject(error)
    }
  }

  start () {
    if (this.startPromise) return this.startPromise
    if (this.hasStarted || this.closing || this.child) return Promise.reject(workerExited())
    this.hasStarted = true
    this.startPromise = this.startGeneration()
    return this.startPromise
  }

  async startGeneration () {
    this.state = 'starting'
    let child
    try {
      child = this.electron.utilityProcess.fork(this.workerPath, this.workerArgs, {
        env: { ...this.environment },
        serviceName: SERVICE_NAME,
        stdio: this.stdio
      })
    } catch {
      this.state = 'failed'
      this.notifyGenerationFailure()
      throw workerExited()
    }
    this.child = child
    this.generation += 1
    this.installChild(child)
    try {
      const initialized = await this.perform(
        OPERATIONS.INITIALIZE,
        {},
        (result) => initializeResult(result)
      )
      if (this.child !== child) throw workerExited()
      this.availableKinds = [...initialized.availableTaskKinds]
      this.state = 'ready'
      return { availableTaskKinds: [...this.availableKinds] }
    } catch (error) {
      await this.failGeneration(child)
      throw error?.code === 'AGENT_WORKER_EXITED' ? error : workerExited()
    }
  }

  perform (operation, payload, validateResult) {
    const child = this.child
    const allowed = child && (
      (this.state === 'starting' && operation === OPERATIONS.INITIALIZE) ||
      (this.state === 'ready' && [OPERATIONS.EXECUTE_JOB, OPERATIONS.CANCEL].includes(operation)) ||
      (this.state === 'stopping' && operation === OPERATIONS.SHUTDOWN)
    )
    if (!allowed || typeof validateResult !== 'function') return Promise.reject(workerExited())
    const requestId = `agent-utility-${this.generation}-${++this.counter}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { void this.failGeneration(child) }, this.requestTimeoutMs)
      this.pending.set(requestId, { child, operation, validateResult, resolve, reject, timer })
      try {
        child.postMessage({
          version: PROTOCOL_VERSION,
          type: 'agent-utility:request',
          requestId,
          operation,
          payload
        })
      } catch {
        void this.failGeneration(child)
      }
    })
  }

  handleMessage (child, message) {
    if (this.child !== child || this.state === 'failed') return
    let response
    try {
      response = responseEnvelope(message)
    } catch {
      void this.failGeneration(child)
      return
    }
    const pending = this.pending.get(response.requestId)
    if (!pending || pending.child !== child) {
      void this.failGeneration(child)
      return
    }
    if (!response.ok) {
      if (response.error.code === 'AGENT_WORKER_EXITED') {
        void this.failGeneration(child)
        return
      }
      clearTimeout(pending.timer)
      this.pending.delete(response.requestId)
      pending.reject(response.error)
      return
    }
    let result
    try {
      result = pending.validateResult(response.result)
    } catch {
      void this.failGeneration(child)
      return
    }
    clearTimeout(pending.timer)
    this.pending.delete(response.requestId)
    pending.resolve(result)
  }

  async failGeneration (child) {
    if (this.failurePromise) return this.failurePromise
    this.state = 'failed'
    this.rejectPending(child, workerExited())
    this.notifyGenerationFailure()
    const promise = (async () => {
      try {
        await this.terminateChildAndWait(child, this.requestTimeoutMs)
      } catch {
        this.rejectPending(child, workerExited())
      }
    })()
    this.failurePromise = promise
    return promise
  }

  availableTaskKinds () {
    return this.state === 'ready' ? [...this.availableKinds] : []
  }

  async executeJob (rawPayload, options = {}) {
    if (this.state !== 'ready' || this.activeRunId !== null) throw workerExited()
    const signal = callerSignal(options.signal)
    const payload = executeJobPayload(rawPayload)
    if (signal?.aborted) {
      payload.credentialBytes.fill(0)
      throw new AgentCoreError('AGENT_CANCELLED')
    }
    this.activeRunId = payload.job.runId
    const onAbort = () => {
      void this.perform(
        OPERATIONS.CANCEL,
        { runId: payload.job.runId },
        (result) => cancelResult(result, payload.job.runId)
      ).catch(() => {})
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await this.perform(
        OPERATIONS.EXECUTE_JOB,
        payload,
        (result) => pluginResultForJob(result, payload.job, payload.snapshot)
      )
    } finally {
      signal?.removeEventListener('abort', onAbort)
      clearCredentialBytes(payload.credentialBytes)
      if (this.activeRunId === payload.job.runId) this.activeRunId = null
    }
  }

  waitForExactExit () {
    return this.childExit?.promise || Promise.resolve(null)
  }

  async terminateChildAndWait (child, timeoutMs) {
    const record = this.childExit?.child === child ? this.childExit : null
    if (!record) return null
    if (this.terminationChild !== child) {
      try { child.kill() } catch { /* exact exit wait below */ }
      this.terminationChild = child
    }
    return waitWithTimeout(record.promise, positiveTimeout(timeoutMs, this.requestTimeoutMs))
  }

  async terminateAndWait (timeoutMs = this.requestTimeoutMs) {
    this.closing = true
    const child = this.child
    if (!child) return this.waitForExactExit()
    this.expectedExitChild = child
    this.state = 'stopping'
    const code = await this.terminateChildAndWait(child, timeoutMs)
    this.state = 'stopped'
    return code
  }

  shutdown () {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shutdownPromise = this.shutdownGeneration()
    return this.shutdownPromise
  }

  async shutdownGeneration () {
    if (this.state !== 'ready' || this.activeRunId !== null || !this.child) throw workerExited()
    this.closing = true
    const child = this.child
    this.expectedExitChild = child
    this.state = 'stopping'
    try {
      await this.perform(OPERATIONS.SHUTDOWN, {}, (result) => shutdownResult(result))
      const code = await waitWithTimeout(this.waitForExactExit(), this.requestTimeoutMs)
      if (code !== 0) throw workerExited()
      this.state = 'closed'
    } catch (error) {
      await this.terminateChildAndWait(child, this.requestTimeoutMs).catch(() => {})
      throw error?.code === 'AGENT_WORKER_EXITED' ? error : workerExited()
    }
  }
}

module.exports = {
  AgentUtilityWorkerHost,
  SERVICE_NAME,
  WORKER_PATH,
  childEnvironment,
  workerArguments,
  workerExited,
  workerStdio
}
