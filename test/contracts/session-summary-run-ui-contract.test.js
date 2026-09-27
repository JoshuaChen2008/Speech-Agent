'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const contract = require('../../src/agent/contracts/session-summary-run-ui')

const header = {
  contract_id: 'speech-agent.session-summary-run.ui',
  contract_version: '1.0.0'
}

test('SEM-F38/J30-ACCEPT: fixed summary action has no caller supplied prompt', () => {
  const request = {
    ...header,
    action: 'summary',
    scope: { kind: 'session', reference: 'session.p1' },
    client_request_key: 'request.p1.summary'
  }
  assert.equal(contract.assertAcceptRequest(request), request)
  assert.throws(() => contract.assertAcceptRequest({ ...request, summary_use_memory: false }), /exact/)
  assert.throws(() => contract.assertAcceptRequest({ ...request, prompt: 'override' }), /exact/)
})

test('SEM-F38/J30-ACCEPT: question action requires a bounded prompt and controls carry only request identity', () => {
  const request = {
    ...header,
    action: 'question',
    scope: { kind: 'session', reference: 'session.p1' },
    client_request_key: 'request.p1.question',
    prompt: 'What decisions were made?'
  }
  assert.equal(contract.assertAcceptRequest(request), request)
  assert.throws(() => contract.assertAcceptRequest({ ...request, recipe_id: 'summary.minutes' }), /exact/)
  assert.equal(contract.assertControlRequest({ ...header, request_id: 'request.p1.summary' }).request_id, 'request.p1.summary')
})

test('SEM-F38/J30-PROGRESS: snapshot rejects fabricated progress and non-finite ages', () => {
  const snapshot = {
    request_id: 'request.p1.summary',
    generation: 1,
    revision: 2,
    action: 'summary',
    state: 'running',
    phase: 'waiting_model',
    attempt: 1,
    elapsed_ms: 1250,
    last_activity_age_ms: null,
    validated_chunk_count: null,
    total_chunk_count: null,
    memory_state: 'not_read',
    error_code: null,
    budget: null,
    freshness: 'fresh',
    cancel_requested: false,
    diagnostics_available: true
  }
  assert.equal(contract.assertRequestSnapshot(snapshot), snapshot)
  assert.throws(() => contract.assertRequestSnapshot({ ...snapshot, progress_percent: 40 }), /exact/)
  assert.throws(() => contract.assertRequestSnapshot({ ...snapshot, last_activity_age_ms: Infinity }), /safe integer/)
})
