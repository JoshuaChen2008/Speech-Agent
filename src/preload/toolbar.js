'use strict'

const { contextBridge } = require('electron')
const CHANNELS = require('../main/ipc/channels')
const { ipcRenderer, subscribe } = require('./shared')

contextBridge.exposeInMainWorld('shell', {
  mouseThrough: (ignore) => ipcRenderer.send(CHANNELS.MOUSE_THROUGH, !!ignore),
  dragStart: () => ipcRenderer.send(CHANNELS.DRAG_START),
  dragEnd: () => ipcRenderer.send(CHANNELS.DRAG_END),
  lockToggle: () => ipcRenderer.send(CHANNELS.LOCK_TOGGLE),
  getLock: () => ipcRenderer.invoke(CHANNELS.LOCK_GET),
  onLock: (callback) => subscribe(CHANNELS.LOCK_CHANGED, callback),
  action: (name) => ipcRenderer.send(CHANNELS.TOOLBAR_ACTION, String(name || '')),
  getConfig: () => ipcRenderer.invoke(CHANNELS.CONFIG_GET),
  onConfig: (callback) => subscribe(CHANNELS.CONFIG_CHANGED, callback),
  getSnapshot: () => ipcRenderer.invoke(CHANNELS.RUNTIME_GET),
  onSnapshot: (callback) => subscribe(CHANNELS.RUNTIME_CHANGED, callback),
  getRefinementNotice: () => ipcRenderer.invoke(CHANNELS.REFINEMENT_NOTICE_GET),
  onRefinementNotice: (callback) => subscribe(CHANNELS.REFINEMENT_NOTICE_CHANGED, callback),
  command: (name) => ipcRenderer.invoke(CHANNELS.RUNTIME_COMMAND, String(name || ''))
})
