'use strict'

// @ts-check

/* Strict verifier for the only report shape allowed to close I3.  It accepts
 * neither a short smoke nor the runner's synthetic-fixture report. */

const fs = require('node:fs')
const path = require('node:path')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')
const I3_STIMULUS_DEFINITION = require('./i3-live-stimulus.json')
const { PRODUCTION_MODEL_MANIFEST } = require('../src/main/services/model-manifest')
const {
  MIN_ACCEPTANCE_WALL_DURATION_MS,
  MIN_FINAL_SEGMENTS,
  MIN_QUALIFICATION_FINAL_SEGMENTS,
  MIN_QUALIFICATION_POST_RECOVERY_FINAL_SEGMENTS,
  MIN_QUALIFICATION_PRE_RECOVERY_FINAL_SEGMENTS,
  PLAYBACK_SCHEDULE_LEAD_MS,
  QUALIFICATION_CRASH_TARGET_MS,
  QUALIFICATION_DURATION_SECONDS,
  SOAK_LIMITS,
  currentProvenance
} = require('./i3-live-audio-soak')

const SHA256 = /^[a-f0-9]{64}$/
const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function exactKeys (value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has unexpected keys`)
  }
  return value
}

function finiteNonNegative (value, label) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a non-negative finite number`)
  return value
}

function positiveInteger (value, label, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${label} must be an integer >= ${minimum}`)
  return value
}

function boolean (value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be boolean`)
  return value
}

function digest (value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) throw new TypeError(`${label} must be a SHA-256 digest`)
  return value
}

function timestamp (value, label) {
  if (typeof value !== 'string' || !ISO_UTC_MS.test(value) || new Date(value).toISOString() !== value) {
    throw new TypeError(`${label} must be a canonical UTC ISO-8601 millisecond timestamp`)
  }
}

function validateResource (resource) {
  exactKeys(resource, ['appCpuP95Percent', 'appWorkingSetMiBMax', 'maxGatewayQueueDepth', 'maxProcessCount', 'sampleCount'], 'metrics.resource')
  for (const key of Object.keys(resource)) finiteNonNegative(resource[key], `metrics.resource.${key}`)
  if (resource.sampleCount < SOAK_LIMITS.minResourceSamples || resource.appCpuP95Percent > SOAK_LIMITS.maxAppCpuP95Percent ||
      resource.appWorkingSetMiBMax > SOAK_LIMITS.maxAppWorkingSetMiB || resource.maxGatewayQueueDepth > SOAK_LIMITS.maxGatewayQueueDepth ||
      resource.maxProcessCount > SOAK_LIMITS.maxProcessCount) {
    throw new Error('I3 live resource bounds are exceeded')
  }
}

function validateExports (value) {
  exactKeys(value, ['markdown', 'srt', 'text'], 'exports')
  for (const [name, item] of Object.entries(value)) {
    exactKeys(item, ['bytes', 'recordCount', 'sha256'], `exports.${name}`)
    positiveInteger(item.bytes, `exports.${name}.bytes`)
    positiveInteger(item.recordCount, `exports.${name}.recordCount`)
    digest(item.sha256, `exports.${name}.sha256`)
  }
}

function validateTransportGeneration (value, label, options = {}) {
  const keys = [
    'acknowledgedFrames', 'badSampleTypeFrames', 'capturedFrames', 'creditStalls', 'droppedCaptionCount',
    'droppedFrames', 'ingestedFrames', 'lostInFlightFrames', 'missedFrames', 'portReplacements', 'sentFrames',
    'sequenceGapCount'
  ]
  exactKeys(value, keys, label)
  for (const key of keys) finiteNonNegative(value[key], `${label}.${key}`)
  const zeroRequired = options.allowForcedExitLoss === true
    ? ['badSampleTypeFrames', 'droppedCaptionCount', 'missedFrames', 'sequenceGapCount']
    : ['badSampleTypeFrames', 'droppedCaptionCount', 'droppedFrames', 'lostInFlightFrames', 'missedFrames', 'sequenceGapCount']
  for (const key of zeroRequired) {
    if (value[key] !== 0) throw new Error(`I3 live transport is not loss-free: ${key}`)
  }
}

function validateTransport (value) {
  exactKeys(value, ['forcedCrashGeneration', 'postRecoveryGeneration'], 'transport')
  /* The first generation is force-killed by the test itself.  Its in-flight
     loss counters stay visible and may be nonzero; all other integrity axes
     still have to remain clean.  The recovered generation is fully strict. */
  validateTransportGeneration(value.forcedCrashGeneration, 'transport.forcedCrashGeneration', { allowForcedExitLoss: true })
  validateTransportGeneration(value.postRecoveryGeneration, 'transport.postRecoveryGeneration')
}

function validateStimulus (stimulus) {
  const expected = I3_STIMULUS_DEFINITION
  const stimulusKeys = stimulus?.sourceId === 'mic'
    ? ['cycleDurationMs', 'derivedWavSha256', 'physicalMicPreflightSha256', 'referenceSha256', 'scheduleLeadMs', 'silenceDurationMs', 'sliceLeadingSilenceMs', 'sliceLengthMs', 'sliceSampleCount', 'sourceCorpusSha256', 'sourceId', 'sourceReferenceSha256']
    : ['cycleDurationMs', 'derivedWavSha256', 'referenceSha256', 'scheduleLeadMs', 'silenceDurationMs', 'sliceLeadingSilenceMs', 'sliceLengthMs', 'sliceSampleCount', 'sourceCorpusSha256', 'sourceId', 'sourceReferenceSha256']
  exactKeys(stimulus, stimulusKeys, 'stimulus')
  digest(stimulus.derivedWavSha256, 'stimulus.derivedWavSha256')
  digest(stimulus.referenceSha256, 'stimulus.referenceSha256')
  digest(stimulus.sourceCorpusSha256, 'stimulus.sourceCorpusSha256')
  digest(stimulus.sourceReferenceSha256, 'stimulus.sourceReferenceSha256')
  if (!['loopback', 'mic'].includes(stimulus.sourceId) || !Number.isInteger(stimulus.cycleDurationMs) ||
      stimulus.cycleDurationMs > SOAK_LIMITS.maxStimulusCycleDurationMs || stimulus.cycleDurationMs > 2200 ||
      !Number.isInteger(stimulus.silenceDurationMs) || !Number.isInteger(stimulus.sliceLeadingSilenceMs) ||
      !Number.isInteger(stimulus.sliceLengthMs) || !Number.isInteger(stimulus.sliceSampleCount) ||
      stimulus.derivedWavSha256 !== expected.expectedDerivedWavSha256 ||
      stimulus.referenceSha256 !== expected.referenceSha256 ||
      stimulus.sourceCorpusSha256 !== expected.sourceCorpus.sha256 ||
      stimulus.sourceReferenceSha256 !== expected.sourceCorpus.referenceSha256 ||
      stimulus.scheduleLeadMs !== PLAYBACK_SCHEDULE_LEAD_MS ||
      stimulus.silenceDurationMs !== expected.silenceDurationMs ||
      stimulus.sliceLeadingSilenceMs !== expected.sliceLeadingSilenceMs ||
      stimulus.sliceLengthMs !== expected.sliceLengthMs ||
      stimulus.sliceSampleCount !== (expected.sliceLengthMs * expected.sampleRate) / 1000 ||
      stimulus.cycleDurationMs !== expected.sliceLengthMs + expected.silenceDurationMs ||
      Math.floor(MIN_ACCEPTANCE_WALL_DURATION_MS /
        (stimulus.cycleDurationMs + stimulus.scheduleLeadMs)) < MIN_FINAL_SEGMENTS + 100) {
    throw new Error('I3 live controlled stimulus evidence is invalid')
  }
  if (stimulus.sourceId === 'mic') digest(stimulus.physicalMicPreflightSha256, 'stimulus.physicalMicPreflightSha256')
}

function validateProvenance (provenance) {
  const expectedProvenance = currentProvenance()
  exactKeys(provenance, Object.keys(expectedProvenance), 'provenance')
  for (const [key, value] of Object.entries(expectedProvenance)) {
    digest(provenance[key], `provenance.${key}`)
    if (provenance[key] !== value) throw new Error(`I3 live provenance drifted for ${key}`)
  }
}

function assertPrivacyAndNoLeak (privacy, report) {
  exactKeys(privacy, ['capturedAudioPersisted', 'reportContainsAbsolutePath', 'reportContainsTranscriptText'], 'privacy')
  if (privacy.capturedAudioPersisted !== false || privacy.reportContainsAbsolutePath !== false ||
      privacy.reportContainsTranscriptText !== false) {
    throw new Error('I3 live privacy assertions are invalid')
  }
  const rendered = JSON.stringify(report)
  if (/[A-Za-z]:[\\/]|(?:^|[^:])\/Users\/|我们下周|onboarding drop-off|二零二六年/i.test(rendered)) {
    throw new Error('I3 live report leaks an absolute path or transcript text')
  }
}

function validateModelEvidence (model) {
  exactKeys(model, ['realtime', 'refinement', 'vad'], 'model')
  const expected = {
    realtime: 'x-asr-160ms',
    refinement: 'x-asr-offline',
    vad: 'silero-vad'
  }
  for (const [key, artifactId] of Object.entries(expected)) {
    exactKeys(model[key], ['artifactId', 'manifestSha256', 'markerSha256'], `model.${key}`)
    if (model[key].artifactId !== artifactId) throw new Error(`I3 model evidence has wrong artifact: ${key}`)
    digest(model[key].manifestSha256, `model.${key}.manifestSha256`)
    digest(model[key].markerSha256, `model.${key}.markerSha256`)
    const artifact = PRODUCTION_MODEL_MANIFEST.artifacts.find((item) => item.id === artifactId)
    if (!artifact || model[key].manifestSha256 !== artifact.sha256) {
      throw new Error(`I3 model evidence manifest digest drifted: ${key}`)
    }
  }
}

function validateI3LiveAudioReport (report) {
  if (!report || typeof report !== 'object' || Array.isArray(report) ||
      report.kind !== 'i3-live-audio-soak' || report.mode !== 'acceptance' || report.result !== 'pass') {
    throw new Error('only a passing I3 live audio acceptance report is valid')
  }
  exactKeys(report, [
    'boundaries', 'checks', 'crashRecovery', 'environment', 'exports', 'generatedAt', 'kind', 'limits',
    'metrics', 'mode', 'model', 'privacy', 'progress', 'provenance', 'result', 'schemaVersion', 'stimulus', 'transport', 'window'
  ], 'I3 live report')
  if (report.schemaVersion !== 1) {
    throw new Error('only a passing I3 live audio acceptance report is valid')
  }
  timestamp(report.generatedAt, 'generatedAt')

  exactKeys(report.boundaries, [
    'actualElectronBrowserWindow', 'actualRealtimeAudioPipeline', 'actualSqliteStorage', 'controlledSpeakerPlayback',
    'syntheticFixture', 'wallClockTwoHourRun'
  ], 'boundaries')
  if (report.boundaries.actualElectronBrowserWindow !== true || report.boundaries.actualRealtimeAudioPipeline !== true ||
      report.boundaries.actualSqliteStorage !== true || report.boundaries.controlledSpeakerPlayback !== true ||
      report.boundaries.syntheticFixture !== false || report.boundaries.wallClockTwoHourRun !== true) {
    throw new Error('I3 live report overclaims an audio acceptance boundary')
  }

  exactKeys(report.checks, [
    'actualWallClockTwoHours', 'audioArtifactsAbsent', 'captionsPersisted', 'exportsComplete',
    'historyPaginationComplete', 'nativeWindowDragObserved', 'noCapturePersisted', 'realBrowserWindowLongLived',
    'refinedObservedWhenEnabled', 'resourceBounds', 'sqliteIntegrity', 'storageRecoveryAfterForcedMainExit',
    'transportHealthy', 'workerCrashRecovered'
  ], 'checks')
  if (Object.values(report.checks).some((value) => value !== true)) throw new Error('I3 live report contains a failed acceptance check')

  exactKeys(report.crashRecovery, [
    'recoveredSessionCount', 'recoveredSessionTerminal', 'recoveryStatus', 'separateMainProcessForcedExit'
  ], 'crashRecovery')
  if (report.crashRecovery.recoveredSessionCount !== 1 || report.crashRecovery.recoveryStatus !== 'committed' ||
      report.crashRecovery.recoveredSessionTerminal !== true || report.crashRecovery.separateMainProcessForcedExit !== true) {
    throw new Error('I3 live SQLite stale-session recovery evidence is incomplete')
  }

  exactKeys(report.environment, ['electron', 'node'], 'environment')
  nonEmptyVersion(report.environment.electron, 'environment.electron')
  nonEmptyVersion(report.environment.node, 'environment.node')
  validateModelEvidence(report.model)

  exactKeys(report.limits, Object.keys(SOAK_LIMITS), 'limits')
  for (const [key, value] of Object.entries(SOAK_LIMITS)) {
    if (report.limits[key] !== value) throw new Error(`I3 live limit changed: ${key}`)
  }

  exactKeys(report.metrics, [
    'captionEvents', 'finalSegments', 'historyPageCount', 'historyPageP95Ms', 'historySegmentCount',
    'measuredListeningWallDurationMs', 'playbackCycles', 'postRecoveryFinalSegments', 'postRecoveryPlaybackCycles',
    'preRecoveryFinalSegments', 'refinedSegments', 'resource', 'sqliteCaptionEvents', 'sqliteSegments'
  ], 'metrics')
  for (const key of Object.keys(report.metrics).filter((key) => key !== 'resource')) finiteNonNegative(report.metrics[key], `metrics.${key}`)
  validateResource(report.metrics.resource)
  if (report.metrics.measuredListeningWallDurationMs < MIN_ACCEPTANCE_WALL_DURATION_MS ||
      report.metrics.finalSegments < MIN_FINAL_SEGMENTS || report.metrics.historySegmentCount !== report.metrics.finalSegments ||
      report.metrics.sqliteSegments !== report.metrics.finalSegments || report.metrics.postRecoveryFinalSegments < 1 ||
      report.metrics.preRecoveryFinalSegments + report.metrics.postRecoveryFinalSegments !== report.metrics.finalSegments ||
      report.metrics.playbackCycles < 1 || report.metrics.postRecoveryPlaybackCycles < 1 ||
      report.metrics.historyPageP95Ms > SOAK_LIMITS.maxHistoryPageP95Ms) {
    throw new Error('I3 live duration, history, playback, or segment evidence is incomplete')
  }

  assertPrivacyAndNoLeak(report.privacy, report)

  exactKeys(report.progress, ['soakId', 'statusWindowDragRequired', 'workerCrashInjectionRequired'], 'progress')
  if (!/^[a-f0-9]{24}$/.test(report.progress.soakId || '') || report.progress.statusWindowDragRequired !== true ||
      report.progress.workerCrashInjectionRequired !== true) throw new Error('I3 live progress hook evidence is invalid')

  validateProvenance(report.provenance)
  validateStimulus(report.stimulus)

  exactKeys(report.window, ['heartbeatCount', 'nativeDragObserved', 'rendered', 'visibleAtCompletion'], 'window')
  positiveInteger(report.window.heartbeatCount, 'window.heartbeatCount')
  if (report.window.nativeDragObserved !== true || report.window.rendered !== true || report.window.visibleAtCompletion !== true) {
    throw new Error('I3 live visible BrowserWindow/drag evidence is incomplete')
  }
  validateExports(report.exports)
  if (Object.values(report.exports).some((item) => item.recordCount !== report.metrics.finalSegments)) {
    throw new Error('I3 live exports do not preserve every final segment')
  }
  validateTransport(report.transport)
  return report
}

function nonEmptyVersion (value, label) {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+/.test(value)) throw new TypeError(`${label} must be a version string`)
}

function readAndValidateI3LiveAudioReport (reportPath) {
  const resolved = path.resolve(reportPath)
  return validateI3LiveAudioReport(parseStrictEvidenceJson(fs.readFileSync(resolved), `I3 live report ${path.basename(resolved)}`))
}

function validateI3LiveAudioQualificationReport (report) {
  if (!report || typeof report !== 'object' || Array.isArray(report) || report.kind !== 'i3-live-audio-qualification' ||
      report.mode !== 'qualification' || report.gateStatus !== 'partial' || report.result !== 'pass') {
    throw new Error('only a passing partial I3 real-audio qualification report is valid')
  }
  exactKeys(report, [
    'boundaries', 'checks', 'crashRecovery', 'environment', 'exports', 'gateStatus', 'generatedAt', 'kind', 'limits',
    'metrics', 'mode', 'model', 'privacy', 'progress', 'provenance', 'result', 'schemaVersion', 'stimulus', 'transport', 'window'
  ], 'I3 real-audio qualification report')
  if (report.schemaVersion !== 1) throw new Error('I3 real-audio qualification schema is invalid')
  timestamp(report.generatedAt, 'generatedAt')
  exactKeys(report.boundaries, [
    'actualElectronBrowserWindow', 'actualRealtimeAudioPipeline', 'actualSqliteStorage', 'controlledSpeakerPlayback',
    'syntheticFixture', 'wallClockTwoHourRun'
  ], 'boundaries')
  if (report.boundaries.actualElectronBrowserWindow !== true || report.boundaries.actualRealtimeAudioPipeline !== true ||
      report.boundaries.actualSqliteStorage !== true || report.boundaries.controlledSpeakerPlayback !== true ||
      report.boundaries.syntheticFixture !== false || report.boundaries.wallClockTwoHourRun !== false) {
    throw new Error('I3 qualification boundaries are invalid')
  }
  const checkKeys = [
    'audioArtifactsAbsent', 'captionsPersisted', 'controlledCycleBounded', 'exportsComplete',
    'historyPaginationComplete', 'noCapturePersisted', 'postRecoveryFinalsPersisted', 'preRecoveryFinalsPersisted',
    'realAudioDurationSeventyFiveSeconds', 'refinedObservedWhenEnabled',
    'resourceBounds', 'sqliteIntegrity', 'storageRecoveryAfterForcedMainExit', 'transportHealthy', 'workerCrashRecovered'
  ]
  exactKeys(report.checks, checkKeys, 'qualification checks')
  if (Object.values(report.checks).some((value) => value !== true)) throw new Error('I3 real-audio qualification contains a failed check')
  exactKeys(report.limits, [
    'crashTargetSeconds', 'durationSeconds', 'maxHistoryPageP95Ms', 'maxStimulusCycleDurationMs', 'minFinalSegments',
    'minPostRecoveryFinalSegments', 'minPreRecoveryFinalSegments', 'minResourceSamples'
  ], 'qualification limits')
  if (report.limits.crashTargetSeconds !== QUALIFICATION_CRASH_TARGET_MS / 1000 ||
      report.limits.durationSeconds !== QUALIFICATION_DURATION_SECONDS ||
      report.limits.minFinalSegments !== MIN_QUALIFICATION_FINAL_SEGMENTS ||
      report.limits.minPostRecoveryFinalSegments !== MIN_QUALIFICATION_POST_RECOVERY_FINAL_SEGMENTS ||
      report.limits.minPreRecoveryFinalSegments !== MIN_QUALIFICATION_PRE_RECOVERY_FINAL_SEGMENTS ||
      report.limits.minResourceSamples !== 30 ||
      report.limits.maxHistoryPageP95Ms !== SOAK_LIMITS.maxHistoryPageP95Ms ||
      report.limits.maxStimulusCycleDurationMs !== SOAK_LIMITS.maxStimulusCycleDurationMs) {
    throw new Error('I3 real-audio qualification limits are invalid')
  }
  exactKeys(report.metrics, [
    'captionEvents', 'finalSegments', 'historyPageCount', 'historyPageP95Ms', 'historySegmentCount',
    'measuredListeningWallDurationMs', 'playbackCycles', 'postRecoveryFinalSegments', 'postRecoveryPlaybackCycles',
    'preRecoveryFinalSegments', 'refinedSegments', 'resource', 'sqliteCaptionEvents', 'sqliteSegments'
  ], 'qualification metrics')
  for (const key of Object.keys(report.metrics).filter((key) => key !== 'resource')) finiteNonNegative(report.metrics[key], `metrics.${key}`)
  exactKeys(report.metrics.resource, ['appCpuP95Percent', 'appWorkingSetMiBMax', 'maxGatewayQueueDepth', 'maxProcessCount', 'sampleCount'], 'metrics.resource')
  for (const [key, value] of Object.entries(report.metrics.resource)) finiteNonNegative(value, `metrics.resource.${key}`)
  if (report.metrics.measuredListeningWallDurationMs < QUALIFICATION_DURATION_SECONDS * 1000 ||
      report.metrics.finalSegments < MIN_QUALIFICATION_FINAL_SEGMENTS ||
      report.metrics.historySegmentCount !== report.metrics.finalSegments || report.metrics.sqliteSegments !== report.metrics.finalSegments ||
      report.metrics.preRecoveryFinalSegments + report.metrics.postRecoveryFinalSegments !== report.metrics.finalSegments ||
      report.metrics.historyPageP95Ms > SOAK_LIMITS.maxHistoryPageP95Ms || report.metrics.resource.sampleCount < 30 ||
      report.metrics.resource.appCpuP95Percent > SOAK_LIMITS.maxAppCpuP95Percent ||
      report.metrics.resource.appWorkingSetMiBMax > SOAK_LIMITS.maxAppWorkingSetMiB ||
      report.metrics.resource.maxGatewayQueueDepth > SOAK_LIMITS.maxGatewayQueueDepth ||
      report.metrics.resource.maxProcessCount > SOAK_LIMITS.maxProcessCount ||
      report.metrics.preRecoveryFinalSegments < MIN_QUALIFICATION_PRE_RECOVERY_FINAL_SEGMENTS ||
      report.metrics.postRecoveryFinalSegments < MIN_QUALIFICATION_POST_RECOVERY_FINAL_SEGMENTS ||
      report.metrics.postRecoveryPlaybackCycles < 1) {
    throw new Error('I3 real-audio qualification metrics are incomplete')
  }
  exactKeys(report.crashRecovery, ['recoveredSessionCount', 'recoveredSessionTerminal', 'recoveryStatus', 'separateMainProcessForcedExit'], 'crashRecovery')
  if (report.crashRecovery.recoveredSessionCount !== 1 || report.crashRecovery.recoveryStatus !== 'committed' ||
      report.crashRecovery.recoveredSessionTerminal !== true || report.crashRecovery.separateMainProcessForcedExit !== true) {
    throw new Error('I3 real-audio qualification recovery evidence is incomplete')
  }
  exactKeys(report.environment, ['electron', 'node'], 'environment')
  nonEmptyVersion(report.environment.electron, 'environment.electron')
  nonEmptyVersion(report.environment.node, 'environment.node')
  validateModelEvidence(report.model)
  validateExports(report.exports)
  if (Object.values(report.exports).some((item) => item.recordCount !== report.metrics.finalSegments)) {
    throw new Error('I3 real-audio qualification exports are incomplete')
  }
  validateTransport(report.transport)
  validateStimulus(report.stimulus)
  validateProvenance(report.provenance)
  assertPrivacyAndNoLeak(report.privacy, report)
  exactKeys(report.progress, ['soakId', 'statusWindowDragRequired', 'workerCrashInjectionRequired'], 'progress')
  if (!/^[a-f0-9]{24}$/.test(report.progress.soakId || '') || report.progress.statusWindowDragRequired !== false ||
      report.progress.workerCrashInjectionRequired !== true) throw new Error('I3 real-audio qualification progress evidence is invalid')
  exactKeys(report.window, ['heartbeatCount', 'nativeDragObserved', 'rendered', 'visibleAtCompletion'], 'window')
  positiveInteger(report.window.heartbeatCount, 'window.heartbeatCount')
  if (report.window.rendered !== true || report.window.visibleAtCompletion !== true) {
    throw new Error('I3 real-audio qualification BrowserWindow evidence is incomplete')
  }
  return report
}

function readAndValidateI3LiveAudioQualificationReport (reportPath) {
  const resolved = path.resolve(reportPath)
  return validateI3LiveAudioQualificationReport(
    parseStrictEvidenceJson(fs.readFileSync(resolved), `I3 qualification report ${path.basename(resolved)}`)
  )
}

if (require.main === module) {
  const qualification = process.argv[2] === '--qualification'
  if ((qualification && process.argv.length !== 4) || (!qualification && process.argv.length !== 3)) {
    throw new Error('usage: node scripts/verify-i3-live-audio-report.js [--qualification] <report.json>')
  }
  const report = qualification
    ? readAndValidateI3LiveAudioQualificationReport(process.argv[3])
    : readAndValidateI3LiveAudioReport(process.argv[2])
  process.stdout.write(JSON.stringify({ mode: report.mode, result: report.result, sourceId: report.stimulus.sourceId }) + '\n')
}

module.exports = {
  readAndValidateI3LiveAudioReport,
  readAndValidateI3LiveAudioQualificationReport,
  validateI3LiveAudioQualificationReport,
  validateI3LiveAudioReport
}
