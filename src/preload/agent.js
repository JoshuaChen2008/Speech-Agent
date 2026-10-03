'use strict'
const { createContextSourceBridge } = require('./context-source')
const { contextBridge } = require('electron')
const CHANNELS = require('../main/ipc/channels')
const { ipcRenderer, createWindowInteractionBridge, subscribe } = require('./shared')
const contextSource = createContextSourceBridge(ipcRenderer)
const c = require('../agent/contracts/agent-run-ui')
const summaryRun = require('../agent/contracts/session-summary-run-ui')
const summaryDiagnostics = require('../agent/contracts/agent-run-diagnostics-ui')
const context = require('../agent/contracts/agent-context-ui')
const interaction = createWindowInteractionBridge('agent')
let requestedScope = null
const requestedScopeListeners = new Set()

function acceptRequestedScope (value) {
  if (!value || value.kind !== 'session' || typeof value.reference !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,160}$/.test(value.reference)) return
  requestedScope = { kind: 'session', reference: value.reference }
  for (const listener of [...requestedScopeListeners]) {
    try { listener(requestedScope) } catch {}
  }
}

ipcRenderer.on(CHANNELS.AGENT_SCOPE_REQUESTED, (_event, value) => acceptRequestedScope(value))

function onChanged (callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  const handler = (_event, value) => { try { callback(c.assertChangedEvent(value)) } catch {} }
  ipcRenderer.on(CHANNELS.AGENT_RUN_CHANGED, handler)
  return () => ipcRenderer.removeListener(CHANNELS.AGENT_RUN_CHANGED, handler)
}
function onSessionSummaryRunChanged (callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  const handler = (_event, value) => { try { callback(summaryRun.assertChangedEvent(value)) } catch {} }
  ipcRenderer.on(CHANNELS.SESSION_SUMMARY_RUN_CHANGED, handler)
  return () => ipcRenderer.removeListener(CHANNELS.SESSION_SUMMARY_RUN_CHANGED, handler)
}
function onAgentContextChanged (callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  const handler = (_event, value) => {
    try { callback(context.assertChangedEvent(value)) } catch { /* invalid events are dropped whole */ }
  }
  ipcRenderer.on(CHANNELS.AGENT_CONTEXT_CHANGED, handler)
  return () => ipcRenderer.removeListener(CHANNELS.AGENT_CONTEXT_CHANGED, handler)
}
function onRequestedScope (callback) {
  if (typeof callback !== 'function') throw new TypeError('callback must be a function')
  requestedScopeListeners.add(callback)
  if (requestedScope) queueMicrotask(() => {
    if (!requestedScopeListeners.has(callback)) return
    try { callback(requestedScope) } catch {}
  })
  return () => requestedScopeListeners.delete(callback)
}
function invoke (channel, validator, responseValidator, value) {
  validator(value)
  return ipcRenderer.invoke(channel, value).then((response) => responseValidator(response))
}
contextBridge.exposeInMainWorld('agentApi', {
  ...contextSource,
  dragStart: interaction.dragStart,
  dragEnd: interaction.dragEnd,
  onInteractionSync: interaction.onInteractionSync,
  close: () => ipcRenderer.send(CHANNELS.AGENT_CLOSE),
  openSettings: () => ipcRenderer.send(CHANNELS.AGENT_OPEN_SETTINGS),
  getConfig: () => ipcRenderer.invoke(CHANNELS.CONFIG_GET),
  onConfig: (callback) => subscribe(CHANNELS.CONFIG_CHANGED, callback),
  getAgentContextOverview: (request) => {
    context.assertGetOverviewRequest(request)
    return ipcRenderer.invoke(CHANNELS.AGENT_CONTEXT_GET_OVERVIEW, request).then((response) => context.assertGetOverviewResponse(response))
  },
  manageAgentContext: (request) => {
    context.assertManageRequest(request)
    return ipcRenderer.invoke(CHANNELS.AGENT_CONTEXT_MANAGE, request).then((response) => context.assertManageResponse(response))
  },
  onAgentContextChanged,
  subscribeChanged: onChanged,
  onRequestedScope,
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
  exportInteraction: (request) => invoke(CHANNELS.AGENT_RUN_EXPORT_INTERACTION, c.assertExportRequest, c.assertExportResponse, request),
  recordSignal: (request) => invoke(CHANNELS.AGENT_RUN_RECORD_SIGNAL, c.assertRecordSignalRequest, c.assertRecordSignalResponse, request),
  acceptSessionSummaryRun: (request) => invoke(CHANNELS.SESSION_SUMMARY_RUN_ACCEPT, summaryRun.assertAcceptRequest, summaryRun.assertAcceptResponse, request),
  getSessionSummaryRun: (request) => invoke(CHANNELS.SESSION_SUMMARY_RUN_GET, summaryRun.assertControlRequest, summaryRun.assertGetResponse, request),
  cancelSessionSummaryRun: (request) => invoke(CHANNELS.SESSION_SUMMARY_RUN_CANCEL, summaryRun.assertCancelRequest, summaryRun.assertCancelResponse, request),
  resumeSessionSummaryRun: (request) => invoke(CHANNELS.SESSION_SUMMARY_RUN_RESUME, summaryRun.assertResumeRequest, summaryRun.assertResumeResponse, request),
  listRecoverableSessionSummaryRuns: (request) => invoke(CHANNELS.SESSION_SUMMARY_RUN_LIST_RECOVERABLE, summaryRun.assertListRecoverableRequest, summaryRun.assertListRecoverableResponse, request),
  getSessionSummaryRunDiagnostics: (request) => invoke(CHANNELS.SESSION_SUMMARY_RUN_DIAGNOSTICS_QUERY, summaryDiagnostics.assertQueryRequest, summaryDiagnostics.assertQueryResponse, request),
  exportSessionSummaryRunDiagnostics: (request) => invoke(CHANNELS.SESSION_SUMMARY_RUN_DIAGNOSTICS_EXPORT, summaryDiagnostics.assertExportRequest, summaryDiagnostics.assertExportResponse, request),
  onSessionSummaryRunChanged
})
