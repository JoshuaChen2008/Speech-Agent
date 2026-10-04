'use strict'
const assert = require('node:assert/strict')
const test = require('node:test')
const c = require('../../src/contracts/caption-lock-shortcut')

test('SEM-F22/J17-SHORTCUT: physical sides, generic default and bounded key choices have distinct labels and activation modes', () => {
  assert.equal(c.shortcutLabel(c.DEFAULT_CAPTION_LOCK_SHORTCUT), 'Ctrl+Alt+L')
  assert.equal(c.shortcutAccelerator(c.DEFAULT_CAPTION_LOCK_SHORTCUT), 'Control+Alt+L')
  assert.equal(c.shortcutLabel(['AltRight']), '右 Alt')
  assert.equal(c.shortcutAccelerator(['AltRight']), null)
  assert.equal(c.shortcutAccelerator(['Control', 'Alt']), null)
  assert.equal(c.shortcutLabel(['KeyK', 'ControlRight', 'ShiftLeft']), '右 Ctrl+左 Shift+K')
  for (const keys of [['F24'], ['KeyA'], ['ControlRight', 'ArrowUp'], ['AltRight', 'KeyK']]) assert.equal(c.isCaptionLockShortcut(keys), true)
  for (const keys of [null, [], Array(1), ['Escape'], ['MetaLeft'], ['F12'], ['Unknown'], ['KeyA', 'KeyB'], ['Alt', 'AltRight'], ['AltLeft', 'Tab'], ['Control', 'Alt', 'Delete'], ['ControlLeft', 'AltRight']]) assert.equal(c.isCaptionLockShortcut(keys), false)
})

test('SEM-F22/SEM-T04/J17-SHORTCUT: AltGr normalization excludes opposite sides and character supersets', () => {
  assert.deepEqual(c.pressedKeysFromVirtualKeys([162, 165]), ['AltRight'])
  assert.equal(c.shortcutMatches(['AltRight'], ['AltLeft']), false)
  assert.equal(c.shortcutMatches(['AltRight'], ['ControlLeft', 'AltRight']), true)
  assert.equal(c.shortcutMatches(['AltRight'], ['ControlLeft', 'AltRight', 'KeyA']), false)
  assert.equal(c.shortcutMatches(c.DEFAULT_CAPTION_LOCK_SHORTCUT, ['ControlLeft', 'AltRight', 'KeyL']), false)
  assert.equal(c.shortcutMatches(c.DEFAULT_CAPTION_LOCK_SHORTCUT, ['ControlRight', 'AltLeft', 'KeyL']), true)
  for (const invalid of [null, [0], [255], ['165'], Array(257).fill(165)]) assert.throws(() => c.pressedKeysFromVirtualKeys(invalid))
})

test('SEM-F22/SEM-T04/J17-SHORTCUT: recording IPC requires one exact boolean field', () => {
  assert.deepEqual(c.assertShortcutRecordingRequest({ recording: true }), { recording: true })
  for (const value of [null, true, {}, { recording: 'true' }, { recording: true, keys: ['AltRight'] }]) assert.throws(() => c.assertShortcutRecordingRequest(value))
})
