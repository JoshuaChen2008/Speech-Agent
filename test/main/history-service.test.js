'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  HistoryError,
  HistoryService,
  buildExport,
  versionedSegments
} = require('../../src/main/services/history-service')

function transcript (overrides = {}) {
  return {
    session: {
      sessionId: 'session:history/1',
      mode: 'meeting',
      sourceId: 'loopback',
      startedAt: 1775001000000,
      endedAt: 1775001004800,
      state: 'closed',
      ...overrides.session
    },
    refinement: {
      segmentCount: 2,
      refinedSegmentCount: 1,
      refinementResultStatus: 'known',
      refinementEnabled: true,
      refinementFaultCode: null,
      ...overrides.refinement
    },
    segments: overrides.segments || [
      {
        segmentId: 'segment-1',
        sourceId: 'loopback',
        text: '第一次定稿的字幕。',
        refinedText: '精修后的字幕。',
        textRevision: 1,
        t0Ms: 250,
        t1Ms: 1800,
        firstEventOrder: 1,
        updatedEventOrder: 2,
        translation: { language: 'en', text: 'must not escape' },
        audioPath: 'C:\\private\\capture.wav'
      },
      {
        segmentId: 'segment-2',
        sourceId: 'loopback',
        text: '第二条字幕',
        textRevision: 1,
        t0Ms: 2000,
        t1Ms: 4750,
        firstEventOrder: 3,
        updatedEventOrder: 3
      }
    ]
  }
}

function sessionPage (overrides = {}) {
  return {
    session: {
      sessionId: 'session:history/1',
      mode: 'meeting',
      sourceId: 'loopback',
      startedAt: 1775001000000,
      endedAt: 1775001004800,
      state: 'closed',
      ...overrides.session
    },
    totalCount: overrides.totalCount === undefined ? 2 : overrides.totalCount,
    refinement: {
      segmentCount: 2,
      refinedSegmentCount: 1,
      refinementResultStatus: 'known',
      refinementEnabled: true,
      refinementFaultCode: null,
      ...overrides.refinement
    },
    items: overrides.items || [
      {
        segmentId: 'segment-1',
        sourceId: 'loopback',
        /* 默认正文恒为首次 final；精修稿并存但不遮蔽它（SEM-F04/F11）。 */
        text: '第一次定稿的字幕。',
        refinedText: '精修后的字幕。',
        textRevision: 1,
        t0Ms: 250,
        t1Ms: 1800
      },
      {
        segmentId: 'segment-2',
        sourceId: 'loopback',
        text: '第二条字幕',
        refinedText: null,
        textRevision: 1,
        t0Ms: 2000,
        t1Ms: 4750
      }
    ],
    nextCursor: Object.hasOwn(overrides, 'nextCursor') ? overrides.nextCursor : null,
    ...overrides.root
  }
}

function sessionList (overrides = {}) {
  return {
    items: overrides.items || [{
      sessionId: 'session:history/1',
      mode: 'meeting',
      sourceId: 'loopback',
      startedAt: 1775001000000,
      endedAt: 1775001004800,
      state: 'closed',
      segmentCount: 2
    }],
    nextCursor: Object.hasOwn(overrides, 'nextCursor') ? overrides.nextCursor : null,
    ...overrides.root
  }
}

function makeService (overrides = {}) {
  const stored = overrides.transcript || transcript()
  const gateway = overrides.gateway || {
    listSessions: async () => sessionList(),
    getSessionPage: async () => overrides.page || sessionPage(),
    getSessionTranscript: async () => stored
  }
  return new HistoryService({
    gateway,
    showSaveDialog: overrides.showSaveDialog || (async () => ({ canceled: true })),
    writeFile: overrides.writeFile
  })
}

test('history listing accepts only the narrow pagination shape and clones caller input', async () => {
  let received = null
  const gateway = {
    listSessions: async (input) => {
      received = input
      input.cursor.startedAt = 0
      return { items: [], nextCursor: null }
    },
    getSessionPage: async () => sessionPage(),
    getSessionTranscript: async () => transcript()
  }
  const service = makeService({ gateway })
  const request = { limit: 20, cursor: { startedAt: 1775001000000, sessionId: 'cursor-session' } }

  assert.deepEqual(await service.listSessions(request), { items: [], nextCursor: null })
  assert.notEqual(received, request)
  assert.notEqual(received.cursor, request.cursor)
  assert.equal(request.cursor.startedAt, 1775001000000)
  assert.throws(() => service.listSessions({ limit: 20, cursor: null, sql: 'DROP TABLE sessions' }),
    (error) => error instanceof HistoryError && error.code === 'INVALID_HISTORY_REQUEST')
  assert.throws(() => service.listSessions({ limit: 20 }), /历史记录请求无效/)
})

test('history listing rebuilds a strict terminal allowlist and rejects privileged gateway data', async (t) => {
  const request = { limit: 1, cursor: null }
  const stored = sessionList({
    nextCursor: { startedAt: 1775001000000, sessionId: 'session:history/1' }
  })
  const gateway = {
    listSessions: async () => stored,
    getSessionPage: async () => sessionPage(),
    getSessionTranscript: async () => transcript()
  }
  const result = await makeService({ gateway }).listSessions(request)
  assert.deepEqual(result, stored)
  result.items[0].state = 'interrupted'
  result.nextCursor.sessionId = 'renderer-mutation'
  assert.equal(stored.items[0].state, 'closed')
  assert.equal(stored.nextCursor.sessionId, 'session:history/1')

  const invalidLists = [
    sessionList({ root: { text: 'transcript leak' } }),
    sessionList({ items: [{ ...sessionList().items[0], audioPath: 'C:\\private\\capture.wav' }] }),
    sessionList({ items: [{ ...sessionList().items[0], translation: { text: 'leak' } }] }),
    sessionList({ items: [{ ...sessionList().items[0], state: 'active' }] }),
    sessionList({ items: [{ ...sessionList().items[0], mode: 'dictation' }] }),
    sessionList({
      nextCursor: { startedAt: 1775001000000, sessionId: 'session:history/1', sql: 'SELECT 1' }
    })
  ]
  for (const [index, value] of invalidLists.entries()) {
    await t.test(`invalid list ${index + 1}`, async () => {
      const invalidGateway = {
        ...gateway,
        listSessions: async () => value
      }
      await assert.rejects(
        makeService({ gateway: invalidGateway }).listSessions(request),
        (error) => error instanceof HistoryError && error.code === 'INVALID_HISTORY_DATA'
      )
    })
  }
})

test('history detail page is detached, terminal and accepts only its exact keyset request', async () => {
  const stored = sessionPage()
  let received = null
  const gateway = {
    listSessions: async () => ({ items: [], nextCursor: null }),
    getSessionPage: async (input) => {
      received = input
      return stored
    },
    getSessionTranscript: async () => transcript()
  }
  const service = makeService({ gateway })
  const request = { sessionId: 'session:history/1', limit: 2, cursor: null }
  const result = await service.getSessionPage(request)

  assert.notEqual(received, request)
  assert.deepEqual(received, request)
  result.session.state = 'interrupted'
  result.items[0].text = 'renderer mutation'
  assert.equal(stored.session.state, 'closed')
  assert.equal(stored.items[0].text, '第一次定稿的字幕。')
  await assert.rejects(
    service.getSessionPage({ sessionId: '', limit: 2, cursor: null }),
    (error) => error instanceof HistoryError && error.code === 'INVALID_SESSION'
  )
  await assert.rejects(
    service.getSessionPage({ sessionId: 'session:history/1', limit: 2, cursor: null, sql: 'SELECT 1' }),
    (error) => error instanceof HistoryError && error.code === 'INVALID_HISTORY_REQUEST'
  )
  await assert.rejects(
    service.getSessionPage({ sessionId: 'session:history/1', limit: 101, cursor: null }),
    (error) => error instanceof HistoryError && error.code === 'INVALID_HISTORY_REQUEST'
  )
  await assert.rejects(
    service.getSessionPage({
      sessionId: 'session:history/1', limit: 2,
      cursor: { t0Ms: 0, firstEventOrder: 1, id: 7 }
    }),
    (error) => error instanceof HistoryError && error.code === 'INVALID_HISTORY_REQUEST'
  )
})

test('history detail page rejects active, over-privileged and malformed gateway data', async (t) => {
  const invalidPages = [
    sessionPage({ session: { state: 'active', endedAt: null } }),
    sessionPage({ session: { state: 'unknown' } }),
    sessionPage({ root: { sql: 'SELECT * FROM segments' } }),
    sessionPage({ session: { audioPath: 'C:\\private\\capture.wav' } }),
    sessionPage({ items: [
      { ...sessionPage().items[0], translation: { language: 'en', text: 'secret' } },
      sessionPage().items[1]
    ] }),
    sessionPage({ items: [
      { ...sessionPage().items[0], audioPath: 'C:\\private\\capture.wav' },
      sessionPage().items[1]
    ] }),
    sessionPage({ items: [
      { ...sessionPage().items[0], firstEventOrder: 1 },
      sessionPage().items[1]
    ] }),
    sessionPage({ items: [
      sessionPage().items[0],
      { ...sessionPage().items[1], sql: 'SELECT 1' }
    ] }),
    sessionPage({ nextCursor: { t0Ms: 2000, firstEventOrder: 3, path: 'C:\\private' } })
  ]

  for (const [index, page] of invalidPages.entries()) {
    await t.test(`invalid page ${index + 1}`, async () => {
      const service = makeService({ page })
      await assert.rejects(
        service.getSessionPage({ sessionId: 'session:history/1', limit: 2, cursor: null }),
        (error) => error instanceof HistoryError &&
          (index === 0 ? error.code === 'SESSION_ACTIVE' : error.code === 'INVALID_HISTORY_DATA')
      )
    })
  }
})

test('history detail page requires a cursor matching the last item and strictly advancing', async () => {
  const items = sessionPage().items.map((item) => ({ ...item, t0Ms: 1000, t1Ms: 2000 }))
  const request = {
    sessionId: 'session:history/1',
    limit: 2,
    cursor: { t0Ms: 1000, firstEventOrder: 10 }
  }

  const valid = makeService({ page: sessionPage({
    totalCount: 3,
    refinement: { segmentCount: 3, refinedSegmentCount: 1 },
    items,
    nextCursor: { t0Ms: 1000, firstEventOrder: 12 }
  }) })
  assert.equal((await valid.getSessionPage(request)).nextCursor.firstEventOrder, 12)

  for (const nextCursor of [
    { t0Ms: 1000, firstEventOrder: 10 },
    { t0Ms: 1000, firstEventOrder: 9 },
    { t0Ms: 999, firstEventOrder: 99 },
    { t0Ms: 1001, firstEventOrder: 12 }
  ]) {
    const service = makeService({ page: sessionPage({
      totalCount: 3,
      refinement: { segmentCount: 3, refinedSegmentCount: 1 },
      items,
      nextCursor
    }) })
    await assert.rejects(
      service.getSessionPage(request),
      (error) => error instanceof HistoryError && error.code === 'INVALID_HISTORY_DATA'
    )
  }
})

test('history service constructor requires both paged reads and private full export reads', () => {
  assert.throws(() => new HistoryService({
    gateway: {
      listSessions: async () => ({ items: [], nextCursor: null }),
      getSessionTranscript: async () => transcript()
    },
    showSaveDialog: async () => ({ canceled: true })
  }), /history storage gateway is required/)
})

test('exports default to the first-pass original version in all three formats', () => {
  const value = transcript()
  const projected = versionedSegments(value, 'original')
  assert.deepEqual(projected.map((segment) => [segment.text, segment.t0, segment.t1, segment.translation]), [
    ['第一次定稿的字幕。', 0.25, 1.8, null],
    ['第二条字幕', 2, 4.75, null]
  ])

  const txt = buildExport(value, 'txt')
  const md = buildExport(value, 'md')
  const srt = buildExport(value, 'srt')
  assert.equal(txt.content, '第一次定稿的字幕。\n第二条字幕\n')
  assert.match(md.content, /- 第一次定稿的字幕。\n- 第二条字幕/)
  assert.equal(srt.content,
    '1\n00:00:00,250 --> 00:00:01,800\n第一次定稿的字幕。\n\n' +
    '2\n00:00:02,000 --> 00:00:04,750\n第二条字幕\n')
  for (const output of [txt, md, srt]) {
    assert.equal(output.version, 'original')
    assert.doesNotMatch(output.content, /must not escape|capture\.wav|精修后的字幕/i)
    assert.match(output.suggestedName, /^\d{8}-\d{6}_loopback_session_history_1_original\.(?:txt|md|srt)$/)
  }
  assert.throws(() => buildExport(value, 'html'),
    (error) => error instanceof HistoryError && error.code === 'INVALID_EXPORT_FORMAT')
})

test('an explicitly selected refined export carries the refined body and its own name', () => {
  const value = transcript()
  value.segments[1].refinedText = '第二条精修字幕。'
  value.refinement = {
    segmentCount: 2,
    refinedSegmentCount: 2,
    refinementResultStatus: 'known',
    refinementEnabled: true,
    refinementFaultCode: null
  }
  const original = buildExport(value, 'txt', 'original')
  const refined = buildExport(value, 'txt', 'refined')

  /* 精修版只替换有精修稿的段落；没有精修的段落回落到原始版，两版段落数
     必须保持可比——SEM-T08 要求两版的导出 digest 分别核对。 */
  assert.equal(refined.content, '精修后的字幕。\n第二条精修字幕。\n')
  assert.equal(refined.version, 'refined')
  assert.notEqual(refined.content, original.content)
  assert.equal(refined.content.trimEnd().split('\n').length, original.content.trimEnd().split('\n').length)
  assert.match(refined.suggestedName, /_refined\.txt$/)

  /* 未声明版本时永远是原始版；未知版本必须 fail closed。 */
  assert.equal(buildExport(value, 'txt').content, original.content)
  for (const bad of ['REFINED', 'latest', '', null, 1]) {
    assert.throws(() => buildExport(value, 'txt', bad),
      (error) => error instanceof HistoryError && error.code === 'INVALID_EXPORT_VERSION')
  }
})

test('J15c: incomplete refined exports identify every original fallback without changing original output', () => {
  const value = transcript()
  value.refinement = {
    segmentCount: 2,
    refinedSegmentCount: 1,
    refinementResultStatus: 'known',
    refinementEnabled: true,
    refinementFaultCode: null
  }

  const original = buildExport(value, 'txt', 'original')
  const incompleteTxt = buildExport(value, 'txt', 'refined')
  const incompleteMd = buildExport(value, 'md', 'refined')
  const incompleteSrt = buildExport(value, 'srt', 'refined')

  assert.equal(original.content, '第一次定稿的字幕。\n第二条字幕\n')
  assert.match(incompleteTxt.suggestedName, /_refined-incomplete\.txt$/)
  assert.match(incompleteTxt.content, /已精修 1\/2 段，1 段使用原始版/)
  assert.match(incompleteTxt.content, /\[原始版回退\] 第二条字幕/)
  assert.match(incompleteMd.content, /已精修 1\/2 段，1 段使用原始版/)
  assert.match(incompleteMd.content, /\[原始版回退\] 第二条字幕/)
  assert.match(incompleteSrt.content, /\[原始版回退\] 第二条字幕/)
})

test('J15c: refined export fails closed for zero refined segments, including an empty session', () => {
  const noneRefined = transcript({
    refinement: {
      segmentCount: 2,
      refinedSegmentCount: 0,
      refinementResultStatus: 'known',
      refinementEnabled: true,
      refinementFaultCode: null
    }
  })
  assert.throws(
    () => buildExport(noneRefined, 'txt', 'refined'),
    (error) => error instanceof HistoryError && error.code === 'REFINEMENT_UNAVAILABLE'
  )

  const empty = transcript({
    segments: [],
    refinement: {
      segmentCount: 0,
      refinedSegmentCount: 0,
      refinementResultStatus: 'known',
      refinementEnabled: false,
      refinementFaultCode: null
    }
  })
  assert.throws(
    () => buildExport(empty, 'srt', 'refined'),
    (error) => error instanceof HistoryError && error.code === 'REFINEMENT_UNAVAILABLE'
  )
})

test('cancelled export writes nothing and does not expose a filesystem path', async () => {
  let writeCount = 0
  const owner = { role: 'history-window' }
  let dialogOwner = null
  let dialogOptions = null
  const service = makeService({
    showSaveDialog: async (receivedOwner, options) => {
      dialogOwner = receivedOwner
      dialogOptions = options
      return { canceled: true, filePath: 'C:\\must-not-write.txt' }
    },
    writeFile: async () => { writeCount += 1 }
  })

  const result = await service.exportSession({ sessionId: 'session:history/1', format: 'txt' }, owner)
  assert.deepEqual(result, { status: 'cancelled', format: 'txt', version: 'original' })
  assert.equal(Object.hasOwn(result, 'filePath'), false)
  assert.equal(writeCount, 0)
  assert.equal(dialogOwner, owner)
  assert.equal(dialogOptions.defaultPath.endsWith('.txt'), true)
  assert.deepEqual(dialogOptions.filters, [{ name: '纯文本', extensions: ['txt'] }])
})

test('successful export writes only to the main-selected path and returns a path-free receipt', async () => {
  const writes = []
  const service = makeService({
    showSaveDialog: async () => ({ canceled: false, filePath: 'D:\\chosen-by-os\\meeting.srt' }),
    writeFile: async (...args) => { writes.push(args) }
  })

  const result = await service.exportSession({ sessionId: 'session:history/1', format: 'srt' })
  assert.deepEqual(result, { status: 'saved', format: 'srt', version: 'original' })
  assert.equal(Object.hasOwn(result, 'filePath'), false)
  assert.equal(writes.length, 1)
  assert.equal(writes[0][0], 'D:\\chosen-by-os\\meeting.srt')
  assert.match(writes[0][1], /第一次定稿的字幕。/)
  assert.deepEqual(writes[0][2], { encoding: 'utf8' })

  await assert.rejects(
    service.exportSession({ sessionId: 'session:history/1', format: 'txt', filePath: 'D:\\renderer.txt' }),
    (error) => error instanceof HistoryError && error.code === 'INVALID_HISTORY_REQUEST'
  )
  await assert.rejects(
    service.exportSession({ sessionId: 'session:history/1', format: 'html' }),
    (error) => error instanceof HistoryError && error.code === 'INVALID_EXPORT_FORMAT'
  )
})
