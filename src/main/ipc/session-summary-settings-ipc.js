'use strict'

const CHANNELS = require('./channels')
const {
  CONTRACT_ID,
  CONTRACT_VERSION,
  ERROR_CODES,
  ERROR_RULES,
  assertUpdateRequest,
  assertUpdateResponse
} = require('../../agent/contracts/session-summary-settings-ui')

function header (value) { return { contract_id: CONTRACT_ID, contract_version: CONTRACT_VERSION, ...value } }

function publicSettings (value) {
  return {
    summary_use_memory: value.summaryUseMemory === true,
    agent_settings_revision: value.agentSettingsRevision
  }
}

function responseFailure (code) {
  const rule = ERROR_RULES[code] || ERROR_RULES[ERROR_CODES.unavailable]
  return assertUpdateResponse(header({ ok: false, settings: null, error: { code, next_action: rule.next_action } }))
}

function registerSessionSummarySettingsIpc (options = {}) {
  if (!options.ipcMain || typeof options.ipcMain.handle !== 'function') throw new TypeError('ipcMain is required')
  if (typeof options.authorize !== 'function' || typeof options.getConfig !== 'function' || typeof options.updateSummaryUseMemory !== 'function') {
    throw new TypeError('authorization, config and update access are required')
  }
  const handler = async (event, request) => {
    try { options.authorize(event, CHANNELS.SESSION_SUMMARY_SETTINGS_UPDATE) } catch { return responseFailure(ERROR_CODES.permissionDenied) }
    try { assertUpdateRequest(request) } catch { return responseFailure(ERROR_CODES.invalid) }
    try {
      options.getConfig()
      const settings = await options.updateSummaryUseMemory({
        expectedRevision: request.expected_revision,
        summaryUseMemory: request.summary_use_memory
      })
      const result = assertUpdateResponse(header({ ok: true, settings: publicSettings(settings), error: null }))
      try { options.onChanged?.(result.settings) } catch { /* observers cannot affect the committed write */ }
      return result
    } catch (caught) {
      if (caught?.code === 'SETTINGS_REVISION_CONFLICT') return responseFailure(ERROR_CODES.revisionConflict)
      if (caught?.code === 'AGENT_CONTEXT_OPERATION_FAILED') return responseFailure(ERROR_CODES.unavailable)
      return responseFailure(ERROR_CODES.updateFailed)
    }
  }
  options.ipcMain.handle(CHANNELS.SESSION_SUMMARY_SETTINGS_UPDATE, handler)
  return () => { if (typeof options.ipcMain.removeHandler === 'function') options.ipcMain.removeHandler(CHANNELS.SESSION_SUMMARY_SETTINGS_UPDATE) }
}

module.exports = { registerSessionSummarySettingsIpc, publicSettings }
