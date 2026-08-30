'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const CHANNELS = require('../../src/main/ipc/channels')
const { isRoleAllowed } = require('../../src/main/ipc/access-policy')
const { registerModelAccessIpc } = require('../../src/main/ipc/model-access-ipc')

const header = { contractId: 'agent-model-ui', contractVersion: '1.0.0' }

test('SEM-F33/J25: model IPC is settings-only and delegates exact requests', async () => {
  for (const channel of [CHANNELS.AGENT_MODEL_GET_CATALOG, CHANNELS.AGENT_MODEL_CONFIGURE, CHANNELS.AGENT_MODEL_PULL_REMOTE_CATALOG]) {
    assert.equal(isRoleAllowed(channel, 'settings'), true)
    for (const role of ['caption', 'toolbar', 'history']) assert.equal(isRoleAllowed(channel, role), false)
  }
  const handlers = new Map()
  registerModelAccessIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    authorize: (_event, channel) => { if (!channel.startsWith('agent-model:')) throw new Error() },
    getRuntime: () => ({
      catalog: async () => ({ ok: true, snapshot: { revision: 0, profiles: [], readinessByPurpose: {} }, error: null }),
      configure: async () => ({ ok: true, revision: 1, error: null })
    }),
    getPullController: () => ({ pull: async () => ({ status: 'success', suggestions: [] }) })
  })
  assert.equal((await handlers.get(CHANNELS.AGENT_MODEL_GET_CATALOG)({}, header)).ok, true)
  const invalid = await handlers.get(CHANNELS.AGENT_MODEL_CONFIGURE)({}, { ...header, command: { type: 'unknown', expectedRevision: 0 } })
  assert.equal(invalid.error.code, 'MODEL_CONFIG_INVALID')
  const pull = await handlers.get(CHANNELS.AGENT_MODEL_PULL_REMOTE_CATALOG)({}, { ...header, profileId: 'deepseek', expectedRevision: 0 })
  assert.equal(pull.status, 'success')
})
