'use strict'

/*
 * Fail-closed verifier for the complete SEM-F20/J15a non-audio visual
 * subgate. A passing matrix is deliberately narrower than full subtitle MVP
 * acceptance: it proves only the frozen visible-DWM matrix.
 */

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { parseStrictEvidenceJson } = require('./strict-evidence-json')
const {
  BACKGROUNDS,
  EXPECTED_COMBINATIONS,
  SCALE_PERCENTS,
  THEMES,
  artifactPath,
  assertCombination,
  assertCurrentProvenance,
  assertExactKeys,
  assertPositiveInteger,
  assertSha256,
  candidateSha256,
  collectObservationFiles,
  combinationKey,
  inspectSafeEvidenceValue,
  parseMatrixArguments
} = require('./caption-visual-review-protocol')
const {
  validateCaptionVisualReviewObservation
} = require('./verify-caption-visual-review-report')

const MATRIX_ENTRY_KEYS = Object.freeze([
  'candidateSha256',
  'combination',
  'crossScaleMoveObserved',
  'displayCount',
  'distinctScaleFactorCount',
  'fromScalePercent',
  'observationSha256',
  'toScalePercent'
])

function validateMatrixEntry (entry, matrixCandidate, expectedCombination, index) {
  const label = `observations[${index}]`
  assertExactKeys(entry, MATRIX_ENTRY_KEYS, label)
  assertCombination(entry.combination, `${label}.combination`)
  assert.equal(combinationKey(entry.combination), combinationKey(expectedCombination),
    `${label}.combination is missing, duplicated, or out of canonical order`)
  assertSha256(entry.candidateSha256, `${label}.candidateSha256`)
  assert.equal(entry.candidateSha256, matrixCandidate,
    `${label}.candidateSha256 must match the matrix candidate`)
  assertSha256(entry.observationSha256, `${label}.observationSha256`)
  assertPositiveInteger(entry.displayCount, `${label}.displayCount`)
  assertPositiveInteger(entry.distinctScaleFactorCount, `${label}.distinctScaleFactorCount`)
  assert.ok(entry.distinctScaleFactorCount <= entry.displayCount,
    `${label}.distinctScaleFactorCount cannot exceed displayCount`)
  assertPositiveInteger(entry.fromScalePercent, `${label}.fromScalePercent`)
  assertPositiveInteger(entry.toScalePercent, `${label}.toScalePercent`)
  assert.equal(entry.toScalePercent, entry.combination.scalePercent,
    `${label}.toScalePercent must match its combination`)
  assert.equal(typeof entry.crossScaleMoveObserved, 'boolean',
    `${label}.crossScaleMoveObserved must be a boolean`)

  if (entry.crossScaleMoveObserved) {
    assert.ok(entry.displayCount >= 2, `${label} cross-scale movement requires at least two displays`)
    assert.ok(entry.distinctScaleFactorCount >= 2,
      `${label} cross-scale movement requires at least two distinct scale factors`)
    assert.notEqual(entry.fromScalePercent, entry.toScalePercent,
      `${label} cross-scale movement cannot repeat one scale factor`)
  } else {
    assert.equal(entry.fromScalePercent, entry.toScalePercent,
      `${label} without cross-scale movement must stay on one scale factor`)
  }
}

function validateCaptionVisualReviewMatrix (report) {
  inspectSafeEvidenceValue(report)
  assertExactKeys(report, [
    'boundaries', 'candidateSha256', 'coverage', 'gateStatus', 'kind',
    'observations', 'provenance', 'result', 'schemaVersion'
  ], 'caption visual review matrix')

  assert.equal(report.schemaVersion, 1)
  assert.equal(report.kind, 'caption-visual-review-matrix')
  assert.equal(report.result, 'pass')
  assert.equal(report.gateStatus, 'visual-subgate-complete')

  assertCurrentProvenance(report.provenance)
  assertSha256(report.candidateSha256, 'candidateSha256')
  assert.equal(report.candidateSha256, candidateSha256(report.provenance),
    'candidateSha256 must bind the exact current visual-review provenance')

  assert.ok(Array.isArray(report.observations), 'observations must be an array')
  assert.equal(report.observations.length, EXPECTED_COMBINATIONS.length,
    `matrix must contain exactly ${EXPECTED_COMBINATIONS.length} observations`)

  const observationHashes = new Set()
  let crossScaleMoveObservationCount = 0
  report.observations.forEach((entry, index) => {
    validateMatrixEntry(entry, report.candidateSha256, EXPECTED_COMBINATIONS[index], index)
    assert.ok(!observationHashes.has(entry.observationSha256),
      `observations[${index}].observationSha256 is duplicated`)
    observationHashes.add(entry.observationSha256)
    if (entry.crossScaleMoveObserved) crossScaleMoveObservationCount += 1
  })
  assert.ok(crossScaleMoveObservationCount >= 1,
    'matrix requires at least one visible move across displays with different scale factors')

  assertExactKeys(report.coverage, [
    'backgroundCount', 'crossScaleMoveObservationCount', 'differentScaleFactorDualDisplayObserved',
    'expectedCombinationCount', 'observationCount', 'scalePercentCount', 'themeCount',
    'uniqueCombinationCount'
  ], 'coverage')
  assert.deepEqual(report.coverage, {
    expectedCombinationCount: EXPECTED_COMBINATIONS.length,
    observationCount: EXPECTED_COMBINATIONS.length,
    uniqueCombinationCount: EXPECTED_COMBINATIONS.length,
    scalePercentCount: SCALE_PERCENTS.length,
    themeCount: THEMES.length,
    backgroundCount: BACKGROUNDS.length,
    crossScaleMoveObservationCount,
    differentScaleFactorDualDisplayObserved: true
  })

  assertExactKeys(report.boundaries, [
    'audioCapture', 'deviceNamesPersisted', 'fullSubtitleMvpAcceptance', 'localPathsPersisted',
    'modelLoaded', 'networkAccess', 'textPersisted', 'visualSubgateOnly'
  ], 'boundaries')
  assert.deepEqual(report.boundaries, {
    audioCapture: false,
    deviceNamesPersisted: false,
    fullSubtitleMvpAcceptance: false,
    localPathsPersisted: false,
    modelLoaded: false,
    networkAccess: false,
    textPersisted: false,
    visualSubgateOnly: true
  })

  return report
}

function sha256Bytes (bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function readOriginalObservationRecord (filePath) {
  const bytes = fs.readFileSync(filePath)
  return {
    report: validateCaptionVisualReviewObservation(parseStrictEvidenceJson(
      bytes,
      `caption visual review observation ${path.basename(filePath)}`
    )),
    observationSha256: sha256Bytes(bytes)
  }
}

function matrixEntryFromObservationRecord (record) {
  assertExactKeys(record, ['observationSha256', 'report'], 'original observation record')
  assertSha256(record.observationSha256, 'original observation record.observationSha256')
  const report = validateCaptionVisualReviewObservation(record.report)
  return {
    candidateSha256: report.candidateSha256,
    combination: { ...report.combination },
    crossScaleMoveObserved: report.move.observed && report.move.acrossDifferentScaleFactors,
    displayCount: report.display.displayCount,
    distinctScaleFactorCount: report.display.distinctScaleFactorCount,
    fromScalePercent: report.move.fromScalePercent,
    observationSha256: record.observationSha256,
    toScalePercent: report.move.toScalePercent
  }
}

function validateCaptionVisualReviewMatrixAgainstObservations (report, records) {
  validateCaptionVisualReviewMatrix(report)
  assert.ok(Array.isArray(records), 'original observation records must be an array')
  assert.equal(records.length, EXPECTED_COMBINATIONS.length,
    `matrix verification requires exactly ${EXPECTED_COMBINATIONS.length} original observation files`)

  const byCombination = new Map()
  for (const record of records) {
    const entry = matrixEntryFromObservationRecord(record)
    const key = combinationKey(entry.combination)
    assert.ok(!byCombination.has(key), `duplicate original observation combination: ${key}`)
    byCombination.set(key, entry)
  }

  report.observations.forEach((entry, index) => {
    const key = combinationKey(EXPECTED_COMBINATIONS[index])
    const original = byCombination.get(key)
    assert.ok(original, `missing original observation combination: ${key}`)
    assert.deepEqual(entry, original,
      `matrix observation summary does not match original observation: ${key}`)
  })
  return report
}

function readAndValidateCaptionVisualReviewMatrix (reportPath, observationsRoot) {
  const resolved = artifactPath(reportPath, 'matrix report', '.matrix.json')
  const observations = artifactPath(observationsRoot, 'original observations')
  const files = collectObservationFiles(observations)
  if (files.length !== EXPECTED_COMBINATIONS.length) {
    throw new Error(`matrix verification requires exactly ${EXPECTED_COMBINATIONS.length} original observation files`)
  }
  const report = parseStrictEvidenceJson(
    fs.readFileSync(resolved),
    `caption visual review matrix ${path.basename(resolved)}`
  )
  return validateCaptionVisualReviewMatrixAgainstObservations(
    report,
    files.map(readOriginalObservationRecord)
  )
}

if (require.main === module) {
  const options = parseMatrixArguments(process.argv.slice(2))
  const report = readAndValidateCaptionVisualReviewMatrix(options.report, options.observations)
  process.stdout.write(JSON.stringify({
    result: report.result,
    gateStatus: report.gateStatus,
    observationCount: report.coverage.observationCount,
    crossScaleMoveObservationCount: report.coverage.crossScaleMoveObservationCount
  }) + '\n')
}

module.exports = {
  MATRIX_ENTRY_KEYS,
  readAndValidateCaptionVisualReviewMatrix,
  validateCaptionVisualReviewMatrixAgainstObservations,
  validateCaptionVisualReviewMatrix
}
