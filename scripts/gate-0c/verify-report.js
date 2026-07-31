'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { parseStrictEvidenceJson } = require('../strict-evidence-json')
const {
  analyzeSamples,
  evaluateCaptureChecks,
  evaluateGate0CDecision,
  formatPasses,
  parsePcm16Wav,
  sha256
} = require('./audio-utils')

function parseArguments (argv) {
  const options = { workDir: null, report: null }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    if (argv[index] === '--work-dir' || argv[index] === '--artifact-dir') { options.workDir = value; index += 1 } else if (argv[index] === '--report') { options.report = value; index += 1 } else throw new Error(`Unknown argument: ${argv[index]}`)
  }
  if (!options.report) throw new Error('--report is required')
  return options
}

function assertNoPersistedPayload (value) {
  const forbiddenKeys = /^(?:capturedPcmBase64|pcmBase64|rawPcm|samples|transcript|text|deviceLabel|audioPath|path|file|artifact)$/i
  const visit = (item) => {
    if (Array.isArray(item)) {
      for (const child of item) visit(child)
      return
    }
    if (!item || typeof item !== 'object') return
    for (const [key, child] of Object.entries(item)) {
      assert.doesNotMatch(key, forbiddenKeys, `Gate 0C metrics report contains forbidden persisted field: ${key}`)
      visit(child)
    }
  }
  visit(value)
}

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const VERSION_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,6}(?:\.\d{1,6})?(?:-(?:alpha|beta|rc)\.\d{1,4})?$/
const WINDOWS_RELEASE_PATTERN = /^\d{1,3}(?:\.\d{1,10}){2,3}$/
const WINDOWS_VERSION_PATTERN = /^Windows (?:(?:10|11) (?:Home|Pro|Enterprise|Education|Pro Education|Pro for Workstations)|Server (?:2016|2019|2022|2025) (?:Standard|Datacenter))$/
const CANONICAL_UTC_MILLISECOND_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const RUN_ID_PATTERN = /^gate-0c-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/
const DECISION_NOTE = 'The display handler observed a real userGesture on the hidden host and each in-memory source probe passed signal, clipping, and continuity checks.'
const PRIVACY_NOTE = 'Captured samples are analyzed in memory and released; only structured settings, counters, and signal metrics are reported.'
const VISIBILITY_STAGES = Object.freeze([
  'ready',
  'before-user-gesture-trigger',
  'loopback:first-pcm',
  'mic:first-pcm',
  'mic-probe:first-pcm',
  'after-no-gesture-probe',
  'complete'
])

function assertPlainObjectWithExactKeys (value, expectedKeys, label) {
  const prototype = value && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (prototype === Object.prototype || prototype === null), `${label} must be a plain object`)
  const keys = Reflect.ownKeys(value)
  assert.ok(keys.every((key) => typeof key === 'string'), `${label} must not contain symbol keys`)
  assert.deepEqual([...keys].sort(), [...expectedKeys].sort(), `${label} must contain exactly the schema keys`)
}

function assertClosedArray (value, label, maximumLength = 1000) {
  assert.ok(Array.isArray(value) && Object.getPrototypeOf(value) === Array.prototype, `${label} must be an array`)
  assert.ok(Number.isSafeInteger(value.length) && value.length <= maximumLength, `${label} is too large`)
  const expectedKeys = ['length', ...Array.from({ length: value.length }, (_, index) => String(index))]
  const keys = Reflect.ownKeys(value)
  assert.ok(keys.every((key) => typeof key === 'string'), `${label} must not contain symbol keys`)
  assert.deepEqual([...keys].sort(), expectedKeys.sort(), `${label} must be dense and contain no extra properties`)
}

function assertBoolean (value, label) {
  assert.equal(typeof value, 'boolean', `${label} must be a boolean`)
}

function assertFiniteNumber (value, label, options = {}) {
  assert.ok(typeof value === 'number' && Number.isFinite(value), `${label} must be a finite number`)
  if (options.minimum !== undefined) assert.ok(value >= options.minimum, `${label} must be at least ${options.minimum}`)
  if (options.maximum !== undefined) assert.ok(value <= options.maximum, `${label} must be at most ${options.maximum}`)
}

function assertSafeInteger (value, label, options = {}) {
  assert.ok(Number.isSafeInteger(value), `${label} must be a safe integer`)
  if (options.minimum !== undefined) assert.ok(value >= options.minimum, `${label} must be at least ${options.minimum}`)
  if (options.maximum !== undefined) assert.ok(value <= options.maximum, `${label} must be at most ${options.maximum}`)
}

function assertEnum (value, allowed, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  assert.ok(allowed.includes(value), `${label} is not an allowed value`)
}

function assertPattern (value, pattern, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  assert.match(value, pattern, `${label} does not use the required canonical format`)
}

function assertCanonicalUtcTimestamp (value, label) {
  assertPattern(value, CANONICAL_UTC_MILLISECOND_PATTERN, label)
  const milliseconds = Date.parse(value)
  assert.ok(Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value, `${label} must be a real canonical UTC millisecond timestamp`)
  return milliseconds
}

function validateRunIdentity (report) {
  const match = typeof report.runId === 'string' ? RUN_ID_PATTERN.exec(report.runId) : null
  assert.ok(match, 'Gate 0C runId must match gate-0c-YYYY-MM-DDTHH-mm-ss-SSSZ')
  const runTimestamp = `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`
  const runMilliseconds = assertCanonicalUtcTimestamp(runTimestamp, 'Gate 0C runId timestamp')
  assert.equal(`gate-0c-${runTimestamp.replace(/[:.]/g, '-')}`, report.runId, 'Gate 0C runId must be canonical')
  const executedMilliseconds = assertCanonicalUtcTimestamp(report.executedAt, 'Gate 0C executedAt')
  assert.ok(runMilliseconds <= executedMilliseconds, 'Gate 0C runId must not postdate executedAt')
  assert.ok(executedMilliseconds - runMilliseconds <= 30 * 60 * 1000, 'Gate 0C runId and executedAt must belong to one bounded run')
}

function validateEnvironment (environment) {
  assertPlainObjectWithExactKeys(environment, ['platform', 'osRelease', 'osVersion', 'electron', 'chromium', 'node'], 'environment')
  assert.equal(environment.platform, 'win32', 'environment.platform must identify the supported Gate 0C platform')
  assertPattern(environment.osRelease, WINDOWS_RELEASE_PATTERN, 'environment.osRelease')
  assertPattern(environment.osVersion, WINDOWS_VERSION_PATTERN, 'environment.osVersion')
  for (const key of ['electron', 'chromium', 'node']) assertPattern(environment[key], VERSION_PATTERN, `environment.${key}`)
}

function validateTestSignal (testSignal) {
  assertPlainObjectWithExactKeys(testSignal, ['id', 'frequencyHz', 'amplitude', 'startDelayMs', 'durationMs', 'fadeMs'], 'testSignal')
  assert.equal(testSignal.id, 'independent-player-sine-v1')
  assert.equal(testSignal.frequencyHz, 997)
  assert.equal(testSignal.amplitude, 0.12)
  assert.equal(testSignal.startDelayMs, 350)
  assert.equal(testSignal.durationMs, 1000)
  assert.equal(testSignal.fadeMs, 40)
}

function validateActivation (activation, label, expected) {
  assertPlainObjectWithExactKeys(activation, ['isActive', 'hasBeenActive'], label)
  assertBoolean(activation.isActive, `${label}.isActive`)
  assertBoolean(activation.hasBeenActive, `${label}.hasBeenActive`)
  assert.deepEqual(activation, expected, `${label} does not match the fixed activation state`)
}

function validateWindow (window) {
  assertPlainObjectWithExactKeys(window, ['showConfigured', 'backgroundThrottling', 'visibility'], 'window')
  assert.equal(window.showConfigured, false)
  assert.equal(window.backgroundThrottling, false)
  assertClosedArray(window.visibility, 'window.visibility', VISIBILITY_STAGES.length)
  assert.equal(window.visibility.length, VISIBILITY_STAGES.length, 'window.visibility must contain the seven fixed lifecycle events')
  for (let index = 0; index < VISIBILITY_STAGES.length; index += 1) {
    const event = window.visibility[index]
    const label = `window.visibility[${index}]`
    assertPlainObjectWithExactKeys(event, ['stage', 'visible', 'detail'], label)
    assert.equal(event.stage, VISIBILITY_STAGES[index], `${label}.stage must follow the fixed lifecycle order`)
    assert.equal(event.visible, false, `${label}.visible must remain false`)
    if (event.stage.endsWith(':first-pcm')) {
      assertPlainObjectWithExactKeys(event.detail, ['sequence'], `${label}.detail`)
      assertSafeInteger(event.detail.sequence, `${label}.detail.sequence`, { minimum: 0 })
      assert.equal(event.detail.sequence, 0, `${label}.detail.sequence must identify the first worklet frame`)
    } else {
      assert.equal(event.detail, null, `${label}.detail must be null`)
    }
  }
}

function validatePermissions (permissions) {
  assertPlainObjectWithExactKeys(permissions, ['microphoneBefore', 'screenBefore', 'checks', 'requests'], 'permissions')
  const statuses = ['not-determined', 'granted', 'denied', 'restricted', 'unknown']
  assertEnum(permissions.microphoneBefore, statuses, 'permissions.microphoneBefore')
  assertEnum(permissions.screenBefore, statuses, 'permissions.screenBefore')
  assertClosedArray(permissions.checks, 'permissions.checks')
  for (let index = 0; index < permissions.checks.length; index += 1) {
    const check = permissions.checks[index]
    const label = `permissions.checks[${index}]`
    assertPlainObjectWithExactKeys(check, ['permission', 'origin', 'allowed', 'mediaType'], label)
    assertEnum(check.permission, ['media', 'speaker-selection', 'geolocation', 'web-app-installation'], `${label}.permission`)
    assertEnum(check.origin, ['', 'file://'], `${label}.origin`)
    assertBoolean(check.allowed, `${label}.allowed`)
    if (check.mediaType !== null) assertEnum(check.mediaType, ['audio', 'video'], `${label}.mediaType`)
  }
  assertClosedArray(permissions.requests, 'permissions.requests')
  for (let index = 0; index < permissions.requests.length; index += 1) {
    const request = permissions.requests[index]
    const label = `permissions.requests[${index}]`
    assertPlainObjectWithExactKeys(request, ['permission', 'origin', 'allowed', 'mediaTypes'], label)
    assertEnum(request.permission, ['media', 'speaker-selection'], `${label}.permission`)
    assert.equal(request.origin, 'file://', `${label}.origin must be the sanitized local origin`)
    assertBoolean(request.allowed, `${label}.allowed`)
    assertClosedArray(request.mediaTypes, `${label}.mediaTypes`, 2)
    for (let mediaIndex = 0; mediaIndex < request.mediaTypes.length; mediaIndex += 1) {
      assertEnum(request.mediaTypes[mediaIndex], ['audio', 'video'], `${label}.mediaTypes[${mediaIndex}]`)
    }
    assert.equal(new Set(request.mediaTypes).size, request.mediaTypes.length, `${label}.mediaTypes must not contain duplicates`)
  }
}

function validateHiddenGestureControl (control) {
  assertPlainObjectWithExactKeys(control, ['status', 'activation', 'stream'], 'hiddenGestureControl')
  assert.equal(control.status, 'resolved')
  validateActivation(control.activation, 'hiddenGestureControl.activation', { isActive: false, hasBeenActive: true })
  assertPlainObjectWithExactKeys(control.stream, ['audioTrackCount', 'videoTrackCountBeforeStop', 'audioReadyStateAfterVideoStop'], 'hiddenGestureControl.stream')
  assert.equal(control.stream.audioTrackCount, 1)
  assert.equal(control.stream.videoTrackCountBeforeStop, 1)
  assert.equal(control.stream.audioReadyStateAfterVideoStop, 'live')
}

function validateDisplayRequests (requests) {
  assertClosedArray(requests, 'displayRequests', 2)
  assert.equal(requests.length, 2, 'displayRequests must contain the gesture and no-gesture probes')
  for (let index = 0; index < requests.length; index += 1) {
    const request = requests[index]
    const label = `displayRequests[${index}]`
    assertPlainObjectWithExactKeys(request, ['securityOrigin', 'videoRequested', 'audioRequested', 'userGesture', 'frameMatchedHost', 'hostVisible', 'callbackAudio', 'callbackVideoSourceType', 'error', 'availableScreenSourceCount'], label)
    assert.equal(request.securityOrigin, 'file://')
    assert.equal(request.videoRequested, true)
    assert.equal(request.audioRequested, true)
    assertBoolean(request.userGesture, `${label}.userGesture`)
    assert.equal(request.userGesture, index === 0, `${label}.userGesture does not match its fixed probe position`)
    assert.equal(request.frameMatchedHost, true)
    assert.equal(request.hostVisible, false)
    assert.equal(request.callbackAudio, 'loopback')
    assert.equal(request.callbackVideoSourceType, 'screen')
    assert.equal(request.error, null)
    assertSafeInteger(request.availableScreenSourceCount, `${label}.availableScreenSourceCount`, { minimum: 1 })
  }
}

function validateTrackSettings (settings, label) {
  assertPlainObjectWithExactKeys(settings, ['autoGainControl', 'channelCount', 'echoCancellation', 'latency', 'noiseSuppression', 'sampleRate', 'sampleSize'], label)
  assert.equal(settings.autoGainControl, false)
  assertSafeInteger(settings.channelCount, `${label}.channelCount`, { minimum: 1, maximum: 32 })
  assert.equal(settings.echoCancellation, false)
  assertFiniteNumber(settings.latency, `${label}.latency`, { minimum: 0, maximum: 10 })
  assert.equal(settings.noiseSuppression, false)
  assertSafeInteger(settings.sampleRate, `${label}.sampleRate`, { minimum: 8000, maximum: 384000 })
  assertSafeInteger(settings.sampleSize, `${label}.sampleSize`, { minimum: 8, maximum: 64 })
}

function validateTrack (track, label) {
  assertPlainObjectWithExactKeys(track, ['kind', 'enabled', 'muted', 'readyState', 'labelSha256', 'settings'], label)
  assert.equal(track.kind, 'audio')
  assert.equal(track.enabled, true)
  assert.equal(track.muted, false)
  assert.equal(track.readyState, 'live')
  assertPattern(track.labelSha256, SHA256_PATTERN, `${label}.labelSha256`)
  validateTrackSettings(track.settings, `${label}.settings`)
}

function validatePipeline (pipeline, label) {
  assertPlainObjectWithExactKeys(pipeline, ['inputAudioContextSampleRate', 'outputSampleRate', 'frameSamples', 'frameCount', 'firstSequence', 'fullFrameCount', 'tailFrameSamples', 'sequenceGapCount', 'timestampRegressionCount', 'sampleCount', 'wallElapsedSeconds', 'audioContextElapsedSeconds'], label)
  assertSafeInteger(pipeline.inputAudioContextSampleRate, `${label}.inputAudioContextSampleRate`, { minimum: 8000, maximum: 384000 })
  assert.equal(pipeline.outputSampleRate, 16000)
  assert.equal(pipeline.frameSamples, 1600)
  for (const key of ['frameCount', 'firstSequence', 'fullFrameCount', 'tailFrameSamples', 'sequenceGapCount', 'timestampRegressionCount', 'sampleCount']) {
    assertSafeInteger(pipeline[key], `${label}.${key}`, { minimum: 0 })
  }
  assert.ok(pipeline.frameCount > 0, `${label}.frameCount must be positive`)
  assert.ok(pipeline.fullFrameCount > 0, `${label}.fullFrameCount must be positive`)
  assert.ok(pipeline.tailFrameSamples > 0 && pipeline.tailFrameSamples <= pipeline.frameSamples, `${label}.tailFrameSamples is outside the frame size`)
  const expectedFrameCount = pipeline.fullFrameCount + (pipeline.tailFrameSamples < pipeline.frameSamples ? 1 : 0)
  const expectedSampleCount = (pipeline.fullFrameCount * pipeline.frameSamples) + (pipeline.tailFrameSamples < pipeline.frameSamples ? pipeline.tailFrameSamples : 0)
  assert.equal(pipeline.frameCount, expectedFrameCount, `${label}.frameCount is inconsistent`)
  assert.equal(pipeline.sampleCount, expectedSampleCount, `${label}.sampleCount is inconsistent`)
  assertFiniteNumber(pipeline.wallElapsedSeconds, `${label}.wallElapsedSeconds`, { minimum: Number.EPSILON })
  assertFiniteNumber(pipeline.audioContextElapsedSeconds, `${label}.audioContextElapsedSeconds`, { minimum: Number.EPSILON })
}

function validateAnalysis (analysis, label) {
  assertPlainObjectWithExactKeys(analysis, ['sampleCount', 'durationSeconds', 'peak', 'rms', 'rmsDbfs', 'dcOffset', 'acRms', 'acRmsDbfs', 'nonSilentRatio', 'clippingCount', 'clippedRatio', 'preClampOverRangeCount', 'longestFullScaleRun', 'nonFiniteCount', 'maxAdjacentDelta', 'maxFrameBoundaryDelta', 'probe'], label)
  assertSafeInteger(analysis.sampleCount, `${label}.sampleCount`, { minimum: 1 })
  assertFiniteNumber(analysis.durationSeconds, `${label}.durationSeconds`, { minimum: Number.EPSILON })
  for (const key of ['peak', 'rms', 'acRms', 'maxAdjacentDelta', 'maxFrameBoundaryDelta']) assertFiniteNumber(analysis[key], `${label}.${key}`, { minimum: 0 })
  for (const key of ['rmsDbfs', 'dcOffset', 'acRmsDbfs']) assertFiniteNumber(analysis[key], `${label}.${key}`)
  for (const key of ['nonSilentRatio', 'clippedRatio']) assertFiniteNumber(analysis[key], `${label}.${key}`, { minimum: 0, maximum: 1 })
  for (const key of ['clippingCount', 'preClampOverRangeCount', 'longestFullScaleRun', 'nonFiniteCount']) assertSafeInteger(analysis[key], `${label}.${key}`, { minimum: 0 })
  assert.equal(analysis.durationSeconds, Number((analysis.sampleCount / 16000).toFixed(6)), `${label}.durationSeconds is inconsistent`)
  assert.equal(analysis.clippedRatio, Number((analysis.clippingCount / analysis.sampleCount).toFixed(6)), `${label}.clippedRatio is inconsistent`)

  const probe = analysis.probe
  assertPlainObjectWithExactKeys(probe, ['expectedFrequencyHz', 'observedFrequencyHz', 'frequencyErrorHz', 'amplitude', 'snrDb', 'windowMode', 'analysisWindowStartSeconds', 'analysisWindowDurationSeconds'], `${label}.probe`)
  assert.equal(probe.expectedFrequencyHz, 997)
  assertSafeInteger(probe.observedFrequencyHz, `${label}.probe.observedFrequencyHz`, { minimum: 1 })
  assertSafeInteger(probe.frequencyErrorHz, `${label}.probe.frequencyErrorHz`, { minimum: 0 })
  assert.equal(probe.frequencyErrorHz, Math.abs(probe.observedFrequencyHz - probe.expectedFrequencyHz), `${label}.probe.frequencyErrorHz is inconsistent`)
  assertFiniteNumber(probe.amplitude, `${label}.probe.amplitude`, { minimum: 0 })
  assertFiniteNumber(probe.snrDb, `${label}.probe.snrDb`)
  assert.equal(probe.windowMode, 'scheduled')
  assert.equal(probe.analysisWindowStartSeconds, 0.25)
  assert.equal(probe.analysisWindowDurationSeconds, 1.2)
}

function validateChecks (checks, sourceId, analysis, pipeline, label) {
  assertPlainObjectWithExactKeys(checks, ['clockCoverageRatio', 'pipelinePass', 'noClipping', 'noLargeDiscontinuity', 'signalPresent', 'probeDetected', 'probeRequired', 'pass', 'bufferPass'], label)
  assertFiniteNumber(checks.clockCoverageRatio, `${label}.clockCoverageRatio`, { minimum: 0.9, maximum: 1.1 })
  assert.equal(checks.clockCoverageRatio, Number((analysis.durationSeconds / pipeline.wallElapsedSeconds).toFixed(6)), `${label}.clockCoverageRatio is inconsistent`)
  for (const key of ['pipelinePass', 'noClipping', 'noLargeDiscontinuity', 'signalPresent', 'probeDetected', 'probeRequired', 'pass', 'bufferPass']) assertBoolean(checks[key], `${label}.${key}`)
  assert.equal(checks.pipelinePass, true)
  assert.equal(checks.noClipping, true)
  assert.equal(checks.noLargeDiscontinuity, true)
  assert.equal(checks.signalPresent, true)
  assert.equal(checks.probeDetected, true)
  assert.equal(checks.probeRequired, sourceId !== 'mic')
  assert.equal(checks.pass, true)
  assert.equal(checks.bufferPass, true)
}

function validateDiagnostic (diagnostic, sourceId, label) {
  assertPlainObjectWithExactKeys(diagnostic, ['buffer', 'inputPreClampOverRangeCount', 'pipeline', 'analysis', 'checks'], label)
  assertPlainObjectWithExactKeys(diagnostic.buffer, ['channels', 'sampleRate', 'sampleCount'], `${label}.buffer`)
  assert.equal(diagnostic.buffer.channels, 1)
  assert.equal(diagnostic.buffer.sampleRate, 16000)
  assertSafeInteger(diagnostic.buffer.sampleCount, `${label}.buffer.sampleCount`, { minimum: 1 })
  assertSafeInteger(diagnostic.inputPreClampOverRangeCount, `${label}.inputPreClampOverRangeCount`, { minimum: 0 })
  validatePipeline(diagnostic.pipeline, `${label}.pipeline`)
  validateAnalysis(diagnostic.analysis, `${label}.analysis`)
  validateChecks(diagnostic.checks, sourceId, diagnostic.analysis, diagnostic.pipeline, `${label}.checks`)
  assert.equal(diagnostic.buffer.sampleCount, diagnostic.pipeline.sampleCount, `${label}.buffer.sampleCount mismatch`)
  assert.equal(diagnostic.analysis.sampleCount, diagnostic.pipeline.sampleCount, `${label}.analysis.sampleCount mismatch`)
  assert.equal(diagnostic.inputPreClampOverRangeCount, diagnostic.analysis.preClampOverRangeCount, `${label}.pre-clamp count mismatch`)
}

const SOURCE_CONFIG = Object.freeze({
  loopback: Object.freeze({ captureKey: 'loopback', selection: null, requestedOutput: 'default', selectedOutput: 'default', outputHasIdentity: false }),
  mic: Object.freeze({ captureKey: 'mic', selection: 'physical-preferred', requestedOutput: 'physical-speaker', selectedOutput: 'physical-speaker-preferred', outputHasIdentity: true }),
  'mic-probe': Object.freeze({ captureKey: 'micProbe', selection: 'virtual-cable', requestedOutput: 'virtual-cable', selectedOutput: 'virtual-cable', outputHasIdentity: true })
})

function validatePlayback (playback, sourceId, config, label) {
  assertPlainObjectWithExactKeys(playback, ['sourceId', 'frequencyHz', 'amplitude', 'startDelayMs', 'durationMs', 'fadeMs', 'outputSampleRate', 'output', 'mainObservedAudible'], label)
  assert.equal(playback.sourceId, sourceId)
  assert.equal(playback.frequencyHz, 997)
  assert.equal(playback.amplitude, 0.12)
  assert.equal(playback.startDelayMs, 350)
  assert.equal(playback.durationMs, 1000)
  assert.equal(playback.fadeMs, 40)
  assertSafeInteger(playback.outputSampleRate, `${label}.outputSampleRate`, { minimum: 8000, maximum: 384000 })
  assertBoolean(playback.mainObservedAudible, `${label}.mainObservedAudible`)
  const outputKeys = config.outputHasIdentity
    ? ['requested', 'selected', 'labelSha256', 'enumeratedAudioOutputCount']
    : ['requested', 'selected']
  assertPlainObjectWithExactKeys(playback.output, outputKeys, `${label}.output`)
  assert.equal(playback.output.requested, config.requestedOutput)
  assert.equal(playback.output.selected, config.selectedOutput)
  if (config.outputHasIdentity) {
    assertPattern(playback.output.labelSha256, SHA256_PATTERN, `${label}.output.labelSha256`)
    assertSafeInteger(playback.output.enumeratedAudioOutputCount, `${label}.output.enumeratedAudioOutputCount`, { minimum: 1 })
  }
}

function validateCaptureSource (source, sourceId, label) {
  const config = SOURCE_CONFIG[sourceId]
  const sourceKeys = sourceId === 'loopback'
    ? ['status', 'stream', 'capture']
    : ['status', 'selection', 'enumeratedAudioInputCount', 'failedCandidateCount', 'stream', 'capture']
  assertPlainObjectWithExactKeys(source, sourceKeys, label)
  assert.equal(source.status, 'ok')
  if (config.selection !== null) {
    assert.equal(source.selection, config.selection)
    assertSafeInteger(source.enumeratedAudioInputCount, `${label}.enumeratedAudioInputCount`, { minimum: 1 })
    assertSafeInteger(source.failedCandidateCount, `${label}.failedCandidateCount`, { minimum: 0 })
  }

  const streamKeys = sourceId === 'loopback'
    ? ['audioTrackCount', 'videoTrackCountBeforeStop', 'audioReadyStateAfterVideoStop', 'track']
    : ['audioTrackCount', 'track']
  assertPlainObjectWithExactKeys(source.stream, streamKeys, `${label}.stream`)
  assert.equal(source.stream.audioTrackCount, 1)
  if (sourceId === 'loopback') {
    assert.equal(source.stream.videoTrackCountBeforeStop, 1)
    assert.equal(source.stream.audioReadyStateAfterVideoStop, 'live')
  }
  validateTrack(source.stream.track, `${label}.stream.track`)

  assertPlainObjectWithExactKeys(source.capture, ['playback', 'pipeline', 'diagnostic'], `${label}.capture`)
  validatePlayback(source.capture.playback, sourceId, config, `${label}.capture.playback`)
  validatePipeline(source.capture.pipeline, `${label}.capture.pipeline`)
  validateDiagnostic(source.capture.diagnostic, sourceId, `${label}.capture.diagnostic`)
  assert.deepEqual(source.capture.pipeline, source.capture.diagnostic.pipeline, `${label}.capture pipeline snapshots differ`)
}

function validateCaptureAndDiagnostics (capture, diagnostics) {
  assertPlainObjectWithExactKeys(capture, ['activationAtInvocation', 'loopback', 'mic', 'micProbe'], 'capture')
  validateActivation(capture.activationAtInvocation, 'capture.activationAtInvocation', { isActive: true, hasBeenActive: true })
  assertPlainObjectWithExactKeys(diagnostics, ['loopback', 'mic', 'mic-probe'], 'diagnostics')
  for (const sourceId of Object.keys(SOURCE_CONFIG)) {
    const config = SOURCE_CONFIG[sourceId]
    validateCaptureSource(capture[config.captureKey], sourceId, `capture.${config.captureKey}`)
    validateDiagnostic(diagnostics[sourceId], sourceId, `diagnostics.${sourceId}`)
    assert.deepEqual(capture[config.captureKey].capture.diagnostic, diagnostics[sourceId], `${sourceId} diagnostic snapshots differ`)
  }
}

function validateDecision (decision) {
  const booleanKeys = ['hiddenThroughout', 'requiredVisibilityStagesPresent', 'displayRequestPass', 'hiddenSchemePass', 'loopbackPass', 'physicalMicrophonePass', 'deterministicMicrophoneProbePass', 'microphonePass', 'diagnosticsComplete', 'toolbarFallbackTested']
  assertPlainObjectWithExactKeys(decision, [...booleanKeys, 'selectedTopology', 'captureInitiator', 'note'], 'decision')
  for (const key of booleanKeys) assertBoolean(decision[key], `decision.${key}`)
  assert.equal(decision.selectedTopology, 'hidden-audio-host')
  assert.equal(decision.captureInitiator, 'main-execute-javascript-user-gesture')
  assert.equal(decision.toolbarFallbackTested, false)
  assert.equal(decision.note, DECISION_NOTE, 'decision.note must be the canonical privacy-reviewed wording')
}

function validatePrivacy (privacy) {
  assertPlainObjectWithExactKeys(privacy, ['rawAudioPersisted', 'absolutePathsCommitted', 'deviceLabelsCommitted', 'note'], 'privacy')
  assert.equal(privacy.rawAudioPersisted, false)
  assert.equal(privacy.absolutePathsCommitted, false)
  assert.equal(privacy.deviceLabelsCommitted, false)
  assert.equal(privacy.note, PRIVACY_NOTE, 'privacy.note must be the canonical privacy-reviewed wording')
}

function validateGate0CMetricsReport (report) {
  assertPlainObjectWithExactKeys(report, ['schemaVersion', 'gate', 'runId', 'executedAt', 'result', 'environment', 'testSignal', 'window', 'permissions', 'hiddenGestureControl', 'displayRequests', 'capture', 'diagnostics', 'decision', 'privacy'], 'Gate 0C report')
  assert.equal(report.schemaVersion, 2)
  assert.equal(report.gate, '0C')
  assert.equal(report.result, 'pass')
  validateRunIdentity(report)
  validateEnvironment(report.environment)
  validateTestSignal(report.testSignal)
  validateWindow(report.window)
  validatePermissions(report.permissions)
  validateHiddenGestureControl(report.hiddenGestureControl)
  validateDisplayRequests(report.displayRequests)
  validateCaptureAndDiagnostics(report.capture, report.diagnostics)
  validateDecision(report.decision)
  validatePrivacy(report.privacy)
  const evaluated = evaluateGate0CDecision({
    capture: report.capture,
    diagnostics: report.diagnostics,
    displayRequests: report.displayRequests,
    visibility: report.window.visibility
  })
  assert.equal(report.result, evaluated.result)
  for (const key of Object.keys(evaluated).filter((key) => key !== 'result')) assert.equal(report.decision[key], evaluated[key], `decision.${key} mismatch`)
  assert.equal(evaluated.result, 'pass')
  assertNoPersistedPayload(report)
  assert.doesNotMatch(JSON.stringify(report), /[A-Za-z]:\\\\|Joshua|A1Project|Speech-Agent2\.0/i)
  return report
}

function main () {
  const options = parseArguments(process.argv.slice(2))
  const report = parseStrictEvidenceJson(fs.readFileSync(path.resolve(options.report)), 'Gate 0C report')
  if (report.schemaVersion === 2) {
    validateGate0CMetricsReport(report)
    process.stdout.write('Gate 0C metrics-only report is internally consistent.\n')
    return
  }

  if (!options.workDir) throw new Error('--work-dir is required for legacy schemaVersion 1 reports')
  const artifactDir = path.resolve(options.workDir)
  for (const sourceId of ['loopback', 'mic', 'mic-probe']) {
    const expected = report.artifacts[sourceId]
    assert.ok(expected, `missing ${sourceId} evidence`)
    assert.equal(path.basename(expected.artifact.file), expected.artifact.file, 'artifact file must be path-free')
    const wav = fs.readFileSync(path.join(artifactDir, expected.artifact.file))
    assert.equal(wav.length, expected.artifact.bytes)
    assert.equal(sha256(wav), expected.artifact.sha256)
    const parsed = parsePcm16Wav(wav)
    const format = Object.fromEntries(Object.keys(expected.format).map((key) => [key, parsed[key]]))
    assert.deepEqual(format, expected.format)
    assert.equal(formatPasses(format), true)
    const analysis = analyzeSamples(
      parsed.samples,
      parsed.sampleRate,
      report.testSignal.frequencyHz,
      expected.pipeline.frameSamples,
      {
        startSeconds: report.testSignal.startDelayMs / 1000,
        durationSeconds: report.testSignal.durationMs / 1000
      }
    )
    assert.deepEqual(analysis, expected.analysis)
    const checks = evaluateCaptureChecks(sourceId, analysis, expected.pipeline, expected.inputPreClampOverRangeCount)
    checks.formatPass = true
    checks.pass = checks.pass && checks.formatPass
    assert.deepEqual(checks, expected.checks)
  }
  assert.notEqual(report.artifacts.loopback.artifact.sha256, report.artifacts.mic.artifact.sha256)
  assert.notEqual(report.artifacts.mic.artifact.sha256, report.artifacts['mic-probe'].artifact.sha256)
  assert.notEqual(report.artifacts.loopback.artifact.sha256, report.artifacts['mic-probe'].artifact.sha256)
  assert.equal(report.capture.mic.selection, 'physical-preferred')
  assert.equal(report.capture.micProbe.selection, 'virtual-cable')
  assert.equal(report.capture.micProbe.capture.playback.output.selected, 'virtual-cable')
  const evaluated = evaluateGate0CDecision({
    capture: report.capture,
    artifacts: report.artifacts,
    displayRequests: report.displayRequests,
    visibility: report.window.visibility
  })
  assert.equal(report.result, evaluated.result)
  for (const key of Object.keys(evaluated).filter((key) => key !== 'result')) assert.equal(report.decision[key], evaluated[key], `decision.${key} mismatch`)
  assert.equal(evaluated.result, 'pass')
  assert.doesNotMatch(JSON.stringify(report), /[A-Za-z]:\\\\|Joshua|A1Project|Speech-Agent2\.0/i)
  process.stdout.write('Legacy Gate 0C artifacts and report match.\n')
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error?.stack || error)
    process.exitCode = 1
  }
}

module.exports = { assertNoPersistedPayload, parseArguments, validateGate0CMetricsReport }
