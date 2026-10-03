'use strict'

const { BUDGET_AXES } = require('./budget-axes')

const CONTRACT_ID = 'speech-agent.session-summary-run.ui'
const CONTRACT_VERSION = '1.0.0'
const ACTIONS = Object.freeze(['summary', 'question'])
const STATES = Object.freeze([
  'accepted', 'preparing', 'routing', 'queued', 'running', 'retry_wait', 'cancelling',
  'succeeded', 'failed', 'cancelled'
])
const PHASES = Object.freeze([
  'accepted', 'preparing', 'waiting_model', 'reading_context', 'reducing',
  'validating', 'retry_wait', 'cancelling', 'terminal'
])
const MEMORY_STATES = Object.freeze(['not_read', 'not_used', 'empty', 'referenced', 'failed', 'unknown'])
const FRESHNESS_STATES = Object.freeze(['fresh', 'stale', 'unknown'])
const ROUTING_MODES = Object.freeze(['model', 'rules', 'preset'])
const ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/
const RECIPE_ID = /^[a-z][a-z0-9]*(?:\.[a-z0-9]+)+$/
const ERROR_CODES = Object.freeze([
  'AGENT_RUN_UNAVAILABLE', 'AGENT_RUN_INVALID', 'AGENT_CANCELLED',
  'AGENT_PROVIDER_AUTH_FAILED', 'AGENT_PROVIDER_RATE_LIMITED', 'AGENT_PROVIDER_UNAVAILABLE',
  'AGENT_PROVIDER_TIMEOUT', 'AGENT_OUTPUT_INVALID', 'AGENT_PERMISSION_DENIED',
  'AGENT_REQUEST_INVALID', 'AGENT_WORKER_EXITED', 'AGENT_INTERNAL_FAILURE',
  'AGENT_BUDGET_EXCEEDED', 'AGENT_SUMMARY_MEMORY_READ_FAILED',
  'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED', 'AGENT_QA_INPUT_LIMIT_EXCEEDED'
])

const IPC_CHANNELS = Object.freeze({
  accept: 'session-summary-run:accept',
  get: 'session-summary-run:get',
  cancel: 'session-summary-run:cancel',
  resume: 'session-summary-run:resume',
  listRecoverable: 'session-summary-run:list-recoverable',
  changed: 'session-summary-run:changed'
})

function fail (path, message) { throw new TypeError(`${path}: ${message}`) }

function plain (value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(path, 'must be a plain object')
  }
}

function exact (value, required, path, optional = []) {
  plain(value, path)
  const allowed = new Set([...required, ...optional])
  const actual = Object.keys(value)
  if (actual.some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key)) ||
      actual.length !== required.length + optional.filter((key) => Object.hasOwn(value, key)).length) {
    fail(path, 'must contain exact keys')
  }
}

function header (value) {
  if (value.contract_id !== CONTRACT_ID || value.contract_version !== CONTRACT_VERSION) {
    fail('request', 'unsupported contract version')
  }
}

function id (value, path) {
  if (typeof value !== 'string' || !ID.test(value)) fail(path, 'must be a bounded identifier')
}

function integer (value, path, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(path, 'must be a safe integer')
}

function assertScope (scope, path = 'request.scope') {
  exact(scope, ['kind', 'reference'], path)
  if (scope.kind !== 'session') fail(`${path}.kind`, 'must be session')
  id(scope.reference, `${path}.reference`)
  return scope
}

function assertAcceptRequest (request) {
  plain(request, 'request')
  header(request)
  if (!ACTIONS.includes(request.action)) fail('request.action', 'is not registered')
  const required = ['contract_id', 'contract_version', 'action', 'scope', 'client_request_key']
  exact(request, request.action === 'summary' ? required : [...required, 'prompt'], 'request',
    request.action === 'question' ? ['resubmits_request_id'] : [])
  assertScope(request.scope)
  id(request.client_request_key, 'request.client_request_key')
  if (request.action === 'summary') {
    if (Object.hasOwn(request, 'prompt')) fail('request.prompt', 'is not accepted for a fixed summary action')
  } else {
    if (typeof request.prompt !== 'string' || request.prompt.length < 1 || request.prompt.length > 4096 ||
        /[\u0000-\u001f\u007f]/u.test(request.prompt)) fail('request.prompt', 'must be bounded question text')
    if (request.resubmits_request_id !== undefined) id(request.resubmits_request_id, 'request.resubmits_request_id')
  }
  return request
}

function assertControlRequest (request) {
  exact(request, ['contract_id', 'contract_version', 'request_id'], 'request')
  header(request)
  id(request.request_id, 'request.request_id')
  return request
}

function assertListRecoverableRequest (request) {
  exact(request, ['contract_id', 'contract_version'], 'request')
  header(request)
  return request
}

function assertResumeRequest (request) {
  exact(request, ['contract_id', 'contract_version', 'request_id', 'generation', 'expected_revision'], 'request')
  header(request)
  id(request.request_id, 'request.request_id')
  integer(request.generation, 'request.generation', 1)
  integer(request.expected_revision, 'request.expected_revision')
  return request
}

function assertCancelRequest (request) {
  exact(request, ['contract_id', 'contract_version', 'generation', 'request_id'], 'request')
  header(request)
  id(request.request_id, 'request.request_id')
  integer(request.generation, 'request.generation', 1)
  return request
}

function assertBudget (value) {
  if (value === null) return value
  exact(value, ['axis', 'actual', 'limit'], 'snapshot.budget')
  if (!BUDGET_AXES.includes(value.axis)) fail('snapshot.budget.axis', 'is not registered')
  integer(value.actual, 'snapshot.budget.actual')
  integer(value.limit, 'snapshot.budget.limit')
  return value
}

function assertRequestSnapshot (snapshot) {
  exact(snapshot, [
    'request_id', 'generation', 'revision', 'action', 'state', 'phase', 'attempt',
    'elapsed_ms', 'last_activity_age_ms', 'validated_chunk_count', 'total_chunk_count',
    'memory_state', 'error_code', 'budget', 'freshness', 'cancel_requested', 'resume_required',
    'diagnostics_available', 'route_run_id', 'target_run_id', 'interaction_id', 'recipe_id', 'routing_mode'
  ], 'snapshot', ['retry'])
  id(snapshot.request_id, 'snapshot.request_id')
  integer(snapshot.generation, 'snapshot.generation', 1)
  integer(snapshot.revision, 'snapshot.revision')
  if (!ACTIONS.includes(snapshot.action)) fail('snapshot.action', 'is not registered')
  if (!STATES.includes(snapshot.state)) fail('snapshot.state', 'is not registered')
  if (!PHASES.includes(snapshot.phase)) fail('snapshot.phase', 'is not registered')
  if (snapshot.retry !== undefined && snapshot.retry !== null) {
    exact(snapshot.retry, ['request_attempt', 'wait_ms', 'reason'], 'snapshot.retry')
    integer(snapshot.retry.request_attempt, 'snapshot.retry.request_attempt', 2)
    if (snapshot.retry.request_attempt > 5) fail('snapshot.retry.request_attempt', 'exceeds policy')
    integer(snapshot.retry.wait_ms, 'snapshot.retry.wait_ms')
    if (snapshot.retry.wait_ms > 1000) fail('snapshot.retry.wait_ms', 'exceeds policy')
    if (!['AGENT_PROVIDER_RATE_LIMITED', 'AGENT_PROVIDER_UNAVAILABLE', 'AGENT_PROVIDER_TIMEOUT'].includes(snapshot.retry.reason)) {
      fail('snapshot.retry.reason', 'is not a retryable category')
    }
  }
  integer(snapshot.attempt, 'snapshot.attempt')
  integer(snapshot.elapsed_ms, 'snapshot.elapsed_ms')
  if (snapshot.last_activity_age_ms !== null) integer(snapshot.last_activity_age_ms, 'snapshot.last_activity_age_ms')
  for (const key of ['validated_chunk_count', 'total_chunk_count']) {
    if (snapshot[key] !== null) integer(snapshot[key], `snapshot.${key}`)
  }
  if ((snapshot.validated_chunk_count === null) !== (snapshot.total_chunk_count === null) ||
      snapshot.validated_chunk_count !== null && snapshot.validated_chunk_count > snapshot.total_chunk_count) {
    fail('snapshot.chunk_counts', 'are inconsistent')
  }
  if (!MEMORY_STATES.includes(snapshot.memory_state)) fail('snapshot.memory_state', 'is not registered')
  if (snapshot.error_code !== null && !ERROR_CODES.includes(snapshot.error_code)) fail('snapshot.error_code', 'is not registered')
  assertBudget(snapshot.budget)
  if (!FRESHNESS_STATES.includes(snapshot.freshness)) fail('snapshot.freshness', 'is not registered')
  if (typeof snapshot.cancel_requested !== 'boolean') fail('snapshot.cancel_requested', 'must be boolean')
  if (typeof snapshot.resume_required !== 'boolean') fail('snapshot.resume_required', 'must be boolean')
  if (typeof snapshot.diagnostics_available !== 'boolean') fail('snapshot.diagnostics_available', 'must be boolean')
  for (const key of ['route_run_id', 'target_run_id', 'interaction_id']) {
    if (snapshot[key] !== null) id(snapshot[key], `snapshot.${key}`)
  }
  if (snapshot.recipe_id !== null && (typeof snapshot.recipe_id !== 'string' || !RECIPE_ID.test(snapshot.recipe_id))) {
    fail('snapshot.recipe_id', 'must be null or a registered recipe identity')
  }
  if (snapshot.routing_mode !== null && !ROUTING_MODES.includes(snapshot.routing_mode)) fail('snapshot.routing_mode', 'is not registered')
  return snapshot
}

function assertAcceptResult (result) {
  exact(result, ['accepted', 'replayed', 'snapshot'], 'result')
  if (typeof result.accepted !== 'boolean') fail('result.accepted', 'must be boolean')
  if (typeof result.replayed !== 'boolean') fail('result.replayed', 'must be boolean')
  assertRequestSnapshot(result.snapshot)
  return result
}

function assertPublicError (error) {
  exact(error, ['code', 'next_action'], 'response.error')
  if (!ERROR_CODES.includes(error.code)) fail('response.error.code', 'is not registered')
  if (error.next_action !== null && typeof error.next_action !== 'string') fail('response.error.next_action', 'must be null or a string')
  return error
}

function assertEnvelope (response, resultValidator) {
  exact(response, ['contract_id', 'contract_version', 'ok', 'error', 'result'], 'response')
  if (response.contract_id !== CONTRACT_ID || response.contract_version !== CONTRACT_VERSION) fail('response', 'unsupported contract version')
  if (typeof response.ok !== 'boolean') fail('response.ok', 'must be boolean')
  if (response.ok) {
    if (response.error !== null) fail('response.error', 'must be null')
    resultValidator(response.result)
  } else {
    if (response.result !== null) fail('response.result', 'must be null for a failed response')
    assertPublicError(response.error)
  }
  return response
}

function assertAcceptResponse (response) { return assertEnvelope(response, assertAcceptResult) }
function assertSnapshotResult (result) {
  exact(result, ['snapshot'], 'result')
  assertRequestSnapshot(result.snapshot)
  return result
}
function assertGetResponse (response) { return assertEnvelope(response, assertSnapshotResult) }
function assertCancelResponse (response) { return assertEnvelope(response, assertSnapshotResult) }
function assertResumeResponse (response) { return assertEnvelope(response, assertSnapshotResult) }
function assertListRecoverableResult (result) {
  exact(result, ['requests'], 'result')
  if (!Array.isArray(result.requests) || result.requests.length > 100) fail('result.requests', 'must be a bounded array')
  for (const [index, item] of result.requests.entries()) {
    exact(item, ['scope', 'snapshot'], `result.requests[${index}]`)
    assertScope(item.scope, `result.requests[${index}].scope`)
    assertRequestSnapshot(item.snapshot)
  }
  return result
}
function assertListRecoverableResponse (response) { return assertEnvelope(response, assertListRecoverableResult) }
function assertChangedEvent (event) {
  exact(event, ['contract_id', 'contract_version', 'request_id', 'generation', 'revision'], 'event')
  header(event)
  id(event.request_id, 'event.request_id')
  integer(event.generation, 'event.generation', 1)
  integer(event.revision, 'event.revision')
  return event
}

module.exports = {
  ACTIONS,
  CONTRACT_ID,
  CONTRACT_VERSION,
  ERROR_CODES,
  FRESHNESS_STATES,
  IPC_CHANNELS,
  MEMORY_STATES,
  PHASES,
  ROUTING_MODES,
  STATES,
  assertAcceptRequest,
  assertAcceptResponse,
  assertAcceptResult,
  assertBudget,
  assertCancelRequest,
  assertCancelResponse,
  assertChangedEvent,
  assertControlRequest,
  assertGetResponse,
  assertListRecoverableRequest,
  assertListRecoverableResponse,
  assertListRecoverableResult,
  assertResumeRequest,
  assertResumeResponse,
  assertRequestSnapshot
}
