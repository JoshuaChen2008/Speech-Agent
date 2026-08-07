'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const {
  readAndValidateProductShellRestartReport,
  validateProductShellRestartReport
} = require('../../scripts/verify-product-shell-restart-report')
const { IDENTITY_VERSION } = require('../../src/main/services/product-payload-identity')

const ROOT = path.resolve(__dirname, '../..')

function restartReportFixture () {
  const packaged = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'docs', 'validation', 'b5-packaged-product-results.json'),
    'utf8'
  ))
  return {
    schemaVersion: 1,
    kind: 'product-shell-offline-restart-smoke',
    generatedAt: '2026-07-31T00:00:00.000Z',
    result: 'pass',
    gateStatus: 'partial',
    runtime: packaged.runtime,
    packaging: packaged.packaging,
    qualification: {
      runId: 'b5-00000000-0000-4000-8000-000000000000',
      phase: 'restart',
      freshProductReportSha256: 'a'.repeat(64),
      productPayloadVersion: IDENTITY_VERSION,
      productPayloadFileCount: 80,
      productPayloadSha256: 'b'.repeat(64)
    },
    journey: {
      readyModelSurvivedRestart: true,
      modelFetchAttemptCount: 0,
      fixtureServerStarted: false,
      modelReadyMarkerCount: 3,
      resourceCount: 3,
      persistedTerminalHistoryCount: 3,
      previousLiveSessionVisible: true,
      legacySessionVisible: true,
      legacyMigrationIdempotent: true,
      longHistorySegmentCount: 205,
      historyPageSize: 50,
      historyExportArtifactCount: 3,
      historyExportFullSegmentCount: 205,
      restartCaptionRendered: true,
      restartSessionPersisted: true,
      terminalHistoryCountAfterRestart: 4
    },
    privacy: {
      physicalAudioSourceOpened: false,
      audioPersisted: false,
      transcriptTextPersistedInReport: false,
      localPathsPersistedInReport: false
    },
    limitations: [
      'fake-asr-no-physical-audio',
      'controlled-ready-model-fixtures-no-real-tensors',
      'deterministic-205-segment-fixture-not-two-hour-i3',
      'not-clean-machine-i4',
      'packaged-test-variant-not-release-installer'
    ]
  }
}

function restartReportV2Fixture () {
  const report = restartReportFixture()
  return {
    ...report,
    schemaVersion: 2,
    journey: {
      coreReadySurvivedRestart: true,
      refinementReadySurvivedRestart: true,
      modelFetchAttemptCount: 0,
      fixtureServerStarted: false,
      coreReadyMarkerCount: 2,
      refinementReadyMarkerCount: 1,
      resourceCount: 3,
      refinementPreferencePersisted: true,
      refinementNoticeNotReplayed: true,
      persistedTerminalHistoryCount: 4,
      previousLiveSessionVisible: true,
      legacySessionVisible: true,
      legacyMigrationIdempotent: true,
      persistedRawSessionFrozenOriginal: true,
      persistedRefinedSessionFrozenEnabled: true,
      longHistorySegmentCount: 205,
      historyPageSize: 50,
      historyOriginalExportArtifactCount: 3,
      historyOriginalExportFullSegmentCount: 205,
      restartCaptionRendered: true,
      restartSessionFrozenWithPersistedPreference: true,
      refinementPreferenceChangedForFutureSessions: true,
      restartSessionPersisted: true,
      terminalHistoryCountAfterRestart: 5
    }
  }
}

function restartReportV3Fixture () {
  const report = restartReportV2Fixture()
  const {
    refinementReadySurvivedRestart,
    modelFetchAttemptCount,
    fixtureServerStarted,
    refinementPreferencePersisted,
    persistedRefinedSessionFrozenEnabled,
    terminalHistoryCountAfterRestart,
    ...baseJourney
  } = report.journey
  return {
    ...report,
    schemaVersion: 3,
    journey: {
      ...baseJourney,
      refinementMissingWithRetainedPart: true,
      modelFetchAttemptCountBeforeExplicitContinue: 0,
      fixtureServerStartedBeforeExplicitContinue: false,
      refinementContinueRangeObserved: true,
      refinementExplicitDownloadReady: true,
      refinementPreferenceStillDisabledAfterDownload: true,
      refinementPreferenceExplicitlyEnabled: true,
      refinementFaultSilentDuringSession: true,
      postSessionRefinementNoticeShown: true,
      refinementNoticeClearedByHistory: true,
      historyRefinementFaultVisible: true,
      persistedTerminalHistoryCount: 3,
      terminalHistoryCountAfterRestart: 4
    }
  }
}

function restartReportV4Fixture () {
  const report = restartReportV3Fixture()
  return {
    ...report,
    schemaVersion: 4,
    journey: {
      ...report.journey,
      coreReadyMarkerCount: 3,
      resourceCount: 4
    }
  }
}

test('packaged offline restart report proves ready-model and SQLite persistence without overclaiming I4', (t) => {
  const report = restartReportFixture()
  assert.equal(validateProductShellRestartReport(report), report)
  assert.throws(() => validateProductShellRestartReport({
    ...report,
    journey: { ...report.journey, modelFetchAttemptCount: 1 }
  }), /journey evidence/)
  assert.throws(() => validateProductShellRestartReport({
    ...report,
    limitations: report.limitations.filter((value) => value !== 'not-clean-machine-i4')
  }), /limitations/)

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'restart-report-strict-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const duplicateKeyPath = path.join(directory, 'duplicate-key.json')
  fs.writeFileSync(duplicateKeyPath, '{"schemaVersion":1,"schemaVersion":1}', 'utf8')
  assert.throws(() => readAndValidateProductShellRestartReport(duplicateKeyPath), /duplicate object key/)
})

test('packaged offline restart v2 report keeps core and optional readiness, preference freezing and notice lifecycle separate', () => {
  const report = restartReportV2Fixture()
  assert.equal(validateProductShellRestartReport(report), report)
  assert.throws(() => validateProductShellRestartReport({
    ...report,
    journey: { ...report.journey, refinementNoticeNotReplayed: false }
  }), /v2 journey/)
  assert.throws(() => validateProductShellRestartReport({
    ...report,
    journey: { ...report.journey, unexpectedEvidence: true }
  }), /v2 journey/)
})

test('packaged restart v3 reports the cancelled-part offline boundary before the explicit Range continuation', () => {
  const report = restartReportV3Fixture()
  assert.equal(validateProductShellRestartReport(report), report)
  assert.throws(() => validateProductShellRestartReport({
    ...report,
    journey: { ...report.journey, modelFetchAttemptCountBeforeExplicitContinue: 1 }
  }), /v3 journey/)
  assert.throws(() => validateProductShellRestartReport({
    ...report,
    journey: { ...report.journey, refinementContinueRangeObserved: false }
  }), /v3 journey/)
})

test('packaged restart v4 requires all three core ready markers across the offline boundary', () => {
  const report = restartReportV4Fixture()
  assert.equal(validateProductShellRestartReport(report), report)
  assert.throws(() => validateProductShellRestartReport({
    ...report,
    journey: { ...report.journey, coreReadyMarkerCount: 2 }
  }), /v4 journey/)
  assert.throws(() => validateProductShellRestartReport({
    ...report,
    journey: { ...report.journey, resourceCount: 3 }
  }), /v4 journey/)
})

test('packaged runner performs a second supervised launch against the same isolated userData', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'scripts', 'run-packaged-product-shell.js'), 'utf8')
  const smoke = fs.readFileSync(path.join(ROOT, 'scripts', 'product-shell-smoke.js'), 'utf8')
  assert.match(runner, /--report', 'offline-restart\.json'/)
  assert.match(runner, /--mode', 'restart'/)
  assert.match(runner, /readAndValidateProductShellRestartReport\(restartReportPath\)/)
  assert.match(runner, /readAndValidateElectronExitEvidence\(restartEvidencePath\)/)
  assert.match(smoke, /offline restart attempted a model download/)
  assert.match(smoke, /legacyMigrationIdempotent/)
  assert.match(smoke, /historyOriginalExportFullSegmentCount/)
  assert.match(smoke, /coreReadyMarkerCount/)
  assert.match(smoke, /refinementNoticeNotReplayed/)
  assert.match(smoke, /modelFetchAttemptCountBeforeExplicitContinue/)
  assert.match(smoke, /refinementContinueRangeObserved/)
  assert.match(smoke, /terminalHistoryCountAfterRestart:\s*4/)
})
