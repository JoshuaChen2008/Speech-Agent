'use strict'

const { contextBridge } = require('electron')
const CHANNELS = require('../main/ipc/channels')
const { createWindowInteractionBridge, ipcRenderer, subscribe } = require('./shared')
const interaction = createWindowInteractionBridge('settings')
const { assertUpdateRequest: assertRecognitionUpdateRequest, assertResponse: assertRecognitionResponse } = require('../contracts/recognition-settings')
const {
  assertChangedEvent,
  assertGetOverviewRequest,
  assertGetOverviewResponse,
  assertManageRequest,
  assertManageResponse
} = require('../agent/contracts/agent-context-ui')
const {
  assertCatalogResponse: assertModelCatalogResponse,
  assertChangedEvent: assertModelChangedEvent,
  assertConfigureRequest: assertModelConfigureRequest,
  assertConfigureResponse: assertModelConfigureResponse,
  assertGetCatalogRequest: assertModelCatalogRequest,
  assertPullRequest: assertModelPullRequest,
  assertPullResponse: assertModelPullResponse
} = require('../agent/contracts/agent-model-ui')
const {
  CONTRACT_ID: PRESETS_CONTRACT_ID,
  CONTRACT_VERSION: PRESETS_CONTRACT_VERSION,
  assertGetPresetsRequest,
  assertGetPresetsResponse
} = require('../agent/contracts/agent-model-presets-ui')
const {
  CONTRACT_ID: TEST_CONTRACT_ID,
  CONTRACT_VERSION: TEST_CONTRACT_VERSION,
  assertCancelRequest: assertModelTestCancelRequest,
  assertTestRequest: assertModelTestRequest,
  assertTestResponse: assertModelTestResponse
} = require('../agent/contracts/agent-model-test-ui')
const {
  assertUpdateRequest: assertAgentSettingsUpdateRequest,
  assertUpdateResponse: assertAgentSettingsUpdateResponse
} = require('../agent/contracts/agent-settings-ui')
const {
  assertUpdateRequest: assertSummarySettingsUpdateRequest,
  assertUpdateResponse: assertSummarySettingsUpdateResponse
} = require('../agent/contracts/session-summary-settings-ui')

function onAgentContextChanged (callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  const handler = (_event, value) => {
    try { callback(assertChangedEvent(value)) } catch { /* invalid events are dropped whole */ }
  }
  ipcRenderer.on(CHANNELS.AGENT_CONTEXT_CHANGED, handler)
  return () => ipcRenderer.removeListener(CHANNELS.AGENT_CONTEXT_CHANGED, handler)
}

function onAgentModelChanged (callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  const handler = (_event, value) => { try { callback(assertModelChangedEvent(value)) } catch {} }
  ipcRenderer.on(CHANNELS.AGENT_MODEL_CHANGED, handler)
  return () => ipcRenderer.removeListener(CHANNELS.AGENT_MODEL_CHANGED, handler)
}

contextBridge.exposeInMainWorld('shell', {
  getRecognitionSettings: () => ipcRenderer.invoke(CHANNELS.RECOGNITION_GET).then(response => assertRecognitionResponse(response)),
  updateRecognitionSettings: request => {
    assertRecognitionUpdateRequest(request)
    return ipcRenderer.invoke(CHANNELS.RECOGNITION_UPDATE, request).then(response => assertRecognitionResponse(response))
  },
  verifyRecognitionCredentials: () => ipcRenderer.invoke(CHANNELS.RECOGNITION_VERIFY).then(response => assertRecognitionResponse(response, true)),
  dragStart: interaction.dragStart,
  dragEnd: interaction.dragEnd,
  onInteractionSync: interaction.onInteractionSync,
  closeSettings: () => ipcRenderer.send(CHANNELS.SETTINGS_CLOSE),
  getConfig: () => ipcRenderer.invoke(CHANNELS.CONFIG_GET),
  setConfig: (patch) => ipcRenderer.invoke(CHANNELS.CONFIG_UPDATE, patch),
  setAgentSettings: (request) => {
    assertAgentSettingsUpdateRequest(request)
    return ipcRenderer.invoke(CHANNELS.AGENT_SETTINGS_UPDATE, request).then((response) => assertAgentSettingsUpdateResponse(response))
  },
  setSummaryMemoryPreference: (request) => {
    assertSummarySettingsUpdateRequest(request)
    return ipcRenderer.invoke(CHANNELS.SESSION_SUMMARY_SETTINGS_UPDATE, request).then((response) => assertSummarySettingsUpdateResponse(response))
  },
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
  onAgentContextChanged,
  getAgentModelCatalog: (request) => {
    assertModelCatalogRequest(request)
    return ipcRenderer.invoke(CHANNELS.AGENT_MODEL_GET_CATALOG, request).then(assertModelCatalogResponse)
  },
  getAgentModelPresets: () => {
    const request = { contractId: PRESETS_CONTRACT_ID, contractVersion: PRESETS_CONTRACT_VERSION }
    assertGetPresetsRequest(request)
    return ipcRenderer.invoke(CHANNELS.AGENT_MODEL_GET_PRESETS, request).then((response) => assertGetPresetsResponse(response))
  },
  configureAgentModel: (request) => {
    assertModelConfigureRequest(request)
    return ipcRenderer.invoke(CHANNELS.AGENT_MODEL_CONFIGURE, request).then(assertModelConfigureResponse)
  },
  pullAgentModelCatalog: (request) => {
    assertModelPullRequest(request)
    return ipcRenderer.invoke(CHANNELS.AGENT_MODEL_PULL_REMOTE_CATALOG, request).then(assertModelPullResponse)
  },
  testSavedAgentModel: (request) => {
    assertModelTestRequest(request)
    return ipcRenderer.invoke(CHANNELS.AGENT_MODEL_TEST_SAVED, request).then((response) => assertModelTestResponse(response))
  },
  cancelSavedAgentModel: (request) => {
    assertModelTestCancelRequest(request)
    return ipcRenderer.invoke(CHANNELS.AGENT_MODEL_CANCEL_TEST, request).then((response) => assertModelTestResponse(response))
  },
  onAgentModelChanged
})
