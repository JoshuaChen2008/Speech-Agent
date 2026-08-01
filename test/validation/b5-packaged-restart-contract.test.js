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

test('packaged runner performs a second supervised launch against the same isolated userData', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'scripts', 'run-packaged-product-shell.js'), 'utf8')
  const smoke = fs.readFileSync(path.join(ROOT, 'scripts', 'product-shell-smoke.js'), 'utf8')
  assert.match(runner, /--report', 'offline-restart\.json'/)
  assert.match(runner, /--mode', 'restart'/)
  assert.match(runner, /readAndValidateProductShellRestartReport\(restartReportPath\)/)
  assert.match(runner, /readAndValidateElectronExitEvidence\(restartEvidencePath\)/)
  assert.match(smoke, /offline restart attempted a model download/)
  assert.match(smoke, /legacyMigrationIdempotent/)
  assert.match(smoke, /historyExportFullSegmentCount/)
  assert.match(smoke, /terminalHistoryCountAfterRestart:\s*4/)
})
