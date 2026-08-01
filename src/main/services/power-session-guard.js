'use strict'

// @ts-check

/*
 * Electron powerMonitor -> active subtitle session boundary.
 *
 * A suspended Windows machine cannot promise that an audio track, AudioContext
 * or utility-process MessagePort remains usable after resume.  Treating that
 * state as still-listening risks silently losing captions.  The guard therefore
 * reports a recoverable system fault on suspend and deliberately does not
 * auto-restart on resume: the normal Retry control reacquires the selected
 * source after Windows has restored the device graph.
 *
 * This module intentionally contains no Electron import, so the event wiring
 * and its idempotency can be tested without opening a window, touching a media
 * device, or putting the machine to sleep.
 */

const SYSTEM_SUSPEND_FAULT = Object.freeze({
  scope: 'system',
  code: 'SYSTEM_SUSPEND',
  message: '系统休眠，音频会话已中断',
  recoverable: true
})

function assertPowerMonitor (value) {
  if (!value || typeof value.on !== 'function' || typeof value.removeListener !== 'function') {
    throw new TypeError('powerMonitor must provide on and removeListener')
  }
  return value
}

class PowerSessionGuard {
  constructor (options = {}) {
    this.powerMonitor = assertPowerMonitor(options.powerMonitor)
    if (typeof options.getCoordinator !== 'function') {
      throw new TypeError('getCoordinator must be a function')
    }
    this.getCoordinator = options.getCoordinator
    this.onError = typeof options.onError === 'function' ? options.onError : () => {}
    this.started = false
    this.suspended = false
    this.onSuspend = () => this.handleSuspend()
    this.onResume = () => this.handleResume()
  }

  start () {
    if (this.started) return false
    this.powerMonitor.on('suspend', this.onSuspend)
    this.powerMonitor.on('resume', this.onResume)
    this.started = true
    return true
  }

  stop () {
    if (!this.started) return false
    this.powerMonitor.removeListener('suspend', this.onSuspend)
    this.powerMonitor.removeListener('resume', this.onResume)
    this.started = false
    this.suspended = false
    return true
  }

  handleSuspend () {
    /* Windows may send repeated suspend notifications.  A single active
       session must receive at most one recoverable fault for each sleep cycle. */
    if (this.suspended) return false
    this.suspended = true
    try {
      const coordinator = this.getCoordinator()
      if (!coordinator || typeof coordinator.reportSystemSuspend !== 'function') return false
      return coordinator.reportSystemSuspend() === true
    } catch (error) {
      try { this.onError(error) } catch { /* observer isolation */ }
      return false
    }
  }

  handleResume () {
    if (!this.suspended) return false
    this.suspended = false
    /* Do not call retry/start here.  Reacquiring an input after an OS sleep is
       an externally visible microphone/loopback action and must remain an
       explicit product command after the user can inspect the restored device. */
    return true
  }
}

module.exports = {
  PowerSessionGuard,
  SYSTEM_SUSPEND_FAULT,
  assertPowerMonitor
}
