'use strict'

const {
  CONTRACT_ID,
  CONTRACT_VERSION,
  ERROR_CODES,
  IPC_CHANNELS,
  assertChangedEvent,
  assertGetOverviewResponse,
  assertManageResponse
} = require('../../agent/contracts/agent-context-ui')

const CHANNELS = require('./channels')

function error (code) {
  const rules = {
    [ERROR_CODES.permissionDenied]: ['permission', 'none', null],
    [ERROR_CODES.unavailable]: ['unavailable', 'retry_same_request', 'retry']
  }
  const rule = rules[code]
  return { code, category: rule[0], current_revision: null, retry_policy: rule[1], next_action: rule[2] }
}

function unavailableOverview (code = ERROR_CODES.unavailable) {
  return assertGetOverviewResponse({
    contract_id: CONTRACT_ID, contract_version: CONTRACT_VERSION,
    ok: false, snapshot: null, error: error(code)
  })
}

function unavailableManage (code = ERROR_CODES.unavailable) {
  return assertManageResponse({
    contract_id: CONTRACT_ID, contract_version: CONTRACT_VERSION,
    ok: false, result: null, revision: null, error: error(code)
  })
}

function registerPersonalContextIpc (options = {}) {
  if (!options.ipcMain || typeof options.ipcMain.handle !== 'function') throw new TypeError('ipcMain is required')
  if (typeof options.authorize !== 'function' || typeof options.getRuntime !== 'function') {
    throw new TypeError('authorization and runtime access are required')
  }
  const overviewHandler = async (event, request) => {
    try { options.authorize(event, CHANNELS.AGENT_CONTEXT_GET_OVERVIEW) } catch { return unavailableOverview(ERROR_CODES.permissionDenied) }
    const runtime = options.getRuntime()
    if (!runtime) return unavailableOverview()
    try { return assertGetOverviewResponse(await runtime.getOverview(request)) } catch { return unavailableOverview() }
  }
  const manageHandler = async (event, request) => {
    try { options.authorize(event, CHANNELS.AGENT_CONTEXT_MANAGE) } catch { return unavailableManage(ERROR_CODES.permissionDenied) }
    const runtime = options.getRuntime()
    if (!runtime) return unavailableManage()
    try { return assertManageResponse(await runtime.manage(request)) } catch { return unavailableManage() }
  }
  options.ipcMain.handle(CHANNELS.AGENT_CONTEXT_GET_OVERVIEW, overviewHandler)
  options.ipcMain.handle(CHANNELS.AGENT_CONTEXT_MANAGE, manageHandler)
  return () => {
    if (typeof options.ipcMain.removeHandler === 'function') {
      options.ipcMain.removeHandler(CHANNELS.AGENT_CONTEXT_GET_OVERVIEW)
      options.ipcMain.removeHandler(CHANNELS.AGENT_CONTEXT_MANAGE)
    }
  }
}

function broadcastPersonalContextChanged (windows, event) {
  let validated
  try { validated = assertChangedEvent(event) } catch { return false }
  for (const win of [windows.settings, windows.history]) {
    if (win && !win.isDestroyed()) win.webContents.send(IPC_CHANNELS.changed, validated)
  }
  return true
}

module.exports = {
  broadcastPersonalContextChanged,
  registerPersonalContextIpc,
  unavailableManage,
  unavailableOverview
}
