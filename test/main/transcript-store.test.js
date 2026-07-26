'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  TranscriptStore,
  exportMarkdown,
  exportSrt,
  exportText,
  foldSegments,
  formatSrtTime,
  readSessionFile,
  windowsSafeTimestamp
} = require('../../src/main/services/transcript-store')

function tempDirectory (t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-store-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function caption (overrides = {}) {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    sourceId: 'mic',
    segmentId: 'seg-mic-1',
    sequence: 1,
    revision: 1,
    kind: 'final',
    t0: 0,
    t1: 2.4,
    text: '第一句。',
    translation: null,
    ...overrides
  }
}

test('store writes windows-safe append-only session files and filters events', (t) => {
  const directory = tempDirectory(t)
  const store = new TranscriptStore({ directory, now: () => new Date(2026, 6, 27, 1, 2, 3) })

  const filePath = store.openSession('session-1')
  assert.equal(path.basename(filePath), '20260727-010203_session-1.jsonl')
  assert.ok(!path.basename(filePath).includes(':'), '文件名不得含 Windows 非法字符')
  assert.equal(store.openSession('session-1'), filePath, '重复 open 同一会话是 no-op')

  assert.equal(store.append(caption()), true)
  assert.equal(store.append(caption({ kind: 'partial', text: '第' })), false, 'partial 不入档')
  assert.equal(store.append(caption({ sessionId: 'other' })), false, '跨会话拒绝')
  assert.equal(store.append(caption({
    segmentId: 'seg-mic-1',
    sequence: 2,
    revision: 2,
    kind: 'translated',
    text: '第一句。',
    translation: { language: 'en', text: 'First sentence.', basedOnRevision: 1 }
  })), true)
  store.closeSession()
  assert.equal(store.append(caption()), false, '封档后拒绝')

  const { events, corruptLineCount, truncatedTail } = readSessionFile(filePath)
  assert.equal(corruptLineCount, 0)
  assert.equal(truncatedTail, false)
  assert.deepEqual(events.map((record) => record.event),
    ['session.open', 'segment.final', 'segment.translated', 'session.close'])
  const translated = events[2]
  assert.equal(translated.lang, 'en')
  assert.equal(translated.translation, 'First sentence.')
  assert.equal(translated.basedOnRevision, 1)
})

test('sanitized session ids cannot escape the directory', (t) => {
  const directory = tempDirectory(t)
  const store = new TranscriptStore({ directory, now: () => new Date(2026, 6, 27, 1, 2, 3) })
  const filePath = store.openSession('..\\..\\evil:session//x')
  assert.equal(path.dirname(filePath), directory)
  assert.ok(!path.basename(filePath).includes('..'))
  assert.ok(!path.basename(filePath).includes(':'))
  store.dispose()
})

test('truncated tails are tolerated and mid-file corruption is counted, never fatal', (t) => {
  const directory = tempDirectory(t)
  const filePath = path.join(directory, 'session.jsonl')
  fs.writeFileSync(filePath, [
    JSON.stringify({ v: 1, event: 'session.open', sessionId: 's' }),
    'not-json-at-all',
    JSON.stringify({ v: 1, event: 'segment.final', sessionId: 's', segmentId: 'a', revision: 1, t0: 0, t1: 1, text: '好。' }),
    '{"v":1,"event":"segment.final","sessionId":"s","segmentId":"b","revision":1,"t0":1,"t1":2,"tex'
  ].join('\n'))

  const { events, corruptLineCount, truncatedTail } = readSessionFile(filePath)
  assert.equal(truncatedTail, true, '崩溃截断的尾行被容忍')
  assert.equal(corruptLineCount, 1, '中间坏行被计数')
  assert.deepEqual(events.map((record) => record.event), ['session.open', 'segment.final'])
})

test('folding applies refined over final and attaches late translations without rollback', () => {
  const events = [
    { v: 1, event: 'segment.final', segmentId: 'a', sourceId: 'mic', revision: 3, t0: 0, t1: 2, text: '初稿。' },
    { v: 1, event: 'segment.final', segmentId: 'b', sourceId: 'mic', revision: 2, t0: 3, t1: 5, text: '第二句。' },
    { v: 1, event: 'segment.refined', segmentId: 'a', revision: 4, t0: 0, t1: 2.1, text: '精修稿。' },
    { v: 1, event: 'segment.translated', segmentId: 'a', revision: 5, t0: 0, t1: 2.1, text: '精修稿。', lang: 'en', translation: 'Refined.', basedOnRevision: 4 },
    /* 迟到的低 revision 事件不得回滚。 */
    { v: 1, event: 'segment.refined', segmentId: 'a', revision: 2, t0: 0, t1: 2, text: '旧稿' },
    /* 只有 translated、没有正文事件的段不该出现在折叠结果里。 */
    { v: 1, event: 'segment.translated', segmentId: 'ghost', revision: 2, lang: 'en', translation: 'Ghost.', basedOnRevision: 1 }
  ]
  const segments = foldSegments(events)
  assert.deepEqual(segments.map((segment) => segment.segmentId), ['a', 'b'])
  assert.equal(segments[0].text, '精修稿。')
  assert.equal(segments[0].textRevision, 5)
  assert.equal(segments[0].translation.text, 'Refined.')
  assert.equal(segments[1].text, '第二句。')
  assert.equal(segments[1].translation, null)
})

test('exports produce stable text, markdown, and srt with correct timecodes', () => {
  const segments = foldSegments([
    { v: 1, event: 'segment.final', segmentId: 'a', revision: 1, t0: 0, t1: 2.345, text: '你好。' },
    { v: 1, event: 'segment.translated', segmentId: 'a', revision: 2, t0: 0, t1: 2.345, text: '你好。', lang: 'en', translation: 'Hello.', basedOnRevision: 1 },
    { v: 1, event: 'segment.final', segmentId: 'b', revision: 1, t0: 3661.5, t1: 3663.25, text: '再见。' }
  ])

  assert.equal(exportText(segments), '你好。\n再见。\n')
  const markdown = exportMarkdown(segments, { title: '会议' })
  assert.ok(markdown.startsWith('# 会议\n'))
  assert.ok(markdown.includes('- 你好。\n  - Hello.'))

  assert.equal(formatSrtTime(3661.5), '01:01:01,500')
  const srt = exportSrt(segments)
  assert.ok(srt.includes('1\n00:00:00,000 --> 00:00:02,345\n你好。\nHello.'))
  assert.ok(srt.includes('2\n01:01:01,500 --> 01:01:03,250\n再见。'))

  /* 毫秒四舍五入必须进位到秒，绝不产出 ",1000"。 */
  assert.equal(formatSrtTime(2.9996), '00:00:03,000')
  assert.equal(formatSrtTime(59.9999), '00:01:00,000')
  assert.equal(formatSrtTime(3599.9995), '01:00:00,000')

  /* 文本内换行会伪造 SRT cue 块，导出时必须压平。 */
  const injected = exportSrt(foldSegments([
    { v: 1, event: 'segment.final', segmentId: 'x', revision: 1, t0: 0, t1: 1, text: '第一行\n\n2\n00:00:09,000 --> 00:00:10,000\n伪造' }
  ]))
  assert.ok(!injected.includes('\n\n2\n00:00:09'), 'SRT 块结构不可被文本注入破坏')
})

test('a complete bad line with trailing newline is corruption, not truncation', (t) => {
  const directory = tempDirectory(t)
  const filePath = path.join(directory, 'session.jsonl')
  fs.writeFileSync(filePath, JSON.stringify({ v: 1, event: 'session.open', sessionId: 's' }) + '\nGARBAGE\n')
  const report = readSessionFile(filePath)
  assert.equal(report.truncatedTail, false, '带换行收尾的坏行是损坏而非截断')
  assert.equal(report.corruptLineCount, 1)
})

test('same-second sessions with identical sanitized names never share a file', (t) => {
  const directory = tempDirectory(t)
  const now = () => new Date(2026, 6, 27, 3, 4, 5)
  const first = new TranscriptStore({ directory, now })
  const second = new TranscriptStore({ directory, now })
  const firstPath = first.openSession('a:x')
  const secondPath = second.openSession('a?x')
  assert.notEqual(firstPath, secondPath, '同秒同名会话必须分文件')
  first.dispose()
  second.dispose()
  const files = fs.readdirSync(directory)
  assert.equal(files.length, 2)
})

test('windowsSafeTimestamp never emits illegal filename characters', () => {
  const stamp = windowsSafeTimestamp(new Date(2026, 11, 31, 23, 59, 58))
  assert.equal(stamp, '20261231-235958')
  assert.ok(!/[:*?"<>|\\/]/.test(stamp))
})

test('append failures are reported, not thrown', (t) => {
  const directory = tempDirectory(t)
  const errors = []
  const store = new TranscriptStore({ directory, onError: (error) => errors.push(error) })
  store.openSession('session-1')
  /* 让底层写入失败：删掉目录。 */
  fs.rmSync(directory, { recursive: true, force: true })
  assert.equal(store.append(caption()), false)
  assert.equal(errors.length, 1)
  store.closeSession()
})
