'use strict'

// @ts-check

const fs = require('node:fs')
const path = require('node:path')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')
const { computeProductPayloadIdentity } = require('../src/main/services/product-payload-identity')

const PRODUCT_SHELL_V2_JOURNEY_KEYS = Object.freeze([
  'onboardingPreset',
  'coreInstallClicked',
  'coreInitialState',
  'refinementInitialState',
  'refinementPreferenceInitiallyDisabled',
  'refinementPreferenceRejectedWhileMissing',
  'refinementFetchAttemptCountBeforeExplicitDownload',
  'coreObservedStates',
  'coreRangeResumeObserved',
  'coreReadyMarkerCount',
  'refinementReadyMarkerCountBeforeExplicitDownload',
  'coreHotActivation',
  'refinementContinueRangeObserved',
  'refinementExplicitDownloadReady',
  'refinementReadyMarkerCount',
  'refinementPreferenceStillDisabledAfterDownload',
  'refinementPreferenceExplicitlyEnabled',
  'rawSessionFrozenOriginal',
  'futureSessionFrozenRefinementEnabled',
  'refinementFaultSilentDuringSession',
  'postSessionRefinementNoticeShown',
  'refinementNoticeClearedByHistory',
  'historyRefinementFaultVisible',
  'startListeningStop',
  'pauseResume',
  'finalCaptionRendered',
  'visibleCaptionMatchesFinal',
  'captionFontApplied',
  'downloadedModelSessionInHistory',
  'terminalHistoryCount',
  'legacyJsonlMigrated',
  'legacySessionVisible',
  'legacySourceReadOnly',
  'longHistorySegmentCount',
  'historyPageCount',
  'historyPageSize',
  'historyMaxTimelineNodes',
  'historyReachedEnd',
  'historyBackForwardNavigation',
  'historyAriaRangeAligned',
  'historyVersionStartsOriginal',
  'historyRefinedVersionSelected',
  'historyRefinedVersionPersistsAcrossPaging',
  'historyRefinedExportHonored',
  'historySessionChangeResetsOriginal',
  'historyOriginalExportHonored',
  'historyExportDialogCount',
  'historyOriginalExportFormats',
  'historyOriginalExportArtifactCount',
  'historyOriginalExportFullSegmentCount',
  'historyRefinedExportArtifactCount',
  'historyRawOriginalExportArtifactCount',
  'resourcesPaneOpenedFromToolbar',
  'coreState',
  'refinementState',
  'resourceCount',
  'coreReadinessSource',
  'translationAdvertised'
])

const PRODUCT_SHELL_V3_JOURNEY_KEYS = Object.freeze([
  'onboardingPreset',
  'coreInstallClicked',
  'coreInitialState',
  'refinementInitialState',
  'refinementPreferenceInitiallyDisabled',
  'refinementPreferenceRejectedWhileMissing',
  'refinementFetchAttemptCountBeforeExplicitDownload',
  'coreObservedStates',
  'coreRangeResumeObserved',
  'coreReadyMarkerCount',
  'refinementReadyMarkerCountBeforeExplicitDownload',
  'coreHotActivation',
  'refinementDownloadStartedBeforeCancellation',
  'refinementCancellationClosedFetchStream',
  'refinementCancellationRetainedPart',
  'refinementReadyMarkerCount',
  'rawSessionFrozenOriginal',
  'startListeningStop',
  'pauseResume',
  'finalCaptionRendered',
  'visibleCaptionMatchesFinal',
  'captionFontApplied',
  'downloadedModelSessionInHistory',
  'terminalHistoryCount',
  'legacyJsonlMigrated',
  'legacySessionVisible',
  'legacySourceReadOnly',
  'longHistorySegmentCount',
  'historyPageCount',
  'historyPageSize',
  'historyMaxTimelineNodes',
  'historyReachedEnd',
  'historyBackForwardNavigation',
  'historyAriaRangeAligned',
  'historyVersionStartsOriginal',
  'historyRefinedVersionSelected',
  'historyRefinedVersionPersistsAcrossPaging',
  'historyRefinedExportHonored',
  'historySessionChangeResetsOriginal',
  'historyOriginalExportHonored',
  'historyExportDialogCount',
  'historyOriginalExportFormats',
  'historyOriginalExportArtifactCount',
  'historyOriginalExportFullSegmentCount',
  'historyRefinedExportArtifactCount',
  'historyRawOriginalExportArtifactCount',
  'resourcesPaneOpenedFromToolbar',
  'coreState',
  'refinementState',
  'resourceCount',
  'coreReadinessSource',
  'translationAdvertised'
])

const PRODUCT_SHELL_V5_WINDOW_INTERACTION_KEYS = Object.freeze([
  'firstFrameFallbackObserved',
  'validContourObserved',
  'validContourShrinkObserved',
  'toolbarStateContourChangeObserved',
  'reloadGenerationFallbackObserved',
  'reloadValidRecoveryObserved',
  'invalidContourFallbackObserved',
  'staleGenerationFallbackObserved',
  'postFailureRecoveryObserved',
  'layoutFallbackObservationCount',
  'layoutRecoveryObservationCount',
  'transparentMarginPassThroughObserved',
  'toolbarContourPriorityObserved',
  'resizeBandObserved',
  'visibleCardDragPointCount',
  'firstPointerDeltaObserved',
  'stationaryPressReleaseStable',
  'gestureCancellationObservationCount',
  'nonGripToolbarDragRejected',
  'unlockedGripMovesCaptionGroup',
  'lockedGripMovesToolbarOnly',
  'normalTitlebarDragCount',
  'normalInteractiveExclusionCount',
  'normalBodyExclusionCount',
  'normalForegroundPromotionCount',
  'rapidFocusSwitchObserved',
  'focusLossDemotionObserved',
  'focusedDragBlurCancellationObserved',
  'sharedTitlebarStructureObserved',
  'sharedTitlebarThemeVariantsObserved',
  'forcedColorsTitlebarRuleObserved'
])
const PRODUCT_SHELL_V6_APPLICATION_LIFECYCLE_KEYS = Object.freeze([
  'primaryWindowMinimizable',
  'primaryWindowTitleStable',
  'minimizeControlVisible',
  'activeSessionContinuedWhileMinimized',
  'captionHiddenWhileMinimized',
  'visibleAuxiliaryWindowCountBeforeMinimize',
  'minimizedAuxiliaryWindowCount',
  'nativeRestorePreservedWindowSet',
  'nativeRestorePreservedBounds',
  'nativeRestorePreservedRuntimeSnapshot',
  'secondInstanceRestoredPrimary',
  'secondInstancePreservedWindowSet',
  'secondInstancePreservedBounds',
  'auxiliaryCloseKeptPrimary',
  'rendererExitRequested'
])
const PRODUCT_SHELL_V5_LIMITATIONS = Object.freeze([
  'fake-asr-no-physical-audio',
  'controlled-model-fixtures-no-real-tensors',
  'deterministic-205-segment-fixture-not-two-hour-i3',
  'controlled-pointer-and-focus-no-human-dwm',
  'no-system-dpi-or-mixed-scale-qualification'
])
const PRODUCT_SHELL_PACKAGING_KEYS = Object.freeze([
  'appIsPackaged',
  'defaultApp',
  'smokeMainFromAsar',
  'productMainFromAsar',
  'storageUtilityRoundTrip',
  'nativeBinaryCount',
  'nativeAddonLoadedInUtility',
  'nativeApiSurfaceReady',
  'nativeProbeExactExitCode',
  'nativeProbeFatalObserved',
  'packagedDb0Status',
  'packagedDb0CheckCount',
  'packagedDb0Wal',
  'packagedDb0Reopen',
  'packagedDb0Integrity',
  'packagedDb0ExactExitCode',
  'releaseCandidate',
  'installedViaNsis'
])
const PRODUCT_SHELL_QUALIFICATION_KEYS = Object.freeze([
  'runId',
  'phase',
  'freshProductReportSha256',
  'productPayloadVersion',
  'productPayloadFileCount',
  'productPayloadSha256'
])
const SHA256_PATTERN = /^[a-f0-9]{64}$/

function hasExactKeys (value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isExactArray (value, expected) {
  return Array.isArray(value) && value.length === expected.length &&
    value.every((item, index) => item === expected[index])
}

function validateProductShellV2Journey (journey) {
  const requiredCoreStates = ['missing', 'downloading', 'verifying', 'ready']
  const trueFields = [
    'coreInstallClicked',
    'refinementPreferenceInitiallyDisabled',
    'refinementPreferenceRejectedWhileMissing',
    'coreRangeResumeObserved',
    'coreHotActivation',
    'refinementContinueRangeObserved',
    'refinementExplicitDownloadReady',
    'refinementPreferenceStillDisabledAfterDownload',
    'refinementPreferenceExplicitlyEnabled',
    'rawSessionFrozenOriginal',
    'futureSessionFrozenRefinementEnabled',
    'refinementFaultSilentDuringSession',
    'postSessionRefinementNoticeShown',
    'refinementNoticeClearedByHistory',
    'historyRefinementFaultVisible',
    'startListeningStop',
    'pauseResume',
    'finalCaptionRendered',
    'visibleCaptionMatchesFinal',
    'captionFontApplied',
    'downloadedModelSessionInHistory',
    'legacyJsonlMigrated',
    'legacySessionVisible',
    'legacySourceReadOnly',
    'historyReachedEnd',
    'historyBackForwardNavigation',
    'historyAriaRangeAligned',
    'historyVersionStartsOriginal',
    'historyRefinedVersionSelected',
    'historyRefinedVersionPersistsAcrossPaging',
    'historyRefinedExportHonored',
    'historySessionChangeResetsOriginal',
    'historyOriginalExportHonored',
    'resourcesPaneOpenedFromToolbar'
  ]
  if (!hasExactKeys(journey, PRODUCT_SHELL_V2_JOURNEY_KEYS) ||
      journey.onboardingPreset !== 'dictation' ||
      journey.coreInitialState !== 'missing' || journey.refinementInitialState !== 'missing' ||
      journey.refinementFetchAttemptCountBeforeExplicitDownload !== 0 ||
      !isExactArray(journey.coreObservedStates, requiredCoreStates) ||
      journey.coreReadyMarkerCount !== 2 || journey.refinementReadyMarkerCountBeforeExplicitDownload !== 0 ||
      journey.refinementReadyMarkerCount !== 1 || journey.terminalHistoryCount !== 4 ||
      journey.longHistorySegmentCount !== 205 || journey.historyPageCount !== 5 ||
      journey.historyPageSize !== 50 || !Number.isSafeInteger(journey.historyMaxTimelineNodes) ||
      journey.historyMaxTimelineNodes < 1 || journey.historyMaxTimelineNodes > 50 ||
      journey.historyExportDialogCount !== 5 ||
      !isExactArray(journey.historyOriginalExportFormats, ['txt', 'md', 'srt']) ||
      journey.historyOriginalExportArtifactCount !== 3 || journey.historyOriginalExportFullSegmentCount !== 205 ||
      journey.historyRefinedExportArtifactCount !== 1 || journey.historyRawOriginalExportArtifactCount !== 1 ||
      journey.coreState !== 'ready' || journey.refinementState !== 'ready' || journey.resourceCount !== 3 ||
      journey.coreReadinessSource !== 'settings-click-controlled-install' ||
      journey.translationAdvertised !== false ||
      trueFields.some((field) => journey[field] !== true)) {
    throw new Error('product-shell v2 user journey evidence is incomplete')
  }
}

function validateProductShellV3Journey (journey, expectedCoreReadyMarkerCount = 2, expectedResourceCount = 3, schemaVersion = 3) {
  const requiredCoreStates = ['missing', 'downloading', 'verifying', 'ready']
  const trueFields = [
    'coreInstallClicked',
    'refinementPreferenceInitiallyDisabled',
    'refinementPreferenceRejectedWhileMissing',
    'coreRangeResumeObserved',
    'coreHotActivation',
    'refinementDownloadStartedBeforeCancellation',
    'refinementCancellationClosedFetchStream',
    'refinementCancellationRetainedPart',
    'rawSessionFrozenOriginal',
    'startListeningStop',
    'pauseResume',
    'finalCaptionRendered',
    'visibleCaptionMatchesFinal',
    'captionFontApplied',
    'downloadedModelSessionInHistory',
    'legacyJsonlMigrated',
    'legacySessionVisible',
    'legacySourceReadOnly',
    'historyReachedEnd',
    'historyBackForwardNavigation',
    'historyAriaRangeAligned',
    'historyVersionStartsOriginal',
    'historyRefinedVersionSelected',
    'historyRefinedVersionPersistsAcrossPaging',
    'historyRefinedExportHonored',
    'historySessionChangeResetsOriginal',
    'historyOriginalExportHonored',
    'resourcesPaneOpenedFromToolbar'
  ]
  if (!hasExactKeys(journey, PRODUCT_SHELL_V3_JOURNEY_KEYS) ||
      journey.onboardingPreset !== 'dictation' ||
      journey.coreInitialState !== 'missing' || journey.refinementInitialState !== 'missing' ||
      journey.refinementFetchAttemptCountBeforeExplicitDownload !== 0 ||
      !isExactArray(journey.coreObservedStates, requiredCoreStates) ||
      journey.coreReadyMarkerCount !== expectedCoreReadyMarkerCount || journey.refinementReadyMarkerCountBeforeExplicitDownload !== 0 ||
      journey.refinementReadyMarkerCount !== 0 || journey.terminalHistoryCount !== 3 ||
      journey.longHistorySegmentCount !== 205 || journey.historyPageCount !== 5 ||
      journey.historyPageSize !== 50 || !Number.isSafeInteger(journey.historyMaxTimelineNodes) ||
      journey.historyMaxTimelineNodes < 1 || journey.historyMaxTimelineNodes > 50 ||
      journey.historyExportDialogCount !== 5 ||
      !isExactArray(journey.historyOriginalExportFormats, ['txt', 'md', 'srt']) ||
      journey.historyOriginalExportArtifactCount !== 3 || journey.historyOriginalExportFullSegmentCount !== 205 ||
      journey.historyRefinedExportArtifactCount !== 1 || journey.historyRawOriginalExportArtifactCount !== 1 ||
      journey.coreState !== 'ready' || journey.refinementState !== 'missing' || journey.resourceCount !== expectedResourceCount ||
      journey.coreReadinessSource !== 'settings-click-controlled-install' ||
      journey.translationAdvertised !== false ||
      trueFields.some((field) => journey[field] !== true)) {
    throw new Error(`product-shell v${schemaVersion} user journey evidence is incomplete`)
  }
}

function assertNoWindowInteractionSensitiveFields (value, pathLabel = 'report') {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoWindowInteractionSensitiveFields(entry, `${pathLabel}[${index}]`))
    return
  }
  for (const [key, nested] of Object.entries(value)) {
    if (/^(?:x|y|top|right|bottom|left|width|height|rect|bounds|geometry|coordinates|screenPosition|windowPosition|toolbarRect|deviceName|deviceLabel|displayId|absoluteMonotonicTime|clockOffset|localPath|captionText|transcriptText|text)$/i.test(key)) {
      throw new Error(`product-shell window interaction contains forbidden field: ${pathLabel}.${key}`)
    }
    assertNoWindowInteractionSensitiveFields(nested, `${pathLabel}.${key}`)
  }
}

function validateProductShellV5WindowInteraction (value) {
  if (!hasExactKeys(value, PRODUCT_SHELL_V5_WINDOW_INTERACTION_KEYS)) {
    throw new Error('product-shell v5 window interaction has missing or unknown fields')
  }
  const countMinimums = {
    layoutFallbackObservationCount: 4,
    layoutRecoveryObservationCount: 4,
    visibleCardDragPointCount: 2,
    gestureCancellationObservationCount: 6,
    normalTitlebarDragCount: 2,
    normalInteractiveExclusionCount: 2,
    normalBodyExclusionCount: 2,
    normalForegroundPromotionCount: 2
  }
  for (const key of PRODUCT_SHELL_V5_WINDOW_INTERACTION_KEYS) {
    if (Object.hasOwn(countMinimums, key)) {
      if (!Number.isSafeInteger(value[key]) || value[key] < countMinimums[key] || value[key] > 1000000) {
        throw new Error(`product-shell v5 window interaction count is invalid: ${key}`)
      }
    } else if (value[key] !== true) {
      throw new Error(`product-shell v5 window interaction observation is incomplete: ${key}`)
    }
  }
  assertNoWindowInteractionSensitiveFields(value, 'windowInteraction')
  return value
}

function validateProductShellV5Identity (value) {
  if (!hasExactKeys(value, [
    'productPayloadVersion', 'productPayloadFileCount', 'productPayloadSha256'
  ])) throw new Error('product-shell v5 source identity has missing or unknown fields')
  const expected = computeProductPayloadIdentity()
  if (value.productPayloadVersion !== expected.version ||
      value.productPayloadFileCount !== expected.fileCount ||
      value.productPayloadSha256 !== expected.sha256 ||
      !SHA256_PATTERN.test(String(value.productPayloadSha256 || ''))) {
    throw new Error('product-shell v5 source identity does not match the current candidate')
  }
  return value
}

function validateProductShellV6ApplicationLifecycle (value) {
  if (!hasExactKeys(value, PRODUCT_SHELL_V6_APPLICATION_LIFECYCLE_KEYS)) {
    throw new Error('product-shell v6 application lifecycle has missing or unknown fields')
  }
  const countFields = new Set([
    'visibleAuxiliaryWindowCountBeforeMinimize',
    'minimizedAuxiliaryWindowCount'
  ])
  for (const key of PRODUCT_SHELL_V6_APPLICATION_LIFECYCLE_KEYS) {
    if (countFields.has(key)) {
      if (!Number.isSafeInteger(value[key]) || value[key] !== 2) {
        throw new Error(`product-shell v6 application lifecycle count is invalid: ${key}`)
      }
    } else if (value[key] !== true) {
      throw new Error(`product-shell v6 application lifecycle observation is incomplete: ${key}`)
    }
  }
  assertNoWindowInteractionSensitiveFields(value, 'applicationLifecycle')
  return value
}

function validateProductShellV5Envelope (report, schemaVersion = 5) {
  const hasApplicationLifecycle = schemaVersion === 6
  const expectedRootKeys = [
    'schemaVersion', 'kind', 'generatedAt', 'result', 'gateStatus', 'runtime', 'journey',
    'windowInteraction', 'sourceIdentity', 'privacy', 'limitations',
    ...(hasApplicationLifecycle ? ['applicationLifecycle'] : []),
    ...(report.packaging ? ['packaging', 'qualification'] : [])
  ]
  if (!hasExactKeys(report, expectedRootKeys) ||
      !hasExactKeys(report.runtime, ['electron', 'node', 'rendererCount', 'crashEventCount']) ||
      !hasExactKeys(report.privacy, [
        'physicalAudioSourceOpened', 'audioPersisted',
        'transcriptTextPersistedInReport', 'localPathsPersistedInReport'
      ]) ||
      (report.packaging && (
        !hasExactKeys(report.packaging, PRODUCT_SHELL_PACKAGING_KEYS) ||
        !hasExactKeys(report.qualification, PRODUCT_SHELL_QUALIFICATION_KEYS)
      ))) {
    throw new Error(`product-shell v${schemaVersion} report envelope has missing or unknown fields`)
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(String(report.generatedAt || '')) ||
      new Date(report.generatedAt).toISOString() !== report.generatedAt) {
    throw new Error(`product-shell v${schemaVersion} generatedAt is invalid`)
  }
  const expectedLimitations = [
    ...PRODUCT_SHELL_V5_LIMITATIONS,
    ...(report.packaging?.appIsPackaged === true
      ? ['not-clean-machine-i4', 'packaged-test-variant-not-release-installer']
      : ['not-packaged-i4'])
  ]
  if (!isExactArray(report.limitations, expectedLimitations)) {
    throw new Error(`product-shell v${schemaVersion} limitations are not the exact external boundary`)
  }
  validateProductShellV5WindowInteraction(report.windowInteraction)
  validateProductShellV5Identity(report.sourceIdentity)
  if (hasApplicationLifecycle) validateProductShellV6ApplicationLifecycle(report.applicationLifecycle)
  if (report.packaging?.appIsPackaged === true && (
    report.qualification?.productPayloadVersion !== report.sourceIdentity.productPayloadVersion ||
    report.qualification?.productPayloadFileCount !== report.sourceIdentity.productPayloadFileCount ||
    report.qualification?.productPayloadSha256 !== report.sourceIdentity.productPayloadSha256
  )) throw new Error('packaged product-shell v5 source identity is not qualification-bound')
  assertNoWindowInteractionSensitiveFields(report.windowInteraction, 'windowInteraction')
  if (hasApplicationLifecycle) {
    assertNoWindowInteractionSensitiveFields(report.applicationLifecycle, 'applicationLifecycle')
  }
}

function validateProductShellReport (report) {
  if (!report || ![1, 2, 3, 4, 5, 6].includes(report.schemaVersion) || report.kind !== 'product-shell-smoke') {
    throw new Error('invalid product-shell report envelope')
  }
  if (report.result !== 'pass' || report.gateStatus !== 'partial') {
    throw new Error('product-shell journey did not pass or overclaimed the release gate')
  }
  if (!/^43\./.test(String(report.runtime?.electron || '')) ||
      report.runtime?.rendererCount !== 4 || report.runtime?.crashEventCount !== 0) {
    throw new Error('product-shell Electron runtime evidence is incomplete')
  }
  const journey = report.journey || {}
  const requiredModelStates = ['missing', 'downloading', 'verifying', 'ready']
  if (report.schemaVersion === 1 && (journey.onboardingPreset !== 'dictation' ||
      journey.modelInstallClicked !== true ||
      journey.modelInitialState !== 'missing' ||
      !Array.isArray(journey.modelObservedStates) ||
      journey.modelObservedStates.length !== requiredModelStates.length ||
      journey.modelObservedStates.some((state, index) => state !== requiredModelStates[index]) ||
      journey.modelRangeResumeObserved !== true ||
      journey.modelReadyMarkerCount !== 3 ||
      journey.modelHotActivation !== true ||
      journey.startListeningStop !== true ||
      journey.pauseResume !== true ||
      journey.finalCaptionRendered !== true ||
      /* J15a：可见字幕必须就是那条定稿，且改字号后视口按整行重算不溢出。 */
      journey.visibleCaptionMatchesFinal !== true ||
      journey.captionFontApplied !== true ||
      journey.downloadedModelSessionInHistory !== true ||
      journey.terminalHistoryCount !== 3 ||
      journey.legacyJsonlMigrated !== true || journey.legacySessionVisible !== true ||
      journey.legacySourceReadOnly !== true ||
      journey.longHistorySegmentCount !== 205 || journey.historyPageCount !== 5 ||
      journey.historyPageSize !== 50 || journey.historyMaxTimelineNodes > 50 ||
      !Number.isSafeInteger(journey.historyMaxTimelineNodes) || journey.historyMaxTimelineNodes < 1 ||
      journey.historyReachedEnd !== true || journey.historyBackForwardNavigation !== true ||
      journey.historyAriaRangeAligned !== true ||
      journey.historyExportDialogCount !== 3 ||
      !Array.isArray(journey.historyExportFormats) ||
      journey.historyExportFormats.length !== 3 ||
      journey.historyExportFormats.some((format, index) => format !== ['txt', 'md', 'srt'][index]) ||
      journey.historyExportArtifactCount !== 3 ||
      journey.historyExportFullSegmentCount !== 205 ||
      journey.resourcesPaneOpenedFromToolbar !== true ||
      journey.modelState !== 'ready' || journey.resourceCount !== 3 ||
      journey.modelReadinessSource !== 'settings-click-controlled-install' ||
      journey.translationAdvertised !== false)) {
    throw new Error('product-shell user journey evidence is incomplete')
  }
  if (report.schemaVersion === 2) validateProductShellV2Journey(journey)
  if (report.schemaVersion === 3) validateProductShellV3Journey(journey)
  if (report.schemaVersion === 4) validateProductShellV3Journey(journey, 3, 4, 4)
  if (report.schemaVersion === 5) {
    validateProductShellV3Journey(journey, 3, 4, 5)
    validateProductShellV5Envelope(report)
  }
  if (report.schemaVersion === 6) {
    validateProductShellV3Journey(journey, 3, 4, 6)
    validateProductShellV5Envelope(report, 6)
  }
  if (report.privacy?.physicalAudioSourceOpened !== false ||
      report.privacy?.audioPersisted !== false ||
      report.privacy?.transcriptTextPersistedInReport !== false ||
      report.privacy?.localPathsPersistedInReport !== false) {
    throw new Error('product-shell privacy evidence is incomplete')
  }
  const requiredLimitations = [
    'fake-asr-no-physical-audio',
    'controlled-model-fixtures-no-real-tensors',
    'deterministic-205-segment-fixture-not-two-hour-i3',
    report.packaging?.appIsPackaged === true ? 'not-clean-machine-i4' : 'not-packaged-i4'
  ]
  if (![5, 6].includes(report.schemaVersion) && (!Array.isArray(report.limitations) ||
      requiredLimitations.some((limitation) => !report.limitations.includes(limitation)) ||
      (report.packaging?.appIsPackaged === true && report.limitations.includes('not-packaged-i4')))) {
    throw new Error('product-shell report must preserve its external-boundary limitations')
  }
  const serialized = JSON.stringify(report)
  if (/[A-Za-z]:[\\/]/.test(serialized) ||
      /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)/i.test(serialized) ||
      /joined(?:Final|Refined)Text|captionArrivals|"text"\s*:/i.test(serialized)) {
    throw new Error('product-shell report leaked a path, audio reference or transcript text')
  }
  return report
}

function readAndValidateProductShellReport (reportPath) {
  const resolved = path.resolve(reportPath)
  return validateProductShellReport(parseStrictEvidenceJson(
    fs.readFileSync(resolved),
    `product-shell report ${path.basename(resolved)}`
  ))
}

if (require.main === module) {
  const reportPath = process.argv[2]
  if (!reportPath || process.argv.length !== 3) {
    throw new Error('usage: node scripts/verify-product-shell-report.js <report.json>')
  }
  const report = readAndValidateProductShellReport(reportPath)
  process.stdout.write(JSON.stringify({
    result: report.result,
    gateStatus: report.gateStatus,
    electron: report.runtime.electron,
    rendererCount: report.runtime.rendererCount,
    crashEventCount: report.runtime.crashEventCount
  }) + '\n')
}

module.exports = {
  PRODUCT_SHELL_V2_JOURNEY_KEYS,
  PRODUCT_SHELL_V3_JOURNEY_KEYS,
  PRODUCT_SHELL_V5_LIMITATIONS,
  PRODUCT_SHELL_V5_WINDOW_INTERACTION_KEYS,
  PRODUCT_SHELL_V6_APPLICATION_LIFECYCLE_KEYS,
  PRODUCT_SHELL_PACKAGING_KEYS,
  PRODUCT_SHELL_QUALIFICATION_KEYS,
  readAndValidateProductShellReport,
  validateProductShellReport
}
