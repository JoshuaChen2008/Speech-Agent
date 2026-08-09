'use strict'

const PRIMARY_WINDOW_TITLE = 'Live Subtitle'
const WINDOWS_APP_USER_MODEL_ID = 'com.live-subtitle.desktop'
const AUXILIARY_ROLES = Object.freeze(['settings', 'history'])

function isUsableWindow (win) {
  return !!(win && typeof win.isDestroyed === 'function' && !win.isDestroyed())
}

function overlayApplicationOptions (role) {
  if (role !== 'caption' && role !== 'toolbar') {
    throw new TypeError('overlay application role is invalid')
  }
  return Object.freeze({
    title: PRIMARY_WINDOW_TITLE,
    minimizable: role === 'toolbar',
    skipTaskbar: role !== 'toolbar'
  })
}

function showWindow (win, inactive = false) {
  if (!isUsableWindow(win)) return
  if (inactive && typeof win.showInactive === 'function') win.showInactive()
  else win.show()
}

function sameBounds (left, right) {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height
}

function restoreBounds (entry) {
  if (!entry?.bounds || !isUsableWindow(entry.win)) return
  const current = entry.win.getBounds()
  if (!sameBounds(current, entry.bounds)) entry.win.setBounds(entry.bounds)
}

class ApplicationWindowLifecycleController {
  constructor ({
    getCaptionWindow,
    getToolbarWindow,
    getSettingsWindow,
    getHistoryWindow,
    stopInteractions,
    beginInteractionTransaction,
    resumeInteractions,
    degradeInteractions,
    restoreWindowStack,
    schedulePostRestore = setImmediate,
    onFault = () => {}
  }) {
    for (const dependency of [
      getCaptionWindow,
      getToolbarWindow,
      getSettingsWindow,
      getHistoryWindow,
      stopInteractions,
      beginInteractionTransaction,
      resumeInteractions,
      degradeInteractions,
      restoreWindowStack,
      schedulePostRestore,
      onFault
    ]) {
      if (typeof dependency !== 'function') {
        throw new TypeError('application window lifecycle dependencies are invalid')
      }
    }

    this.getCaptionWindow = getCaptionWindow
    this.getToolbarWindow = getToolbarWindow
    this.getSettingsWindow = getSettingsWindow
    this.getHistoryWindow = getHistoryWindow
    this.stopInteractions = stopInteractions
    this.beginInteractionTransaction = beginInteractionTransaction
    this.resumeInteractions = resumeInteractions
    this.degradeInteractions = degradeInteractions
    this.restoreWindowStack = restoreWindowStack
    this.schedulePostRestore = schedulePostRestore
    this.onFault = onFault
    this.minimizedState = null
    this.transition = null
    this.restoreCommitToken = 0
    this.boundPrimaryWindows = new WeakSet()
    this.boundAuxiliaryWindows = new WeakSet()
  }

  reportFault (code) {
    try { this.onFault({ role: 'application', code }) } catch { /* diagnostics cannot break lifecycle */ }
  }

  bindPrimaryWindow (win) {
    if (!win || typeof win.on !== 'function') throw new TypeError('primary window is invalid')
    if (this.boundPrimaryWindows.has(win)) return
    this.boundPrimaryWindows.add(win)

    win.on('minimize', () => {
      if (this.transition === null) this.minimize()
    })
    win.on('restore', () => {
      if (this.transition === null && this.minimizedState) this.restore()
    })
    win.on('closed', () => {
      if (this.minimizedState?.primary === win) this.minimizedState = null
    })
  }

  bindAuxiliaryWindow (win, role) {
    if (!AUXILIARY_ROLES.includes(role) || !win || typeof win.on !== 'function') {
      throw new TypeError('auxiliary window is invalid')
    }
    if (this.boundAuxiliaryWindows.has(win)) return
    this.boundAuxiliaryWindows.add(win)

    win.on('restore', () => {
      if (this.transition === null && this.minimizedState) this.restore()
    })
  }

  showAuxiliaryWindow (win, role) {
    if (!AUXILIARY_ROLES.includes(role) || !isUsableWindow(win)) {
      throw new TypeError('auxiliary window is invalid')
    }
    if (this.minimizedState) {
      const entry = this.minimizedState.auxiliaries.find((candidate) => candidate.role === role)
      if (entry) {
        entry.win = win
        entry.visible = true
        entry.focused = true
        entry.bounds = win.getBounds()
        this.minimizedState.focused = entry
      }
      return false
    }
    if (win.isMinimized()) win.restore()
    showWindow(win)
    win.focus()
    return true
  }

  readWindowState (win, role) {
    if (!isUsableWindow(win)) return { role, win, visible: false, focused: false, bounds: null }
    const minimized = typeof win.isMinimized === 'function' && win.isMinimized()
    return {
      role,
      win,
      visible: !minimized && win.isVisible(),
      focused: typeof win.isFocused === 'function' && win.isFocused(),
      bounds: win.getBounds()
    }
  }

  captureState (primary) {
    const caption = this.readWindowState(this.getCaptionWindow(), 'caption')
    const auxiliaries = [
      this.readWindowState(this.getSettingsWindow(), 'settings'),
      this.readWindowState(this.getHistoryWindow(), 'history')
    ]
    const focused = auxiliaries.find((entry) => entry.focused) ||
      (typeof primary.isFocused === 'function' && primary.isFocused()
        ? { role: 'toolbar', win: primary, visible: true, focused: true }
        : null)
    return {
      primary,
      primaryBounds: primary.getBounds(),
      caption,
      auxiliaries,
      focused
    }
  }

  stopActiveInteractions () {
    try { this.stopInteractions() } catch { this.reportFault('interaction-stop-failed') }
  }

  resumeInteractionGeneration (generation) {
    return this.resumeInteractions(generation)
  }

  degradeInteractionGeneration (generation) {
    return this.degradeInteractions(generation)
  }

  scheduleBoundsCorrection (state, interactionGeneration, restoreCommitToken) {
    this.schedulePostRestore(() => {
      if (restoreCommitToken !== this.restoreCommitToken ||
          this.minimizedState !== null || this.transition !== null) return
      try {
        restoreBounds({ win: state.primary, bounds: state.primaryBounds })
        if (state.caption.visible) restoreBounds(state.caption)
        for (const entry of state.auxiliaries) {
          if (entry.visible) restoreBounds(entry)
        }
        this.resumeInteractionGeneration(interactionGeneration)
      } catch {
        this.reportFault('post-restore-bounds-failed')
        this.degradeInteractionGeneration(interactionGeneration)
      }
    })
  }

  minimize () {
    const primary = this.getToolbarWindow()
    if (!isUsableWindow(primary)) return false
    if (this.transition !== null) return false
    if (this.minimizedState && primary.isMinimized()) return true

    let state
    try {
      state = this.minimizedState || this.captureState(primary)
    } catch {
      this.reportFault('minimize-state-failed')
      return false
    }

    this.minimizedState = state
    this.transition = 'minimizing'
    this.restoreCommitToken += 1
    this.stopActiveInteractions()
    const interactionGeneration = this.beginInteractionTransaction()
    try {
      if (state.caption.visible && isUsableWindow(state.caption.win)) state.caption.win.hide()
      for (const entry of state.auxiliaries) {
        if (entry.visible && isUsableWindow(entry.win) && !entry.win.isMinimized()) entry.win.minimize()
      }
      if (!primary.isMinimized()) primary.minimize()
      return true
    } catch {
      this.reportFault('minimize-failed')
      if (this.rollbackMinimize(state)) {
        this.minimizedState = null
        this.resumeInteractionGeneration(interactionGeneration)
      } else {
        this.degradeInteractionGeneration(interactionGeneration)
      }
      return false
    } finally {
      this.transition = null
    }
  }

  rollbackMinimize (state) {
    try {
      const primary = state.primary
      if (isUsableWindow(primary)) {
        if (primary.isMinimized()) primary.restore()
        showWindow(primary)
        restoreBounds({ win: primary, bounds: state.primaryBounds })
      }
      if (state.caption.visible) {
        showWindow(state.caption.win, true)
        restoreBounds(state.caption)
      }
      for (const entry of state.auxiliaries) {
        if (!entry.visible || !isUsableWindow(entry.win)) continue
        if (entry.win.isMinimized()) entry.win.restore()
        showWindow(entry.win)
        restoreBounds(entry)
      }
      this.restoreWindowStack()
      if (state.focused && isUsableWindow(state.focused.win)) state.focused.win.focus()
      else if (isUsableWindow(primary)) primary.focus()
      return true
    } catch {
      this.reportFault('minimize-rollback-failed')
      return false
    }
  }

  restore () {
    const primary = this.getToolbarWindow()
    if (!isUsableWindow(primary) || this.transition !== null) return false
    if (!this.minimizedState) return this.restoreOrShow()

    const state = this.minimizedState
    this.transition = 'restoring'
    const restoreCommitToken = ++this.restoreCommitToken
    this.stopActiveInteractions()
    const interactionGeneration = this.beginInteractionTransaction()
    try {
      if (primary.isMinimized()) primary.restore()
      showWindow(primary)
      restoreBounds({ win: primary, bounds: state.primaryBounds })
      if (state.caption.visible) {
        showWindow(state.caption.win, true)
        restoreBounds(state.caption)
      }
      for (const entry of state.auxiliaries) {
        if (!entry.visible || !isUsableWindow(entry.win)) continue
        if (entry.win.isMinimized()) entry.win.restore()
        showWindow(entry.win)
        restoreBounds(entry)
      }
      this.restoreWindowStack()
      if (state.focused && isUsableWindow(state.focused.win)) state.focused.win.focus()
      else primary.focus()
      this.minimizedState = null
      this.scheduleBoundsCorrection(state, interactionGeneration, restoreCommitToken)
      return true
    } catch {
      /* The primary is restored first, so even a later auxiliary failure keeps
         a taskbar-reachable window available for an explicit retry or exit. */
      this.reportFault('restore-failed')
      try {
        if (primary.isMinimized()) primary.restore()
        showWindow(primary)
        primary.focus()
      } catch { this.reportFault('primary-restore-failed') }
      this.degradeInteractionGeneration(interactionGeneration)
      return false
    } finally {
      this.transition = null
    }
  }

  restoreOrShow () {
    const primary = this.getToolbarWindow()
    if (!isUsableWindow(primary) || this.transition !== null) return false
    if (this.minimizedState) return this.restore()

    this.transition = 'showing'
    const restoreCommitToken = ++this.restoreCommitToken
    this.stopActiveInteractions()
    const interactionGeneration = this.beginInteractionTransaction()
    try {
      if (primary.isMinimized()) primary.restore()
      const caption = this.getCaptionWindow()
      if (isUsableWindow(caption) && !caption.isVisible()) showWindow(caption, true)
      showWindow(primary)
      this.restoreWindowStack()
      primary.focus()
      this.schedulePostRestore(() => {
        if (restoreCommitToken === this.restoreCommitToken &&
            this.transition === null && this.minimizedState === null) {
          this.resumeInteractionGeneration(interactionGeneration)
        }
      })
      return true
    } catch {
      this.reportFault('show-failed')
      try {
        if (primary.isMinimized()) primary.restore()
        showWindow(primary)
        primary.focus()
      } catch { this.reportFault('primary-restore-failed') }
      this.degradeInteractionGeneration(interactionGeneration)
      return false
    } finally {
      this.transition = null
    }
  }
}

module.exports = {
  ApplicationWindowLifecycleController,
  PRIMARY_WINDOW_TITLE,
  WINDOWS_APP_USER_MODEL_ID,
  overlayApplicationOptions
}
