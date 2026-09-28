'use strict'

const records = require('./agent-run-diagnostics')

const CONTRACT_ID = 'speech-agent.agent-run-diagnostics.ui'
const CONTRACT_VERSION = '1.0.0'
const IPC_CHANNELS = Object.freeze({
  query: 'session-summary-run:diagnostics-query',
  export: 'session-summary-run:diagnostics-export'
})
const ERROR_CODES = Object.freeze([
  'AGENT_DIAGNOSTICS_UNAVAILABLE', 'AGENT_DIAGNOSTIC_EXPORT_FAILED',
  'AGENT_REQUEST_INVALID', 'AGENT_RUN_UNAVAILABLE'
])
const EXPORT_STATUSES = Object.freeze(['saved', 'cancelled'])
const MAX_PAGE_SIZE = 100

function fail (path, reason) {
  throw new TypeError(`${path}: ${reason}`)
}

function exact (value, required, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(path, 'must be a plain object')
  }
  const actual = Object.keys(value).sort()
  const expected = [...required].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(path, 'must contain exact keys')
  }
}

function id (value, path) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,159}$/.test(value)) fail(path, 'must be a bounded identifier')
}

function integer (value, path, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(path, 'must be a safe integer')
}

function header (value) {
  if (value.contract_id !== CONTRACT_ID || value.contract_version !== CONTRACT_VERSION) {
    fail('request', 'unsupported contract version')
  }
}

function assertQueryRequest (request) {
  exact(request, ['contract_id', 'contract_version', 'request_id', 'before_sequence', 'limit'], 'request')
  header(request)
  id(request.request_id, 'request.request_id')
  if (request.before_sequence !== null) integer(request.before_sequence, 'request.before_sequence', 1)
  integer(request.limit, 'request.limit', 1)
  if (request.limit > MAX_PAGE_SIZE) fail('request.limit', 'exceeds the page size limit')
  return request
}

function assertExportRequest (request) {
  exact(request, ['contract_id', 'contract_version', 'request_id'], 'request')
  header(request)
  id(request.request_id, 'request.request_id')
  return request
}

function assertEnvelope (response, validateResult) {
  exact(response, ['contract_id', 'contract_version', 'ok', 'error', 'result'], 'response')
  if (response.contract_id !== CONTRACT_ID || response.contract_version !== CONTRACT_VERSION) fail('response', 'unsupported contract version')
  if (typeof response.ok !== 'boolean') fail('response.ok', 'must be boolean')
  if (response.ok) {
    if (response.error !== null) fail('response.error', 'must be null')
    validateResult(response.result)
  } else {
    if (response.result !== null) fail('response.result', 'must be null')
    exact(response.error, ['code', 'next_action'], 'response.error')
    if (!ERROR_CODES.includes(response.error.code)) fail('response.error.code', 'is not registered')
    if (response.error.next_action !== null && typeof response.error.next_action !== 'string') {
      fail('response.error.next_action', 'must be null or a string')
    }
  }
  return response
}

function assertQueryResult (result) {
  exact(result, ['available', 'records', 'next_before_sequence'], 'result')
  if (typeof result.available !== 'boolean') fail('result.available', 'must be boolean')
  if (!Array.isArray(result.records) || result.records.length > MAX_PAGE_SIZE) fail('result.records', 'must be a bounded array')
  for (const [index, record] of result.records.entries()) records.assertDiagnosticRecord(record)
  if (result.next_before_sequence !== null) integer(result.next_before_sequence, 'result.next_before_sequence', 1)
  const sequences = result.records.map((record) => record.sequence)
  if (sequences.some((value, index) => index > 0 && value >= sequences[index - 1])) {
    fail('result.records', 'must be ordered by descending sequence')
  }
  if (result.next_before_sequence !== null && (result.records.length === 0 ||
      result.next_before_sequence !== result.records[result.records.length - 1].sequence)) {
    fail('result.next_before_sequence', 'must equal the last sequence in the page')
  }
  return result
}

function assertQueryResponse (response) { return assertEnvelope(response, assertQueryResult) }

function assertExportResult (result) {
  exact(result, ['status', 'record_count', 'available'], 'result')
  if (!EXPORT_STATUSES.includes(result.status)) fail('result.status', 'is not registered')
  integer(result.record_count, 'result.record_count')
  if (typeof result.available !== 'boolean') fail('result.available', 'must be boolean')
  if (result.status === 'cancelled' && result.record_count !== 0) fail('result.record_count', 'must be zero when cancelled')
  return result
}

function assertExportResponse (response) { return assertEnvelope(response, assertExportResult) }

module.exports = Object.freeze({
  CONTRACT_ID,
  CONTRACT_VERSION,
  ERROR_CODES,
  EXPORT_STATUSES,
  IPC_CHANNELS,
  MAX_PAGE_SIZE,
  assertExportRequest,
  assertExportResponse,
  assertExportResult,
  assertQueryRequest,
  assertQueryResponse,
  assertQueryResult
})
