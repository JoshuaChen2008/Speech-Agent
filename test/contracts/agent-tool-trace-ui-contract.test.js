'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  BUDGET_STATES,
  CONTRACT_ID,
  CONTRACT_VERSION,
  FIXTURE_SCENARIOS,
  INTERACTION_STATUSES,
  assertFixture,
  assertFixturePrivacy,
  assertSnapshot,
  isSupportedContract
} = require('../../src/agent/contracts/agent-tool-trace-ui')
const fixtures = require('../../src/agent/contracts/fixtures/agent-tool-trace-ui')
const unknownTool = require('../../src/agent/contracts/fixtures/agent-tool-trace-ui/v1.0.0/negative-unknown-tool.json')
const unknownStatus = require('../../src/agent/contracts/fixtures/agent-tool-trace-ui/v1.0.0/negative-unknown-status.json')

function clone (value) {
  return JSON.parse(JSON.stringify(value))
}

test('SEM-F34/J22/J24: renderer-facing tool trace is exact, bounded, and does not expose recipe controls', () => {
  assert.equal(CONTRACT_ID, 'speech-agent.agent-tool-trace.ui')
  assert.equal(CONTRACT_VERSION, '1.0.0')
  assert.deepEqual(INTERACTION_STATUSES, ['running', 'succeeded', 'failed', 'cancelled'])
  assert.deepEqual(BUDGET_STATES, ['within_budget', 'exhausted'])
  assert.equal(isSupportedContract(CONTRACT_ID, CONTRACT_VERSION), true)
  assert.equal(isSupportedContract(CONTRACT_ID, '1.0.1'), false)

  const snapshot = clone(fixtures.searchContextSucceeded.snapshot)
  assert.equal(assertSnapshot(snapshot), snapshot)
  assert.throws(() => assertSnapshot({ ...snapshot, recipeId: 'qa.answer' }), /exact keys/)
  assert.throws(() => assertSnapshot({ ...snapshot, maxTurns: 3 }), /exact keys/)
  assert.throws(() => assertSnapshot({ ...snapshot, toolGrants: ['search_context'] }), /exact keys/)
})

test('SEM-F34/J22/J24: all renderer preview fixtures are synthetic, preview-only, and not joint evidence', () => {
  const expectedScenarios = [
    'read_sources_succeeded',
    'retry_preserved',
    'running_call',
    'search_context_succeeded',
    'tool_args_invalid',
    'tool_budget_exceeded',
    'tool_cancelled',
    'tool_not_available_for_recipe',
    'tool_scope_denied',
    'tool_timeout'
  ]
  assert.deepEqual(Object.values(fixtures).map((fixture) => fixture.scenario).sort(), expectedScenarios)
  for (const fixture of Object.values(fixtures)) {
    assert.equal(fixture.contract_id, CONTRACT_ID)
    assert.equal(fixture.contract_version, CONTRACT_VERSION)
    assert.equal(fixture.preview_only, true)
    assert.equal(fixture.synthetic, true)
    assert.equal(fixture.j22_evidence, false)
    assert.equal(fixture.j24_evidence, false)
    assert.ok(FIXTURE_SCENARIOS.includes(fixture.scenario))
    assert.equal(assertFixture(fixture), fixture)
    assert.equal(Object.isFrozen(fixture), true)
  }
})

test('SEM-F34/J22/J24: unknown enums and private fixture fields fail closed', () => {
  assert.throws(() => assertFixture(unknownTool), /not registered/)
  assert.throws(() => assertFixture(unknownStatus), /not registered/)
  const badVersion = clone(fixtures.toolTimeout)
  badVersion.contract_version = '2.0.0'
  assert.throws(() => assertFixture(badVersion), /contract_version/)
  assert.throws(() => assertFixturePrivacy({ nested: { audioPath: 'synthetic-only' } }), /forbidden private field/)
  assert.throws(() => assertFixturePrivacy({ nested: { internalReasoning: 'synthetic-only' } }), /forbidden private field/)
})

test('SEM-F34/J22/J24: retry and cancellation projections preserve terminal order semantics', () => {
  const retry = fixtures.retryPreserved.snapshot
  assert.equal(retry.attemptCount, 2)
  assert.deepEqual(retry.toolCalls.map((call) => [call.attempt, call.callOrder]), [[1, 1], [2, 1]])
  assert.equal(fixtures.toolCancelled.snapshot.status, 'cancelled')
  assert.equal(fixtures.toolCancelled.snapshot.toolCalls[0].errorCode, 'TOOL_CANCELLED')
  const invalidCancelledRetry = clone(fixtures.toolCancelled.snapshot)
  invalidCancelledRetry.status = 'failed'
  invalidCancelledRetry.attemptCount = 2
  invalidCancelledRetry.toolCalls.push({
    ...clone(fixtures.toolNotAvailable.snapshot.toolCalls[0]),
    attempt: 2,
    callOrder: 1
  })
  assert.throws(() => assertSnapshot(invalidCancelledRetry), /retry must start a new completed attempt/)
})
