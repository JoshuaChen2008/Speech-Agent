'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { registerAgentRunIpc } = require('../../src/main/ipc/agent-run-ipc')
const c = require('../../src/agent/contracts/agent-run-ui')
test('S5-1 controller gates roles and delegates exact requests', async () => {
  const handlers = new Map()
  const calls = []
  registerAgentRunIpc({
    ipcMain: { handle: (ch, fn) => handlers.set(ch, fn) },
    authorize: (_event, channel) => { if (channel === c.IPC_CHANNELS.submit) throw new Error('denied') },
    service: {
      getEligibility: async (r) => { calls.push(r); return { contract_id:c.CONTRACT_ID, contract_version:c.CONTRACT_VERSION, ok:true, error:null, snapshot:{ scope:r.scope, eligibility:'provider_not_configured', next_action:null, revision:0 } } },
      submit: async () => ({ contract_id:c.CONTRACT_ID, contract_version:c.CONTRACT_VERSION, ok:true, error:null, result:null }),
      cancel: async () => ({ contract_id:c.CONTRACT_ID, contract_version:c.CONTRACT_VERSION, ok:true, error:null, result:null }),
      getHistory: async () => ({ contract_id:c.CONTRACT_ID, contract_version:c.CONTRACT_VERSION, ok:true, error:null, result:{ items:[], has_more:false, next_cursor:null } }),
      getInteraction: async () => ({ contract_id:c.CONTRACT_ID, contract_version:c.CONTRACT_VERSION, ok:true, error:null, result:null }),
      exportInteraction: async () => ({ contract_id:c.CONTRACT_ID, contract_version:c.CONTRACT_VERSION, ok:true, error:null, result:null }),
      recordSignal: async () => ({ contract_id:c.CONTRACT_ID, contract_version:c.CONTRACT_VERSION, ok:true, error:null, result:{ accepted:true, interaction_id:'interaction.x', replayed:false, signal_kind:'accept' } })
    }
  })
  const req = { contract_id:c.CONTRACT_ID, contract_version:c.CONTRACT_VERSION, scope:{kind:'session',reference:'session.x'} }
  const eligibility = await handlers.get(c.IPC_CHANNELS.getEligibility)({}, req)
  assert.equal(eligibility.ok, true)
  assert.equal(eligibility.snapshot.eligibility, 'provider_not_configured')
  assert.equal(calls.length, 1)
  await assert.rejects(() => handlers.get(c.IPC_CHANNELS.submit)({}, { ...req, prompt:'x', client_idempotency_key:'client.x' }), /denied/)
})

test('SEM-F31/J22/J24: IPC revalidates the service response before exposing it to a renderer', async () => {
  const handlers = new Map()
  registerAgentRunIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    authorize: () => {},
    service: {
      getScopes: async () => ({
        contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION, ok: true, error: null,
        scopes: [], next_cursor: null, default_scope: null, revision: 0
      }),
      getEligibility: async (request) => ({
        contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION, ok: true, error: null,
        snapshot: { scope: request.scope, eligibility: 'credential_unavailable', next_action: null, revision: 0 }
      }),
      submit: async () => ({ contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION, ok: true, error: null, result: null }),
      cancel: async () => ({ contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION, ok: true, error: null, result: null }),
      getHistory: async () => ({
        contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION, ok: true, error: null,
        result: { items: [], has_more: false, next_cursor: null }, extra: 'must be rejected'
      }),
      getInteraction: async () => ({ contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION, ok: true, error: null, result: null }),
      exportInteraction: async () => ({ contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION, ok: true, error: null, result: null }),
      recordSignal: async () => ({ contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION, ok: true, error: null, result: { accepted: true, interaction_id: 'interaction.x', replayed: false, signal_kind: 'accept' } })
    }
  })

  const request = { contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION, limit: 10, cursor: null }
  await assert.rejects(
    () => handlers.get(c.IPC_CHANNELS.getHistory)({}, request),
    /must contain exact keys/
  )
})
