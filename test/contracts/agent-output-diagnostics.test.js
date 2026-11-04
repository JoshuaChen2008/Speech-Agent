'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { validateRecipeOutput } = require('../../src/agent/contracts/recipes')
const { executeInputPlan } = require('../../src/agent/execution-host/summary-plan-executor')
const { executeQuestionEvidence } = require('../../src/agent/execution-host/question-evidence-executor')
const { assertOutputValidation, outputValidationFor } = require('../../src/agent/contracts/output-validation')

test('SEM-F40/J30-DIAG: summary validation preserves a body-free reason through the input plan', async () => {
  const output = { schemaVersion: 1, overview: 'PRIVATE_BODY\u0000second line', conclusions: [], todos: [], risks: [] }
  const expected = { reason: 'control_character', field: 'overview', actual: null, limit: null }
  assert.throws(() => validateRecipeOutput('summary.minutes', '2', output), error => {
    assert.deepEqual(error.outputValidation, expected)
    return true
  })
  await assert.rejects(executeInputPlan({ input: { sessionId: 'synthetic' },
    plan: { policyVersion: 'summary-long-input@1', promptLimit: 1000, leaves: [{ prompt: 'synthetic', fromEventOrder: 1, throughEventOrder: 1 }], levels: [] },
    invoke: async () => ({ text: JSON.stringify(output) }), onProgress: () => {} }), error => {
    assert.equal(error.code, 'AGENT_OUTPUT_INVALID')
    assert.deepEqual(error.outputValidation, expected)
    assert.equal(JSON.stringify(error).includes('PRIVATE_BODY'), false)
    return true
  })
})

test('SEM-F40/J30-DIAG: question evidence distinguishes JSON, schema and unauthorized sources', async () => {
  const valid = { schemaVersion: 2, answer: 'No evidence.', claims: [], sourceRefs: [], memoryRefs: [], unresolved: ['Unknown.'], coverage: null }
  for (const [text, reason, field] of [
    ['PRIVATE_INVALID_JSON', 'json', 'output'],
    [JSON.stringify({ ...valid, answer: 'private\u0000answer' }), 'control_character', 'answer'],
    [JSON.stringify({ ...valid, extra: 'PRIVATE_EXTRA_FIELD' }), 'schema', 'output'],
    [JSON.stringify({ ...valid, sourceRefs: [{ sessionId: 'private-session', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 2 }] }), 'source_reference', 'sourceRefs']
  ]) {
    await assert.rejects(executeQuestionEvidence({ evidence: { leaves: [{ prompt: 'synthetic', sourceRefs: [] }] },
      promptByteLimit: 1000, invoke: async () => ({ text }), validateMemoryRefs: () => {} }), error => {
      assert.equal(error.code, 'AGENT_OUTPUT_INVALID')
      assert.deepEqual(outputValidationFor(error), { reason, field, actual: null, limit: null })
      return true
    })
  }
})

test('SEM-F14/F40/J30-DIAG: diagnostics reject unregistered fields, body and raw exception details', () => {
  const valid = { reason: 'length', field: 'overview', actual: 2001, limit: 2000 }
  assert.equal(assertOutputValidation(valid), valid)
  for (const value of [{ ...valid, field: 'PRIVATE_TEXT' }, { ...valid, reason: 'PRIVATE_TEXT' },
    { ...valid, text: 'PRIVATE_TEXT' }, { ...valid, actual: -1 }, { ...valid, limit: null }]) {
    assert.throws(() => assertOutputValidation(value))
    assert.deepEqual(outputValidationFor({ outputValidation: value, message: 'PRIVATE_TEXT' }),
      { reason: 'unknown', field: 'output', actual: null, limit: null })
  }
})
