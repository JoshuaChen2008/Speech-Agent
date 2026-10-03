'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')
const { mergeGroupSizes, planSummaryInput } = require('../../src/agent/execution-host/summary-input-plan')

const binding = Object.freeze({
  capabilities: { maxInputTokens: 65536, maxOutputTokens: 4096 },
  budget: { maxRequestInputTokens: 65536 }
})

function source (events) {
  const inputWatermark = events.at(-1).eventOrder
  return {
    sourceKind: 'session', sessionId: 'session.j31.coverage', transcriptVersion: 'raw',
    inputWatermark,
    inputDigest: sha256Canonical({ sessionId: 'session.j31.coverage', transcriptVersion: 'raw', inputWatermark, events }),
    events
  }
}

test('SEM-F39/J31-COVERAGE: long multilingual raw segment splits on code points and reconstructs exactly', () => {
  const text = '决定 A。\n否定 B，改为 C 😀 e\u0301 "\\'.repeat(8000)
  const input = source([{ eventOrder: 7, segmentId: 'segment.one', text }])
  const plan = planSummaryInput(input, '总结会话', binding)
  assert.ok(plan.leaves.length > 1)
  assert.ok(plan.leaves.length <= 256)
  assert.ok(plan.nodeCount <= 384)
  const pieces = plan.leaves.flatMap((leaf) => {
    assert.ok(Buffer.byteLength(JSON.stringify(leaf.prompt), 'utf8') <= plan.promptLimit)
    return JSON.parse(leaf.prompt).summaryPlan.parts
  })
  assert.equal(pieces.map((part) => part.text).join(''), text)
  assert.deepEqual(pieces.map((part) => part.codePointStart),
    [0, ...pieces.slice(0, -1).map((part) => part.codePointEnd)])
  assert.equal(pieces.at(-1).codePointEnd, Array.from(text).length)
  assert.equal(planSummaryInput(input, '总结会话', binding).planDigest, plan.planDigest)
})

test('SEM-F39/J31-MERGE: fixed fan-in never produces a singleton trailing merge', () => {
  for (let count = 2; count <= 256; count += 1) {
    const sizes = mergeGroupSizes(count)
    assert.equal(sizes.reduce((sum, value) => sum + value, 0), count)
    assert.equal(sizes.every((value) => value >= 2 && value <= 4), true)
  }
  assert.deepEqual(mergeGroupSizes(5), [3, 2])
  assert.deepEqual(mergeGroupSizes(9), [4, 3, 2])
})

test('SEM-F39/J31-COVERAGE: empty and repeated-text segments keep distinct source order', () => {
  const events = [
    { eventOrder: 1, segmentId: 'segment.a', text: '重复' },
    { eventOrder: 3, segmentId: 'segment.empty', text: '' },
    { eventOrder: 7, segmentId: 'segment.b', text: '重复' }
  ]
  const plan = planSummaryInput(source(events), '总结会话', binding)
  const parts = plan.leaves.flatMap((leaf) => JSON.parse(leaf.prompt).summaryPlan.parts)
  assert.deepEqual(parts.map(({ eventOrder, segmentId, text }) => ({ eventOrder, segmentId, text })), events)
  assert.throws(() => planSummaryInput(source([events[0], events[0]]), '总结会话', binding),
    { code: 'AGENT_REQUEST_INVALID' })
})

test('SEM-F39/J31-SIZE: frozen input text and event-sequence bounds reject before planning nodes', () => {
  assert.throws(() => planSummaryInput(source([{
    eventOrder: 1, segmentId: 'over-limit', text: 'x'.repeat(4 * 1024 * 1024 + 1)
  }]), '总结', binding), { code: 'AGENT_BUDGET_EXCEEDED' })
  assert.throws(() => planSummaryInput(source([{
    eventOrder: 1, segmentId: 'segment.one', text: 'x'.repeat(20000)
  }]), '总结', {
    capabilities: { maxInputTokens: 16000, maxOutputTokens: 4096 },
    budget: { maxRequestInputTokens: 16000 }
  }), { code: 'AGENT_BUDGET_EXCEEDED' })
})


test('SEM-F39/SEM-T04/J31-MERGE: oversized or invalid intermediate results never reach merge', async () => {
  const { executeSummaryPlan } = require('../../src/agent/execution-host/summary-plan-executor')
  const input = source([{ eventOrder: 7, segmentId: 'long', text: 'x'.repeat(173827) }])
  for (const output of [
    { schemaVersion: 1, overview: 'x'.repeat(9000), conclusions: [], todos: [], risks: [] },
    { schemaVersion: 1, overview: 'synthetic', conclusions: [], todos: [], risks: [], unexpected: true }
  ]) {
    let calls = 0
    await assert.rejects(executeSummaryPlan({ input, plan: planSummaryInput(input, '总结', binding),
      invoke: async () => { calls++; return { text: JSON.stringify(output) } }, onProgress: async () => {} }),
    { code: 'AGENT_OUTPUT_INVALID' })
    assert.equal(calls, 1)
  }
})

test('SEM-F39/J31-RESOURCE: asynchronous planning yields and cancellation prevents model execution', async () => {
  const { planSummaryInputAsync } = require('../../src/agent/execution-host/summary-input-plan')
  const input = source([{ eventOrder: 1, segmentId: 'long', text: '😀'.repeat(100000) }])
  const controller = new AbortController()
  setImmediate(() => controller.abort())
  await assert.rejects(planSummaryInputAsync(input, '总结', binding, controller.signal), { code: 'AGENT_CANCELLED' })
})

test('SEM-F31/F39/J22-QA-LONG/J31: QA plans cover escaped Unicode and freeze question identity before execution', async () => {
  const { planQuestionInputAsync, assertQuestionPlanCoverage } = require('../../src/agent/execution-host/summary-input-plan')
  const input = source([{ eventOrder: 7, segmentId: 'qa.long', text: '初议与后文修订 😀 e\u0301 "\\\n'.repeat(7000) }])
  const first = await planQuestionInputAsync(input, '后来撤销了哪个决定？', binding)
  assert.equal(assertQuestionPlanCoverage(input, first), true)
  assert.ok(first.leaves.length > 1)
  assert.equal(first.policyVersion, 'qa-long-input@1')
  for (const leaf of first.leaves) {
    assert.equal(JSON.parse(leaf.prompt).userPrompt, '后来撤销了哪个决定？')
    assert.ok(Buffer.byteLength(JSON.stringify(leaf.prompt), 'utf8') <= first.promptLimit)
  }
  const retry = await planQuestionInputAsync(input, '后来撤销了哪个决定？', binding)
  assert.equal(retry.planDigest, first.planDigest)
  const changed = await planQuestionInputAsync(input, '后来保留了哪个决定？', binding)
  assert.notEqual(changed.planDigest, first.planDigest)
  const controller = new AbortController()
  setImmediate(() => controller.abort())
  await assert.rejects(planQuestionInputAsync(input, '问题', binding, controller.signal), { code: 'AGENT_CANCELLED' })
})

test('SEM-F31/F40/J24-QA-LONG: QA planning reports count limits without inventing token usage', async () => {
  const { planQuestionInputAsync } = require('../../src/agent/execution-host/summary-input-plan')
  const events = Array.from({ length: 50001 }, (_, index) => ({ eventOrder: index + 1, segmentId: `segment.${index}`, text: '合成' }))
  await assert.rejects(planQuestionInputAsync(source(events), '问题', binding), (error) => {
    assert.equal(error.code, 'AGENT_QA_INPUT_LIMIT_EXCEEDED')
    assert.deepEqual(error.diagnosticMetrics, { actual: 50001, limit: 50000, unit: 'count' })
    return true
  })
})
