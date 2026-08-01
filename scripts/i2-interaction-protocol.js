'use strict'

/*
 * Shared, pure protocol for the executable I2 interaction scenarios.
 *
 * The Electron runner owns real media/worker/UI work.  This module owns the
 * report shape, privacy boundary, transport snapshots and DWM hand-off files,
 * so all of those can be unit-tested without launching Electron or touching a
 * microphone, loopback device, speaker, network or desktop window.
 */

const assert = require('node:assert/strict')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')

const SCENARIOS = Object.freeze(['pause-refine', 'worker-crash-retry', 'dwm-drag'])
const SOURCES = Object.freeze(['loopback', 'mic'])
const TRANSPORT_FIELDS = Object.freeze([
  'capturedFrames', 'sentFrames', 'ingestedFrames', 'droppedFrames',
  'creditStalls', 'maxQueuedMsObserved', 'acknowledgedFrames',
  'lostInFlightFrames', 'portReplacements', 'queuedFramesAtStop',
  'queuedMsAtStop', 'discardedAtStop', 'sequenceGapCount', 'missedFrames',
  'badSampleTypeFrames', 'droppedCaptionCount'
])
const LOSS_FIELDS = Object.freeze([
  'droppedFrames', 'lostInFlightFrames', 'sequenceGapCount', 'missedFrames',
  'badSampleTypeFrames', 'droppedCaptionCount'
])
const PROGRESS_STATES = Object.freeze([
  'starting', 'ready-for-dwm-drag', 'awaiting-operator-completion', 'completed', 'failed'
])
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function assertPlainRecord (value, label) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  assert.ok(prototype === Object.prototype || prototype === null, `${label} must be a plain object`)
}

function assertExactKeys (value, keys, label) {
  assertPlainRecord(value, label)
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has missing or unknown fields`)
}

function assertNonNegativeInteger (value, label) {
  assert.equal(typeof value, 'number', `${label} must be a number`)
  assert.ok(Number.isSafeInteger(value) && value >= 0, `${label} must be a non-negative safe integer`)
}

function assertNullableNonNegativeInteger (value, label) {
  if (value === null) return
  assertNonNegativeInteger(value, label)
}

function assertIsoTimestamp (value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  assert.match(value, ISO_TIMESTAMP_PATTERN, `${label} must be canonical UTC ISO time`)
  const epoch = Date.parse(value)
  assert.ok(Number.isFinite(epoch) && new Date(epoch).toISOString() === value, `${label} must be valid ISO time`)
}

function inspectSafeValue (value, keyPath = 'report') {
  if (typeof value === 'string') {
    assert.doesNotMatch(value, /(?:[A-Za-z]:[\\/]|^\\\\|file:\/\/|\/(?:Users|home|tmp|var|etc|mnt)\/)/i,
      `${keyPath} must not expose a local path`)
    assert.doesNotMatch(value, /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)(?:$|[?#\s])/i,
      `${keyPath} must not reference an audio file`)
    assert.doesNotMatch(value, /^data:audio\//i, `${keyPath} must not embed audio data`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectSafeValue(entry, `${keyPath}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    assert.doesNotMatch(key,
      /^(?:capturedPcmBase64|pcm(?:16)?Base64|samples|audioBase64|audioFile|audioFilePath|transcript|transcriptText|captionText|joinedFinalText|joinedRefinedText|deviceLabel|deviceName|localPath|modelDir|modelPath|text)$/i,
      `${keyPath}.${key} is a forbidden sensitive field`)
    inspectSafeValue(nested, `${keyPath}.${key}`)
  }
}

function assertSafeInteractionValue (value) {
  inspectSafeValue(value)
  const serialized = JSON.stringify(value)
  assert.doesNotMatch(serialized,
    /(?:"text"\s*:|captionArrivals|capturedPcmBase64|pcm16Base64|deviceLabel|modelDir|modelPath)/i,
    'interaction evidence must contain no caption text, PCM, device label or model path')
}

function parseArguments (argv) {
  const options = {
    scenario: null,
    source: null,
    report: null,
    progress: null,
    completion: null,
    physicalMicPreflight: null,
    timeoutSeconds: 90
  }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!['--scenario', '--source', '--report', '--progress', '--completion', '--physical-mic-preflight', '--timeout-seconds'].includes(flag)) {
      throw new Error(`Unknown argument: ${flag}`)
    }
    if (seen.has(flag)) throw new Error(`${flag} must be provided at most once`)
    seen.add(flag)
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    index += 1
    if (flag === '--scenario') options.scenario = value
    else if (flag === '--source') options.source = value
    else if (flag === '--report') options.report = value
    else if (flag === '--progress') options.progress = value
    else if (flag === '--completion') options.completion = value
    else if (flag === '--physical-mic-preflight') options.physicalMicPreflight = value
    else options.timeoutSeconds = Number(value)
  }
  if (!SCENARIOS.includes(options.scenario)) throw new Error(`--scenario must be one of ${SCENARIOS.join(', ')}`)
  if (!SOURCES.includes(options.source)) throw new Error('--source must be loopback or mic')
  if (typeof options.report !== 'string' || options.report.trim().length === 0) throw new Error('--report is required')
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 15 || options.timeoutSeconds > 180) {
    throw new Error('--timeout-seconds must be an integer between 15 and 180')
  }
  if (options.source === 'mic' && !options.physicalMicPreflight) {
    throw new Error('--physical-mic-preflight is required for controlled mic interaction scenarios')
  }
  if (options.source === 'loopback' && options.physicalMicPreflight !== null) {
    throw new Error('--physical-mic-preflight is only valid with --source mic')
  }
  if (options.scenario === 'dwm-drag' && (!options.progress || !options.completion)) {
    throw new Error('dwm-drag requires both --progress and --completion')
  }
  if (options.scenario !== 'dwm-drag' && (options.progress || options.completion)) {
    throw new Error('--progress and --completion are only valid for dwm-drag')
  }
  return options
}

function numberOrNull (value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function transportSnapshot (diagnostics, sourceId) {
  if (!SOURCES.includes(sourceId)) throw new TypeError('sourceId must be loopback or mic')
  const capture = diagnostics?.capture?.[sourceId] || {}
  const worker = diagnostics?.worker || {}
  const source = worker?.sources?.[sourceId] || {}
  return {
    capturedFrames: numberOrNull(capture.capturedFrames),
    sentFrames: numberOrNull(capture.sentFrames),
    ingestedFrames: numberOrNull(source.framesIngested),
    droppedFrames: numberOrNull(capture.droppedFrames),
    creditStalls: numberOrNull(capture.creditStalls),
    maxQueuedMsObserved: numberOrNull(capture.maxQueuedMsObserved),
    acknowledgedFrames: numberOrNull(capture.acknowledgedFrames),
    lostInFlightFrames: numberOrNull(capture.lostInFlightFrames),
    portReplacements: numberOrNull(capture.portReplacements),
    queuedFramesAtStop: numberOrNull(capture.queuedFrames),
    queuedMsAtStop: numberOrNull(capture.queuedMs),
    discardedAtStop: numberOrNull(capture.discardedAtStop),
    sequenceGapCount: numberOrNull(source.sequenceGapCount),
    missedFrames: numberOrNull(source.missedFrames),
    badSampleTypeFrames: numberOrNull(worker.badSampleTypeFrames ?? source.badSampleTypeFrames),
    droppedCaptionCount: numberOrNull(diagnostics?.droppedCaptionCount)
  }
}

function transportDelta (before, after, comparable) {
  validateTransportSnapshot(before, 'before transport')
  validateTransportSnapshot(after, 'after transport')
  if (!comparable) return null
  return Object.fromEntries(TRANSPORT_FIELDS.map((field) => {
    const beforeValue = before[field]
    const afterValue = after[field]
    return [field, beforeValue === null || afterValue === null ? null : afterValue - beforeValue]
  }))
}

function validateTransportSnapshot (value, label) {
  assertExactKeys(value, TRANSPORT_FIELDS, label)
  for (const field of TRANSPORT_FIELDS) assertNullableNonNegativeInteger(value[field], `${label}.${field}`)
}

function buildDwmProgress ({ sourceId, state, transport, operatorCompletionObserved }) {
  if (!SOURCES.includes(sourceId)) throw new TypeError('progress sourceId is invalid')
  if (!PROGRESS_STATES.includes(state)) throw new TypeError('progress state is invalid')
  validateTransportSnapshot(transport.before, 'progress transport.before')
  validateTransportSnapshot(transport.after, 'progress transport.after')
  if (transport.delta !== null) validateTransportDelta(transport.delta, 'progress transport.delta')
  return {
    schemaVersion: 1,
    kind: 'i2-dwm-drag-progress',
    scenario: 'dwm-drag',
    sourceId,
    state,
    operatorCompletionObserved: operatorCompletionObserved === true,
    transport
  }
}

function validateTransportDelta (value, label) {
  assertExactKeys(value, TRANSPORT_FIELDS, label)
  for (const field of TRANSPORT_FIELDS) {
    const entry = value[field]
    if (entry === null) continue
    assert.equal(typeof entry, 'number', `${label}.${field} must be number or null`)
    assert.ok(Number.isSafeInteger(entry), `${label}.${field} must be a safe integer`)
  }
}

function validateDwmProgress (value) {
  assertSafeInteractionValue(value)
  assertExactKeys(value, [
    'schemaVersion', 'kind', 'scenario', 'sourceId', 'state', 'operatorCompletionObserved', 'transport'
  ], 'DWM progress')
  assert.equal(value.schemaVersion, 1)
  assert.equal(value.kind, 'i2-dwm-drag-progress')
  assert.equal(value.scenario, 'dwm-drag')
  assert.ok(SOURCES.includes(value.sourceId))
  assert.ok(PROGRESS_STATES.includes(value.state))
  assert.equal(typeof value.operatorCompletionObserved, 'boolean')
  assertExactKeys(value.transport, ['comparison', 'before', 'after', 'delta'], 'DWM progress.transport')
  assert.equal(value.transport.comparison, 'same-capture-generation')
  validateTransportSnapshot(value.transport.before, 'DWM progress.transport.before')
  validateTransportSnapshot(value.transport.after, 'DWM progress.transport.after')
  validateTransportDelta(value.transport.delta, 'DWM progress.transport.delta')
  return value
}

function parseOperatorCompletion (bytes) {
  const value = parseStrictEvidenceJson(bytes, 'DWM operator completion')
  assertSafeInteractionValue(value)
  assertExactKeys(value, ['schemaVersion', 'kind', 'scenario', 'observed'], 'DWM operator completion')
  assert.equal(value.schemaVersion, 1)
  assert.equal(value.kind, 'i2-dwm-drag-operator-completion')
  assert.equal(value.scenario, 'dwm-drag')
  assert.equal(value.observed, true, 'operator completion must explicitly record observed=true')
  return value
}

function buildInteractionReport ({
  executedAt,
  scenario,
  sourceId,
  result,
  runtime,
  counts,
  scenarioEvidence,
  transport,
  deviceRecovery
}) {
  return {
    schemaVersion: 1,
    kind: 'i2-live-interaction',
    executedAt,
    scenario,
    sourceId,
    result,
    runtime,
    counts,
    scenarioEvidence,
    transport,
    deviceRecovery,
    privacy: {
      capturedAudioPersisted: false,
      reportContainsTranscriptText: false,
      reportContainsAudioPath: false,
      reportContainsDeviceName: false
    },
    limitations: [
      'This interaction report does not attest physical device removal or OS sleep/wake.',
      'No captured audio, transcript text, device name, model path, or local audio path is persisted in this evidence.'
    ]
  }
}

function validateRuntime (runtime) {
  assertExactKeys(runtime, ['modelId', 'profile', 'vad', 'refinement', 'sqliteSessionRecorder'], 'runtime')
  assert.equal(runtime.modelId, 'x-asr-160ms')
  assert.equal(runtime.profile, 'fast')
  assert.equal(runtime.vad, 'silero')
  assert.equal(runtime.refinement, 'x-asr-offline')
  assert.equal(runtime.sqliteSessionRecorder, true)
}

function validateCounts (counts) {
  assertExactKeys(counts, ['captions', 'partials', 'finals', 'refined'], 'counts')
  for (const field of Object.keys(counts)) assertNonNegativeInteger(counts[field], `counts.${field}`)
  assert.equal(counts.captions, counts.partials + counts.finals + counts.refined)
}

function validateDeviceRecovery (value) {
  assertExactKeys(value, [
    'simulatedTrackEnded', 'actualOsDeviceRemoval', 'actualSystemSleepWake', 'networkRecoveryNotApplicable'
  ], 'deviceRecovery')
  assert.deepEqual(value, {
    simulatedTrackEnded: false,
    actualOsDeviceRemoval: false,
    actualSystemSleepWake: false,
    networkRecoveryNotApplicable: true
  })
}

function validateInteractionTransport (transport, scenario, result) {
  assertExactKeys(transport, ['comparison', 'before', 'after', 'delta'], 'transport')
  const expectedComparison = scenario === 'worker-crash-retry'
    ? 'cross-recovery-generation'
    : 'same-capture-generation'
  assert.equal(transport.comparison, expectedComparison)
  validateTransportSnapshot(transport.before, 'transport.before')
  validateTransportSnapshot(transport.after, 'transport.after')
  if (expectedComparison === 'same-capture-generation') {
    validateTransportDelta(transport.delta, 'transport.delta')
  } else {
    assert.equal(transport.delta, null, 'cross-generation transport delta must not pretend to be comparable')
  }
  if (result === 'pass' || result === 'pass-manual-observed') {
    assertNonNegativeInteger(transport.after.capturedFrames, 'transport.after.capturedFrames')
    assert.ok(transport.after.capturedFrames > 0, 'transport.after.capturedFrames must be positive')
    assertNonNegativeInteger(transport.after.sentFrames, 'transport.after.sentFrames')
    for (const field of LOSS_FIELDS) assert.equal(transport.after[field], 0, `transport.after.${field} must be zero`)
  }
}

function validateScenarioEvidence (scenario, value, result) {
  if (scenario === 'pause-refine') {
    assertExactKeys(value, [
      'pauseAcknowledged', 'resumeAcknowledged', 'finalBeforePause', 'refinementPendingAtPause',
      'refinedWhilePaused', 'refinedAfterResume'
    ], 'scenarioEvidence')
    assert.equal(typeof value.pauseAcknowledged, 'boolean')
    assert.equal(typeof value.resumeAcknowledged, 'boolean')
    assertNonNegativeInteger(value.finalBeforePause, 'scenarioEvidence.finalBeforePause')
    assertNonNegativeInteger(value.refinementPendingAtPause, 'scenarioEvidence.refinementPendingAtPause')
    assertNonNegativeInteger(value.refinedWhilePaused, 'scenarioEvidence.refinedWhilePaused')
    assertNonNegativeInteger(value.refinedAfterResume, 'scenarioEvidence.refinedAfterResume')
    if (result === 'pass') {
      assert.equal(value.pauseAcknowledged, true)
      assert.equal(value.resumeAcknowledged, true)
      assert.ok(value.finalBeforePause > 0)
      assert.ok(value.refinementPendingAtPause > 0, 'a real refinement request must still be pending at pause')
      assert.equal(value.refinedWhilePaused, 0)
      assert.ok(value.refinedAfterResume > 0)
    }
    return
  }
  if (scenario === 'worker-crash-retry') {
    assertExactKeys(value, [
      'crashMethod', 'workerExitObserved', 'retrySucceeded', 'sameSession', 'runtimeAdapterReusedAfterRetry',
      'freshWorkerGenerationAfterRetry', 'workerGenerationCount',
      'finalBeforeCrash', 'finalAfterRetry'
    ], 'scenarioEvidence')
    assert.equal(value.crashMethod, 'forced-exact-realtime-worker-termination')
    assert.equal(typeof value.workerExitObserved, 'boolean')
    assert.equal(typeof value.retrySucceeded, 'boolean')
    assert.equal(typeof value.sameSession, 'boolean')
    assert.equal(typeof value.runtimeAdapterReusedAfterRetry, 'boolean')
    assert.equal(typeof value.freshWorkerGenerationAfterRetry, 'boolean')
    assertNonNegativeInteger(value.workerGenerationCount, 'scenarioEvidence.workerGenerationCount')
    assertNonNegativeInteger(value.finalBeforeCrash, 'scenarioEvidence.finalBeforeCrash')
    assertNonNegativeInteger(value.finalAfterRetry, 'scenarioEvidence.finalAfterRetry')
    if (result === 'pass') {
      assert.equal(value.workerExitObserved, true)
      assert.equal(value.retrySucceeded, true)
      assert.equal(value.sameSession, true)
      assert.equal(value.runtimeAdapterReusedAfterRetry, true)
      assert.equal(value.freshWorkerGenerationAfterRetry, true)
      assert.ok(value.workerGenerationCount >= 2)
      assert.ok(value.finalBeforeCrash > 0)
      assert.ok(value.finalAfterRetry > 0)
    }
    return
  }
  assertExactKeys(value, [
    'mode', 'rendererAssets', 'manualSetBounds', 'operatorCompletionObserved'
  ], 'scenarioEvidence')
  assert.equal(value.mode, 'manual-dwm-harness')
  assert.equal(value.rendererAssets, 'caption-toolbar')
  assert.equal(value.manualSetBounds, true)
  assert.equal(typeof value.operatorCompletionObserved, 'boolean')
  if (result === 'pass-manual-observed') assert.equal(value.operatorCompletionObserved, true)
}

function validateInteractionReport (report, expectedScenario = null) {
  assertSafeInteractionValue(report)
  assertExactKeys(report, [
    'schemaVersion', 'kind', 'executedAt', 'scenario', 'sourceId', 'result', 'runtime', 'counts',
    'scenarioEvidence', 'transport', 'deviceRecovery', 'privacy', 'limitations'
  ], 'interaction report')
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.kind, 'i2-live-interaction')
  assertIsoTimestamp(report.executedAt, 'executedAt')
  assert.ok(SCENARIOS.includes(report.scenario), 'scenario is invalid')
  if (expectedScenario !== null) assert.equal(report.scenario, expectedScenario)
  assert.ok(SOURCES.includes(report.sourceId), 'sourceId is invalid')
  const allowedResults = report.scenario === 'dwm-drag'
    ? ['pass-manual-observed', 'inconclusive-manual-observation', 'fail']
    : ['pass', 'fail']
  assert.ok(allowedResults.includes(report.result), 'result is invalid for scenario')
  validateRuntime(report.runtime)
  validateCounts(report.counts)
  validateScenarioEvidence(report.scenario, report.scenarioEvidence, report.result)
  validateInteractionTransport(report.transport, report.scenario, report.result)
  validateDeviceRecovery(report.deviceRecovery)
  assert.deepEqual(report.privacy, {
    capturedAudioPersisted: false,
    reportContainsTranscriptText: false,
    reportContainsAudioPath: false,
    reportContainsDeviceName: false
  })
  assert.deepEqual(report.limitations, [
    'This interaction report does not attest physical device removal or OS sleep/wake.',
    'No captured audio, transcript text, device name, model path, or local audio path is persisted in this evidence.'
  ])
  return report
}

module.exports = {
  LOSS_FIELDS,
  PROGRESS_STATES,
  SCENARIOS,
  SOURCES,
  TRANSPORT_FIELDS,
  assertSafeInteractionValue,
  buildDwmProgress,
  buildInteractionReport,
  parseArguments,
  parseOperatorCompletion,
  transportDelta,
  transportSnapshot,
  validateDwmProgress,
  validateInteractionReport,
  validateTransportSnapshot
}
