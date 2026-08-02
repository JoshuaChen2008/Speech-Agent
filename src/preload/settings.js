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
  getModelStatus: () => ipcRenderer.invoke(CHANNELS.MODEL_STATUS_GET),
  installModelResources: () => ipcRenderer.invoke(CHANNELS.MODEL_INSTALL),
  installRefinementModel: () => ipcRenderer.invoke(CHANNELS.MODEL_INSTALL_REFINEMENT),
  cancelModelInstall: () => ipcRenderer.invoke(CHANNELS.MODEL_CANCEL_INSTALL),
  setRefinementPreference: (enabled) => ipcRenderer.invoke(CHANNELS.REFINEMENT_PREFERENCE_SET, enabled === true),
  onModelStatus: (callback) => subscribe(CHANNELS.MODEL_STATUS_CHANGED, callback),
  onNavigate: (callback) => subscribe(CHANNELS.SETTINGS_NAVIGATE, callback),
  getSnapshot: () => ipcRenderer.invoke(CHANNELS.RUNTIME_GET),
  onSnapshot: (callback) => subscribe(CHANNELS.RUNTIME_CHANGED, callback)
})
