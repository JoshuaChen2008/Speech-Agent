'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { fixture, waitFor, minutes, stageResponse } = require('./helpers/summary-quality-fixture')
const { providerResponse, toolRequest } = require('./provider-network-fixture')
const { publicSnapshot } = require('../../src/agent/formal-run/agent-operation-service')
const c = require('../../src/agent/contracts/session-summary-run-ui')
const { buildExportSnapshot } = require('../../src/agent/formal-run/agent-interaction-exporter')

function storedResult (f) {
  const row = f.database.prepare('SELECT result_json FROM formal_agent_interactions WHERE recipe_id=\'summary.minutes\'').get()
  return row.result_json === null ? null : JSON.parse(row.result_json)
}

test('SEM-F28/F38/F39/F40/J29/J30/J31: full source, fixed stages, corrected minutes and reload snapshot use real modules', async t => {
  let seenDraft = false
  const f = await fixture(t, { respond: ({ payload, database, sessionId }) => {
    const q = database.prepare('SELECT * FROM formal_agent_summary_quality').get()
    const frozen = JSON.parse(q.frozen_json)
    assert.equal(frozen.mode, 'whole'); assert.equal(q.summary_stage, payload.summaryPlan.stage)
    assert.deepEqual(payload.summaryPlan.source.parts.map(part => part.eventOrder), [1, 2])
    if (payload.summaryPlan.stage === 'drafting_minutes') {
      assert.equal(payload.summaryPlan.topicIndex.schemaVersion, 1)
      seenDraft = true
      const wrong = minutes(); wrong.topics[0].text = '周五发布，预算100。'
      return providerResponse(wrong, [], { prompt_tokens: 10, completion_tokens: 5 })
    }
    if (payload.summaryPlan.stage === 'verifying_sources') {
      assert.equal(payload.summaryPlan.draft.topics[0].text, '周五发布，预算100。')
      assert.equal(database.prepare('SELECT result_json FROM formal_agent_interactions').get().result_json, null)
    }
    return stageResponse(payload, sessionId)
  } })
  const row = await f.settled()
  assert.equal(row.state, 'succeeded', JSON.stringify(f.networkErrors)); assert.equal(seenDraft, true)
  assert.deepEqual(f.requests.map(body => JSON.parse(body.messages[1].content).summaryPlan.stage), ['organizing_topics', 'drafting_minutes', 'verifying_sources'])
  assert.deepEqual(f.requests.map(body => body.max_tokens), [16384, 65536, 65536])
  assert.ok(f.requests.every(body => body.thinking?.type !== 'enabled'))
  assert.equal(storedResult(f).topics[0].text.includes('撤销'), true)
  const reloaded = publicSnapshot(await f.gateway.getSessionSummaryRequest({ requestId: f.requestId }))
  c.assertRequestSnapshot(reloaded)
  assert.equal(reloaded.summary_stage, 'verifying_sources'); assert.equal(reloaded.node_role, 'whole')
  assert.deepEqual([...new Set(f.snapshots.map(snapshot => snapshot.summary_stage).filter(Boolean))], ['organizing_topics', 'drafting_minutes', 'verifying_sources'])
  const run = f.database.prepare('SELECT recipe_version,summary_quality_policy,summary_input_policy FROM formal_agent_runs').get()
  assert.deepEqual({ ...run }, { recipe_version: '3', summary_quality_policy: 'summary-quality@1', summary_input_policy: null })
  const plan = f.database.prepare('SELECT usage_known,input_tokens,output_tokens FROM formal_agent_run_input_plans').get()
  assert.deepEqual({ ...plan }, { usage_known: 1, input_tokens: 30, output_tokens: 15 })
  const detail = await f.gateway.getAgentInteraction({ interactionId: row.targetInteractionId })
  const exported = buildExportSnapshot(detail)
  assert.equal(exported.schema_version, 7)
  assert.equal(exported.model.request_strategy, 'openai-compatible@1')
  assert.equal(exported.summary_quality.mode, 'whole')
  assert.equal(exported.result.schemaVersion, 2)
  assert.equal(exported.summary_execution.total_loop_count, 3)
  assert.equal(exported.summary_execution.request_count, 3)
})

test('SEM-F39/F40/J31-BUDGET: every later stage uses the shared remaining output quota without changing frozen ceilings', async t => {
  const f = await fixture(t, { respond: ({ payload, count, sessionId }) => stageResponse(payload, sessionId,
    { prompt_tokens: 10, completion_tokens: [980000, 19990, 9][count - 1] }) })
  assert.equal((await f.settled()).state, 'succeeded')
  assert.deepEqual(f.requests.map(body => body.max_tokens), [16384, 20000, 10])
  const q = JSON.parse(f.database.prepare('SELECT frozen_json FROM formal_agent_summary_quality').get().frozen_json)
  assert.equal(q.stageOutputTokens.verifying_sources, 65536)
  assert.equal(f.database.prepare('SELECT output_tokens FROM formal_agent_run_input_plans').get().output_tokens, 999999)
})

test('SEM-F38/F39/F40/J30/J31: persisted stages reject skips and duplicate stage receipts do not consume another Loop', async t => {
  const f = await fixture(t, { respond: async ({ payload, count, database, gateway, sessionId }) => {
    if (count === 1) {
      const run = database.prepare('SELECT run_id,attempt_count,lease_owner,lease_expires_at FROM formal_agent_runs').get()
      const attemptIdentity = { runId: run.run_id, attempt: run.attempt_count, owner: run.lease_owner, leaseExpiresAt: run.lease_expires_at }
      const receipt = { action: 'stage', attemptIdentity, summaryStage: 'organizing_topics', nodeRole: 'whole', nodeIndex: 1, loopCount: 1 }
      await gateway.summaryInputPlan(receipt)
      assert.equal(database.prepare('SELECT total_loop_count FROM formal_agent_summary_quality').get().total_loop_count, 1)
      await assert.rejects(gateway.summaryInputPlan({ ...receipt, summaryStage: 'verifying_sources', loopCount: 3 }), { code: 'AGENT_REQUEST_INVALID' })
      await assert.rejects(gateway.summaryInputPlan({ ...receipt, summaryStage: 'drafting_minutes' }), { code: 'AGENT_REQUEST_INVALID' })
    }
    assert.equal(payload.summaryPlan.authorizedSourceRef.sessionId, sessionId)
    return stageResponse(payload, sessionId)
  } })
  assert.equal((await f.settled()).state, 'succeeded', JSON.stringify(f.networkErrors))
  assert.equal(f.database.prepare('SELECT total_loop_count FROM formal_agent_summary_quality').get().total_loop_count, 3)
})

test('SEM-F28/F39/F40/J31-BUDGET: tools and retries share the frozen actual request count across all stages', async t => {
  const f = await fixture(t, { respond: ({ body, payload, count, sessionId }) => {
    if (count === 1) return { ok: false, status: 429, headers: { get: name => name === 'retry-after' ? '0' : null }, text: async () => '{}' }
    if (body.messages.filter(message => message.role === 'tool').length < 2) return toolRequest('search_context', { schemaVersion: 1, aliasKeys: ['none'] }, `call.${count}`)
    return stageResponse(payload, sessionId)
  } })
  const row = await f.settled()
  assert.equal(row.state, 'failed'); assert.equal(row.errorCode, 'AGENT_BUDGET_EXCEEDED')
  assert.equal(f.requests.length, 9); assert.equal(storedResult(f), null)
  assert.equal(f.database.prepare('SELECT COUNT(*) AS n FROM formal_agent_model_request_reservations').get().n, 9)
})

test('SEM-F39/F40/J31-BUDGET: expanded thinking history is checked before a post-tool request reservation', async t => {
  const f = await fixture(t, { thinking: true, respond: () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{
    finish_reason: 'tool_calls', message: { content: null, reasoning_content: '私'.repeat(400000), tool_calls: [{ id: 'call.large', type: 'function',
      function: { name: 'search_context', arguments: JSON.stringify({ schemaVersion: 1, aliasKeys: ['none'] }) } }] }
  }] }) }) })
  const row = await f.settled()
  assert.equal(row.state, 'failed'); assert.equal(row.errorCode, 'AGENT_BUDGET_EXCEEDED')
  assert.equal(f.requests.length, 1); assert.equal(storedResult(f), null)
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_model_request_reservations').get().count, 1)
})

for (const delta of [-1, 0, 1]) {
  test(`SEM-F33/F40/J30-DIAG/J31-SIZE: new protocol response transport boundary ${delta >= 0 ? '+' : ''}${delta}`, async t => {
    const f = await fixture(t, { thinking: true, respond: async ({ payload, sessionId }) => {
      const response = stageResponse(payload, sessionId)
      if (payload.summaryPlan.stage !== 'verifying_sources') return response
      const text = await response.text()
      return { ...response, text: async () => text + ' '.repeat(4 * 1024 * 1024 + delta - Buffer.byteLength(text)) }
    } })
    const row = await f.settled()
    assert.equal(row.state, delta <= 0 ? 'succeeded' : 'failed')
    if (delta > 0) {
      assert.equal(row.outputValidation.reason, 'transport_size')
      assert.equal(row.outputValidation.actual, 4194305); assert.equal(row.outputValidation.limit, 4194304)
      assert.equal(storedResult(f), null)
    }
  })
}

test('SEM-F39/F40/J31-COVER/J31-REDUCE: Unicode and escaped source coverage survive odd binary merge promotion', async t => {
  const text = '回到议题😀，引用"与\\以及否定；'.repeat(3000)
  const f = await fixture(t, { texts: [text], capabilities: { maxInputTokens: 100000, maxOutputTokens: 81920,
    supportsToolCalling: true, supportsStructuredOutput: true, supportsStreaming: false, usageReporting: true } })
  const row = await f.settled()
  assert.equal(row.state, 'succeeded', JSON.stringify(row))
  const q = f.database.prepare('SELECT * FROM formal_agent_summary_quality').get()
  const plan = f.database.prepare('SELECT * FROM formal_agent_run_input_plans').get()
  const payloads = f.requests.map(body => JSON.parse(body.messages.find(message => message.role === 'user').content).summaryPlan)
  const leaves = payloads.filter(payload => payload.nodeRole === 'leaf' && payload.stage === 'organizing_topics')
  assert.ok(leaves.length > 2)
  assert.equal(leaves.flatMap(leaf => leaf.source.parts.map(part => part.text)).join(''), text)
  assert.ok(payloads.filter(payload => payload.nodeRole === 'merge').every(payload =>
    payload.source.kind === 'verified_chunks' && payload.source.parts.length >= 2 && payload.source.parts.length <= 4))
  assert.equal(q.loop_count, plan.node_count * 3); assert.equal(f.requests.length, plan.node_count * 3)
  assert.equal(JSON.parse(q.frozen_json).mode, 'chunked')
  assert.equal(publicSnapshot(row).summary_processing_mode, 'chunked')
})

test('SEM-F39/F40/J31-BUDGET: capacity preflight rejects before any provider reservation or partial result', async t => {
  const f = await fixture(t, { capabilities: { maxInputTokens: 20000, maxOutputTokens: 81920,
    supportsToolCalling: true, supportsStructuredOutput: true, supportsStreaming: false, usageReporting: true } })
  const row = await f.settled()
  assert.equal(row.state, 'failed'); assert.equal(row.errorCode, 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED')
  assert.equal(f.requests.length, 0)
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_model_request_reservations').get().count, 0)
  assert.equal(storedResult(f), null)
})

for (const stage of ['organizing_topics', 'verifying_sources']) {
  for (const delta of [-1, 0, 1]) {
    test(`SEM-F39/F40/J31-SIZE: ${stage} raw UTF-8 byte limit ${delta >= 0 ? '+' : ''}${delta} stays independent of Schema`, async t => {
      const f = await fixture(t, { respond: async ({ payload, database, sessionId }) => {
        const response = stageResponse(payload, sessionId)
        if (payload.summaryPlan.stage !== stage) return response
        const q = JSON.parse(database.prepare('SELECT frozen_json FROM formal_agent_summary_quality').get().frozen_json)
        const limit = stage === 'organizing_topics' ? q.intermediateBytes : q.finalBytes
        const body = JSON.parse(await response.text())
        const content = body.choices[0].message.content
        body.choices[0].message.content = content + ' '.repeat(limit + delta - Buffer.byteLength(content, 'utf8'))
        return { ...response, text: async () => JSON.stringify(body) }
      } })
      const row = await f.settled()
      assert.equal(row.state, delta <= 0 ? 'succeeded' : 'failed')
      if (delta > 0) {
        assert.equal(storedResult(f), null)
        assert.equal(row.outputValidation.reason, 'output_size')
        assert.equal(row.outputValidation.actual, row.outputValidation.limit + 1)
        assert.equal(f.requests.length, stage === 'organizing_topics' ? 1 : 3)
      }
    })
  }
}

test('SEM-F28/F33/F40/J31-BUDGET/J31-COMPAT: thinking tool replay is complete, usage stays unknown and thinking is never persisted', async t => {
  const thinking = 'PRIVATE_REASONING_SENTINEL_'.repeat(30000)
  const f = await fixture(t, { thinking: true, respond: ({ body, payload, count, sessionId }) => {
    assert.deepEqual(body.thinking, { type: 'enabled' }); assert.equal(body.reasoning_effort, 'high')
    if (count === 1) return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: {
      role: 'assistant', content: null, reasoning_content: thinking,
      tool_calls: [{ id: 'call.quality', type: 'function', function: { name: 'search_context', arguments: JSON.stringify({ schemaVersion: 1, aliasKeys: ['none'] }) } }]
    } }] }) }
    if (count === 2) {
      assert.equal(body.messages.find(message => message.role === 'assistant').reasoning_content, thinking)
      assert.equal(body.messages.at(-1).role, 'tool')
    } else assert.ok(body.messages.every(message => !Object.hasOwn(message, 'reasoning_content')))
    return stageResponse(payload, sessionId)
  } })
  const row = await f.settled()
  assert.equal(row.state, 'succeeded', JSON.stringify(row)); assert.equal(f.requests.length, 4, JSON.stringify({ errors: f.networkErrors,
    requests: f.requests.map(body => ({ stage: JSON.parse(body.messages[1].content).summaryPlan.stage, roles: body.messages.map(message => message.role) })),
    tools: f.database.prepare('SELECT status,error_code FROM formal_agent_tool_calls').all(),
    receipts: f.database.prepare('SELECT attempt,request_sequence FROM formal_agent_model_request_reservations').all() }))
  assert.equal(f.database.prepare('SELECT usage_known FROM formal_agent_run_input_plans').get().usage_known, 0)
  assert.equal(f.database.prepare('SELECT usage_json FROM formal_agent_interactions').get().usage_json, null)
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_tool_calls').get().count, 1)
  const tables = f.database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%agent%'").all()
  for (const { name } of tables) assert.equal(JSON.stringify(f.database.prepare(`SELECT * FROM ${name}`).all()).includes('PRIVATE_REASONING_SENTINEL'), false)
  f.database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  assert.equal(fs.readFileSync(f.databasePath).includes(Buffer.from('PRIVATE_REASONING_SENTINEL')), false)
})

for (const [kind, mutate, reason] of [
  ['JSON', () => '{', 'json'],
  ['Schema', value => ({ ...value, unexpected: true }), 'schema'],
  ['source', value => { value.topics[0].sourceRefs[0].throughEventOrder += 1; return value }, 'source_reference']
]) {
  test(`SEM-F28/F39/F40/SEM-T04/J30/J31: later ${kind} rejection commits no draft`, async t => {
    const f = await fixture(t, { respond: async ({ payload, sessionId }) => {
      const response = stageResponse(payload, sessionId)
      if (payload.summaryPlan.stage !== 'verifying_sources') return response
      const body = JSON.parse(await response.text())
      return providerResponse(mutate(JSON.parse(body.choices[0].message.content)))
    } })
    const row = await f.settled()
    assert.equal(row.state, 'failed'); assert.equal(row.errorCode, 'AGENT_OUTPUT_INVALID')
    assert.equal(row.outputValidation.reason, reason)
    assert.equal(storedResult(f), null); assert.equal(f.requests.length, 3)
  })
}

test('SEM-F38/F40/J30-CANCEL/J31: cancellation during verification rejects a late provider result and reload restores actual stage', async t => {
  let release; let entered = false
  const f = await fixture(t, { respond: ({ payload, sessionId }) => {
    if (payload.summaryPlan.stage !== 'verifying_sources') return stageResponse(payload, sessionId)
    entered = true
    return new Promise(resolve => { release = () => resolve(stageResponse(payload, sessionId)) })
  } })
  await waitFor(() => entered)
  const before = await f.operations.get({ contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION, request_id: f.requestId })
  assert.equal(before.result.snapshot.summary_stage, 'verifying_sources')
  const cancel = await f.operations.cancel({ contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION, request_id: f.requestId, generation: before.result.snapshot.generation })
  assert.equal(cancel.ok, true)
  const row = await f.settled(); assert.equal(row.state, 'cancelled')
  release(); await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(storedResult(f), null); assert.equal(f.requests.length, 3)
})
