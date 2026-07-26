'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  KEEP_SEGMENTS,
  applyEvent,
  createState,
  hydrateState,
  selectLines
} = require('../../src/ui/shared/caption-reducer')

function canonicalSegment (overrides = {}) {
  return {
    segmentId: 'segment-1',
    sourceId: 'mic',
    sequence: 3,
    kind: 'final',
    text: '定稿。',
    textRevision: 3,
    translation: null,
    translationRevision: 0,
    t0: 0,
    t1: 2,
    ...overrides
  }
}

function canonicalState (segments, sessionId = 'session-1') {
  return { schemaVersion: 1, revision: segments.length, sessionId, segments }
}

function event (overrides = {}) {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    sourceId: 'mic',
    segmentId: 'segment-1',
    sequence: 1,
    revision: 1,
    kind: 'partial',
    t0: 0,
    t1: 0.5,
    text: '文本',
    translation: null,
    ...overrides
  }
}

test('hydrateState returns an empty state for missing or idle canonical input', () => {
  assert.deepEqual(hydrateState(null), createState())
  assert.deepEqual(hydrateState(undefined), createState())
  assert.deepEqual(
    hydrateState({ schemaVersion: 1, revision: 0, sessionId: null, segments: [] }),
    createState()
  )
})

test('hydrateState keeps only the newest KEEP_SEGMENTS segments', () => {
  const total = KEEP_SEGMENTS + 3
  const segments = []
  for (let index = 1; index <= total; index += 1) {
    segments.push(canonicalSegment({ segmentId: `seg-${index}`, sequence: index }))
  }
  const state = hydrateState(canonicalState(segments))
  assert.equal(state.sessionId, 'session-1')
  assert.equal(state.segments.length, KEEP_SEGMENTS)
  assert.equal(state.segments[0].segmentId, `seg-${total - KEEP_SEGMENTS + 1}`)
  assert.equal(state.segments.at(-1).segmentId, `seg-${total}`)
})

test('stale events replayed after hydration cannot roll captions back', () => {
  const state = hydrateState(canonicalState([canonicalSegment()]))

  applyEvent(state, event({ sequence: 2, revision: 2, text: '旧 partial' }))
  assert.equal(state.segments[0].text, '定稿。')
  assert.equal(state.segments[0].kind, 'final')

  applyEvent(state, event({ sequence: 3, revision: 3, kind: 'final', text: '重复定稿。' }))
  assert.equal(state.segments[0].text, '定稿。')

  applyEvent(state, event({ sequence: 4, revision: 4, kind: 'refined', text: '精修定稿。' }))
  assert.equal(state.segments[0].text, '精修定稿。')
  assert.equal(state.segments[0].kind, 'refined')
  assert.equal(state.segments[0].textRevision, 4)
})

test('late translation applies to a hydrated final segment', () => {
  const state = hydrateState(canonicalState([canonicalSegment()]))
  applyEvent(state, event({
    sequence: 4,
    revision: 4,
    kind: 'translated',
    text: '定稿。',
    translation: { language: 'en', text: 'Done.', basedOnRevision: 3 }
  }))

  const lines = selectLines(state, { bilingual: true })
  assert.equal(lines.current, '定稿。')
  assert.equal(lines.translation, 'Done.')
  assert.equal(lines.isPartial, false)
})

test('refined and translated events cannot open a segment', () => {
  const state = createState()
  applyEvent(state, event({ segmentId: 'gone', sequence: 9, revision: 2, kind: 'refined', text: '迟到精修' }))
  applyEvent(state, event({
    segmentId: 'gone',
    sequence: 10,
    revision: 3,
    kind: 'translated',
    text: '迟到精修',
    translation: { language: 'en', text: 'Late.', basedOnRevision: 2 }
  }))
  assert.deepEqual(state.segments, [])

  /* partial/final 照常开段。 */
  applyEvent(state, event({ segmentId: 'fresh', sequence: 11, revision: 1, text: '新段' }))
  assert.equal(state.segments.length, 1)
})

test('hydrated translation state matches live folding semantics', () => {
  const hydrated = hydrateState(canonicalState([canonicalSegment({
    segmentId: 'segment-t',
    sequence: 4,
    kind: 'translated',
    textRevision: 4,
    translation: { language: 'en', text: 'Done.', basedOnRevision: 3 },
    translationRevision: 4
  })]))

  const live = createState()
  applyEvent(live, event({ segmentId: 'segment-t', sequence: 3, revision: 3, kind: 'final', text: '定稿。', t1: 2 }))
  applyEvent(live, event({
    segmentId: 'segment-t',
    sequence: 4,
    revision: 4,
    kind: 'translated',
    text: '定稿。',
    t1: 2,
    translation: { language: 'en', text: 'Done.', basedOnRevision: 3 }
  }))

  assert.deepEqual(hydrated.segments, live.segments)
})
