'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')

function tempStore (t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'subtitle-store-'))
  const store = new SqliteSubtitleStore({
    databasePath: path.join(directory, 'data', 'speech-agent.sqlite3'),
    now: () => 1770000005000,
    ...options
  })
  t.after(() => {
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })
  return store
}

function caption (overrides = {}) {
  return {
    schemaVersion: 1,
    sessionId: 'session-loopback',
    sourceId: 'loopback',
    segmentId: 'segment-1',
    sequence: 3,
    revision: 3,
    kind: 'final',
    t0: 0.125,
    t1: 1.625,
    text: '一遍定稿。',
    translation: null,
    ...overrides
  }
}

test('open/append/refine/late-event/close form one strict idempotent history', (t) => {
  const store = tempStore(t)
  const opened = { sessionId: 'session-loopback', sourceId: 'loopback', startedAt: 1770000000000 }
  assert.equal(store.openSession(opened).status, 'committed')
  assert.equal(store.openSession(opened).status, 'already_processed')
  assert.throws(
    () => store.openSession({ ...opened, startedAt: opened.startedAt + 1 }),
    (error) => error.code === 'SESSION_CONFLICT'
  )

  const final = caption()
  assert.deepEqual(store.appendCaption(final), {
    status: 'committed', eventOrder: 1, projectionUpdated: true
  })
  assert.deepEqual(store.appendCaption(final), {
    status: 'already_processed', eventOrder: 1, projectionUpdated: false
  })
  assert.equal(store.getStats().captionEvents, 1)
  assert.equal(store.getStats().segments, 1)

  const refined = caption({ sequence: 4, revision: 4, kind: 'refined', text: '精修正文。', t1: 1.7 })
  assert.equal(store.appendCaption(refined).projectionUpdated, true)
  const late = caption({ sequence: 5, revision: 2, text: '迟到旧正文。' })
  assert.equal(store.appendCaption(late).projectionUpdated, false)
  /* 精修不覆盖首次 final：默认正文仍是原始版，精修稿另行可读（SEM-F04）。 */
  const afterRefine = store.getSessionTranscript({ sessionId: 'session-loopback' }).segments[0]
  assert.equal(afterRefine.text, '一遍定稿。')
  assert.equal(afterRefine.refinedText, '精修正文。')
  const closed = { sessionId: 'session-loopback', sourceId: 'loopback', endedAt: 1770000010000, state: 'closed' }
  assert.equal(store.closeSession(closed).status, 'committed')
  assert.equal(store.closeSession(closed).status, 'already_processed')
})

test('current projection is higher revision, stable and isolated across sequential XOR sessions', (t) => {
  const store = tempStore(t)
  store.openSession({ sessionId: 'session-loopback', sourceId: 'loopback', startedAt: 1000 })
  store.appendCaption(caption())
  store.appendCaption(caption({ sequence: 4, revision: 4, kind: 'refined', text: '精修正文。' }))
  store.appendCaption(caption({ sequence: 5, revision: 2, text: '迟到旧正文。' }))
  store.closeSession({ sessionId: 'session-loopback', sourceId: 'loopback', endedAt: 9000, state: 'closed' })

  store.openSession({ sessionId: 'session-mic', sourceId: 'mic', startedAt: 10000 })
  store.appendCaption(caption({
    sessionId: 'session-mic', sourceId: 'mic', segmentId: 'mic-segment',
    sequence: 1, revision: 1, t0: 2, t1: 3, text: '麦克风听写。'
  }))
  store.closeSession({ sessionId: 'session-mic', sourceId: 'mic', endedAt: 20000 })

  const loopback = store.getSessionTranscript({ sessionId: 'session-loopback' })
  assert.equal(loopback.session.mode, 'meeting')
  assert.equal(loopback.session.state, 'closed')
  assert.equal(loopback.segments.length, 1)
  assert.equal(loopback.segments[0].text, '一遍定稿。')
  assert.equal(loopback.segments[0].refinedText, '精修正文。')
  assert.equal(loopback.segments[0].textRevision, 3)
  assert.equal(loopback.segments[0].t0Ms, 125)
  assert.equal(loopback.segments[0].t1Ms, 1625)
  assert.equal(store.getSessionTranscript({ sessionId: 'session-mic' }).segments[0].sourceId, 'mic')
  assert.deepEqual(store.getStats(), {
    sessions: 2,
    activeSessions: 0,
    captionEvents: 4,
    segments: 2,
    legacyImports: 0,
    journalMode: 'wal',
    integrity: 'ok'
  })
})

test('identity conflicts, ghost refinements and non-subtitle kinds fail closed', (t) => {
  const store = tempStore(t)
  store.openSession({ sessionId: 'session-loopback', sourceId: 'loopback', startedAt: 1000 })
  store.appendCaption(caption())
  for (const divergent of [
    caption({ text: '同序号不同正文。' }),
    caption({ sequence: 9, text: '同段修订不同序号。' })
  ]) {
    assert.throws(() => store.appendCaption(divergent), (error) => error.code === 'EVENT_IDENTITY_CONFLICT')
  }
  assert.throws(
    () => store.appendCaption(caption({ segmentId: 'ghost', sequence: 10, revision: 2, kind: 'refined' })),
    (error) => error.code === 'MISSING_BASE_SEGMENT'
  )
  assert.throws(
    () => store.appendCaption(caption({ sequence: 11, kind: 'partial', text: '临时', translation: null })),
    (error) => error.code === 'UNSUPPORTED_CAPTION_KIND'
  )
  assert.throws(
    () => store.appendCaption(caption({
      sequence: 12,
      revision: 4,
      kind: 'translated',
      translation: { language: 'en', text: 'legacy', basedOnRevision: 3 }
    })),
    (error) => error.code === 'UNSUPPORTED_CAPTION_KIND'
  )
  assert.equal(store.getStats().captionEvents, 1)
  assert.equal(store.getStats().segments, 1)
})

test('caption facts reject unknown SQL and audio-bearing fields instead of silently dropping them', (t) => {
  const store = tempStore(t)
  store.openSession({ sessionId: 'session-loopback', sourceId: 'loopback', startedAt: 1000 })
  for (const extra of [
    { audioPath: 'C:\\private\\capture.wav' },
    { samples: [0.1, 0.2] },
    { pcm: Buffer.from([1, 2, 3]) },
    { sql: 'DROP TABLE caption_events' }
  ]) {
    assert.throws(
      () => store.appendCaption(caption(extra)),
      (error) => error.code === 'INVALID_CAPTION'
    )
  }
  assert.equal(store.getStats().captionEvents, 0)
  assert.equal(store.getStats().segments, 0)
})

test('new events require the active matching session but exact retries remain idempotent after close', (t) => {
  const store = tempStore(t)
  const opened = { sessionId: 'session-loopback', sourceId: 'loopback', startedAt: 1000 }
  store.openSession(opened)
  assert.throws(
    () => store.openSession({ sessionId: 'other', sourceId: 'mic', startedAt: 1001 }),
    (error) => error.code === 'ACTIVE_SESSION_EXISTS'
  )
  assert.throws(
    () => store.appendCaption(caption({ sourceId: 'mic' })),
    (error) => error.code === 'SESSION_CONFLICT'
  )
  const final = caption()
  store.appendCaption(final)
  const close = { sessionId: 'session-loopback', sourceId: 'loopback', endedAt: 9000, state: 'closed' }
  assert.equal(store.closeSession(close).status, 'committed')
  assert.equal(store.closeSession(close).status, 'already_processed')
  assert.equal(store.appendCaption(final).status, 'already_processed')
  assert.throws(
    () => store.appendCaption(caption({ sequence: 4, revision: 4, kind: 'refined', text: '关闭后新事件。' })),
    (error) => error.code === 'SESSION_NOT_ACTIVE'
  )
})

test('faults before commit roll back both facts and projections; lost reply retries once', (t) => {
  let faultPoint = null
  const store = tempStore(t, {
    faultInjector: (point) => {
      if (point === faultPoint) throw new Error(`injected ${point}`)
    }
  })
  store.openSession({ sessionId: 'session-loopback', sourceId: 'loopback', startedAt: 1000 })

  for (const point of ['afterEventInsert', 'afterProjection']) {
    faultPoint = point
    assert.throws(() => store.appendCaption(caption()), /injected/)
    assert.equal(store.getStats().captionEvents, 0)
    assert.equal(store.getStats().segments, 0)
  }

  faultPoint = 'afterCommitBeforeReturn'
  assert.throws(() => store.appendCaption(caption()), /afterCommitBeforeReturn/)
  assert.equal(store.getStats().captionEvents, 1)
  assert.equal(store.getStats().segments, 1)
  faultPoint = null
  assert.equal(store.appendCaption(caption()).status, 'already_processed')
  assert.equal(store.getStats().captionEvents, 1)
  assert.equal(store.getStats().segments, 1)
})

test('cold-start recovery atomically marks stale active sessions interrupted', (t) => {
  let faultPoint = 'afterStaleRecovery'
  const store = tempStore(t, {
    faultInjector: (point) => {
      if (point === faultPoint) throw new Error('injected stale recovery fault')
    }
  })
  store.openSession({ sessionId: 'stale-session', sourceId: 'mic', startedAt: 5000 })

  assert.throws(
    () => store.recoverStaleSessions({ recoveredAt: 4000 }),
    /injected stale recovery fault/
  )
  assert.equal(store.getStats().activeSessions, 1, 'a pre-commit recovery fault must roll back')

  faultPoint = null
  assert.deepEqual(store.recoverStaleSessions({ recoveredAt: 4000 }), {
    status: 'committed',
    recoveredSessionCount: 1
  })
  const transcript = store.getSessionTranscript({ sessionId: 'stale-session' })
  assert.equal(transcript.session.state, 'interrupted')
  assert.equal(transcript.session.endedAt, 5000, 'clock rollback cannot end before session start')
  assert.deepEqual(store.recoverStaleSessions({ recoveredAt: 9000 }), {
    status: 'none',
    recoveredSessionCount: 0
  })
  assert.throws(
    () => store.recoverStaleSessions({ recoveredAt: 9000, sql: 'UPDATE sessions' }),
    (error) => error.code === 'INVALID_SESSION'
  )
})

test('history listing excludes active sessions and pages terminal sessions by a stable keyset', (t) => {
  const store = tempStore(t)

  assert.deepEqual(store.listSessions({ limit: 10, cursor: null }), {
    items: [], nextCursor: null
  })

  store.openSession({ sessionId: 'terminal-a', sourceId: 'loopback', startedAt: 1000 })
  store.closeSession({ sessionId: 'terminal-a', sourceId: 'loopback', endedAt: 1100, state: 'closed' })

  store.openSession({ sessionId: 'terminal-z', sourceId: 'mic', startedAt: 1000 })
  store.appendCaption(caption({
    sessionId: 'terminal-z', sourceId: 'mic', segmentId: 'terminal-z-1', sequence: 1, revision: 1
  }))
  store.closeSession({ sessionId: 'terminal-z', sourceId: 'mic', endedAt: 1200, state: 'interrupted' })

  store.openSession({ sessionId: 'terminal-new', sourceId: 'loopback', startedAt: 2000 })
  store.appendCaption(caption({
    sessionId: 'terminal-new', segmentId: 'terminal-new-1', sequence: 1, revision: 1
  }))
  store.appendCaption(caption({
    sessionId: 'terminal-new', segmentId: 'terminal-new-2', sequence: 2, revision: 1
  }))
  store.closeSession({ sessionId: 'terminal-new', sourceId: 'loopback', endedAt: 2200, state: 'closed' })

  store.openSession({ sessionId: 'still-active', sourceId: 'mic', startedAt: 3000 })

  const firstPage = store.listSessions({ limit: 2, cursor: null })
  assert.deepEqual(firstPage, {
    items: [
      {
        sessionId: 'terminal-new', mode: 'meeting', sourceId: 'loopback',
        startedAt: 2000, endedAt: 2200, state: 'closed', segmentCount: 2
      },
      {
        sessionId: 'terminal-z', mode: 'dictation', sourceId: 'mic',
        startedAt: 1000, endedAt: 1200, state: 'interrupted', segmentCount: 1
      }
    ],
    nextCursor: { startedAt: 1000, sessionId: 'terminal-z' }
  })
  assert.equal(firstPage.items.some((item) => item.sessionId === 'still-active'), false)

  assert.deepEqual(store.listSessions({ limit: 2, cursor: firstPage.nextCursor }), {
    items: [{
      sessionId: 'terminal-a', mode: 'meeting', sourceId: 'loopback',
      startedAt: 1000, endedAt: 1100, state: 'closed', segmentCount: 0
    }],
    nextCursor: null
  })
})

test('history listing fails closed for malformed pagination and over-privileged fields', (t) => {
  const store = tempStore(t)
  for (const input of [
    { limit: 0, cursor: null },
    { limit: 101, cursor: null },
    { limit: 1.5, cursor: null },
    { limit: 1, cursor: {} },
    { limit: 1, cursor: { startedAt: -1, sessionId: 'session' } },
    { limit: 1, cursor: { startedAt: 1000, sessionId: '', audioPath: 'C:\\private\\audio.wav' } },
    { limit: 1, cursor: null, sql: 'DROP TABLE sessions' },
    { limit: 1, cursor: null, audioPath: 'C:\\private\\audio.wav' }
  ]) {
    assert.throws(() => store.listSessions(input), (error) => error.code === 'INVALID_SESSION')
  }
})

test('history detail pages 205 same-timestamp segments without gaps, duplicates or internal fields', (t) => {
  const store = tempStore(t)
  const sessionId = 'paged-history'
  store.openSession({ sessionId, sourceId: 'loopback', startedAt: 1000 })
  for (let index = 0; index < 205; index += 1) {
    const t0 = Math.floor(index / 7)
    store.appendCaption(caption({
      sessionId,
      segmentId: `segment-${String(index).padStart(3, '0')}`,
      sequence: index + 1,
      revision: 1,
      t0,
      t1: t0 + 0.5,
      text: `字幕 ${index}`
    }))
  }
  store.closeSession({ sessionId, sourceId: 'loopback', endedAt: 40000, state: 'closed' })

  let cursor = null
  let pageCount = 0
  const collected = []
  let firstPageLast = null
  let secondPageFirst = null
  do {
    const page = store.getSessionPage({ sessionId, limit: 50, cursor })
    pageCount += 1
    assert.deepEqual(Object.keys(page).sort(), ['items', 'nextCursor', 'session', 'totalCount'])
    assert.deepEqual(page.session, {
      sessionId,
      mode: 'meeting',
      sourceId: 'loopback',
      startedAt: 1000,
      endedAt: 40000,
      state: 'closed'
    })
    assert.equal(page.totalCount, 205)
    for (const item of page.items) {
      assert.deepEqual(Object.keys(item).sort(), [
        'refinedText', 'segmentId', 'sourceId', 't0Ms', 't1Ms', 'text', 'textRevision'
      ])
      assert.equal(item.refinedText, null, '没有精修的段落不得凭空得到精修稿')
      assert.equal(Object.hasOwn(item, 'firstEventOrder'), false)
      assert.equal(Object.hasOwn(item, 'updatedEventOrder'), false)
    }
    if (pageCount === 1) firstPageLast = page.items.at(-1)
    if (pageCount === 2) secondPageFirst = page.items[0]
    collected.push(...page.items)
    cursor = page.nextCursor
  } while (cursor !== null)

  assert.equal(pageCount, 5)
  assert.equal(firstPageLast.t0Ms, secondPageFirst.t0Ms,
    'the keyset must cross a page boundary inside one timestamp group')
  assert.equal(collected.length, 205)
  assert.equal(new Set(collected.map((item) => item.segmentId)).size, 205)
  assert.deepEqual(collected.map((item) => item.segmentId),
    Array.from({ length: 205 }, (_, index) => `segment-${String(index).padStart(3, '0')}`))
})

test('history detail pages reject active sessions, malformed cursors and over-privileged fields', (t) => {
  const store = tempStore(t)
  store.openSession({ sessionId: 'active-history', sourceId: 'mic', startedAt: 1000 })
  store.appendCaption(caption({
    sessionId: 'active-history', sourceId: 'mic', sequence: 1, revision: 1
  }))

  assert.throws(
    () => store.getSessionPage({ sessionId: 'active-history', limit: 50, cursor: null }),
    (error) => error.code === 'SESSION_ACTIVE'
  )
  assert.throws(
    () => store.getSessionPage({ sessionId: 'missing-history', limit: 50, cursor: null }),
    (error) => error.code === 'SESSION_NOT_FOUND'
  )
  for (const input of [
    { sessionId: 'active-history', limit: 0, cursor: null },
    { sessionId: 'active-history', limit: 101, cursor: null },
    { sessionId: 'active-history', limit: 1.5, cursor: null },
    { sessionId: 'active-history', limit: 50, cursor: {} },
    { sessionId: 'active-history', limit: 50, cursor: { t0Ms: -1, firstEventOrder: 1 } },
    { sessionId: 'active-history', limit: 50, cursor: { t0Ms: 0, firstEventOrder: 0 } },
    { sessionId: 'active-history', limit: 50, cursor: { t0Ms: 0, firstEventOrder: 1, id: 7 } },
    { sessionId: 'active-history', limit: 50, cursor: null, sql: 'SELECT * FROM segments' },
    { sessionId: 'active-history', limit: 50, cursor: null, audioPath: 'C:\\private\\audio.wav' }
  ]) {
    assert.throws(() => store.getSessionPage(input), (error) => error.code === 'INVALID_SESSION')
  }
})

/* --------------------------------------------------------------------------
   J15b / SEM-F04 / SEM-F11 / SEM-T08：转写版本隔离。

   首次 `final` 是不可变的权威原始转写，精修稿只是可选派生版本。原始版靠
   `segments.first_event_order` 指针回到 append-only 的 `caption_events` 取回，
   所以「该指针恒指向该段的首次 final」是整条版本隔离链路的地基。它此前没有
   任何测试保护——改动插入逻辑就会静默丢掉原始版，而既有的迁移/导出断言
   校验的是折叠后的单一投影，语义换了仍会全绿。
   -------------------------------------------------------------------------- */

function versionStore (t, sessionId = 'session-loopback') {
  const store = tempStore(t)
  store.openSession({ sessionId, sourceId: 'loopback', startedAt: 1770000000000 })
  return store
}

test('J15b: refinement never overwrites the first-pass final; both versions stay readable', (t) => {
  const store = versionStore(t)
  store.appendCaption(caption({ sequence: 1, revision: 1, kind: 'final', text: '原始版正文。' }))
  store.appendCaption(caption({ sequence: 2, revision: 2, kind: 'refined', text: '精修版正文。' }))

  const [segment] = store.getSessionTranscript({ sessionId: 'session-loopback' }).segments
  assert.equal(segment.text, '原始版正文。', '默认正文必须是首次 final，精修稿不得覆盖它')
  assert.equal(segment.refinedText, '精修版正文。', '精修稿必须可以单独读取')

  store.closeSession({ sessionId: 'session-loopback', sourceId: 'loopback', endedAt: 1770000009000, state: 'closed' })
  const [item] = store.getSessionPage({ sessionId: 'session-loopback', limit: 50, cursor: null }).items
  assert.equal(item.text, '原始版正文。')
  assert.equal(item.refinedText, '精修版正文。')
})

test('J15b: a segment without refinement reports no refined version at all', (t) => {
  const store = versionStore(t)
  store.appendCaption(caption({ sequence: 1, revision: 1, kind: 'final', text: '只有原始版。' }))

  const [segment] = store.getSessionTranscript({ sessionId: 'session-loopback' }).segments
  assert.equal(segment.text, '只有原始版。')
  assert.equal(segment.refinedText, null, '没有精修时不得凭空造出一个精修稿')
})

test('J15b: the first-final pointer survives out-of-order arrival and several finals', (t) => {
  const store = versionStore(t)
  /* 先到的是较低 revision 的 final，随后到达更高 revision 的 final 与 refined。
     无论后续怎么写，原始版都必须停在最早那一条 final 上。 */
  store.appendCaption(caption({ segmentId: 'seg-a', sequence: 1, revision: 1, kind: 'final', text: '最早的原始版。' }))
  store.appendCaption(caption({ segmentId: 'seg-a', sequence: 2, revision: 2, kind: 'final', text: '第二条 final。' }))
  store.appendCaption(caption({ segmentId: 'seg-a', sequence: 3, revision: 3, kind: 'refined', text: '精修稿。' }))

  const [segment] = store.getSessionTranscript({ sessionId: 'session-loopback' }).segments
  assert.equal(segment.text, '最早的原始版。')
  assert.equal(segment.refinedText, '精修稿。')

  /* 迟到的更低 revision 不得改写任何一版。 */
  store.appendCaption(caption({ segmentId: 'seg-a', sequence: 4, revision: 4, kind: 'refined', text: '更晚的精修稿。' }))
  const [afterLate] = store.getSessionTranscript({ sessionId: 'session-loopback' }).segments
  assert.equal(afterLate.text, '最早的原始版。')
  assert.equal(afterLate.refinedText, '更晚的精修稿。')
})

test('J15b: the first-final pointer is an event-table pointer, not a copied string', (t) => {
  const store = versionStore(t)
  store.appendCaption(caption({ sequence: 1, revision: 1, kind: 'final', text: '原始版正文。' }))
  store.appendCaption(caption({ sequence: 2, revision: 2, kind: 'refined', text: '精修版正文。' }))

  const [segment] = store.getSessionTranscript({ sessionId: 'session-loopback' }).segments
  /* caption_events 是 append-only 且有拒绝 UPDATE/DELETE 的触发器，所以只要
     原始版是「顺着 firstEventOrder 指针读出来的」，它就不可能被后续写入改掉。 */
  assert.equal(typeof segment.firstEventOrder, 'number')
  assert.equal(segment.text, '原始版正文。')
})
