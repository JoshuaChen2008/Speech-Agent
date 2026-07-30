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

class HistoryError extends Error {
  constructor (code, message) {
    super(message)
    this.name = 'HistoryError'
    this.code = code
  }
}

function exactObject (value, keys, code = 'INVALID_HISTORY_REQUEST') {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key)) ||
      keys.some((key) => !Object.hasOwn(value, key))) {
    throw new HistoryError(code, '历史记录请求无效')
  }
  return value
}

function sessionIdValue (value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160) {
    throw new HistoryError('INVALID_SESSION', '会话标识无效')
  }
  return value
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

function originalSegments (transcript) {
  return transcript.segments.map((segment) => ({
    segmentId: segment.segmentId,
    sourceId: segment.sourceId,
    text: segment.text,
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

function buildExport (transcript, format) {
  const terminal = terminalTranscript(transcript)
  const selectedFormat = formatValue(format)
  const segments = originalSegments(terminal)
  const title = `字幕记录 ${new Date(terminal.session.startedAt).toLocaleString('zh-CN')}`
  let content
  if (selectedFormat === 'txt') content = exportText(segments)
  else if (selectedFormat === 'md') content = exportMarkdown(segments, { title })
  else content = exportSrt(segments)
  const metadata = EXPORT_FORMATS[selectedFormat]
  return Object.freeze({
    content,
    format: selectedFormat,
    mimeType: metadata.mimeType,
    suggestedName: `${safeStamp(terminal.session.startedAt)}_${terminal.session.sourceId}_` +
      `${safeSessionPart(terminal.session.sessionId)}.${metadata.extension}`
  })
}

class HistoryService {
  constructor (options = {}) {
    if (!options.gateway || typeof options.gateway.listSessions !== 'function' ||
        typeof options.gateway.getSessionTranscript !== 'function') {
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
    exactObject(input, ['limit', 'cursor'])
    return this.gateway.listSessions(structuredClone(input))
  }

  async getSession (sessionId) {
    const transcript = await this.gateway.getSessionTranscript(sessionIdValue(sessionId))
    return structuredClone(terminalTranscript(transcript))
  }

  async exportSession (input, ownerWindow = null) {
    exactObject(input, ['sessionId', 'format'])
    const sessionId = sessionIdValue(input.sessionId)
    const format = formatValue(input.format)
    const built = buildExport(await this.gateway.getSessionTranscript(sessionId), format)
    const metadata = EXPORT_FORMATS[format]
    const dialogResult = await this.showSaveDialog(ownerWindow, {
      title: '导出字幕原文',
      defaultPath: built.suggestedName,
      filters: [{ name: metadata.name, extensions: [metadata.extension] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    if (!dialogResult || dialogResult.canceled || typeof dialogResult.filePath !== 'string') {
      return Object.freeze({ status: 'cancelled', format })
    }
    await this.writeFile(dialogResult.filePath, built.content, { encoding: 'utf8' })
    return Object.freeze({ status: 'saved', format })
  }
}

module.exports = {
  EXPORT_FORMATS,
  HistoryError,
  HistoryService,
  buildExport,
  originalSegments
}
