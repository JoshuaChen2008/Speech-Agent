'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const CHANNELS = require('../../src/main/ipc/channels')
const { isRoleAllowed } = require('../../src/main/ipc/access-policy')
const { registerModelAccessIpc } = require('../../src/main/ipc/model-access-ipc')

const modelHeader = { contractId: 'agent-model-ui', contractVersion: '1.0.0' }
const testHeader = { contractId: 'agent-model-test-ui', contractVersion: '1.0.0' }

test('SEM-F36/J25: independent model test IPC is settings-only and returns exact bounded envelopes', async () => {
  for (const channel of [CHANNELS.AGENT_MODEL_GET_PRESETS, CHANNELS.AGENT_MODEL_TEST_SAVED, CHANNELS.AGENT_MODEL_CANCEL_TEST]) {
    assert.equal(isRoleAllowed(channel, 'settings'), true)
    for (const role of ['caption', 'toolbar', 'history', 'agent']) assert.equal(isRoleAllowed(channel, role), false)
  }
  const handlers = new Map()
  const calls = []
  registerModelAccessIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    authorize: (_event, channel) => { if (!channel.startsWith('agent-model:')) throw new Error('denied') },
    getRuntime: () => ({
      catalog: async () => ({ ok: true, snapshot: { revision: 0, profiles: [], readinessByPurpose: { default: { assignmentMode: 'unconfigured', providerKind: null, target: null, singleShot: 'provider_not_configured', agentLoop: 'provider_not_configured' }, information_extraction: { assignmentMode: 'unconfigured', providerKind: null, target: null, singleShot: 'provider_not_configured', agentLoop: 'provider_not_configured' }, summary: { assignmentMode: 'unconfigured', providerKind: null, target: null, singleShot: 'provider_not_configured', agentLoop: 'provider_not_configured' }, analysis_planning: { assignmentMode: 'unconfigured', providerKind: null, target: null, singleShot: 'provider_not_configured', agentLoop: 'provider_not_configured' } } }, error: null }),
      presetCatalog: async () => [],
      testSavedModel: async (request) => { calls.push(request); return { ok: true, status: 'success', nextAction: 'none' } },
      cancelSavedModel: async (testId) => { calls.push(testId); return { ok: false, status: 'cancelled', nextAction: 'none' } }
    }),
    getPullController: () => null
  })
  const settings = { role: 'settings' }
  const presets = await handlers.get(CHANNELS.AGENT_MODEL_GET_PRESETS)(settings, { contractId: 'agent-model-presets-ui', contractVersion: '1.0.0' })
  assert.deepEqual(presets.presets, [])
  const request = { ...testHeader, profileId: 'deepseek', modelId: 'model', expectedRevision: 0, testId: 'test.1' }
  assert.deepEqual(await handlers.get(CHANNELS.AGENT_MODEL_TEST_SAVED)(settings, request), { ...testHeader, testId: 'test.1', ok: true, status: 'success', nextAction: 'none' })
  assert.deepEqual(await handlers.get(CHANNELS.AGENT_MODEL_CANCEL_TEST)(settings, { ...testHeader, testId: 'test.1' }), { ...testHeader, testId: 'test.1', ok: false, status: 'cancelled', nextAction: 'none' })
  assert.equal(calls.length, 2)
  const invalid = await handlers.get(CHANNELS.AGENT_MODEL_TEST_SAVED)(settings, { ...request, prompt: 'no' })
  assert.deepEqual(invalid, { ...testHeader, testId: 'invalid-test', ok: false, status: 'invalid_request', nextAction: 'edit_connection' })
})
