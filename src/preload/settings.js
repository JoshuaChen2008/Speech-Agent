'use strict'

const { contextBridge } = require('electron')
const CHANNELS = require('../main/ipc/channels')
const { ipcRenderer, subscribe } = require('./shared')

contextBridge.exposeInMainWorld('shell', {
  dragStart: () => ipcRenderer.send(CHANNELS.DRAG_START),
  dragEnd: () => ipcRenderer.send(CHANNELS.DRAG_END),
  closeSettings: () => ipcRenderer.send(CHANNELS.SETTINGS_CLOSE),
  getConfig: () => ipcRenderer.invoke(CHANNELS.CONFIG_GET),
  setConfig: (patch) => ipcRenderer.invoke(CHANNELS.CONFIG_UPDATE, patch),
  onConfig: (callback) => subscribe(CHANNELS.CONFIG_CHANGED, callback),
  selectPreset: (preset) => ipcRenderer.invoke(CHANNELS.PRESET_SELECT, String(preset || '')),
  getSnapshot: () => ipcRenderer.invoke(CHANNELS.RUNTIME_GET),
  onSnapshot: (callback) => subscribe(CHANNELS.RUNTIME_CHANGED, callback)
})
