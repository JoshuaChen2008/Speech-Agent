'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const c = require('../../src/agent/contracts/agent-run-ui')
const h = { contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION }
test('S5-1 exact Agent run channels and fail-closed contracts', () => {
  assert.deepEqual(c.IPC_CHANNELS, { getScopes:'agent-run:get-scopes', getEligibility:'agent-run:get-eligibility', submit:'agent-run:submit', cancel:'agent-run:cancel', getHistory:'agent-run:get-history', getInteraction:'agent-run:get-interaction', changed:'agent-run:changed', exportInteraction:'agent-run:export-interaction' })
  const scope = { kind:'session', reference:'session.demo' }
  assert.doesNotThrow(() => c.assertGetScopesRequest({ ...h, limit:50, cursor:null }))
  assert.throws(() => c.assertGetScopesRequest({ ...h, limit:51, cursor:null }), /range/)
  assert.doesNotThrow(() => c.assertGetScopesResponse({ ...h, ok:true, error:null, scopes:[], next_cursor:null, default_scope:null, revision:0 }))
  assert.throws(() => c.assertGetScopesResponse({ ...h, ok:true, error:null, scopes:[{ scope, display_name:'Demo', started_at:null, ended_at:null, state:'terminal' }], next_cursor:null, default_scope:scope, revision:0 }), /ended_at/)
  assert.doesNotThrow(() => c.assertGetEligibilityRequest({ ...h, scope }))
  assert.doesNotThrow(() => c.assertSubmitRequest({ ...h, scope, prompt:'minutes', client_idempotency_key:'client.demo' }))
  assert.throws(() => c.assertSubmitRequest({ ...h, scope, input:'x', prompt:'leak', client_idempotency_key:'client.demo' }), /exact keys/)
  assert.throws(() => c.assertExportRequest({ ...h, interaction_id:'interaction.demo', format:'markdown' }), /exact keys/)
  assert.doesNotThrow(() => c.assertCommandResponse({ ...h, ok:true, error:null, result:{ input_token:1, output_token:2 } }))
  assert.throws(() => c.assertCommandResponse({ ...h, ok:true, error:null, result:{ token_value:'secret' } }), /forbidden/)
  assert.throws(() => c.assertExportResponse({ ...h, ok:true, error:null, result:{ bytes_sha256:'a'.repeat(64), interaction_id:'interaction.demo', schema_version:1, snapshot:{ result:{ local_path:'/tmp/agent.json' } } } }), /forbidden/)
  assert.throws(() => c.assertGetEligibilityRequest({ ...h, contract_version:'9.0.0', scope }), /unsupported/)
  assert.throws(() => c.assertHistoryRequest({ ...h, limit:101, cursor:null }), /range/)
})
