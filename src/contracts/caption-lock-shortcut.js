'use strict'

// Physical KeyboardEvent.code names; generic modifiers are retained for the
// existing Ctrl+Alt+L default. No key event history is part of this contract.
const DEFAULT_CAPTION_LOCK_SHORTCUT = Object.freeze(['Control', 'Alt', 'KeyL'])
const MODIFIERS = Object.freeze(['Control', 'ControlLeft', 'ControlRight', 'Alt', 'AltLeft', 'AltRight', 'Shift', 'ShiftLeft', 'ShiftRight'])
const KEY_VK = Object.freeze({
  Backspace: 8, Tab: 9, Enter: 13, ShiftLeft: 160, ShiftRight: 161,
  ControlLeft: 162, ControlRight: 163, AltLeft: 164, AltRight: 165,
  Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Insert: 45, Delete: 46,
  ...Object.fromEntries(Array.from({ length: 26 }, (_, i) => [`Key${String.fromCharCode(65 + i)}`, 65 + i])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`Digit${i}`, 48 + i])),
  ...Object.fromEntries(Array.from({ length: 24 }, (_, i) => [`F${i + 1}`, 112 + i]))
})
const VK_KEY = Object.freeze(Object.fromEntries(Object.entries(KEY_VK).map(([key, vk]) => [vk, key])))
const LABELS = Object.freeze({
  Control: 'Ctrl', ControlLeft: '左 Ctrl', ControlRight: '右 Ctrl',
  Alt: 'Alt', AltLeft: '左 Alt', AltRight: '右 Alt',
  Shift: 'Shift', ShiftLeft: '左 Shift', ShiftRight: '右 Shift',
  Space: '空格', Enter: 'Enter', Tab: 'Tab', Backspace: '退格', Delete: 'Delete',
  ArrowLeft: '←', ArrowUp: '↑', ArrowRight: '→', ArrowDown: '↓'
})
function modifierGroup (key) { return MODIFIERS.find((item) => item === key)?.replace(/Left|Right/g, '') || null }
function canonicalShortcut (keys) {
  return [...keys].sort((a, b) => {
    const order = key => ({ Control: 0, Alt: 1, Shift: 2 })[modifierGroup(key)] ?? 3
    return order(a) - order(b) || a.localeCompare(b)
  })
}
function assertCaptionLockShortcut (keys) {
  if (!Array.isArray(keys) || keys.length < 1 || keys.length > 4 || new Set(keys).size !== keys.length ||
      Array.from(keys).some(key => typeof key !== 'string' || (!MODIFIERS.includes(key) && !Object.hasOwn(KEY_VK, key)))) {
    throw new TypeError('caption lock shortcut keys are invalid')
  }
  const groups = keys.map(modifierGroup).filter(Boolean)
  if (new Set(groups).size !== groups.length || keys.filter(key => !modifierGroup(key)).length > 1) {
    throw new TypeError('caption lock shortcut requires distinct modifiers and at most one regular key')
  }
  if (keys.includes('F12') || (groups.includes('Control') && groups.includes('Alt') && keys.includes('Delete')) ||
      (groups.includes('Alt') && (keys.includes('Tab') || keys.includes('F4'))) ||
      (keys.includes('ControlLeft') && keys.includes('AltRight'))) {
    throw new TypeError('caption lock shortcut is reserved or ambiguous with AltGr')
  }
  return keys
}
function isCaptionLockShortcut (keys) { try { assertCaptionLockShortcut(keys); return true } catch { return false } }
function shortcutLabel (keys) {
  if (!isCaptionLockShortcut(keys)) return ''
  return canonicalShortcut(keys).map(key => LABELS[key] || key.replace(/^Key|^Digit/, '')).join('+')
}
function shortcutAccelerator (keys) {
  assertCaptionLockShortcut(keys)
  if (keys.some(key => /Left|Right$/.test(key) && modifierGroup(key)) || keys.every(key => modifierGroup(key))) return null
  return canonicalShortcut(keys).map(key => ({ Control: 'Control', Space: 'Space', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down' })[key] || key.replace(/^Key|^Digit/, '')).join('+')
}
function normalizePressedKeys (keys) {
  const result = [...new Set(keys)]
  // AltGr's synthetic left Ctrl must not turn right Alt into a Ctrl+Alt chord.
  return result.includes('AltRight') ? result.filter(key => key !== 'ControlLeft' && key !== 'Control') : result
}
function pressedKeysFromVirtualKeys (values) {
  if (!Array.isArray(values) || values.length > 256 || Array.from(values).some(vk => !Number.isInteger(vk) || vk < 1 || vk > 254)) {
    throw new TypeError('caption lock shortcut native state is invalid')
  }
  return normalizePressedKeys(values.map(vk => VK_KEY[vk] || `Unsupported${vk}`))
}
function shortcutMatches (keys, pressed) {
  const normalized = normalizePressedKeys(pressed)
  const match = (key, down) => key === down || (['Control', 'Alt', 'Shift'].includes(key) && modifierGroup(down) === key)
  return keys.every(key => normalized.some(down => match(key, down))) && normalized.every(down => keys.some(key => match(key, down)))
}
function assertShortcutRecordingRequest (request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) ||
      Reflect.ownKeys(request).length !== 1 || !Object.hasOwn(request, 'recording') || typeof request.recording !== 'boolean') {
    throw new TypeError('caption lock shortcut recording request is invalid')
  }
  return request
}

module.exports = {
  DEFAULT_CAPTION_LOCK_SHORTCUT, MODIFIERS, KEY_VK, modifierGroup, canonicalShortcut,
  assertCaptionLockShortcut, isCaptionLockShortcut, shortcutLabel, shortcutAccelerator,
  normalizePressedKeys, pressedKeysFromVirtualKeys, shortcutMatches, assertShortcutRecordingRequest
}
