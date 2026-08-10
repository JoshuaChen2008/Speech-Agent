'use strict'

const { captionNativeHitAt } = require('./window-layout-contract')

const DEFAULT_POLL_INTERVAL_MS = 16

function isUsableWindow (win) {
  return !!(win && typeof win.isDestroyed === 'function' && !win.isDestroyed() &&
    typeof win.isVisible === 'function' && win.isVisible() &&
    typeof win.isMinimized === 'function' && !win.isMinimized() &&
    typeof win.getBounds === 'function')
}

function isInteractionState (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Number.isSafeInteger(value.generation) &&
    value.generation > 0 && (value.phase === 'suspend' || value.phase === 'resume')
}

class CaptionNativeHitController {
  constructor ({
    applyNativeHit,
    clearTimer = clearTimeout,
    getCaptionWindow,
    getCursorScreenPoint,
    getInteractionState,
    getLocked,
    getToolbarOverlap,
    isGestureActive,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    setTimer = setTimeout
  }) {
    for (const dependency of [
      applyNativeHit, clearTimer, getCaptionWindow, getCursorScreenPoint,
      getInteractionState, getLocked, getToolbarOverlap, isGestureActive, setTimer
    ]) {
      if (typeof dependency !== 'function') {
        throw new TypeError('caption native hit controller dependencies are invalid')
      }
    }
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new TypeError('caption native hit poll interval is invalid')
    }
    this.applyNativeHit = applyNativeHit
    this.clearTimer = clearTimer
    this.getCaptionWindow = getCaptionWindow
    this.getCursorScreenPoint = getCursorScreenPoint
    this.getInteractionState = getInteractionState
    this.getLocked = getLocked
    this.getToolbarOverlap = getToolbarOverlap
    this.isGestureActive = isGestureActive
    this.pollIntervalMs = pollIntervalMs
    this.setTimer = setTimer
    this.running = false
    this.timer = null
    this.lastGeneration = null
    this.lastPhase = null
    this.lastSolid = null
  }

  sampledSolid () {
    try {
      const locked = this.getLocked()
      if (typeof locked !== 'boolean' || locked) return false
      const win = this.getCaptionWindow()
      if (!isUsableWindow(win)) return false
      const overlap = this.getToolbarOverlap()
      if (!overlap || typeof overlap !== 'object') return false
      return captionNativeHitAt({
        captionBounds: win.getBounds(),
        toolbarOverlapRect: overlap.rect,
        pointer: this.getCursorScreenPoint(),
        locked
      })
    } catch {
      /* Missing pointer/window/layout data must preserve pass-through. */
      return false
    }
  }

  evaluate () {
    let state = null
    try { state = this.getInteractionState() } catch { return }
    if (!isInteractionState(state)) return
    if (state.generation !== this.lastGeneration || state.phase !== this.lastPhase) {
      this.lastGeneration = state.generation
      this.lastPhase = state.phase
      this.lastSolid = null
    }
    if (state.phase !== 'resume') return
    try {
      if (this.isGestureActive()) return
    } catch {
      return
    }

    const solid = this.sampledSolid()
    if (solid === this.lastSolid) return
    let applied = false
    try { applied = this.applyNativeHit({ generation: state.generation, solid }) === true } catch { /* fail closed below */ }
    if (applied) this.lastSolid = solid
  }

  runTick () {
    if (!this.running) return
    this.evaluate()
    if (!this.running) return
    this.timer = this.setTimer(() => {
      this.timer = null
      this.runTick()
    }, this.pollIntervalMs)
  }

  start () {
    if (this.running) return false
    this.running = true
    this.runTick()
    return true
  }

  stop () {
    if (!this.running) return false
    this.running = false
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    this.lastGeneration = null
    this.lastPhase = null
    this.lastSolid = null
    return true
  }

  isRunning () { return this.running }
}

module.exports = {
  CaptionNativeHitController,
  DEFAULT_POLL_INTERVAL_MS
}
