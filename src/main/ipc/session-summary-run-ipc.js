'use strict'

const CHANNELS = require('./channels')
const { isRoleAllowed } = require('./access-policy')
const c = require('../../agent/contracts/session-summary-run-ui')
const diagnostics = require('../../agent/contracts/agent-run-diagnostics-ui')

function unavailableResponse () {
  return {
    contract_id: c.CONTRACT_ID,
    contract_version: c.CONTRACT_VERSION,
    ok: false,
    error: { code: 'AGENT_RUN_UNAVAILABLE', next_action: 'retry' },
    result: null
  }
}

function diagnosticsFailureResponse (code) {
  return {
    contract_id: diagnostics.CONTRACT_ID,
    contract_version: diagnostics.CONTRACT_VERSION,
    ok: false,
    error: { code: diagnostics.ERROR_CODES.includes(code) ? code : 'AGENT_RUN_UNAVAILABLE', next_action: 'retry' },
    result: null
  }
}

function registerSessionSummaryRunIpc ({ ipcMain, service, getRole = () => 'agent', authorize = null }) {
  if (!ipcMain || typeof ipcMain.handle !== 'function') throw new TypeError('ipcMain is required')
  if (!service) throw new TypeError('service is required')
  const guard = (event, channel) => {
    if (authorize) { authorize(event, channel); return }
    const role = getRole(event)
    if (!isRoleAllowed(channel, role)) throw new Error('IPC_ACCESS_DENIED')
  }
  const invoke = (channel, requestValidator, responseValidator, method) => ipcMain.handle(channel, async (event, request) => {
    guard(event, channel)
    const input = requestValidator(request)
    let response
    try {
      if (typeof service[method] !== 'function') throw new Error('summary service method unavailable')
      response = await service[method](input, { sender: event?.sender })
    } catch {
      response = unavailableResponse()
    }
    return responseValidator(response)
  })

  invoke(CHANNELS.SESSION_SUMMARY_RUN_ACCEPT, c.assertAcceptRequest, c.assertAcceptResponse, 'accept')
  invoke(CHANNELS.SESSION_SUMMARY_RUN_GET, c.assertControlRequest, c.assertGetResponse, 'get')
  invoke(CHANNELS.SESSION_SUMMARY_RUN_CANCEL, c.assertCancelRequest, c.assertCancelResponse, 'cancel')
  invoke(CHANNELS.SESSION_SUMMARY_RUN_RESUME, c.assertResumeRequest, c.assertResumeResponse, 'resume')
  invoke(CHANNELS.SESSION_SUMMARY_RUN_LIST_RECOVERABLE, c.assertListRecoverableRequest, c.assertListRecoverableResponse, 'listRecoverable')
  const invokeDiagnostics = (channel, requestValidator, responseValidator, method, fallbackCode) => ipcMain.handle(channel, async (event, request) => {
    guard(event, channel)
    const input = requestValidator(request)
    let response
    try {
      if (typeof service[method] !== 'function') throw new Error('diagnostic service method unavailable')
      response = await service[method](input, { sender: event?.sender })
    } catch (error) {
      response = diagnosticsFailureResponse(error?.code || fallbackCode)
    }
    return responseValidator(response)
  })
  invokeDiagnostics(CHANNELS.SESSION_SUMMARY_RUN_DIAGNOSTICS_QUERY, diagnostics.assertQueryRequest,
    diagnostics.assertQueryResponse, 'getDiagnostics', 'AGENT_DIAGNOSTICS_UNAVAILABLE')
  invokeDiagnostics(CHANNELS.SESSION_SUMMARY_RUN_DIAGNOSTICS_EXPORT, diagnostics.assertExportRequest,
    diagnostics.assertExportResponse, 'exportDiagnostics', 'AGENT_DIAGNOSTIC_EXPORT_FAILED')
  return Object.freeze({ channels: Object.freeze({ ...c.IPC_CHANNELS, ...diagnostics.IPC_CHANNELS }) })
}

module.exports = { registerSessionSummaryRunIpc, unavailableResponse }
