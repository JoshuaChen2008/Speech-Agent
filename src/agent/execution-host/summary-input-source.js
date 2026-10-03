'use strict'

const crypto = require('node:crypto')
const { canonicalize } = require('../../runtime/storage-worker/canonical-json')

function fail (code, metrics) {
  const error = new Error(code)
  error.code = code
  if (metrics) error.diagnosticMetrics = metrics
  throw error
}

function sameCursor (left, right) {
  return left.afterEventOrder === right.afterEventOrder &&
    left.codePointOffset === right.codePointOffset && left.utf16Offset === right.utf16Offset
}

async function readFrozenSummaryInput (personalContext, source, signal, { collect = true, question = false } = {}) {
  const checkCapacity = (actual, limit, unit = 'bytes') => {
    if (actual > limit) fail(question ? 'AGENT_QA_INPUT_LIMIT_EXCEEDED' : 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED',
      question ? { actual, limit, unit } : undefined)
  }
  if (typeof personalContext?.readSessionRangePage !== 'function' ||
      source?.sourceKind !== 'session' || source.transcriptVersion !== 'raw') fail('AGENT_REQUEST_INVALID')
  const hash = crypto.createHash('sha256')
  hash.update('{"events":[')
  let cursor = { afterEventOrder: 0, codePointOffset: 0, utf16Offset: 0 }
  let event = null
  let segmentCount = 0
  let rawTextBytes = 0
  let canonicalBytes = 2
  let previousOrder = 0
  let startedAt = null
  let endedAt = null
  const events = collect ? [] : null

  const flush = () => {
    if (!event) return
    if (event.eventOrder <= previousOrder) fail('AGENT_INPUT_CHANGED')
    const encoded = canonicalize({ eventOrder: event.eventOrder, segmentId: event.segmentId, text: event.text })
    hash.update(segmentCount > 0 ? ',' : '')
    hash.update(encoded)
    canonicalBytes += Buffer.byteLength(encoded, 'utf8') + (segmentCount > 0 ? 1 : 0)
    checkCapacity(canonicalBytes, 8 * 1024 * 1024)
    rawTextBytes += Buffer.byteLength(event.text, 'utf8')
    checkCapacity(rawTextBytes, 4 * 1024 * 1024)
    segmentCount += 1
    checkCapacity(segmentCount, 50000, 'count')
    previousOrder = event.eventOrder
    if (events) events.push({ eventOrder: event.eventOrder, segmentId: event.segmentId, text: event.text })
    event = null
  }

  for (let pageNumber = 0; pageNumber <= 50000; pageNumber += 1) {
    if (signal?.aborted) fail('AGENT_CANCELLED')
    const page = await personalContext.readSessionRangePage({ source, cursor }, signal)
    if (signal?.aborted) fail('AGENT_CANCELLED')
    if (!page || !Array.isArray(page.events) || page.events.length > 500 ||
        !Number.isSafeInteger(page.textBytes) || page.textBytes > 256 * 1024 ||
        page.source?.inputDigest !== source.inputDigest ||
        page.source?.sessionId !== source.sessionId ||
        page.source?.transcriptVersion !== 'raw') fail('AGENT_INPUT_CHANGED')
    if (startedAt === null) {
      startedAt = page.startedAt
      endedAt = page.endedAt
    } else if (page.startedAt !== startedAt || page.endedAt !== endedAt) fail('AGENT_INPUT_CHANGED')
    for (const fragment of page.events) {
      if (!Number.isSafeInteger(fragment.eventOrder) || typeof fragment.segmentId !== 'string' ||
          typeof fragment.text !== 'string' || !Number.isSafeInteger(fragment.codePointStart) ||
          !Number.isSafeInteger(fragment.codePointEnd)) fail('AGENT_INPUT_CHANGED')
      if (event && event.eventOrder !== fragment.eventOrder) flush()
      if (!event) {
        if (fragment.codePointStart !== 0 || fragment.eventOrder <= previousOrder) fail('AGENT_INPUT_CHANGED')
        event = { eventOrder: fragment.eventOrder, segmentId: fragment.segmentId, text: '' }
        event.nextCodePoint = 0
      }
      if (fragment.segmentId !== event.segmentId || fragment.codePointStart !== event.nextCodePoint ||
          fragment.codePointEnd !== fragment.codePointStart + Array.from(fragment.text).length) {
        fail('AGENT_INPUT_CHANGED')
      }
      checkCapacity(rawTextBytes + Buffer.byteLength(event.text, 'utf8') + Buffer.byteLength(fragment.text, 'utf8'), 4 * 1024 * 1024)
      event.text += fragment.text
      event.nextCodePoint = fragment.codePointEnd
    }
    if (page.done) {
      flush()
      if (segmentCount === 0 || rawTextBytes === 0 || previousOrder !== source.inputWatermark) {
        fail('AGENT_INPUT_CHANGED')
      }
      hash.update(`],"inputWatermark":${canonicalize(source.inputWatermark)},`)
      hash.update(`"sessionId":${canonicalize(source.sessionId)},`)
      hash.update('"transcriptVersion":"raw"}')
      if (hash.digest('hex') !== source.inputDigest) fail('AGENT_INPUT_CHANGED')
      return {
        sourceKind: 'session', sessionId: source.sessionId, transcriptVersion: 'raw',
        inputWatermark: source.inputWatermark, inputDigest: source.inputDigest,
        startedAt, endedAt, segmentCount, rawTextBytes, canonicalBytes,
        fromEventOrder: events?.[0]?.eventOrder, throughEventOrder: previousOrder,
        ...(events ? { events } : {})
      }
    }
    if (page.events.length === 0 || !page.nextCursor || sameCursor(cursor, page.nextCursor)) fail('AGENT_INPUT_CHANGED')
    cursor = page.nextCursor
    await new Promise(resolve => setImmediate(resolve))
  }
  checkCapacity(50001, 50000, 'count')
}

function readFrozenQuestionInput (personalContext, source, signal, options = {}) {
  return readFrozenSummaryInput(personalContext, source, signal, { ...options, question: true })
}
module.exports = { readFrozenSummaryInput, readFrozenQuestionInput }
