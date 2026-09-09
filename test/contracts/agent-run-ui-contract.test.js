'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const c = require('../../src/agent/contracts/agent-run-ui')
const { deriveToolResultMetadata } = require('../../src/agent/contracts/controlled-tools')
const { sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')
const h = { contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION }
const sourceRef = { sessionId:'session.ui', transcriptVersion:'raw', fromEventOrder:1, throughEventOrder:1 }
const toolArgs = { schemaVersion:1, sourceRefs:[sourceRef] }
const toolResult = { schemaVersion:1, sources:[{ sourceRef, text:'受控来源' }] }
const toolMetadata = deriveToolResultMetadata('read_sources', toolArgs, toolResult)
const toolCall = {
  args: toolArgs,
  args_digest: sha256Canonical(toolArgs),
  attempt: 1,
  call_id: 'call.ui.1',
  call_order: 1,
  counts: { resultBytes: toolMetadata.resultBytes, sourceTextBytes: toolMetadata.sourceTextBytes, sourceReferenceCount: toolMetadata.sourceReferenceCount },
  ended_offset_ms: 12,
  error_code: null,
  result: toolResult,
  result_digest: toolMetadata.resultDigest,
  schema_version: 1,
  source_refs: toolMetadata.sourceRefs,
  started_offset_ms: 0,
  status: 'succeeded',
  tool_name: 'read_sources'
}
test('S5-1 exact Agent run channels and fail-closed contracts', () => {
  assert.deepEqual(c.IPC_CHANNELS, { getScopes:'agent-run:get-scopes', getEligibility:'agent-run:get-eligibility', submit:'agent-run:submit', cancel:'agent-run:cancel', getHistory:'agent-run:get-history', getInteraction:'agent-run:get-interaction', changed:'agent-run:changed', exportInteraction:'agent-run:export-interaction', recordSignal:'agent-run:record-signal' })
  const scope = { kind:'session', reference:'session.demo' }
  assert.doesNotThrow(() => c.assertGetScopesRequest({ ...h, limit:50, cursor:null }))
  assert.throws(() => c.assertGetScopesRequest({ ...h, limit:51, cursor:null }), /range/)
  assert.doesNotThrow(() => c.assertGetScopesResponse({ ...h, ok:true, error:null, scopes:[], next_cursor:null, default_scope:null, revision:0 }))
  assert.throws(() => c.assertGetScopesResponse({ ...h, ok:true, error:null, scopes:[{ scope, display_name:'Demo', started_at:null, ended_at:null, state:'terminal' }], next_cursor:null, default_scope:scope, revision:0 }), /ended_at/)
  assert.doesNotThrow(() => c.assertGetEligibilityRequest({ ...h, scope }))
  assert.doesNotThrow(() => c.assertSubmitRequest({ ...h, scope, prompt:'minutes', client_idempotency_key:'client.demo' }))
  assert.throws(() => c.assertSubmitRequest({ ...h, scope, input:'x', prompt:'leak', client_idempotency_key:'client.demo' }), /exact keys/)
  assert.throws(() => c.assertExportRequest({ ...h, interaction_id:'interaction.demo', format:'markdown' }), /exact keys/)
  assert.doesNotThrow(() => c.assertRecordSignalRequest({ ...h, interaction_id:'interaction.demo', payload:null, result_digest:'a'.repeat(64), signal_idempotency_key:'signal.demo', signal_kind:'accept' }))
  assert.doesNotThrow(() => c.assertRecordSignalRequest({ ...h, interaction_id:'interaction.demo', payload:{ text:'修订后的内容' }, result_digest:'a'.repeat(64), signal_idempotency_key:'signal.edit.demo', signal_kind:'edit' }))
  assert.throws(() => c.assertRecordSignalRequest({ ...h, interaction_id:'interaction.demo', payload:null, result_digest:'a'.repeat(64), signal_idempotency_key:'signal.demo', signal_kind:'scroll' }), /registered/)
  assert.throws(() => c.assertRecordSignalRequest({ ...h, interaction_id:'interaction.demo', payload:null, result_digest:null, signal_idempotency_key:'signal.demo', signal_kind:'accept' }), /result digest/)
  assert.throws(() => c.assertRecordSignalRequest({ ...h, interaction_id:'interaction.demo', payload:{ text:'x\u0000' }, result_digest:'a'.repeat(64), signal_idempotency_key:'signal.demo', signal_kind:'edit' }), /bounded text/)
  assert.throws(() => c.assertRecordSignalRequest({ ...h, interaction_id:'interaction.demo', payload:null, result_digest:null, signal_idempotency_key:'signal.demo', signal_kind:'prompt', extra:'telemetry' }), /exact keys/)
  assert.doesNotThrow(() => c.assertRecordSignalResponse({ ...h, ok:true, error:null, result:{ accepted:true, interaction_id:'interaction.demo', replayed:false, signal_kind:'accept' } }))
  assert.doesNotThrow(() => c.assertCommandResponse({ ...h, ok:true, error:null, result:{ input_token:1, output_token:2 } }))
  assert.throws(() => c.assertCommandResponse({ ...h, ok:true, error:null, result:{ token_value:'secret' } }), /forbidden/)
  assert.throws(() => c.assertExportResponse({ ...h, ok:true, error:null, result:{ bytes_sha256:'a'.repeat(64), interaction_id:'interaction.demo', schema_version:1, snapshot:{ result:{ local_path:'/tmp/agent.json' } } } }), /forbidden/)
  assert.throws(() => c.assertGetEligibilityRequest({ ...h, contract_version:'9.0.0', scope }), /unsupported/)
  assert.throws(() => c.assertHistoryRequest({ ...h, limit:101, cursor:null }), /range/)
})

test('SEM-F31/SEM-F33/J25: history keeps frozen model identity and comparison group without prompt fields', () => {
  const item = {
    attempt_count: 1, comparison_group_id: 'c'.repeat(64), created_at: 1, duration_ms: 20,
    error_code: null, interaction_id: 'interaction.history',
    model: { adapter_id: 'openai-compatible', model_id: 'model.a', profile_id: 'profile.a', profile_revision: 2, provider_kind: 'cloud' },
    recipe_id: 'qa.answer', recipe_version: '1', result: { answer: '摘要' }, result_digest: 'a'.repeat(64),
    terminal_at: 2, terminal_reason: 'succeeded', usage: null, usage_state: 'unknown'
  }
  assert.doesNotThrow(() => c.assertHistoryResponse({ ...h, ok: true, error: null, result: { has_more: false, items: [item], next_cursor: null } }))
  assert.throws(() => c.assertHistoryResponse({ ...h, ok: true, error: null, result: { has_more: false, items: [{ ...item, comparison_group_id: null }], next_cursor: null } }), /comparison_group_id/)
  assert.throws(() => c.assertHistoryResponse({ ...h, ok: true, error: null, result: { has_more: false, items: [{ ...item, model: { ...item.model, credential: 'secret' } }], next_cursor: null } }), /exact keys/)
})

test('SEM-F34/J24: Agent interaction exposes complete bounded tool arguments and results only as an explicit detail record', () => {
  const result = {
    attempt_count: 1, created_at: 1, duration_ms: 12, error_code: null,
    interaction_id: 'interaction.ui.tools',
    model: { adapter_id:'adapter.internal', model_id:'model.internal', profile_id:'profile.internal', profile_revision:1, provider_kind:'cloud' },
    recipe_id: 'qa.answer', recipe_version:'1', result:{ answer:'结果摘要', sourceRefs:[sourceRef], memoryRefs:[], unresolved:[] },
    result_digest: 'a'.repeat(64), routing_mode:'model', run_id:'run.ui.tools', source_refs:[sourceRef], state:'succeeded',
    terminal_at:2, terminal_reason:'succeeded', tool_calls:[toolCall], usage:null, usage_state:'unknown'
  }
  assert.doesNotThrow(() => c.assertInteractionResponse({ ...h, ok:true, error:null, result }))
  assert.throws(() => c.assertInteractionResponse({ ...h, ok:true, error:null, result:{ ...result, tool_calls:[{ ...toolCall, result_digest:null }] } }), /ToolCallRecordV1|resultDigest/)
  const forbiddenArgs = { schemaVersion:1, sourceRefs:[{ ...sourceRef, sessionId:'C:\\secret' }] }
  assert.throws(() => c.assertInteractionResponse({ ...h, ok:true, error:null, result:{ ...result, tool_calls:[{ ...toolCall, args:forbiddenArgs, args_digest:sha256Canonical(forbiddenArgs) }] } }), /forbidden|source/i)
})

test('SEM-F34/J24: running tool records expose zeroed counts and tool-call order is validated as one sequence', () => {
  const running = {
    ...toolCall,
    ended_offset_ms: null,
    result: null,
    result_digest: null,
    source_refs: [],
    counts: { resultBytes: 0, sourceTextBytes: 0, sourceReferenceCount: 0 },
    status: 'started'
  }
  const result = {
    attempt_count: 1, created_at: 1, duration_ms: 0, error_code: null,
    interaction_id: 'interaction.ui.running',
    model: { adapter_id:'adapter.internal', model_id:'model.internal', profile_id:'profile.internal', profile_revision:1, provider_kind:'cloud' },
    recipe_id: 'qa.answer', recipe_version:'1', result: null, result_digest: null, routing_mode:'model',
    run_id: 'run.ui.running', source_refs: [], state:'running', terminal_at: null, terminal_reason: null,
    tool_calls: [running], usage: null, usage_state:'unknown'
  }
  assert.doesNotThrow(() => c.assertInteractionResponse({ ...h, ok:true, error:null, result }))
  const outOfOrder = { ...toolCall, call_id:'call.ui.3', call_order:3 }
  assert.throws(() => c.assertInteractionResponse({ ...h, ok:true, error:null, result: { ...result, tool_calls:[toolCall, outOfOrder] } }), /ToolCallSequenceV1|callOrder/)
})
