'use strict'

// @ts-check

/* audio host 的纯决策逻辑：权限、display-media 请求校验、屏幕源选择与
   诊断参数校验。与 Electron 对象解耦，由 controller 接线、由单测覆盖。
   规则来源：Gate 0C 批准的拓扑（docs/validation/gate-0c.md）。 */

const { AUDIO_SOURCE_IDS: SOURCE_IDS, assertSingleSourceIds } = require('../../contracts')
const MIN_DIAGNOSTIC_MS = 1000
const MAX_DIAGNOSTIC_MS = 10000

function sanitizeOrigin (value) {
  return typeof value === 'string' && value.startsWith('file:') ? 'file://' : String(value || '')
}

/** 隐藏宿主只允许 media 权限，且必须来自宿主窗口自身。 */
function isPermissionAllowed (permission, isTrustedHostSender) {
  return permission === 'media' && isTrustedHostSender === true
}

/**
 * display-media 请求必须来自宿主 main frame、file:// origin，且同时请求
 * video+audio（Electron 43 不请求 video 会失败；video track 拿到后立即停）。
 */
function evaluateDisplayRequest (request) {
  if (!request || typeof request !== 'object') return { allowed: false, reason: 'missing request' }
  if (request.frameMatchesHost !== true) return { allowed: false, reason: 'frame is not the audio host main frame' }
  if (sanitizeOrigin(request.securityOrigin) !== 'file://') return { allowed: false, reason: 'origin is not the local host page' }
  if (request.videoRequested !== true || request.audioRequested !== true) {
    return { allowed: false, reason: 'loopback capture must request video and audio together' }
  }
  return { allowed: true, reason: null }
}

/** 优先主显示器；找不到时退回第一个屏幕源。 */
function selectScreenSource (sources, primaryDisplayId) {
  if (!Array.isArray(sources) || sources.length === 0) return null
  const primary = sources.find((source) => source.display_id === String(primaryDisplayId))
  return primary || sources[0]
}

function validateDiagnosticOptions (options) {
  if (!options || typeof options !== 'object') throw new TypeError('diagnostic options are required')
  if (typeof options.sessionId !== 'string' || options.sessionId.trim().length === 0) {
    throw new TypeError('sessionId must be a non-empty string')
  }
  if (options.sessionId.length > 128) {
    throw new TypeError('sessionId must be at most 128 characters')
  }
  assertSingleSourceIds(options.sourceIds)
  if (!Number.isInteger(options.durationMs) ||
      options.durationMs < MIN_DIAGNOSTIC_MS || options.durationMs > MAX_DIAGNOSTIC_MS) {
    throw new TypeError(`durationMs must be an integer between ${MIN_DIAGNOSTIC_MS} and ${MAX_DIAGNOSTIC_MS}`)
  }
  return {
    sessionId: options.sessionId,
    sourceIds: [...options.sourceIds],
    durationMs: options.durationMs
  }
}

const MIN_QUEUE_MS = 250
const MAX_QUEUE_MS = 10000
const CONTROL_TYPES = Object.freeze(['track-ended', 'metrics', 'stopped'])
const METRIC_KEYS = Object.freeze([
  'capturedFrames', 'sentFrames', 'droppedFrames', 'creditStalls',
  'maxQueuedMsObserved', 'queuedFrames', 'queuedMs', 'credits', 'discardedAtStop',
  'acknowledgedFrames', 'lostInFlightFrames', 'portReplacements'
])

/** 连续采集（B2.2）参数校验：与诊断共享 sessionId/sourceIds 规则，外加队列预算。 */
function validateCaptureOptions (options) {
  if (!options || typeof options !== 'object') throw new TypeError('capture options are required')
  const base = validateDiagnosticOptions({
    sessionId: options.sessionId,
    sourceIds: options.sourceIds,
    durationMs: MIN_DIAGNOSTIC_MS
  })
  const maxQueueMs = options.maxQueueMs === undefined ? 2000 : options.maxQueueMs
  if (!Number.isInteger(maxQueueMs) || maxQueueMs < MIN_QUEUE_MS || maxQueueMs > MAX_QUEUE_MS) {
    throw new TypeError(`maxQueueMs must be an integer between ${MIN_QUEUE_MS} and ${MAX_QUEUE_MS}`)
  }
  return { sessionId: base.sessionId, sourceIds: base.sourceIds, maxQueueMs }
}

/**
 * 宿主窗控制消息在 main 边界的白名单清洗：只保留已知 type、
 * 截断字符串、指标只收有限数字。非法输入返回 null。
 */
function sanitizeControlMessage (payload) {
  if (!payload || typeof payload !== 'object') return null
  const type = payload.type
  if (!CONTROL_TYPES.includes(type)) return null
  const message = {
    type,
    sessionId: typeof payload.sessionId === 'string' ? scrubLocalPaths(payload.sessionId).slice(0, 128) : null
  }
  if (type === 'track-ended') {
    if (!SOURCE_IDS.includes(payload.sourceId)) return null
    message.sourceId = payload.sourceId
    return message
  }
  const sources = {}
  if (payload.sources && typeof payload.sources === 'object' && !Array.isArray(payload.sources)) {
    for (const sourceId of SOURCE_IDS) {
      const raw = payload.sources[sourceId]
      if (!raw || typeof raw !== 'object') continue
      const metrics = {}
      for (const key of METRIC_KEYS) {
        if (Number.isFinite(raw[key])) metrics[key] = raw[key]
      }
      sources[sourceId] = metrics
    }
  }
  message.sources = sources
  return message
}

/** 剥掉文本中的本机路径并限制长度。 */
function scrubLocalPaths (text) {
  return String(text ?? '').replace(/[A-Za-z]:[\\/][^\s]+/g, '<local-path>').slice(0, 300)
}

/** 错误脱敏：剥掉本机路径，限制长度。 */
function publicError (error) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    message: scrubLocalPaths(error?.message || error)
  }
}

module.exports = {
  CONTROL_TYPES,
  MAX_DIAGNOSTIC_MS,
  MAX_QUEUE_MS,
  MIN_DIAGNOSTIC_MS,
  MIN_QUEUE_MS,
  SOURCE_IDS,
  evaluateDisplayRequest,
  isPermissionAllowed,
  publicError,
  sanitizeControlMessage,
  sanitizeOrigin,
  scrubLocalPaths,
  selectScreenSource,
  validateCaptureOptions,
  validateDiagnosticOptions
}
