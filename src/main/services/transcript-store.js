'use strict'

// @ts-check

/* 事件式 JSONL 转写存储（B3.1，PLAN §6.4）。
   --------------------------------------------------------------------------
   - append-only：保存事件而不是可变记录；refined/translated 可以晚到，
     崩溃前已写入的 final 不丢。
   - 文件名 Windows-safe：ISO 时间戳的 ':' 非法，使用 yyyyMMdd-HHmmss。
   - 每行独立 JSON；进程崩溃可能留下半行，读取时容忍坏尾行并如实报告。
   - 读取/导出按 segmentId + revision 折叠为当前状态；折叠排序按
     (t0, 首见顺序)，与显示层解耦。
   - 只收 final/refined/translated（partial 是显示态，不入档）。
   - 低频写入（每句一条），appendFileSync 保证崩溃一致性；本模块不做
     跨行事务。API Key/模型路径等敏感信息永不出现在事件里（契约字段白名单）。 */

const fs = require('node:fs')
const path = require('node:path')

const PERSISTED_KINDS = Object.freeze(['final', 'refined', 'translated'])
const EVENT_NAMES = Object.freeze({
  final: 'segment.final',
  refined: 'segment.refined',
  translated: 'segment.translated'
})

function windowsSafeTimestamp (date) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function sanitizeSessionId (sessionId) {
  /* 白名单后再折叠点号连跑：'..' 不可出现在文件名里（防路径歧义）。 */
  return String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.{2,}/g, '_').slice(0, 80)
}

class TranscriptStore {
  constructor (options) {
    if (!options || typeof options.directory !== 'string' || options.directory.length === 0) {
      throw new TypeError('directory is required')
    }
    this.directory = options.directory
    this.now = options.now || (() => new Date())
    this.onError = options.onError || (() => {})
    this.active = null
  }

  reportError (error) {
    try { this.onError(error) } catch { /* observer failures stay isolated */ }
  }

  /** 会话开始：创建 append-only 事件文件。重复 open 同一会话是 no-op。 */
  openSession (sessionId) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) throw new TypeError('sessionId is required')
    if (this.active && this.active.sessionId === sessionId) return this.active.filePath
    this.closeSession()
    fs.mkdirSync(this.directory, { recursive: true })
    const openedAt = this.now()
    const base = `${windowsSafeTimestamp(openedAt)}_${sanitizeSessionId(sessionId)}`
    /* 排他创建 + 序号后缀：同秒且清洗后同名的会话绝不混入同一文件。 */
    let filePath = null
    for (let suffix = 0; suffix < 100; suffix += 1) {
      const candidate = path.join(this.directory, suffix === 0 ? `${base}.jsonl` : `${base}.${suffix}.jsonl`)
      try {
        fs.closeSync(fs.openSync(candidate, 'ax'))
        filePath = candidate
        break
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
      }
    }
    if (!filePath) throw new Error('could not allocate a unique session file name')
    this.active = { sessionId, filePath }
    this.appendLine({ v: 1, event: 'session.open', sessionId, at: openedAt.toISOString() })
    return filePath
  }

  appendLine (record) {
    if (!this.active) return false
    try {
      fs.appendFileSync(this.active.filePath, JSON.stringify(record) + '\n')
      return true
    } catch (error) {
      this.reportError(error)
      return false
    }
  }

  /**
   * 收录一条已定稿 CaptionEvent（final/refined/translated）。
   * partial、会话不匹配或未开档一律拒绝（返回 false）。
   */
  append (event) {
    if (!this.active || !event || event.sessionId !== this.active.sessionId) return false
    if (!PERSISTED_KINDS.includes(event.kind)) return false
    const record = {
      v: 1,
      event: EVENT_NAMES[event.kind],
      sessionId: event.sessionId,
      sourceId: event.sourceId,
      segmentId: event.segmentId,
      sequence: event.sequence,
      revision: event.revision,
      t0: event.t0,
      t1: event.t1,
      text: event.text
    }
    if (event.kind === 'translated' && event.translation) {
      record.lang = event.translation.language
      record.translation = event.translation.text
      record.basedOnRevision = event.translation.basedOnRevision
    }
    return this.appendLine(record)
  }

  closeSession () {
    if (!this.active) return
    this.appendLine({ v: 1, event: 'session.close', sessionId: this.active.sessionId, at: this.now().toISOString() })
    this.active = null
  }

  dispose () {
    this.closeSession()
  }
}

/**
 * 读取一个会话文件。坏尾行（崩溃截断）被容忍并报告；
 * 中间行损坏同样跳过计数——绝不因单行损坏丢弃整个文件。
 */
function readSessionFile (filePath) {
  const raw = fs.readFileSync(filePath, 'utf8')
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
  EVENT_NAMES,
  PERSISTED_KINDS,
  TranscriptStore,
  exportMarkdown,
  exportSrt,
  exportText,
  foldSegments,
  formatSrtTime,
  readSessionFile,
  windowsSafeTimestamp
}
