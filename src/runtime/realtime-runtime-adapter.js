'use strict'

// @ts-check

/* B2 真实运行链路的 runtime adapter（I2.1 结构接线）。
   --------------------------------------------------------------------------
   实现 B1 冻结的 adapter 接口（start/pause/resume/stop/dispose/onCaption，
   外加 §12.4 关闭后的可选 onError），组合：
     AudioHostController（隐藏采集窗）→ MessageChannelMain → RealtimeWorkerHost
   PCM 不经过主进程；caption 从 worker 边界（已契约校验）直达 coordinator 的
   acceptCaption 路径。

   Gate 0B 仍是 FAIL：recognizer profile 经 profileMap 显式映射，默认全部映射
   到 'null'（消费帧、不产文本）。因此本 adapter 在模型批准前是【结构模式】——
   状态机、采集、背压、恢复全真，但没有任何字幕文本，也绝不伪造。 */

const { AudioHostController } = require('./audio-host/audio-host-controller')
const { RealtimeWorkerHost } = require('./realtime-worker/worker-host')

const DEFAULT_PROFILE_MAP = Object.freeze({ fast: 'null', balanced: 'null', accurate: 'null' })

function throwIfAborted (signal) {
  if (signal && signal.aborted) {
    const error = new Error('adapter transition aborted')
    error.name = 'AbortError'
    throw error
  }
}

class RealtimeRuntimeAdapter {
  constructor (options = {}) {
    this.electron = options.electron || require('electron')
    this.profileMap = options.profileMap || DEFAULT_PROFILE_MAP
    this.maxQueueMs = options.maxQueueMs || 2000
    this.vadOptions = options.vadOptions
    this.hostFactory = options.hostFactory || (() => new AudioHostController({ electron: this.electron }))
    this.workerFactory = options.workerFactory || (() => new RealtimeWorkerHost({ electron: this.electron }))
    this.captionHandler = null
    this.errorHandler = null
    this.session = null
    this.disposed = false
  }

  onCaption (handler) {
    if (typeof handler !== 'function') throw new TypeError('caption handler must be a function')
    this.captionHandler = handler
    return () => {
      if (this.captionHandler === handler) this.captionHandler = null
    }
  }

  onError (handler) {
    if (typeof handler !== 'function') throw new TypeError('error handler must be a function')
    this.errorHandler = handler
    return () => {
      if (this.errorHandler === handler) this.errorHandler = null
    }
  }

  fault (session, event) {
    if (this.disposed || this.session !== session || session.stopping) return
    if (this.errorHandler) {
      try { this.errorHandler(event) } catch { /* observer failures stay isolated */ }
    }
  }

  async start (context) {
    if (this.disposed) throw new Error('runtime adapter is disposed')
    if (this.session) throw new Error('runtime adapter is already running')
    if (!context || typeof context.sessionId !== 'string' || context.sessionId.length === 0) {
      throw new TypeError('sessionId is required')
    }
    if (!Array.isArray(context.sourceIds) || context.sourceIds.length === 0) {
      throw new TypeError('at least one sourceId is required')
    }
    const recognizerProfile = this.profileMap[context.profile]
    if (typeof recognizerProfile !== 'string') {
      throw new TypeError(`no recognizer mapping for profile: ${String(context.profile)}`)
    }
    throwIfAborted(context.signal)

    const session = {
      sessionId: context.sessionId,
      sourceIds: [...context.sourceIds],
      host: this.hostFactory(),
      worker: this.workerFactory(),
      unsubscribers: [],
      stopping: false
    }
    this.session = session
    try {
      session.unsubscribers.push(session.worker.onCaption((event) => {
        if (this.session === session && this.captionHandler) this.captionHandler(event)
      }))
      session.unsubscribers.push(session.worker.onExit(({ code }) => {
        this.fault(session, {
          scope: 'worker',
          code: 'REALTIME_WORKER_EXITED',
          message: `识别进程退出（${code}）`,
          recoverable: true
        })
      }))
      session.unsubscribers.push(session.host.onControl((message) => {
        if (message.type === 'track-ended') {
          this.fault(session, {
            scope: 'audio',
            code: 'AUDIO_TRACK_ENDED',
            message: '音频来源已断开',
            recoverable: true
          })
        } else if (message.type === 'host-gone') {
          this.fault(session, {
            scope: 'audio',
            code: 'AUDIO_HOST_GONE',
            message: '音频采集进程中断',
            recoverable: true
          })
        }
      }))

      const resume = context.resume || null
      await session.worker.start({
        sessionId: session.sessionId,
        sourceIds: session.sourceIds,
        recognizerProfile,
        vadOptions: this.vadOptions,
        attempt: resume ? resume.attempt : 0,
        sequenceBases: resume ? resume.sourceSequences : {}
      })
      throwIfAborted(context.signal)

      const channel = new this.electron.MessageChannelMain()
      session.worker.attachPort(channel.port2)
      await session.host.startCapture({
        sessionId: session.sessionId,
        sourceIds: session.sourceIds,
        maxQueueMs: this.maxQueueMs,
        port: channel.port1
      })
      throwIfAborted(context.signal)
      /* 活性兜底：worker 在 configure 后、采集就绪前退出的话，其 exit
         故障落在 busy 迁移窗口内被 coordinator 忽略且不会重发——这里
         显式失败，让迁移自己的失败路径接管。 */
      if (session.worker.exited) {
        throw new Error(`realtime worker exited during start (code ${session.worker.exited.code})`)
      }
    } catch (error) {
      this.teardown(session)
      throw error
    }
  }

  async pause (options = {}) {
    const session = this.requireSession()
    throwIfAborted(options.signal)
    /* await ack：定稿先于 ack 交付；死 worker 抛错走迁移失败路径。 */
    await session.worker.pause()
  }

  async resume (options = {}) {
    const session = this.requireSession()
    throwIfAborted(options.signal)
    await session.worker.resume()
  }

  async stop (options = {}) {
    throwIfAborted(options.signal)
    const session = this.session
    if (!session) return
    session.stopping = true
    try {
      /* 先停采集：host 发 end → worker flush 未收束段（final 在 stopping
         相位仍会被 coordinator 接受）→ 等 worker 的 endReceived 确定性
         信号（带上限）→ 再收拾 worker。 */
      await session.host.stopCapture()
      await session.worker.waitForEnd()
    } finally {
      this.teardown(session)
    }
  }

  requireSession () {
    if (this.disposed) throw new Error('runtime adapter is disposed')
    if (!this.session) throw new Error('runtime adapter is not running')
    return this.session
  }

  teardown (session) {
    if (this.session === session) this.session = null
    for (const unsubscribe of session.unsubscribers) {
      try { unsubscribe() } catch { /* best effort */ }
    }
    session.unsubscribers = []
    try { session.host.dispose() } catch { /* best effort */ }
    try { session.worker.dispose() } catch { /* best effort */ }
  }

  dispose () {
    if (this.disposed) return
    this.disposed = true
    const session = this.session
    if (session) {
      session.stopping = true
      this.teardown(session)
    }
    this.captionHandler = null
    this.errorHandler = null
  }
}

module.exports = { DEFAULT_PROFILE_MAP, RealtimeRuntimeAdapter }
