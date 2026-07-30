'use strict'

// @ts-check

/* B2 真实运行链路的 runtime adapter（I2.1 结构接线）。
   --------------------------------------------------------------------------
   实现 B1 冻结的 adapter 接口（start/pause/resume/stop/dispose/onCaption，
   外加 §12.4 关闭后的可选 onError），组合：
     AudioHostController（隐藏采集窗）→ MessageChannelMain → RealtimeWorkerHost
   PCM 不经过主进程；caption 从 worker 边界（已契约校验）直达 coordinator 的
   acceptCaption 路径。

   recognizer profile 经 profileMap 显式映射，默认全部映射到 'null'（消费帧、
   不产文本）——即【结构模式】：状态机、采集、背压、恢复全真，零字幕、绝不
   伪造。Gate 0B 2026-07-27 改判后，主进程可注入 options.recognizer（模型
   目录等，由 model-resolver 解析）并把批准 profile 映射到真实 recognizer
   名；此时 worker configure 会同步载入模型再回执。 */

const { AudioHostController } = require('./audio-host/audio-host-controller')
const { RealtimeWorkerHost } = require('./realtime-worker/worker-host')
const { RefineWorkerHost } = require('./refine-worker/worker-host')
const { assertSingleSourceIds } = require('../contracts')

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
    /* 真实模型选项（{kind, modelDir, numThreads, modelType}），null = 结构模式。 */
    this.recognizer = options.recognizer || null
    /* 真实 VAD 选项（{kind:'silero', modelPath}），null = EnergyVad 兜底。 */
    this.vad = options.vad || null
    /* 精修模型选项（{kind:'sherpa-offline-transducer', modelDir, numThreads}），
       null = 无二遍精修。精修是增强路径：refine worker 起不来或中途退出都
       只降级（无 refined 事件），绝不影响实时字幕。 */
    this.refinement = options.refinement || null
    this.refineWorkerFactory = options.refineWorkerFactory || (() => new RefineWorkerHost({ electron: this.electron }))
    this.onDegraded = options.onDegraded || ((message) => console.warn(`[runtime] ${message}`))
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
    assertSingleSourceIds(context.sourceIds)
    const recognizerProfile = this.profileMap[context.profile]
    if (typeof recognizerProfile !== 'string') {
      throw new TypeError(`no recognizer mapping for profile: ${String(context.profile)}`)
    }
    throwIfAborted(context.signal)

    const useRefinement = recognizerProfile !== 'null' && !!this.refinement
    const session = {
      sessionId: context.sessionId,
      sourceIds: [...context.sourceIds],
      host: this.hostFactory(),
      worker: this.workerFactory(),
      refineWorker: useRefinement ? this.refineWorkerFactory() : null,
      refineReady: false,
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
      if (session.refineWorker) {
        /* 精修退出 ≠ 会话故障：实时字幕继续，仅降级并留警告。宿主对象
           就地收殓（进程已退，dispose 只清理监听与占位）。 */
        session.unsubscribers.push(session.refineWorker.onExit(({ code }) => {
          /* refineReady 门：configure 期间的崩溃由 refineStart 的失败路径
             统一告警，这里只管「配置成功后」的中途退出，避免双重告警。 */
          if (this.session === session && !session.stopping && session.refineWorker && session.refineReady) {
            const refineWorker = session.refineWorker
            session.refineWorker = null
            try { refineWorker.dispose() } catch { /* best effort */ }
            this.onDegraded(`refine worker exited (${code}); captions continue without refinement`)
          }
        }))
      }
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
      /* realtime 与 refine worker 并行配置（各自同步载模型，串行会翻倍
         start 时长）；精修配置失败只降级，不失败会话。 */
      const workerStart = session.worker.start({
        sessionId: session.sessionId,
        sourceIds: session.sourceIds,
        recognizerProfile,
        /* null profile 绝不携带模型/VAD 选项：结构模式的 worker 不加载任何
           原生模块（构造性保证，不依赖组合方自觉）。 */
        recognizer: recognizerProfile !== 'null' && this.recognizer ? this.recognizer : undefined,
        vad: recognizerProfile !== 'null' && this.vad ? this.vad : undefined,
        refinement: session.refineWorker !== null,
        vadOptions: this.vadOptions,
        attempt: resume ? resume.attempt : 0,
        sequenceBases: resume ? resume.sourceSequences : {}
      })
      const refineStart = session.refineWorker
        ? session.refineWorker.start({ model: this.refinement }).then(() => true, (error) => {
            this.onDegraded(`refinement unavailable for this session: ${String(error?.message || error).slice(0, 160)}`)
            return false
          })
        : Promise.resolve(false)
      const [, refineReady] = await Promise.all([workerStart, refineStart])
      throwIfAborted(context.signal)
      session.refineReady = refineReady
      if (refineReady && session.refineWorker) {
        const refineChannel = new this.electron.MessageChannelMain()
        session.worker.attachRefinePort(refineChannel.port1)
        session.refineWorker.attachPort(refineChannel.port2)
      } else if (session.refineWorker) {
        session.refineWorker.dispose()
        session.refineWorker = null
      }

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
    if (session.refineWorker) {
      try { session.refineWorker.dispose() } catch { /* best effort */ }
      session.refineWorker = null
    }
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
