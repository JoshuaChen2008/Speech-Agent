'use strict'

const CHANNELS = require('./channels')
const {
  CONTRACT_ID, CONTRACT_VERSION,
  assertCatalogResponse, assertChangedEvent, assertConfigureRequest, assertConfigureResponse,
  assertGetCatalogRequest, assertPullRequest, assertPullResponse
} = require('../../agent/contracts/agent-model-ui')

const withHeader = (value) => ({ contractId: CONTRACT_ID, contractVersion: CONTRACT_VERSION, ...value })

function registerModelAccessIpc (options = {}) {
  if (!options.ipcMain || typeof options.authorize !== 'function' || typeof options.getRuntime !== 'function' || typeof options.getPullController !== 'function') throw new TypeError('model IPC dependencies are required')
  options.ipcMain.handle(CHANNELS.AGENT_MODEL_GET_CATALOG, async (event, request) => {
    try { options.authorize(event, CHANNELS.AGENT_MODEL_GET_CATALOG); assertGetCatalogRequest(request) } catch { return assertCatalogResponse(withHeader({ ok: false, snapshot: null, error: { code: 'MODEL_ACCESS_UNAVAILABLE' } })) }
    const runtime = options.getRuntime()
    if (!runtime) return assertCatalogResponse(withHeader({ ok: false, snapshot: null, error: { code: 'MODEL_ACCESS_UNAVAILABLE' } }))
    return assertCatalogResponse(withHeader(await runtime.catalog()))
  })
  options.ipcMain.handle(CHANNELS.AGENT_MODEL_CONFIGURE, async (event, request) => {
    try { options.authorize(event, CHANNELS.AGENT_MODEL_CONFIGURE); assertConfigureRequest(request) } catch { return assertConfigureResponse(withHeader({ ok: false, revision: null, error: { code: 'MODEL_CONFIG_INVALID', nextAction: 'correct_input' } })) }
    return assertConfigureResponse(withHeader(await options.getRuntime().configure(request.command)))
  })
  options.ipcMain.handle(CHANNELS.AGENT_MODEL_PULL_REMOTE_CATALOG, async (event, request) => {
    try { options.authorize(event, CHANNELS.AGENT_MODEL_PULL_REMOTE_CATALOG); assertPullRequest(request) } catch { return assertPullResponse(withHeader({ status: 'invalid_request', suggestions: [] })) }
    const controller = options.getPullController()
    if (!controller) return assertPullResponse(withHeader({ status: 'remote_unavailable', suggestions: [] }))
    return assertPullResponse(withHeader(await controller.pull({ profileId: request.profileId, expectedRevision: request.expectedRevision })))
  })
}

function broadcastModelAccessChanged (settingsWindow, revision) {
  const event = assertChangedEvent(withHeader({ revision }))
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send(CHANNELS.AGENT_MODEL_CHANGED, event)
}

module.exports = { broadcastModelAccessChanged, registerModelAccessIpc }
