'use strict'

/* Strict verifier for one visible, non-audio SEM-F20/J15a DWM observation. */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { parseStrictEvidenceJson } = require('./strict-evidence-json')
const {
  OPERATOR_CHECKS,
  artifactPath,
  assertCombination,
  assertCurrentProvenance,
  assertExactKeys,
  assertPositiveInteger,
  assertSha256,
  candidateSha256,
  inspectSafeEvidenceValue
} = require('./caption-visual-review-protocol')

const GEOMETRY_CHECKS = Object.freeze([
  'boundsUnchangedAfterCaptionUpdates',
  'contentOverflowed',
  'newestLineVisible',
  'noHorizontalOverflow',
  'topClipIsWholeLines',
  'topOnlyClip',
  'viewportIsWholeLines'
])

function assertTrueFields (value, keys, label) {
  assertExactKeys(value, keys, label)
  for (const key of keys) assert.equal(value[key], true, `${label}.${key} must be true`)
}

function validateCaptionVisualReviewObservation (report) {
  inspectSafeEvidenceValue(report)
  assertExactKeys(report, [
    'boundaries', 'candidateSha256', 'combination', 'display', 'events', 'gateStatus',
    'geometry', 'kind', 'move', 'operator', 'provenance', 'result', 'schemaVersion', 'window'
  ], 'caption visual review observation')

  assert.equal(report.schemaVersion, 1)
  assert.equal(report.kind, 'caption-visual-review-observation')
  assert.equal(report.result, 'pass')
  assert.equal(report.gateStatus, 'partial', 'one observation must never claim the complete visual subgate')
  assertCombination(report.combination)

  assertCurrentProvenance(report.provenance)
  assertSha256(report.candidateSha256, 'candidateSha256')
  assert.equal(report.candidateSha256, candidateSha256(report.provenance),
    'candidateSha256 must bind the exact current provenance')

  assertExactKeys(report.display, [
    'browserZoomDefault', 'displayCount', 'distinctScaleFactorCount',
    'rendererDeviceScaleMatched', 'systemThemeMatched', 'targetScaleFactorMatched'
  ], 'display')
  assertPositiveInteger(report.display.displayCount, 'display.displayCount')
  assertPositiveInteger(report.display.distinctScaleFactorCount, 'display.distinctScaleFactorCount')
  assert.ok(report.display.distinctScaleFactorCount <= report.display.displayCount,
    'distinct scale-factor count cannot exceed display count')
  for (const key of [
    'browserZoomDefault', 'rendererDeviceScaleMatched', 'systemThemeMatched', 'targetScaleFactorMatched'
  ]) assert.equal(report.display[key], true, `display.${key} must be true`)

  assertExactKeys(report.move, [
    'acrossDifferentScaleFactors', 'fromScalePercent', 'observed', 'requested', 'toScalePercent'
  ], 'move')
  for (const key of ['requested', 'observed', 'acrossDifferentScaleFactors']) {
    assert.equal(typeof report.move[key], 'boolean', `move.${key} must be a boolean`)
  }
  assertPositiveInteger(report.move.fromScalePercent, 'move.fromScalePercent')
  assertPositiveInteger(report.move.toScalePercent, 'move.toScalePercent')
  assert.equal(report.move.toScalePercent, report.combination.scalePercent,
    'move.toScalePercent must match the observation combination')
  if (report.move.requested) {
    assert.equal(report.move.observed, true, 'a requested cross-scale move must be observed')
    assert.equal(report.move.acrossDifferentScaleFactors, true,
      'a requested move must cross different scale factors')
    assert.notEqual(report.move.fromScalePercent, report.move.toScalePercent,
      'cross-scale movement cannot repeat one scale factor')
    assert.ok(report.display.displayCount >= 2, 'cross-scale movement requires at least two displays')
    assert.ok(report.display.distinctScaleFactorCount >= 2,
      'cross-scale movement requires at least two distinct scale factors')
  } else {
    assert.equal(report.move.observed, false, 'an unrequested move cannot be reported as observed')
    assert.equal(report.move.acrossDifferentScaleFactors, false,
      'an unrequested move cannot claim different scale factors')
    assert.equal(report.move.fromScalePercent, report.move.toScalePercent,
      'an unrequested move must remain on the target scale factor')
  }

  assertTrueFields(report.geometry, GEOMETRY_CHECKS, 'geometry')

  assertExactKeys(report.window, ['focusable', 'frame', 'transparent', 'visible'], 'window')
  assert.equal(report.window.visible, true, 'the DWM observation window must be visible')
  assert.equal(report.window.transparent, true, 'the DWM observation window must be transparent')
  assert.equal(report.window.focusable, false, 'the caption observation must match the non-focusable product window')
  assert.equal(report.window.frame, false, 'the caption observation must match the frameless product window')

  assertExactKeys(report.events, [
    'captionEventCount', 'finalEventCount', 'partialEventCount', 'segmentCount', 'sourceCount'
  ], 'events')
  for (const [key, value] of Object.entries(report.events)) assertPositiveInteger(value, `events.${key}`)
  assert.equal(report.events.captionEventCount,
    report.events.finalEventCount + report.events.partialEventCount,
    'caption event count must equal final + partial')
  assert.equal(report.events.sourceCount, 1, 'synthetic observation must use one fixed source')

  assertExactKeys(report.operator, ['checks', 'observed'], 'operator')
  assert.equal(report.operator.observed, true, 'external operator completion is required')
  assertTrueFields(report.operator.checks, OPERATOR_CHECKS, 'operator.checks')

  assertExactKeys(report.boundaries, [
    'audioCapture', 'browserZoomUsed', 'deviceNamesPersisted', 'hiddenWindow', 'localPathsPersisted',
    'modelLoaded', 'networkAccess', 'physicalSourceOpened', 'syntheticCaptionEventsOnly', 'textPersisted'
  ], 'boundaries')
  assert.deepEqual(report.boundaries, {
    audioCapture: false,
    browserZoomUsed: false,
    deviceNamesPersisted: false,
    hiddenWindow: false,
    localPathsPersisted: false,
    modelLoaded: false,
    networkAccess: false,
    physicalSourceOpened: false,
    syntheticCaptionEventsOnly: true,
    textPersisted: false
  })

  return report
}

function readAndValidateCaptionVisualReviewObservation (reportPath) {
  const resolved = artifactPath(reportPath, 'observation report', '.observation.json')
  return validateCaptionVisualReviewObservation(parseStrictEvidenceJson(
    fs.readFileSync(resolved),
    `caption visual review observation ${path.basename(resolved)}`
  ))
}

if (require.main === module) {
  if (process.argv.length !== 3) {
    throw new Error('usage: node scripts/verify-caption-visual-review-report.js .artifacts/<run>/<case>.observation.json')
  }
  const report = readAndValidateCaptionVisualReviewObservation(process.argv[2])
  process.stdout.write(JSON.stringify({
    result: report.result,
    gateStatus: report.gateStatus,
    scalePercent: report.combination.scalePercent,
    theme: report.combination.theme,
    background: report.combination.background
  }) + '\n')
}

module.exports = {
  GEOMETRY_CHECKS,
  readAndValidateCaptionVisualReviewObservation,
  validateCaptionVisualReviewObservation
}
