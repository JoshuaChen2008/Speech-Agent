'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const contract = require('../../src/agent/contracts/session-summary-run-ui')
const CHANNELS = require('../../src/main/ipc/channels')
const summaryAccepted = require('../../src/agent/contracts/fixtures/session-summary-run-ui/v1.0.0/summary-accepted.json')
const summaryChanged = require('../../src/agent/contracts/fixtures/session-summary-run-ui/v1.0.0/changed-summary.json')

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
  assert.equal(contract.assertCancelRequest({ ...header, request_id: 'request.p1.summary', generation: 1 }).generation, 1)
  assert.throws(() => contract.assertCancelRequest({ ...header, request_id: 'request.p1.summary' }), /exact/)
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
    resume_required: false,
    diagnostics_available: false,
    route_run_id: null,
    target_run_id: 'run.summary.target',
    interaction_id: 'interaction.summary.target',
    recipe_id: 'summary.minutes',
    routing_mode: 'preset'
  }
  assert.equal(contract.assertRequestSnapshot(snapshot), snapshot)
  assert.throws(() => contract.assertRequestSnapshot({ ...snapshot, progress_percent: 40 }), /exact/)
  assert.throws(() => contract.assertRequestSnapshot({ ...snapshot, last_activity_age_ms: Infinity }), /safe integer/)
})

test('SEM-F38/J30-ACCEPT: accepted result and response envelope are versioned and exact', () => {
  const snapshot = {
    request_id: 'request.p1.summary', generation: 1, revision: 0, action: 'summary',
    state: 'accepted', phase: 'accepted', attempt: 0, elapsed_ms: 0,
    last_activity_age_ms: null, validated_chunk_count: null, total_chunk_count: null,
    memory_state: 'not_read', error_code: null, budget: null, freshness: 'fresh',
    cancel_requested: false, resume_required: false, diagnostics_available: false,
    route_run_id: null, target_run_id: null, interaction_id: null, recipe_id: null, routing_mode: null
  }
  const response = {
    ...header,
    ok: true,
    error: null,
    result: { accepted: true, replayed: false, snapshot }
  }
  assert.equal(contract.assertAcceptResponse(response), response)
  assert.throws(() => contract.assertAcceptResponse({ ...response, internal_digest: 'x' }), /exact/)
  assert.throws(() => contract.assertAcceptResponse({ ...response, result: { ...response.result, snapshot: { ...snapshot, prompt: 'sensitive' } } }), /exact/)
})

test('SEM-F38/J30-ACCEPT: versioned fixtures bind the contract to main IPC channel names', () => {
  assert.equal(contract.assertAcceptRequest(summaryAccepted.request), summaryAccepted.request)
  assert.equal(contract.assertAcceptResponse(summaryAccepted.response), summaryAccepted.response)
  assert.equal(contract.assertChangedEvent(summaryChanged), summaryChanged)
  assert.deepEqual(contract.IPC_CHANNELS, {
    accept: CHANNELS.SESSION_SUMMARY_RUN_ACCEPT,
    get: CHANNELS.SESSION_SUMMARY_RUN_GET,
    cancel: CHANNELS.SESSION_SUMMARY_RUN_CANCEL,
    changed: CHANNELS.SESSION_SUMMARY_RUN_CHANGED
  })
  assert.equal(Object.hasOwn(contract, 'assertResumeRequest'), false)
})
