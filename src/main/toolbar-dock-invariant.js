'use strict'

const {
  WINDOW_LAYOUT,
  toolbarDockBoundsFor
} = require('./window-layout-contract')

const TOOLBAR_CORRECTION_SETTLE_MS = 250
const TOOLBAR_CORRECTION_MAX_WRITES = 4
const TOOLBAR_CORRECTION_MAX_MS = 1000
const TOOLBAR_OUTER_FRAME_TOLERANCE_DIP = 1

function toolbarViewportBoundsFor (toolbarBounds) {
  return {
    x: toolbarBounds.x,
    y: toolbarBounds.y,
    width: WINDOW_LAYOUT.toolbarViewportWidth,
    height: WINDOW_LAYOUT.toolbarViewportHeight
  }
}

function toolbarWindowViewportBounds (toolbar) {
  const bounds = typeof toolbar.getContentBounds === 'function'
    ? toolbar.getContentBounds()
    : toolbar.getBounds()
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height
  }
}

function toolbarDockInvariantBoundsFor ({ captionBounds, toolbarBounds, locked }) {
  if (typeof locked !== 'boolean') throw new TypeError('toolbar lock state is invalid')
  return locked
    ? toolbarViewportBoundsFor(toolbarBounds)
    : toolbarDockBoundsFor(captionBounds)
}

function sameBounds (left, right) {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height
}

function toolbarOuterFrameEquivalent (toolbar) {
  if (typeof toolbar.getContentBounds !== 'function') return true
  const outer = toolbar.getBounds()
  const content = toolbar.getContentBounds()
  return ['x', 'y', 'width', 'height'].every((key) =>
    Number.isFinite(outer[key]) && Number.isFinite(content[key]) &&
    Math.abs(outer[key] - content[key]) <= TOOLBAR_OUTER_FRAME_TOLERANCE_DIP)
}

function toolbarViewportStateEquivalent (toolbar, expected) {
  return sameBounds(toolbarWindowViewportBounds(toolbar), expected) &&
    toolbarOuterFrameEquivalent(toolbar)
}

function toolbarWindowGeometry (toolbar) {
  return {
    content: toolbarWindowViewportBounds(toolbar),
    outer: { ...toolbar.getBounds() }
  }
}

function sameToolbarWindowGeometry (left, right) {
  return !!left && !!right &&
    sameBounds(left.content, right.content) && sameBounds(left.outer, right.outer)
}

function bindToolbarDockInvariant ({
  toolbar,
  getDockBounds,
  setDockBounds,
  scheduleVerification = (callback, delayMs) => setTimeout(callback, delayMs),
  cancelVerification = (handle) => clearTimeout(handle),
  onCorrected = () => {},
  onFault = () => {}
}) {
  if (!toolbar || typeof toolbar.on !== 'function' ||
      typeof toolbar.isDestroyed !== 'function' ||
      typeof toolbar.getBounds !== 'function' ||
      typeof getDockBounds !== 'function' ||
      typeof setDockBounds !== 'function' ||
      typeof scheduleVerification !== 'function' ||
      typeof cancelVerification !== 'function' ||
      typeof onCorrected !== 'function' ||
      typeof onFault !== 'function') {
    throw new TypeError('toolbar dock invariant dependencies are invalid')
  }

  let correcting = false
  let correctionSuspended = false
  let pending = null
  let failedCorrection = null
  let nextVersion = 0
  let authoritativeBounds = toolbarViewportBoundsFor(toolbarWindowViewportBounds(toolbar))
  const notifyCorrected = () => {
    try { onCorrected() } catch { /* pointer re-hit cannot undo a successful correction */ }
  }
  const reportCorrectionFault = () => {
    try { onFault({ role: 'toolbar', code: 'toolbar-dock-correction-failed' }) } catch { /* diagnostics only */ }
  }
  const cancelPending = () => {
    const stale = pending
    pending = null
    nextVersion += 1
    if (stale?.handle !== null && stale?.handle !== undefined) {
      try { cancelVerification(stale.handle) } catch { /* version check rejects an uncancelled callback */ }
    }
    if (stale?.deadlineHandle !== null && stale?.deadlineHandle !== undefined) {
      try { cancelVerification(stale.deadlineHandle) } catch { /* version check rejects an uncancelled callback */ }
    }
  }
  const beginPending = (expected, correctionIssued = false) => {
    cancelPending()
    pending = {
      version: ++nextVersion,
      expected: { ...expected },
      correctionIssued,
      correctionWrites: 0,
      lastCorrectionObserved: null,
      handle: null,
      deadlineHandle: null,
      timerVersion: 0,
      deadlineVersion: 0
    }
    return pending
  }
  const getAuthoritativeBounds = () => ({ ...authoritativeBounds })
  const currentExpected = () => getDockBounds(getAuthoritativeBounds())
  const getExpectedBounds = () => ({ ...currentExpected() })
  const replaceExpectedIfNeeded = (state, expected) => {
    if (sameBounds(state.expected, expected)) return false
    if (state.deadlineHandle !== null && state.deadlineHandle !== undefined) {
      try { cancelVerification(state.deadlineHandle) } catch { /* state version still rejects stale work */ }
      state.deadlineHandle = null
    }
    state.deadlineVersion += 1
    state.expected = { ...expected }
    state.correctionIssued = false
    state.correctionWrites = 0
    state.lastCorrectionObserved = null
    return true
  }
  let verifyPending = () => {}
  let finishPendingAtDeadline = () => {}
  const scheduleDeadline = (state) => {
    if (pending !== state || state.deadlineHandle !== null) return
    const version = state.version
    const deadlineVersion = ++state.deadlineVersion
    state.deadlineHandle = scheduleVerification(() => {
      if (pending !== state || state.version !== version || state.deadlineVersion !== deadlineVersion) return
      state.deadlineHandle = null
      finishPendingAtDeadline(state)
    }, TOOLBAR_CORRECTION_MAX_MS)
  }
  const schedulePending = (state) => {
    if (pending !== state) return
    if (state.handle !== null && state.handle !== undefined) {
      try { cancelVerification(state.handle) } catch { /* timerVersion rejects the stale callback */ }
    }
    const timerVersion = ++state.timerVersion
    state.handle = scheduleVerification(() => {
      if (pending !== state || state.version !== pending.version || timerVersion !== state.timerVersion) return
      state.handle = null
      verifyPending(state)
    }, TOOLBAR_CORRECTION_SETTLE_MS)
    scheduleDeadline(state)
  }
  const issueCorrection = (state, expected, force = false) => {
    const observed = toolbarWindowGeometry(toolbar)
    if (!force && sameToolbarWindowGeometry(observed, state.lastCorrectionObserved)) return false
    if (state.correctionWrites >= TOOLBAR_CORRECTION_MAX_WRITES) return false
    state.lastCorrectionObserved = observed
    setDockBounds(expected)
    if (pending !== state) return false
    state.correctionIssued = true
    state.correctionWrites += 1
    return true
  }
  const failPending = (expected = pending?.expected || null) => {
    const failedState = pending
    let observed = null
    try { observed = toolbarWindowGeometry(toolbar) } catch { /* the fixed diagnostic remains geometry-free */ }
    const duplicate = expected && failedCorrection &&
      sameBounds(expected, failedCorrection.expected) &&
      sameToolbarWindowGeometry(observed, failedCorrection.observed)
    cancelPending()
    if (expected) {
      failedCorrection = {
        expected: { ...expected },
        observed,
        correctionIssued: failedState?.correctionIssued === true
      }
    }
    if (!duplicate) reportCorrectionFault()
  }
  verifyPending = (state) => {
    if (pending !== state) return
    if (toolbar.isDestroyed()) {
      cancelPending()
      return
    }
    if (correcting) {
      try { schedulePending(state) } catch { failPending(state.expected) }
      return
    }
    correcting = true
    let shouldNotify = false
    let shouldReschedule = false
    try {
      const expected = currentExpected()
      replaceExpectedIfNeeded(state, expected)
      if (toolbarViewportStateEquivalent(toolbar, expected)) {
        shouldNotify = state.correctionIssued
        cancelPending()
      } else {
        issueCorrection(state, expected, true)
        shouldReschedule = pending === state
      }
    } catch {
      failPending(state.expected)
    } finally {
      correcting = false
    }
    if (shouldNotify) notifyCorrected()
    if (shouldReschedule) {
      try { schedulePending(state) } catch { failPending(state.expected) }
    }
  }
  finishPendingAtDeadline = (state) => {
    if (pending !== state) return
    if (toolbar.isDestroyed()) {
      cancelPending()
      return
    }
    let shouldNotify = false
    try {
      const expected = currentExpected()
      if (replaceExpectedIfNeeded(state, expected)) {
        schedulePending(state)
        return
      }
      if (!toolbarViewportStateEquivalent(toolbar, expected)) {
        failPending(state.expected)
        return
      }
      shouldNotify = state.correctionIssued
      cancelPending()
    } catch {
      failPending(state.expected)
      return
    }
    if (shouldNotify) notifyCorrected()
  }
  const correct = () => {
    if (correcting || correctionSuspended || toolbar.isDestroyed()) return
    correcting = true
    let state = pending
    let shouldSchedule = false
    let inheritedCorrection = false
    try {
      const expected = currentExpected()
      if (failedCorrection) {
        if (sameBounds(failedCorrection.expected, expected)) {
          const observed = toolbarWindowGeometry(toolbar)
          if (sameToolbarWindowGeometry(observed, failedCorrection.observed)) return
          inheritedCorrection = failedCorrection.correctionIssued
        }
        failedCorrection = null
      }
      if (!state && toolbarViewportStateEquivalent(toolbar, expected) && !inheritedCorrection) return
      if (state) replaceExpectedIfNeeded(state, expected)
      else state = beginPending(expected, inheritedCorrection)
      if (!toolbarViewportStateEquivalent(toolbar, expected)) issueCorrection(state, expected)
      shouldSchedule = pending === state
    } catch {
      failPending(state?.expected)
    } finally {
      correcting = false
    }
    if (shouldSchedule) {
      try { schedulePending(state) } catch { failPending(state?.expected) }
    }
  }
  const commitBounds = (bounds = null) => {
    if (toolbar.isDestroyed()) return false
    try {
      correctionSuspended = false
      failedCorrection = null
      cancelPending()
      const committed = bounds === null ? toolbarWindowViewportBounds(toolbar) : bounds
      authoritativeBounds = toolbarViewportBoundsFor(committed)
      const expected = currentExpected()
      const state = beginPending(expected)
      if (!toolbarViewportStateEquivalent(toolbar, expected)) issueCorrection(state, expected)
      if (pending === state) schedulePending(state)
      return true
    } catch {
      failPending()
      return false
    }
  }
  const suspendCorrection = () => {
    cancelPending()
    correctionSuspended = true
  }
  const observeMove = () => correct()

  toolbar.on('resize', correct)
  toolbar.on('move', observeMove)
  return Object.freeze({
    commitBounds,
    getAuthoritativeBounds,
    getExpectedBounds,
    suspendCorrection,
    unbind () {
      cancelPending()
      if (typeof toolbar.off === 'function') toolbar.off('resize', correct)
      else if (typeof toolbar.removeListener === 'function') toolbar.removeListener('resize', correct)
      if (typeof toolbar.off === 'function') toolbar.off('move', observeMove)
      else if (typeof toolbar.removeListener === 'function') toolbar.removeListener('move', observeMove)
    }
  })
}

module.exports = {
  bindToolbarDockInvariant,
  TOOLBAR_CORRECTION_MAX_MS,
  TOOLBAR_CORRECTION_MAX_WRITES,
  TOOLBAR_CORRECTION_SETTLE_MS,
  TOOLBAR_OUTER_FRAME_TOLERANCE_DIP,
  toolbarDockInvariantBoundsFor,
  toolbarOuterFrameEquivalent,
  toolbarViewportBoundsFor,
  toolbarViewportStateEquivalent,
  toolbarWindowViewportBounds
}
