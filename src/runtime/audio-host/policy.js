'use strict'

// @ts-check

/* audio host 的纯决策逻辑：权限、display-media 请求校验、屏幕源选择与
   诊断参数校验。与 Electron 对象解耦，由 controller 接线、由单测覆盖。
   规则来源：Gate 0C 批准的拓扑（docs/validation/gate-0c.md）。 */

const SOURCE_IDS = Object.freeze(['mic', 'loopback'])
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
  if (!Array.isArray(options.sourceIds) || options.sourceIds.length === 0) {
    throw new TypeError('sourceIds must be a non-empty array')
  }
  const seen = new Set()
  for (const sourceId of options.sourceIds) {
    if (!SOURCE_IDS.includes(sourceId)) throw new TypeError(`unknown sourceId: ${String(sourceId)}`)
    if (seen.has(sourceId)) throw new TypeError(`duplicate sourceId: ${sourceId}`)
    seen.add(sourceId)
  }
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
  MAX_DIAGNOSTIC_MS,
  MIN_DIAGNOSTIC_MS,
  SOURCE_IDS,
  evaluateDisplayRequest,
  isPermissionAllowed,
  publicError,
  sanitizeOrigin,
  scrubLocalPaths,
  selectScreenSource,
  validateDiagnosticOptions
}
