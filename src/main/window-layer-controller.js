'use strict'

const FOREGROUND_ROLES = Object.freeze(['settings', 'history'])

function isUsableWindow (win) {
  return !!(win && typeof win.isDestroyed === 'function' && !win.isDestroyed())
}

class WindowLayerController {
  constructor ({ getCaptionWindow, getToolbarWindow, onFault = () => {} }) {
    this.getCaptionWindow = getCaptionWindow
    this.getToolbarWindow = getToolbarWindow
    this.onFault = onFault
    this.active = null
    this.bound = new WeakSet()
    this.disposed = false
  }

  reportFault (role, code) {
    try { this.onFault({ role, code }) } catch { /* diagnostics cannot break window control */ }
  }

  bindForegroundWindow (win, role) {
    if (!FOREGROUND_ROLES.includes(role) || !win || typeof win.on !== 'function') {
      throw new TypeError('foreground window role is invalid')
    }
    if (this.bound.has(win)) return
    this.bound.add(win)

    win.on('focus', () => this.promote(win, role))
    win.on('blur', () => this.demoteIfActive(win, role))
    win.on('closed', () => this.demoteIfActive(win, role))
    if (win.webContents && typeof win.webContents.on === 'function') {
      win.webContents.on('destroyed', () => this.demoteIfActive(win, role))
    }
  }

  promote (win, role) {
    if (this.disposed || !isUsableWindow(win)) return
    if (this.active && this.active.win !== win) this.demoteIfActive(this.active.win, this.active.role)

    try {
      win.setAlwaysOnTop(true, 'screen-saver')
      win.moveTop()
    } catch {
      try { if (isUsableWindow(win)) win.setAlwaysOnTop(false) } catch { /* best effort */ }
      this.reportFault(role, 'promote-failed')
      return
    }
    this.active = { win, role }
  }

  demoteIfActive (win, role) {
    if (!this.active || this.active.win !== win) return
    this.active = null
    if (!isUsableWindow(win)) return
    try { win.setAlwaysOnTop(false) } catch { this.reportFault(role, 'demote-failed') }
  }

  moveTop (win, role) {
    if (!isUsableWindow(win)) return
    try { win.moveTop() } catch { this.reportFault(role, 'restack-failed') }
  }

  restoreWindowStack () {
    if (this.disposed) return
    this.moveTop(this.getCaptionWindow?.(), 'caption')
    this.moveTop(this.getToolbarWindow?.(), 'toolbar')
    if (this.active && isUsableWindow(this.active.win)) {
      this.moveTop(this.active.win, this.active.role)
    } else if (this.active) {
      this.active = null
    }
  }

  getActiveRole () {
    if (this.active && !isUsableWindow(this.active.win)) this.active = null
    return this.active?.role || null
  }

  dispose () {
    if (this.disposed) return
    if (this.active) this.demoteIfActive(this.active.win, this.active.role)
    this.disposed = true
  }
}

module.exports = { WindowLayerController }
