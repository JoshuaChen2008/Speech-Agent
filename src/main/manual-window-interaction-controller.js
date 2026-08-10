'use strict'

const { dragBoundsAt, toolbarDockBoundsFor } = require('./window-layout-contract')

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
    getToolbarWindow,
    getLocked,
    getCaptionLimits,
    dock,
    onCaptionResizeEnd = () => {},
    onGeometrySettled = () => {},
    onObservation = () => {},
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    /* Windows 的默认定时器精度是 15.6ms，8ms 兑现不了：一半的 tick 空转，
       只会把抖动放大。对齐一帧比"要得更勤"更顺。 */
    tickIntervalMs = 16
  }) {
    if (typeof getCursorScreenPoint !== 'function' ||
        typeof getCaptionWindow !== 'function' ||
        typeof getToolbarWindow !== 'function' ||
        typeof getLocked !== 'function' ||
        typeof getCaptionLimits !== 'function' ||
        typeof dock !== 'function' ||
        typeof onGeometrySettled !== 'function' ||
        typeof onObservation !== 'function' ||
        typeof setTimer !== 'function' ||
        typeof clearTimer !== 'function' ||
        !Number.isSafeInteger(tickIntervalMs) || tickIntervalMs <= 0) {
      throw new TypeError('manual window interaction dependencies are invalid')
    }
    this.getCursorScreenPoint = getCursorScreenPoint
    this.getCaptionWindow = getCaptionWindow
    this.getToolbarWindow = getToolbarWindow
    this.getLocked = getLocked
    this.getCaptionLimits = getCaptionLimits
    this.dock = dock
    this.onCaptionResizeEnd = onCaptionResizeEnd
    this.onGeometrySettled = onGeometrySettled
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

  settleGeometry (roles) {
    try { this.onGeometrySettled(Object.freeze([...roles])) } catch { /* hit refresh cannot break gesture cleanup */ }
  }

  /**
   * 拖动期间字幕窗尺寸不变，而 toolbarDockBoundsFor 只是字幕 bounds 的一次平移，
   * 所以工具条相对字幕的偏移在整场拖动里是常量。量一次、每帧直接加，就能省掉
   * 每帧的 dock()：那里面有两次 getBounds 和一次重新求解停靠位置。
   * 结果与逐帧 dock() 逐像素相同（平移量都是整数，Math.round 是恒等）。
   * 取不到工具条时留空，dragTick 退回 dock()，行为不变只是慢。
   */
  companionFor (redock, start) {
    if (!redock) return { companion: null, companionOffset: null }
    const companion = this.getToolbarWindow()
    if (!isUsableWindow(companion)) return { companion: null, companionOffset: null }
    const docked = toolbarDockBoundsFor(start)
    return {
      companion,
      companionOffset: { x: docked.x - start.x, y: docked.y - start.y }
    }
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
      /* 拖动只改位置。setBounds 还要走一遍 resize 路径，而这两个都是
         transparent + alwaysOnTop 的分层窗，每次移动都要 DWM 重新合成整窗 ——
         每帧省下来的每一次系统调用都直接换成手感。 */
      state.win.setPosition(nextBounds.x, nextBounds.y)
      state.lastBounds = nextBounds
      if (!state.moved) {
        state.moved = true
        this.observe({ kind: 'drag-move', role: state.role })
      }
      if (state.companion && isUsableWindow(state.companion)) {
        state.companion.setPosition(
          nextBounds.x + state.companionOffset.x,
          nextBounds.y + state.companionOffset.y
        )
      } else if (state.redock) {
        this.dock({ restoreStack: false })
      }
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
      timer: null,
      ...this.companionFor(redock, start)
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
    if (state.moved) {
      if (state.redock) this.settleGeometry(['caption', 'toolbar'])
      else if (state.role === 'toolbar') this.settleGeometry(['toolbar'])
    }
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
    if (state.moved) this.settleGeometry(['caption', 'toolbar'])
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
