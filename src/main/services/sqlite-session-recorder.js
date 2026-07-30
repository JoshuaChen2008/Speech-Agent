'use strict'

// @ts-check

/* SessionCoordinator 的 SQLite persistence sink。
   - sourceId / startedAt / endedAt 在第一次观察时冻结；
   - 只接收 final/refined，partial/translated 不进入字幕事实；
   - Gateway 拥有唯一 FIFO，本类只维护一个会话的生命周期与重试语义。 */

const { assertCaptionEvent } = require('../../contracts')

const PERSISTED_KINDS = Object.freeze(['final', 'refined'])
const TERMINAL_STATES = Object.freeze(['closed', 'interrupted'])

function assertSessionIdentity (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !['sessionId', 'sourceId'].every((key) => typeof value[key] === 'string' && value[key].length > 0) ||
      !['loopback', 'mic'].includes(value.sourceId)) {
    throw new TypeError('valid sessionId and sourceId are required')
  }
  return { sessionId: value.sessionId, sourceId: value.sourceId }
}

function timestamp (value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('recorder clock must return epoch milliseconds')
  return value
}

class SqliteSessionRecorder {
  constructor (options) {
    const gateway = options?.gateway
    if (!gateway || typeof gateway.openSession !== 'function' ||
        typeof gateway.appendCaption !== 'function' || typeof gateway.closeSession !== 'function' ||
        typeof gateway.flush !== 'function' || typeof gateway.retry !== 'function') {
      throw new TypeError('storage gateway is required')
    }
    this.gateway = gateway
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.onError = typeof options.onError === 'function' ? options.onError : () => {}
    this.active = null
    this.failure = null
  }

  reportError (error) {
    if (this.failure === null) this.failure = error
    try { this.onError(error) } catch { /* observer failures stay isolated */ }
  }

  track (promise) {
    const tracked = Promise.resolve(promise)
    tracked.catch((error) => this.reportError(error))
    return tracked
  }

  openSession (input) {
    const identity = assertSessionIdentity(input)
    if (this.active) {
      if (this.active.sessionId !== identity.sessionId || this.active.sourceId !== identity.sourceId) {
        throw new Error('another durable subtitle session is active')
      }
      return this.active.openPromise || this.submitOpen(this.active)
    }
    const payload = {
      ...identity,
      startedAt: timestamp(this.now())
    }
    const active = {
      ...payload,
      closePayload: null,
      openPromise: null,
      openQueued: false,
      closePromise: null,
      closeQueued: false
    }
    this.active = active
    return this.submitOpen(active)
  }

  submitOpen (active) {
    let operation
    try {
      operation = this.gateway.openSession(structuredClone({
        sessionId: active.sessionId,
        sourceId: active.sourceId,
        startedAt: active.startedAt
      }))
      active.openQueued = true
    } catch (error) {
      active.openQueued = error?.storageRetained === true
      this.reportError(error)
      throw error
    }
    const openPromise = this.track(operation).then(
      (result) => result,
      (error) => {
        active.openQueued = error?.storageRetained === true
        throw error
      }
    )
    active.openPromise = openPromise
    return openPromise
  }

  acceptCaption (event) {
    try { assertCaptionEvent(event) } catch { return false }
    if (!PERSISTED_KINDS.includes(event.kind)) return false
    if (!this.active || this.active.closePayload || event.sessionId !== this.active.sessionId ||
        event.sourceId !== this.active.sourceId) {
      return false
    }
    return this.track(this.gateway.appendCaption(structuredClone(event)))
  }

  closeSession (input) {
    const identity = assertSessionIdentity(input)
    const state = input?.state
    if (!TERMINAL_STATES.includes(state)) throw new TypeError('terminal state must be closed or interrupted')
    if (!this.active || this.active.sessionId !== identity.sessionId || this.active.sourceId !== identity.sourceId) {
      throw new Error('durable session identity does not match')
    }
    if (!this.active.closePayload) {
      this.active.closePayload = {
        ...identity,
        endedAt: Math.max(this.active.startedAt, timestamp(this.now())),
        state
      }
    } else if (this.active.closePayload.state !== state) {
      throw new Error('durable session terminal state is already frozen')
    }
    if (!this.active.closePromise) return this.submitClose(this.active)
    return this.active.closePromise
  }

  submitClose (active) {
    let operation
    try {
      operation = this.gateway.closeSession(structuredClone(active.closePayload))
      active.closeQueued = true
    } catch (error) {
      active.closeQueued = error?.storageRetained === true
      this.reportError(error)
      throw error
    }
    const closePromise = this.track(operation).then(
      (result) => {
        if (this.active === active) this.active = null
        this.failure = null
        return result
      },
      (error) => {
        active.closeQueued = error?.storageRetained === true
        throw error
      }
    )
    active.closePromise = closePromise
    return closePromise
  }

  async retry () {
    const result = await this.gateway.retry()
    this.failure = null
    if (this.active?.closePayload) {
      const active = this.active
      if (active.closeQueued) this.active = null
      else {
        active.closePromise = null
        return this.submitClose(active)
      }
    } else if (this.active) {
      const active = this.active
      if (active.openQueued) active.openPromise = Promise.resolve(result)
      else {
        active.openPromise = null
        return this.submitOpen(active)
      }
    }
    return result
  }

  flush () {
    return this.gateway.flush()
  }

  getActiveSession () {
    if (!this.active) return null
    return structuredClone({
      sessionId: this.active.sessionId,
      sourceId: this.active.sourceId,
      startedAt: this.active.startedAt,
      closePayload: this.active.closePayload
    })
  }
}

module.exports = {
  PERSISTED_KINDS,
  SqliteSessionRecorder,
  TERMINAL_STATES
}
