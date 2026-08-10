'use strict'

const {
  WINDOW_LAYOUT,
  dragBoundsAt,
  toolbarDockBoundsFor
} = require('./window-layout-contract')
const { toolbarWindowViewportBounds } = require('./toolbar-dock-invariant')

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
    onInteractionEnded = () => {},
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
        typeof onInteractionEnded !== 'function' ||
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
    this.onInteractionEnded = onInteractionEnded
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

  finishInteraction (value) {
    try { this.onInteractionEnded(Object.freeze({ ...value })) } catch { /* invariant re-arm cannot break cleanup */ }
  }

  moveWindow (win, bounds, isToolbar) {
    if (isToolbar) {
      /* BrowserWindow.setPosition() can replay a stale Win32 normal-placement
         size while moving the fixed toolbar. Submit the viewport dimensions
         with every toolbar translation so a move cannot become a resize. */
      const viewportBounds = {
        x: bounds.x,
        y: bounds.y,
        width: WINDOW_LAYOUT.toolbarViewportWidth,
        height: WINDOW_LAYOUT.toolbarViewportHeight
      }
      if (typeof win.setContentBounds === 'function') win.setContentBounds(viewportBounds)
      else win.setBounds(viewportBounds)
      return
    }
    win.setPosition(bounds.x, bounds.y)
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
      this.moveWindow(state.win, nextBounds, state.targetIsToolbar)
      state.lastBounds = nextBounds
      if (!state.moved) {
        state.moved = true
        this.observe({ kind: 'drag-move', role: state.role })
      }
      if (state.companion && isUsableWindow(state.companion)) {
        this.moveWindow(state.companion, {
          x: nextBounds.x + state.companionOffset.x,
          y: nextBounds.y + state.companionOffset.y
        }, true)
      } else if (state.redock) {
        this.dock({ restoreStack: false })
      }
    }
    if (this.dragState === state) {
      state.timer = this.setTimer(() => this.dragTick(), this.tickIntervalMs)
    }
  }

  startDrag ({ role, win, senderId }) {
    if (!DRAG_ROLES.includes(role) || !isUsableWindow(win)) return false
    /* 嵌入态由字幕卡负责移动组合。即使过期 renderer 绕过 CSS 发出工具条
       意图，也必须在停止当前手势之前拒绝，不能让它取消正在进行的字幕拖动。 */
    if (role === 'toolbar' && (!this.getLocked() || win !== this.getToolbarWindow())) return false
    if (role === 'caption' && (this.getLocked() || win !== this.getCaptionWindow())) return false

    this.stopAll()

    let target = win
    let redock = false
    if (role === 'caption') {
      redock = true
    }
    if (!isUsableWindow(target)) return false

    const origin = this.getCursorScreenPoint()
    const targetIsToolbar = target === this.getToolbarWindow()
    const start = targetIsToolbar
      ? toolbarWindowViewportBounds(target)
      : target.getBounds()
    this.dragState = {
      senderId,
      win: target,
      origin,
      start,
      lastBounds: start,
      targetIsToolbar,
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
    this.finishInteraction({ kind: 'drag', role: state.role, redock: state.redock, moved: state.moved })
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
  getActiveSenderId () {
    return this.dragState?.senderId ?? this.resizeState?.senderId ?? null
  }
}

module.exports = {
  ManualWindowInteractionController,
  RESIZE_EDGES,
  sameBounds
}
