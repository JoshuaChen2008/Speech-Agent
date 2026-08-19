'use strict'

const OVERLAY_STARTUP_TIMEOUT_MS = 5000

class OverlayStartupController {
  constructor ({
    loadRole,
    prepareAttempt,
    showReachableToolbar,
    settleGeometry,
    activateOverlays,
    promptRecovery,
    exitApplication,
    scheduleTimeout = (callback, delayMs) => setTimeout(callback, delayMs),
    cancelTimeout = (handle) => clearTimeout(handle)
  }) {
    for (const dependency of [
      loadRole,
      prepareAttempt,
      showReachableToolbar,
      settleGeometry,
      activateOverlays,
      promptRecovery,
      exitApplication,
      scheduleTimeout,
      cancelTimeout
    ]) {
      if (typeof dependency !== 'function') throw new TypeError('overlay startup dependencies are invalid')
    }
    Object.assign(this, {
      loadRole,
      prepareAttempt,
      showReachableToolbar,
      settleGeometry,
      activateOverlays,
      promptRecovery,
      exitApplication,
      scheduleTimeout,
      cancelTimeout
    })
    this.attempt = 0
    this.timeoutHandle = null
    this.stopped = false
  }

  clearAttemptTimeout () {
    if (this.timeoutHandle === null) return
    try { this.cancelTimeout(this.timeoutHandle) } catch { /* attempt token remains authoritative */ }
    this.timeoutHandle = null
  }

  isCurrent (attempt) {
    return !this.stopped && attempt === this.attempt
  }

  start () {
    if (this.stopped) return false
    const attempt = ++this.attempt
    this.clearAttemptTimeout()
    this.prepareAttempt()
    this.showReachableToolbar()
    this.timeoutHandle = this.scheduleTimeout(() => {
      void this.fail(attempt, 'overlay-startup-timeout')
    }, OVERLAY_STARTUP_TIMEOUT_MS)
    void Promise.all([
      Promise.resolve().then(() => this.loadRole('caption')),
      Promise.resolve().then(() => this.loadRole('toolbar'))
    ]).then(async () => {
      if (!this.isCurrent(attempt)) return
      const settled = await this.settleGeometry()
      if (!this.isCurrent(attempt)) return
      if (settled !== true) {
        await this.fail(attempt, 'overlay-startup-geometry-failed')
        return
      }
      this.clearAttemptTimeout()
      this.activateOverlays()
    }).catch(() => this.fail(attempt, 'overlay-startup-load-failed'))
    return true
  }

  async fail (attempt, code) {
    if (!this.isCurrent(attempt)) return false
    this.attempt += 1
    this.clearAttemptTimeout()
    let action = 'exit'
    try {
      action = await this.promptRecovery(code)
    } catch {
      action = 'exit'
    }
    if (this.stopped) return false
    if (action === 'retry') return this.start()
    this.stopped = true
    this.exitApplication()
    return true
  }

  stop () {
    this.stopped = true
    this.attempt += 1
    this.clearAttemptTimeout()
  }
}

async function promptOverlayStartupRecovery (dialog, owner, code) {
  if (!dialog || typeof dialog.showMessageBox !== 'function') {
    throw new TypeError('overlay startup dialog is invalid')
  }
  const result = await dialog.showMessageBox(owner, {
    type: 'error',
    title: '实时字幕启动失败',
    message: '窗口未能正常载入或完成几何对齐。',
    detail: `诊断代码：${code}`,
    buttons: ['重试', '退出'],
    defaultId: 0,
    cancelId: 1,
    noLink: true
  })
  return result.response === 0 ? 'retry' : 'exit'
}

module.exports = {
  OVERLAY_STARTUP_TIMEOUT_MS,
  OverlayStartupController,
  promptOverlayStartupRecovery
}
