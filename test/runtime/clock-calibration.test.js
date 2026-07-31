'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  MAIN_CLOCK_ID,
  CALIBRATION_METHOD,
  selectClockCalibration,
  normalizeRemoteClockMs,
  summarizeClockCalibration
} = require('../../src/runtime/clock-calibration')

const REMOTE_CLOCK_ID = 'electron-renderer-performance-v1'

function sample({
  mainSentClockMs,
  remoteReceivedClockMs,
  remoteSentClockMs,
  mainReceivedClockMs,
  clockId = REMOTE_CLOCK_ID
}) {
  return {
    mainSentClockMs,
    remoteReceivedClockMs,
    remoteSentClockMs,
    mainReceivedClockMs,
    clockId
  }
}

test('selectClockCalibration chooses the lowest corrected RTT and NTP midpoint offset', () => {
  const calibration = selectClockCalibration(
    [
      sample({ mainSentClockMs: 100, remoteReceivedClockMs: 80, remoteSentClockMs: 82, mainReceivedClockMs: 114 }),
      sample({ mainSentClockMs: 200, remoteReceivedClockMs: 175, remoteSentClockMs: 176, mainReceivedClockMs: 210 }),
      sample({ mainSentClockMs: 300, remoteReceivedClockMs: 280, remoteSentClockMs: 282, mainReceivedClockMs: 313 })
    ],
    REMOTE_CLOCK_ID,
    320
  )

  // Corrected RTTs are 12, 9 and 11ms respectively, so the second wins.
  assert.deepEqual(calibration, {
    method: CALIBRATION_METHOD,
    clockId: REMOTE_CLOCK_ID,
    sampleCount: 3,
    minimumRoundTripMs: 9,
    uncertaintyMs: 5,
    offsetToMainMs: 29.5,
    calibratedAtMainClockMs: 320
  })
  assert.equal(normalizeRemoteClockMs(180, calibration, REMOTE_CLOCK_ID), 209.5)
})

test('selectClockCalibration keeps the first equal-minimum sample deterministically', () => {
  const calibration = selectClockCalibration(
    [
      sample({ mainSentClockMs: 100, remoteReceivedClockMs: 90, remoteSentClockMs: 92, mainReceivedClockMs: 112 }),
      sample({ mainSentClockMs: 200, remoteReceivedClockMs: 170, remoteSentClockMs: 172, mainReceivedClockMs: 212 }),
      sample({ mainSentClockMs: 300, remoteReceivedClockMs: 290, remoteSentClockMs: 292, mainReceivedClockMs: 312 })
    ],
    REMOTE_CLOCK_ID,
    320
  )

  assert.equal(calibration.minimumRoundTripMs, 10)
  assert.equal(calibration.offsetToMainMs, 15)
})

test('selectClockCalibration requires three valid exact-clock samples', () => {
  assert.throws(
    () => selectClockCalibration([], REMOTE_CLOCK_ID, 1),
    /at least 3 entries/
  )
  assert.throws(
    () =>
      selectClockCalibration(
        [
          sample({ mainSentClockMs: 1, remoteReceivedClockMs: 1, remoteSentClockMs: 1, mainReceivedClockMs: 1 }),
          sample({ mainSentClockMs: 2, remoteReceivedClockMs: 2, remoteSentClockMs: 2, mainReceivedClockMs: 2 }),
          sample({ mainSentClockMs: 3, remoteReceivedClockMs: 3, remoteSentClockMs: 3, mainReceivedClockMs: 3, clockId: 'wrong-clock' })
        ],
        REMOTE_CLOCK_ID,
        4
      ),
    /exactly equal expectedClockId/
  )
})

test('selectClockCalibration rejects malformed, backwards, and negative-RTT samples', () => {
  const valid = sample({ mainSentClockMs: 1, remoteReceivedClockMs: 1, remoteSentClockMs: 1, mainReceivedClockMs: 1 })
  const three = [valid, valid, valid]

  assert.throws(
    () => selectClockCalibration([{ ...valid, ignored: true }, valid, valid], REMOTE_CLOCK_ID, 2),
    /must contain exactly/
  )
  assert.throws(
    () => selectClockCalibration([sample({ mainSentClockMs: 2, remoteReceivedClockMs: 1, remoteSentClockMs: 1, mainReceivedClockMs: 1 }), valid, valid], REMOTE_CLOCK_ID, 2),
    /must not precede mainSentClockMs/
  )
  assert.throws(
    () => selectClockCalibration([sample({ mainSentClockMs: 1, remoteReceivedClockMs: 2, remoteSentClockMs: 1, mainReceivedClockMs: 3 }), valid, valid], REMOTE_CLOCK_ID, 3),
    /must not precede remoteReceivedClockMs/
  )
  assert.throws(
    () => selectClockCalibration([sample({ mainSentClockMs: 0, remoteReceivedClockMs: 0, remoteSentClockMs: 10, mainReceivedClockMs: 5 }), valid, valid], REMOTE_CLOCK_ID, 10),
    /negative corrected round trip/
  )
  assert.throws(
    () => selectClockCalibration([sample({ mainSentClockMs: Number.NaN, remoteReceivedClockMs: 0, remoteSentClockMs: 0, mainReceivedClockMs: 0 }), ...three.slice(1)], REMOTE_CLOCK_ID, 0),
    /finite, non-negative/
  )
})

test('normalizeRemoteClockMs refuses a calibration from another clock', () => {
  const calibration = selectClockCalibration(
    [
      sample({ mainSentClockMs: 1, remoteReceivedClockMs: 1, remoteSentClockMs: 1, mainReceivedClockMs: 1 }),
      sample({ mainSentClockMs: 2, remoteReceivedClockMs: 2, remoteSentClockMs: 2, mainReceivedClockMs: 2 }),
      sample({ mainSentClockMs: 3, remoteReceivedClockMs: 3, remoteSentClockMs: 3, mainReceivedClockMs: 3 })
    ],
    REMOTE_CLOCK_ID,
    4
  )

  assert.throws(
    () => normalizeRemoteClockMs(5, calibration, 'electron-worker-performance-v1'),
    /exactly equal expectedClockId/
  )
  assert.throws(
    () => normalizeRemoteClockMs(-1, calibration, REMOTE_CLOCK_ID),
    /finite, non-negative/
  )
})

test('summarizeClockCalibration emits only rounded non-sensitive fields', () => {
  const calibration = selectClockCalibration(
    [
      sample({ mainSentClockMs: 100, remoteReceivedClockMs: 80, remoteSentClockMs: 80.2, mainReceivedClockMs: 102.9 }),
      sample({ mainSentClockMs: 200, remoteReceivedClockMs: 180, remoteSentClockMs: 180.25, mainReceivedClockMs: 202.85 }),
      sample({ mainSentClockMs: 300, remoteReceivedClockMs: 280, remoteSentClockMs: 280.4, mainReceivedClockMs: 304 })
    ],
    REMOTE_CLOCK_ID,
    500.1234
  )
  const summary = summarizeClockCalibration(calibration, 502.4692)

  assert.deepEqual(summary, {
    method: CALIBRATION_METHOD,
    sampleCount: 3,
    minimumRoundTripMs: 2.6,
    uncertaintyMs: 1.8,
    ageMs: 2.346
  })
  assert.deepEqual(Object.keys(summary).sort(), [
    'ageMs',
    'method',
    'minimumRoundTripMs',
    'sampleCount',
    'uncertaintyMs'
  ])
  assert.equal(Object.hasOwn(summary, 'offsetToMainMs'), false)
  assert.equal(Object.hasOwn(summary, 'calibratedAtMainClockMs'), false)
})

test('summarizeClockCalibration rejects a pre-calibration event', () => {
  const calibration = selectClockCalibration(
    [
      sample({ mainSentClockMs: 1, remoteReceivedClockMs: 1, remoteSentClockMs: 1, mainReceivedClockMs: 1 }),
      sample({ mainSentClockMs: 2, remoteReceivedClockMs: 2, remoteSentClockMs: 2, mainReceivedClockMs: 2 }),
      sample({ mainSentClockMs: 3, remoteReceivedClockMs: 3, remoteSentClockMs: 3, mainReceivedClockMs: 3 })
    ],
    REMOTE_CLOCK_ID,
    10
  )

  assert.throws(() => summarizeClockCalibration(calibration, 9.999), /must not precede calibration/)
})

test('exports the stable main clock identifier', () => {
  assert.equal(MAIN_CLOCK_ID, 'electron-main-performance-v1')
})
