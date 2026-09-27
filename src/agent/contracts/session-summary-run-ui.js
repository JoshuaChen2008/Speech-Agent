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
const ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/
const DIGEST = /^[a-f0-9]{64}$/
const ERROR_CODES = Object.freeze([
  'AGENT_RUN_UNAVAILABLE', 'AGENT_RUN_INVALID', 'AGENT_CANCELLED',
  'AGENT_PROVIDER_AUTH_FAILED', 'AGENT_PROVIDER_RATE_LIMITED', 'AGENT_PROVIDER_UNAVAILABLE',
  'AGENT_PROVIDER_TIMEOUT', 'AGENT_OUTPUT_INVALID', 'AGENT_PERMISSION_DENIED',
  'AGENT_REQUEST_INVALID', 'AGENT_WORKER_EXITED', 'AGENT_INTERNAL_FAILURE',
  'AGENT_BUDGET_EXCEEDED', 'AGENT_SUMMARY_MEMORY_READ_FAILED',
  'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED'
])

const IPC_CHANNELS = Object.freeze({
  accept: 'session-summary-run:accept',
  get: 'session-summary-run:get',
  cancel: 'session-summary-run:cancel',
  resume: 'session-summary-run:resume',
  changed: 'session-summary-run:changed',
  getDiagnostics: 'session-summary-run:get-diagnostics',
  exportDiagnostics: 'session-summary-run:export-diagnostics'
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
  exact(request, request.action === 'summary' ? required : [...required, 'prompt'], 'request')
  assertScope(request.scope)
  id(request.client_request_key, 'request.client_request_key')
  if (request.action === 'summary') {
    if (Object.hasOwn(request, 'prompt')) fail('request.prompt', 'is not accepted for a fixed summary action')
  } else {
    if (typeof request.prompt !== 'string' || request.prompt.length < 1 || request.prompt.length > 4096 ||
        /[\u0000-\u001f\u007f]/u.test(request.prompt)) fail('request.prompt', 'must be bounded question text')
  }
  return request
}

function assertControlRequest (request) {
  exact(request, ['contract_id', 'contract_version', 'request_id'], 'request')
  header(request)
  id(request.request_id, 'request.request_id')
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
    'memory_state', 'error_code', 'budget', 'freshness', 'cancel_requested', 'diagnostics_available'
  ], 'snapshot')
  id(snapshot.request_id, 'snapshot.request_id')
  integer(snapshot.generation, 'snapshot.generation', 1)
  integer(snapshot.revision, 'snapshot.revision')
  if (!ACTIONS.includes(snapshot.action)) fail('snapshot.action', 'is not registered')
  if (!STATES.includes(snapshot.state)) fail('snapshot.state', 'is not registered')
  if (!PHASES.includes(snapshot.phase)) fail('snapshot.phase', 'is not registered')
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
  if (typeof snapshot.diagnostics_available !== 'boolean') fail('snapshot.diagnostics_available', 'must be boolean')
  return snapshot
}

function assertAcceptResult (result) {
  exact(result, ['accepted', 'snapshot'], 'result')
  if (typeof result.accepted !== 'boolean') fail('result.accepted', 'must be boolean')
  assertRequestSnapshot(result.snapshot)
  return result
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
  STATES,
  assertAcceptRequest,
  assertAcceptResult,
  assertBudget,
  assertControlRequest,
  assertRequestSnapshot
}
