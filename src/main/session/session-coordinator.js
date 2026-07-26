'use strict'

// @ts-check

const { randomUUID } = require('node:crypto')
const {
  assertCaptionEvent,
  assertCaptionState,
  assertCommandResult,
  assertRuntimeSnapshot
} = require('../../contracts')
/* canonical caption state 只服务 renderer 恢复显示，不是会话史（那是 B3 的
   JSONL）。折叠必须与 renderer 逐事件一致，否则 reload 前后视图会分叉——
   所以这里直接复用同一份纯逻辑折叠实现（caption-reducer 无 DOM 依赖），
   窗口、修订规则、会话切换语义由构造保证相同，而不是靠两套代码手工对齐。
   该文件因此成为 UI 与壳层共享，改动需双侧评审。 */
const {
  applyEvent: foldCaptionEvent,
  createState: createCaptionFoldState
} = require('../../ui/shared/caption-reducer')

const COMMANDS = Object.freeze(['start', 'pause', 'resume', 'stop', 'retry'])
const SOURCE_DEFINITIONS = Object.freeze([
  Object.freeze({ id: 'mic', label: '麦克风' }),
  Object.freeze({ id: 'loopback', label: '系统音频' })
])
const DEFAULT_TRANSITION_TIMEOUT_MS = 5000

class TransitionTimeoutError extends Error {
  constructor (operation) {
    super(`${operation} timed out`)
    this.name = 'TransitionTimeoutError'
  }
}

class TransitionCancelledError extends Error {
  constructor () {
    super('transition cancelled')
    this.name = 'TransitionCancelledError'
  }
}

function clone (value) {
  return structuredClone(value)
}

function success () {
  return assertCommandResult({
    schemaVersion: 1,
    ok: true,
    code: 'OK',
    message: null,
    recoverable: null,
    nextAction: null
  })
}

function failure (code, message, recoverable, nextAction = null) {
  return assertCommandResult({
    schemaVersion: 1,
    ok: false,
    code,
    message,
    recoverable,
    nextAction
  })
}

class SessionCoordinator {
  constructor (options) {
    if (!options || (!options.adapter && !options.adapterFactory)) {
      throw new TypeError('adapter or adapterFactory is required')
    }
    this.adapterFactory = options.adapterFactory || null
    this.usedAdapters = new Set()
    this.quarantinedAdapters = new Set()
    this.adapter = options.adapter
      ? this.registerAdapter(options.adapter)
      : this.createAdapter()
    this.runtimeOptions = options.runtimeOptions || { modelOverride: null }
    this.idFactory = options.idFactory || (() => `session-${randomUUID()}`)
    this.transitionTimeoutMs = options.transitionTimeoutMs || DEFAULT_TRANSITION_TIMEOUT_MS
    this.configuration = this.validateConfiguration(options.configuration)
    this.snapshotListeners = new Set()
    this.captionListeners = new Set()
    this.sourceSequences = new Map()
    this.segmentRevisions = new Map()
    this.segmentSources = new Map()
    this.issuedSessionIds = new Set()
    this.pendingCaptions = []
    this.adapterEpoch = 0
    this.captionStateRevision = 0
    this.captionFold = createCaptionFoldState()
    this.onListenerError = options.onListenerError || (() => {})
    this.sessionSourceIds = []
    this.busy = false
    this.disposed = false
    this.transitionSequence = 0
    this.activeTransition = null
    this.revision = 0
    this.snapshot = this.buildRestingSnapshot()
    this.unsubscribeAdapter = this.bindAdapter(this.adapter)
  }

  validateConfiguration (configuration) {
    if (!configuration || typeof configuration !== 'object') {
      throw new TypeError('configuration is required')
    }
    if (typeof configuration.onboardingCompleted !== 'boolean') {
      throw new TypeError('configuration.onboardingCompleted must be a boolean')
    }
    if (configuration.onboardingPreset !== null &&
        !['meeting', 'dictation'].includes(configuration.onboardingPreset)) {
      throw new TypeError('configuration.onboardingPreset is invalid')
    }
    if (typeof configuration.mic !== 'boolean' || typeof configuration.loopback !== 'boolean') {
      throw new TypeError('configuration capture flags must be booleans')
    }
    if (configuration.onboardingCompleted !== (configuration.onboardingPreset !== null)) {
      throw new TypeError('configuration onboarding fields are inconsistent')
    }
    if (!configuration.onboardingCompleted && (configuration.mic || configuration.loopback)) {
      throw new TypeError('configuration cannot enable sources before onboarding')
    }
    return {
      onboardingCompleted: configuration.onboardingCompleted,
      onboardingPreset: configuration.onboardingPreset,
      mic: configuration.mic,
      loopback: configuration.loopback
    }
  }

  getSnapshot () {
    return clone(this.snapshot)
  }

  /**
   * 已广播字幕折叠出的权威状态。caption renderer 在 reload/bootstrap 时
   * 先订阅增量事件，再读取本状态水合，最后重放订阅期间缓冲的事件。
   */
  getCaptionState () {
    return clone(assertCaptionState({
      schemaVersion: 1,
      revision: this.captionStateRevision,
      sessionId: this.captionFold.sessionId,
      segments: this.captionFold.segments
    }))
  }

  onSnapshot (listener) {
    if (typeof listener !== 'function') throw new TypeError('snapshot listener must be a function')
    this.snapshotListeners.add(listener)
    return () => this.snapshotListeners.delete(listener)
  }

  onCaption (listener) {
    if (typeof listener !== 'function') throw new TypeError('caption listener must be a function')
    this.captionListeners.add(listener)
    return () => this.captionListeners.delete(listener)
  }

  updateConfiguration (configuration) {
    const next = this.validateConfiguration(configuration)
    if (this.snapshot.sessionId !== null && !sameConfiguration(this.configuration, next)) {
      throw new Error('capture configuration cannot change during an active session')
    }
    this.configuration = next
    if (this.snapshot.sessionId === null && !this.busy) {
      this.publish(this.buildRestingSnapshot())
    }
    return this.getSnapshot()
  }

  async command (name) {
    if (this.disposed) return failure('COORDINATOR_CLOSED', '会话服务已关闭', false)
    if (!COMMANDS.includes(name)) return failure('UNKNOWN_COMMAND', '未知命令', false)
    if (this.busy) return failure('COMMAND_BUSY', '命令处理中', true)

    switch (name) {
      case 'start': return this.start()
      case 'pause': return this.pause()
      case 'resume': return this.resume()
      case 'stop': return this.stop()
      case 'retry': return this.retry()
    }
  }

  async start () {
    if (!this.snapshot.capabilities.canStart) {
      const limitation = this.snapshot.capabilities.limitations.find((item) => item.capability === 'start')
      return failure(
        limitation ? limitation.code : 'INVALID_STATE',
        limitation ? limitation.message : '当前不能开始',
        true,
        limitation ? limitation.nextAction : null
      )
    }

    this.busy = true
    let sessionId
    try {
      sessionId = this.issueSessionId()
    } catch {
      this.busy = false
      return failure('SESSION_ID_INVALID', '无法创建会话', true, 'retry')
    }
    const transition = this.beginTransition('start')
    this.sessionSourceIds = this.selectedSourceIds()
    this.sourceSequences.clear()
    this.segmentRevisions.clear()
    this.segmentSources.clear()
    this.pendingCaptions = []
    this.publish(this.buildSnapshot('starting', sessionId, 'starting', null))
    try {
      await this.invokeAdapter(transition, 'start', {
        sessionId,
        sourceIds: [...this.sessionSourceIds],
        profile: this.runtimeOptions.modelOverride.profile,
        resume: this.captionCursor(),
        signal: transition.controller.signal
      })
      if (!this.isTransitionCurrent(transition)) return failure('COORDINATOR_CLOSED', '会话服务已关闭', false)
      this.publish(this.buildSnapshot('listening', sessionId, 'active', null))
      this.flushPendingCaptions()
      return success()
    } catch (cause) {
      if (!this.isTransitionCurrent(transition)) return failure('COORDINATOR_CLOSED', '会话服务已关闭', false)
      this.pendingCaptions = []
      const error = this.adapterError('START', '启动', cause, transition)
      this.publish(this.buildSnapshot('error', sessionId, 'error', error))
      return failure(error.code, error.message, error.recoverable, error.nextAction)
    } finally {
      this.finishTransition(transition)
    }
  }

  async pause () {
    if (!this.snapshot.capabilities.canPause) return failure('INVALID_STATE', '当前不能暂停', true)
    const transition = this.beginTransition('pause')
    try {
      await this.invokeAdapter(transition, 'pause', { signal: transition.controller.signal })
      if (!this.isTransitionCurrent(transition)) return failure('COORDINATOR_CLOSED', '会话服务已关闭', false)
      this.publish(this.buildSnapshot('paused', this.snapshot.sessionId, 'paused', null))
      return success()
    } catch (cause) {
      if (!this.isTransitionCurrent(transition)) return failure('COORDINATOR_CLOSED', '会话服务已关闭', false)
      return this.enterAdapterErrorFrom('PAUSE', '暂停', cause, transition)
    } finally {
      this.finishTransition(transition)
    }
  }

  async resume () {
    if (!this.snapshot.capabilities.canResume) return failure('INVALID_STATE', '当前不能继续', true)
    const transition = this.beginTransition('resume')
    try {
      await this.invokeAdapter(transition, 'resume', { signal: transition.controller.signal })
      if (!this.isTransitionCurrent(transition)) return failure('COORDINATOR_CLOSED', '会话服务已关闭', false)
      this.publish(this.buildSnapshot('listening', this.snapshot.sessionId, 'active', null))
      return success()
    } catch (cause) {
      if (!this.isTransitionCurrent(transition)) return failure('COORDINATOR_CLOSED', '会话服务已关闭', false)
      return this.enterAdapterErrorFrom('RESUME', '继续', cause, transition)
    } finally {
      this.finishTransition(transition)
    }
  }

  async stop () {
    if (!this.snapshot.capabilities.canStop) return failure('INVALID_STATE', '当前不能停止', true)
    if (!this.adapter) {
      const sessionId = this.snapshot.sessionId
      this.publish(this.buildSnapshot('stopping', sessionId, 'inactive', null))
      this.sessionSourceIds = []
      this.sourceSequences.clear()
      this.segmentRevisions.clear()
      this.segmentSources.clear()
      this.pendingCaptions = []
      this.publish(this.buildRestingSnapshot())
      return success()
    }
    const transition = this.beginTransition('stop')
    const sessionId = this.snapshot.sessionId
    this.publish(this.buildSnapshot('stopping', sessionId, 'inactive', null))
    try {
      await this.invokeAdapter(transition, 'stop', { signal: transition.controller.signal })
      if (!this.isTransitionCurrent(transition)) return failure('COORDINATOR_CLOSED', '会话服务已关闭', false)
      this.sessionSourceIds = []
      this.sourceSequences.clear()
      this.segmentRevisions.clear()
      this.segmentSources.clear()
      this.pendingCaptions = []
      this.publish(this.buildRestingSnapshot())
      return success()
    } catch (cause) {
      if (!this.isTransitionCurrent(transition)) return failure('COORDINATOR_CLOSED', '会话服务已关闭', false)
      return this.enterAdapterErrorFrom('STOP', '停止', cause, transition)
    } finally {
      this.finishTransition(transition)
    }
  }

  async retry () {
    if (!this.snapshot.capabilities.canRetry) return failure('INVALID_STATE', '当前不能重试', true)
    const transition = this.beginTransition('retry')
    const sessionId = this.snapshot.sessionId
    this.pendingCaptions = []
    this.publish(this.buildSnapshot('recovering', sessionId, 'recovering', this.snapshot.lastError))
    try {
      await this.invokeAdapter(transition, 'stop', { signal: transition.controller.signal })
      await this.invokeAdapter(transition, 'start', {
        sessionId,
        sourceIds: [...this.sessionSourceIds],
        profile: this.runtimeOptions.modelOverride.profile,
        resume: this.captionCursor(),
        signal: transition.controller.signal
      })
      if (!this.isTransitionCurrent(transition)) return failure('COORDINATOR_CLOSED', '会话服务已关闭', false)
      this.publish(this.buildSnapshot('listening', sessionId, 'active', null))
      this.flushPendingCaptions()
      return success()
    } catch (cause) {
      if (!this.isTransitionCurrent(transition)) return failure('COORDINATOR_CLOSED', '会话服务已关闭', false)
      this.pendingCaptions = []
      const error = this.adapterError('RETRY', '重试', cause, transition)
      this.publish(this.buildSnapshot('error', sessionId, 'error', error))
      return failure(error.code, error.message, error.recoverable, error.nextAction)
    } finally {
      this.finishTransition(transition)
    }
  }

  enterAdapterErrorFrom (operation, label, cause, transition) {
    const error = this.adapterError(operation, label, cause, transition)
    this.publish(this.buildSnapshot('error', this.snapshot.sessionId, 'error', error))
    return failure(error.code, error.message, error.recoverable, error.nextAction)
  }

  adapterError (operation, label, cause, transition = null) {
    const timedOut = cause && cause.name === 'TransitionTimeoutError'
    if (timedOut && transition) this.quarantineAdapter(transition.adapter)
    const recoverable = !timedOut || this.adapter !== null
    return this.runtimeError(
      `ADAPTER_${operation}_${timedOut ? 'TIMEOUT' : 'FAILED'}`,
      `${label}${timedOut ? '超时' : '失败'}`,
      recoverable
    )
  }

  runtimeError (code, message, recoverable = true) {
    return {
      scope: 'worker',
      code,
      message,
      recoverable,
      nextAction: recoverable ? 'retry' : null
    }
  }

  reportListenerError (error) {
    try { this.onListenerError(error) } catch { /* observer failures stay isolated */ }
  }

  issueSessionId () {
    const sessionId = this.idFactory()
    if (typeof sessionId !== 'string' || sessionId.length === 0 || this.issuedSessionIds.has(sessionId)) {
      throw new Error('session id must be non-empty and unique')
    }
    this.issuedSessionIds.add(sessionId)
    return sessionId
  }

  /**
   * Recovery cursor for the same-session adapter (re)start contract:
   * replacement adapters must emit sequences strictly above these values
   * and must namespace new segment ids by `attempt`, so the retained
   * dedup maps keep rejecting the quarantined adapter's stale events
   * without also rejecting the replacement's fresh ones.
   */
  captionCursor () {
    return {
      attempt: this.adapterEpoch,
      sourceSequences: Object.fromEntries(this.sourceSequences)
    }
  }

  resetCaptionState () {
    this.captionStateRevision += 1
    this.captionFold = createCaptionFoldState()
  }

  foldCaptionState (event) {
    /* 与 renderer 完全相同的折叠：惰性会话切换、修订不开新段、
       KEEP_SEGMENTS 窗口淘汰，全部来自共享实现。 */
    foldCaptionEvent(this.captionFold, clone(event))
    this.captionStateRevision += 1
  }

  beginTransition (operation) {
    if (!this.adapter) throw new Error('runtime adapter is unavailable')
    const transition = {
      token: ++this.transitionSequence,
      operation,
      controller: new AbortController(),
      timedOut: false,
      timeout: null
    }
    transition.adapter = this.adapter
    this.activeTransition = transition
    this.busy = true
    return transition
  }

  isTransitionCurrent (transition) {
    return !this.disposed && this.activeTransition === transition
  }

  finishTransition (transition) {
    if (this.activeTransition !== transition) return
    clearTimeout(transition.timeout)
    this.activeTransition = null
    this.busy = false
  }

  async invokeAdapter (transition, operation, argument) {
    if (!this.isTransitionCurrent(transition) || transition.controller.signal.aborted) {
      throw new TransitionCancelledError()
    }

    let rejectCancelled
    const cancelled = new Promise((resolve, reject) => { rejectCancelled = reject })
    const onAbort = () => {
      rejectCancelled(transition.timedOut
        ? new TransitionTimeoutError(operation)
        : new TransitionCancelledError())
    }
    transition.controller.signal.addEventListener('abort', onAbort, { once: true })
    // Close the check/register race: abort may have happened between the first
    // check and addEventListener, and AbortSignal does not replay past events.
    if (transition.controller.signal.aborted) onAbort()

    if (!this.isTransitionCurrent(transition) || transition.controller.signal.aborted) {
      transition.controller.signal.removeEventListener('abort', onAbort)
      throw new TransitionCancelledError()
    }

    const adapter = transition.adapter
    const work = Promise.resolve().then(() => adapter[operation](argument))
    work.then(
      () => { if (!this.isTransitionCurrent(transition)) this.cleanupAdapter(adapter) },
      () => { if (!this.isTransitionCurrent(transition)) this.cleanupAdapter(adapter) }
    )
    transition.timeout = setTimeout(() => {
      transition.timedOut = true
      transition.controller.abort()
    }, this.transitionTimeoutMs)
    try {
      return await Promise.race([work, cancelled])
    } finally {
      clearTimeout(transition.timeout)
      transition.timeout = null
      transition.controller.signal.removeEventListener('abort', onAbort)
    }
  }

  createAdapter () {
    const adapter = this.adapterFactory()
    return this.registerAdapter(adapter)
  }

  registerAdapter (adapter) {
    if (!adapter || typeof adapter.onCaption !== 'function') {
      throw new TypeError('runtime adapter must provide onCaption')
    }
    if (this.usedAdapters.has(adapter)) {
      throw new TypeError('adapterFactory must return a new adapter instance')
    }
    this.usedAdapters.add(adapter)
    return adapter
  }

  bindAdapter (adapter) {
    if (!adapter || typeof adapter.onCaption !== 'function') {
      throw new TypeError('adapter.onCaption is required')
    }
    const unsubscribers = [adapter.onCaption((event) => this.acceptCaption(event))]
    /* B2 缺口关闭（handoff §12.4）：adapter 可选提供 onError——worker/host
       在会话进行中自行崩溃时主动把 coordinator 推入 error（retry 走既有
       replacement/cursor 恢复路径）。 */
    if (typeof adapter.onError === 'function') {
      unsubscribers.push(adapter.onError((event) => this.acceptAdapterFault(adapter, event)))
    }
    return () => { for (const unsubscribe of unsubscribers) unsubscribe() }
  }

  /**
   * 会话进行中（listening/paused）的 adapter 自报故障。
   * 迁移中（busy）的故障由该迁移自己的失败/超时路径处理；
   * 已隔离的旧 adapter 的迟到故障忽略。
   */
  acceptAdapterFault (adapter, event) {
    if (this.disposed || adapter !== this.adapter) return false
    if (this.busy || !['listening', 'paused'].includes(this.snapshot.phase)) return false
    const code = typeof event?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(event.code)
      ? event.code
      : 'RUNTIME_FAULT'
    const message = typeof event?.message === 'string' && event.message.trim().length > 0
      ? event.message.trim().slice(0, 120)
      : '运行服务中断'
    const recoverable = event?.recoverable !== false
    const scope = ['audio', 'model', 'worker', 'translation', 'system'].includes(event?.scope)
      ? event.scope
      : 'worker'
    const error = {
      scope,
      code,
      message,
      recoverable,
      nextAction: recoverable ? 'retry' : null
    }
    this.publish(this.buildSnapshot('error', this.snapshot.sessionId, 'error', error))
    return true
  }

  quarantineAdapter (adapter) {
    if (!adapter || this.adapter !== adapter) return
    this.unsubscribeAdapter()
    this.quarantinedAdapters.add(adapter)
    this.adapter = null
    this.cleanupAdapter(adapter)
    if (!this.adapterFactory) return
    try {
      this.adapter = this.createAdapter()
      this.unsubscribeAdapter = this.bindAdapter(this.adapter)
      this.adapterEpoch += 1
    } catch (error) {
      this.adapter = null
      this.reportListenerError(error)
    }
  }

  cleanupAdapter (adapter) {
    if (!adapter || adapter === this.adapter) return
    try {
      Promise.resolve(adapter.stop()).catch(() => {})
    } catch { /* best effort */ }
    try {
      if (typeof adapter.dispose === 'function') adapter.dispose()
    } catch { /* best effort */ }
  }

  selectedSourceIds () {
    return SOURCE_DEFINITIONS
      .filter((source) => this.configuration[source.id] === true)
      .map((source) => source.id)
  }

  availability () {
    const selected = this.selectedSourceIds()
    if (!this.configuration.onboardingCompleted || this.configuration.onboardingPreset === null) {
      return {
        phase: 'unavailable',
        selected,
        limitation: {
          capability: 'start',
          code: 'SETUP_REQUIRED',
          message: '请先选择使用场景',
          nextAction: 'open-settings'
        }
      }
    }
    if (!this.runtimeOptions.modelOverride) {
      return {
        phase: 'unavailable',
        selected,
        limitation: {
          capability: 'start',
          code: 'GATE_0B_NOT_PASSED',
          message: '模型尚未达标',
          nextAction: 'open-model-manager'
        }
      }
    }
    if (!this.adapter) {
      return {
        phase: 'unavailable',
        selected,
        limitation: {
          capability: 'start',
          code: 'RUNTIME_ADAPTER_UNAVAILABLE',
          message: '运行服务不可用',
          nextAction: null
        }
      }
    }
    if (selected.length === 0) {
      return {
        phase: 'unavailable',
        selected,
        limitation: {
          capability: 'start',
          code: 'NO_AUDIO_SOURCE',
          message: '请先选择音频源',
          nextAction: 'open-settings'
        }
      }
    }
    return { phase: 'idle', selected, limitation: null }
  }

  buildRestingSnapshot () {
    const available = this.availability()
    return this.buildSnapshot(available.phase, null, 'inactive', null, available)
  }

  buildSnapshot (phase, sessionId, selectedState, lastError, availability = null) {
    const available = availability || this.availability()
    const activeSourceIds = sessionId === null ? available.selected : this.sessionSourceIds
    const selected = new Set(activeSourceIds)
    const profiles = this.runtimeOptions.modelOverride
      ? [this.runtimeOptions.modelOverride.profile]
      : []

    const controls = {
      canStart: phase === 'idle',
      canPause: phase === 'listening',
      canResume: phase === 'paused',
      canStop: phase === 'listening' || phase === 'paused' || phase === 'error',
      canRetry: phase === 'error' && !!lastError && lastError.recoverable
    }
    const limitations = []
    if (phase === 'unavailable' && available.limitation) limitations.push(available.limitation)

    const snapshot = {
      schemaVersion: 1,
      revision: this.revision,
      sessionId,
      phase,
      capabilities: {
        schemaVersion: 1,
        ...controls,
        canRefine: false,
        canTranslate: false,
        availableProfiles: profiles,
        availableSourceIds: [...activeSourceIds],
        translationTargets: [],
        limitations
      },
      sources: SOURCE_DEFINITIONS.map((source) => ({
        id: source.id,
        label: source.label,
        state: selected.has(source.id) ? selectedState : 'unavailable',
        level: 0
      })),
      model: this.runtimeOptions.modelOverride
        ? { state: 'ready', profile: this.runtimeOptions.modelOverride.profile, progress: 1 }
        : { state: 'missing', profile: null, progress: null },
      lastError
    }
    return assertRuntimeSnapshot(snapshot)
  }

  publish (snapshot) {
    this.revision += 1
    snapshot.revision = this.revision
    this.snapshot = assertRuntimeSnapshot(snapshot)
    for (const listener of this.snapshotListeners) {
      try { listener(this.getSnapshot()) } catch (error) { this.reportListenerError(error) }
    }
  }

  flushPendingCaptions () {
    const captions = this.pendingCaptions
    this.pendingCaptions = []
    for (const event of captions) this.notifyCaption(event)
  }

  notifyCaption (event) {
    /* 折叠发生在广播出口：canonical state 精确等于订阅者见过的内容，
       被丢弃的 pending 缓冲不会在 reload 后凭空出现在字幕窗里。 */
    this.foldCaptionState(event)
    for (const listener of this.captionListeners) {
      try { listener(clone(event)) } catch (error) { this.reportListenerError(error) }
    }
  }

  acceptCaption (event) {
    try {
      assertCaptionEvent(event)
    } catch {
      return false
    }
    const pending = ['starting', 'recovering'].includes(this.snapshot.phase)
    if (!pending && !['listening', 'stopping'].includes(this.snapshot.phase)) return false
    if (event.sessionId !== this.snapshot.sessionId) return false
    if (!this.sessionSourceIds.includes(event.sourceId)) return false

    const segmentKey = event.segmentId
    const sourceSequence = this.sourceSequences.get(event.sourceId) || 0
    const segmentRevision = this.segmentRevisions.get(segmentKey) || 0
    const segmentSource = this.segmentSources.get(segmentKey)
    if (segmentSource && segmentSource !== event.sourceId) return false
    if (event.sequence <= sourceSequence || event.revision <= segmentRevision) return false
    this.sourceSequences.set(event.sourceId, event.sequence)
    this.segmentRevisions.set(segmentKey, event.revision)
    this.segmentSources.set(segmentKey, event.sourceId)
    if (pending) this.pendingCaptions.push(clone(event))
    else this.notifyCaption(event)
    return true
  }

  async dispose () {
    if (this.disposed) return
    this.disposed = true
    const transition = this.activeTransition
    this.activeTransition = null
    this.busy = false
    if (transition) transition.controller.abort()
    this.pendingCaptions = []
    this.resetCaptionState()
    this.unsubscribeAdapter()
    this.snapshotListeners.clear()
    this.captionListeners.clear()
    const adapters = new Set([this.adapter, ...this.quarantinedAdapters].filter(Boolean))
    try {
      await Promise.race([
        Promise.allSettled([...adapters].map((adapter) => Promise.resolve(adapter.stop()))),
        new Promise((resolve) => setTimeout(resolve, Math.min(this.transitionTimeoutMs, 250)))
      ])
    } catch { /* best effort */ }
    for (const adapter of adapters) {
      try { if (typeof adapter.dispose === 'function') adapter.dispose() } catch { /* best effort */ }
    }
    this.quarantinedAdapters.clear()
    this.adapter = null
  }
}

function sameConfiguration (left, right) {
  return left.onboardingCompleted === right.onboardingCompleted &&
    left.onboardingPreset === right.onboardingPreset &&
    left.mic === right.mic &&
    left.loopback === right.loopback
}

module.exports = {
  COMMANDS,
  DEFAULT_TRANSITION_TIMEOUT_MS,
  SOURCE_DEFINITIONS,
  SessionCoordinator,
  failure,
  success
}
