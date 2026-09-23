'use strict'

const CHANNELS = require('./channels')

const ROLES = Object.freeze(['caption', 'toolbar', 'settings', 'history', 'agent'])
const ROLE_ACCESS = Object.freeze({
  [CHANNELS.RECOGNITION_GET]: Object.freeze(['settings']),
  [CHANNELS.RECOGNITION_UPDATE]: Object.freeze(['settings']),
  [CHANNELS.RECOGNITION_VERIFY]: Object.freeze(['settings']),
  [CHANNELS.MOUSE_THROUGH]: Object.freeze(['caption', 'toolbar']),
  [CHANNELS.DRAG_START]: Object.freeze(['caption', 'toolbar', 'settings', 'history', 'agent']),
  [CHANNELS.DRAG_END]: Object.freeze(['caption', 'toolbar', 'settings', 'history', 'agent']),
  [CHANNELS.RESIZE_START]: Object.freeze(['caption']),
  [CHANNELS.RESIZE_END]: Object.freeze(['caption']),
  [CHANNELS.WINDOW_INTERACTION_READY]: Object.freeze(['caption', 'toolbar', 'settings', 'history', 'agent']),
  [CHANNELS.LOCK_TOGGLE]: Object.freeze(['toolbar']),
  [CHANNELS.LOCK_GET]: Object.freeze(['caption', 'toolbar']),
  [CHANNELS.TOOLBAR_LAYOUT_GET_CONTEXT]: Object.freeze(['toolbar']),
  [CHANNELS.TOOLBAR_LAYOUT_REPORT_RECT]: Object.freeze(['toolbar']),
  [CHANNELS.TOOLBAR_ACTION]: Object.freeze(['toolbar']),
  [CHANNELS.AGENT_OPEN]: Object.freeze(['toolbar']),
  [CHANNELS.AGENT_OPEN_STATUS]: Object.freeze(['toolbar']),
  [CHANNELS.AGENT_OPEN_SETTINGS]: Object.freeze(['agent']),
  [CHANNELS.SETTINGS_CLOSE]: Object.freeze(['settings']),
  [CHANNELS.HISTORY_CLOSE]: Object.freeze(['history']),
  [CHANNELS.AGENT_CLOSE]: Object.freeze(['agent']),
  [CHANNELS.AGENT_SCOPE_REQUESTED]: Object.freeze(['agent']),
  [CHANNELS.HISTORY_LIST]: Object.freeze(['history']),
  [CHANNELS.HISTORY_PAGE]: Object.freeze(['history']),
  [CHANNELS.HISTORY_EXPORT]: Object.freeze(['history']),
  [CHANNELS.HISTORY_SUMMARY]: Object.freeze(['history']),
  [CHANNELS.CONFIG_GET]: Object.freeze(['caption', 'toolbar', 'settings', 'history', 'agent']),
  [CHANNELS.CONFIG_UPDATE]: Object.freeze(['settings']),
  [CHANNELS.PRESET_SELECT]: Object.freeze(['settings']),
  [CHANNELS.MODEL_STATUS_GET]: Object.freeze(['settings']),
  [CHANNELS.MODEL_INSTALL]: Object.freeze(['settings']),
  [CHANNELS.MODEL_INSTALL_REFINEMENT]: Object.freeze(['settings']),
  [CHANNELS.MODEL_CANCEL_INSTALL]: Object.freeze(['settings']),
  [CHANNELS.REFINEMENT_PREFERENCE_SET]: Object.freeze(['settings']),
  [CHANNELS.RUNTIME_GET]: Object.freeze(['toolbar', 'settings']),
  [CHANNELS.RUNTIME_COMMAND]: Object.freeze(['toolbar']),
  [CHANNELS.CAPTION_STATE_GET]: Object.freeze(['caption']),
  [CHANNELS.CAPTION_VIEWPORT_EVICT]: Object.freeze(['caption']),
  [CHANNELS.REFINEMENT_NOTICE_GET]: Object.freeze(['toolbar']),
  [CHANNELS.AGENT_CONTEXT_GET_OVERVIEW]: Object.freeze(['settings', 'history', 'agent']),
  [CHANNELS.AGENT_CONTEXT_MANAGE]: Object.freeze(['settings', 'history', 'agent']),
  [CHANNELS.AGENT_SETTINGS_UPDATE]: Object.freeze(['settings']),
  [CHANNELS.SESSION_SUMMARY_SETTINGS_UPDATE]: Object.freeze(['settings']),
  [CHANNELS.AGENT_MODEL_GET_CATALOG]: Object.freeze(['settings']),
  [CHANNELS.AGENT_MODEL_GET_PRESETS]: Object.freeze(['settings']),
  [CHANNELS.AGENT_MODEL_CONFIGURE]: Object.freeze(['settings']),
  [CHANNELS.AGENT_MODEL_PULL_REMOTE_CATALOG]: Object.freeze(['settings']),
  [CHANNELS.AGENT_MODEL_TEST_SAVED]: Object.freeze(['settings']),
  [CHANNELS.AGENT_MODEL_CANCEL_TEST]: Object.freeze(['settings']),
  [CHANNELS.AGENT_RUN_GET_SCOPES]: Object.freeze(['agent', 'history']),
  [CHANNELS.AGENT_RUN_GET_ELIGIBILITY]: Object.freeze(['agent', 'history']),
  [CHANNELS.AGENT_RUN_SUBMIT]: Object.freeze(['agent']),
  [CHANNELS.AGENT_RUN_CANCEL]: Object.freeze(['agent']),
  [CHANNELS.AGENT_RUN_GET_HISTORY]: Object.freeze(['agent', 'history']),
  [CHANNELS.AGENT_RUN_GET_INTERACTION]: Object.freeze(['agent', 'history']),
  [CHANNELS.AGENT_RUN_CHANGED]: Object.freeze(['agent', 'history']),
  [CHANNELS.AGENT_RUN_EXPORT_INTERACTION]: Object.freeze(['agent', 'history']),
  [CHANNELS.AGENT_RUN_RECORD_SIGNAL]: Object.freeze(['agent'])
})

const RENDERER_CONFIG_KEYS = Object.freeze([
  'fontSize',
  'opacity',
  'toolbarOpacity',
  'barColor',
  'captionTextColor',
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
