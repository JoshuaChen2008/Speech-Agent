'use strict'

// @ts-check

const {
  LANGUAGE_TAG_PATTERN,
  assertArray,
  assertEnum,
  assertFiniteNumber,
  assertInteger,
  assertNullableString,
  assertRecord,
  assertSchemaVersion,
  assertString,
  fail
} = require('./shared')
const { CAPTION_KINDS } = require('./caption-event')

/* CaptionState 是主进程 SessionCoordinator 折叠已广播 CaptionEvent 后的
   权威字幕状态。caption renderer 在 bootstrap/reload 时读取它水合本地
   reducer，再继续消费增量 CaptionEvent；两者的折叠语义必须保持一致。
   它是 B2.0 新增的 v1 契约对象，不改变 Gate 0A 冻结的四类对象。 */

function assertCaptionSegment (segment, path) {
  assertRecord(segment, path)
  assertString(segment.segmentId, `${path}.segmentId`, { nonEmpty: true })
  assertString(segment.sourceId, `${path}.sourceId`, { nonEmpty: true })
  assertInteger(segment.sequence, `${path}.sequence`, { min: 1 })
  assertEnum(segment.kind, CAPTION_KINDS, `${path}.kind`)
  assertString(segment.text, `${path}.text`)
  if (segment.kind !== 'partial') {
    assertString(segment.text, `${path}.text`, { nonEmpty: true })
  }
  assertInteger(segment.textRevision, `${path}.textRevision`, { min: 1 })
  assertInteger(segment.translationRevision, `${path}.translationRevision`, { min: 0 })
  if (segment.translationRevision > segment.textRevision) {
    fail(`${path}.translationRevision`, 'cannot exceed textRevision')
  }
  assertFiniteNumber(segment.t0, `${path}.t0`, { min: 0 })
  assertFiniteNumber(segment.t1, `${path}.t1`, { min: 0 })
  if (segment.t1 < segment.t0) fail(`${path}.t1`, 'must be >= t0')

  if (segment.translation === null) {
    if (segment.translationRevision !== 0) {
      fail(`${path}.translationRevision`, 'must be 0 without a translation')
    }
    if (segment.kind === 'translated') {
      fail(`${path}.translation`, 'must be present for a translated segment')
    }
    return
  }
  assertRecord(segment.translation, `${path}.translation`)
  assertString(segment.translation.language, `${path}.translation.language`, {
    nonEmpty: true,
    pattern: LANGUAGE_TAG_PATTERN
  })
  assertString(segment.translation.text, `${path}.translation.text`, { nonEmpty: true })
  assertInteger(segment.translation.basedOnRevision, `${path}.translation.basedOnRevision`, { min: 1 })
  if (segment.translationRevision < 1) {
    fail(`${path}.translationRevision`, 'must be >= 1 with a translation')
  }
  if (segment.translation.basedOnRevision >= segment.translationRevision) {
    fail(`${path}.translation.basedOnRevision`, 'must refer to an earlier source-text revision')
  }
}

function assertCaptionState (value, path = 'CaptionState') {
  assertSchemaVersion(value, path)
  assertInteger(value.revision, `${path}.revision`, { min: 0 })
  assertNullableString(value.sessionId, `${path}.sessionId`, { nonEmpty: true })
  assertArray(value.segments, `${path}.segments`)
  if (value.sessionId === null && value.segments.length > 0) {
    fail(`${path}.segments`, 'must be empty without a session')
  }
  const seen = new Set()
  value.segments.forEach((segment, index) => {
    const segmentPath = `${path}.segments[${index}]`
    assertCaptionSegment(segment, segmentPath)
    if (seen.has(segment.segmentId)) {
      fail(`${segmentPath}.segmentId`, `duplicates ${JSON.stringify(segment.segmentId)}`)
    }
    seen.add(segment.segmentId)
  })
  return value
}

function isCaptionState (value) {
  try {
    assertCaptionState(value)
    return true
  } catch {
    return false
  }
}

/* Renderer 只把“哪个旧段已经整段离开固定视口”闭合回主进程。
   这是显示身份水位，不是布局遥测；严格键集合防止字幕正文或屏幕几何
   意外跨过这条反向 IPC。 */
function assertCaptionViewportEviction (value, path = 'CaptionViewportEviction') {
  assertSchemaVersion(value, path)
  const keys = Object.keys(value).sort()
  const expected = ['schemaVersion', 'sessionId', 'throughSegmentId']
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail(path, `must contain exactly: ${expected.join(', ')}`)
  }
  assertString(value.sessionId, `${path}.sessionId`, { nonEmpty: true })
  assertString(value.throughSegmentId, `${path}.throughSegmentId`, { nonEmpty: true })
  return value
}

module.exports = {
  assertCaptionState,
  assertCaptionViewportEviction,
  isCaptionState
}
