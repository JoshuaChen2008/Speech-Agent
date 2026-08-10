'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { PRODUCTION_MODEL_MANIFEST } = require('../../src/main/services/model-manifest')
const { validateProductShellReport } = require('../../scripts/verify-product-shell-report')

const VALIDATION_DIR = path.resolve(__dirname, '../../docs/validation')
const MODEL_REPORT_PATH = path.join(VALIDATION_DIR, 'model-install-results.json')
const PRODUCT_REPORT_PATH = path.join(VALIDATION_DIR, 'product-shell-results.json')

function readReport (reportPath) {
  return JSON.parse(fs.readFileSync(reportPath, 'utf8'))
}

function assertTrackedReportIsPrivate (report) {
  const serialized = JSON.stringify(report)
  assert.doesNotMatch(serialized, /[A-Za-z]:[\\/]/, 'tracked evidence must not expose local paths')
  assert.doesNotMatch(serialized, /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)/i)
  assert.doesNotMatch(serialized, /joined(?:Final|Refined)Text|captionArrivals|"text"\s*:/i)
}

test('published B4 model evidence remains bound to the historical three-resource bundle', () => {
  const report = readReport(MODEL_REPORT_PATH)
  const currentDraft = PRODUCTION_MODEL_MANIFEST.artifacts.find((artifact) => artifact.id === 'zipformer-bilingual-zh-en-2023-02-20')
  const currentBytes = PRODUCTION_MODEL_MANIFEST.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0)

  assert.equal(report.schemaVersion, 1)
  assert.equal(report.kind, 'model-install-live-smoke')
  assert.equal(report.result, 'pass')
  assert.equal(report.manifestVersion, PRODUCTION_MODEL_MANIFEST.version)
  assert.equal(report.installation.resourceCount, 3)
  assert.equal(report.installation.totalBytes, 270938600)
  assert.equal(PRODUCTION_MODEL_MANIFEST.artifacts.length, 4)
  assert.equal(currentBytes, report.installation.totalBytes + currentDraft.bytes)
  assert.equal(report.installation.finalState, 'ready')
  assert.deepEqual(report.installation.observedStates, ['missing', 'downloading', 'verifying', 'ready'])
  assert.equal(report.transport.resumeSeedBytes, 1024 * 1024)
  assert.equal(report.transport.rangeResumeObserved, true)
  assert.deepEqual(report.callability.online.loaded, true)
  assert.deepEqual(report.callability.online.partialObserved, true)
  assert.deepEqual(report.callability.online.finalNonEmpty, true)
  assert.match(report.callability.online.outputDigest, /^[a-f0-9]{64}$/)
  assert.deepEqual(report.callability.offline.loaded, true)
  assert.deepEqual(report.callability.offline.finalNonEmpty, true)
  assert.match(report.callability.offline.outputDigest, /^[a-f0-9]{64}$/)
  assert.deepEqual(report.callability.vad, { loaded: true, speechStartObserved: true })
  assert.deepEqual(report.privacy, {
    capturedAudioPersisted: false,
    transcriptTextPersisted: false,
    localPathsPersisted: false
  })
  assertTrackedReportIsPrivate(report)
})

test('published product-shell evidence proves the four-window user journey without overclaiming physical audio', () => {
  const report = validateProductShellReport(readReport(PRODUCT_REPORT_PATH))

  assert.equal(report.schemaVersion, 1)
  assert.equal(report.kind, 'product-shell-smoke')
  assert.equal(report.result, 'pass')
  assert.equal(report.gateStatus, 'partial')
  assert.equal(report.runtime.rendererCount, 4)
  assert.equal(report.runtime.crashEventCount, 0)
  assert.deepEqual(report.journey, {
    onboardingPreset: 'dictation',
    modelInstallClicked: true,
    modelInitialState: 'missing',
    modelObservedStates: ['missing', 'downloading', 'verifying', 'ready'],
    modelRangeResumeObserved: true,
    modelReadyMarkerCount: 3,
    modelHotActivation: true,
    startListeningStop: true,
    pauseResume: true,
    finalCaptionRendered: true,
    visibleCaptionMatchesFinal: true,
    captionFontApplied: true,
    downloadedModelSessionInHistory: true,
    terminalHistoryCount: 3,
    legacyJsonlMigrated: true,
    legacySessionVisible: true,
    legacySourceReadOnly: true,
    longHistorySegmentCount: 205,
    historyPageCount: 5,
    historyPageSize: 50,
    historyMaxTimelineNodes: 50,
    historyReachedEnd: true,
    historyBackForwardNavigation: true,
    historyAriaRangeAligned: true,
    historyExportDialogCount: 3,
    historyExportFormats: ['txt', 'md', 'srt'],
    historyExportArtifactCount: 3,
    historyExportFullSegmentCount: 205,
    resourcesPaneOpenedFromToolbar: true,
    modelState: 'ready',
    resourceCount: 3,
    modelReadinessSource: 'settings-click-controlled-install',
    translationAdvertised: false
  })
  assert.deepEqual(report.privacy, {
    physicalAudioSourceOpened: false,
    audioPersisted: false,
    transcriptTextPersistedInReport: false,
    localPathsPersistedInReport: false
  })
  assertTrackedReportIsPrivate(report)
})

test('product-shell report verifier rejects real-model, physical-audio and release overclaims', () => {
  const report = readReport(PRODUCT_REPORT_PATH)
  assert.throws(() => validateProductShellReport({ ...report, gateStatus: 'pass' }), /overclaimed/)
  assert.throws(() => validateProductShellReport({
    ...report,
    journey: { ...report.journey, modelObservedStates: ['missing', 'ready'] }
  }), /journey evidence/)
  assert.throws(() => validateProductShellReport({
    ...report,
    journey: { ...report.journey, modelRangeResumeObserved: false }
  }), /journey evidence/)
  assert.throws(() => validateProductShellReport({
    ...report,
    journey: { ...report.journey, modelReadyMarkerCount: 2 }
  }), /journey evidence/)
  assert.throws(() => validateProductShellReport({
    ...report,
    journey: { ...report.journey, historyMaxTimelineNodes: 51 }
  }), /journey evidence/)
  assert.throws(() => validateProductShellReport({
    ...report,
    journey: { ...report.journey, historyExportFullSegmentCount: 50 }
  }), /journey evidence/)
  assert.throws(() => validateProductShellReport({
    ...report,
    limitations: report.limitations.filter((value) => value !== 'deterministic-205-segment-fixture-not-two-hour-i3')
  }), /limitations/)
  assert.throws(() => validateProductShellReport({
    ...report,
    journey: { ...report.journey, modelReadinessSource: 'production-model-inference' }
  }), /journey evidence/)
  assert.throws(() => validateProductShellReport({
    ...report,
    privacy: { ...report.privacy, physicalAudioSourceOpened: true }
  }), /privacy evidence/)
})

test('product-shell CI keeps the settings-click controlled install rather than external or preseeded readiness', () => {
  const smoke = fs.readFileSync(path.resolve(__dirname, '../../scripts/product-shell-smoke.js'), 'utf8')
  const workflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8')

  assert.match(smoke, /externalReady:\s*null/)
  assert.match(smoke, /seedInterruptedModelDownload\(userDataDir, modelFixtures\)/)
  assert.match(smoke, /initialModelState\.core !== 'missing'/)
  assert.match(smoke, /initialModelState\.refinement !== 'missing'/)
  assert.match(smoke, /document\.getElementById\('modelInstallButton'\)\.click\(\)/)
  assert.match(smoke, /\['missing', 'downloading', 'verifying', 'ready'\]/)
  assert.match(smoke, /coreRangeResumeObserved/)
  assert.match(smoke, /coreReadyMarkerCount:\s*CORE_RESOURCE_IDS\.length/)
  assert.match(smoke, /schemaVersion:\s*8/)
  assert.match(smoke, /windowInteraction/)
  assert.match(smoke, /applicationLifecycle/)
  assert.match(smoke, /interactionLifecycle/)
  assert.match(smoke, /sourceIdentity/)
  assert.match(smoke, /button\[data-act="close"\]/)
  assert.match(smoke, /document\.getElementById\('refinementCancelButton'\)\.click\(\)/)
  assert.match(smoke, /heldRefinementResponse\.connectionClosed/)
  assert.match(smoke, /refinementCancellationRetainedPart/)
  assert.match(smoke, /if \(smokeFailed\)[\s\S]*event\.preventDefault\(\)[\s\S]*app\.exit\(1\)/)
  assert.doesNotMatch(smoke, /createDevelopmentModelFixtures|development-fixture-files/)
  assert.match(workflow, /--entry scripts\/product-shell-smoke\.js[\s\S]*verify-product-shell-report\.js/)
})

test('B4 evidence report explicitly preserves the remaining I4 boundary', () => {
  const report = fs.readFileSync(path.join(VALIDATION_DIR, 'b4-model-and-product-shell.md'), 'utf8')
  assert.match(report, /I4[^\n]*(?:待|未)/)
  assert.match(report, /不能声称已经修复/)
  assert.match(report, /不替代 I4 干净机经真实公网完整下载/)
})

test('Windows CI supervises the full four-window product journey and verifies both reports', () => {
  const workflow = fs.readFileSync(path.resolve(__dirname, '../../.github/workflows/ci.yml'), 'utf8')
  assert.match(workflow, /Run four-window product-shell user journey[\s\S]*node scripts\/run-supervised-electron\.js/)
  assert.match(workflow, /--entry scripts\/product-shell-smoke\.js[\s\S]*--strict-report/)
  assert.match(workflow, /--strict-report[\s\S]*if \(\$LASTEXITCODE -ne 0\)/)
  assert.match(workflow, /verify-product-shell-report\.js \.artifacts\/product-shell-ci\/report\.json/)
  assert.match(workflow, /verify-electron-exit-evidence\.js \.artifacts\/product-shell-ci\/exit-evidence\.json/)
})
