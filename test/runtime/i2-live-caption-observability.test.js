'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { buildLatencyObservability } = require('../../scripts/i2-live-caption-smoke')
const { selectClockCalibration } = require('../../src/runtime/clock-calibration')

const MAIN_CLOCK_ID = 'electron-main-performance-v1'
const PLAYBACK_CLOCK_ID = 'playback-renderer-performance-v1'
const AUDIO_HOST_CLOCK_ID = 'audio-host-performance-v1'
const UTILITY_CLOCK_ID = 'realtime-utility-performance-v1'
const SOURCE_ID = 'loopback'
const STIMULUS_STARTED_AT_MAIN_CLOCK_MS = 1000500
const FROZEN_SPEECH_ONSET_OFFSET_MS = 140
const FIRST_PARTIAL_AT_MAIN_CLOCK_MS = 1001000

function makeCalibration ({ clockId, offsetToMainMs, calibratedAtMainClockMs, minimumRoundTripMs = 4 }) {
  const samples = Array.from({ length: 7 }, (_, index) => {
    const mainSentClockMs = calibratedAtMainClockMs - 90 + index * 10
    const correctedRoundTripMs = minimumRoundTripMs + index
    const remoteProcessingMs = 1
    const mainReceivedClockMs = mainSentClockMs + correctedRoundTripMs + remoteProcessingMs
    const remoteReceivedClockMs =
      (mainSentClockMs + mainReceivedClockMs) / 2 - offsetToMainMs - remoteProcessingMs / 2
    return {
      mainSentClockMs,
      remoteReceivedClockMs,
      remoteSentClockMs: remoteReceivedClockMs + remoteProcessingMs,
      mainReceivedClockMs,
      clockId
    }
  })
  return selectClockCalibration(samples, clockId, calibratedAtMainClockMs)
}

function remoteClockMs (mainClockMs, calibration) {
  return mainClockMs - calibration.offsetToMainMs
}

function makeFixture () {
  // Each remote clock has an intentionally different origin.  The test only
  // compares values after they have been normalized to the main clock.
  const playbackCalibration = makeCalibration({
    clockId: PLAYBACK_CLOCK_ID,
    offsetToMainMs: 700000,
    calibratedAtMainClockMs: 1000100
  })
  const audioHostCalibration = makeCalibration({
    clockId: AUDIO_HOST_CLOCK_ID,
    offsetToMainMs: -250000,
    calibratedAtMainClockMs: 1000200
  })
  const utilityCalibration = makeCalibration({
    clockId: UTILITY_CLOCK_ID,
    offsetToMainMs: 400000,
    calibratedAtMainClockMs: 1000300
  })
  const timing = {
    probeArmedMainClockMs: 1000400,
    capturedOnsetMainClockMs: 1000680,
    capturedOnsetObservedMainClockMs: 1000688,
    vadStartMainClockMs: 1000700,
    partialTriggerMainClockMs: 1000760,
    utilityIngressMainClockMs: 1000820,
    utilityPublishMainClockMs: 1000850,
    workerHostMainClockMs: 1000870
  }
  const firstPartialArrival = {
    sourceId: SOURCE_ID,
    segmentId: 'segment-1',
    sequence: 4,
    arrivedAtMainClockMs: FIRST_PARTIAL_AT_MAIN_CLOCK_MS
  }
  const accepted = {
    sourceId: SOURCE_ID,
    segmentId: 'segment-1',
    sequence: 4,
    audioHostClockId: AUDIO_HOST_CLOCK_ID,
    vadStartAudioTimestampMs: 340,
    vadStartFrameAudioHostClockMs: remoteClockMs(timing.vadStartMainClockMs, audioHostCalibration),
    partialTriggerAudioEndMs: 500,
    partialTriggerFrameAudioHostClockMs: remoteClockMs(timing.partialTriggerMainClockMs, audioHostCalibration),
    utilityClockId: UTILITY_CLOCK_ID,
    partialTriggerUtilityIngressClockMs: remoteClockMs(timing.utilityIngressMainClockMs, utilityCalibration),
    partialPublishUtilityClockMs: remoteClockMs(timing.utilityPublishMainClockMs, utilityCalibration),
    mainClockId: MAIN_CLOCK_ID,
    workerHostMainClockMs: timing.workerHostMainClockMs,
    coordinatorAcceptedReturnMainClockMs: FIRST_PARTIAL_AT_MAIN_CLOCK_MS + 5
  }
  const capture = {
    timingProbeArmedAudioHostClockMs: remoteClockMs(timing.probeArmedMainClockMs, audioHostCalibration),
    timingSpeechOnsetEstimatedAudioHostClockMs: remoteClockMs(timing.capturedOnsetMainClockMs, audioHostCalibration),
    timingSpeechOnsetObservedAudioHostClockMs: remoteClockMs(timing.capturedOnsetObservedMainClockMs, audioHostCalibration),
    timingSpeechOnsetAudioMs: 320,
    timingSpeechOnsetFrameSequence: 101,
    timingProbeDiscontinuities: 0,
    timingProbeInvalidSamples: 0
  }

  return {
    playback: {
      clockCalibration: playbackCalibration,
      timing: {
        method: 'get-output-timestamp-projection',
        baseLatencyMs: 8.1,
        outputLatencyMs: 10.2,
        validProjectionSampleCount: 3,
        projectionSpreadMs: 0.7,
        estimatedFirstSamplePresentationMainClockMs: STIMULUS_STARTED_AT_MAIN_CLOCK_MS + 10
      }
    },
    diagnostics: {
      capture: { [SOURCE_ID]: capture },
      timingCalibrations: {
        audioHost: audioHostCalibration,
        utility: utilityCalibration
      },
      workerHost: { acceptedCaptionTimings: [accepted] }
    },
    sourceId: SOURCE_ID,
    stimulusStartedAtMainClockMs: STIMULUS_STARTED_AT_MAIN_CLOCK_MS,
    firstPartialArrival,
    calibrations: { playbackCalibration, audioHostCalibration, utilityCalibration },
    timing,
    accepted,
    capture
  }
}

function observe (fixture) {
  return buildLatencyObservability({
    playback: fixture.playback,
    diagnostics: fixture.diagnostics,
    sourceId: fixture.sourceId,
    stimulusStartedAtMainClockMs: fixture.stimulusStartedAtMainClockMs,
    firstPartialArrival: fixture.firstPartialArrival
  })
}

test('calibrated heterogeneous clocks yield a telescoping trace equal to frozen latency', () => {
  const fixture = makeFixture()
  const result = observe(fixture)

  assert.equal(result.failureCode, null)
  assert.ok(result.latencyTrace)
  const frozenLatencyMs =
    Math.round(fixture.firstPartialArrival.arrivedAtMainClockMs) -
    Math.round(fixture.stimulusStartedAtMainClockMs + FROZEN_SPEECH_ONSET_OFFSET_MS)
  const traceTotalMs = Object.values(result.latencyTrace).reduce((total, value) => total + value, 0)
  assert.equal(traceTotalMs, frozenLatencyMs)
  assert.deepEqual(result.latencyTrace, {
    estimatedSpeechOnsetToVadStartFrameAudioHostReceiptMs: 60,
    vadStartFrameToPartialTriggerFrameAudioHostMs: 60,
    partialTriggerFrameAudioHostToUtilityIngressMs: 60,
    partialTriggerUtilityIngressToPublishMs: 30,
    partialPublishUtilityToMainWorkerHostMs: 20,
    mainWorkerHostToCoordinatorObserverMs: 130
  })
})

test('a calibrated cross-domain causal reversal is rejected instead of clamped', () => {
  const fixture = makeFixture()
  // The utility clock is independent of the audio-host clock.  Its raw value
  // is locally valid, but normalization proves it occurred before the prior
  // audio-host stage.
  fixture.accepted.partialTriggerUtilityIngressClockMs = remoteClockMs(
    fixture.timing.partialTriggerMainClockMs - 10,
    fixture.calibrations.utilityCalibration
  )

  const result = observe(fixture)
  assert.equal(result.latencyTrace, null)
  assert.equal(result.latencyDiagnostics, null)
  assert.equal(result.failureCode, 'latency-observability-calibrated-order-3')
})

test('wrong audio-host, utility, or playback calibration clock ids are all rejected', () => {
  for (const calibrationName of ['audioHostCalibration', 'utilityCalibration', 'playbackCalibration']) {
    const fixture = makeFixture()
    const wrongCalibration = { ...fixture.calibrations[calibrationName], clockId: 'wrong-clock-id' }
    if (calibrationName === 'playbackCalibration') fixture.playback.clockCalibration = wrongCalibration
    else fixture.diagnostics.timingCalibrations[calibrationName === 'audioHostCalibration' ? 'audioHost' : 'utility'] = wrongCalibration

    const result = observe(fixture)
    assert.equal(result.latencyTrace, null, `${calibrationName} must not produce a trace`)
    assert.equal(result.latencyDiagnostics, null, `${calibrationName} must not produce persistent diagnostics`)
    assert.notEqual(result.failureCode, null, `${calibrationName} must be rejected`)
  }
})

test('expired and high-minimum-RTT calibrations are rejected before a trace is emitted', () => {
  const staleFixture = makeFixture()
  staleFixture.diagnostics.timingCalibrations.audioHost = makeCalibration({
    clockId: AUDIO_HOST_CLOCK_ID,
    offsetToMainMs: -250000,
    calibratedAtMainClockMs: FIRST_PARTIAL_AT_MAIN_CLOCK_MS - 30001
  })
  const stale = observe(staleFixture)
  assert.deepEqual(stale, {
    latencyTrace: null,
    latencyDiagnostics: null,
    failureCode: 'latency-observability-clock-calibration-stale'
  })

  const highRttFixture = makeFixture()
  highRttFixture.diagnostics.timingCalibrations.utility = makeCalibration({
    clockId: UTILITY_CLOCK_ID,
    offsetToMainMs: 400000,
    calibratedAtMainClockMs: 1000300,
    minimumRoundTripMs: 50.001
  })
  const highRtt = observe(highRttFixture)
  assert.deepEqual(highRtt, {
    latencyTrace: null,
    latencyDiagnostics: null,
    failureCode: 'latency-observability-clock-calibration-stale'
  })
})

test('persistable latency diagnostics contain neither offsets nor absolute remote clock values', () => {
  const fixture = makeFixture()
  const result = observe(fixture)
  const serialized = JSON.stringify(result.latencyDiagnostics)
  const remoteClockValues = [
    fixture.capture.timingProbeArmedAudioHostClockMs,
    fixture.capture.timingSpeechOnsetEstimatedAudioHostClockMs,
    fixture.capture.timingSpeechOnsetObservedAudioHostClockMs,
    fixture.accepted.vadStartFrameAudioHostClockMs,
    fixture.accepted.partialTriggerFrameAudioHostClockMs,
    fixture.accepted.partialTriggerUtilityIngressClockMs,
    fixture.accepted.partialPublishUtilityClockMs
  ]

  assert.equal(result.failureCode, null)
  assert.doesNotMatch(serialized, /offsetToMainMs|calibratedAtMainClockMs/i)
  for (const value of remoteClockValues) {
    assert.equal(serialized.includes(String(value)), false, `remote timestamp ${value} leaked into diagnostics`)
  }
})
