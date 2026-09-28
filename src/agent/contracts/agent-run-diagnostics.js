'use strict'

const sessionSummary = require('./session-summary-run-ui')
const { BUDGET_AXES } = require('./budget-axes')

const DIAGNOSTIC_SCHEMA_VERSION = 1
const DIAGNOSTIC_EVENTS = Object.freeze([
  'accepted', 'planning', 'planned', 'model_request_started', 'model_request_ended',
  'tool_started', 'tool_ended', 'backoff', 'cancel_requested', 'cancelled',
  'budget_rejected', 'terminal', 'recovery'
])
const METRIC_UNITS = Object.freeze(['bytes', 'count', 'duration_ms'])
const UNIT_BY_BUDGET_AXIS = Object.freeze({
  maxTurns: 'count',
  maxRequestInputTokens: 'count',
  maxCumulativeInputTokens: 'count',
  maxCumulativeOutputTokens: 'count',
  maxWallClockMs: 'duration_ms',
  maxToolCalls: 'count',
  toolTimeoutMs: 'duration_ms',
  maxParallelTools: 'count',
  maxToolResultBytes: 'bytes',
  maxSourceTextBytes: 'bytes'
})
const DIGEST = /^[a-f0-9]{64}$/
const APP_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+-]{0,63}$/

const RECORD_KEYS = Object.freeze([
  'schemaVersion', 'appVersion', 'requestDigest', 'runDigest', 'attempt', 'sequence',
  'phase', 'event', 'elapsedMs', 'lastActivityAgeMs', 'errorCode', 'budgetAxis',
  'metrics', 'modelBindingDigest', 'planDigest'
])
const EXPORT_KEYS = Object.freeze(['schemaVersion', 'available', 'records'])

function fail (path, reason) {
  throw new TypeError(`${path}: ${reason}`)
}

function exactObject (value, keys, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(path, 'must be a plain object')
  }
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(path, 'must contain exact keys')
  }
}

function nullableInteger (value, path) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) fail(path, 'must be null or a non-negative safe integer')
}

function nullableDigest (value, path) {
  if (value !== null && (typeof value !== 'string' || !DIGEST.test(value))) fail(path, 'must be null or a SHA-256 digest')
}

function assertDiagnosticMetrics (metrics) {
  exactObject(metrics, ['actual', 'limit', 'unit'], 'diagnostic.metrics')
  nullableInteger(metrics.actual, 'diagnostic.metrics.actual')
  nullableInteger(metrics.limit, 'diagnostic.metrics.limit')
  if ((metrics.actual === null) !== (metrics.limit === null)) fail('diagnostic.metrics', 'actual and limit must be jointly known')
  if (metrics.unit !== null && !METRIC_UNITS.includes(metrics.unit)) fail('diagnostic.metrics.unit', 'is not registered')
  if (metrics.actual === null && metrics.unit !== null) fail('diagnostic.metrics.unit', 'requires actual and limit')
  if (metrics.actual !== null && metrics.unit === null) fail('diagnostic.metrics.unit', 'is required when actual and limit are known')
  return metrics
}

function assertDiagnosticRecord (record) {
  exactObject(record, RECORD_KEYS, 'diagnostic')
  if (record.schemaVersion !== DIAGNOSTIC_SCHEMA_VERSION) fail('diagnostic.schemaVersion', 'is unsupported')
  if (typeof record.appVersion !== 'string' || !APP_VERSION.test(record.appVersion)) fail('diagnostic.appVersion', 'is invalid')
  nullableDigest(record.requestDigest, 'diagnostic.requestDigest')
  nullableDigest(record.runDigest, 'diagnostic.runDigest')
  if (!Number.isSafeInteger(record.attempt) || record.attempt < 0) fail('diagnostic.attempt', 'is invalid')
  if (!Number.isSafeInteger(record.sequence) || record.sequence < 1) fail('diagnostic.sequence', 'is invalid')
  if (!sessionSummary.PHASES.includes(record.phase)) fail('diagnostic.phase', 'is not registered')
  if (!DIAGNOSTIC_EVENTS.includes(record.event)) fail('diagnostic.event', 'is not registered')
  nullableInteger(record.elapsedMs, 'diagnostic.elapsedMs')
  nullableInteger(record.lastActivityAgeMs, 'diagnostic.lastActivityAgeMs')
  if (record.errorCode !== null && !sessionSummary.ERROR_CODES.includes(record.errorCode)) fail('diagnostic.errorCode', 'is not registered')
  if (record.budgetAxis !== null && !BUDGET_AXES.includes(record.budgetAxis)) fail('diagnostic.budgetAxis', 'is not registered')
  assertDiagnosticMetrics(record.metrics)
  if (record.metrics.actual !== null) {
    if (record.budgetAxis !== null && record.metrics.unit !== UNIT_BY_BUDGET_AXIS[record.budgetAxis]) {
      fail('diagnostic.metrics.unit', 'does not match the registered budget axis')
    }
    if (record.budgetAxis === null && (record.event !== 'budget_rejected' ||
        record.errorCode !== 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED' || record.metrics.unit !== 'bytes')) {
      fail('diagnostic.budgetAxis', 'known metrics without an axis require the v1 summary input compatibility preflight')
    }
  }
  nullableDigest(record.modelBindingDigest, 'diagnostic.modelBindingDigest')
  nullableDigest(record.planDigest, 'diagnostic.planDigest')
  return record
}

function assertDiagnosticExportSnapshot (snapshot) {
  exactObject(snapshot, EXPORT_KEYS, 'diagnosticExport')
  if (snapshot.schemaVersion !== DIAGNOSTIC_SCHEMA_VERSION) fail('diagnosticExport.schemaVersion', 'is unsupported')
  if (typeof snapshot.available !== 'boolean') fail('diagnosticExport.available', 'must be boolean')
  if (!Array.isArray(snapshot.records)) fail('diagnosticExport.records', 'must be an array')
  for (const [index, record] of snapshot.records.entries()) assertDiagnosticRecord(record)
  if (snapshot.records.some((record, index) => index > 0 && record.sequence <= snapshot.records[index - 1].sequence)) {
    fail('diagnosticExport.records', 'must be ordered by ascending sequence')
  }
  if (snapshot.records.length > 1) {
    const requestDigest = snapshot.records[0].requestDigest
    if (snapshot.records.some((record) => record.requestDigest !== requestDigest)) {
      fail('diagnosticExport.records', 'must belong to one request digest')
    }
  }
  return snapshot
}

module.exports = Object.freeze({
  DIAGNOSTIC_EVENTS,
  DIAGNOSTIC_SCHEMA_VERSION,
  EXPORT_KEYS,
  METRIC_UNITS,
  RECORD_KEYS,
  assertDiagnosticMetrics,
  assertDiagnosticExportSnapshot,
  assertDiagnosticRecord
})
