'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { validateGate0CMetricsReport } = require('./gate-0c/verify-report')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')

const CORPUS_ID = 'zh-en-code-switch'
const CORPUS_SHA256 = 'cf741c91fae04e20ae92193065a24248a1f6ecd20a179c3deaf3d69bc9a6febc'
const REFERENCE_SHA256 = '524198166c72c7480ec0009f433fa79dbf54b0ea9c76180bf98fa36253701cb2'
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

const LOOPBACK_LIMITATIONS = Object.freeze([
  'This is one real loopback run, not a latency percentile study.',
  'This source-specific report does not attest a physical-preferred microphone fixture; use the separate --source mic evidence.'
])

const MIC_ACOUSTIC_LIMITATIONS = Object.freeze([
  'This is one real physical-preferred microphone acoustic-fixture run, not a hardware attestation or latency percentile study.',
  'Physical-preferred is a label heuristic; acoustic geometry and room noise make results machine-specific.',
  'This source-specific run does not replace the separate loopback evidence.'
])

const MIC_OPERATOR_LIMITATIONS = Object.freeze([
  'This is one real operator-spoken microphone run, not a device-class attestation or latency percentile study.',
  'This source-specific run does not replace the separate loopback evidence.'
])

const ROOT_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'executedAt',
  'environment',
  'sourceId',
  'result',
  'model',
  'vad',
  'refinement',
  'stimulus',
  'preflight',
  'input',
  'failures',
  'phases',
  'counts',
  'accuracy',
  'timings',
  'resources',
  'signal',
  'transport',
  'privacy',
  'limitations'
])

const TRANSPORT_KEYS = Object.freeze([
  'capturedFrames',
  'sentFrames',
  'ingestedFrames',
  'droppedFrames',
  'creditStalls',
  'maxQueuedMsObserved',
  'acknowledgedFrames',
  'lostInFlightFrames',
  'portReplacements',
  'queuedFramesAtStop',
  'queuedMsAtStop',
  'discardedAtStop',
  'sequenceGapCount',
  'missedFrames',
  'badSampleTypeFrames',
  'droppedCaptionCount'
])

const ZERO_TRANSPORT_KEYS = Object.freeze([
  'droppedFrames',
  'creditStalls',
  'maxQueuedMsObserved',
  'lostInFlightFrames',
  'portReplacements',
  'queuedFramesAtStop',
  'queuedMsAtStop',
  'discardedAtStop',
  'sequenceGapCount',
  'missedFrames',
  'badSampleTypeFrames',
  'droppedCaptionCount'
])

function assertPlainRecord (value, label) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  assert.ok(prototype === Object.prototype || prototype === null, `${label} must be a plain object`)
}

function assertExactKeys (value, keys, label) {
  assertPlainRecord(value, label)
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has missing or unknown fields`)
}

function assertFiniteNonNegative (value, label) {
  assert.equal(typeof value, 'number', `${label} must be a number`)
  assert.ok(Number.isFinite(value), `${label} must be finite`)
  assert.ok(value >= 0, `${label} must be nonnegative`)
}

function assertPositiveFinite (value, label) {
  assertFiniteNonNegative(value, label)
  assert.ok(value > 0, `${label} must be positive`)
}

function assertNonNegativeInteger (value, label) {
  assert.equal(typeof value, 'number', `${label} must be a number`)
  assert.ok(Number.isSafeInteger(value), `${label} must be a safe integer`)
  assert.ok(value >= 0, `${label} must be nonnegative`)
}

function assertFiniteInteger (value, label) {
  assert.equal(typeof value, 'number', `${label} must be a number`)
  assert.ok(Number.isSafeInteger(value), `${label} must be a safe integer`)
}

function assertPositiveInteger (value, label) {
  assertNonNegativeInteger(value, label)
  assert.ok(value > 0, `${label} must be positive`)
}

function assertSha256 (value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  assert.match(value, SHA256_PATTERN, `${label} must be a lowercase SHA-256 digest`)
}

function assertIsoTimestamp (value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  assert.match(value, ISO_TIMESTAMP_PATTERN, `${label} must be a canonical UTC ISO timestamp`)
  const epoch = Date.parse(value)
  assert.ok(Number.isFinite(epoch), `${label} must be a valid timestamp`)
  assert.equal(new Date(epoch).toISOString(), value, `${label} must be a canonical UTC ISO timestamp`)
  return epoch
}

function inspectSafeValue (value, keyPath = 'report') {
  if (typeof value === 'string') {
    assert.doesNotMatch(value, /(?:[A-Za-z]:[\\/]|^\\\\|file:\/\/|\/(?:Users|home|tmp|var|etc|mnt)\/)/i, `${keyPath} must not expose a local path`)
    assert.doesNotMatch(value, /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)(?:$|[?#\s])/i, `${keyPath} must not reference an audio file`)
    assert.doesNotMatch(value, /^data:audio\//i, `${keyPath} must not embed audio data`)
    return
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) inspectSafeValue(value[index], `${keyPath}[${index}]`)
    return
  }
  if (value === null || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    assert.doesNotMatch(
      key,
      /^(?:capturedPcmBase64|pcm(?:16)?Base64|audioBase64|audioFile|audioFilePath|deviceLabel|joinedFinalText|joinedRefinedText|transcript|transcriptText|captionText|text)$/i,
      `${keyPath}.${key} is a forbidden sensitive field`
    )
    inspectSafeValue(nested, `${keyPath}.${key}`)
  }
}

function assertSafeSerializedReport (report) {
  inspectSafeValue(report)
  const serialized = JSON.stringify(report)
  assert.doesNotMatch(serialized, /joined(?:Final|Refined)Text|captionArrivals|capturedPcmBase64|deviceLabel|"text"\s*:/i, 'report must not contain transcript, PCM, or device-label fields')
}

function validateEnvironment (environment) {
  assertExactKeys(environment, ['electron', 'node'], 'environment')
  for (const key of ['electron', 'node']) {
    assert.equal(typeof environment[key], 'string', `environment.${key} must be a string`)
    assert.match(environment[key], /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/, `environment.${key} must be a version`)
  }
}

function validateModel (model) {
  assertExactKeys(model, ['id', 'profile', 'numThreads'], 'model')
  assert.equal(model.id, 'x-asr-160ms')
  assert.equal(model.profile, 'fast')
  assertPositiveInteger(model.numThreads, 'model.numThreads')
}

function validateTrack (track) {
  assertExactKeys(track, ['kind', 'labelSha256', 'settings'], 'input.track')
  assert.equal(track.kind, 'audio')
  assertSha256(track.labelSha256, 'input.track.labelSha256')
  assertExactKeys(track.settings, [
    'autoGainControl',
    'channelCount',
    'echoCancellation',
    'latency',
    'noiseSuppression',
    'sampleRate',
    'sampleSize'
  ], 'input.track.settings')
  assert.equal(typeof track.settings.autoGainControl, 'boolean')
  assertPositiveInteger(track.settings.channelCount, 'input.track.settings.channelCount')
  assert.equal(typeof track.settings.echoCancellation, 'boolean')
  assertFiniteNonNegative(track.settings.latency, 'input.track.settings.latency')
  assert.equal(typeof track.settings.noiseSuppression, 'boolean')
  assertPositiveInteger(track.settings.sampleRate, 'input.track.settings.sampleRate')
  assertPositiveInteger(track.settings.sampleSize, 'input.track.settings.sampleSize')
}

function validatePreflight (preflight, reportExecutedAtEpoch) {
  assertExactKeys(preflight, [
    'kind',
    'schemaVersion',
    'reportSha256',
    'runId',
    'executedAt',
    'result',
    'physicalMicrophoneSelection',
    'physicalSpeakerSelection',
    'micLabelSha256',
    'speakerLabelSha256',
    'rawAudioPersisted'
  ], 'preflight')
  assert.equal(preflight.kind, 'gate-0c-audio-topology')
  assert.equal(preflight.schemaVersion, 2)
  assertSha256(preflight.reportSha256, 'preflight.reportSha256')
  assert.equal(typeof preflight.runId, 'string', 'preflight.runId must be a string')
  assert.match(preflight.runId, /^gate-0c-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/, 'preflight.runId must be canonical')
  const preflightEpoch = assertIsoTimestamp(preflight.executedAt, 'preflight.executedAt')
  assert.ok(preflightEpoch <= reportExecutedAtEpoch, 'preflight must not postdate the I2 report')
  assert.ok(reportExecutedAtEpoch - preflightEpoch <= 30 * 60 * 1000, 'preflight must be no more than 30 minutes old')
  assert.equal(preflight.result, 'pass')
  assert.equal(preflight.physicalMicrophoneSelection, 'physical-preferred')
  assert.equal(preflight.physicalSpeakerSelection, 'physical-speaker-preferred')
  assertSha256(preflight.micLabelSha256, 'preflight.micLabelSha256')
  assertSha256(preflight.speakerLabelSha256, 'preflight.speakerLabelSha256')
  assert.equal(preflight.rawAudioPersisted, false)
}

function validateStimulusAndBinding (report, reportExecutedAtEpoch) {
  const { stimulus, input, preflight, sourceId } = report
  assertExactKeys(input, ['selection', 'matchedLabelHashCount', 'track'], 'input')
  validateTrack(input.track)

  if (sourceId === 'loopback') {
    assertExactKeys(stimulus, ['kind', 'corpusId', 'corpusSha256', 'referenceSha256', 'durationSeconds', 'speechOnsetOffsetMs', 'outputSampleRate', 'output'], 'stimulus')
    assert.equal(stimulus.kind, 'controlled-playback')
    assert.equal(preflight, null)
    assert.equal(input.selection, null)
    assert.equal(input.matchedLabelHashCount, null)
    assertExactKeys(stimulus.output, ['requested', 'selected'], 'stimulus.output')
    assert.equal(stimulus.output.requested, 'default')
    assert.equal(stimulus.output.selected, 'default')
    assert.deepEqual(report.limitations, LOOPBACK_LIMITATIONS)
  } else if (stimulus?.kind === 'controlled-physical-speaker-playback') {
    assertExactKeys(stimulus, ['kind', 'corpusId', 'corpusSha256', 'referenceSha256', 'durationSeconds', 'speechOnsetOffsetMs', 'outputSampleRate', 'output'], 'stimulus')
    validatePreflight(preflight, reportExecutedAtEpoch)
    assert.equal(input.selection, 'label-hash-exact')
    assert.equal(input.matchedLabelHashCount, 1)
    assert.equal(input.track.labelSha256, preflight.micLabelSha256)
    assertExactKeys(stimulus.output, ['requested', 'selected', 'labelSha256', 'matchedLabelHashCount', 'enumeratedAudioOutputCount'], 'stimulus.output')
    assert.equal(stimulus.output.requested, 'physical-speaker-hash')
    assert.equal(stimulus.output.selected, 'label-hash-exact-physical-preferred')
    assertSha256(stimulus.output.labelSha256, 'stimulus.output.labelSha256')
    assert.equal(stimulus.output.labelSha256, preflight.speakerLabelSha256)
    assert.equal(stimulus.output.matchedLabelHashCount, 1)
    assertPositiveInteger(stimulus.output.enumeratedAudioOutputCount, 'stimulus.output.enumeratedAudioOutputCount')
    assert.ok(stimulus.output.matchedLabelHashCount <= stimulus.output.enumeratedAudioOutputCount)
    assert.deepEqual(report.limitations, MIC_ACOUSTIC_LIMITATIONS)
  } else {
    assertExactKeys(stimulus, ['kind', 'corpusId', 'corpusSha256', 'referenceSha256', 'listenSeconds'], 'stimulus')
    assert.equal(sourceId, 'mic')
    assert.equal(stimulus.kind, 'operator-spoken-prompt')
    assert.equal(preflight, null)
    assert.equal(input.selection, 'system-default')
    assert.equal(input.matchedLabelHashCount, null)
    assertPositiveFinite(stimulus.listenSeconds, 'stimulus.listenSeconds')
    assert.deepEqual(report.limitations, MIC_OPERATOR_LIMITATIONS)
  }

  assert.equal(stimulus.corpusId, CORPUS_ID)
  assert.equal(stimulus.corpusSha256, CORPUS_SHA256)
  assert.equal(stimulus.referenceSha256, REFERENCE_SHA256)
  if (stimulus.kind !== 'operator-spoken-prompt') {
    assertPositiveFinite(stimulus.durationSeconds, 'stimulus.durationSeconds')
    assert.equal(stimulus.speechOnsetOffsetMs, 140)
    assertPositiveInteger(stimulus.outputSampleRate, 'stimulus.outputSampleRate')
  }
}

function validateCountsAndAccuracy (report) {
  assertExactKeys(report.counts, ['captions', 'partials', 'finals', 'refined'], 'counts')
  for (const key of ['captions', 'partials', 'finals', 'refined']) assertNonNegativeInteger(report.counts[key], `counts.${key}`)
  assertPositiveInteger(report.counts.partials, 'counts.partials')
  assertPositiveInteger(report.counts.finals, 'counts.finals')
  assertPositiveInteger(report.counts.refined, 'counts.refined')
  assert.equal(report.counts.captions, report.counts.partials + report.counts.finals + report.counts.refined)

  assertExactKeys(report.accuracy, ['finalCer', 'refinedCer', 'refinedHasPunctuation'], 'accuracy')
  assertFiniteNonNegative(report.accuracy.finalCer, 'accuracy.finalCer')
  assert.ok(report.accuracy.finalCer <= 0.3, 'accuracy.finalCer exceeds 0.3')
  assertFiniteNonNegative(report.accuracy.refinedCer, 'accuracy.refinedCer')
  assert.ok(report.accuracy.refinedCer <= 0.3, 'accuracy.refinedCer exceeds 0.3')
  assert.equal(report.accuracy.refinedHasPunctuation, true)
}

function validateTimings (report) {
  assertExactKeys(report.timings, [
    'firstPartialFromStimulusStartMs',
    'firstPartialFromEstimatedSpeechOnsetMs',
    'firstFinalFromStimulusStartMs',
    'firstRefinedFromStimulusStartMs',
    'firstFinalAfterStimulusEndMs',
    'captionArrivalCount'
  ], 'timings')
  for (const key of [
    'firstPartialFromStimulusStartMs',
    'firstFinalFromStimulusStartMs',
    'firstRefinedFromStimulusStartMs',
    'captionArrivalCount'
  ]) assertNonNegativeInteger(report.timings[key], `timings.${key}`)

  if (report.stimulus.kind === 'operator-spoken-prompt') {
    assert.equal(report.timings.firstPartialFromEstimatedSpeechOnsetMs, null)
    assertFiniteInteger(report.timings.firstFinalAfterStimulusEndMs, 'timings.firstFinalAfterStimulusEndMs')
  } else {
    assertNonNegativeInteger(report.timings.firstPartialFromEstimatedSpeechOnsetMs, 'timings.firstPartialFromEstimatedSpeechOnsetMs')
    assertNonNegativeInteger(report.timings.firstFinalAfterStimulusEndMs, 'timings.firstFinalAfterStimulusEndMs')
    assert.equal(
      report.timings.firstPartialFromStimulusStartMs,
      report.timings.firstPartialFromEstimatedSpeechOnsetMs + report.stimulus.speechOnsetOffsetMs,
      'controlled-playback partial timings must share the frozen speech-onset origin'
    )
  }
  assert.ok(report.timings.firstFinalFromStimulusStartMs >= report.timings.firstPartialFromStimulusStartMs)
  assert.ok(report.timings.firstRefinedFromStimulusStartMs >= report.timings.firstFinalFromStimulusStartMs)
  assert.equal(report.timings.captionArrivalCount, report.counts.captions)
}

function validateResources (resources) {
  assertExactKeys(resources, ['sampleCount', 'cpuPercent', 'workingSetMiB', 'maxProcessCount'], 'resources')
  assertPositiveInteger(resources.sampleCount, 'resources.sampleCount')
  assertPositiveInteger(resources.maxProcessCount, 'resources.maxProcessCount')
  for (const groupName of ['cpuPercent', 'workingSetMiB']) {
    const group = resources[groupName]
    assertExactKeys(group, ['p50', 'p95', 'max'], `resources.${groupName}`)
    for (const key of ['p50', 'p95', 'max']) assertFiniteNonNegative(group[key], `resources.${groupName}.${key}`)
    assert.ok(group.p50 <= group.p95, `resources.${groupName}.p50 must not exceed p95`)
    assert.ok(group.p95 <= group.max, `resources.${groupName}.p95 must not exceed max`)
  }
}

function validateTransport (transport) {
  assertExactKeys(transport, TRANSPORT_KEYS, 'transport')
  for (const key of TRANSPORT_KEYS) assertNonNegativeInteger(transport[key], `transport.${key}`)
  assertPositiveInteger(transport.capturedFrames, 'transport.capturedFrames')
  assert.equal(transport.sentFrames, transport.capturedFrames, 'every captured frame must be sent')
  assert.equal(transport.ingestedFrames, transport.capturedFrames, 'every captured frame must be ingested')
  assert.ok(transport.acknowledgedFrames <= transport.sentFrames, 'acknowledgedFrames must not exceed sentFrames')
  for (const key of ZERO_TRANSPORT_KEYS) assert.equal(transport[key], 0, `${key} must be zero`)
}

function validateI2LiveReport (report, expectedSource = null) {
  assertSafeSerializedReport(report)
  assertExactKeys(report, ROOT_KEYS, 'report')
  assert.equal(report.schemaVersion, 4)
  assert.equal(report.kind, 'i2-live-caption-smoke')
  const reportExecutedAtEpoch = assertIsoTimestamp(report.executedAt, 'executedAt')
  validateEnvironment(report.environment)
  assert.ok(['loopback', 'mic'].includes(report.sourceId), 'sourceId must be loopback or mic')
  if (expectedSource !== null) {
    assert.ok(['loopback', 'mic'].includes(expectedSource), 'expectedSource must be loopback or mic')
    assert.equal(report.sourceId, expectedSource)
  }
  assert.equal(report.result, 'pass')
  assert.deepEqual(report.failures, [])
  assert.deepEqual(report.phases, ['starting', 'listening', 'stopping', 'idle'])

  validateModel(report.model)
  assert.equal(report.vad, 'silero')
  assert.equal(report.refinement, 'x-asr-offline')
  validateStimulusAndBinding(report, reportExecutedAtEpoch)
  validateCountsAndAccuracy(report)
  validateTimings(report)
  validateResources(report.resources)

  assertExactKeys(report.signal, ['peakRms'], 'signal')
  assertPositiveFinite(report.signal.peakRms, 'signal.peakRms')
  validateTransport(report.transport)
  assert.deepEqual(report.privacy, {
    capturedAudioPersisted: false,
    reportContainsTranscriptText: false,
    reportContainsAudioPath: false
  })

  return report
}

function normalizeEvidenceBytes (value, label) {
  assert.ok(Buffer.isBuffer(value) || typeof value === 'string', `${label} must be exact UTF-8 bytes or text`)
  return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
}

function deriveGate0CBinding (gateReportBytes) {
  const bytes = normalizeEvidenceBytes(gateReportBytes, 'Gate 0C evidence')
  const report = parseStrictEvidenceJson(bytes, 'Gate 0C evidence')
  validateGate0CMetricsReport(report)
  return {
    reportSha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    runId: report.runId,
    executedAt: report.executedAt,
    microphoneLabelSha256: report.capture.mic.stream.track.labelSha256,
    speakerLabelSha256: report.capture.mic.capture.playback.output.labelSha256
  }
}

function assertGate0CBinding (report, binding) {
  assert.equal(report.stimulus.kind, 'controlled-physical-speaker-playback', 'Gate 0C evidence is only valid for controlled mic replay')
  assert.deepEqual(report.preflight, {
    kind: 'gate-0c-audio-topology',
    schemaVersion: 2,
    reportSha256: binding.reportSha256,
    runId: binding.runId,
    executedAt: binding.executedAt,
    result: 'pass',
    physicalMicrophoneSelection: 'physical-preferred',
    physicalSpeakerSelection: 'physical-speaker-preferred',
    micLabelSha256: binding.microphoneLabelSha256,
    speakerLabelSha256: binding.speakerLabelSha256,
    rawAudioPersisted: false
  }, 'I2 preflight must be exactly derived from Gate 0C bytes')
  assert.equal(report.input.track.labelSha256, binding.microphoneLabelSha256)
  assert.equal(report.stimulus.output.labelSha256, binding.speakerLabelSha256)
}

function validateI2LiveReportEvidence (reportBytes, expectedSource = null, gateReportBytes = null) {
  const report = parseStrictEvidenceJson(normalizeEvidenceBytes(reportBytes, 'I2 report evidence'), 'I2 report evidence')
  validateI2LiveReport(report, expectedSource)
  if (report.stimulus.kind === 'controlled-physical-speaker-playback') {
    assert.ok(gateReportBytes !== null, 'controlled mic evidence requires exact Gate 0C report bytes')
    assertGate0CBinding(report, deriveGate0CBinding(gateReportBytes))
  } else {
    assert.equal(gateReportBytes, null, 'Gate 0C evidence is only valid for controlled mic replay')
  }
  return report
}

if (require.main === module) {
  const argv = process.argv.slice(2)
  if (argv.length < 1 || argv.length > 4) {
    throw new Error('usage: node scripts/verify-i2-live-report.js <report.json> [loopback|mic] [--gate-0c-report <report.json>]')
  }
  const reportPath = argv.shift()
  const expectedSource = argv[0] && !argv[0].startsWith('--') ? argv.shift() : null
  let gateReportBytes = null
  if (argv.length > 0) {
    if (argv.length !== 2 || argv[0] !== '--gate-0c-report') throw new Error('invalid Gate 0C evidence arguments')
    gateReportBytes = fs.readFileSync(path.resolve(argv[1]))
  }
  const report = validateI2LiveReportEvidence(fs.readFileSync(path.resolve(reportPath)), expectedSource, gateReportBytes)
  process.stdout.write(`I2 ${report.sourceId} live report passed.\n`)
}

module.exports = {
  CORPUS_ID,
  CORPUS_SHA256,
  REFERENCE_SHA256,
  LOOPBACK_LIMITATIONS,
  MIC_ACOUSTIC_LIMITATIONS,
  MIC_OPERATOR_LIMITATIONS,
  ROOT_KEYS,
  TRANSPORT_KEYS,
  ZERO_TRANSPORT_KEYS,
  assertGate0CBinding,
  assertExactKeys,
  assertSafeSerializedReport,
  deriveGate0CBinding,
  validateI2LiveReportEvidence,
  validateI2LiveReport
}
