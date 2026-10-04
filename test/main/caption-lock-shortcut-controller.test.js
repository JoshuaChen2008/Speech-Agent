'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const { CaptionLockShortcutController } = require('../../src/main/caption-lock-shortcut-controller')
const { DEFAULT_CONFIG } = require('../../src/main/services/config-store')

function harness (keys = ['AltRight']) {
  const callbacks = new Map(); const timers = new Set(); const denied = new Set()
  let down = []; let fault = false; let suspended = false; let toggles = 0
  const controller = new CaptionLockShortcutController({
    globalShortcut: {
      register (accelerator, callback) { if (suspended || denied.has(accelerator) || callbacks.has(accelerator)) return false; callbacks.set(accelerator, callback); return true },
      unregister: accelerator => callbacks.delete(accelerator), setSuspended: value => { suspended = value }
    },
    readVirtualKeys: () => { if (fault) throw new Error('controlled OS access failure'); return down }, onToggle: () => { toggles += 1 },
    setInterval: callback => { timers.add(callback); return callback }, clearInterval: callback => timers.delete(callback)
  })
  controller.initialize({ ...DEFAULT_CONFIG, captionLockShortcut: keys })
  const sample = values => { down = values; for (const callback of [...timers]) callback() }
  sample([])
  return { controller, callbacks, timers, denied, sample, get count () { return toggles }, get suspended () { return suspended }, fail () { fault = true }, fire (accelerator) { if (!suspended) callbacks.get(accelerator)?.() } }
}

test('SEM-F22/J17-SHORTCUT: right Alt toggles on clean release, with hold, opposite side, AltGr and other-key suppression', () => {
  const h = harness()
  h.sample([165]); h.sample([165]); assert.equal(h.count, 0)
  h.sample([]); assert.equal(h.count, 1)
  h.sample([164]); h.sample([]); assert.equal(h.count, 1)
  h.sample([165]); h.sample([165, 65]); h.sample([165]); h.sample([]); assert.equal(h.count, 1)
  h.sample([162, 165]); h.sample([162]); h.sample([]); assert.equal(h.count, 2)
  h.sample([162, 165, 65]); h.sample([]); assert.equal(h.count, 2)
  h.sample([1, 165]); h.sample([]); assert.equal(h.count, 2)
  h.controller.dispose(); assert.equal(h.timers.size, 0)
})

test('SEM-F22/J17-SHORTCUT: pure modifier and physical key chords deduplicate and reject extra-key episodes', () => {
  const modifiers = harness(['ControlRight', 'AltLeft'])
  modifiers.sample([163]); modifiers.sample([163, 164]); modifiers.sample([164]); modifiers.sample([]); assert.equal(modifiers.count, 1)
  modifiers.sample([163, 164, 65]); modifiers.sample([]); assert.equal(modifiers.count, 1); modifiers.controller.dispose()
  const h = harness(['ControlRight', 'KeyK'])
  h.sample([163, 75]); h.sample([163, 75]); assert.equal(h.count, 1)
  h.sample([163]); h.sample([163, 75]); assert.equal(h.count, 2)
  h.sample([]); h.sample([163, 75, 65]); h.sample([163, 75]); assert.equal(h.count, 2); h.controller.dispose()
})

test('SEM-F22/J17-SHORTCUT: recording suspends OS interception and resumes only after held keys release', () => {
  const h = harness(DEFAULT_CONFIG.captionLockShortcut)
  h.controller.setRecording(true); assert.equal(h.suspended, true)
  h.sample([162, 164, 76]); h.fire('Control+Alt+L'); assert.equal(h.count, 0)
  h.controller.setRecording(false); assert.equal(h.suspended, false)
  h.fire('Control+Alt+L'); assert.equal(h.count, 0)
  h.sample([]); h.sample([162, 164, 76]); h.fire('Control+Alt+L'); h.fire('Control+Alt+L'); assert.equal(h.count, 1)
  h.sample([162, 164]); h.sample([162, 164, 76]); h.fire('Control+Alt+L'); assert.equal(h.count, 2)
  h.controller.dispose()
})

test('SEM-F22/J17-SHORTCUT: a queued OS event still toggles after release and observable AltGr is excluded', () => {
  const h = harness(DEFAULT_CONFIG.captionLockShortcut)
  h.fire('Control+Alt+L'); assert.equal(h.count, 1)
  h.sample([]); h.sample([162, 165, 76]); h.fire('Control+Alt+L'); assert.equal(h.count, 1)
  h.controller.dispose()
})

test('SEM-F22/SEM-T04/J17-SHORTCUT: registration conflict and failed persistence retain the previous live shortcut', () => {
  const h = harness(DEFAULT_CONFIG.captionLockShortcut); let writes = 0
  h.denied.add('F8')
  assert.throws(() => h.controller.update({ ...DEFAULT_CONFIG, captionLockShortcut: ['F8'] }, () => { writes += 1 }), error => error.code === 'CAPTION_SHORTCUT_CONFLICT')
  assert.equal(writes, 0); assert.equal(h.callbacks.has('Control+Alt+L'), true)
  assert.throws(() => h.controller.update({ ...DEFAULT_CONFIG, captionLockShortcut: ['F9'] }, () => { throw new Error('disk denied') }))
  assert.equal(h.callbacks.has('F9'), false); assert.equal(h.callbacks.has('Control+Alt+L'), true)
  h.sample([162, 164, 76]); h.fire('Control+Alt+L'); assert.equal(h.count, 1)
  h.controller.setRecording(true)
  h.controller.update({ ...DEFAULT_CONFIG, captionLockShortcut: ['F10'] }, () => { writes += 1 })
  assert.equal(h.callbacks.has('F10'), true); assert.equal(h.suspended, true)
  h.controller.dispose(); assert.equal(h.suspended, false); assert.equal(h.callbacks.size, 0)
})

test('SEM-F22/SEM-T04/J17-SHORTCUT: disabled bindings release resources and observation failure does not create a release toggle', () => {
  const h = harness(); h.sample([165]); h.fail(); h.sample([])
  assert.equal(h.count, 0); assert.equal(h.controller.status, 'unavailable'); assert.equal(h.timers.size, 0)
  assert.throws(() => h.controller.update({ ...DEFAULT_CONFIG, captionLockShortcut: ['AltRight'] }, () => {}), error => error.code === 'CAPTION_SHORTCUT_UNAVAILABLE')
  h.controller.dispose()
  const disabled = harness(DEFAULT_CONFIG.captionLockShortcut)
  disabled.controller.update({ ...DEFAULT_CONFIG, captionLockShortcutEnabled: false }, () => {})
  assert.equal(disabled.controller.status, 'disabled'); assert.equal(disabled.callbacks.size, 0); assert.equal(disabled.timers.size, 0)
  disabled.sample([162, 164, 76]); disabled.fire('Control+Alt+L'); assert.equal(disabled.count, 0); disabled.controller.dispose()
})
