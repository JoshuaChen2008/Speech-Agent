'use strict'

/* Build the complete SEM-F20/J15a visual subgate report from strict observations. */

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
  candidateSha256,
  collectObservationFiles,
  combinationKey,
  parseMatrixArguments
} = require('./caption-visual-review-protocol')
const {
  validateCaptionVisualReviewObservation
} = require('./verify-caption-visual-review-report')
const {
  validateCaptionVisualReviewMatrix
} = require('./verify-caption-visual-review-matrix')

function sha256Bytes (bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function readObservationRecord (filePath) {
  const bytes = fs.readFileSync(filePath)
  const report = validateCaptionVisualReviewObservation(parseStrictEvidenceJson(
    bytes,
    `caption visual review observation ${path.basename(filePath)}`
  ))
  return { report, observationSha256: sha256Bytes(bytes) }
}

function buildCaptionVisualReviewMatrix (records) {
  assert.ok(Array.isArray(records), 'observation records must be an array')
  assert.equal(records.length, EXPECTED_COMBINATIONS.length,
    `matrix requires exactly ${EXPECTED_COMBINATIONS.length} observation records`)

  const byCombination = new Map()
  let matrixCandidate = null
  let provenance = null
  for (const [index, record] of records.entries()) {
    assert.ok(record !== null && typeof record === 'object' && !Array.isArray(record),
      `observation record ${index} must be an object`)
    assert.deepEqual(Object.keys(record).sort(), ['observationSha256', 'report'],
      `observation record ${index} has missing or unknown fields`)
    assert.match(record.observationSha256, /^[a-f0-9]{64}$/,
      `observation record ${index} must include a SHA-256 digest`)
    const report = validateCaptionVisualReviewObservation(record.report)
    const key = combinationKey(report.combination)
    assert.ok(!byCombination.has(key), `duplicate observation combination: ${key}`)
    if (matrixCandidate === null) {
      matrixCandidate = report.candidateSha256
      provenance = report.provenance
    } else {
      assert.equal(report.candidateSha256, matrixCandidate,
        'all observations must bind the same candidate provenance')
      assert.deepEqual(report.provenance, provenance,
        'all observations must contain the same provenance map')
    }
    byCombination.set(key, record)
  }

  assert.equal(matrixCandidate, candidateSha256(provenance),
    'matrix candidate must match the shared observation provenance')

  const observations = EXPECTED_COMBINATIONS.map((combination) => {
    const record = byCombination.get(combinationKey(combination))
    assert.ok(record, `missing observation combination: ${combinationKey(combination)}`)
    const { report, observationSha256 } = record
    return {
      candidateSha256: report.candidateSha256,
      combination: { ...report.combination },
      crossScaleMoveObserved: report.move.observed && report.move.acrossDifferentScaleFactors,
      displayCount: report.display.displayCount,
      distinctScaleFactorCount: report.display.distinctScaleFactorCount,
      fromScalePercent: report.move.fromScalePercent,
      observationSha256,
      toScalePercent: report.move.toScalePercent
    }
  })
  const crossScaleMoveObservationCount = observations
    .filter((entry) => entry.crossScaleMoveObserved)
    .length

  return validateCaptionVisualReviewMatrix({
    schemaVersion: 1,
    kind: 'caption-visual-review-matrix',
    result: 'pass',
    gateStatus: 'visual-subgate-complete',
    candidateSha256: matrixCandidate,
    provenance: { ...provenance },
    coverage: {
      expectedCombinationCount: EXPECTED_COMBINATIONS.length,
      observationCount: observations.length,
      uniqueCombinationCount: byCombination.size,
      scalePercentCount: SCALE_PERCENTS.length,
      themeCount: THEMES.length,
      backgroundCount: BACKGROUNDS.length,
      crossScaleMoveObservationCount,
      differentScaleFactorDualDisplayObserved: crossScaleMoveObservationCount > 0
    },
    observations,
    boundaries: {
      audioCapture: false,
      deviceNamesPersisted: false,
      fullSubtitleMvpAcceptance: false,
      localPathsPersisted: false,
      modelLoaded: false,
      networkAccess: false,
      textPersisted: false,
      visualSubgateOnly: true
    }
  })
}

function summarizeCaptionVisualReviewMatrix (options) {
  if (fs.existsSync(options.report)) throw new Error('matrix report already exists; refusing to overwrite it')
  const files = collectObservationFiles(options.observations)
  const report = buildCaptionVisualReviewMatrix(files.map(readObservationRecord))
  fs.mkdirSync(path.dirname(options.report), { recursive: true })
  fs.writeFileSync(options.report, JSON.stringify(report, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'wx'
  })
  return report
}

if (require.main === module) {
  const options = parseMatrixArguments(process.argv.slice(2))
  const report = summarizeCaptionVisualReviewMatrix(options)
  process.stdout.write(JSON.stringify({
    result: report.result,
    gateStatus: report.gateStatus,
    observationCount: report.coverage.observationCount,
    crossScaleMoveObservationCount: report.coverage.crossScaleMoveObservationCount
  }) + '\n')
}

module.exports = {
  buildCaptionVisualReviewMatrix,
  collectObservationFiles,
  readObservationRecord,
  summarizeCaptionVisualReviewMatrix
}
