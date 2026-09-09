'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const CHANNELS = require('../../src/main/ipc/channels')
const { isRoleAllowed } = require('../../src/main/ipc/access-policy')
const { registerAgentSettingsIpc } = require('../../src/main/ipc/agent-settings-ipc')
const c = require('../../src/agent/contracts/agent-settings-ui')

const request = {
  contract_id: c.CONTRACT_ID,
  contract_version: c.CONTRACT_VERSION,
  expected_revision: 0,
  agent_enabled: true,
  memory_enabled: true,
  cloud_disclosure_accepted: false
}

function harness (runtime, authorize = () => {}) {
  const handlers = new Map()
  const changes = []
  const getRuntime = typeof runtime === 'function' ? runtime : () => runtime
  const unregister = registerAgentSettingsIpc({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel)
    },
    authorize,
    getRuntime,
    onChanged: (value) => changes.push(value)
  })
  return { changes, handlers, unregister }
}

test('SEM-F27/SEM-F30/J21: Agent settings IPC is settings-only and delegates the exact update', async () => {
  assert.equal(isRoleAllowed(CHANNELS.AGENT_SETTINGS_UPDATE, 'settings'), true)
  for (const role of ['caption', 'toolbar', 'history', 'agent', 'unknown']) {
    assert.equal(isRoleAllowed(CHANNELS.AGENT_SETTINGS_UPDATE, role), false)
  }
  const calls = []
  const h = harness({
    updateAgentSettings: async (value) => { calls.push(value); return {
      agentEnabled: true, memoryEnabled: true, cloudDisclosureAccepted: false, agentSettingsRevision: 1
    } }
  }, (_event, channel) => assert.equal(channel, CHANNELS.AGENT_SETTINGS_UPDATE))
  const response = await h.handlers.get(CHANNELS.AGENT_SETTINGS_UPDATE)({}, request)
  assert.equal(response.ok, true)
  assert.deepEqual(calls, [{ expectedRevision: 0, agentEnabled: true, memoryEnabled: true, cloudDisclosureAccepted: false }])
  assert.deepEqual(h.changes, [response.settings])
  h.unregister()
  assert.equal(h.handlers.has(CHANNELS.AGENT_SETTINGS_UPDATE), false)
})

test('SEM-T04/J21: malformed, stale, unavailable and policy failures are sanitized before reaching the renderer', async () => {
  const runtime = { updateAgentSettings: async () => { throw Object.assign(new Error('private path'), { code: 'SETTINGS_REVISION_CONFLICT' }) } }
  const h = harness(runtime)
  const invalid = await h.handlers.get(CHANNELS.AGENT_SETTINGS_UPDATE)({}, { ...request, unknown: true })
  assert.equal(invalid.error.code, 'AGENT_SETTINGS_INVALID')
  assert.doesNotMatch(JSON.stringify(invalid), /private|path|stack/i)
  const conflict = await h.handlers.get(CHANNELS.AGENT_SETTINGS_UPDATE)({}, request)
  assert.equal(conflict.error.code, 'AGENT_SETTINGS_REVISION_CONFLICT')

  const unavailable = harness(null)
  const missing = await unavailable.handlers.get(CHANNELS.AGENT_SETTINGS_UPDATE)({}, request)
  assert.equal(missing.error.code, 'AGENT_SETTINGS_UNAVAILABLE')

  const unavailableAccessor = harness(() => { throw new Error('runtime closed') })
  const accessorFailure = await unavailableAccessor.handlers.get(CHANNELS.AGENT_SETTINGS_UPDATE)({}, request)
  assert.equal(accessorFailure.error.code, 'AGENT_SETTINGS_UNAVAILABLE')

  const failed = harness({ updateAgentSettings: async () => { throw Object.assign(new Error('provider failure'), { code: 'AGENT_CONTEXT_OPERATION_FAILED' }) } })
  const policy = await failed.handlers.get(CHANNELS.AGENT_SETTINGS_UPDATE)({}, request)
  assert.equal(policy.error.code, 'AGENT_SETTINGS_UPDATE_FAILED')

  const denied = harness({ updateAgentSettings: async () => { throw new Error('must not call') } }, () => { throw new Error('denied') })
  const permission = await denied.handlers.get(CHANNELS.AGENT_SETTINGS_UPDATE)({}, request)
  assert.equal(permission.error.code, 'AGENT_SETTINGS_PERMISSION_DENIED')
})
