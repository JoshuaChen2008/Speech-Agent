'use strict'

module.exports = Object.freeze({
  MOUSE_THROUGH: 'window:mouse-through',
  DRAG_START: 'window:drag-start',
  DRAG_END: 'window:drag-end',
  RESIZE_START: 'window:resize-start',
  RESIZE_END: 'window:resize-end',
  LOCK_TOGGLE: 'window:lock-toggle',
  LOCK_GET: 'window:lock-get',
  LOCK_CHANGED: 'window:lock-changed',
  TOOLBAR_ACTION: 'toolbar:action',
  SETTINGS_CLOSE: 'settings:close',
  CONFIG_GET: 'config:get',
  CONFIG_UPDATE: 'config:update',
  CONFIG_CHANGED: 'config:changed',
  PRESET_SELECT: 'onboarding:select-preset',
  RUNTIME_GET: 'runtime:get-snapshot',
  RUNTIME_COMMAND: 'runtime:command',
  RUNTIME_CHANGED: 'runtime:snapshot',
  CAPTION_EVENT: 'runtime:caption'
})
