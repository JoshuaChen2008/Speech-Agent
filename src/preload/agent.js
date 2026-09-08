'use strict'
const { contextBridge } = require('electron')
const CHANNELS = require('../main/ipc/channels')
const { ipcRenderer, createWindowInteractionBridge } = require('./shared')
const c = require('../agent/contracts/agent-run-ui')
const interaction = createWindowInteractionBridge('agent')

function onChanged (callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  const handler = (_event, value) => { try { callback(c.assertChangedEvent(value)) } catch {} }
  ipcRenderer.on(CHANNELS.AGENT_RUN_CHANGED, handler)
  return () => ipcRenderer.removeListener(CHANNELS.AGENT_RUN_CHANGED, handler)
}
function invoke (channel, validator, responseValidator, value) {
  validator(value)
  return ipcRenderer.invoke(channel, value).then((response) => responseValidator(response))
}
contextBridge.exposeInMainWorld('agentApi', {
  dragStart: interaction.dragStart,
  dragEnd: interaction.dragEnd,
  onInteractionSync: interaction.onInteractionSync,
  close: () => ipcRenderer.send(CHANNELS.AGENT_CLOSE),
  subscribeChanged: onChanged,
  subscribeAndGetEligibility: (request, callback) => {
    const unsubscribe = onChanged(callback)
    return { unsubscribe, snapshot: invoke(CHANNELS.AGENT_RUN_GET_ELIGIBILITY, c.assertGetEligibilityRequest, c.assertGetEligibilityResponse, request) }
  },
  getScopes: (request) => invoke(CHANNELS.AGENT_RUN_GET_SCOPES, c.assertGetScopesRequest, c.assertGetScopesResponse, request),
  getEligibility: (request) => invoke(CHANNELS.AGENT_RUN_GET_ELIGIBILITY, c.assertGetEligibilityRequest, c.assertGetEligibilityResponse, request),
  submit: (request) => invoke(CHANNELS.AGENT_RUN_SUBMIT, c.assertSubmitRequest, c.assertSubmitResponse, request),
  cancel: (request) => invoke(CHANNELS.AGENT_RUN_CANCEL, c.assertCancelRequest, c.assertCancelResponse, request),
  getHistory: (request) => invoke(CHANNELS.AGENT_RUN_GET_HISTORY, c.assertHistoryRequest, c.assertHistoryResponse, request),
  getInteraction: (request) => invoke(CHANNELS.AGENT_RUN_GET_INTERACTION, c.assertInteractionRequest, c.assertInteractionResponse, request),
  exportInteraction: (request) => invoke(CHANNELS.AGENT_RUN_EXPORT_INTERACTION, c.assertExportRequest, c.assertExportResponse, request)
})
