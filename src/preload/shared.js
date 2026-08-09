'use strict'

const { ipcRenderer } = require('electron')
const CHANNELS = require('../main/ipc/channels')
const {
  INTERACTION_ROLES,
  INTERACTION_SCHEMA_VERSION,
  isInteractionSync
} = require('../contracts/window-interaction')

function subscribe (channel, callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  const handler = (_event, value) => callback(value)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

function createWindowInteractionBridge (role) {
  if (!INTERACTION_ROLES.includes(role)) throw new TypeError('window interaction role is invalid')
  let generation = 0
  let currentSync = null
  const callbacks = new Set()

  ipcRenderer.on(CHANNELS.WINDOW_INTERACTION_SYNC, (_event, value) => {
    if (!isInteractionSync(value, role) || value.generation < generation) return
    generation = value.generation
    currentSync = value
    for (const callback of [...callbacks]) callback(value)
  })
  ipcRenderer.send(CHANNELS.WINDOW_INTERACTION_READY, {
    schemaVersion: INTERACTION_SCHEMA_VERSION
  })

  function onInteractionSync (callback) {
    if (typeof callback !== 'function') throw new TypeError('callback must be a function')
    callbacks.add(callback)
    if (currentSync) callback(currentSync)
    return () => callbacks.delete(callback)
  }

  function send (channel, fields = {}) {
    if (generation <= 0) return false
    ipcRenderer.send(channel, {
      schemaVersion: INTERACTION_SCHEMA_VERSION,
      generation,
      ...fields
    })
    return true
  }

  return Object.freeze({
    dragEnd: () => send(CHANNELS.DRAG_END),
    dragStart: () => send(CHANNELS.DRAG_START),
    mouseThrough: (ignore) => send(CHANNELS.MOUSE_THROUGH, { ignore: !!ignore }),
    onInteractionSync,
    resizeEnd: () => send(CHANNELS.RESIZE_END),
    resizeStart: (edge) => send(CHANNELS.RESIZE_START, { edge: String(edge || '') })
  })
}

module.exports = { createWindowInteractionBridge, ipcRenderer, subscribe }
