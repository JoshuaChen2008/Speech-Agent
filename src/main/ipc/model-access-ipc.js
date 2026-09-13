'use strict'

const CHANNELS = require('./channels')
const {
  CONTRACT_ID, CONTRACT_VERSION,
  assertCatalogResponse, assertChangedEvent, assertConfigureRequest, assertConfigureResponse,
  assertGetCatalogRequest, assertPullRequest, assertPullResponse
} = require('../../agent/contracts/agent-model-ui')
const {
  CONTRACT_ID: PRESETS_CONTRACT_ID, CONTRACT_VERSION: PRESETS_CONTRACT_VERSION,
  assertGetPresetsRequest, assertGetPresetsResponse
} = require('../../agent/contracts/agent-model-presets-ui')
const {
  CONTRACT_ID: TEST_CONTRACT_ID, CONTRACT_VERSION: TEST_CONTRACT_VERSION,
  assertCancelRequest, assertTestRequest, assertTestResponse
} = require('../../agent/contracts/agent-model-test-ui')

const withHeader = (value) => ({ contractId: CONTRACT_ID, contractVersion: CONTRACT_VERSION, ...value })
const withPresetsHeader = (value) => ({ contractId: PRESETS_CONTRACT_ID, contractVersion: PRESETS_CONTRACT_VERSION, ...value })
const withTestHeader = (value) => ({ contractId: TEST_CONTRACT_ID, contractVersion: TEST_CONTRACT_VERSION, ...value })

function registerModelAccessIpc (options = {}) {
  if (!options.ipcMain || typeof options.authorize !== 'function' || typeof options.getRuntime !== 'function' || typeof options.getPullController !== 'function') throw new TypeError('model IPC dependencies are required')
  options.ipcMain.handle(CHANNELS.AGENT_MODEL_GET_CATALOG, async (event, request) => {
    try { options.authorize(event, CHANNELS.AGENT_MODEL_GET_CATALOG); assertGetCatalogRequest(request) } catch { return assertCatalogResponse(withHeader({ ok: false, snapshot: null, error: { code: 'MODEL_ACCESS_UNAVAILABLE' } })) }
    const runtime = options.getRuntime()
    if (!runtime) return assertCatalogResponse(withHeader({ ok: false, snapshot: null, error: { code: 'MODEL_ACCESS_UNAVAILABLE' } }))
    return assertCatalogResponse(withHeader(await runtime.catalog()))
  })
  options.ipcMain.handle(CHANNELS.AGENT_MODEL_GET_PRESETS, async (event, request) => {
    try { options.authorize(event, CHANNELS.AGENT_MODEL_GET_PRESETS); assertGetPresetsRequest(request) } catch { return assertGetPresetsResponse(withPresetsHeader({ presets: [] })) }
    const runtime = options.getRuntime()
    let presets = []
    try { if (runtime && typeof runtime.presetCatalog === 'function') presets = await runtime.presetCatalog() } catch { presets = [] }
    return assertGetPresetsResponse(withPresetsHeader({ presets }))
  })
  options.ipcMain.handle(CHANNELS.AGENT_MODEL_CONFIGURE, async (event, request) => {
    try { options.authorize(event, CHANNELS.AGENT_MODEL_CONFIGURE); assertConfigureRequest(request) } catch { return assertConfigureResponse(withHeader({ ok: false, revision: null, error: { code: 'MODEL_CONFIG_INVALID', nextAction: 'correct_input' } })) }
    const runtime = options.getRuntime()
    if (!runtime) return assertConfigureResponse(withHeader({ ok: false, revision: null, error: { code: 'MODEL_CONFIG_INVALID', nextAction: 'correct_input' } }))
    try { return assertConfigureResponse(withHeader(await runtime.configure(request.command))) } catch {
      return assertConfigureResponse(withHeader({ ok: false, revision: null, error: { code: 'MODEL_CONFIG_INVALID', nextAction: 'correct_input' } }))
    }
  })
  options.ipcMain.handle(CHANNELS.AGENT_MODEL_PULL_REMOTE_CATALOG, async (event, request) => {
    try { options.authorize(event, CHANNELS.AGENT_MODEL_PULL_REMOTE_CATALOG); assertPullRequest(request) } catch { return assertPullResponse(withHeader({ status: 'invalid_request', suggestions: [] })) }
    const controller = options.getPullController()
    if (!controller) return assertPullResponse(withHeader({ status: 'remote_unavailable', suggestions: [] }))
    return assertPullResponse(withHeader(await controller.pull({ profileId: request.profileId, expectedRevision: request.expectedRevision })))
  })
  options.ipcMain.handle(CHANNELS.AGENT_MODEL_TEST_SAVED, async (event, request) => {
    try { options.authorize(event, CHANNELS.AGENT_MODEL_TEST_SAVED); assertTestRequest(request) } catch {
      return assertTestResponse(withTestHeader({ testId: 'invalid-test', ok: false, status: 'invalid_request', nextAction: 'edit_connection' }))
    }
    const runtime = options.getRuntime()
    if (!runtime || typeof runtime.testSavedModel !== 'function') return assertTestResponse(withTestHeader({ testId: request.testId, ok: false, status: 'remote_unavailable', nextAction: 'retry' }))
    try {
      const result = await runtime.testSavedModel(request)
      return assertTestResponse(withTestHeader({ testId: request.testId, ...result }))
    } catch { return assertTestResponse(withTestHeader({ testId: request.testId, ok: false, status: 'remote_unavailable', nextAction: 'retry' })) }
  })
  options.ipcMain.handle(CHANNELS.AGENT_MODEL_CANCEL_TEST, async (event, request) => {
    try { options.authorize(event, CHANNELS.AGENT_MODEL_CANCEL_TEST); assertCancelRequest(request) } catch {
      return assertTestResponse(withTestHeader({ testId: 'invalid-test', ok: false, status: 'invalid_request', nextAction: 'edit_connection' }))
    }
    const runtime = options.getRuntime()
    if (runtime && typeof runtime.cancelSavedModel === 'function') await runtime.cancelSavedModel(request.testId)
    return assertTestResponse(withTestHeader({ testId: request.testId, ok: false, status: 'cancelled', nextAction: 'none' }))
  })
}

function broadcastModelAccessChanged (settingsWindow, revision) {
  const event = assertChangedEvent(withHeader({ revision }))
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send(CHANNELS.AGENT_MODEL_CHANGED, event)
}

module.exports = { broadcastModelAccessChanged, registerModelAccessIpc }
