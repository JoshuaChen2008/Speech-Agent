'use strict'

const CHANNELS = require('./channels')

const ROLES = Object.freeze(['caption', 'toolbar', 'settings', 'history'])
const ROLE_ACCESS = Object.freeze({
  [CHANNELS.MOUSE_THROUGH]: Object.freeze(['caption', 'toolbar']),
  [CHANNELS.DRAG_START]: Object.freeze(['caption', 'toolbar', 'settings', 'history']),
  [CHANNELS.DRAG_END]: Object.freeze(['caption', 'toolbar', 'settings', 'history']),
  [CHANNELS.RESIZE_START]: Object.freeze(['caption']),
  [CHANNELS.RESIZE_END]: Object.freeze(['caption']),
  [CHANNELS.LOCK_TOGGLE]: Object.freeze(['toolbar']),
  [CHANNELS.LOCK_GET]: Object.freeze(['caption', 'toolbar']),
  [CHANNELS.TOOLBAR_ACTION]: Object.freeze(['toolbar']),
  [CHANNELS.SETTINGS_CLOSE]: Object.freeze(['settings']),
  [CHANNELS.HISTORY_CLOSE]: Object.freeze(['history']),
  [CHANNELS.HISTORY_LIST]: Object.freeze(['history']),
  [CHANNELS.HISTORY_GET]: Object.freeze(['history']),
  [CHANNELS.HISTORY_EXPORT]: Object.freeze(['history']),
  [CHANNELS.CONFIG_GET]: Object.freeze(['caption', 'toolbar', 'settings', 'history']),
  [CHANNELS.CONFIG_UPDATE]: Object.freeze(['settings']),
  [CHANNELS.PRESET_SELECT]: Object.freeze(['settings']),
  [CHANNELS.MODEL_STATUS_GET]: Object.freeze(['settings']),
  [CHANNELS.MODEL_INSTALL]: Object.freeze(['settings']),
  [CHANNELS.RUNTIME_GET]: Object.freeze(['toolbar', 'settings']),
  [CHANNELS.RUNTIME_COMMAND]: Object.freeze(['toolbar']),
  [CHANNELS.CAPTION_STATE_GET]: Object.freeze(['caption'])
})

const RENDERER_CONFIG_KEYS = Object.freeze([
  'fontSize',
  'opacity',
  'toolbarOpacity',
  'barColor',
  'radius',
  'theme',
  'bilingual',
  'maxLines',
  'latency'
])
const CAPTURE_CONFIG_KEYS = Object.freeze(['mic', 'loopback'])

function isRoleAllowed (channel, role) {
  return ROLES.includes(role) && !!ROLE_ACCESS[channel] && ROLE_ACCESS[channel].includes(role)
}

function assertRendererConfigPatch (patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new TypeError('config patch must be an object')
  }
  for (const key of Object.keys(patch)) {
    if (!RENDERER_CONFIG_KEYS.includes(key)) {
      throw new TypeError(`config patch key is not renderer-writable: ${key}`)
    }
  }
  return patch
}

function changesCaptureConfiguration (patch) {
  return Object.keys(patch).some((key) => CAPTURE_CONFIG_KEYS.includes(key))
}

module.exports = {
  CAPTURE_CONFIG_KEYS,
  RENDERER_CONFIG_KEYS,
  ROLE_ACCESS,
  ROLES,
  assertRendererConfigPatch,
  changesCaptureConfiguration,
  isRoleAllowed
}
