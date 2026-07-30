'use strict'

// @ts-check

const fs = require('node:fs')
const path = require('node:path')

const REQUIRED_LIMITATIONS = Object.freeze([
  'no-audio-capture-or-pcm',
  'does-not-reproduce-user-dialog',
  'does-not-prove-two-hour-stability',
  'not-packaged-i4'
])

function assertExactKeys (value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} contains missing or unknown fields`)
  }
}

function validateNativeModelLifecycleReport (report) {
  assertExactKeys(report, [
    'schemaVersion',
    'kind',
    'generatedAt',
    'result',
    'gateStatus',
    'runtime',
    'scope',
    'metrics',
    'privacy',
    'limitations',
    'errorCode'
  ], 'native lifecycle report')
  if (!report || report.schemaVersion !== 1 || report.kind !== 'native-model-lifecycle-smoke') {
    throw new Error('invalid native lifecycle report envelope')
  }
  if (typeof report.generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(report.generatedAt)) {
    throw new Error('native lifecycle report timestamp is invalid')
  }
  assertExactKeys(report.runtime, ['electron', 'node'], 'native lifecycle runtime')
  if (report.result !== 'pass' || report.gateStatus !== 'diagnostic-only' || !/^43\.\d+\.\d+$/.test(String(report.runtime?.electron || ''))) {
    throw new Error('native lifecycle diagnostic did not pass or overclaimed a release gate')
  }
  if (!/^\d+(?:\.\d+){1,3}$/.test(String(report.runtime.node || ''))) {
    throw new Error('native lifecycle Node runtime is invalid')
  }
  const scope = report.scope || {}
  assertExactKeys(scope, [
    'approvedInstalledBundleResolved',
    'realtimeModelAndVadLoaded',
    'offlineRefinementModelLoaded',
    'audioCaptureOpened',
    'pcmFramesSent',
    'packagedRuntime',
    'userDialogReproduced',
    'browserWindowCount'
  ], 'native lifecycle scope')
  if (scope.approvedInstalledBundleResolved !== true ||
      scope.realtimeModelAndVadLoaded !== true ||
      scope.offlineRefinementModelLoaded !== true ||
      scope.audioCaptureOpened !== false || scope.pcmFramesSent !== 0 ||
      scope.packagedRuntime !== false || scope.userDialogReproduced !== false ||
      scope.browserWindowCount !== 0) {
    throw new Error('native lifecycle scope is incomplete or overclaimed')
  }
  const metrics = report.metrics || {}
  assertExactKeys(metrics, [
    'requestedIterations',
    'completedIterations',
    'responsiveWorkerPairs',
    'gracefulRealtimeExits',
    'gracefulRefinementExits',
    'zeroExitCodeCount',
    'fatalErrorCount',
    'abnormalChildProcessCount',
    'cleanChildProcessCount'
  ], 'native lifecycle metrics')
  if (!Number.isInteger(metrics.requestedIterations) || metrics.requestedIterations < 1 ||
      metrics.completedIterations !== metrics.requestedIterations ||
      metrics.responsiveWorkerPairs !== metrics.requestedIterations ||
      metrics.gracefulRealtimeExits !== metrics.requestedIterations ||
      metrics.gracefulRefinementExits !== metrics.requestedIterations ||
      metrics.zeroExitCodeCount !== metrics.requestedIterations * 2 ||
      metrics.fatalErrorCount !== 0 || metrics.abnormalChildProcessCount !== 0 ||
      !Number.isInteger(metrics.cleanChildProcessCount) || metrics.cleanChildProcessCount < 0) {
    throw new Error('native lifecycle metrics are incomplete')
  }
  assertExactKeys(report.privacy, [
    'capturedAudioPersisted',
    'transcriptTextPersisted',
    'localPathsPersisted',
    'diagnosticAudioArtifacts'
  ], 'native lifecycle privacy')
  if (report.privacy?.capturedAudioPersisted !== false ||
      report.privacy?.transcriptTextPersisted !== false ||
      report.privacy?.localPathsPersisted !== false ||
      report.privacy?.diagnosticAudioArtifacts !== 0) {
    throw new Error('native lifecycle privacy evidence failed')
  }
  if (!Array.isArray(report.limitations) ||
      report.limitations.length !== REQUIRED_LIMITATIONS.length ||
      REQUIRED_LIMITATIONS.some((entry) => !report.limitations.includes(entry))) {
    throw new Error('native lifecycle report omitted an external-boundary limitation')
  }
  if (report.errorCode !== null) throw new Error('passing native lifecycle report has an error code')

  const serialized = JSON.stringify(report)
  if (/[A-Za-z]:[\\/]/.test(serialized) ||
      /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)/i.test(serialized) ||
      /"(?:text|transcript|modelDir|modelPath|databasePath|reportPath)"\s*:/i.test(serialized)) {
    throw new Error('native lifecycle report leaked a path, audio reference or transcript field')
  }
  return report
}

function readAndValidateNativeModelLifecycleReport (reportPath) {
  return validateNativeModelLifecycleReport(JSON.parse(fs.readFileSync(path.resolve(reportPath), 'utf8')))
}

if (require.main === module) {
  if (process.argv.length !== 3) {
    throw new Error('usage: node scripts/verify-native-model-lifecycle-report.js <report.json>')
  }
  const report = readAndValidateNativeModelLifecycleReport(process.argv[2])
  process.stdout.write(`${JSON.stringify({ result: report.result, gateStatus: report.gateStatus, metrics: report.metrics })}\n`)
}

module.exports = {
  REQUIRED_LIMITATIONS,
  assertExactKeys,
  readAndValidateNativeModelLifecycleReport,
  validateNativeModelLifecycleReport
}
