'use strict'

// @ts-check

/* Process-memory-only post-session status. It reports refinement processing
   facts; it never summarizes transcript content and deliberately has no load
   or save API, so an application restart cannot replay a prior notice. */

const RESULT_KEYS = Object.freeze([
  'segmentCount',
  'refinedSegmentCount',
  'refinementResultStatus',
  'refinementEnabled',
  'refinementFaultCode'
])
const FAULT_CODES = new Set([
  'REFINE_WORKER_START_FAILED',
  'REFINE_WORKER_EXITED',
  'REFINE_DECODE_FAILED',
  'REFINE_INVALID_RESPONSE',
  'REFINE_INTERNAL_FAILURE'
])

function buildRefinementNotice (sessionId, result) {
  if (typeof sessionId !== 'string' || sessionId.length < 1 || sessionId.length > 160) {
    throw new TypeError('notice session id is invalid')
  }
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      Object.keys(result).sort().join(',') !== [...RESULT_KEYS].sort().join(',')) {
    throw new TypeError('notice requires the exact result shape')
  }
  if (result.refinementResultStatus === 'not_recorded') return null
  if (result.refinementResultStatus !== 'known') throw new TypeError('notice result status is invalid')
  if (!Number.isSafeInteger(result.segmentCount) || result.segmentCount < 0 ||
      !Number.isSafeInteger(result.refinedSegmentCount) || result.refinedSegmentCount < 0 ||
      result.refinedSegmentCount > result.segmentCount) {
    throw new TypeError('notice refinement coverage is invalid')
  }
  if (result.refinementEnabled !== true && result.refinementEnabled !== false) {
    throw new TypeError('notice refinement preference is invalid')
  }
  if (result.refinementFaultCode === null) return null
  if (!FAULT_CODES.has(result.refinementFaultCode)) throw new TypeError('notice refinement fault is invalid')

  const total = result.segmentCount
  const refined = result.refinedSegmentCount
  let message
  if (total === 0) {
    message = '精修进程异常结束；本会话未产生可精修的已定稿字幕'
  } else if (refined === total) {
    message = `精修进程异常结束，但本次已生成 ${refined}/${total} 段精修稿`
  } else {
    message = `精修异常，已精修 ${refined}/${total} 段，其余保留原字幕`
  }
  return Object.freeze({
    schemaVersion: 1,
    kind: 'refinement-fault',
    sessionId,
    message
  })
}

class RefinementNoticeStore {
  constructor (options = {}) {
    this.notice = null
    this.listeners = new Set()
    this.onListenerError = typeof options.onListenerError === 'function'
      ? options.onListenerError
      : () => {}
  }

  get () {
    return this.notice === null ? null : structuredClone(this.notice)
  }

  onChanged (listener) {
    if (typeof listener !== 'function') throw new TypeError('notice listener must be a function')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  setFromResult (sessionId, result) {
    const notice = buildRefinementNotice(sessionId, result)
    if (notice === null) return this.clear()
    this.notice = notice
    this.publish()
    return true
  }

  clear () {
    if (this.notice === null) return false
    this.notice = null
    this.publish()
    return true
  }

  publish () {
    for (const listener of this.listeners) {
      try { listener(this.get()) } catch (error) {
        try { this.onListenerError(error) } catch { /* observer failures stay isolated */ }
      }
    }
  }
}

module.exports = {
  RefinementNoticeStore,
  buildRefinementNotice
}
