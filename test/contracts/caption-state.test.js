'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  assertCaptionState,
  assertCaptionViewportEviction,
  isCaptionState
} = require('../../src/contracts')

function validState () {
  return {
    schemaVersion: 1,
    revision: 12,
    sessionId: 'session-1',
    segments: [
      {
        segmentId: 'segment-1',
        sourceId: 'mic',
        sequence: 4,
        kind: 'translated',
        text: '你好。',
        textRevision: 4,
        translation: { language: 'en', text: 'Hello.', basedOnRevision: 3 },
        translationRevision: 4,
        t0: 0,
        t1: 2.1
      },
      {
        segmentId: 'segment-2',
        sourceId: 'loopback',
        sequence: 5,
        kind: 'partial',
        text: '正在',
        textRevision: 1,
        translation: null,
        translationRevision: 0,
        t0: 2.2,
        t1: 2.9
      }
    ]
  }
}

test('caption state validator accepts idle and populated states', () => {
  assertCaptionState({ schemaVersion: 1, revision: 0, sessionId: null, segments: [] })
  const state = validState()
  assert.equal(assertCaptionState(state), state)
})

test('caption state validator rejects structural violations', () => {
  const cases = [
    [(state) => { state.schemaVersion = 2 }, /schemaVersion/],
    [(state) => { state.revision = -1 }, /revision/],
    [(state) => { state.sessionId = null }, /must be empty without a session/],
    [(state) => { state.sessionId = ' ' }, /sessionId/],
    [(state) => { state.segments = null }, /must be an array/],
    [(state) => { state.segments[1].segmentId = 'segment-1' }, /duplicates/],
    [(state) => {
      state.segments[0].kind = 'final'
      state.segments[0].text = ''
      state.segments[0].translation = null
      state.segments[0].translationRevision = 0
    }, /text/],
    [(state) => { state.segments[0].translationRevision = 5 }, /translationRevision/],
    [(state) => {
      state.segments[0].translation = null
      state.segments[0].translationRevision = 0
    }, /translation/],
    [(state) => { state.segments[0].translation.basedOnRevision = 4 }, /basedOnRevision/],
    [(state) => { state.segments[1].t1 = 1 }, /t1/],
    [(state) => { state.segments[1].sequence = 0 }, /sequence/]
  ]
  for (const [mutate, expected] of cases) {
    const state = structuredClone(validState())
    mutate(state)
    assert.throws(() => assertCaptionState(state), expected)
  }
})

test('isCaptionState returns booleans instead of throwing', () => {
  assert.equal(isCaptionState(validState()), true)
  assert.equal(isCaptionState(null), false)
  assert.equal(isCaptionState({ schemaVersion: 1 }), false)
})

test('caption viewport eviction carries identity only and rejects text or geometry', () => {
  const report = {
    schemaVersion: 1,
    sessionId: 'session-1',
    throughSegmentId: 'segment-7'
  }
  assert.equal(assertCaptionViewportEviction(report), report)

  const invalid = [
    [{ ...report, schemaVersion: 2 }, /schemaVersion/],
    [{ ...report, sessionId: ' ' }, /sessionId/],
    [{ ...report, throughSegmentId: '' }, /throughSegmentId/],
    [{ ...report, text: '不得回传字幕正文' }, /exactly/],
    [{ ...report, viewportTop: 120 }, /exactly/],
    [{ schemaVersion: 1, sessionId: 'session-1' }, /exactly/]
  ]
  for (const [value, expected] of invalid) {
    assert.throws(() => assertCaptionViewportEviction(value), expected)
  }
})
