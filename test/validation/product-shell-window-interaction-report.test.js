'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { computeProductPayloadIdentity } = require('../../src/main/services/product-payload-identity')
const {
  PRODUCT_SHELL_PACKAGING_KEYS,
  PRODUCT_SHELL_QUALIFICATION_KEYS,
  PRODUCT_SHELL_V3_JOURNEY_KEYS,
  PRODUCT_SHELL_V5_WINDOW_INTERACTION_KEYS,
  validateProductShellReport
} = require('../../scripts/verify-product-shell-report')

function v4Journey () {
  const journey = Object.fromEntries(PRODUCT_SHELL_V3_JOURNEY_KEYS.map((key) => [key, true]))
  return Object.assign(journey, {
    onboardingPreset: 'dictation',
    coreInitialState: 'missing',
    refinementInitialState: 'missing',
    refinementFetchAttemptCountBeforeExplicitDownload: 0,
    coreObservedStates: ['missing', 'downloading', 'verifying', 'ready'],
    coreReadyMarkerCount: 3,
    refinementReadyMarkerCountBeforeExplicitDownload: 0,
    refinementReadyMarkerCount: 0,
    terminalHistoryCount: 3,
    longHistorySegmentCount: 205,
    historyPageCount: 5,
    historyPageSize: 50,
    historyMaxTimelineNodes: 50,
    historyExportDialogCount: 5,
    historyOriginalExportFormats: ['txt', 'md', 'srt'],
    historyOriginalExportArtifactCount: 3,
    historyOriginalExportFullSegmentCount: 205,
    historyRefinedExportArtifactCount: 1,
    historyRawOriginalExportArtifactCount: 1,
    coreState: 'ready',
    refinementState: 'missing',
    resourceCount: 4,
    coreReadinessSource: 'settings-click-controlled-install',
    translationAdvertised: false
  })
}

function completeWindowInteraction () {
  const value = Object.fromEntries(PRODUCT_SHELL_V5_WINDOW_INTERACTION_KEYS.map((key) => [key, true]))
  return Object.assign(value, {
    layoutFallbackObservationCount: 4,
    layoutRecoveryObservationCount: 4,
    visibleCardDragPointCount: 2,
    gestureCancellationObservationCount: 6,
    normalTitlebarDragCount: 2,
    normalInteractiveExclusionCount: 2,
    normalBodyExclusionCount: 2,
    normalForegroundPromotionCount: 2
  })
}

function reportV5 () {
  const identity = computeProductPayloadIdentity()
  return {
    schemaVersion: 5,
    kind: 'product-shell-smoke',
    generatedAt: '2026-08-08T00:00:00.000Z',
    result: 'pass',
    gateStatus: 'partial',
    runtime: { electron: '43.0.0', node: '22.0.0', rendererCount: 4, crashEventCount: 0 },
    journey: v4Journey(),
    windowInteraction: completeWindowInteraction(),
    sourceIdentity: {
      productPayloadVersion: identity.version,
      productPayloadFileCount: identity.fileCount,
      productPayloadSha256: identity.sha256
    },
    privacy: {
      physicalAudioSourceOpened: false,
      audioPersisted: false,
      transcriptTextPersistedInReport: false,
      localPathsPersistedInReport: false
    },
    limitations: [
      'fake-asr-no-physical-audio',
      'controlled-model-fixtures-no-real-tensors',
      'deterministic-205-segment-fixture-not-two-hour-i3',
      'controlled-pointer-and-focus-no-human-dwm',
      'no-system-dpi-or-mixed-scale-qualification',
      'not-packaged-i4'
    ]
  }
}

function packagedReportV5 () {
  const report = reportV5()
  report.packaging = Object.fromEntries(PRODUCT_SHELL_PACKAGING_KEYS.map((key) => [key, false]))
  report.packaging.appIsPackaged = true
  report.qualification = Object.fromEntries(PRODUCT_SHELL_QUALIFICATION_KEYS.map((key) => [key, null]))
  Object.assign(report.qualification, {
    productPayloadVersion: report.sourceIdentity.productPayloadVersion,
    productPayloadFileCount: report.sourceIdentity.productPayloadFileCount,
    productPayloadSha256: report.sourceIdentity.productPayloadSha256
  })
  report.limitations = report.limitations
    .filter((limitation) => limitation !== 'not-packaged-i4')
    .concat('not-clean-machine-i4', 'packaged-test-variant-not-release-installer')
  return report
}

test('SEM-F22/J17: product-shell schema v5 accepts exact private window interaction evidence bound to current source', () => {
  const report = reportV5()
  assert.equal(validateProductShellReport(report), report)
})

test('SEM-F14/F22/J17: schema v5 rejects missing, unknown, false, out-of-range and stale candidate evidence', () => {
  const missing = structuredClone(reportV5())
  delete missing.windowInteraction.firstPointerDeltaObserved
  assert.throws(() => validateProductShellReport(missing), /window interaction/)

  const unknown = structuredClone(reportV5())
  unknown.windowInteraction.unexpected = true
  assert.throws(() => validateProductShellReport(unknown), /window interaction/)

  const falseClaim = structuredClone(reportV5())
  falseClaim.windowInteraction.focusLossDemotionObserved = false
  assert.throws(() => validateProductShellReport(falseClaim), /window interaction/)

  const fractional = structuredClone(reportV5())
  fractional.windowInteraction.normalTitlebarDragCount = 1.5
  assert.throws(() => validateProductShellReport(fractional), /window interaction/)

  const stale = structuredClone(reportV5())
  stale.sourceIdentity.productPayloadSha256 = '0'.repeat(64)
  assert.throws(() => validateProductShellReport(stale), /source identity/)
})

test('SEM-F14/J17: schema v5 rejects geometry, coordinates, device names, monotonic time, paths and subtitle text', () => {
  for (const [key, value] of [
    ['bounds', { width: 1 }],
    ['coordinates', [1, 2]],
    ['deviceName', 'forbidden'],
    ['absoluteMonotonicTime', 1],
    ['clockOffset', 1],
    ['localPath', 'C:\\forbidden'],
    ['captionText', 'forbidden']
  ]) {
    const report = reportV5()
    report.windowInteraction[key] = value
    assert.throws(() => validateProductShellReport(report), /window interaction|forbidden|leaked/)
  }
})

test('SEM-F14/J17: packaged schema v5 rejects unknown packaging and qualification fields', () => {
  const packagingLeak = packagedReportV5()
  packagingLeak.packaging.bounds = { width: 1 }
  assert.throws(() => validateProductShellReport(packagingLeak), /envelope/)

  const qualificationLeak = packagedReportV5()
  qualificationLeak.qualification.transcript = 'forbidden'
  assert.throws(() => validateProductShellReport(qualificationLeak), /envelope/)
})
