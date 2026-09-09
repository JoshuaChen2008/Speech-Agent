'use strict'
const CHANNELS = require('./channels')
const { isRoleAllowed } = require('./access-policy')
const c = require('../../agent/contracts/agent-run-ui')

function registerAgentRunIpc ({ ipcMain, service, getRole = () => 'agent', authorize = null, onChanged = null }) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') throw new TypeError('ipcMain is required')
  if (!service) throw new TypeError('service is required')
  const guard = (event, channel) => {
    if (authorize) { authorize(event, channel); return }
    const role = getRole(event)
    if (!isRoleAllowed(channel, role)) throw new Error('IPC_ACCESS_DENIED')
  }
  const invoke = (channel, validate, responseValidate, method) => ipcMain.handle(channel, async (event, request) => {
    guard(event, channel)
    const input = validate(request)
    const result = await service[method](input, { sender: event?.sender })
    return responseValidate(result)
  })
  invoke(CHANNELS.AGENT_RUN_GET_SCOPES, c.assertGetScopesRequest, c.assertGetScopesResponse, 'getScopes')
  invoke(CHANNELS.AGENT_RUN_GET_ELIGIBILITY, c.assertGetEligibilityRequest, c.assertGetEligibilityResponse, 'getEligibility')
  invoke(CHANNELS.AGENT_RUN_SUBMIT, c.assertSubmitRequest, c.assertSubmitResponse, 'submit')
  invoke(CHANNELS.AGENT_RUN_CANCEL, c.assertCancelRequest, c.assertCancelResponse, 'cancel')
  invoke(CHANNELS.AGENT_RUN_GET_HISTORY, c.assertHistoryRequest, c.assertHistoryResponse, 'getHistory')
  invoke(CHANNELS.AGENT_RUN_GET_INTERACTION, c.assertInteractionRequest, c.assertInteractionResponse, 'getInteraction')
  invoke(CHANNELS.AGENT_RUN_EXPORT_INTERACTION, c.assertExportRequest, c.assertExportResponse, 'exportInteraction')
  invoke(CHANNELS.AGENT_RUN_RECORD_SIGNAL, c.assertRecordSignalRequest, c.assertRecordSignalResponse, 'recordSignal')
  if (onChanged) onChanged((event, value) => {
    guard(event, CHANNELS.AGENT_RUN_CHANGED)
    return c.assertChangedEvent(value)
  })
  return Object.freeze({ channels: c.IPC_CHANNELS })
}

module.exports = { registerAgentRunIpc }
