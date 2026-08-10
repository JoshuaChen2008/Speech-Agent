'use strict'

// @ts-check

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const {
  DWM_COMBINATIONS,
  DWM_SCALE_PERCENTS,
  DWM_THEMES,
  SOURCES,
  assertSafeInteractionValue,
  validateDwmCombination
} = require('./i2-interaction-protocol')
const {
  validateDwmCompanion,
  validateInteractionEvidence
} = require('./verify-i2-interaction-report')
const { validateProductShellReport } = require('./verify-product-shell-report')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')
const { computeProductPayloadIdentity } = require('../src/main/services/product-payload-identity')

const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const MATRIX_LIMITATIONS = Object.freeze([
  'This matrix binds twelve visible DWM scale/theme observations and one J17 product-shell report for the current candidate.',
  'It does not attest audio latency, long-duration stability, clean-machine installation, or release qualification.',
  'No captured audio, transcript text, device name, local path, geometry, coordinate, or absolute monotonic time is persisted in this evidence.'
])
const MATRIX_PRIVACY = Object.freeze({
  reportContainsTranscriptText: false,
  reportContainsAudioPath: false,
  reportContainsDeviceName: false,
  reportContainsLocalPaths: false,
  reportContainsGeometryOrCoordinates: false
})

function assertExactKeys (value, keys, label) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has missing or unknown fields`)
}

function assertSha256 (value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  assert.match(value, SHA256_PATTERN, `${label} must be lowercase SHA-256`)
}

function assertCanonicalIsoTimestamp (value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  assert.match(value, ISO_TIMESTAMP_PATTERN, `${label} must be canonical UTC ISO time`)
  const epoch = Date.parse(value)
  assert.ok(Number.isFinite(epoch) && new Date(epoch).toISOString() === value, `${label} must be valid ISO time`)
}

function sha256Bytes (bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function combinationKey (combination) {
  return `${combination.scalePercent}:${combination.theme}`
}

function validateSourceIdentity (value) {
  assertExactKeys(value, [
    'productPayloadVersion', 'productPayloadFileCount', 'productPayloadSha256'
  ], 'DWM matrix sourceIdentity')
  const current = computeProductPayloadIdentity()
  assert.equal(value.productPayloadVersion, current.version,
    'DWM matrix product payload version does not match the current candidate')
  assert.equal(value.productPayloadFileCount, current.fileCount,
    'DWM matrix product payload file count does not match the current candidate')
  assert.equal(value.productPayloadSha256, current.sha256,
    'DWM matrix product payload SHA-256 does not match the current candidate')
  assertSha256(value.productPayloadSha256, 'DWM matrix sourceIdentity.productPayloadSha256')
  return value
}

function validateDwmMatrix (value) {
  assertSafeInteractionValue(value)
  assertExactKeys(value, [
    'schemaVersion', 'kind', 'generatedAt', 'result', 'gateStatus', 'sourceIdentity',
    'j17', 'coverage', 'entries', 'privacy', 'limitations'
  ], 'DWM matrix')
  assert.ok([1, 2].includes(value.schemaVersion), 'DWM matrix schemaVersion must be 1 or 2')
  assert.equal(value.kind, 'i2-dwm-drag-matrix')
  assertCanonicalIsoTimestamp(value.generatedAt, 'DWM matrix.generatedAt')
  assert.equal(value.result, 'pass')
  assert.equal(value.gateStatus, 'dwm-drag-matrix-qualified')
  validateSourceIdentity(value.sourceIdentity)

  assertExactKeys(value.j17, ['schemaVersion', 'kind', 'result', 'reportSha256'], 'DWM matrix.j17')
  const expectedJ17SchemaVersion = value.schemaVersion >= 2 ? 8 : 7
  assert.equal(value.j17.schemaVersion, expectedJ17SchemaVersion,
    `DWM matrix must bind a schema-v${expectedJ17SchemaVersion} J17 product-shell report`)
  assert.equal(value.j17.kind, 'product-shell-smoke')
  assert.equal(value.j17.result, 'pass')
  assertSha256(value.j17.reportSha256, 'DWM matrix.j17.reportSha256')

  assertExactKeys(value.coverage, [
    'combinationCount', 'scalePercents', 'themes', 'crossScaleObservationCount'
  ], 'DWM matrix.coverage')
  assert.equal(value.coverage.combinationCount, DWM_COMBINATIONS.length)
  assert.deepEqual(value.coverage.scalePercents, [...DWM_SCALE_PERCENTS])
  assert.deepEqual(value.coverage.themes, [...DWM_THEMES])
  assert.ok(Number.isSafeInteger(value.coverage.crossScaleObservationCount) &&
    value.coverage.crossScaleObservationCount >= 1 &&
    value.coverage.crossScaleObservationCount <= DWM_COMBINATIONS.length,
  'DWM matrix requires at least one bounded cross-scale observation')

  assert.ok(Array.isArray(value.entries), 'DWM matrix.entries must be an array')
  assert.equal(value.entries.length, DWM_COMBINATIONS.length,
    'DWM matrix must contain exactly twelve combinations')
  const reportHashes = new Set()
  const completionHashes = new Set()
  const runBindings = new Set()
  let crossScaleObservationCount = 0
  value.entries.forEach((entry, index) => {
    assertExactKeys(entry, [
      'combination', 'sourceId', 'runBindingSha256', 'reportSha256',
      'operatorCompletionSha256', 'crossScaleObserved'
    ], `DWM matrix.entries[${index}]`)
    validateDwmCombination(entry.combination, `DWM matrix.entries[${index}].combination`)
    assert.deepEqual(entry.combination, DWM_COMBINATIONS[index],
      'DWM matrix combinations must be complete, unique and in canonical order')
    assert.ok(SOURCES.includes(entry.sourceId), `DWM matrix.entries[${index}].sourceId is invalid`)
    assertSha256(entry.runBindingSha256, `DWM matrix.entries[${index}].runBindingSha256`)
    assertSha256(entry.reportSha256, `DWM matrix.entries[${index}].reportSha256`)
    assertSha256(entry.operatorCompletionSha256,
      `DWM matrix.entries[${index}].operatorCompletionSha256`)
    assert.equal(typeof entry.crossScaleObserved, 'boolean')
    assert.equal(reportHashes.has(entry.reportSha256), false, 'DWM matrix report is duplicated')
    assert.equal(completionHashes.has(entry.operatorCompletionSha256), false,
      'DWM matrix operator completion is duplicated')
    assert.equal(runBindings.has(entry.runBindingSha256), false, 'DWM matrix run binding is duplicated')
    reportHashes.add(entry.reportSha256)
    completionHashes.add(entry.operatorCompletionSha256)
    runBindings.add(entry.runBindingSha256)
    if (entry.crossScaleObserved) crossScaleObservationCount += 1
  })
  assert.equal(value.coverage.crossScaleObservationCount, crossScaleObservationCount,
    'DWM matrix cross-scale coverage count does not match its entries')
  assert.deepEqual(value.privacy, MATRIX_PRIVACY)
  assert.deepEqual(value.limitations, [...MATRIX_LIMITATIONS])
  return value
}

function buildDwmMatrix ({ generatedAt = new Date().toISOString(), j17Bytes, pairs, schemaVersion = 2 }) {
  assert.ok([1, 2].includes(schemaVersion), 'DWM matrix build schemaVersion must be 1 or 2')
  assert.ok(Buffer.isBuffer(j17Bytes), 'J17 report bytes must be a Buffer')
  assert.ok(Array.isArray(pairs) && pairs.length === DWM_COMBINATIONS.length,
    'DWM matrix requires exactly twelve report/completion pairs')
  const j17 = validateProductShellReport(parseStrictEvidenceJson(j17Bytes, 'J17 product-shell report'))
  const expectedJ17SchemaVersion = schemaVersion >= 2 ? 8 : 7
  assert.equal(j17.schemaVersion, expectedJ17SchemaVersion,
    `DWM matrix requires a schema-v${expectedJ17SchemaVersion} J17 product-shell report`)

  const byCombination = new Map()
  const reportHashes = new Set()
  const completionHashes = new Set()
  const runBindings = new Set()
  for (const [index, pair] of pairs.entries()) {
    assertExactKeys(pair, ['reportBytes', 'completionBytes'], `DWM matrix pair[${index}]`)
    assert.ok(Buffer.isBuffer(pair.reportBytes), `DWM matrix pair[${index}].reportBytes must be a Buffer`)
    assert.ok(Buffer.isBuffer(pair.completionBytes), `DWM matrix pair[${index}].completionBytes must be a Buffer`)
    const report = validateInteractionEvidence(pair.reportBytes, 'dwm-drag')
    const expectedDwmSchemaVersion = schemaVersion >= 2 ? 6 : 5
    assert.equal(report.schemaVersion, expectedDwmSchemaVersion,
      `DWM matrix requires schema-v${expectedDwmSchemaVersion} DWM reports`)
    assert.equal(report.result, 'pass-manual-observed',
      'DWM matrix requires every DWM report to be manually observed')
    const completion = validateDwmCompanion(report, pair.completionBytes)
    const reportSha256 = sha256Bytes(pair.reportBytes)
    const operatorCompletionSha256 = sha256Bytes(pair.completionBytes)
    const runBindingSha256 = report.scenarioEvidence.runBindingSha256
    const key = combinationKey(report.scenarioEvidence.combination)
    assert.equal(byCombination.has(key), false, `DWM matrix combination is duplicated: ${key}`)
    assert.equal(reportHashes.has(reportSha256), false, 'DWM matrix report bytes are duplicated')
    assert.equal(completionHashes.has(operatorCompletionSha256), false,
      'DWM matrix completion bytes are duplicated')
    assert.equal(runBindings.has(runBindingSha256), false, 'DWM matrix run binding is duplicated')
    reportHashes.add(reportSha256)
    completionHashes.add(operatorCompletionSha256)
    runBindings.add(runBindingSha256)
    byCombination.set(key, {
      combination: { ...report.scenarioEvidence.combination },
      sourceId: report.sourceId,
      runBindingSha256,
      reportSha256,
      operatorCompletionSha256,
      crossScaleObserved: completion.crossScale.observed
    })
  }

  const entries = DWM_COMBINATIONS.map((combination) => {
    const entry = byCombination.get(combinationKey(combination))
    assert.ok(entry, `DWM matrix combination is missing: ${combinationKey(combination)}`)
    return entry
  })
  const identity = computeProductPayloadIdentity()
  const matrix = {
    schemaVersion,
    kind: 'i2-dwm-drag-matrix',
    generatedAt,
    result: 'pass',
    gateStatus: 'dwm-drag-matrix-qualified',
    sourceIdentity: {
      productPayloadVersion: identity.version,
      productPayloadFileCount: identity.fileCount,
      productPayloadSha256: identity.sha256
    },
    j17: {
      schemaVersion: j17.schemaVersion,
      kind: j17.kind,
      result: j17.result,
      reportSha256: sha256Bytes(j17Bytes)
    },
    coverage: {
      combinationCount: entries.length,
      scalePercents: [...DWM_SCALE_PERCENTS],
      themes: [...DWM_THEMES],
      crossScaleObservationCount: entries.filter((entry) => entry.crossScaleObserved).length
    },
    entries,
    privacy: { ...MATRIX_PRIVACY },
    limitations: [...MATRIX_LIMITATIONS]
  }
  return validateDwmMatrix(matrix)
}

function validateDwmMatrixCompanions (matrix, { j17Bytes, pairs }) {
  validateDwmMatrix(matrix)
  const rebuilt = buildDwmMatrix({
    generatedAt: matrix.generatedAt,
    j17Bytes,
    pairs,
    schemaVersion: matrix.schemaVersion
  })
  assert.deepEqual(matrix, rebuilt,
    'DWM matrix does not match the supplied J17 report and raw report/completion pairs')
  return matrix
}

function parseDwmMatrix (bytes) {
  return validateDwmMatrix(parseStrictEvidenceJson(bytes, 'I2 DWM drag matrix'))
}

module.exports = {
  MATRIX_LIMITATIONS,
  MATRIX_PRIVACY,
  buildDwmMatrix,
  parseDwmMatrix,
  sha256Bytes,
  validateDwmMatrix,
  validateDwmMatrixCompanions
}
