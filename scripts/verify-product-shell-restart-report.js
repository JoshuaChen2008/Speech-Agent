'use strict'

// @ts-check

const fs = require('node:fs')
const path = require('node:path')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')
const {
  validatePackagedQualification,
  validatePackagedRuntimeEvidence
} = require('./verify-packaged-product-shell-report')

const PRODUCT_SHELL_RESTART_V2_JOURNEY_KEYS = Object.freeze([
  'coreReadySurvivedRestart',
  'refinementReadySurvivedRestart',
  'modelFetchAttemptCount',
  'fixtureServerStarted',
  'coreReadyMarkerCount',
  'refinementReadyMarkerCount',
  'resourceCount',
  'refinementPreferencePersisted',
  'refinementNoticeNotReplayed',
  'persistedTerminalHistoryCount',
  'previousLiveSessionVisible',
  'legacySessionVisible',
  'legacyMigrationIdempotent',
  'persistedRawSessionFrozenOriginal',
  'persistedRefinedSessionFrozenEnabled',
  'longHistorySegmentCount',
  'historyPageSize',
  'historyOriginalExportArtifactCount',
  'historyOriginalExportFullSegmentCount',
  'restartCaptionRendered',
  'restartSessionFrozenWithPersistedPreference',
  'refinementPreferenceChangedForFutureSessions',
  'restartSessionPersisted',
  'terminalHistoryCountAfterRestart'
])

const PRODUCT_SHELL_RESTART_V3_JOURNEY_KEYS = Object.freeze([
  'coreReadySurvivedRestart',
  'refinementMissingWithRetainedPart',
  'modelFetchAttemptCountBeforeExplicitContinue',
  'fixtureServerStartedBeforeExplicitContinue',
  'coreReadyMarkerCount',
  'refinementReadyMarkerCount',
  'resourceCount',
  'refinementContinueRangeObserved',
  'refinementExplicitDownloadReady',
  'refinementPreferenceStillDisabledAfterDownload',
  'refinementPreferenceExplicitlyEnabled',
  'refinementNoticeNotReplayed',
  'persistedTerminalHistoryCount',
  'previousLiveSessionVisible',
  'legacySessionVisible',
  'legacyMigrationIdempotent',
  'persistedRawSessionFrozenOriginal',
  'longHistorySegmentCount',
  'historyPageSize',
  'historyOriginalExportArtifactCount',
  'historyOriginalExportFullSegmentCount',
  'restartCaptionRendered',
  'restartSessionFrozenWithPersistedPreference',
  'refinementPreferenceChangedForFutureSessions',
  'refinementFaultSilentDuringSession',
  'postSessionRefinementNoticeShown',
  'refinementNoticeClearedByHistory',
  'historyRefinementFaultVisible',
  'restartSessionPersisted',
  'terminalHistoryCountAfterRestart'
])

function hasExactKeys (value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function validateRestartV2Journey (journey) {
  const trueFields = [
    'coreReadySurvivedRestart',
    'refinementReadySurvivedRestart',
    'refinementPreferencePersisted',
    'refinementNoticeNotReplayed',
    'previousLiveSessionVisible',
    'legacySessionVisible',
    'legacyMigrationIdempotent',
    'persistedRawSessionFrozenOriginal',
    'persistedRefinedSessionFrozenEnabled',
    'restartCaptionRendered',
    'restartSessionFrozenWithPersistedPreference',
    'refinementPreferenceChangedForFutureSessions',
    'restartSessionPersisted'
  ]
  if (!hasExactKeys(journey, PRODUCT_SHELL_RESTART_V2_JOURNEY_KEYS) ||
      journey.modelFetchAttemptCount !== 0 || journey.fixtureServerStarted !== false ||
      journey.coreReadyMarkerCount !== 2 || journey.refinementReadyMarkerCount !== 1 ||
      journey.resourceCount !== 3 || journey.persistedTerminalHistoryCount !== 4 ||
      journey.longHistorySegmentCount !== 205 || journey.historyPageSize !== 50 ||
      journey.historyOriginalExportArtifactCount !== 3 || journey.historyOriginalExportFullSegmentCount !== 205 ||
      journey.terminalHistoryCountAfterRestart !== 5 ||
      trueFields.some((field) => journey[field] !== true)) {
    throw new Error('offline restart v2 journey evidence is incomplete')
  }
}

function validateRestartV3Journey (journey) {
  const trueFields = [
    'coreReadySurvivedRestart',
    'refinementMissingWithRetainedPart',
    'refinementContinueRangeObserved',
    'refinementExplicitDownloadReady',
    'refinementPreferenceStillDisabledAfterDownload',
    'refinementPreferenceExplicitlyEnabled',
    'refinementNoticeNotReplayed',
    'previousLiveSessionVisible',
    'legacySessionVisible',
    'legacyMigrationIdempotent',
    'persistedRawSessionFrozenOriginal',
    'restartCaptionRendered',
    'restartSessionFrozenWithPersistedPreference',
    'refinementPreferenceChangedForFutureSessions',
    'refinementFaultSilentDuringSession',
    'postSessionRefinementNoticeShown',
    'refinementNoticeClearedByHistory',
    'historyRefinementFaultVisible',
    'restartSessionPersisted'
  ]
  if (!hasExactKeys(journey, PRODUCT_SHELL_RESTART_V3_JOURNEY_KEYS) ||
      journey.modelFetchAttemptCountBeforeExplicitContinue !== 0 ||
      journey.fixtureServerStartedBeforeExplicitContinue !== false ||
      journey.coreReadyMarkerCount !== 2 || journey.refinementReadyMarkerCount !== 1 ||
      journey.resourceCount !== 3 || journey.persistedTerminalHistoryCount !== 3 ||
      journey.longHistorySegmentCount !== 205 || journey.historyPageSize !== 50 ||
      journey.historyOriginalExportArtifactCount !== 3 || journey.historyOriginalExportFullSegmentCount !== 205 ||
      journey.terminalHistoryCountAfterRestart !== 4 ||
      trueFields.some((field) => journey[field] !== true)) {
    throw new Error('offline restart v3 journey evidence is incomplete')
  }
}

function validateProductShellRestartReport (report) {
  if (!report || ![1, 2, 3].includes(report.schemaVersion) ||
      report.kind !== 'product-shell-offline-restart-smoke' ||
      report.result !== 'pass' || report.gateStatus !== 'partial') {
    throw new Error('invalid product-shell offline restart report envelope')
  }
  if (!/^43\./.test(String(report.runtime?.electron || '')) ||
      report.runtime?.rendererCount !== 4 || report.runtime?.crashEventCount !== 0) {
    throw new Error('offline restart Electron runtime evidence is incomplete')
  }
  validatePackagedRuntimeEvidence(report.packaging)
  validatePackagedQualification(report.qualification, 'restart')
  const journey = report.journey || {}
  if (report.schemaVersion === 1 && (journey.readyModelSurvivedRestart !== true ||
      journey.modelFetchAttemptCount !== 0 || journey.fixtureServerStarted !== false ||
      journey.modelReadyMarkerCount !== 3 || journey.resourceCount !== 3 ||
      journey.persistedTerminalHistoryCount !== 3 ||
      journey.previousLiveSessionVisible !== true || journey.legacySessionVisible !== true ||
      journey.legacyMigrationIdempotent !== true || journey.longHistorySegmentCount !== 205 ||
      journey.historyPageSize !== 50 || journey.historyExportArtifactCount !== 3 ||
      journey.historyExportFullSegmentCount !== 205 ||
      journey.restartCaptionRendered !== true || journey.restartSessionPersisted !== true ||
      journey.terminalHistoryCountAfterRestart !== 4)) {
    throw new Error('offline restart journey evidence is incomplete')
  }
  if (report.schemaVersion === 2) validateRestartV2Journey(journey)
  if (report.schemaVersion === 3) validateRestartV3Journey(journey)
  if (report.privacy?.physicalAudioSourceOpened !== false ||
      report.privacy?.audioPersisted !== false ||
      report.privacy?.transcriptTextPersistedInReport !== false ||
      report.privacy?.localPathsPersistedInReport !== false) {
    throw new Error('offline restart privacy evidence is incomplete')
  }
  const requiredLimitations = [
    'fake-asr-no-physical-audio',
    'controlled-ready-model-fixtures-no-real-tensors',
    'deterministic-205-segment-fixture-not-two-hour-i3',
    'not-clean-machine-i4',
    'packaged-test-variant-not-release-installer'
  ]
  if (!Array.isArray(report.limitations) ||
      requiredLimitations.some((limitation) => !report.limitations.includes(limitation)) ||
      report.limitations.includes('not-packaged-i4')) {
    throw new Error('offline restart report must preserve its external-boundary limitations')
  }
  const serialized = JSON.stringify(report)
  if (/[A-Za-z]:[\\/]/.test(serialized) || /file:\/\//i.test(serialized) ||
      /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)/i.test(serialized) ||
      /joined(?:Final|Refined)Text|captionArrivals|"text"\s*:/i.test(serialized)) {
    throw new Error('offline restart report leaked a path, audio reference or transcript text')
  }
  return report
}

function readAndValidateProductShellRestartReport (reportPath) {
  const resolved = path.resolve(reportPath)
  return validateProductShellRestartReport(parseStrictEvidenceJson(
    fs.readFileSync(resolved),
    `product-shell restart report ${path.basename(resolved)}`
  ))
}

if (require.main === module) {
  if (process.argv.length !== 3) {
    throw new Error('usage: node scripts/verify-product-shell-restart-report.js <report.json>')
  }
  const report = readAndValidateProductShellRestartReport(process.argv[2])
  process.stdout.write(JSON.stringify({
    result: report.result,
    coreReadySurvivedRestart: report.schemaVersion >= 2
      ? report.journey.coreReadySurvivedRestart
      : report.journey.readyModelSurvivedRestart,
    refinementMissingWithRetainedPart: report.schemaVersion === 3
      ? report.journey.refinementMissingWithRetainedPart
      : null,
    modelFetchAttemptCountBeforeExplicitContinue: report.schemaVersion === 3
      ? report.journey.modelFetchAttemptCountBeforeExplicitContinue
      : report.journey.modelFetchAttemptCount,
    persistedTerminalHistoryCount: report.journey.persistedTerminalHistoryCount,
    terminalHistoryCountAfterRestart: report.journey.terminalHistoryCountAfterRestart
  }) + '\n')
}

module.exports = {
  PRODUCT_SHELL_RESTART_V2_JOURNEY_KEYS,
  PRODUCT_SHELL_RESTART_V3_JOURNEY_KEYS,
  readAndValidateProductShellRestartReport,
  validateProductShellRestartReport
}
