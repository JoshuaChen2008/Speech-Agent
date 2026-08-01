'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  KEEP_SEGMENTS,
  applyEvent,
  createState,
  hydrateState,
  selectFlow,
  countVisibleLines
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

  const flow = selectFlow(state)
  assert.equal(flow.at(-1).text, '定稿。')
  assert.equal(flow.at(-1).isPartial, false)
  /* 译文仍留在状态里供后续派生能力使用，但 MVP 的字幕流不渲染它（SEM-F05）。 */
  assert.equal(state.segments.at(-1).translation.text, 'Done.')
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

/* --------------------------------------------------------------------------
   J15a / SEM-F20：固定高度字幕流的纯逻辑层。
   这一层只回答「哪些段按什么顺序进流」和「视口能完整放下几行」；
   换行位置与顶部裁剪由 Chromium 完成，另由 caption-layout smoke 取证。
   -------------------------------------------------------------------------- */

test('flow keeps segments oldest-first so the newest line always sits at the clipped viewport bottom', () => {
  const state = createState()
  applyEvent(state, event({ segmentId: 'seg-1', sequence: 1, revision: 1, kind: 'final', text: '第一句' }))
  applyEvent(state, event({ segmentId: 'seg-2', sequence: 2, revision: 1, kind: 'partial', text: '第二句还在说' }))

  const flow = selectFlow(state)
  assert.deepEqual(flow.map((item) => item.text), ['第一句', '第二句还在说'])
  /* 视口从顶部裁剪，所以「当前 partial 永不被挤掉」由顺序结构性保证。 */
  assert.equal(flow.at(-1).isPartial, true)
  assert.equal(flow.at(0).isPartial, false)
})

test('flow drops empty segments instead of spending a whole visual line on nothing', () => {
  const state = createState()
  state.sessionId = 'session-empty'
  state.segments.push({
    segmentId: 'seg-empty', sourceId: 'mic', sequence: 1, kind: 'partial',
    text: '', textRevision: 1, translation: null, translationRevision: 0, t0: 0, t1: 0
  })
  applyEvent(state, event({ sessionId: 'session-empty', segmentId: 'seg-real', sequence: 2, revision: 1, text: '有内容' }))

  assert.deepEqual(selectFlow(state).map((item) => item.segmentId), ['seg-real'])
})

test('a late refinement to a still-visible segment replaces that line instead of appending one', () => {
  const state = createState()
  applyEvent(state, event({ segmentId: 'seg-1', sequence: 1, revision: 1, kind: 'final', text: '原始版' }))
  applyEvent(state, event({ segmentId: 'seg-1', sequence: 2, revision: 2, kind: 'refined', text: '精修版' }))

  assert.deepEqual(selectFlow(state), [{ segmentId: 'seg-1', text: '精修版', isPartial: false }])
})

test('visible lines round down to whole lines so the top edge never shows a clipped half line', () => {
  /* 110px 可用高度、30px 字号、1.35 行高 → 行高 40.5px，放得下 2 整行（81px），
     第三行会露出 29px 的半行，必须排除。 */
  assert.equal(countVisibleLines({ available: 110, fontSize: 30, lineHeight: 1.35 }), 2)
  assert.equal(countVisibleLines({ available: 81, fontSize: 30, lineHeight: 1.35 }), 2)
  assert.equal(countVisibleLines({ available: 80.9, fontSize: 30, lineHeight: 1.35 }), 1)
})

test('larger font sizes reduce the visible line count for the same viewport', () => {
  const available = 340
  const at24 = countVisibleLines({ available, fontSize: 24, lineHeight: 1.35 })
  const at30 = countVisibleLines({ available, fontSize: 30, lineHeight: 1.35 })
  const at38 = countVisibleLines({ available, fontSize: 38, lineHeight: 1.35 })

  assert.deepEqual([at24, at30, at38], [10, 8, 6])
  assert.ok(at24 > at30 && at30 > at38, '字号变大后同一视口必须容纳更少的整行')
})

test('visible lines never drop below one, even for degenerate viewports or broken config', () => {
  assert.equal(countVisibleLines({ available: 10, fontSize: 38, lineHeight: 1.35 }), 1)
  assert.equal(countVisibleLines({ available: 0, fontSize: 30, lineHeight: 1.35 }), 1)
  assert.equal(countVisibleLines({ available: 110, fontSize: Number.NaN, lineHeight: 1.35 }), 1)
  assert.equal(countVisibleLines({ available: 110, fontSize: 30, lineHeight: 0 }), 1)
  assert.equal(countVisibleLines({ available: Number.POSITIVE_INFINITY, fontSize: 30, lineHeight: 1.35 }), 1)
})
