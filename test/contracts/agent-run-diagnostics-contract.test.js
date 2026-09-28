'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { DIAGNOSTIC_SCHEMA_VERSION, assertDiagnosticRecord } = require('../../src/agent/contracts/agent-run-diagnostics')

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
