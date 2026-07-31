'use strict'

/**
 * The monotonic clock exposed by Electron's main process.  Remote clock ids
 * are deliberately supplied by the caller: a calibration is only meaningful
 * for the exact renderer/worker clock that produced its samples.
 */
const MAIN_CLOCK_ID = 'electron-main-performance-v1'
const CALIBRATION_METHOD = 'ntp-min-rtt-monotonic-v1'
const MINIMUM_SAMPLE_COUNT = 3
const SAMPLE_KEYS = Object.freeze([
  'mainSentClockMs',
  'remoteReceivedClockMs',
  'remoteSentClockMs',
  'mainReceivedClockMs',
  'clockId'
])

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function assertNonNegativeFinite(value, label) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite, non-negative number`)
  }
}

function assertClockId(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`)
  }
}

function assertExactKeys(record, keys, label) {
  const actualKeys = Object.keys(record).sort()
  const expectedKeys = [...keys].sort()
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    throw new TypeError(`${label} must contain exactly: ${expectedKeys.join(', ')}`)
  }
}

function assertSample(sample, expectedClockId, index) {
  const label = `samples[${index}]`
  if (!isRecord(sample)) {
    throw new TypeError(`${label} must be an object`)
  }
  assertExactKeys(sample, SAMPLE_KEYS, label)
  assertClockId(sample.clockId, `${label}.clockId`)
  if (sample.clockId !== expectedClockId) {
    throw new RangeError(`${label}.clockId must exactly equal expectedClockId`)
  }

  assertNonNegativeFinite(sample.mainSentClockMs, `${label}.mainSentClockMs`)
  assertNonNegativeFinite(sample.remoteReceivedClockMs, `${label}.remoteReceivedClockMs`)
  assertNonNegativeFinite(sample.remoteSentClockMs, `${label}.remoteSentClockMs`)
  assertNonNegativeFinite(sample.mainReceivedClockMs, `${label}.mainReceivedClockMs`)

  if (sample.mainReceivedClockMs < sample.mainSentClockMs) {
    throw new RangeError(`${label}.mainReceivedClockMs must not precede mainSentClockMs`)
  }
  if (sample.remoteSentClockMs < sample.remoteReceivedClockMs) {
    throw new RangeError(`${label}.remoteSentClockMs must not precede remoteReceivedClockMs`)
  }

  const correctedRoundTripMs =
    (sample.mainReceivedClockMs - sample.mainSentClockMs) -
    (sample.remoteSentClockMs - sample.remoteReceivedClockMs)
  if (!Number.isFinite(correctedRoundTripMs) || correctedRoundTripMs < 0) {
    throw new RangeError(`${label} has a negative corrected round trip time`)
  }

  return {
    correctedRoundTripMs,
    offsetToMainMs:
      ((sample.mainSentClockMs + sample.mainReceivedClockMs) -
        (sample.remoteReceivedClockMs + sample.remoteSentClockMs)) /
      2
  }
}

function assertCalibration(calibration, expectedClockId) {
  if (!isRecord(calibration)) {
    throw new TypeError('calibration must be an object')
  }
  if (calibration.method !== CALIBRATION_METHOD) {
    throw new RangeError('calibration.method is not supported')
  }
  assertClockId(calibration.clockId, 'calibration.clockId')
  if (expectedClockId !== undefined && calibration.clockId !== expectedClockId) {
    throw new RangeError('calibration.clockId must exactly equal expectedClockId')
  }
  if (!Number.isInteger(calibration.sampleCount) || calibration.sampleCount < MINIMUM_SAMPLE_COUNT) {
    throw new TypeError(`calibration.sampleCount must be an integer of at least ${MINIMUM_SAMPLE_COUNT}`)
  }
  assertNonNegativeFinite(calibration.minimumRoundTripMs, 'calibration.minimumRoundTripMs')
  assertNonNegativeFinite(calibration.uncertaintyMs, 'calibration.uncertaintyMs')
  if (!Number.isFinite(calibration.offsetToMainMs)) {
    throw new TypeError('calibration.offsetToMainMs must be finite')
  }
  assertNonNegativeFinite(calibration.calibratedAtMainClockMs, 'calibration.calibratedAtMainClockMs')
}

function roundMilliseconds(value) {
  return Number(value.toFixed(3))
}

/**
 * Select the NTP-style sample with the smallest corrected RTT.  We validate
 * every supplied sample rather than silently dropping malformed observations:
 * a calibration is an attestation of its full collection round.
 */
function selectClockCalibration(samples, expectedClockId, calibratedAtMainClockMs) {
  if (!Array.isArray(samples) || samples.length < MINIMUM_SAMPLE_COUNT) {
    throw new RangeError(`samples must contain at least ${MINIMUM_SAMPLE_COUNT} entries`)
  }
  assertClockId(expectedClockId, 'expectedClockId')
  assertNonNegativeFinite(calibratedAtMainClockMs, 'calibratedAtMainClockMs')

  let selected = null
  samples.forEach((sample, index) => {
    const normalized = assertSample(sample, expectedClockId, index)
    if (selected === null || normalized.correctedRoundTripMs < selected.correctedRoundTripMs) {
      selected = normalized
    }
  })

  const minimumRoundTripMs = selected.correctedRoundTripMs
  return Object.freeze({
    method: CALIBRATION_METHOD,
    clockId: expectedClockId,
    sampleCount: samples.length,
    minimumRoundTripMs,
    uncertaintyMs: minimumRoundTripMs / 2 + 0.5,
    offsetToMainMs: selected.offsetToMainMs,
    calibratedAtMainClockMs
  })
}

/**
 * Convert a timestamp emitted by the calibrated remote monotonic clock into
 * the main-process monotonic clock domain.
 */
function normalizeRemoteClockMs(value, calibration, expectedClockId) {
  assertNonNegativeFinite(value, 'value')
  assertClockId(expectedClockId, 'expectedClockId')
  assertCalibration(calibration, expectedClockId)

  const normalized = value + calibration.offsetToMainMs
  if (!Number.isFinite(normalized)) {
    throw new RangeError('normalized clock value must be finite')
  }
  return normalized
}

/**
 * Deliberately omits the offset and calibration timestamp.  This is the only
 * shape intended for reports and telemetry, so absolute clock data stays in
 * memory at the point of measurement.
 */
function summarizeClockCalibration(calibration, eventMainClockMs) {
  assertCalibration(calibration)
  assertNonNegativeFinite(eventMainClockMs, 'eventMainClockMs')
  if (eventMainClockMs < calibration.calibratedAtMainClockMs) {
    throw new RangeError('eventMainClockMs must not precede calibration')
  }

  return Object.freeze({
    method: CALIBRATION_METHOD,
    sampleCount: calibration.sampleCount,
    minimumRoundTripMs: roundMilliseconds(calibration.minimumRoundTripMs),
    uncertaintyMs: roundMilliseconds(calibration.uncertaintyMs),
    ageMs: roundMilliseconds(eventMainClockMs - calibration.calibratedAtMainClockMs)
  })
}

module.exports = {
  MAIN_CLOCK_ID,
  CALIBRATION_METHOD,
  selectClockCalibration,
  normalizeRemoteClockMs,
  summarizeClockCalibration
}
