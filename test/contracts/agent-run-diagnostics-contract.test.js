'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const diagnosticContract = require('../../src/agent/contracts/agent-run-diagnostics')
const diagnosticsUI = require('../../src/agent/contracts/agent-run-diagnostics-ui')
const { DIAGNOSTIC_SCHEMA_VERSION, assertDiagnosticRecord } = diagnosticContract

function record (overrides = {}) {
  return {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    appVersion: '0.1.0',
    requestDigest: 'a'.repeat(64),
    runDigest: 'b'.repeat(64),
    attempt: 1,
    sequence: 1,
    phase: 'waiting_model',
    event: 'model_request_started',
    elapsedMs: 120,
    lastActivityAgeMs: 0,
    errorCode: null,
    budgetAxis: null,
    metrics: { actual: null, limit: null, unit: null },
    modelBindingDigest: null,
    planDigest: null,
    ...overrides
  }
}

test('SEM-F40/J30-DIAG: diagnostic record accepts only exact no-body metadata', () => {
  assert.equal(assertDiagnosticRecord(record()).event, 'model_request_started')
  assert.throws(() => assertDiagnosticRecord(record({ prompt: 'private marker' })), /exact keys/)
  assert.throws(() => assertDiagnosticRecord(record({ absolutePath: 'D:\\private\\file' })), /exact keys/)
  assert.throws(() => assertDiagnosticRecord(record({ event: 'provider_raw_event' })), /not registered/)
  assert.throws(() => assertDiagnosticRecord(record({ runDigest: 'private marker' })), /SHA-256 digest/)
  assert.throws(() => assertDiagnosticRecord(record({ elapsedMs: Number.POSITIVE_INFINITY })), /safe integer/)
})

test('SEM-F40/J30-DIAG: budget diagnostics preserve only registered axis and finite actual/limit metrics', () => {
  const value = record({
    event: 'budget_rejected',
    errorCode: 'AGENT_BUDGET_EXCEEDED',
    budgetAxis: 'maxWallClockMs',
    metrics: { actual: 180001, limit: 180000, unit: 'duration_ms' }
  })
  assert.equal(assertDiagnosticRecord(value).metrics.actual, 180001)
  assert.throws(() => assertDiagnosticRecord(record({
    event: 'budget_rejected', budgetAxis: 'subtitleText',
    metrics: { actual: 2, limit: 1, unit: 'count' }
  })), /not registered/)
  assert.throws(() => assertDiagnosticRecord(record({
    event: 'budget_rejected', errorCode: 'AGENT_BUDGET_EXCEEDED', budgetAxis: 'maxWallClockMs',
    metrics: { actual: 2, limit: 1, unit: 'count' }
  })), /does not match the registered budget axis/)
  assert.throws(() => assertDiagnosticRecord(record({
    metrics: { actual: 2, limit: 1, unit: 'count' }
  })), /known metrics without an axis/)
  assert.equal(assertDiagnosticRecord(record({
    event: 'budget_rejected', errorCode: 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED', budgetAxis: null,
    metrics: { actual: 15001, limit: 15000, unit: 'bytes' }
  })).metrics.actual, 15001)
  assert.throws(() => assertDiagnosticRecord(record({
    metrics: { actual: 2, limit: 1, unit: 'tokens' }
  })), /not registered/)
  assert.throws(() => assertDiagnosticRecord(record({
    metrics: { actual: 2, limit: null, unit: 'count' }
  })), /jointly known/)
  assert.throws(() => assertDiagnosticRecord(record({
    metrics: { actual: 2, limit: 1, unit: null }
  })), /required when actual and limit are known/)
})

test('SEM-F40/J30-DIAG: query and export schemas are exact, bounded, and contain only validated records', () => {
  const newer = record({ sequence: 2 })
  const older = record({ sequence: 1, event: 'accepted', phase: 'accepted' })
  const query = {
    contract_id: diagnosticsUI.CONTRACT_ID,
    contract_version: diagnosticsUI.CONTRACT_VERSION,
    request_id: 'request.summary.diagnostics',
    before_sequence: null,
    limit: 50
  }
  assert.equal(diagnosticsUI.assertQueryRequest(query).limit, 50)
  assert.throws(() => diagnosticsUI.assertQueryRequest({ ...query, file_path: 'D:\\private\\export.json' }), /exact keys/)
  assert.throws(() => diagnosticsUI.assertQueryRequest({ ...query, limit: 101 }), /page size limit/)
  const page = diagnosticsUI.assertQueryResponse({
    contract_id: diagnosticsUI.CONTRACT_ID,
    contract_version: diagnosticsUI.CONTRACT_VERSION,
    ok: true,
    error: null,
    result: { available: true, records: [newer, older], next_before_sequence: null }
  })
  assert.equal(page.result.records.length, 2)
  assert.throws(() => diagnosticsUI.assertQueryResponse({
    contract_id: diagnosticsUI.CONTRACT_ID,
    contract_version: diagnosticsUI.CONTRACT_VERSION,
    ok: true,
    error: null,
    result: { available: true, records: [older, newer], next_before_sequence: null }
  }), /descending sequence/)
  assert.equal(diagnosticContract.assertDiagnosticExportSnapshot({ schemaVersion: 1, available: true, records: [older, newer] }).records.length, 2)
  assert.throws(() => diagnosticContract.assertDiagnosticExportSnapshot({ schemaVersion: 1, available: true, records: [older, record({ sequence: 3, requestDigest: 'c'.repeat(64) })] }), /one request digest/)
  assert.throws(() => diagnosticContract.assertDiagnosticExportSnapshot({ schemaVersion: 1, available: true, records: [newer, older] }), /ascending sequence/)
  assert.throws(() => diagnosticContract.assertDiagnosticExportSnapshot({ schemaVersion: 1, available: true, records: [older], target_path: 'private' }), /exact keys/)
  assert.equal(diagnosticsUI.assertExportResponse({
    contract_id: diagnosticsUI.CONTRACT_ID,
    contract_version: diagnosticsUI.CONTRACT_VERSION,
    ok: true,
    error: null,
    result: { status: 'cancelled', record_count: 0, available: true }
  }).result.status, 'cancelled')
  assert.throws(() => diagnosticsUI.assertExportResponse({
    contract_id: diagnosticsUI.CONTRACT_ID,
    contract_version: diagnosticsUI.CONTRACT_VERSION,
    ok: true,
    error: null,
    result: { status: 'cancelled', record_count: 1, available: true }
  }), /zero when cancelled/)
})
