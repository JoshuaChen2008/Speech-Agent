'use strict'

const {
  INTERACTION_ROLES,
  POINTER_ROLES,
  isGestureIntent,
  isMouseThroughIntent,
  isResizeStartIntent,
  resumeSync,
  suspendSync
} = require('../contracts/window-interaction')

const FAILURE_PRIORITY = Object.freeze({
  'interaction-pass-through-failed': 1,
  'interaction-pointer-unavailable': 2,
  'interaction-sync-timeout': 3,
  'stale-interaction-generation': 4
})

function isUsableWindow (win) {
  return !!(win && typeof win.isDestroyed === 'function' && !win.isDestroyed())
}

function isCursorPoint (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Number.isFinite(value.x) && Number.isFinite(value.y)
}

class WindowInteractionGenerationController {
  constructor ({
    getWindow,
    getCursorScreenPoint,
    getLocked,
    sendSync,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    ackTimeoutMs = 1000,
    onFault = () => {}
  }) {
    for (const dependency of [getWindow, getCursorScreenPoint, getLocked, sendSync, setTimer, clearTimer, onFault]) {
      if (typeof dependency !== 'function') throw new TypeError('window interaction generation dependencies are invalid')
    }
    if (!Number.isSafeInteger(ackTimeoutMs) || ackTimeoutMs <= 0) {
      throw new TypeError('window interaction acknowledgement timeout is invalid')
    }

    this.getWindow = getWindow
    this.getCursorScreenPoint = getCursorScreenPoint
    this.getLocked = getLocked
    this.sendSync = sendSync
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.ackTimeoutMs = ackTimeoutMs
    this.onFault = onFault
    this.generation = 1
    this.phase = 'resume'
    this.ackTimers = new Map()
    this.failures = new Map()
    this.suspendedRoles = new Set()
  }

  reportFault (role, code) {
    try { this.onFault({ role, code }) } catch { /* diagnostics cannot break interaction lifecycle */ }
  }

  failurePriority (role) {
    const failure = this.failures.get(role)
    return failure?.generation === this.generation ? failure.priority : Number.POSITIVE_INFINITY
  }

  recordFailure (role, code) {
    const priority = FAILURE_PRIORITY[code]
    if (!priority) throw new TypeError('window interaction failure code is invalid')
    const current = this.failures.get(role)
    if (current?.generation === this.generation && current.priority <= priority) return false
    this.failures.set(role, { generation: this.generation, priority, code })
    this.reportFault(role, code)
    return true
  }

  clearAck (role) {
    const pending = this.ackTimers.get(role)
    if (!pending) return
    this.clearTimer(pending.timer)
    this.ackTimers.delete(role)
  }

  clearAllAcks () {
    for (const role of [...this.ackTimers.keys()]) this.clearAck(role)
  }

  clearRetryableFailure (role) {
    const failure = this.failures.get(role)
    if (failure?.generation === this.generation && failure.priority >= FAILURE_PRIORITY['interaction-pointer-unavailable']) {
      this.failures.delete(role)
    }
  }

  showToolbarForRetry (win, { preserveMinimized = false } = {}) {
    if (!isUsableWindow(win)) return
    try {
      const minimized = typeof win.isMinimized === 'function' && win.isMinimized()
      if (preserveMinimized && minimized) return
      if (minimized) win.restore()
      if (typeof win.show === 'function') win.show()
    } catch { /* the stable taskbar entry remains the next retry path */ }
  }

  applyPassThroughFailure (role, win, { preserveMinimized = false } = {}) {
    this.clearAck(role)
    this.recordFailure(role, 'interaction-pass-through-failed')
    if (!isUsableWindow(win)) return false
    if (role === 'caption') {
      try { win.hide() } catch { /* already rejected for this generation */ }
    } else if (role === 'toolbar') {
      this.showToolbarForRetry(win, { preserveMinimized })
      try { win.setIgnoreMouseEvents(false, { forward: true }) } catch { /* taskbar entry remains */ }
    }
    return false
  }

  setNativeIgnore (role, ignore, { preserveMinimized = false } = {}) {
    const win = this.getWindow(role)
    if (!isUsableWindow(win) || typeof win.setIgnoreMouseEvents !== 'function') {
      return this.applyPassThroughFailure(role, win, { preserveMinimized })
    }
    try {
      win.setIgnoreMouseEvents(ignore, { forward: true })
      return true
    } catch {
      return this.applyPassThroughFailure(role, win, { preserveMinimized })
    }
  }

  prepareOverlay (role) {
    if (!POINTER_ROLES.includes(role)) throw new TypeError('window interaction overlay role is invalid')
    return this.setNativeIgnore(role, true)
  }

  sendToRole (role, payload) {
    const win = this.getWindow(role)
    if (!isUsableWindow(win)) return false
    try { return this.sendSync(win, payload) !== false } catch { return false }
  }

  startAck (role, generation) {
    this.clearAck(role)
    const timer = this.setTimer(() => {
      const pending = this.ackTimers.get(role)
      if (!pending || pending.generation !== generation || generation !== this.generation) return
      this.ackTimers.delete(role)
      if (this.failurePriority(role) < FAILURE_PRIORITY['interaction-sync-timeout']) return
      this.recordFailure(role, 'interaction-sync-timeout')
      if (role === 'caption') this.setNativeIgnore(role, true)
      else this.setNativeIgnore(role, false)
    }, this.ackTimeoutMs)
    this.ackTimers.set(role, { generation, timer })
  }

  beginTransaction () {
    if (this.generation >= Number.MAX_SAFE_INTEGER) throw new Error('window interaction generation exhausted')
    this.generation += 1
    this.phase = 'suspend'
    this.clearAllAcks()
    this.failures.clear()
    this.suspendedRoles.clear()
    const payload = suspendSync(this.generation)
    for (const role of POINTER_ROLES) this.setNativeIgnore(role, true)
    for (const role of INTERACTION_ROLES) this.sendToRole(role, payload)
    return this.generation
  }

  pointerForRole (role, cursor) {
    const win = this.getWindow(role)
    if (!isUsableWindow(win) || typeof win.getBounds !== 'function') return null
    try {
      const bounds = typeof win.getContentBounds === 'function'
        ? win.getContentBounds()
        : win.getBounds()
      if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return null
      return { x: cursor.x - bounds.x, y: cursor.y - bounds.y }
    } catch { return null }
  }

  applyPointerFailure (role) {
    this.clearAck(role)
    this.recordFailure(role, 'interaction-pointer-unavailable')
    if (role === 'caption') this.setNativeIgnore(role, true)
    else this.setNativeIgnore(role, false)
  }

  resumeRole (role, cursor) {
    if (!INTERACTION_ROLES.includes(role)) throw new TypeError('window interaction role is invalid')
    if (!POINTER_ROLES.includes(role)) return this.sendToRole(role, resumeSync(this.generation, null))
    if (this.failurePriority(role) === FAILURE_PRIORITY['interaction-pass-through-failed']) {
      return this.applyPassThroughFailure(role, this.getWindow(role))
    }

    const pointer = isCursorPoint(cursor) ? this.pointerForRole(role, cursor) : null
    if (!pointer) {
      this.applyPointerFailure(role)
      return false
    }
    if (!this.setNativeIgnore(role, true)) return false
    this.startAck(role, this.generation)
    return this.sendToRole(role, resumeSync(this.generation, pointer))
  }

  resume (generation) {
    if (generation !== this.generation || this.phase !== 'suspend') return false
    this.phase = 'resume'
    let cursor = null
    try { cursor = this.getCursorScreenPoint() } catch { /* fixed role-scoped fallback below */ }
    for (const role of INTERACTION_ROLES) {
      this.suspendedRoles.delete(role)
      this.resumeRole(role, cursor)
    }
    return true
  }

  degradeForRestoreFailure (generation) {
    if (generation !== this.generation) return false
    this.phase = 'suspend'
    this.clearAllAcks()

    const caption = this.getWindow('caption')
    this.setNativeIgnore('caption', true)
    if (isUsableWindow(caption)) {
      try { caption.hide() } catch { /* the taskbar primary remains the retry path */ }
    }

    const toolbar = this.getWindow('toolbar')
    this.showToolbarForRetry(toolbar)
    this.setNativeIgnore('toolbar', false)
    return true
  }

  replay (role) {
    if (!INTERACTION_ROLES.includes(role)) throw new TypeError('window interaction role is invalid')
    this.clearAck(role)
    if (this.phase === 'suspend') {
      this.suspendedRoles.add(role)
      return this.sendToRole(role, suspendSync(this.generation))
    }
    this.suspendedRoles.delete(role)
    if (this.failurePriority(role) === FAILURE_PRIORITY['interaction-pass-through-failed']) {
      return this.applyPassThroughFailure(role, this.getWindow(role))
    }
    this.clearRetryableFailure(role)
    let cursor = null
    try { cursor = this.getCursorScreenPoint() } catch { /* fixed role-scoped fallback below */ }
    return this.resumeRole(role, cursor)
  }

  refreshPointerHits (roles = POINTER_ROLES) {
    if (!Array.isArray(roles) || roles.length === 0 ||
        roles.some((role) => !POINTER_ROLES.includes(role)) ||
        new Set(roles).size !== roles.length) {
      throw new TypeError('window interaction refresh roles are invalid')
    }
    if (this.phase !== 'resume') return false
    let cursor = null
    try { cursor = this.getCursorScreenPoint() } catch { /* fixed role-scoped fallback below */ }
    let refreshed = false
    for (const role of roles) {
      /* Geometry re-hit is not a registered recovery boundary. Preserve
         pass-through, missing-pointer and sync-timeout degradation until the
         renderer reloads, a current late acknowledgement arrives, or a newer
         application restore transaction begins. */
      if (this.suspendedRoles.has(role) ||
          this.failurePriority(role) <= FAILURE_PRIORITY['interaction-sync-timeout']) continue
      const pointer = isCursorPoint(cursor) ? this.pointerForRole(role, cursor) : null
      if (!pointer) {
        this.applyPointerFailure(role)
        continue
      }
      this.startAck(role, this.generation)
      if (this.sendToRole(role, resumeSync(this.generation, pointer))) refreshed = true
    }
    return refreshed
  }

  releaseRole (role) {
    if (!INTERACTION_ROLES.includes(role)) return
    this.clearAck(role)
    this.suspendedRoles.add(role)
  }

  failClosedAfterRendererGone (role) {
    if (!INTERACTION_ROLES.includes(role)) return false
    this.releaseRole(role)
    if (role === 'caption') return this.setNativeIgnore(role, true)
    if (role === 'toolbar') {
      const win = this.getWindow(role)
      const preserveMinimized = isUsableWindow(win) &&
        typeof win.isMinimized === 'function' && win.isMinimized()
      this.showToolbarForRetry(win, { preserveMinimized })
      return this.setNativeIgnore(role, false, { preserveMinimized })
    }
    return true
  }

  suspendRoleForReload (role) {
    if (!INTERACTION_ROLES.includes(role)) return false
    this.clearAck(role)
    this.suspendedRoles.add(role)
    if (POINTER_ROLES.includes(role)) this.setNativeIgnore(role, true)
    return this.sendToRole(role, suspendSync(this.generation))
  }

  acceptCurrent (role, payload, validator) {
    if (!INTERACTION_ROLES.includes(role) || !validator(payload)) return false
    if (payload.generation !== this.generation) {
      this.reportFault(role, 'stale-interaction-generation')
      return false
    }
    if (this.phase !== 'resume' || this.suspendedRoles.has(role) ||
        this.failurePriority(role) === FAILURE_PRIORITY['interaction-pass-through-failed']) return false
    return true
  }

  acceptMouseThrough (role, payload) {
    if (!POINTER_ROLES.includes(role) || !this.acceptCurrent(role, payload, isMouseThroughIntent)) return false
    if (this.failurePriority(role) <= FAILURE_PRIORITY['interaction-pointer-unavailable']) return false
    const ignore = role === 'caption' && this.getLocked() ? true : payload.ignore
    if (!this.setNativeIgnore(role, ignore)) return false
    this.clearAck(role)
    const failure = this.failures.get(role)
    if (failure?.generation === this.generation && failure.code === 'interaction-sync-timeout') {
      this.failures.delete(role)
    }
    return true
  }

  acceptGesture (role, payload) {
    return this.acceptCurrent(role, payload, isGestureIntent) &&
      this.failurePriority(role) > FAILURE_PRIORITY['interaction-sync-timeout']
  }

  acceptResizeStart (role, payload) {
    return role === 'caption' && this.acceptCurrent(role, payload, isResizeStartIntent) &&
      this.failurePriority(role) > FAILURE_PRIORITY['interaction-sync-timeout']
  }

  getState () {
    return Object.freeze({ generation: this.generation, phase: this.phase })
  }
}

module.exports = {
  FAILURE_PRIORITY,
  WindowInteractionGenerationController
}
