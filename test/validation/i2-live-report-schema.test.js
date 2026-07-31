'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  CORPUS_SHA256,
  REFERENCE_SHA256,
  LOOPBACK_LIMITATIONS,
  MIC_ACOUSTIC_LIMITATIONS,
  MIC_OPERATOR_LIMITATIONS,
  validateI2LiveReport
} = require('../../scripts/verify-i2-live-report')

const MIC_SHA256 = 'a'.repeat(64)
const SPEAKER_SHA256 = 'b'.repeat(64)
const PREFLIGHT_REPORT_SHA256 = 'c'.repeat(64)

function clone (value) {
  return structuredClone(value)
}

function makeAcousticReport () {
  return {
    schemaVersion: 4,
    kind: 'i2-live-caption-smoke',
    executedAt: '2026-07-31T05:23:47.938Z',
    environment: { electron: '43.2.0', node: '24.18.0' },
    sourceId: 'mic',
    result: 'pass',
    model: { id: 'x-asr-160ms', profile: 'fast', numThreads: 4 },
    vad: 'silero',
    refinement: 'x-asr-offline',
    stimulus: {
      kind: 'controlled-physical-speaker-playback',
      corpusId: 'zh-en-code-switch',
      corpusSha256: CORPUS_SHA256,
      referenceSha256: REFERENCE_SHA256,
      durationSeconds: 8.56,
      speechOnsetOffsetMs: 140,
      outputSampleRate: 48000,
      output: {
        requested: 'physical-speaker-hash',
        selected: 'label-hash-exact-physical-preferred',
        labelSha256: SPEAKER_SHA256,
        matchedLabelHashCount: 1,
        enumeratedAudioOutputCount: 8
      }
    },
    preflight: {
      kind: 'gate-0c-audio-topology',
      schemaVersion: 2,
      reportSha256: PREFLIGHT_REPORT_SHA256,
      runId: 'gate-0c-2026-07-31T05-06-19-411Z',
      executedAt: '2026-07-31T05:06:39.794Z',
      result: 'pass',
      physicalMicrophoneSelection: 'physical-preferred',
      physicalSpeakerSelection: 'physical-speaker-preferred',
      micLabelSha256: MIC_SHA256,
      speakerLabelSha256: SPEAKER_SHA256,
      rawAudioPersisted: false
    },
    input: {
      selection: 'label-hash-exact',
      matchedLabelHashCount: 1,
      track: {
        kind: 'audio',
        labelSha256: MIC_SHA256,
        settings: {
          autoGainControl: false,
          channelCount: 2,
          echoCancellation: false,
          latency: 0.01,
          noiseSuppression: false,
          sampleRate: 48000,
          sampleSize: 16
        }
      }
    },
    failures: [],
    phases: ['starting', 'listening', 'stopping', 'idle'],
    counts: { captions: 3, partials: 1, finals: 1, refined: 1 },
    accuracy: { finalCer: 0, refinedCer: 0, refinedHasPunctuation: true },
    timings: {
      firstPartialFromStimulusStartMs: 240,
      firstPartialFromEstimatedSpeechOnsetMs: 100,
      firstFinalFromStimulusStartMs: 9000,
      firstRefinedFromStimulusStartMs: 9200,
      firstFinalAfterStimulusEndMs: 440,
      captionArrivalCount: 3
    },
    resources: {
      sampleCount: 80,
      cpuPercent: { p50: 10.5, p95: 40.25, max: 42.5 },
      workingSetMiB: { p50: 1100.25, p95: 1150.5, max: 1160.75 },
      maxProcessCount: 8
    },
    signal: { peakRms: 0.3 },
    transport: {
      capturedFrames: 130,
      sentFrames: 130,
      ingestedFrames: 130,
      droppedFrames: 0,
      creditStalls: 0,
      maxQueuedMsObserved: 0,
      acknowledgedFrames: 125,
      lostInFlightFrames: 0,
      portReplacements: 0,
      queuedFramesAtStop: 0,
      queuedMsAtStop: 0,
      discardedAtStop: 0,
      sequenceGapCount: 0,
      missedFrames: 0,
      badSampleTypeFrames: 0,
      droppedCaptionCount: 0
    },
    privacy: {
      capturedAudioPersisted: false,
      reportContainsTranscriptText: false,
      reportContainsAudioPath: false
    },
    limitations: [...MIC_ACOUSTIC_LIMITATIONS]
  }
}

function makeLoopbackReport () {
  const report = makeAcousticReport()
  report.sourceId = 'loopback'
  report.stimulus = {
    kind: 'controlled-playback',
    corpusId: 'zh-en-code-switch',
    corpusSha256: CORPUS_SHA256,
    referenceSha256: REFERENCE_SHA256,
    durationSeconds: 8.56,
    speechOnsetOffsetMs: 140,
    outputSampleRate: 48000,
    output: { requested: 'default', selected: 'default' }
  }
  report.preflight = null
  report.input.selection = null
  report.input.matchedLabelHashCount = null
  report.limitations = [...LOOPBACK_LIMITATIONS]
  return report
}

function makeOperatorReport () {
  const report = makeAcousticReport()
  report.stimulus = {
    kind: 'operator-spoken-prompt',
    corpusId: 'zh-en-code-switch',
    corpusSha256: CORPUS_SHA256,
    referenceSha256: REFERENCE_SHA256,
    listenSeconds: 12
  }
  report.preflight = null
  report.input.selection = 'system-default'
  report.input.matchedLabelHashCount = null
  report.timings.firstPartialFromEstimatedSpeechOnsetMs = null
  report.limitations = [...MIC_OPERATOR_LIMITATIONS]
  return report
}

test('schema v4 accepts only the three explicitly supported source fixtures', () => {
  assert.equal(validateI2LiveReport(makeLoopbackReport(), 'loopback').sourceId, 'loopback')
  assert.equal(validateI2LiveReport(makeAcousticReport(), 'mic').stimulus.kind, 'controlled-physical-speaker-playback')
  assert.equal(validateI2LiveReport(makeOperatorReport(), 'mic').stimulus.kind, 'operator-spoken-prompt')
  const earlyOperatorFinal = makeOperatorReport()
  earlyOperatorFinal.timings.firstFinalAfterStimulusEndMs = -1000
  assert.equal(validateI2LiveReport(earlyOperatorFinal, 'mic').timings.firstFinalAfterStimulusEndMs, -1000)
  const amplified = makeAcousticReport()
  amplified.signal.peakRms = 1.2
  assert.equal(validateI2LiveReport(amplified, 'mic').signal.peakRms, 1.2, 'Web Audio observations may exceed nominal full scale')
})

test('schema v4 rejects unknown and sensitive fields recursively', () => {
  const mutations = [
    (report) => { report.capturedPcmBase64 = 'AAAA' },
    (report) => { report.transcript = 'secret transcript' },
    (report) => { report.environment.unknown = true },
    (report) => { report.input.track.deviceLabel = 'Real Microphone Name' },
    (report) => { report.input.track.settings.path = 'C:\\Users\\operator\\capture.wav' },
    (report) => { report.stimulus.output.unknown = 1 },
    (report) => { report.preflight.unknown = 1 },
    (report) => { report.resources.cpuPercent.unknown = 1 },
    (report) => { report.privacy.unknown = false }
  ]
  for (const mutate of mutations) {
    const report = makeAcousticReport()
    mutate(report)
    assert.throws(() => validateI2LiveReport(report))
  }
})

test('schema v4 requires real refinement output and controlled-playback timings', () => {
  for (const mutate of [
    (report) => { report.refinement = null },
    (report) => { delete report.refinement },
    (report) => { report.counts.refined = 0; report.counts.captions = 2 },
    (report) => { report.accuracy.refinedCer = null },
    (report) => { report.accuracy.refinedHasPunctuation = false },
    (report) => { report.timings.firstPartialFromEstimatedSpeechOnsetMs = null },
    (report) => { report.timings.firstRefinedFromStimulusStartMs = null }
  ]) {
    const report = makeAcousticReport()
    mutate(report)
    assert.throws(() => validateI2LiveReport(report))
  }
})

test('schema v4 binds acoustic replay to one preflight microphone and speaker', () => {
  const mutations = [
    (report) => { report.preflight.executedAt = 'not-a-timestamp' },
    (report) => { report.preflight.executedAt = '2026-08-01T00:00:00.000Z' },
    (report) => { report.preflight.executedAt = '2026-07-31T04:00:00.000Z' },
    (report) => { report.preflight.runId = 'gate-0c-invalid' },
    (report) => { report.preflight.reportSha256 = 'NOT-A-HASH' },
    (report) => { report.preflight.micLabelSha256 = 'd'.repeat(64) },
    (report) => { report.stimulus.output.labelSha256 = 'd'.repeat(64) },
    (report) => { report.input.matchedLabelHashCount = 2 },
    (report) => { report.stimulus.output.matchedLabelHashCount = 2 },
    (report) => { report.stimulus.output.selected = 'physical-speaker-preferred' }
  ]
  for (const mutate of mutations) {
    const report = makeAcousticReport()
    mutate(report)
    assert.throws(() => validateI2LiveReport(report))
  }
})

test('schema v4 rejects nonfinite, negative, fractional-count, and coercible numbers', () => {
  const mutations = [
    (report) => { report.timings.firstFinalFromStimulusStartMs = Infinity },
    (report) => { report.timings.firstFinalAfterStimulusEndMs = -1 },
    (report) => { report.resources.cpuPercent.p95 = Number.NaN },
    (report) => { report.resources.sampleCount = 1.5 },
    (report) => { report.transport.capturedFrames = '130' },
    (report) => { report.transport.ingestedFrames = 129 },
    (report) => { report.transport.queuedFramesAtStop = 1 },
    (report) => { report.model.numThreads = '4' },
    (report) => { report.signal.peakRms = '0.3' },
    (report) => { report.signal.peakRms = Number.NaN }
  ]
  for (const mutate of mutations) {
    const report = makeAcousticReport()
    mutate(report)
    assert.throws(() => validateI2LiveReport(report))
  }
})

test('schema v4 fixes the corpus digest, privacy shape, phases, and limitations', () => {
  const mutations = [
    (report) => { report.stimulus.corpusSha256 = 'd'.repeat(64) },
    (report) => { report.stimulus.referenceSha256 = 'd'.repeat(64) },
    (report) => { report.privacy.capturedAudioPersisted = true },
    (report) => { report.phases.push('debugging') },
    (report) => { report.limitations[0] = 'C:\\Users\\operator\\recording.wav' },
    (report) => { report.failures.push('ignored failure') }
  ]
  for (const mutate of mutations) {
    const report = makeAcousticReport()
    mutate(report)
    assert.throws(() => validateI2LiveReport(report))
  }
})
