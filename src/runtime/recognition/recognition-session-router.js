'use strict'

const { createHash } = require('node:crypto')
const { RECOGNITION_ERROR_CODES } = require('../../contracts/recognition')

class RecognitionSessionRouter {
  constructor ({ sessionId, sourceId, emit, control, status, now = () => 0, sequence = 0 }) {
    Object.assign(this, { sessionId, sourceId, emit, control, status, now, sequence })
    this.generation = 0
    this.actualProvider = 'nls'
    this.fallbackCode = null
    this.fallbackAtMs = null
    this.faultCode = null
    this.faultAtMs = null
    this.active = null
    this.accepting = false
  }

  openStream (offsetSeconds) {
    this.generation++
    this.offset = offsetSeconds
    this.sentSample = 0
    this.committedSample = 0
    this.lastFinalIndex = 0
    this.lastFinalDigest = null
    this.active = null
    this.accepting = this.actualProvider === 'nls'
    return this.generation
  }

  audio (start, count) {
    if (!this.accepting) return
    if (start !== this.sentSample || !Number.isInteger(count) || count < 1 || count > 1600) throw new Error('RECOGNITION_AUDIO_GAP')
    this.sentSample += count
  }

  result (generation, result) {
    if (!this.accepting || generation !== this.generation) return false
    const { kind, index, timeMs, text } = result
    const sample = timeMs * 16
    if (!Number.isInteger(sample) || sample < 0 || sample > this.sentSample || !Number.isInteger(index) || index < 1) {
      throw new Error('NLS_INVALID_RESPONSE')
    }
    if (index <= this.lastFinalIndex) {
      if (kind === 'final' && index === this.lastFinalIndex && this.lastFinalDigest !== this.digest(text)) throw new Error('NLS_INVALID_RESPONSE')
      return false
    }
    if (this.active && index !== this.active.index) throw new Error('NLS_INVALID_RESPONSE')
    if (kind === 'begin') {
      if (!this.active) {
        this.active = { index, id: `nls-${this.generation}-${index}`, revision: 0, beginMs: timeMs, timeMs }
        this.control({ type: 'begin', sample })
      }
      return true
    }
    if (!this.active && kind === 'final') {
      this.active = { index, id: `nls-${this.generation}-${index}`, revision: 0, beginMs: result.beginMs, timeMs }
    }
    if (!this.active || !Number.isInteger(this.active.beginMs) || timeMs < this.active.timeMs ||
        this.active.beginMs > timeMs || this.active.beginMs < 0 || typeof text !== 'string') throw new Error('NLS_INVALID_RESPONSE')
    this.active.timeMs = timeMs
    if (kind === 'final' && result.beginMs !== this.active.beginMs) throw new Error('NLS_INVALID_RESPONSE')
    if (kind !== 'partial' && kind !== 'final') throw new Error('NLS_INVALID_RESPONSE')
    if (kind === 'final') {
      if (text.trim()) this.publish(kind, text)
      else this.clearPartial()
      this.committedSample = Math.max(this.committedSample, sample)
      this.lastFinalIndex = index
      this.lastFinalDigest = this.digest(text)
      this.active = null
      this.control({ type: 'commit', sample: this.committedSample })
    } else if (text) this.publish(kind, text)
    return true
  }

  digest (text) { return createHash('sha256').update(text).digest('hex') }

  publish (kind, text) {
    const segment = this.active
    const event = { schemaVersion: 1, sessionId: this.sessionId, sourceId: this.sourceId,
      segmentId: segment.id, sequence: ++this.sequence, revision: ++segment.revision, kind, text,
      t0: this.offset + segment.beginMs / 1000, t1: this.offset + segment.timeMs / 1000, translation: null }
    if (this.emit(event) === false) throw new Error('NLS_INVALID_RESPONSE')
  }

  clearPartial () {
    if (this.active?.revision) this.publish('partial', '')
    this.active = null
  }

  fallback (code) {
    if (!this.accepting || this.actualProvider === 'local' || this.pendingFallback) return false
    this.accepting = false
    this.clearPartial()
    this.pendingFallback = this.safeCode(code)
    this.control({ type: 'takeover', sample: this.committedSample })
    return true
  }

  confirmTakeover () {
    if (!this.pendingFallback) return false
    this.actualProvider = 'local'
    this.fallbackCode = this.pendingFallback
    this.pendingFallback = null
    this.fallbackAtMs = Math.max(0, Math.round(this.now()))
    this.report()
    return true
  }

  fail (code) {
    this.accepting = false
    this.pendingFallback = null
    this.clearPartial()
    if (this.faultCode === null) {
      this.faultCode = this.safeCode(code)
      this.faultAtMs = Math.max(0, Math.round(this.now()))
    }
    this.report()
  }

  local (event) {
    if (this.actualProvider !== 'local') return false
    return this.emit({ ...event, segmentId: `local-${this.generation}-${event.segmentId}`,
      sequence: ++this.sequence, t0: event.t0 + this.offset, t1: event.t1 + this.offset })
  }

  safeCode (code) { return RECOGNITION_ERROR_CODES.includes(code) ? code : 'NLS_SERVICE_FAILED' }
  report () {
    this.status({ sessionId: this.sessionId, actualProvider: this.actualProvider,
      fallbackCode: this.fallbackCode, fallbackAtMs: this.fallbackAtMs,
      faultCode: this.faultCode, faultAtMs: this.faultAtMs })
  }
}

module.exports = { RecognitionSessionRouter }
