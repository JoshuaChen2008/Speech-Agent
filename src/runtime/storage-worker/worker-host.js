'use strict'

// @ts-check

/* Electron main 侧的低层 storage utility host。当前版本提供单 FIFO、至多一
   个在途请求和有界 shutdown；自动重启/重发由下一阶段 gateway 增强。 */

const path = require('node:path')
const {
  OPERATIONS,
  PROTOCOL_VERSION,
  StorageError,
  makeCaptionEventId,
  makeCloseSessionKey,
  makeOpenSessionKey
} = require('./protocol')

const WORKER_PATH = path.join(__dirname, 'storage-worker.js')

class StorageWorkerHost {
  constructor (options = {}) {
    if (typeof options.databasePath !== 'string' || !path.isAbsolute(options.databasePath)) {
      throw new TypeError('databasePath must be absolute')
    }
    this.electron = options.electron || require('electron')
    this.databasePath = options.databasePath
    this.workerPath = options.workerPath || WORKER_PATH
    this.requestTimeoutMs = Number.isInteger(options.requestTimeoutMs) ? options.requestTimeoutMs : 5000
    this.child = null
    this.tail = Promise.resolve()
    this.counter = 0
    this.generation = 0
    this.closing = false
    this.exitPromise = null
  }

  async start () {
    if (this.child) return
    if (this.closing) throw new StorageError('SHUTTING_DOWN')
    const child = this.electron.utilityProcess.fork(this.workerPath, [], {
      serviceName: 'Speech Agent subtitle storage'
    })
    this.child = child
    this.generation += 1
    this.exitPromise = new Promise((resolve) => {
      child.once('exit', (code) => {
        if (this.child === child) this.child = null
        resolve(code)
      })
    })
    try {
      await this.perform(OPERATIONS.INITIALIZE, { databasePath: this.databasePath })
    } catch (error) {
      try { child.kill() } catch { /* exact child; already exited */ }
      if (this.child === child) this.child = null
      throw error
    }
  }

  enqueue (operation, payload, idempotencyKey) {
    if (this.closing) return Promise.reject(new StorageError('SHUTTING_DOWN'))
    const task = this.tail.then(async () => {
      if (!this.child) throw new StorageError('NOT_INITIALIZED')
      return this.perform(operation, payload, idempotencyKey)
    })
    this.tail = task.catch(() => {})
    return task
  }

  perform (operation, payload, idempotencyKey) {
    const child = this.child
    if (!child) return Promise.reject(new StorageError('NOT_INITIALIZED'))
    const requestId = `storage-${this.generation}-${++this.counter}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`storage request timed out (${operation})`))
      }, this.requestTimeoutMs)
      const onMessage = (message) => {
        if (message?.type !== 'storage:response' || message.requestId !== requestId) return
        cleanup()
        if (message.ok) resolve(message.result)
        else reject(new StorageError(message.error?.code))
      }
      const onExit = (code) => {
        cleanup()
        reject(new Error(`storage worker exited during ${operation} (code ${code})`))
      }
      const cleanup = () => {
        clearTimeout(timer)
        child.removeListener('message', onMessage)
        child.removeListener('exit', onExit)
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
      child.postMessage(request)
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

  getSessionTranscript (sessionId) {
    return this.enqueue(OPERATIONS.GET_SESSION, { sessionId })
  }

  getStats () {
    return this.enqueue(OPERATIONS.GET_STATS, {})
  }

  async shutdown () {
    if (this.closing) return
    this.closing = true
    await this.tail
    const child = this.child
    if (!child) return
    const exitPromise = this.exitPromise
    await this.perform(OPERATIONS.SHUTDOWN, {})
    const exitCode = await Promise.race([
      exitPromise,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), this.requestTimeoutMs))
    ])
    if (exitCode === 'timeout') throw new Error('storage worker did not exit after shutdown')
    if (exitCode !== 0) throw new Error(`storage worker exit code ${exitCode}`)
  }

  terminate () {
    this.closing = true
    const child = this.child
    this.child = null
    if (child) {
      try { child.kill() } catch { /* exact child; already exited */ }
    }
  }
}

module.exports = { StorageWorkerHost, WORKER_PATH }
