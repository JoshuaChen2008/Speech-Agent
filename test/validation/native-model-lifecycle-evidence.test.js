'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { validateNativeModelLifecycleReport } = require('../../scripts/verify-native-model-lifecycle-report')

const TRACKED_REPORT = path.join(__dirname, '..', '..', 'docs', 'validation', 'native-model-lifecycle-results.json')

function passingReport () {
  return {
    schemaVersion: 1,
    kind: 'native-model-lifecycle-smoke',
    generatedAt: '2026-07-31T00:00:00.000Z',
    result: 'pass',
    gateStatus: 'diagnostic-only',
    runtime: { electron: '43.2.0', node: '24.18.0' },
    scope: {
      approvedInstalledBundleResolved: true,
      realtimeModelAndVadLoaded: true,
      offlineRefinementModelLoaded: true,
      audioCaptureOpened: false,
      pcmFramesSent: 0,
      packagedRuntime: false,
      userDialogReproduced: false,
      browserWindowCount: 0
    },
    metrics: {
      requestedIterations: 3,
      completedIterations: 3,
      responsiveWorkerPairs: 3,
      gracefulRealtimeExits: 3,
      gracefulRefinementExits: 3,
      zeroExitCodeCount: 6,
      fatalErrorCount: 0,
      abnormalChildProcessCount: 0,
      cleanChildProcessCount: 6
    },
    privacy: {
      capturedAudioPersisted: false,
      transcriptTextPersisted: false,
      localPathsPersisted: false,
      diagnosticAudioArtifacts: 0
    },
    limitations: [
      'no-audio-capture-or-pcm',
      'does-not-reproduce-user-dialog',
      'does-not-prove-two-hour-stability',
      'not-packaged-i4'
    ],
    errorCode: null
  }
}

test('native model lifecycle evidence accepts bounded diagnostic-only proof', () => {
  const tracked = JSON.parse(fs.readFileSync(TRACKED_REPORT, 'utf8'))
  assert.equal(validateNativeModelLifecycleReport(tracked).result, 'pass')
  assert.equal(validateNativeModelLifecycleReport(passingReport()).result, 'pass')
})

test('native model lifecycle evidence rejects crashes, overclaim and private paths', () => {
  const report = passingReport()
  assert.throws(() => validateNativeModelLifecycleReport({
    ...report,
    metrics: { ...report.metrics, abnormalChildProcessCount: 1 }
  }), /metrics/)
  assert.throws(() => validateNativeModelLifecycleReport({
    ...report,
    scope: { ...report.scope, userDialogReproduced: true }
  }), /scope/)
  assert.throws(() => validateNativeModelLifecycleReport({
    ...report,
    runtime: { ...report.runtime, node: 'D:\\private\\model' }
  }), /Node runtime/)
  assert.throws(() => validateNativeModelLifecycleReport({
    ...report,
    note: 'arbitrary caption body'
  }), /unknown fields/)
  assert.throws(() => validateNativeModelLifecycleReport({
    ...report,
    metrics: { ...report.metrics, note: 'arbitrary caption body' }
  }), /unknown fields/)
})
