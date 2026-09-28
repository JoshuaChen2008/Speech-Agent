'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  BUDGET_AXES,
  SUMMARY_MINUTES_V2_AXIS_SCOPES,
  SUMMARY_MINUTES_V2_BUDGET_POLICY,
  assertRecipeBudgetSnapshot,
  deriveBudget,
  deriveRecipeBudget,
  getBudgetPolicy
} = require('../../src/agent/contracts/budget-axes')

const capabilities = Object.freeze({ maxInputTokens: 64000, maxOutputTokens: 4096 })

test('SEM-F16/J22/J24: budget maxTurns is taken from the recipe registration', () => {
  assert.equal(deriveBudget(capabilities, 1, [], 'user').maxTurns, 1)
  assert.equal(deriveBudget(capabilities, 3, ['search_context'], 'automatic').maxTurns, 3)
  assert.equal(deriveBudget(capabilities, 6, ['search_context', 'read_sources'], 'user').maxTurns, 6)
  assert.throws(() => deriveBudget(capabilities, 2, [], 'user'), /maxTurns|invalid/i)
  assert.throws(() => deriveBudget(capabilities, 3, ['search_context'], 'other'), /requestedBy/)
})

test('SEM-F39/J31-COMPAT: summary.minutes@2 has a frozen ten-axis scope and versioned snapshot', () => {
  const roomyCapabilities = Object.freeze({ maxInputTokens: 200000, maxOutputTokens: 1100000 })
  const v1 = deriveRecipeBudget(roomyCapabilities, 'summary.minutes', '1', 'user')
  const v2 = deriveRecipeBudget(roomyCapabilities, 'summary.minutes', '2', 'user')
  const otherV1 = deriveRecipeBudget(roomyCapabilities, 'qa.answer', '1', 'user')
  const baselineCapabilityV2 = deriveRecipeBudget(capabilities, 'summary.minutes', '2', 'user')

  assert.equal(getBudgetPolicy('summary.minutes', '2'), SUMMARY_MINUTES_V2_BUDGET_POLICY)
  assert.equal(SUMMARY_MINUTES_V2_BUDGET_POLICY.policyId, 'summary.minutes@2')
  assert.equal(Object.isFrozen(SUMMARY_MINUTES_V2_BUDGET_POLICY), true)
  assert.equal(Object.isFrozen(SUMMARY_MINUTES_V2_AXIS_SCOPES), true)
  assert.deepEqual(Object.keys(SUMMARY_MINUTES_V2_AXIS_SCOPES).sort(), [...BUDGET_AXES].sort())
  assert.deepEqual(SUMMARY_MINUTES_V2_AXIS_SCOPES, {
    maxTurns: 'agent_loop', maxRequestInputTokens: 'model_request',
    maxCumulativeInputTokens: 'run', maxCumulativeOutputTokens: 'run',
    maxWallClockMs: 'attempt', maxToolCalls: 'attempt', toolTimeoutMs: 'tool_call',
    maxParallelTools: 'attempt', maxToolResultBytes: 'attempt', maxSourceTextBytes: 'attempt'
  })
  assert.deepEqual(Object.keys(v2).sort(), [...BUDGET_AXES].sort())
  assert.equal(v1.maxRequestInputTokens, 120000)
  assert.equal(v1.maxCumulativeInputTokens, 120000)
  assert.equal(v1.maxCumulativeOutputTokens, 8000)
  assert.equal(v1.maxWallClockMs, 60000)
  assert.equal(v2.maxRequestInputTokens, 120000)
  assert.equal(v2.maxCumulativeInputTokens, 16000000)
  assert.equal(v2.maxCumulativeOutputTokens, 1000000)
  assert.equal(v2.maxWallClockMs, 3600000)
  assert.equal(baselineCapabilityV2.maxCumulativeOutputTokens, 1000000)
  assert.deepEqual(otherV1, v1)
  assert.equal(assertRecipeBudgetSnapshot('summary.minutes', '2', ['search_context'], v2), v2)
  assert.throws(() => assertRecipeBudgetSnapshot('summary.minutes', '2', ['search_context'], {
    ...v2,
    maxCumulativeOutputTokens: 4096
  }), /maxCumulativeOutputTokens diverges from policy/)
  assert.throws(() => assertRecipeBudgetSnapshot('summary.minutes', '2', ['search_context'], v1), /diverges from policy/)
  assert.throws(() => assertRecipeBudgetSnapshot('summary.minutes', '1', ['search_context'], v2), /diverges from policy/)
  assert.throws(() => getBudgetPolicy('summary.minutes', '3'), /AGENT_REQUEST_INVALID/)
})
