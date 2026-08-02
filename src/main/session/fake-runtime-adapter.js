'use strict'

// @ts-check

const { LANGUAGE_TAG_PATTERN, assertCaptionEvent, assertSingleSourceIds } = require('../../contracts')

const DEFAULT_SCRIPT = Object.freeze([
  Object.freeze({
    text: '欢迎使用 Live Subtitle Agent 实时字幕',
    translation: 'Welcome to Live Subtitle Agent.',
    language: 'en'
  }),
  Object.freeze({
    text: '我们下周先对齐一下 roadmap，再排 A/B test。',
    translation: "Let's align on the roadmap next week, then schedule the A/B test.",
    language: 'en'
  }),
  Object.freeze({
    text: 'Can we ship a shorter version this sprint?',
    translation: '这个 sprint 能先发一个精简版吗？',
    language: 'zh-CN'
  })
])

/**
 * B1-only application adapter. It exercises the same lifecycle and contracts
 * that B2 workers will use, but never claims a model unless the coordinator
 * received the explicit development override.
 */
class FakeRuntimeAdapter {
  constructor (options = {}) {
    this.autoEmit = options.autoEmit !== false
    this.characterIntervalMs = options.characterIntervalMs || 55
    this.translationDelayMs = options.translationDelayMs || 400
    this.betweenLinesMs = options.betweenLinesMs || 700
    this.script = validateScript(options.script || DEFAULT_SCRIPT)
    this.captionHandler = null
    this.refinementFaultHandler = null
    this.context = null
    this.lastSessionId = null
    this.paused = false
    this.scriptIndex = 0
    this.segmentIndex = 0
    this.segmentPrefix = 'segment'
    this.sequence = 0
    this.elapsed = 0
    this.characterTimer = null
    this.lineTimer = null
    this.currentLine = null
  }

  onCaption (handler) {
    if (typeof handler !== 'function') throw new TypeError('caption handler must be a function')
    this.captionHandler = handler
    return () => {
      if (this.captionHandler === handler) this.captionHandler = null
    }
  }

  onRefinementFault (handler) {
    if (typeof handler !== 'function') throw new TypeError('refinement fault handler must be a function')
    this.refinementFaultHandler = handler
    return () => {
      if (this.refinementFaultHandler === handler) this.refinementFaultHandler = null
    }
  }

  async start (context) {
    this.stopTimers()
    this.assertContext(context)
    throwIfAborted(context.signal)
    const isNewSession = context.sessionId !== this.lastSessionId
    this.context = {
      sessionId: context.sessionId,
      sourceIds: [...context.sourceIds],
      profile: context.profile,
      refinementEnabled: context.refinementEnabled === true
    }
    this.lastSessionId = context.sessionId
    this.paused = false
    if (isNewSession) {
      this.scriptIndex = 0
      this.segmentIndex = 0
      this.sequence = 0
      this.elapsed = 0
    }
    const resume = context.resume || null
    if (resume) {
      /* Recovery cursor contract: a replacement adapter joining an existing
         session namespaces its segment ids by attempt and continues source
         sequences strictly above the coordinator's last accepted values. */
      this.segmentPrefix = resume.attempt > 0 ? `segment-r${resume.attempt}` : 'segment'
      const cursor = resume.sourceSequences[this.context.sourceIds[0]] || 0
      this.sequence = Math.max(this.sequence, cursor)
    }
    if (this.autoEmit) this.nextLine()
  }

  async pause (options = {}) {
    if (!this.context) throw new Error('fake adapter is not running')
    throwIfAborted(options.signal)
    this.flushCurrentLine()
    this.paused = true
    this.stopTimers()
  }

  async resume (options = {}) {
    if (!this.context) throw new Error('fake adapter is not running')
    throwIfAborted(options.signal)
    this.paused = false
    if (this.autoEmit) this.nextLine()
  }

  async stop (options = {}) {
    throwIfAborted(options.signal)
    this.flushCurrentLine()
    this.stopTimers()
    this.paused = false
    this.context = null
  }

  dispose () {
    this.stopTimers()
    this.captionHandler = null
    this.refinementFaultHandler = null
    this.context = null
    this.currentLine = null
  }

  /** Test/diagnostic seam representing a worker-originated event. */
  emitCaption (event) {
    if (this.captionHandler) this.captionHandler(event)
  }

  /** Test/diagnostic seam for the refinement-only failure channel. */
  emitRefinementFault (event) {
    return this.refinementFaultHandler ? this.refinementFaultHandler(event) : false
  }

  assertContext (context) {
    if (!context || typeof context !== 'object') throw new TypeError('start context is required')
    if (typeof context.sessionId !== 'string' || context.sessionId.length === 0) {
      throw new TypeError('sessionId is required')
    }
    assertSingleSourceIds(context.sourceIds)
    if (context.profile !== 'balanced') throw new TypeError('fake adapter only supports balanced')
    if (context.resume === undefined || context.resume === null) return
    const resume = context.resume
    if (typeof resume !== 'object' || Array.isArray(resume)) {
      throw new TypeError('resume must be an object')
    }
    if (!Number.isInteger(resume.attempt) || resume.attempt < 0) {
      throw new TypeError('resume.attempt must be a non-negative integer')
    }
    if (resume.sourceSequences === null || typeof resume.sourceSequences !== 'object' ||
        Array.isArray(resume.sourceSequences)) {
      throw new TypeError('resume.sourceSequences must be an object')
    }
    for (const [sourceId, sequence] of Object.entries(resume.sourceSequences)) {
      if (!Number.isInteger(sequence) || sequence < 0) {
        throw new TypeError(`resume.sourceSequences.${sourceId} must be a non-negative integer`)
      }
    }
  }

  stopTimers () {
    clearInterval(this.characterTimer)
    clearTimeout(this.lineTimer)
    this.characterTimer = null
    this.lineTimer = null
  }

  emit (kind, revision, text, translation = null) {
    if (!this.context) return
    this.sequence += 1
    const sourceId = this.context.sourceIds[0]
    this.emitCaption(assertCaptionEvent({
      schemaVersion: 1,
      sessionId: this.context.sessionId,
      sourceId,
      segmentId: `${this.segmentPrefix}-${this.segmentIndex}`,
      sequence: this.sequence,
      revision,
      kind,
      t0: this.elapsed,
      t1: this.elapsed + 2.4,
      text,
      translation
    }))
  }

  typeLine (entry) {
    const current = { entry, length: 0, revision: 0 }
    this.currentLine = current
    this.characterTimer = setInterval(() => {
      if (!this.context || this.paused) return
      current.length += 1
      current.revision += 1
      this.emit('partial', current.revision, entry.text.slice(0, current.length))
      if (current.length < entry.text.length) return

      clearInterval(this.characterTimer)
      this.characterTimer = null
      this.currentLine = null
      this.emit('final', current.revision + 1, entry.text)
      this.lineTimer = setTimeout(() => {
        this.emit('translated', current.revision + 2, entry.text, {
          language: entry.language,
          text: entry.translation,
          basedOnRevision: current.revision + 1
        })
        this.lineTimer = setTimeout(() => this.nextLine(), this.betweenLinesMs)
      }, this.translationDelayMs)
    }, this.characterIntervalMs)
  }

  nextLine () {
    if (!this.context || this.paused) return
    const entry = this.script[this.scriptIndex % this.script.length]
    this.scriptIndex += 1
    this.segmentIndex += 1
    this.elapsed += 3.1
    this.typeLine(entry)
  }

  flushCurrentLine () {
    const current = this.currentLine
    if (!current || current.length === 0) {
      this.currentLine = null
      return
    }
    this.emit('final', current.revision + 1, current.entry.text.slice(0, current.length))
    this.currentLine = null
  }
}

function throwIfAborted (signal) {
  if (signal && signal.aborted) {
    const error = new Error('adapter transition aborted')
    error.name = 'AbortError'
    throw error
  }
}

function validateScript (script) {
  if (!Array.isArray(script) || script.length === 0) {
    throw new TypeError('fake adapter script must be a non-empty array')
  }
  return script.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new TypeError(`script[${index}] must be an object`)
    for (const field of ['text', 'translation', 'language']) {
      if (typeof entry[field] !== 'string' || entry[field].length === 0) {
        throw new TypeError(`script[${index}].${field} must be a non-empty string`)
      }
    }
    if (!LANGUAGE_TAG_PATTERN.test(entry.language)) {
      throw new TypeError(`script[${index}].language has an invalid format`)
    }
    return Object.freeze({ text: entry.text, translation: entry.translation, language: entry.language })
  })
}

module.exports = { DEFAULT_SCRIPT, FakeRuntimeAdapter, validateScript }
