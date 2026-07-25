'use strict'

// @ts-check

const {
  LANGUAGE_TAG_PATTERN,
  assertEnum,
  assertFiniteNumber,
  assertInteger,
  assertRecord,
  assertSchemaVersion,
  assertString,
  fail
} = require('./shared')

const CAPTION_KINDS = Object.freeze(['partial', 'final', 'refined', 'translated'])

function assertTranslation (translation, eventRevision, path) {
  assertRecord(translation, path)
  assertString(translation.language, `${path}.language`, { nonEmpty: true, pattern: LANGUAGE_TAG_PATTERN })
  assertString(translation.text, `${path}.text`, { nonEmpty: true })
  assertInteger(translation.basedOnRevision, `${path}.basedOnRevision`, { min: 1 })
  if (translation.basedOnRevision >= eventRevision) {
    fail(`${path}.basedOnRevision`, 'must refer to an earlier source-text revision')
  }
}

function assertCaptionEvent (value, path = 'CaptionEvent') {
  assertSchemaVersion(value, path)
  assertString(value.sessionId, `${path}.sessionId`, { nonEmpty: true })
  assertString(value.sourceId, `${path}.sourceId`, { nonEmpty: true })
  assertString(value.segmentId, `${path}.segmentId`, { nonEmpty: true })
  assertInteger(value.sequence, `${path}.sequence`, { min: 1 })
  assertInteger(value.revision, `${path}.revision`, { min: 1 })
  assertEnum(value.kind, CAPTION_KINDS, `${path}.kind`)
  assertFiniteNumber(value.t0, `${path}.t0`, { min: 0 })
  assertFiniteNumber(value.t1, `${path}.t1`, { min: 0 })
  if (value.t1 < value.t0) fail(`${path}.t1`, 'must be >= t0')
  assertString(value.text, `${path}.text`)

  if (value.kind === 'partial') {
    if (value.translation !== null) fail(`${path}.translation`, 'must be null for a partial event')
  } else {
    assertString(value.text, `${path}.text`, { nonEmpty: true })
  }

  if (value.kind === 'translated') {
    assertTranslation(value.translation, value.revision, `${path}.translation`)
  } else if (value.translation !== null) {
    fail(`${path}.translation`, `must be null for ${value.kind}`)
  }

  return value
}

function isCaptionEvent (value) {
  try {
    assertCaptionEvent(value)
    return true
  } catch {
    return false
  }
}

module.exports = {
  CAPTION_KINDS,
  assertCaptionEvent,
  isCaptionEvent
}
