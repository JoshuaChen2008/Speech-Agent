'use strict'

// @ts-check

/* Recognizer adapter 契约（B2.3）。
   --------------------------------------------------------------------------
   worker 与 SessionCoordinator 都不得绑定具体模型文件名或推理库；模型实现
   通过本工厂注册并按 profile 解析。接口（每 source 一个实例）：

     adapter.acceptFrame(samples: Float32Array, timestampSeconds: number): void
       — 段内每帧调用，喂 16k mono PCM。
     adapter.poll(): string | null
       — 段内每帧后调用；返回当前 partial 文本（无更新可返回同一文本；
         null/空串表示尚无文本）。
     adapter.endSegment(): string | null
       — 段收束时调用；返回定稿文本并复位内部流状态；null/空串表示放弃
         本段（不发 final）。
     adapter.discardProvisional?(): void
       — 可选。丢弃尚未获 Silero 确认的能量候选，不产生 final 或任何事件。
     adapter.dispose(): void

   默认注册表里只有 NullRecognizerAdapter——它消费帧但永不产出文本，
   worker 因此可以完成 frame/VAD/queue 结构验证而不伪造任何字幕。
   真实模型 adapter（sherpa-recognizer.js，Gate 0B 2026-07-27 改判批准）
   在 worker configure 携带 recognizer 选项时经 registerRecognizerAdapter
   注册；没有选项就保持 null——绝不隐式加载模型。 */

class NullRecognizerAdapter {
  constructor () {
    this.framesAccepted = 0
  }

  acceptFrame (samples) {
    this.framesAccepted += 1
  }

  poll () {
    return null
  }

  endSegment () {
    return null
  }

  discardProvisional () {}

  dispose () {}
}

class DraftRecognizerStartError extends Error {
  constructor () {
    super('draft recognizer failed to start')
    this.name = 'DraftRecognizerStartError'
    this.code = 'DRAFT_RECOGNIZER_START_FAILED'
  }
}

function requireTwoStageRecognizerConfiguration (recognizer, draftRecognizer) {
  if (!recognizer || typeof recognizer !== 'object') {
    throw new TypeError('authoritative recognizer configuration is required')
  }
  if (!draftRecognizer || typeof draftRecognizer !== 'object') {
    throw new DraftRecognizerStartError()
  }
  return { recognizer, draftRecognizer }
}

function assertRecognizerAdapter (adapter, role) {
  const required = ['acceptFrame', 'poll', 'endSegment', 'dispose']
  if (!adapter || typeof adapter !== 'object' || required.some((name) => typeof adapter[name] !== 'function')) {
    throw new TypeError(`${role} recognizer adapter is invalid`)
  }
  return adapter
}

class TwoStageRecognizerAdapter {
  constructor (options) {
    if (!options || typeof options.createDraft !== 'function' || typeof options.createAuthoritative !== 'function') {
      throw new TypeError('two-stage recognizer factories are required')
    }
    this.onDraftFault = typeof options.onDraftFault === 'function' ? options.onDraftFault : () => {}
    this.draft = null
    this.authoritative = null
    this.authoritativeOwned = false
    this.draftFailed = false
    this.disposed = false
    try {
      this.draft = assertRecognizerAdapter(options.createDraft(), 'draft')
    } catch {
      throw new DraftRecognizerStartError()
    }
    try {
      this.authoritative = assertRecognizerAdapter(options.createAuthoritative(), 'authoritative')
    } catch (error) {
      try { this.draft.dispose() } catch { /* best effort */ }
      throw error
    }
  }

  failDraft (stage) {
    if (this.draftFailed) return
    this.draftFailed = true
    try { this.draft.dispose() } catch { /* best effort */ }
    this.draft = null
    try {
      this.onDraftFault(Object.freeze({
        code: 'DRAFT_RECOGNIZER_FAILED',
        stage,
        count: 1
      }))
    } catch { /* diagnostics must not break authoritative recognition */ }
  }

  acceptFrame (samples, timestampSeconds) {
    if (this.disposed) return
    if (!this.draftFailed) {
      try { this.draft.acceptFrame(samples, timestampSeconds) } catch { this.failDraft('accept-frame') }
    }
    this.authoritative.acceptFrame(samples, timestampSeconds)
  }

  poll () {
    if (this.disposed) return null
    const authoritativeText = this.authoritative.poll()
    if (typeof authoritativeText === 'string' && authoritativeText.trim().length > 0) {
      this.authoritativeOwned = true
      return authoritativeText
    }
    if (this.authoritativeOwned || this.draftFailed) return null
    try {
      return this.draft.poll()
    } catch {
      this.failDraft('poll')
      return null
    }
  }

  endSegment () {
    if (this.disposed) return null
    if (!this.draftFailed) {
      try {
        if (typeof this.draft.discardProvisional === 'function') this.draft.discardProvisional()
        else this.draft.endSegment()
      } catch { this.failDraft('end-segment') }
    }
    const finalText = this.authoritative.endSegment()
    this.authoritativeOwned = false
    return finalText
  }

  discardProvisional () {
    if (this.disposed) return
    if (!this.draftFailed) {
      try {
        if (typeof this.draft.discardProvisional === 'function') this.draft.discardProvisional()
        else this.draft.endSegment()
      } catch { this.failDraft('discard-provisional') }
    }
    if (typeof this.authoritative.discardProvisional === 'function') this.authoritative.discardProvisional()
    else this.authoritative.endSegment()
    this.authoritativeOwned = false
  }

  dispose () {
    if (this.disposed) return
    this.disposed = true
    if (this.draft) {
      try { this.draft.dispose() } catch { /* best effort */ }
    }
    try { this.authoritative.dispose() } catch { /* best effort */ }
    this.draft = null
    this.authoritative = null
  }
}

function createTwoStageRecognizerAdapter (options) {
  return new TwoStageRecognizerAdapter(options)
}

const FACTORIES = new Map([
  ['null', () => new NullRecognizerAdapter()]
])

/**
 * @param {string} profile 注册表键；B2.3 只有 'null'
 */
function createRecognizerAdapter (profile) {
  const factory = FACTORIES.get(profile)
  if (!factory) throw new TypeError(`unknown recognizer profile: ${String(profile)}`)
  return factory()
}

/** 模型轨用：注册真实实现。重复注册视为编程错误。 */
function registerRecognizerAdapter (profile, factory) {
  if (typeof profile !== 'string' || profile.length === 0) throw new TypeError('profile must be a non-empty string')
  if (typeof factory !== 'function') throw new TypeError('factory must be a function')
  if (FACTORIES.has(profile)) throw new TypeError(`recognizer profile already registered: ${profile}`)
  FACTORIES.set(profile, factory)
}

module.exports = {
  DraftRecognizerStartError,
  NullRecognizerAdapter,
  TwoStageRecognizerAdapter,
  createRecognizerAdapter,
  createTwoStageRecognizerAdapter,
  requireTwoStageRecognizerConfiguration,
  registerRecognizerAdapter
}
