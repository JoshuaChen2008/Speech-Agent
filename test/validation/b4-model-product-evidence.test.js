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

test('published B4 model evidence proves complete approved bundle installation and callability', () => {
  const report = readReport(MODEL_REPORT_PATH)
  const expectedBytes = PRODUCTION_MODEL_MANIFEST.artifacts.reduce((sum, artifact) => sum + artifact.bytes, 0)

  assert.equal(report.schemaVersion, 1)
  assert.equal(report.kind, 'model-install-live-smoke')
  assert.equal(report.result, 'pass')
  assert.equal(report.manifestVersion, PRODUCTION_MODEL_MANIFEST.version)
  assert.equal(report.installation.resourceCount, PRODUCTION_MODEL_MANIFEST.artifacts.length)
  assert.equal(report.installation.totalBytes, expectedBytes)
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
    startListeningStop: true,
    finalCaptionRendered: true,
    terminalHistoryCount: 2,
    longHistorySegmentCount: 205,
    historyPageCount: 5,
    historyPageSize: 50,
    historyMaxTimelineNodes: 50,
    historyReachedEnd: true,
    historyBackForwardNavigation: true,
    historyAriaRangeAligned: true,
    resourcesPaneOpenedFromToolbar: true,
    modelState: 'ready',
    resourceCount: 3,
    modelReadinessSource: 'development-fixture-files',
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
    journey: { ...report.journey, historyMaxTimelineNodes: 51 }
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

test('B4 evidence report explicitly preserves the remaining I4 boundary', () => {
  const report = fs.readFileSync(path.join(VALIDATION_DIR, 'b4-model-and-product-shell.md'), 'utf8')
  assert.match(report, /I4[^\n]*(?:待|未)/)
  assert.match(report, /不能声称已经修复/)
  assert.match(report, /不替代 I4 干净机经真实公网完整下载/)
})
