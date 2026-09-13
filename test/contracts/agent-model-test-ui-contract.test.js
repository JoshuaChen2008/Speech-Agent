'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const contract = require('../../src/agent/contracts/agent-model-test-ui')

const header = { contractId: contract.CONTRACT_ID, contractVersion: contract.CONTRACT_VERSION }

test('SEM-F36/J25: model test contract freezes exact request, response, and next-action mapping', () => {
  const request = { ...header, profileId: 'deepseek', modelId: 'deepseek-v4-flash', expectedRevision: 3, testId: 'test.1' }
  assert.deepEqual(contract.assertTestRequest(request), request)
  assert.deepEqual(contract.assertCancelRequest({ ...header, testId: 'test.1' }), { ...header, testId: 'test.1' })
  for (const [status, nextAction] of Object.entries(contract.NEXT_ACTION_BY_STATUS)) {
    const response = { ...header, testId: 'test.1', ok: status === 'success', status, nextAction }
    assert.deepEqual(contract.assertTestResponse(response), response)
  }
})

test('SEM-F14/SEM-F36/J25: model test contract rejects extra fields, invalid ids, and inconsistent ok/status', () => {
  const request = { ...header, profileId: 'deepseek', modelId: 'model', expectedRevision: 0, testId: 'test.1' }
  assert.throws(() => contract.assertTestRequest({ ...request, prompt: 'subtitle text' }), /invalid/i)
  assert.throws(() => contract.assertTestRequest({ ...request, testId: 'bad id' }), /invalid/i)
  assert.throws(() => contract.assertTestResponse({ ...header, testId: 'test.1', ok: true, status: 'timeout', nextAction: 'retry' }), /invalid/i)
  assert.throws(() => contract.assertCancelRequest({ ...header, testId: 'test.1', runId: 'secret' }), /invalid/i)
})
