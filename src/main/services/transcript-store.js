'use strict'

// @ts-check

/* Legacy JSONL compatibility and shared transcript formatting.
   --------------------------------------------------------------------------
   JSONL is read solely for one-shot migration. New subtitle facts are
   SQLite-only. Parsing remains here because the migration digest must be
   derived from exactly the archived bytes. Export helpers remain shared with
   HistoryService. */

/* Parse a caller-owned immutable text snapshot. Migration uses this entry
   point so the SHA-256 and parsed records come from the exact same bytes. */
function parseSessionText (raw) {
  if (typeof raw !== 'string') throw new TypeError('session text must be a string')
  /* 截断只可能发生在没有换行收尾的最后一行（partial write 是前缀；
     '\n' 是每条记录的最后一字节）。带换行的坏行是损坏，不是截断。 */
  const endsWithNewline = raw.endsWith('\n')
  const lines = raw.split('\n')
  const events = []
  let corruptLineCount = 0
  let truncatedTail = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line.length === 0) continue
    try {
      const record = JSON.parse(line)
      if (record && record.v === 1 && typeof record.event === 'string') events.push(record)
      else corruptLineCount += 1
    } catch {
      if (index === lines.length - 1 && !endsWithNewline) truncatedTail = true
      else corruptLineCount += 1
    }
  }
  return { events, corruptLineCount, truncatedTail }
}

/**
 * 按 segmentId + revision 折叠为当前状态。
 * refined 以更高 revision 覆盖 final 的文本；translated 附加译文且不回滚
 * 更高 revision 的正文。排序按 (t0, 首见顺序)。
 */
function foldSegments (events) {
  const segments = new Map()
  let order = 0
  for (const record of events) {
    if (!record.segmentId || typeof record.revision !== 'number') continue
    let segment = segments.get(record.segmentId)
    if (!segment) {
      segment = {
        segmentId: record.segmentId,
        sourceId: record.sourceId || null,
        firstSeen: order++,
        t0: record.t0,
        t1: record.t1,
        text: '',
        textRevision: 0,
        translation: null,
        translationRevision: 0
      }
      segments.set(record.segmentId, segment)
    }
    if (record.event === 'segment.final' || record.event === 'segment.refined') {
      if (record.revision > segment.textRevision) {
        segment.text = record.text
        segment.textRevision = record.revision
        segment.t0 = record.t0
        segment.t1 = record.t1
      }
    } else if (record.event === 'segment.translated') {
      if (record.revision > segment.textRevision && typeof record.text === 'string') {
        segment.text = record.text
        segment.textRevision = record.revision
      }
      if (record.revision > segment.translationRevision && typeof record.translation === 'string') {
        segment.translation = { language: record.lang || '', text: record.translation }
        segment.translationRevision = record.revision
      }
    }
  }
  return [...segments.values()]
    .filter((segment) => segment.textRevision > 0)
    .sort((left, right) => (left.t0 - right.t0) || (left.firstSeen - right.firstSeen))
}

function formatSrtTime (seconds) {
  /* 先取整到总毫秒再分解：.9995 类边界的进位必须传播到秒/分/时，
     否则会产出 ",1000" 这类非法时间码。 */
  const totalMs = Math.round(Math.max(0, seconds) * 1000)
  const hours = Math.floor(totalMs / 3600000)
  const minutes = Math.floor((totalMs % 3600000) / 60000)
  const wholeSeconds = Math.floor((totalMs % 60000) / 1000)
  const millis = totalMs % 1000
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${pad(hours)}:${pad(minutes)}:${pad(wholeSeconds)},${pad(millis, 3)}`
}

function exportText (segments) {
  return segments.map((segment) => segment.text).join('\n') + '\n'
}

function exportMarkdown (segments, options = {}) {
  const lines = [`# ${options.title || 'Transcript'}`, '']
  for (const segment of segments) {
    lines.push(`- ${segment.text}`)
    if (segment.translation) lines.push(`  - ${segment.translation.text}`)
  }
  return lines.join('\n') + '\n'
}

function exportSrt (segments) {
  /* SRT 的块结构靠空行分隔：文本中的换行必须压平，否则一条含 "\n\n" 的
     字幕会伪造出独立 cue 块（结构性破坏，不只是外观）。 */
  const flat = (text) => String(text).replace(/\r?\n+/g, ' ')
  const blocks = segments.map((segment, index) => {
    const body = segment.translation
      ? `${flat(segment.text)}\n${flat(segment.translation.text)}`
      : flat(segment.text)
    return `${index + 1}\n${formatSrtTime(segment.t0)} --> ${formatSrtTime(segment.t1)}\n${body}`
  })
  return blocks.join('\n\n') + '\n'
}

module.exports = {
  exportMarkdown,
  exportSrt,
  exportText,
  foldSegments,
  formatSrtTime,
  parseSessionText
}
