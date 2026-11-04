'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { validateRecipeOutput, assertSummaryTopicIndex } = require('../../src/agent/contracts/recipes')
const { FORMAL_AGENT_MIGRATIONS } = require('../../src/runtime/storage-worker/schema')
const { encodeExchangeRequest, normalizeExchangeResponse, limitsForStrategy } = require('../../src/agent/contracts/provider-exchange')

const minutes = () => ({ schemaVersion: 2, overview: '事项', topics: [{ topicId: 't1', title: '议题', text: '后来撤销原决定。', sourceRefs: [] }], conclusions: [], todos: [], risks: [] })
test('SEM-F38 J31 SummaryMinutesV2 rejects unknown fields and dangling topic identities', () => {
  assert.deepEqual(validateRecipeOutput('summary.minutes', '3', minutes()), minutes())
  assert.throws(() => validateRecipeOutput('summary.minutes', '3', { ...minutes(), extra: true }))
  assert.throws(() => validateRecipeOutput('summary.minutes', '3', { ...minutes(), conclusions: [{ text: '事项', topicId: 'missing', sourceRefs: [] }] }))
  assertSummaryTopicIndex({ schemaVersion: 1, topics: [{ topicId: 't1', title: '议题', sourceRefs: [] }] })
})
test('SEM-T08 DB1 summary quality migration appends after v32', () => {
  assert.equal(FORMAL_AGENT_MIGRATIONS.at(-1).version, 33)
  assert.match(FORMAL_AGENT_MIGRATIONS.at(-1).sql, /summary_quality/)
})

test('SEM-F28/F38/F40/J31-SIZE: public Unicode field and collection limits accept minus one and equal, and reject plus one', () => {
  const strings = [
    [4000, (v, text) => { v.overview = text }],
    [120, (v, text) => { v.topics[0].title = text }],
    [6000, (v, text) => { v.topics[0].text = text }],
    [1200, (v, text) => { v.conclusions = [{ text, topicId: 't1', sourceRefs: [] }] }],
    [1200, (v, text) => { v.risks = [{ text, topicId: 't1', sourceRefs: [] }] }],
    [1200, (v, text) => { v.todos = [{ text, topicId: 't1', sourceRefs: [], ownerHint: null, dueHint: null }] }],
    [128, (v, text) => { v.todos = [{ text: '事项', topicId: 't1', sourceRefs: [], ownerHint: text, dueHint: text }] }]
  ]
  for (const [limit, put] of strings) for (const delta of [-1, 0, 1]) {
    const value = minutes(); put(value, '中'.repeat(limit + delta - 1) + '😀')
    if (delta === 1) assert.throws(() => validateRecipeOutput('summary.minutes', '3', value))
    else assert.doesNotThrow(() => validateRecipeOutput('summary.minutes', '3', value))
  }
  for (const [field, limit] of [['topics', 64], ['conclusions', 128], ['risks', 128], ['todos', 256]]) for (const delta of [-1, 0, 1]) {
    const value = minutes()
    value[field] = Array.from({ length: limit + delta }, (_, i) => field === 'topics'
      ? { topicId: `t${i + 1}`, title: '议题', text: '事项', sourceRefs: [] }
      : { text: '事项', topicId: 't1', sourceRefs: [], ...(field === 'todos' ? { ownerHint: null, dueHint: null } : {}) })
    if (delta === 1) assert.throws(() => validateRecipeOutput('summary.minutes', '3', value))
    else assert.doesNotThrow(() => validateRecipeOutput('summary.minutes', '3', value))
  }
  for (const delta of [-1, 0, 1]) {
    const value = minutes()
    value.topics[0].sourceRefs = Array.from({ length: 8 + delta }, (_, i) => ({ sessionId: 'session.synthetic', transcriptVersion: 'raw', fromEventOrder: i + 1, throughEventOrder: i + 1 }))
    if (delta === 1) assert.throws(() => validateRecipeOutput('summary.minutes', '3', value))
    else assert.doesNotThrow(() => validateRecipeOutput('summary.minutes', '3', value))
  }
})
test('SEM-F33 J31 thinking protocol keeps the complete in-memory tool history', () => {
  const model = { modelId: 'deepseek-flash', capabilities: { maxOutputTokens: 65536, supportsStructuredOutput: true, supportsToolCalling: true } }
  const response = normalizeExchangeResponse({ choices: [{ finish_reason: 'tool_calls', message: { content: null, reasoning_content: '推理'.repeat(10000), tool_calls: [{ id: 'call1', type: 'function', function: { name: 'search_context', arguments: '{}' } }] } }] }, false, 'deepseek-openai@2')
  const limits = limitsForStrategy('deepseek-openai@2')
  const encoded = JSON.parse(encodeExchangeRequest({ resolvedModel: model, requestStrategy: 'deepseek-openai@2', request: { schemaVersion: 1,
    messages: [response.message], tools: [], outputContract: { mode: 'json' }, limits: { maxOutputTokens: 65536, maxRequestBytes: limits.maxRequestBytes, maxResponseBytes: limits.maxResponseBytes, timeoutMs: 600000, inputByteLimit: null, inputLimitError: 'AGENT_BUDGET_EXCEEDED' } } }))
  assert.equal(encoded.messages[0].reasoning_content, '推理'.repeat(10000))
  assert.deepEqual(encoded.thinking, { type: 'enabled' })
  assert.equal(encoded.reasoning_effort, 'high')
})
