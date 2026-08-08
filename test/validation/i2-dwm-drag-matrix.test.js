'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const {
  DWM_COMBINATIONS,
  DWM_OBSERVATION_IDS,
  TRANSPORT_FIELDS,
  buildInteractionReport,
  completeDwmChecks,
  dwmOperatorCompletion,
  transportDelta
} = require('../../scripts/i2-interaction-protocol')
const {
  buildDwmMatrix,
  validateDwmMatrix,
  validateDwmMatrixCompanions
} = require('../../scripts/i2-dwm-drag-matrix')
const {
  PRODUCT_SHELL_V3_JOURNEY_KEYS,
  PRODUCT_SHELL_V5_WINDOW_INTERACTION_KEYS
} = require('../../scripts/verify-product-shell-report')
const { computeProductPayloadIdentity } = require('../../src/main/services/product-payload-identity')

const PRODUCT_IDENTITY = computeProductPayloadIdentity()

function digest (value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function transport (capturedFrames) {
  const value = Object.fromEntries(TRANSPORT_FIELDS.map((field) => [field, 0]))
  value.capturedFrames = capturedFrames
  value.sentFrames = capturedFrames
  value.ingestedFrames = capturedFrames
  value.acknowledgedFrames = capturedFrames
  return value
}

function productionReuse () {
  return {
    interactionController: true,
    windowLayerController: true,
    ipcAccessPolicy: true,
    windowRoles: ['caption', 'toolbar', 'settings', 'history'],
    preloadRoles: ['caption', 'toolbar', 'settings', 'history'],
    pageRoles: ['caption', 'toolbar', 'settings', 'history'],
    mainProcessManualBoundsUpdates: true
  }
}

function controllerCounts () {
  return {
    windowLoadCount: 4,
    toolbarLayoutReportCount: 3,
    captionDragStartCount: 5,
    captionMovedDragCount: 4,
    captionStationaryPressReleaseCount: 1,
    toolbarGripDragStartCount: 2,
    resizeStartCount: 8,
    settingsTitlebarDragStartCount: 1,
    historyTitlebarDragStartCount: 1,
    lockTransitionCount: 2,
    focusPromotionCount: 2,
    focusDemotionCount: 2
  }
}

function pairFor (combination, index) {
  const crossScaleObserved = index === 0
  const fromScalePercent = crossScaleObserved
    ? DWM_COMBINATIONS.find((entry) => entry.scalePercent !== combination.scalePercent).scalePercent
    : combination.scalePercent
  const runBindingSha256 = digest(`dwm-matrix-run-${index}`)
  const completion = dwmOperatorCompletion({
    confirmations: DWM_OBSERVATION_IDS,
    runBindingSha256,
    productPayloadVersion: PRODUCT_IDENTITY.version,
    productPayloadFileCount: PRODUCT_IDENTITY.fileCount,
    productPayloadSha256: PRODUCT_IDENTITY.sha256,
    combination,
    crossScaleObserved
  })
  const completionBytes = Buffer.from(JSON.stringify(completion, null, 2) + '\n')
  const before = transport(4)
  const after = transport(10)
  const scenarioEvidence = {
    mode: 'production-dwm-harness',
    rendererAssets: 'caption-toolbar-settings-history',
    manualSetBounds: true,
    runBindingSha256,
    operatorCompletionObserved: true,
    operatorCompletionSha256: digest(completionBytes),
    combination: { ...combination },
    checks: completeDwmChecks(),
    crossScale: {
      observed: crossScaleObserved,
      criticalHitMatrixRepeated: crossScaleObserved
    },
    productPayloadVersion: PRODUCT_IDENTITY.version,
    productPayloadFileCount: PRODUCT_IDENTITY.fileCount,
    productPayloadSha256: PRODUCT_IDENTITY.sha256,
    productionReuse: productionReuse(),
    automaticObservation: {
      actualScaleMatched: true,
      systemThemeMatched: true,
      rendererScaleMatched: true,
      displayCount: crossScaleObserved ? 2 : 1,
      distinctScaleFactorCount: crossScaleObserved ? 2 : 1,
      crossScaleMoveObserved: crossScaleObserved,
      fromScalePercent,
      toScalePercent: combination.scalePercent
    },
    controllerCounts: controllerCounts()
  }
  const report = buildInteractionReport({
    executedAt: `2026-08-08T00:00:${String(index).padStart(2, '0')}.000Z`,
    scenario: 'dwm-drag',
    sourceId: index % 2 === 0 ? 'loopback' : 'mic',
    result: 'pass-manual-observed',
    runtime: {
      modelId: 'x-asr-160ms',
      profile: 'fast',
      vad: 'silero',
      refinement: 'x-asr-offline',
      sqliteSessionRecorder: true
    },
    counts: { captions: 3, partials: 1, finals: 1, refined: 1 },
    scenarioEvidence,
    transport: {
      comparison: 'same-capture-generation',
      before,
      after,
      delta: transportDelta(before, after, true)
    },
    deviceRecovery: {
      simulatedTrackEnded: false,
      actualOsDeviceRemoval: false,
      actualSystemSleepWake: false,
      networkRecoveryNotApplicable: true
    }
  })
  return {
    reportBytes: Buffer.from(JSON.stringify(report, null, 2) + '\n'),
    completionBytes
  }
}

function j17Bytes () {
  const journey = Object.fromEntries(PRODUCT_SHELL_V3_JOURNEY_KEYS.map((key) => [key, true]))
  Object.assign(journey, {
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
  const windowInteraction = Object.fromEntries(
    PRODUCT_SHELL_V5_WINDOW_INTERACTION_KEYS.map((key) => [key, true])
  )
  Object.assign(windowInteraction, {
    layoutFallbackObservationCount: 4,
    layoutRecoveryObservationCount: 4,
    visibleCardDragPointCount: 2,
    gestureCancellationObservationCount: 6,
    normalTitlebarDragCount: 2,
    normalInteractiveExclusionCount: 2,
    normalBodyExclusionCount: 2,
    normalForegroundPromotionCount: 2
  })
  return Buffer.from(JSON.stringify({
    schemaVersion: 5,
    kind: 'product-shell-smoke',
    generatedAt: '2026-08-08T00:01:00.000Z',
    result: 'pass',
    gateStatus: 'partial',
    runtime: { electron: '43.0.0', node: '22.0.0', rendererCount: 4, crashEventCount: 0 },
    journey,
    windowInteraction,
    sourceIdentity: {
      productPayloadVersion: PRODUCT_IDENTITY.version,
      productPayloadFileCount: PRODUCT_IDENTITY.fileCount,
      productPayloadSha256: PRODUCT_IDENTITY.sha256
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
  }, null, 2) + '\n')
}

function matrixFixture () {
  const pairs = DWM_COMBINATIONS.map(pairFor)
  const j17ReportBytes = j17Bytes()
  const matrix = buildDwmMatrix({
    generatedAt: '2026-08-08T00:02:00.000Z',
    j17Bytes: j17ReportBytes,
    pairs
  })
  return { matrix, pairs, j17ReportBytes }
}

test('SEM-F22/J17/I2: strict DWM matrix binds all twelve scale/theme combinations and one current J17 report', () => {
  const fixture = matrixFixture()
  assert.equal(validateDwmMatrix(fixture.matrix), fixture.matrix)
  assert.equal(validateDwmMatrixCompanions(fixture.matrix, {
    j17Bytes: fixture.j17ReportBytes,
    pairs: [...fixture.pairs].reverse()
  }), fixture.matrix)
  assert.deepEqual(fixture.matrix.coverage, {
    combinationCount: 12,
    scalePercents: [100, 125, 150, 200],
    themes: ['dark', 'light', 'high-contrast'],
    crossScaleObservationCount: 1
  })
})

test('SEM-F22/I2: DWM matrix rejects missing, duplicate, reordered and completion-only combinations', () => {
  const fixture = matrixFixture()
  assert.throws(() => buildDwmMatrix({
    generatedAt: fixture.matrix.generatedAt,
    j17Bytes: fixture.j17ReportBytes,
    pairs: fixture.pairs.slice(0, 11)
  }), /exactly twelve/)
  assert.throws(() => buildDwmMatrix({
    generatedAt: fixture.matrix.generatedAt,
    j17Bytes: fixture.j17ReportBytes,
    pairs: [...fixture.pairs.slice(0, 11), fixture.pairs[0]]
  }), /duplicated/)

  const reordered = structuredClone(fixture.matrix)
  ;[reordered.entries[0], reordered.entries[1]] = [reordered.entries[1], reordered.entries[0]]
  assert.throws(() => validateDwmMatrix(reordered), /canonical order/)

  const completionOnlyReport = JSON.parse(fixture.pairs[0].reportBytes)
  completionOnlyReport.scenarioEvidence.operatorCompletionObserved = false
  completionOnlyReport.scenarioEvidence.operatorCompletionSha256 = null
  completionOnlyReport.scenarioEvidence.checks = null
  completionOnlyReport.scenarioEvidence.crossScale = null
  const completionOnlyPairs = [...fixture.pairs]
  completionOnlyPairs[0] = {
    ...completionOnlyPairs[0],
    reportBytes: Buffer.from(JSON.stringify(completionOnlyReport))
  }
  assert.throws(() => buildDwmMatrix({
    generatedAt: fixture.matrix.generatedAt,
    j17Bytes: fixture.j17ReportBytes,
    pairs: completionOnlyPairs
  }), /operatorCompletionObserved|true/)
})

test('SEM-F14/F22/I2: DWM matrix rejects stale binding, missing cross-scale coverage and sensitive or unknown fields', () => {
  const fixture = matrixFixture()
  const stale = structuredClone(fixture.matrix)
  stale.sourceIdentity.productPayloadSha256 = '0'.repeat(64)
  assert.throws(() => validateDwmMatrix(stale), /current candidate/)

  const noCrossScale = structuredClone(fixture.matrix)
  noCrossScale.entries[0].crossScaleObserved = false
  noCrossScale.coverage.crossScaleObservationCount = 0
  assert.throws(() => validateDwmMatrix(noCrossScale), /cross-scale/)

  const sensitive = structuredClone(fixture.matrix)
  sensitive.entries[0].geometry = { width: 1 }
  assert.throws(() => validateDwmMatrix(sensitive), /geometry|forbidden|unknown fields/)

  const unknown = structuredClone(fixture.matrix)
  unknown.coverage.unexpected = true
  assert.throws(() => validateDwmMatrix(unknown), /unknown fields/)
})

test('SEM-F22/J17: DWM matrix companion verification rejects another valid J17 run and raw completion mismatch', () => {
  const fixture = matrixFixture()
  const otherJ17 = JSON.parse(fixture.j17ReportBytes)
  otherJ17.generatedAt = '2026-08-08T00:01:01.000Z'
  assert.throws(() => validateDwmMatrixCompanions(fixture.matrix, {
    j17Bytes: Buffer.from(JSON.stringify(otherJ17)),
    pairs: fixture.pairs
  }), /does not match/)

  const mismatchedPairs = [...fixture.pairs]
  mismatchedPairs[0] = {
    ...mismatchedPairs[0],
    completionBytes: fixture.pairs[1].completionBytes
  }
  assert.throws(() => validateDwmMatrixCompanions(fixture.matrix, {
    j17Bytes: fixture.j17ReportBytes,
    pairs: mismatchedPairs
  }), /Expected values to be strictly equal|completion|binding/)
})

test('I2 DWM PowerShell entry requires an explicit combination and binds progress, completion and verifier inputs', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/run-i2-interaction.ps1'), 'utf8')
  assert.match(source, /ScalePercent=100\|125\|150\|200/)
  assert.match(source, /--scale-percent/)
  assert.match(source, /--theme/)
  assert.match(source, /complete-i2-dwm-drag\.js --progress/)
  assert.match(source, /--completion', \$completionPath/)
  assert.match(source, /all twelve combinations are required/)
})
