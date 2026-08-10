'use strict'

const {
  toolbarViewportBoundsFor,
  toolbarViewportStateEquivalent,
  toolbarWindowViewportBounds
} = require('./toolbar-dock-invariant')

const PRIMARY_WINDOW_TITLE = 'Live Subtitle'
const WINDOWS_APP_USER_MODEL_ID = 'com.live-subtitle.desktop'
const AUXILIARY_ROLES = Object.freeze(['settings', 'history'])
const AUXILIARY_BOUNDS_TOLERANCE_DIP = 1
const POST_RESTORE_QUIET_MS = 250
const POST_RESTORE_MAX_MS = 1000
const POST_RESTORE_FINAL_COMMIT_MS = 250

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

function overlayWindowBehavior (role, focusable = true) {
  if (typeof focusable !== 'boolean') throw new TypeError('overlay focusable flag is invalid')
  return Object.freeze({
    ...overlayApplicationOptions(role),
    ...(role === 'toolbar' ? { useContentSize: true } : {}),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    alwaysOnTop: true,
    hasShadow: false,
    focusable
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

function restoreBoundsEquivalent (role, left, right) {
  if (!left || !right) return false
  if (!AUXILIARY_ROLES.includes(role)) return sameBounds(left, right)
  return ['x', 'y', 'width', 'height']
    .every((key) => Number.isFinite(left[key]) && Number.isFinite(right[key]) &&
      Math.abs(left[key] - right[key]) <= AUXILIARY_BOUNDS_TOLERANCE_DIP)
}

function restoreBounds (entry) {
  if (!entry?.bounds || !isUsableWindow(entry.win)) return false
  if (entry.role === 'toolbar') {
    if (toolbarViewportStateEquivalent(entry.win, entry.bounds)) return false
    if (typeof entry.win.setContentBounds === 'function') {
      entry.win.setContentBounds(entry.bounds)
    } else {
      entry.win.setBounds(entry.bounds)
    }
    return true
  }
  const current = entry.role === 'toolbar'
    ? toolbarWindowViewportBounds(entry.win)
    : entry.win.getBounds()
  if (restoreBoundsEquivalent(entry.role, current, entry.bounds)) return false
  entry.win.setBounds(entry.bounds)
  return true
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
    schedulePostRestore = (callback, delayMs) => setTimeout(callback, delayMs),
    cancelPostRestore = (handle) => clearTimeout(handle),
    suspendGeometryCorrections = () => {},
    getPrimaryRestoreBounds = (primary) => toolbarViewportBoundsFor(toolbarWindowViewportBounds(primary)),
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
      cancelPostRestore,
      suspendGeometryCorrections,
      getPrimaryRestoreBounds,
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
    this.cancelPostRestore = cancelPostRestore
    this.suspendGeometryCorrections = suspendGeometryCorrections
    this.getPrimaryRestoreBounds = getPrimaryRestoreBounds
    this.onFault = onFault
    this.minimizedState = null
    this.pendingRecoveryState = null
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
      if (this.pendingRecoveryState?.primary === win) this.pendingRecoveryState = null
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
      /* The taskbar primary is the fixed toolbar viewport. Never let a native
         minimize/restore rounding resize become the next saved baseline. Its
         independent x/y (when locked) remains part of the captured state. */
      primaryBounds: this.getPrimaryRestoreBounds(primary),
      caption,
      auxiliaries,
      focused
    }
  }

  refreshRecoveryState (state, primary) {
    const cloneEntry = (entry, win) => ({
      ...entry,
      win,
      bounds: entry.bounds ? { ...entry.bounds } : null
    })
    const caption = cloneEntry(state.caption, this.getCaptionWindow())
    const auxiliaries = state.auxiliaries.map((entry) => {
      const win = entry.role === 'settings' ? this.getSettingsWindow() : this.getHistoryWindow()
      if (!isUsableWindow(win)) {
        return { ...entry, win, visible: false, focused: false, bounds: null }
      }
      return cloneEntry(entry, win)
    })
    const focused = state.focused?.role === 'toolbar'
      ? { ...state.focused, win: primary }
      : auxiliaries.find((entry) => entry.visible && entry.role === state.focused?.role) || null
    return {
      primary,
      primaryBounds: { ...state.primaryBounds },
      caption,
      auxiliaries,
      focused
    }
  }

  stopActiveInteractions () {
    try { this.stopInteractions() } catch { this.reportFault('interaction-stop-failed') }
  }

  resumeInteractionGeneration (generation, primaryBounds = null) {
    return this.resumeInteractions(generation, primaryBounds)
  }

  degradeInteractionGeneration (generation) {
    return this.degradeInteractions(generation)
  }

  scheduleBoundsCorrection (state, interactionGeneration, restoreCommitToken) {
    this.pendingRecoveryState = state
    const entries = [
      { role: 'toolbar', win: state.primary, bounds: state.primaryBounds },
      ...(state.caption.visible ? [state.caption] : []),
      ...state.auxiliaries.filter((entry) => entry.visible)
    ]
    let active = true
    let correcting = false
    let quietHandle = null
    let maximumHandle = null
    let finalCommitHandle = null
    let finalCommitPending = false
    let quietVersion = 0
    const listeners = []
    const isCurrent = () => restoreCommitToken === this.restoreCommitToken &&
      this.minimizedState === null
    const cancelTimer = (handle) => {
      if (handle === null || handle === undefined) return
      try { this.cancelPostRestore(handle) } catch { /* stale timer version still rejects itself */ }
    }
    const cleanup = () => {
      cancelTimer(quietHandle)
      cancelTimer(maximumHandle)
      cancelTimer(finalCommitHandle)
      quietHandle = null
      maximumHandle = null
      finalCommitHandle = null
      for (const { win, event, listener } of listeners) {
        if (typeof win.off === 'function') win.off(event, listener)
        else if (typeof win.removeListener === 'function') win.removeListener(event, listener)
      }
    }
    const abandon = () => {
      if (!active) return
      active = false
      cleanup()
    }
    const correctBounds = () => {
      if (correcting) return false
      correcting = true
      let changed = false
      try {
        for (const entry of entries) changed = restoreBounds(entry) || changed
      } finally {
        correcting = false
      }
      return changed
    }
    const boundsAreSettled = () => entries.every((entry) => {
      if (AUXILIARY_ROLES.includes(entry?.role) && !isUsableWindow(entry.win)) return true
      if (!entry?.bounds || !isUsableWindow(entry.win)) return false
      try {
        if (entry.role === 'toolbar') {
          return toolbarViewportStateEquivalent(entry.win, entry.bounds)
        }
        const current = entry.win.getBounds()
        return restoreBoundsEquivalent(entry.role, current, entry.bounds)
      } catch { return false }
    })
    const fail = () => {
      if (!active) return
      active = false
      cleanup()
      this.reportFault('post-restore-bounds-failed')
      this.degradeInteractionGeneration(interactionGeneration)
    }
    const resume = () => {
      if (!active) return
      active = false
      cleanup()
      let resumed = false
      try {
        resumed = this.resumeInteractionGeneration(interactionGeneration, state.primaryBounds) === true
      } catch { /* degrade below */ }
      if (!resumed) {
        try { this.degradeInteractionGeneration(interactionGeneration) } catch { /* controller owns fixed diagnostics */ }
      } else if (this.pendingRecoveryState === state) {
        this.pendingRecoveryState = null
      }
    }
    const scheduleQuiet = () => {
      if (!active) return
      quietVersion += 1
      const version = quietVersion
      cancelTimer(quietHandle)
      quietHandle = this.schedulePostRestore(() => {
        if (!active || version !== quietVersion) return
        quietHandle = null
        if (!isCurrent()) {
          abandon()
          return
        }
        if (this.transition !== null) {
          scheduleQuiet()
          return
        }
        try {
          if (correctBounds()) {
            scheduleQuiet()
            return
          }
          if (!boundsAreSettled()) {
            scheduleQuiet()
            return
          }
          this.restoreWindowStack()
          resume()
        } catch { fail() }
      }, POST_RESTORE_QUIET_MS)
    }
    const scheduleFinalCommitConfirmation = () => {
      if (!active) return
      finalCommitPending = true
      quietVersion += 1
      cancelTimer(quietHandle)
      quietHandle = null
      cancelTimer(finalCommitHandle)
      finalCommitHandle = this.schedulePostRestore(() => {
        if (!active) return
        finalCommitHandle = null
        if (!isCurrent()) {
          abandon()
          return
        }
        if (this.transition !== null) {
          fail()
          return
        }
        try {
          if (!boundsAreSettled()) {
            fail()
            return
          }
          this.restoreWindowStack()
          resume()
        } catch { fail() }
      }, POST_RESTORE_FINAL_COMMIT_MS)
    }
    const correctLateNativeDrift = () => {
      if (!active) return
      if (!isCurrent()) {
        abandon()
        return
      }
      if (finalCommitPending) return
      scheduleQuiet()
      if (this.transition !== null || correcting) return
      try {
        if (correctBounds()) scheduleQuiet()
      } catch { fail() }
    }
    for (const entry of entries) {
      if (!entry.win || typeof entry.win.on !== 'function') continue
      for (const event of ['move', 'resize']) {
        entry.win.on(event, correctLateNativeDrift)
        listeners.push({ win: entry.win, event, listener: correctLateNativeDrift })
      }
    }

    scheduleQuiet()
    maximumHandle = this.schedulePostRestore(() => {
      if (!active) return
      maximumHandle = null
      if (!isCurrent()) {
        abandon()
        return
      }
      if (this.transition !== null) {
        fail()
        return
      }
      try {
        const corrected = correctBounds()
        if (corrected) {
          this.suspendGeometryCorrections()
          scheduleFinalCommitConfirmation()
          return
        }
        if (!boundsAreSettled()) {
          fail()
          return
        }
        this.restoreWindowStack()
        resume()
      } catch { fail() }
    }, POST_RESTORE_MAX_MS)
  }

  minimize () {
    const primary = this.getToolbarWindow()
    if (!isUsableWindow(primary)) return false
    if (this.transition !== null) return false
    if (this.minimizedState && primary.isMinimized()) return true

    this.stopActiveInteractions()
    let state
    try {
      state = this.minimizedState || (this.pendingRecoveryState
        ? this.refreshRecoveryState(this.pendingRecoveryState, primary)
        : this.captureState(primary))
      if (this.pendingRecoveryState && state !== this.minimizedState) {
        this.pendingRecoveryState = state
      }
    } catch {
      this.reportFault('minimize-state-failed')
      return false
    }

    this.minimizedState = state
    this.transition = 'minimizing'
    this.restoreCommitToken += 1
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
        const resumed = this.resumeInteractionGeneration(interactionGeneration, state.primaryBounds) === true
        if (resumed && this.pendingRecoveryState === state) this.pendingRecoveryState = null
        else if (!resumed) this.degradeInteractionGeneration(interactionGeneration)
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
        restoreBounds({ role: 'toolbar', win: primary, bounds: state.primaryBounds })
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
      restoreBounds({ role: 'toolbar', win: primary, bounds: state.primaryBounds })
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
      let state
      if (this.pendingRecoveryState) {
        state = this.refreshRecoveryState(this.pendingRecoveryState, primary)
        this.pendingRecoveryState = state
        showWindow(primary)
        if (state.caption.visible && isUsableWindow(state.caption.win)) {
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
      } else {
        const caption = this.getCaptionWindow()
        if (isUsableWindow(caption) && !caption.isVisible()) showWindow(caption, true)
        showWindow(primary)
        this.restoreWindowStack()
        primary.focus()
        state = this.captureState(primary)
      }
      restoreBounds({ role: 'toolbar', win: primary, bounds: state.primaryBounds })
      this.scheduleBoundsCorrection(state, interactionGeneration, restoreCommitToken)
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
  AUXILIARY_BOUNDS_TOLERANCE_DIP,
  POST_RESTORE_FINAL_COMMIT_MS,
  POST_RESTORE_MAX_MS,
  POST_RESTORE_QUIET_MS,
  PRIMARY_WINDOW_TITLE,
  WINDOWS_APP_USER_MODEL_ID,
  overlayApplicationOptions,
  overlayWindowBehavior,
  restoreBoundsEquivalent
}
