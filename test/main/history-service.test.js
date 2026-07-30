'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  HistoryError,
  HistoryService,
  buildExport,
  originalSegments
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
    segments: overrides.segments || [
      {
        segmentId: 'segment-1',
        sourceId: 'loopback',
        text: '精修后的当前字幕。',
        textRevision: 2,
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

function makeService (overrides = {}) {
  const stored = overrides.transcript || transcript()
  const gateway = overrides.gateway || {
    listSessions: async (input) => ({ items: [{ sessionId: 'terminal' }], nextCursor: input.cursor }),
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

test('history detail is a detached terminal transcript and rejects active sessions', async () => {
  const stored = transcript()
  const service = makeService({ transcript: stored })
  const result = await service.getSession('session:history/1')

  result.session.state = 'interrupted'
  result.segments[0].text = 'renderer mutation'
  assert.equal(stored.session.state, 'closed')
  assert.equal(stored.segments[0].text, '精修后的当前字幕。')

  const active = makeService({ transcript: transcript({ session: { state: 'active', endedAt: null } }) })
  await assert.rejects(active.getSession('session:history/1'),
    (error) => error instanceof HistoryError && error.code === 'SESSION_ACTIVE')
  await assert.rejects(service.getSession(''),
    (error) => error instanceof HistoryError && error.code === 'INVALID_SESSION')
})

test('txt, markdown and srt exports contain only the current subtitle projection', () => {
  const value = transcript()
  const projected = originalSegments(value)
  assert.deepEqual(projected.map((segment) => [segment.text, segment.t0, segment.t1, segment.translation]), [
    ['精修后的当前字幕。', 0.25, 1.8, null],
    ['第二条字幕', 2, 4.75, null]
  ])

  const txt = buildExport(value, 'txt')
  const md = buildExport(value, 'md')
  const srt = buildExport(value, 'srt')
  assert.equal(txt.content, '精修后的当前字幕。\n第二条字幕\n')
  assert.match(md.content, /- 精修后的当前字幕。\n- 第二条字幕/)
  assert.equal(srt.content,
    '1\n00:00:00,250 --> 00:00:01,800\n精修后的当前字幕。\n\n' +
    '2\n00:00:02,000 --> 00:00:04,750\n第二条字幕\n')
  for (const output of [txt, md, srt]) {
    assert.doesNotMatch(output.content, /must not escape|capture\.wav/i)
    assert.match(output.suggestedName, /^\d{8}-\d{6}_loopback_session_history_1\.(?:txt|md|srt)$/)
  }
  assert.throws(() => buildExport(value, 'html'),
    (error) => error instanceof HistoryError && error.code === 'INVALID_EXPORT_FORMAT')
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
  assert.deepEqual(result, { status: 'cancelled', format: 'txt' })
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
  assert.deepEqual(result, { status: 'saved', format: 'srt' })
  assert.equal(Object.hasOwn(result, 'filePath'), false)
  assert.equal(writes.length, 1)
  assert.equal(writes[0][0], 'D:\\chosen-by-os\\meeting.srt')
  assert.match(writes[0][1], /精修后的当前字幕。/)
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
