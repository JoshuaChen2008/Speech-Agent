'use strict'

// @ts-check

/* HistoryWindow 的主进程应用服务。renderer 只能请求受限的列表、详情和
   txt/md/srt 导出；数据库路径、SQL、任意目标路径和文件写能力都不跨 IPC。 */

const fs = require('node:fs/promises')
const {
  exportMarkdown,
  exportSrt,
  exportText
} = require('./transcript-store')

const EXPORT_FORMATS = Object.freeze({
  txt: Object.freeze({ extension: 'txt', name: '纯文本', mimeType: 'text/plain' }),
  md: Object.freeze({ extension: 'md', name: 'Markdown', mimeType: 'text/markdown' }),
  srt: Object.freeze({ extension: 'srt', name: 'SubRip 字幕', mimeType: 'application/x-subrip' })
})
const MODE_BY_SOURCE = Object.freeze({ loopback: 'meeting', mic: 'dictation' })

class HistoryError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'HistoryError'
    this.code = code
  }
}

function exactObject (value, keys, code = 'INVALID_HISTORY_REQUEST', optionalKeys = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key) && !optionalKeys.includes(key)) ||
      keys.some((key) => !Object.hasOwn(value, key))) {
    throw new HistoryError(code, code === 'INVALID_HISTORY_DATA' ? '历史记录数据无效' : '历史记录请求无效')
  }
  return value
}

function sessionIdValue (value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160) {
    throw new HistoryError('INVALID_SESSION', '会话标识无效')
  }
  return value
}

function safeInteger (value, options = {}) {
  const min = options.min === undefined ? 0 : options.min
  const max = options.max === undefined ? Number.MAX_SAFE_INTEGER : options.max
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new HistoryError(options.code || 'INVALID_HISTORY_REQUEST', options.message || '历史记录请求无效')
  }
  return value
}

function listRequest (input) {
  exactObject(input, ['limit', 'cursor'])
  const request = {
    limit: safeInteger(input.limit, { min: 1, max: 100 }),
    cursor: null
  }
  if (input.cursor !== null) {
    exactObject(input.cursor, ['startedAt', 'sessionId'])
    request.cursor = {
      startedAt: safeInteger(input.cursor.startedAt),
      sessionId: sessionIdValue(input.cursor.sessionId)
    }
  }
  return request
}

function listItem (value) {
  exactObject(value, [
    'sessionId', 'mode', 'sourceId', 'startedAt', 'endedAt', 'state', 'segmentCount'
  ], 'INVALID_HISTORY_DATA')
  if (typeof value.sessionId !== 'string' || value.sessionId.length < 1 || value.sessionId.length > 160 ||
      !Object.hasOwn(MODE_BY_SOURCE, value.sourceId) || value.mode !== MODE_BY_SOURCE[value.sourceId] ||
      !['closed', 'interrupted'].includes(value.state)) {
    throw new HistoryError('INVALID_HISTORY_DATA', '历史记录数据无效')
  }
  const startedAt = safeInteger(value.startedAt, {
    code: 'INVALID_HISTORY_DATA', message: '历史记录数据无效'
  })
  const endedAt = safeInteger(value.endedAt, {
    min: startedAt, code: 'INVALID_HISTORY_DATA', message: '历史记录数据无效'
  })
  const segmentCount = safeInteger(value.segmentCount, {
    code: 'INVALID_HISTORY_DATA', message: '历史记录数据无效'
  })
  return {
    sessionId: value.sessionId,
    mode: value.mode,
    sourceId: value.sourceId,
    startedAt,
    endedAt,
    state: value.state,
    segmentCount
  }
}

function sessionIdBefore (left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')) < 0
}

function listItemAfterCursor (item, cursor) {
  return item.startedAt < cursor.startedAt ||
    (item.startedAt === cursor.startedAt && sessionIdBefore(item.sessionId, cursor.sessionId))
}

function listResult (value, request) {
  exactObject(value, ['items', 'nextCursor'], 'INVALID_HISTORY_DATA')
  if (!Array.isArray(value.items) || value.items.length > request.limit) {
    throw new HistoryError('INVALID_HISTORY_DATA', '历史记录数据无效')
  }
  const items = value.items.map(listItem)
  for (let index = 1; index < items.length; index += 1) {
    if (!listItemAfterCursor(items[index], items[index - 1])) {
      throw new HistoryError('INVALID_HISTORY_DATA', '历史记录数据无效')
    }
  }
  if (request.cursor && items.length > 0 && !listItemAfterCursor(items[0], request.cursor)) {
    throw new HistoryError('INVALID_HISTORY_DATA', '历史记录数据无效')
  }

  let nextCursor = null
  if (value.nextCursor !== null) {
    exactObject(value.nextCursor, ['startedAt', 'sessionId'], 'INVALID_HISTORY_DATA')
    nextCursor = {
      startedAt: safeInteger(value.nextCursor.startedAt, {
        code: 'INVALID_HISTORY_DATA', message: '历史记录数据无效'
      }),
      sessionId: typeof value.nextCursor.sessionId === 'string'
        ? value.nextCursor.sessionId
        : ''
    }
    if (nextCursor.sessionId.length < 1 || nextCursor.sessionId.length > 160 ||
        items.length !== request.limit || nextCursor.startedAt !== items.at(-1)?.startedAt ||
        nextCursor.sessionId !== items.at(-1)?.sessionId) {
      throw new HistoryError('INVALID_HISTORY_DATA', '历史记录数据无效')
    }
  }
  return { items, nextCursor }
}

function pageRequest (input) {
  exactObject(input, ['sessionId', 'limit', 'cursor'])
  const request = {
    sessionId: sessionIdValue(input.sessionId),
    limit: safeInteger(input.limit, { min: 1, max: 100 }),
    cursor: null
  }
  if (input.cursor !== null) {
    exactObject(input.cursor, ['t0Ms', 'firstEventOrder'])
    request.cursor = {
      t0Ms: safeInteger(input.cursor.t0Ms),
      firstEventOrder: safeInteger(input.cursor.firstEventOrder, { min: 1 })
    }
  }
  return request
}

function pageSession (value, expectedSessionId) {
  exactObject(value, ['sessionId', 'mode', 'sourceId', 'startedAt', 'endedAt', 'state'], 'INVALID_HISTORY_DATA')
  if (value.sessionId !== expectedSessionId ||
      !Object.hasOwn(MODE_BY_SOURCE, value.sourceId) ||
      value.mode !== MODE_BY_SOURCE[value.sourceId]) {
    throw new HistoryError('INVALID_HISTORY_DATA', '历史记录数据无效')
  }
  if (value.state === 'active') {
    throw new HistoryError('SESSION_ACTIVE', '活动会话尚未进入历史记录')
  }
  if (!['closed', 'interrupted'].includes(value.state)) {
    throw new HistoryError('INVALID_HISTORY_DATA', '历史记录数据无效')
  }
  const startedAt = safeInteger(value.startedAt, {
    code: 'INVALID_HISTORY_DATA', message: '历史记录数据无效'
  })
  const endedAt = safeInteger(value.endedAt, {
    min: startedAt, code: 'INVALID_HISTORY_DATA', message: '历史记录数据无效'
  })
  return {
    sessionId: value.sessionId,
    mode: value.mode,
    sourceId: value.sourceId,
    startedAt,
    endedAt,
    state: value.state
  }
}

function pageItem (value, sourceId) {
  exactObject(value, ['segmentId', 'sourceId', 'text', 'refinedText', 'textRevision', 't0Ms', 't1Ms'], 'INVALID_HISTORY_DATA')
  if (typeof value.segmentId !== 'string' || value.segmentId.length < 1 || value.segmentId.length > 240 ||
      value.sourceId !== sourceId || typeof value.text !== 'string' || value.text.length < 1) {
    throw new HistoryError('INVALID_HISTORY_DATA', '历史记录数据无效')
  }
  /* 精修稿是可选派生版本：要么不存在，要么是一段非空文本。它永远不能替代
     `text` —— 后者恒为首次 final 的原始转写（SEM-F04 / SEM-F11）。 */
  if (value.refinedText !== null &&
      (typeof value.refinedText !== 'string' || value.refinedText.length < 1)) {
    throw new HistoryError('INVALID_HISTORY_DATA', '历史记录数据无效')
  }
  const textRevision = safeInteger(value.textRevision, {
    min: 1, code: 'INVALID_HISTORY_DATA', message: '历史记录数据无效'
  })
  const t0Ms = safeInteger(value.t0Ms, {
    code: 'INVALID_HISTORY_DATA', message: '历史记录数据无效'
  })
  const t1Ms = safeInteger(value.t1Ms, {
    min: t0Ms, code: 'INVALID_HISTORY_DATA', message: '历史记录数据无效'
  })
  return {
    segmentId: value.segmentId,
    sourceId: value.sourceId,
    text: value.text,
    refinedText: value.refinedText,
    textRevision,
    t0Ms,
    t1Ms
  }
}

function pageResult (value, request) {
  exactObject(value, ['session', 'totalCount', 'items', 'nextCursor'], 'INVALID_HISTORY_DATA')
  const session = pageSession(value.session, request.sessionId)
  const totalCount = safeInteger(value.totalCount, {
    code: 'INVALID_HISTORY_DATA', message: '历史记录数据无效'
  })
  if (!Array.isArray(value.items) || value.items.length > request.limit || totalCount < value.items.length) {
    throw new HistoryError('INVALID_HISTORY_DATA', '历史记录数据无效')
  }
  const items = value.items.map((item) => pageItem(item, session.sourceId))
  for (let index = 1; index < items.length; index += 1) {
    if (items[index].t0Ms < items[index - 1].t0Ms) {
      throw new HistoryError('INVALID_HISTORY_DATA', '历史记录数据无效')
    }
  }
  if (request.cursor && items.length > 0 && items[0].t0Ms < request.cursor.t0Ms) {
    throw new HistoryError('INVALID_HISTORY_DATA', '历史记录数据无效')
  }

  let nextCursor = null
  if (value.nextCursor !== null) {
    exactObject(value.nextCursor, ['t0Ms', 'firstEventOrder'], 'INVALID_HISTORY_DATA')
    nextCursor = {
      t0Ms: safeInteger(value.nextCursor.t0Ms, {
        code: 'INVALID_HISTORY_DATA', message: '历史记录数据无效'
      }),
      firstEventOrder: safeInteger(value.nextCursor.firstEventOrder, {
        min: 1, code: 'INVALID_HISTORY_DATA', message: '历史记录数据无效'
      })
    }
    if (items.length !== request.limit || nextCursor.t0Ms !== items.at(-1)?.t0Ms) {
      throw new HistoryError('INVALID_HISTORY_DATA', '历史记录数据无效')
    }
    if (totalCount <= items.length) {
      throw new HistoryError('INVALID_HISTORY_DATA', '历史记录数据无效')
    }
    if (request.cursor && (nextCursor.t0Ms < request.cursor.t0Ms ||
        (nextCursor.t0Ms === request.cursor.t0Ms &&
         nextCursor.firstEventOrder <= request.cursor.firstEventOrder))) {
      throw new HistoryError('INVALID_HISTORY_DATA', '历史记录数据无效')
    }
  } else if (request.cursor === null && totalCount !== items.length) {
    throw new HistoryError('INVALID_HISTORY_DATA', '历史记录数据无效')
  }
  return { session, totalCount, items, nextCursor }
}

function formatValue (value) {
  if (typeof value !== 'string' || !Object.hasOwn(EXPORT_FORMATS, value)) {
    throw new HistoryError('INVALID_EXPORT_FORMAT', '不支持这种导出格式')
  }
  return value
}

function terminalTranscript (transcript) {
  if (!transcript || !transcript.session || !Array.isArray(transcript.segments)) {
    throw new HistoryError('INVALID_HISTORY_DATA', '历史记录数据无效')
  }
  if (!['closed', 'interrupted'].includes(transcript.session.state)) {
    throw new HistoryError('SESSION_ACTIVE', '活动会话尚未进入历史记录')
  }
  return transcript
}

/* 导出必须声明版本（SEM-F11 / SEM-T08）：默认原始版，精修版只有用户明确选择
   时才使用。没有精修稿的段落在精修版里回落到原始版——否则导出会出现空洞，
   两版的段落数也不再可比。 */
function versionValue (value) {
  if (value === undefined) return 'original'
  if (value !== 'original' && value !== 'refined') {
    throw new HistoryError('INVALID_EXPORT_VERSION', '不支持这个转写版本')
  }
  return value
}

function versionedSegments (transcript, version) {
  return transcript.segments.map((segment) => ({
    segmentId: segment.segmentId,
    sourceId: segment.sourceId,
    text: version === 'refined' && typeof segment.refinedText === 'string' && segment.refinedText.length > 0
      ? segment.refinedText
      : segment.text,
    textRevision: segment.textRevision,
    t0: segment.t0Ms / 1000,
    t1: segment.t1Ms / 1000,
    translation: null
  }))
}

function safeStamp (epochMs) {
  const date = new Date(epochMs)
  if (!Number.isFinite(date.getTime())) return 'unknown-time'
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
}

function safeSessionPart (sessionId) {
  return sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 36) || 'session'
}

function buildExport (transcript, format, version) {
  const terminal = terminalTranscript(transcript)
  const selectedFormat = formatValue(format)
  const selectedVersion = versionValue(version)
  const segments = versionedSegments(terminal, selectedVersion)
  const versionLabel = selectedVersion === 'refined' ? '精修稿' : '原始转写'
  const title = `字幕记录 ${new Date(terminal.session.startedAt).toLocaleString('zh-CN')} · ${versionLabel}`
  let content
  if (selectedFormat === 'txt') content = exportText(segments)
  else if (selectedFormat === 'md') content = exportMarkdown(segments, { title })
  else content = exportSrt(segments)
  const metadata = EXPORT_FORMATS[selectedFormat]
  return Object.freeze({
    content,
    format: selectedFormat,
    version: selectedVersion,
    mimeType: metadata.mimeType,
    suggestedName: `${safeStamp(terminal.session.startedAt)}_${terminal.session.sourceId}_` +
      `${safeSessionPart(terminal.session.sessionId)}_${selectedVersion}.${metadata.extension}`
  })
}

class HistoryService {
  constructor (options = {}) {
    if (!options.gateway || typeof options.gateway.listSessions !== 'function' ||
        typeof options.gateway.getSessionTranscript !== 'function' ||
        typeof options.gateway.getSessionPage !== 'function') {
      throw new TypeError('history storage gateway is required')
    }
    if (typeof options.showSaveDialog !== 'function') {
      throw new TypeError('showSaveDialog is required')
    }
    if (options.writeFile !== undefined && typeof options.writeFile !== 'function') {
      throw new TypeError('writeFile must be a function')
    }
    this.gateway = options.gateway
    this.showSaveDialog = options.showSaveDialog
    this.writeFile = options.writeFile || fs.writeFile
  }

  listSessions (input) {
    const request = listRequest(input)
    return Promise.resolve(this.gateway.listSessions(structuredClone(request)))
      .then((value) => listResult(value, request))
  }

  async getSessionPage (input) {
    const request = pageRequest(input)
    return pageResult(await this.gateway.getSessionPage(structuredClone(request)), request)
  }

  async exportSession (input, ownerWindow = null) {
    /* version 可选：省略即原始版，明确传入才导出精修稿。 */
    exactObject(input, ['sessionId', 'format'], 'INVALID_HISTORY_REQUEST', ['version'])
    const sessionId = sessionIdValue(input.sessionId)
    const format = formatValue(input.format)
    const version = versionValue(input.version)
    const built = buildExport(await this.gateway.getSessionTranscript(sessionId), format, version)
    const metadata = EXPORT_FORMATS[format]
    const dialogResult = await this.showSaveDialog(ownerWindow, {
      title: version === 'refined' ? '导出字幕精修稿' : '导出字幕原文',
      defaultPath: built.suggestedName,
      filters: [{ name: metadata.name, extensions: [metadata.extension] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    if (!dialogResult || dialogResult.canceled || typeof dialogResult.filePath !== 'string') {
      return Object.freeze({ status: 'cancelled', format, version })
    }
    await this.writeFile(dialogResult.filePath, built.content, { encoding: 'utf8' })
    return Object.freeze({ status: 'saved', format, version })
  }
}

module.exports = {
  EXPORT_FORMATS,
  HistoryError,
  HistoryService,
  buildExport,
  versionedSegments
}
