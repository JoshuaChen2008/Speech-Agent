'use strict'

// @ts-check

/* SessionCoordinator 的 SQLite persistence sink。
   - sourceId / startedAt / endedAt 在第一次观察时冻结；
   - 只接收 final/refined，partial/translated 不进入字幕事实；
   - Gateway 拥有唯一 FIFO，本类只维护一个会话的生命周期与重试语义。 */

const { assertCaptionEvent } = require('../../contracts')

const PERSISTED_KINDS = Object.freeze(['final', 'refined'])
const TERMINAL_STATES = Object.freeze(['closed', 'interrupted'])
const REFINEMENT_FAULT_CODES = Object.freeze([
  'REFINE_WORKER_START_FAILED',
  'REFINE_WORKER_EXITED',
  'REFINE_DECODE_FAILED',
  'REFINE_INVALID_RESPONSE',
  'REFINE_INTERNAL_FAILURE'
])

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

function refinementEnabled (value) {
  if (value === undefined) return false
  if (typeof value !== 'boolean') throw new TypeError('refinementEnabled must be a boolean')
  return value
}

function refinementFault (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 3 || !Object.hasOwn(value, 'sessionId') ||
      !Object.hasOwn(value, 'faultCode') || !Object.hasOwn(value, 'faultAtMs')) {
    throw new TypeError('valid refinement fault is required')
  }
  if (typeof value.sessionId !== 'string' || value.sessionId.length < 1 ||
      !REFINEMENT_FAULT_CODES.includes(value.faultCode) ||
      !Number.isSafeInteger(value.faultAtMs) || value.faultAtMs < 0) {
    throw new TypeError('valid refinement fault is required')
  }
  return { sessionId: value.sessionId, faultCode: value.faultCode, faultAtMs: value.faultAtMs }
}

class SqliteSessionRecorder {
  constructor (options) {
    const gateway = options?.gateway
    if (!gateway || typeof gateway.openSession !== 'function' ||
        typeof gateway.appendCaption !== 'function' || typeof gateway.closeSession !== 'function' ||
        typeof gateway.recordRefinementFault !== 'function' ||
        typeof gateway.flush !== 'function' || typeof gateway.retry !== 'function') {
      throw new TypeError('storage gateway is required')
    }
    this.gateway = gateway
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.onError = typeof options.onError === 'function' ? options.onError : () => {}
    this.active = null
    this.failure = null
    this.terminalListeners = new Set()
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
    const frozenRefinementEnabled = refinementEnabled(input?.refinementEnabled)
    if (this.active) {
      if (this.active.sessionId !== identity.sessionId || this.active.sourceId !== identity.sourceId) {
        throw new Error('another durable subtitle session is active')
      }
      if (this.active.refinementEnabled !== frozenRefinementEnabled) {
        throw new Error('durable session refinement preference is already frozen')
      }
      return this.active.openPromise || this.submitOpen(this.active)
    }
    const payload = {
      ...identity,
      startedAt: timestamp(this.now()),
      refinementEnabled: frozenRefinementEnabled
    }
    const active = {
      ...payload,
      closePayload: null,
      openPromise: null,
      openQueued: false,
      closePromise: null,
      closeQueued: false,
      terminalNotified: false
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
        startedAt: active.startedAt,
        refinementEnabled: active.refinementEnabled
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

  recordRefinementFault (input) {
    const fault = refinementFault(input)
    if (!this.active || fault.sessionId !== this.active.sessionId) {
      throw new Error('durable session identity does not match')
    }
    return this.track(this.gateway.recordRefinementFault(structuredClone(fault)))
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
        if (!active.terminalNotified) {
          active.terminalNotified = true
          this.notifyTerminalCommitted(active.sessionId)
        }
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
      if (active.closeQueued) {
        if (!active.terminalNotified) {
          active.terminalNotified = true
          this.notifyTerminalCommitted(active.sessionId)
        }
        this.active = null
      }
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

  onTerminalCommitted (listener) {
    if (typeof listener !== 'function') throw new TypeError('terminal listener must be a function')
    this.terminalListeners.add(listener)
    return () => this.terminalListeners.delete(listener)
  }

  clearTerminalCommittedListeners () {
    this.terminalListeners.clear()
  }

  notifyTerminalCommitted (sessionId) {
    const notification = Object.freeze({ sessionId })
    queueMicrotask(() => {
      for (const listener of [...this.terminalListeners]) {
        try {
          const result = listener(notification)
          if (result && typeof result.then === 'function') result.catch(() => {})
        } catch { /* detached Agent observers cannot affect subtitle persistence */ }
      }
    })
  }

  getActiveSession () {
    if (!this.active) return null
    return structuredClone({
      sessionId: this.active.sessionId,
      sourceId: this.active.sourceId,
      startedAt: this.active.startedAt,
      refinementEnabled: this.active.refinementEnabled,
      closePayload: this.active.closePayload
    })
  }
}

module.exports = {
  PERSISTED_KINDS,
  REFINEMENT_FAULT_CODES,
  SqliteSessionRecorder,
  TERMINAL_STATES
}
