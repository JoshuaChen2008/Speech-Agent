'use strict'




const test = require('node:test')
const assert = require('node:assert/strict')

const {
  BUDGET_AXES,
  SUMMARY_MINUTES_V2_AXIS_SCOPES,
  SUMMARY_MINUTES_V2_BUDGET_POLICY,
  SUMMARY_MINUTES_V2_REQUEST_OUTPUT_TOKEN_TARGET,
  assertRecipeBudgetSnapshot,
  deriveBudget,
  deriveRecipeBudget,
  deriveRecipeRequestCapacity,
  deriveRecipeOutboundQuota,
  deriveSummaryMinutesV2OutboundQuota,
  deriveSummaryMinutesV2RequestCapacity,
  getBudgetPolicy
} = require('../../src/agent/contracts/budget-axes')

const capabilities = Object.freeze({ maxInputTokens: 64000, maxOutputTokens: 4096 })

test('SEM-F16/F31/J24-QA-BUDGET: qa.answer@2 widens input capacity while keeping every legacy budget axis', () => {
  for (const maxInputTokens of [4096, 8192, 12000, 64000, 256000]) {
    const caps = { maxInputTokens, maxOutputTokens: 81920 }
    const budget = deriveRecipeBudget(caps, 'qa.answer', '2', 'user')
    assert.deepEqual(budget, deriveRecipeBudget(caps, 'qa.answer', '1', 'user'))
    assert.equal(budget.maxWallClockMs, 60000)
    const capacity = deriveRecipeRequestCapacity({ recipeId: 'qa.answer', recipeVersion: '2', capabilities: caps, budget })
    assert.equal(capacity.promptByteLimit, Math.max(0, Math.min(maxInputTokens, 120000) - 8192))
    assert.equal(capacity.requestOutputTokens, 8000)
    const outbound = deriveRecipeOutboundQuota({ recipeId: 'qa.answer', recipeVersion: '2',
      capabilities: caps, budget, knownCumulativeOutputTokens: 7000 })
    assert.equal(outbound.requestOutputTokens, 1000)
    assert.equal(outbound.requestInputByteWindow, Math.min(maxInputTokens, 120000))
    assert.equal(deriveRecipeOutboundQuota({ recipeId: 'qa.answer', recipeVersion: '2',
      capabilities: caps, budget, knownCumulativeOutputTokens: null }).requestOutputTokens, 8000)
    assert.throws(() => deriveRecipeOutboundQuota({ recipeId: 'qa.answer', recipeVersion: '2',
      capabilities: caps, budget, knownCumulativeOutputTokens: 8000 }), { code: 'AGENT_BUDGET_EXCEEDED' })
    assert.throws(() => deriveRecipeRequestCapacity({ recipeId: 'qa.answer', recipeVersion: '1', capabilities: caps, budget }),
      { code: 'AGENT_REQUEST_INVALID' })
  }
})

test('SEM-F16/F31/F39/J24-QA-LONG: qa.answer@3 freezes run totals without changing qa.answer@1/@2', () => {
  const caps = { maxInputTokens: 200000, maxOutputTokens: 20000 }
  const budget = deriveRecipeBudget(caps, 'qa.answer', '3', 'user')
  assert.equal(budget.maxRequestInputTokens, 120000)
  assert.equal(budget.maxCumulativeInputTokens, 16000000)
  assert.equal(budget.maxCumulativeOutputTokens, 1000000)
  assert.equal(budget.maxWallClockMs, 3600000)
  assert.deepEqual(getBudgetPolicy('qa.answer', '3').axisScopes, SUMMARY_MINUTES_V2_AXIS_SCOPES)
  assert.deepEqual(deriveRecipeBudget(caps, 'qa.answer', '2', 'user'), deriveRecipeBudget(caps, 'qa.answer', '1', 'user'))
  assert.equal(deriveRecipeRequestCapacity({ recipeId: 'qa.answer', recipeVersion: '3', capabilities: caps, budget }).requestOutputTokens, 8192)
  assert.equal(deriveRecipeOutboundQuota({ recipeId: 'qa.answer', recipeVersion: '3', capabilities: caps, budget,
    knownCumulativeOutputTokens: 999000 }).requestOutputTokens, 1000)
  assert.throws(() => deriveRecipeOutboundQuota({ recipeId: 'qa.answer', recipeVersion: '3', capabilities: caps, budget,
    knownCumulativeOutputTokens: 1000000 }), { code: 'AGENT_BUDGET_EXCEEDED' })
})

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

test('SEM-F39/J31-SIZE: summary.minutes@2 request capacity derives the registered window and output quota', () => {
  assert.equal(SUMMARY_MINUTES_V2_REQUEST_OUTPUT_TOKEN_TARGET, 8192)
  const roomy = Object.freeze({ maxInputTokens: 128000, maxOutputTokens: 81920 })
  const v2Budget = deriveRecipeBudget(roomy, 'summary.minutes', '2', 'user')
  const capacity = deriveSummaryMinutesV2RequestCapacity({ capabilities: roomy, budget: v2Budget })
  assert.equal(Object.isFrozen(capacity), true)
  assert.equal(capacity.requestOutputTokens, 8192)
  assert.equal(capacity.promptByteLimit, 111808)
})

test('SEM-F39/J31-SIZE: the 86,914-byte acceptance window sits exactly between 95,106 and 95,105 input tokens', () => {
  const v2BudgetAt = (maxInputTokens) => deriveRecipeBudget(
    Object.freeze({ maxInputTokens, maxOutputTokens: 8192 }), 'summary.minutes', '2', 'user')
  const boundary = deriveSummaryMinutesV2RequestCapacity({
    capabilities: Object.freeze({ maxInputTokens: 95106, maxOutputTokens: 8192 }),
    budget: v2BudgetAt(95106)
  })
  assert.equal(boundary.promptByteLimit, 86914)
  assert.equal(boundary.promptByteLimit >= 86914, true)
  const below = deriveSummaryMinutesV2RequestCapacity({
    capabilities: Object.freeze({ maxInputTokens: 95105, maxOutputTokens: 8192 }),
    budget: v2BudgetAt(95105)
  })
  assert.equal(below.promptByteLimit, 86913)
  assert.equal(below.promptByteLimit < 86914, true)
})

test('SEM-F39/J31-SIZE: request output quota yields to model capability and known remaining run budget', () => {
  const smallOutput = Object.freeze({ maxInputTokens: 128000, maxOutputTokens: 4096 })
  assert.equal(deriveSummaryMinutesV2RequestCapacity({
    capabilities: smallOutput, budget: deriveRecipeBudget(smallOutput, 'summary.minutes', '2', 'user')
  }).requestOutputTokens, 4096)
  const roomy = Object.freeze({ maxInputTokens: 128000, maxOutputTokens: 81920 })
  assert.equal(deriveSummaryMinutesV2RequestCapacity({
    capabilities: roomy, budget: deriveRecipeBudget(roomy, 'summary.minutes', '2', 'user'),
    remainingCumulativeOutputTokens: 4000
  }).requestOutputTokens, 4000)
  assert.equal(deriveSummaryMinutesV2RequestCapacity({
    capabilities: roomy, budget: deriveRecipeBudget(roomy, 'summary.minutes', '2', 'user'),
    remainingCumulativeOutputTokens: null
  }).requestOutputTokens, 8192)
})

test('SEM-F39/J31-SIZE: request capacity derivation fails closed on missing or divergent inputs', () => {
  const roomy = Object.freeze({ maxInputTokens: 128000, maxOutputTokens: 81920 })
  const v2Budget = deriveRecipeBudget(roomy, 'summary.minutes', '2', 'user')
  assert.throws(() => deriveSummaryMinutesV2RequestCapacity({ budget: v2Budget }),
    (error) => error.code === 'AGENT_REQUEST_INVALID')
  assert.throws(() => deriveSummaryMinutesV2RequestCapacity({ capabilities: roomy }),
    (error) => error.code === 'AGENT_REQUEST_INVALID')
  assert.throws(() => deriveSummaryMinutesV2RequestCapacity({
    capabilities: roomy, budget: deriveRecipeBudget(roomy, 'summary.minutes', '1', 'user')
  }), (error) => error.code === 'AGENT_REQUEST_INVALID')
  const small = { maxInputTokens: 4096, maxOutputTokens: 81920 }
  assert.equal(deriveSummaryMinutesV2RequestCapacity({
    capabilities: small, budget: deriveRecipeBudget(small, 'summary.minutes', '2', 'user')
  }).promptByteLimit, 0)
})

test('SEM-F39/J31-SIZE: each outbound derives the output quota and serialized input window from one rule', () => {
  const roomy = Object.freeze({ maxInputTokens: 128000, maxOutputTokens: 81920 })
  const v2Budget = deriveRecipeBudget(roomy, 'summary.minutes', '2', 'user')
  const fresh = deriveSummaryMinutesV2OutboundQuota({
    capabilities: roomy, budget: v2Budget, knownCumulativeOutputTokens: 0
  })
  assert.equal(fresh.requestOutputTokens, 8192)
  assert.equal(fresh.requestInputByteWindow, 120000)
  const capabilityBound = deriveSummaryMinutesV2OutboundQuota({
    capabilities: { maxInputTokens: 128000, maxOutputTokens: 4096 },
    budget: deriveRecipeBudget({ maxInputTokens: 128000, maxOutputTokens: 4096 }, 'summary.minutes', '2', 'user'),
    knownCumulativeOutputTokens: 0
  })
  assert.equal(capabilityBound.requestOutputTokens, 4096)
  const remainingBound = deriveSummaryMinutesV2OutboundQuota({
    capabilities: roomy, budget: v2Budget, knownCumulativeOutputTokens: v2Budget.maxCumulativeOutputTokens - 4000
  })
  assert.equal(remainingBound.requestOutputTokens, 4000)
  const unknownUsage = deriveSummaryMinutesV2OutboundQuota({
    capabilities: roomy, budget: v2Budget, knownCumulativeOutputTokens: null
  })
  assert.equal(unknownUsage.requestOutputTokens, 8192, 'unknown usage must not be treated as zero consumption')
})

test('SEM-F39/J31-SIZE: an exhausted output balance rejects the next outbound with the budget code', () => {
  const roomy = Object.freeze({ maxInputTokens: 128000, maxOutputTokens: 81920 })
  const v2Budget = deriveRecipeBudget(roomy, 'summary.minutes', '2', 'user')
  assert.throws(() => deriveSummaryMinutesV2OutboundQuota({
    capabilities: roomy, budget: v2Budget, knownCumulativeOutputTokens: v2Budget.maxCumulativeOutputTokens
  }), (error) => error.code === 'AGENT_BUDGET_EXCEEDED')
  assert.throws(() => deriveSummaryMinutesV2OutboundQuota({
    capabilities: roomy, budget: v2Budget, knownCumulativeOutputTokens: v2Budget.maxCumulativeOutputTokens + 1
  }), (error) => error.code === 'AGENT_BUDGET_EXCEEDED')
})

test('SEM-F39/J31-SIZE: outbound derivation fails closed on divergent budgets and missing capabilities', () => {
  const roomy = Object.freeze({ maxInputTokens: 128000, maxOutputTokens: 81920 })
  const v2Budget = deriveRecipeBudget(roomy, 'summary.minutes', '2', 'user')
  assert.throws(() => deriveSummaryMinutesV2OutboundQuota({
    capabilities: roomy, budget: deriveRecipeBudget(roomy, 'summary.minutes', '1', 'user'), knownCumulativeOutputTokens: 0
  }), (error) => error.code === 'AGENT_REQUEST_INVALID')
  assert.throws(() => deriveSummaryMinutesV2OutboundQuota({
    capabilities: { maxInputTokens: 128000 }, budget: v2Budget, knownCumulativeOutputTokens: 0
  }), (error) => error.code === 'AGENT_REQUEST_INVALID')
  assert.throws(() => deriveSummaryMinutesV2OutboundQuota({
    capabilities: roomy, budget: v2Budget, knownCumulativeOutputTokens: -1
  }), (error) => error.code === 'AGENT_REQUEST_INVALID')
})
