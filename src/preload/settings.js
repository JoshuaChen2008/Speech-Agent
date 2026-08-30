'use strict'

const { contextBridge } = require('electron')
const CHANNELS = require('../main/ipc/channels')
const { createWindowInteractionBridge, ipcRenderer, subscribe } = require('./shared')
const interaction = createWindowInteractionBridge('settings')
const {
  assertChangedEvent,
  assertGetOverviewRequest,
  assertGetOverviewResponse,
  assertManageRequest,
  assertManageResponse
} = require('../agent/contracts/agent-context-ui')

function onAgentContextChanged (callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  const handler = (_event, value) => {
    try { callback(assertChangedEvent(value)) } catch { /* invalid events are dropped whole */ }
  }
  ipcRenderer.on(CHANNELS.AGENT_CONTEXT_CHANGED, handler)
  return () => ipcRenderer.removeListener(CHANNELS.AGENT_CONTEXT_CHANGED, handler)
}

contextBridge.exposeInMainWorld('shell', {
  dragStart: interaction.dragStart,
  dragEnd: interaction.dragEnd,
  onInteractionSync: interaction.onInteractionSync,
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
  onSnapshot: (callback) => subscribe(CHANNELS.RUNTIME_CHANGED, callback),
  getAgentContextOverview: (request) => {
    assertGetOverviewRequest(request)
    return ipcRenderer.invoke(CHANNELS.AGENT_CONTEXT_GET_OVERVIEW, request).then((response) => assertGetOverviewResponse(response))
  },
  manageAgentContext: (request) => {
    assertManageRequest(request)
    return ipcRenderer.invoke(CHANNELS.AGENT_CONTEXT_MANAGE, request).then((response) => assertManageResponse(response))
  },
  onAgentContextChanged
})
