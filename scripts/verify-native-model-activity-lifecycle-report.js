'use strict'

// @ts-check

/* Strict allowlisted report constructor + verifier. The smoke passes only
   counters and lifecycle outcomes into this boundary; caption payloads, raw
   samples and filesystem locations have no representable report field. */

const fs = require('node:fs')
const path = require('node:path')

const FIXTURE_ID = 'controlled-code-switch-v1'
const FIXTURE_SHA256 = 'cf741c91fae04e20ae92193065a24248a1f6ecd20a179c3deaf3d69bc9a6febc'
const REQUIRED_LIMITATIONS = Object.freeze([
  'frozen-fixture-direct-memory-injection',
  'no-physical-mic-or-loopback',
  'diagnostic-only-not-user-dialog-reproduction',
  'does-not-prove-long-duration-stability',
  'not-packaged-runtime'
])

function safeInteger (value, fallback = 0) {
  return Number.isInteger(value) && value >= 0 ? value : fallback
}

function safeExitCode (value) {
  return Number.isInteger(value) ? value : null
}

function copyIteration (entry) {
  return {
    ordinal: safeInteger(entry?.ordinal),
    utility: {
      distinctProcessPair: entry?.utility?.distinctProcessPair === true,
      concurrentDuringActivity: entry?.utility?.concurrentDuringActivity === true
    },
    activity: {
      framesFed: safeInteger(entry?.activity?.framesFed),
      framesIngested: safeInteger(entry?.activity?.framesIngested),
      sequenceGapCount: safeInteger(entry?.activity?.sequenceGapCount),
      badSampleTypeFrames: safeInteger(entry?.activity?.badSampleTypeFrames),
      speechSegmentsDetected: safeInteger(entry?.activity?.speechSegmentsDetected),
      finalCaptionCount: safeInteger(entry?.activity?.finalCaptionCount),
      refinedCaptionCount: safeInteger(entry?.activity?.refinedCaptionCount),
      offlineDecodeCount: safeInteger(entry?.activity?.offlineDecodeCount)
    },
    shutdown: {
      realtimeGraceful: entry?.shutdown?.realtimeGraceful === true,
      realtimeExitCode: safeExitCode(entry?.shutdown?.realtimeExitCode),
      refinementGraceful: entry?.shutdown?.refinementGraceful === true,
      refinementExitCode: safeExitCode(entry?.shutdown?.refinementExitCode)
    }
  }
}

function sum (iterations, selector) {
  return iterations.reduce((total, entry) => total + selector(entry), 0)
}

function createNativeModelActivityReport (options) {
  const state = options?.state || {}
  const iterations = Array.isArray(options?.iterations) ? options.iterations.map(copyIteration) : []
  const requestedIterations = safeInteger(state.requestedIterations)
  const result = options?.result === 'pass' ? 'pass' : 'fail'
  const completedIterations = iterations.length
  const report = {
    schemaVersion: 1,
    kind: 'native-model-activity-lifecycle-smoke',
    generatedAt: new Date().toISOString(),
    result,
    gateStatus: 'diagnostic-only',
    runtime: {
      electron: typeof options?.runtime?.electron === 'string' ? options.runtime.electron : 'unknown',
      node: typeof options?.runtime?.node === 'string' ? options.runtime.node : 'unknown'
    },
    input: {
      mode: 'frozen-fixture-in-memory',
      fixtureId: FIXTURE_ID,
      fixtureSha256: FIXTURE_SHA256,
      sampleRate: 16000,
      frameSamples: 1600,
      trailingSilenceFrames: 15
    },
    scope: {
      approvedInstalledBundleResolved: state.bundleResolved === true,
      realtimeOnlineModelLoaded: state.realtimeLoaded === true,
      sileroVadLoaded: state.vadLoaded === true,
      offlineRefinementModelLoaded: state.refinementLoaded === true,
      concurrentNativeUtilitiesObserved: completedIterations > 0 && iterations.every((entry) => entry.utility.concurrentDuringActivity),
      onlineStreamActivityObserved: completedIterations > 0 && iterations.every((entry) => entry.activity.framesIngested > 0 && entry.activity.finalCaptionCount > 0),
      offlineRefinementActivityObserved: completedIterations > 0 && iterations.every((entry) => entry.activity.offlineDecodeCount > 0 && entry.activity.refinedCaptionCount > 0),
      physicalCaptureOpened: false,
      browserWindowCount: safeInteger(state.browserWindowCount),
      packagedRuntime: false,
      userDialogReproduced: false
    },
    metrics: {
      requestedIterations,
      completedIterations,
      concurrentUtilityPairs: sum(iterations, (entry) => entry.utility.concurrentDuringActivity ? 1 : 0),
      onlineActivityIterations: sum(iterations, (entry) => entry.activity.framesIngested > 0 && entry.activity.finalCaptionCount > 0 ? 1 : 0),
      offlineRefinementIterations: sum(iterations, (entry) => entry.activity.offlineDecodeCount > 0 && entry.activity.refinedCaptionCount > 0 ? 1 : 0),
      totalFramesFed: sum(iterations, (entry) => entry.activity.framesFed),
      totalFramesIngested: sum(iterations, (entry) => entry.activity.framesIngested),
      totalFinalCaptions: sum(iterations, (entry) => entry.activity.finalCaptionCount),
      totalRefinedCaptions: sum(iterations, (entry) => entry.activity.refinedCaptionCount),
      totalOfflineDecodes: sum(iterations, (entry) => entry.activity.offlineDecodeCount),
      gracefulRealtimeExits: sum(iterations, (entry) => entry.shutdown.realtimeGraceful && entry.shutdown.realtimeExitCode === 0 ? 1 : 0),
      gracefulRefinementExits: sum(iterations, (entry) => entry.shutdown.refinementGraceful && entry.shutdown.refinementExitCode === 0 ? 1 : 0),
      zeroExitCodeCount: sum(iterations, (entry) => Number(entry.shutdown.realtimeExitCode === 0) + Number(entry.shutdown.refinementExitCode === 0)),
      fatalErrorCount: safeInteger(state.fatalErrorCount)
    },
    iterations,
    privacy: {
      capturedAudioPersisted: false,
      rawPcmPersisted: false,
      transcriptTextPersisted: false,
      audioPathPersisted: false,
      localPathsPersisted: false,
      diagnosticAudioArtifacts: safeInteger(state.audioArtifactCount)
    },
    limitations: [...REQUIRED_LIMITATIONS],
    errorCode: result === 'pass'
      ? null
      : (options?.errorCode === 'NATIVE_MODEL_ACTIVITY_FAILED' ? options.errorCode : 'NATIVE_MODEL_ACTIVITY_FAILED')
  }
  return report
}

function assertExactKeys (value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const required = [...expected].sort()
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} contains missing or unknown fields`)
  }
}

function assertNonNegativeInteger (value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`)
}

function validateIteration (entry, ordinal) {
  assertExactKeys(entry, ['ordinal', 'utility', 'activity', 'shutdown'], 'activity iteration')
  if (entry.ordinal !== ordinal) throw new Error('activity iteration ordinal is not contiguous')
  assertExactKeys(entry.utility, ['distinctProcessPair', 'concurrentDuringActivity'], 'activity utility evidence')
  if (entry.utility.distinctProcessPair !== true || entry.utility.concurrentDuringActivity !== true) {
    throw new Error('native utility processes were not concurrently active')
  }
  assertExactKeys(entry.activity, [
    'framesFed',
    'framesIngested',
    'sequenceGapCount',
    'badSampleTypeFrames',
    'speechSegmentsDetected',
    'finalCaptionCount',
    'refinedCaptionCount',
    'offlineDecodeCount'
  ], 'activity evidence')
  for (const [key, value] of Object.entries(entry.activity)) assertNonNegativeInteger(value, `activity ${key}`)
  if (entry.activity.framesFed < 1 || entry.activity.framesIngested !== entry.activity.framesFed ||
      entry.activity.sequenceGapCount !== 0 || entry.activity.badSampleTypeFrames !== 0 ||
      entry.activity.speechSegmentsDetected < 1 || entry.activity.finalCaptionCount < 1 ||
      entry.activity.refinedCaptionCount < 1 || entry.activity.offlineDecodeCount < 1) {
    throw new Error('real model activity evidence is incomplete')
  }
  assertExactKeys(entry.shutdown, [
    'realtimeGraceful',
    'realtimeExitCode',
    'refinementGraceful',
    'refinementExitCode'
  ], 'activity shutdown evidence')
  if (entry.shutdown.realtimeGraceful !== true || entry.shutdown.realtimeExitCode !== 0 ||
      entry.shutdown.refinementGraceful !== true || entry.shutdown.refinementExitCode !== 0) {
    throw new Error('native utility shutdown was not graceful with exact exit code zero')
  }
}

function validateNativeModelActivityReport (report) {
  assertExactKeys(report, [
    'schemaVersion',
    'kind',
    'generatedAt',
    'result',
    'gateStatus',
    'runtime',
    'input',
    'scope',
    'metrics',
    'iterations',
    'privacy',
    'limitations',
    'errorCode'
  ], 'native model activity report')
  if (report.schemaVersion !== 1 || report.kind !== 'native-model-activity-lifecycle-smoke' ||
      report.result !== 'pass' || report.gateStatus !== 'diagnostic-only' || report.errorCode !== null) {
    throw new Error('native model activity diagnostic did not pass or overclaimed a gate')
  }
  if (typeof report.generatedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(report.generatedAt)) {
    throw new Error('native model activity timestamp is invalid')
  }
  assertExactKeys(report.runtime, ['electron', 'node'], 'native model activity runtime')
  if (!/^43\.\d+\.\d+$/.test(String(report.runtime.electron)) ||
      !/^\d+(?:\.\d+){1,3}$/.test(String(report.runtime.node))) {
    throw new Error('native model activity runtime is invalid')
  }
  assertExactKeys(report.input, [
    'mode', 'fixtureId', 'fixtureSha256', 'sampleRate', 'frameSamples', 'trailingSilenceFrames'
  ], 'native model activity input')
  if (report.input.mode !== 'frozen-fixture-in-memory' || report.input.fixtureId !== FIXTURE_ID ||
      report.input.fixtureSha256 !== FIXTURE_SHA256 || report.input.sampleRate !== 16000 ||
      report.input.frameSamples !== 1600 || report.input.trailingSilenceFrames !== 15) {
    throw new Error('native model activity input is not the approved frozen in-memory fixture')
  }
  assertExactKeys(report.scope, [
    'approvedInstalledBundleResolved',
    'realtimeOnlineModelLoaded',
    'sileroVadLoaded',
    'offlineRefinementModelLoaded',
    'concurrentNativeUtilitiesObserved',
    'onlineStreamActivityObserved',
    'offlineRefinementActivityObserved',
    'physicalCaptureOpened',
    'browserWindowCount',
    'packagedRuntime',
    'userDialogReproduced'
  ], 'native model activity scope')
  if (report.scope.approvedInstalledBundleResolved !== true ||
      report.scope.realtimeOnlineModelLoaded !== true || report.scope.sileroVadLoaded !== true ||
      report.scope.offlineRefinementModelLoaded !== true ||
      report.scope.concurrentNativeUtilitiesObserved !== true ||
      report.scope.onlineStreamActivityObserved !== true ||
      report.scope.offlineRefinementActivityObserved !== true ||
      report.scope.physicalCaptureOpened !== false || report.scope.browserWindowCount !== 0 ||
      report.scope.packagedRuntime !== false || report.scope.userDialogReproduced !== false) {
    throw new Error('native model activity scope is incomplete or overclaimed')
  }
  assertExactKeys(report.metrics, [
    'requestedIterations',
    'completedIterations',
    'concurrentUtilityPairs',
    'onlineActivityIterations',
    'offlineRefinementIterations',
    'totalFramesFed',
    'totalFramesIngested',
    'totalFinalCaptions',
    'totalRefinedCaptions',
    'totalOfflineDecodes',
    'gracefulRealtimeExits',
    'gracefulRefinementExits',
    'zeroExitCodeCount',
    'fatalErrorCount'
  ], 'native model activity metrics')
  for (const [key, value] of Object.entries(report.metrics)) assertNonNegativeInteger(value, `metric ${key}`)
  const requested = report.metrics.requestedIterations
  if (requested < 1 || requested > 20 || report.metrics.completedIterations !== requested ||
      report.metrics.concurrentUtilityPairs !== requested ||
      report.metrics.onlineActivityIterations !== requested ||
      report.metrics.offlineRefinementIterations !== requested ||
      report.metrics.gracefulRealtimeExits !== requested ||
      report.metrics.gracefulRefinementExits !== requested ||
      report.metrics.zeroExitCodeCount !== requested * 2 ||
      report.metrics.totalFramesFed < requested ||
      report.metrics.totalFramesIngested !== report.metrics.totalFramesFed ||
      report.metrics.totalFinalCaptions < requested || report.metrics.totalRefinedCaptions < requested ||
      report.metrics.totalOfflineDecodes < requested || report.metrics.fatalErrorCount !== 0) {
    throw new Error('native model activity metrics are incomplete')
  }
  if (!Array.isArray(report.iterations) || report.iterations.length !== requested) {
    throw new Error('native model activity iterations are incomplete')
  }
  report.iterations.forEach((entry, index) => validateIteration(entry, index + 1))
  const total = (key) => sum(report.iterations, (entry) => entry.activity[key])
  if (total('framesFed') !== report.metrics.totalFramesFed ||
      total('framesIngested') !== report.metrics.totalFramesIngested ||
      total('finalCaptionCount') !== report.metrics.totalFinalCaptions ||
      total('refinedCaptionCount') !== report.metrics.totalRefinedCaptions ||
      total('offlineDecodeCount') !== report.metrics.totalOfflineDecodes) {
    throw new Error('native model activity totals do not match iteration evidence')
  }
  assertExactKeys(report.privacy, [
    'capturedAudioPersisted',
    'rawPcmPersisted',
    'transcriptTextPersisted',
    'audioPathPersisted',
    'localPathsPersisted',
    'diagnosticAudioArtifacts'
  ], 'native model activity privacy')
  if (report.privacy.capturedAudioPersisted !== false || report.privacy.rawPcmPersisted !== false ||
      report.privacy.transcriptTextPersisted !== false || report.privacy.audioPathPersisted !== false ||
      report.privacy.localPathsPersisted !== false || report.privacy.diagnosticAudioArtifacts !== 0) {
    throw new Error('native model activity privacy evidence failed')
  }
  if (!Array.isArray(report.limitations) || report.limitations.length !== REQUIRED_LIMITATIONS.length ||
      REQUIRED_LIMITATIONS.some((entry) => !report.limitations.includes(entry))) {
    throw new Error('native model activity limitations are incomplete')
  }

  const serialized = JSON.stringify(report)
  if (/[A-Za-z]:[\\/]/.test(serialized) ||
      /(?:^|["\s])\/(?:Users|home|tmp|var|opt|mnt|Volumes)\//i.test(serialized) ||
      /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)(?:["?#\s]|$)/i.test(serialized) ||
      /"(?:text|transcript|samples|pcm|audioPath|filePath|modelDir|modelPath|workDir|reportPath|message|stack)"\s*:/i.test(serialized)) {
    throw new Error('native model activity report leaked content, PCM, an audio reference or a local path')
  }
  return report
}

function readAndValidateNativeModelActivityReport (reportPath) {
  return validateNativeModelActivityReport(JSON.parse(fs.readFileSync(path.resolve(reportPath), 'utf8')))
}

if (require.main === module) {
  if (process.argv.length !== 3) throw new Error('usage: node scripts/verify-native-model-activity-lifecycle-report.js <report.json>')
  const report = readAndValidateNativeModelActivityReport(process.argv[2])
  process.stdout.write(`${JSON.stringify({ result: report.result, gateStatus: report.gateStatus, metrics: report.metrics })}\n`)
}

module.exports = {
  FIXTURE_ID,
  FIXTURE_SHA256,
  REQUIRED_LIMITATIONS,
  assertExactKeys,
  createNativeModelActivityReport,
  readAndValidateNativeModelActivityReport,
  validateNativeModelActivityReport
}
