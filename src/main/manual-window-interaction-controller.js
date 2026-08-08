'use strict'

const { dragBoundsAt } = require('./window-layout-contract')

const DRAG_ROLES = Object.freeze(['caption', 'toolbar', 'settings', 'history'])
const RESIZE_EDGES = Object.freeze(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'])

function isUsableWindow (win) {
  return !!(win && typeof win.isDestroyed === 'function' && !win.isDestroyed())
}

function sameBounds (left, right) {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height
}

function clamp (value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

class ManualWindowInteractionController {
  constructor ({
    getCursorScreenPoint,
    getCaptionWindow,
    getLocked,
    getCaptionLimits,
    dock,
    onCaptionResizeEnd = () => {},
    onObservation = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    tickIntervalMs = 8
  }) {
    if (typeof getCursorScreenPoint !== 'function' ||
        typeof getCaptionWindow !== 'function' ||
        typeof getLocked !== 'function' ||
        typeof getCaptionLimits !== 'function' ||
        typeof dock !== 'function' ||
        typeof onObservation !== 'function' ||
        typeof setTimer !== 'function' ||
        typeof clearTimer !== 'function' ||
        !Number.isSafeInteger(tickIntervalMs) || tickIntervalMs <= 0) {
      throw new TypeError('manual window interaction dependencies are invalid')
    }
    this.getCursorScreenPoint = getCursorScreenPoint
    this.getCaptionWindow = getCaptionWindow
    this.getLocked = getLocked
    this.getCaptionLimits = getCaptionLimits
    this.dock = dock
    this.onCaptionResizeEnd = onCaptionResizeEnd
    this.onObservation = onObservation
    this.setTimer = setTimer
    this.clearTimer = clearTimer
    this.tickIntervalMs = tickIntervalMs
    this.dragState = null
    this.resizeState = null
  }

  observe (value) {
    try { this.onObservation(Object.freeze({ ...value })) } catch { /* evidence must not alter interaction */ }
  }

  dragTick () {
    const state = this.dragState
    if (!state) return
    if (!isUsableWindow(state.win)) {
      this.stopDrag(null, true)
      return
    }
    const point = this.getCursorScreenPoint()
    const nextBounds = dragBoundsAt(state.start, state.origin, point)
    if (!sameBounds(nextBounds, state.lastBounds)) {
      state.win.setBounds(nextBounds)
      state.lastBounds = nextBounds
      if (!state.moved) {
        state.moved = true
        this.observe({ kind: 'drag-move', role: state.role })
      }
      if (state.redock) this.dock({ restoreStack: false })
    }
    if (this.dragState === state) {
      state.timer = this.setTimer(() => this.dragTick(), this.tickIntervalMs)
    }
  }

  startDrag ({ role, win, senderId }) {
    this.stopAll()
    if (!DRAG_ROLES.includes(role) || !isUsableWindow(win)) return false

    let target = win
    let redock = false
    if (role === 'toolbar' && !this.getLocked()) {
      target = this.getCaptionWindow()
      redock = true
    } else if (role === 'caption') {
      if (this.getLocked() || win !== this.getCaptionWindow()) return false
      redock = true
    }
    if (!isUsableWindow(target)) return false

    const origin = this.getCursorScreenPoint()
    const start = target.getBounds()
    this.dragState = {
      senderId,
      win: target,
      origin,
      start,
      lastBounds: start,
      redock,
      role,
      moved: false,
      timer: null
    }
    this.observe({ kind: 'drag-start', role })
    this.dragTick()
    return true
  }

  stopDrag (senderId, force = false) {
    const state = this.dragState
    if (!state || (!force && state.senderId !== senderId)) return false
    this.dragState = null
    if (state.timer !== null) this.clearTimer(state.timer)
    this.observe({ kind: 'drag-end', role: state.role, moved: state.moved })
    return true
  }

  resizeTick () {
    const state = this.resizeState
    if (!state) return
    if (!isUsableWindow(state.win)) {
      this.stopResize(null, true)
      return
    }
    const point = this.getCursorScreenPoint()
    const dx = point.x - state.origin.x
    const dy = point.y - state.origin.y
    let width = state.start.width
    let height = state.start.height
    if (state.edge.includes('e')) width = state.start.width + dx
    if (state.edge.includes('w')) width = state.start.width - dx
    if (state.edge.includes('s')) height = state.start.height + dy
    if (state.edge.includes('n')) height = state.start.height - dy
    width = clamp(width, state.limits.minW, state.limits.maxW)
    height = clamp(height, state.limits.minH, state.limits.maxH)
    const nextBounds = {
      x: state.edge.includes('w') ? state.start.x + state.start.width - width : state.start.x,
      y: state.edge.includes('n') ? state.start.y + state.start.height - height : state.start.y,
      width,
      height
    }
    if (!sameBounds(nextBounds, state.lastBounds)) {
      state.win.setBounds(nextBounds)
      state.lastBounds = nextBounds
      if (!state.moved) {
        state.moved = true
        this.observe({ kind: 'resize-move', role: 'caption' })
      }
      this.dock({ restoreStack: false })
    }
    if (this.resizeState === state) {
      state.timer = this.setTimer(() => this.resizeTick(), this.tickIntervalMs)
    }
  }

  startResize ({ win, senderId, edge }) {
    this.stopAll()
    if (this.getLocked() || win !== this.getCaptionWindow() ||
        !isUsableWindow(win) || !RESIZE_EDGES.includes(edge)) return false
    const start = win.getBounds()
    this.resizeState = {
      senderId,
      win,
      edge,
      start,
      lastBounds: start,
      origin: this.getCursorScreenPoint(),
      limits: this.getCaptionLimits(win),
      moved: false,
      timer: null
    }
    this.observe({ kind: 'resize-start', role: 'caption' })
    this.resizeTick()
    return true
  }

  stopResize (senderId, force = false) {
    const state = this.resizeState
    if (!state || (!force && state.senderId !== senderId)) return false
    this.resizeState = null
    if (state.timer !== null) this.clearTimer(state.timer)
    if (isUsableWindow(state.win)) this.onCaptionResizeEnd(state.win.getBounds())
    this.observe({ kind: 'resize-end', role: 'caption', moved: state.moved })
    return true
  }

  stopForSender (senderId) {
    this.stopDrag(senderId)
    this.stopResize(senderId)
  }

  stopAll () {
    this.stopDrag(null, true)
    this.stopResize(null, true)
  }

  isDragging () { return this.dragState !== null }
  isResizing () { return this.resizeState !== null }
}

module.exports = {
  ManualWindowInteractionController,
  RESIZE_EDGES,
  sameBounds
}
