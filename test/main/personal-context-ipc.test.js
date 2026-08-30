'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { CONTRACT_ID, CONTRACT_VERSION } = require('../../src/agent/contracts/agent-context-ui')
const CHANNELS = require('../../src/main/ipc/channels')
const {
  broadcastPersonalContextChanged,
  registerPersonalContextIpc
} = require('../../src/main/ipc/personal-context-ipc')

function harness (runtime) {
  const handlers = new Map()
  const calls = []
  registerPersonalContextIpc({
    ipcMain: {
      handle: (channel, handler) => handlers.set(channel, handler),
      removeHandler: (channel) => handlers.delete(channel)
    },
    authorize: (event) => {
      if (!['settings', 'history'].includes(event.role)) throw new Error('denied')
    },
    getRuntime: () => runtime && {
      getOverview: async (request) => { calls.push(['overview', request]); return runtime.overview },
      manage: async (request) => { calls.push(['manage', request]); return runtime.manage }
    }
  })
  return { calls, handlers }
}

const overview = {
  contract_id: CONTRACT_ID,
  contract_version: CONTRACT_VERSION,
  ok: true,
  error: null,
  snapshot: {
    counts: { personal_memories: 0, session_episodes: 0 },
    eligibility: 'provider_not_configured',
    memory_processing: { state: 'enabled', automatic_processing_boundary: 'not_established' },
    revision: 0
  }
}

test('SEM-F30/J21: personal-context IPC denies stale or unauthorized roles before touching the module', async () => {
  const { calls, handlers } = harness({ overview, manage: null })
  const request = { contract_id: CONTRACT_ID, contract_version: CONTRACT_VERSION }
  for (const role of ['caption', 'toolbar', 'unknown']) {
    const response = await handlers.get(CHANNELS.AGENT_CONTEXT_GET_OVERVIEW)({ role }, request)
    assert.equal(response.ok, false)
    assert.equal(response.error.code, 'AGENT_CONTEXT_PERMISSION_DENIED')
  }
  assert.deepEqual(calls, [])
})

test('SEM-F30/J21: IPC validates runtime responses and degrades unavailable without exception material', async () => {
  const available = harness({ overview, manage: {
    contract_id: CONTRACT_ID, contract_version: CONTRACT_VERSION,
    ok: true, error: null, revision: 0,
    result: { kind: 'memory_page', items: [], has_more: false, next_cursor: null }
  } })
  assert.deepEqual(await available.handlers.get(CHANNELS.AGENT_CONTEXT_GET_OVERVIEW)(
    { role: 'settings' }, { contract_id: CONTRACT_ID, contract_version: CONTRACT_VERSION }
  ), overview)
  const unavailable = harness(null)
  const response = await unavailable.handlers.get(CHANNELS.AGENT_CONTEXT_MANAGE)({ role: 'history' }, {})
  assert.equal(response.error.code, 'AGENT_CONTEXT_UNAVAILABLE')
  assert.doesNotMatch(JSON.stringify(response), /stack|path|scheduler/i)
})

test('SEM-F30/J21: changed broadcasts only exact events to current settings and history windows', () => {
  const sends = []
  const win = (role, destroyed = false) => ({
    isDestroyed: () => destroyed,
    webContents: { send: (channel, event) => sends.push([role, channel, event]) }
  })
  assert.equal(broadcastPersonalContextChanged({
    settings: win('settings'), history: win('history'), caption: win('caption')
  }, { contract_id: CONTRACT_ID, contract_version: CONTRACT_VERSION, revision: 3 }), true)
  assert.deepEqual(sends.map(([role]) => role), ['settings', 'history'])
  assert.equal(broadcastPersonalContextChanged({ settings: win('settings') }, {
    contract_id: CONTRACT_ID, contract_version: CONTRACT_VERSION, revision: 4, scheduler: true
  }), false)
  assert.equal(sends.length, 2)
})
