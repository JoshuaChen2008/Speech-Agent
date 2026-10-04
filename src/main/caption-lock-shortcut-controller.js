'use strict'

const {
  assertCaptionLockShortcut, modifierGroup, pressedKeysFromVirtualKeys,
  shortcutAccelerator, shortcutMatches
} = require('../contracts/caption-lock-shortcut')

class CaptionLockShortcutError extends Error {
  constructor (code) { super(code); this.code = code }
}

// OS registration and key-state sampling are the only external seams. All
// configuration, repeat suppression and clean modifier release live here.
class CaptionLockShortcutController {
  constructor ({ globalShortcut, readVirtualKeys, onToggle, onStatusChanged = () => {}, setInterval: schedule = setInterval, clearInterval: cancel = clearInterval }) {
    this.globalShortcut = globalShortcut
    this.readVirtualKeys = readVirtualKeys
    this.onToggle = onToggle
    this.onStatusChanged = onStatusChanged
    this.schedule = schedule
    this.cancel = cancel
    this.binding = null
    this.recording = false
    this.timer = null
    this.status = 'disabled'
    this.waitingForRelease = false
    this.latched = false
    this.modifierCandidate = false
    this.contaminated = false
    this.altGrEpisode = false
  }

  initialize (config) {
    try { this.commit(this.prepare(config)) } catch { this.setStatus('unavailable') }
  }

  prepare (config) {
    assertCaptionLockShortcut(config.captionLockShortcut)
    if (typeof config.captionLockShortcutEnabled !== 'boolean') throw new TypeError('caption lock shortcut enabled is invalid')
    if (!config.captionLockShortcutEnabled) return null
    const keys = [...config.captionLockShortcut]
    const accelerator = shortcutAccelerator(keys)
    try { this.readPressedKeys() } catch { throw new CaptionLockShortcutError('CAPTION_SHORTCUT_UNAVAILABLE') }
    if (this.binding && accelerator && accelerator === this.binding.accelerator) return this.binding
    const binding = { keys, accelerator }
    if (accelerator) {
      let registered = false
      try {
        // Electron rejects new registrations while suspended. Callbacks stay
        // guarded by recording/binding identity during this synchronous probe.
        if (this.recording) this.globalShortcut.setSuspended(false)
        registered = this.globalShortcut.register(accelerator, () => this.activate(binding)) === true
      } catch {} finally { if (this.recording) this.globalShortcut.setSuspended(true) }
      if (!registered) throw new CaptionLockShortcutError('CAPTION_SHORTCUT_CONFLICT')
    }
    return binding
  }

  update (config, persist) {
    const prepared = this.prepare(config)
    try { persist() } catch (error) {
      if (prepared !== this.binding) this.release(prepared)
      throw error
    }
    this.commit(prepared)
  }

  commit (binding) {
    if (binding !== this.binding) this.release(this.binding)
    this.stopPolling()
    this.binding = binding
    this.resetEpisode()
    // A saved or restored shortcut never consumes the key used to save it.
    this.waitingForRelease = binding !== null
    this.setStatus(!binding ? 'disabled' : this.recording ? 'recording' : 'active')
    if (binding && !this.recording) this.startPolling()
  }

  setRecording (recording) {
    if (typeof recording !== 'boolean') throw new TypeError('recording must be a boolean')
    if (recording === this.recording) return
    try { this.globalShortcut.setSuspended(recording) } catch {
      this.failObservation(); throw new CaptionLockShortcutError('CAPTION_SHORTCUT_UNAVAILABLE')
    }
    this.recording = recording
    this.stopPolling()
    this.resetEpisode()
    this.waitingForRelease = this.binding !== null
    this.setStatus(!this.binding ? (this.status === 'unavailable' ? 'unavailable' : 'disabled') : recording ? 'recording' : 'active')
    if (this.binding && !recording) this.startPolling()
  }

  readPressedKeys () {
    return pressedKeysFromVirtualKeys(this.readVirtualKeys())
  }

  activate (binding) {
    if (this.binding !== binding || this.recording || this.waitingForRelease || this.latched) return
    try {
      // The OS event proves the chord even if the user released it while the
      // callback was queued. Current state only excludes observable AltGr.
      const pressed = this.readPressedKeys()
      if (binding.keys.includes('Control') && binding.keys.includes('Alt') &&
          pressed.includes('AltRight') && !pressed.includes('ControlRight')) return
      this.latched = true
      this.onToggle()
      this.startPolling()
    } catch { this.failObservation() }
  }

  poll () {
    if (!this.binding || this.recording) return
    let pressed
    try { pressed = this.readPressedKeys() } catch { this.failObservation(); return }
    if (this.waitingForRelease) {
      if (pressed.length === 0) {
        this.waitingForRelease = false
        if (this.binding.accelerator) this.stopPolling()
      }
      return
    }
    if (this.binding.accelerator) {
      const primary = this.binding.keys.find(key => !modifierGroup(key))
      if (!pressed.includes(primary)) { this.latched = false; this.stopPolling() }
      return
    }
    const keys = this.binding.keys
    if (keys.includes('AltRight') && pressed.includes('AltRight')) this.altGrEpisode = true
    if (this.altGrEpisode) pressed = pressed.filter(key => key !== 'ControlLeft')
    if (keys.every(key => modifierGroup(key))) {
      if (pressed.length === 0) {
        const toggle = this.modifierCandidate && !this.contaminated
        this.resetEpisode()
        if (toggle) this.onToggle()
      } else {
        const fits = pressed.every(key => keys.some(wanted => wanted === key || modifierGroup(wanted) === wanted && modifierGroup(key) === wanted))
        if (!fits) this.contaminated = true
        if (shortcutMatches(keys, pressed)) this.modifierCandidate = true
      }
    } else {
      const primary = keys.find(key => !modifierGroup(key))
      if (!pressed.includes(primary)) this.latched = false
      else if (!this.latched) { this.latched = true; if (shortcutMatches(keys, pressed)) this.onToggle() }
    }
  }

  resetEpisode () { this.latched = false; this.modifierCandidate = false; this.contaminated = false; this.altGrEpisode = false }
  startPolling () {
    if (this.timer !== null) return
    this.timer = this.schedule(() => this.poll(), 16)
    this.timer?.unref?.()
  }
  stopPolling () { if (this.timer !== null) this.cancel(this.timer); this.timer = null }
  release (binding) { if (binding?.accelerator) this.globalShortcut.unregister(binding.accelerator) }
  setStatus (status) { if (this.status === status) return; this.status = status; this.onStatusChanged(status) }
  failObservation () { this.stopPolling(); this.release(this.binding); this.binding = null; this.resetEpisode(); this.setStatus('unavailable') }
  dispose () {
    this.stopPolling(); this.release(this.binding); this.binding = null; this.resetEpisode()
    if (this.recording) { try { this.globalShortcut.setSuspended(false) } catch {} }
    this.recording = false; this.setStatus('disabled')
  }
}

module.exports = { CaptionLockShortcutController, CaptionLockShortcutError }
