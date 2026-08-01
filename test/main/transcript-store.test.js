'use strict'

/*
 * JSONL is no longer a production write path. These tests deliberately cover
 * only the compatibility reader/projection used by JsonlSqliteMigrator and
 * the shared export formatter used by HistoryService.
 */

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  exportMarkdown,
  exportSrt,
  exportText,
  foldSegments,
  formatSrtTime,
  parseSessionText
} = require('../../src/main/services/transcript-store')

test('legacy JSONL parser tolerates truncated tails and counts mid-file corruption', () => {
  const raw = [
    JSON.stringify({ v: 1, event: 'session.open', sessionId: 's' }),
    'not-json-at-all',
    JSON.stringify({ v: 1, event: 'segment.final', sessionId: 's', segmentId: 'a', revision: 1, t0: 0, t1: 1, text: '好。' }),
    '{"v":1,"event":"segment.final","sessionId":"s","segmentId":"b","revision":1,"t0":1,"t1":2,"tex'
  ].join('\n')

  const { events, corruptLineCount, truncatedTail } = parseSessionText(raw)
  assert.equal(truncatedTail, true, '崩溃截断的尾行被容忍')
  assert.equal(corruptLineCount, 1, '中间坏行被计数')
  assert.deepEqual(events.map((record) => record.event), ['session.open', 'segment.final'])
})

test('legacy JSONL parser treats a complete bad line as corruption, not truncation', () => {
  const report = parseSessionText(JSON.stringify({ v: 1, event: 'session.open', sessionId: 's' }) + '\nGARBAGE\n')
  assert.equal(report.truncatedTail, false, '带换行收尾的坏行是损坏而非截断')
  assert.equal(report.corruptLineCount, 1)
})

test('legacy JSONL projection applies refined over final and attaches late translations without rollback', () => {
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

test('history and migration exports produce stable text, markdown, and srt', () => {
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
