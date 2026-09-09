'use strict'

const CHANNELS = require('./channels')
const {
  CONTRACT_ID,
  CONTRACT_VERSION,
  ERROR_CODES,
  ERROR_RULES,
  assertUpdateRequest,
  assertUpdateResponse
} = require('../../agent/contracts/agent-settings-ui')

function header (value) {
  return { contract_id: CONTRACT_ID, contract_version: CONTRACT_VERSION, ...value }
}

function error (code) {
  const rule = ERROR_RULES[code] || ERROR_RULES[ERROR_CODES.unavailable]
  return { code, next_action: rule.next_action }
}

function responseFailure (code) {
  return assertUpdateResponse(header({ ok: false, settings: null, error: error(code) }))
}

function publicSettings (value) {
  return {
    agent_enabled: value.agentEnabled === true,
    memory_enabled: value.memoryEnabled === true,
    cloud_disclosure_accepted: value.cloudDisclosureAccepted === true,
    agent_settings_revision: value.agentSettingsRevision
  }
}

function registerAgentSettingsIpc (options = {}) {
  if (!options.ipcMain || typeof options.ipcMain.handle !== 'function') throw new TypeError('ipcMain is required')
  if (typeof options.authorize !== 'function' || typeof options.getRuntime !== 'function') {
    throw new TypeError('authorization and runtime access are required')
  }
  const handler = async (event, request) => {
    try {
      options.authorize(event, CHANNELS.AGENT_SETTINGS_UPDATE)
    } catch {
      return responseFailure(ERROR_CODES.permissionDenied)
    }
    try {
      assertUpdateRequest(request)
    } catch {
      return responseFailure(ERROR_CODES.invalid)
    }
    let runtime
    try {
      runtime = options.getRuntime()
    } catch {
      return responseFailure(ERROR_CODES.unavailable)
    }
    if (!runtime || typeof runtime.updateAgentSettings !== 'function') {
      return responseFailure(ERROR_CODES.unavailable)
    }
    try {
      const settings = await runtime.updateAgentSettings({
        expectedRevision: request.expected_revision,
        agentEnabled: request.agent_enabled,
        memoryEnabled: request.memory_enabled,
        cloudDisclosureAccepted: request.cloud_disclosure_accepted
      })
      const result = assertUpdateResponse(header({
        ok: true,
        settings: publicSettings(settings),
        error: null
      }))
      try { options.onChanged?.(result.settings) } catch { /* renderer notifications are best effort */ }
      return result
    } catch (caught) {
      const code = caught?.code === 'SETTINGS_REVISION_CONFLICT'
        ? ERROR_CODES.revisionConflict
        : caught?.code === 'AGENT_CONTEXT_OPERATION_FAILED'
          ? ERROR_CODES.updateFailed
          : ERROR_CODES.invalid
      return responseFailure(code)
    }
  }
  options.ipcMain.handle(CHANNELS.AGENT_SETTINGS_UPDATE, handler)
  return () => {
    if (typeof options.ipcMain.removeHandler === 'function') {
      options.ipcMain.removeHandler(CHANNELS.AGENT_SETTINGS_UPDATE)
    }
  }
}

module.exports = { registerAgentSettingsIpc, publicSettings }
