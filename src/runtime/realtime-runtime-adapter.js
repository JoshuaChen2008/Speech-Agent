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
const { performance } = require('node:perf_hooks')
const { assertSingleSourceIds } = require('../contracts')

const DEFAULT_PROFILE_MAP = Object.freeze({ fast: 'null', balanced: 'null', accurate: 'null' })
const CAPTURE_PROBE_FLOOR_AFTER_SOURCE_START_MS = 40

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
    this.micLabelSha256 = options.micLabelSha256 || null
    this.vadOptions = options.vadOptions
    /* 真实模型选项（{kind, modelDir, numThreads, modelType}），null = 结构模式。 */
    this.recognizer = options.recognizer || null
    /* 真实 VAD 选项（{kind:'silero', modelPath}），null = EnergyVad 兜底。 */
    this.vad = options.vad || null
    /* 精修模型选项（{kind:'sherpa-offline-transducer', modelDir, numThreads}），
       null = 无二遍精修。精修是增强路径：refine worker 起不来或中途退出都
       只降级（无 refined 事件），绝不影响实时字幕。 */
    this.refinement = options.refinement || null
    /* 仅 I2 交互验收 runner 可传的真实 refine 回包延迟。它不参与任何产品
       配置、IPC 或持久化；默认 null，运行期不会注入延迟。这样可在真实
       offline decode 已完成、回包仍在 realtime worker pending 队列时验证
       pause/resume 的缓冲边界，而不是伪造 refined caption。 */
    this.acceptanceRefineResponseDelayMs = options.acceptanceRefineResponseDelayMs ?? null
    this.refineWorkerFactory = options.refineWorkerFactory || (() => new RefineWorkerHost({
      electron: this.electron,
      onFatalError: options.onRefineUtilityFatal
    }))
    this.onDegraded = options.onDegraded || ((message) => console.warn(`[runtime] ${message}`))
    this.hostFactory = options.hostFactory || (() => new AudioHostController({
      electron: this.electron,
      registerWebContents: options.registerAudioHostWebContents,
      onRenderProcessGone: options.onAudioHostRenderProcessGone,
      onPreloadError: options.onAudioHostPreloadError,
      onUnresponsive: options.onAudioHostUnresponsive
    }))
    this.workerFactory = options.workerFactory || (() => new RealtimeWorkerHost({
      electron: this.electron,
      onFatalError: options.onRealtimeUtilityFatal
    }))
    this.captionHandler = null
    this.errorHandler = null
    this.session = null
    /* 最近一次会话的纯指标快照。只包含帧/队列/worker 计数，不包含 PCM、
       音频路径或字幕正文，供 I2 smoke 与故障诊断读取。 */
    this.lastRunDiagnostics = null
    this.disposePromise = null
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
    /* 故障一发生就关闭采集，不能要求用户先点 retry/stop 才释放麦克风、
       loopback track 或隐藏窗口。cleanupPromise 让紧接着的 retry/stop 等待
       同一轮收敛，避免旧 host teardown 与新一轮 start 竞态。 */
    session.stopping = true
    session.faulted = true
    const cleanupPromise = this.cleanupFaultedSession(session)
    cleanupPromise.catch(() => {})
    session.cleanupPromise = cleanupPromise
    if (this.errorHandler) {
      try { this.errorHandler(event) } catch { /* observer failures stay isolated */ }
    }
  }

  async cleanupFaultedSession (session) {
    try {
      const captureResult = await session.host.stopCapture()
      if (captureResult?.metrics) session.captureMetrics = captureResult.metrics
      await session.worker.waitForEnd()
    } catch { /* 原始 fault 已上报；清理继续走 finally，不能制造第二个产品错误 */ } finally {
      this.captureDiagnostics(session)
      await this.teardownSession(session, 'graceful')
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
      captureEvidence: null,
      captureMetrics: {},
      workerStats: null,
      unsubscribers: [],
      stopping: false,
      faulted: false,
      cleanupPromise: null,
      teardownPromise: null,
      acceptedCaptionTimings: [],
      clockCalibrations: {
        audioHost: null,
        utility: null
      }
    }
    this.session = session
    try {
      session.unsubscribers.push(session.worker.onCaption((event) => {
        const timing = typeof session.worker.takeCaptionTiming === 'function'
          ? session.worker.takeCaptionTiming(event)
          : null
        if (this.session === session && !session.faulted && this.captionHandler) {
          const accepted = this.captionHandler(event)
          if (accepted === true && timing && session.acceptedCaptionTimings.length < 64) {
            session.acceptedCaptionTimings.push({
              ...timing,
              coordinatorAcceptedReturnMainClockMs: Number(performance.now().toFixed(3))
            })
          }
        }
      }))
      session.unsubscribers.push(session.worker.onStats((stats) => {
        if (this.session === session) session.workerStats = stats
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
            try { void Promise.resolve(refineWorker.dispose()).catch(() => {}) } catch { /* best effort */ }
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
        } else if (message.type === 'metrics' || message.type === 'stopped') {
          session.captureMetrics = message.sources || {}
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
      const refineStartOptions = { model: this.refinement }
      if (this.acceptanceRefineResponseDelayMs !== null) {
        refineStartOptions.acceptanceResponseDelayMs = this.acceptanceRefineResponseDelayMs
      }
      const refineStart = session.refineWorker
        ? session.refineWorker.start(refineStartOptions).then(() => true, (error) => {
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
        await this.shutdownWorker(session.refineWorker, 'graceful', 'offline refinement')
        session.refineWorker = null
      }

      const channel = new this.electron.MessageChannelMain()
      session.worker.attachPort(channel.port2)
      session.captureEvidence = await session.host.startCapture({
        sessionId: session.sessionId,
        sourceIds: session.sourceIds,
        maxQueueMs: this.maxQueueMs,
        micLabelSha256: this.micLabelSha256,
        port: channel.port1
      })
      throwIfAborted(context.signal)
      /* host/track 可在 startCapture 的异步窗口内先上报 fault。Coordinator
         此时处于 busy，会让当前 start 的失败路径负责；不能继续返回成功并
         发布一个 adapter 已经 teardown 的伪 listening 状态。 */
      if (session.faulted || this.session !== session) {
        if (session.cleanupPromise) await session.cleanupPromise
        throw new Error('runtime faulted during start')
      }
      /* 活性兜底：worker 在 configure 后、采集就绪前退出的话，其 exit
         故障落在 busy 迁移窗口内被 coordinator 忽略且不会重发——这里
         显式失败，让迁移自己的失败路径接管。 */
      if (session.worker.exited) {
        throw new Error(`realtime worker exited during start (code ${session.worker.exited.code})`)
      }
    } catch (error) {
      /* A failed start can still leave sherpa/ONNX synchronously constructing
         or releasing native state.  Reuse the normal graceful teardown rather
         than immediately killing that live utility generation. */
      try {
        await this.teardownSession(session, 'graceful')
      } catch (cleanupError) {
        /* Reaping failure is the stronger safety signal: returning only the
           original capture/configuration error would let Coordinator treat an
           unconfirmed native generation as an ordinary retryable failure. */
        if (cleanupError instanceof Error && cleanupError.cause === undefined) {
          try { cleanupError.cause = error } catch { /* immutable error */ }
        }
        throw cleanupError
      }
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

  /**
   * Windows suspend invalidates the live-media continuity guarantee.  Stop the
   * hidden capture immediately through the same fault path used by a dead
   * track/worker, then leave recovery to the Coordinator's explicit Retry.
   *
   * This is intentionally an internal product boundary rather than a renderer
   * command: visible pages cannot manufacture a system event or force a media
   * reacquisition.  Returns false when there is no active generation to
   * interrupt, which also makes duplicate power notifications harmless.
   */
  interruptForSystemSuspend () {
    const session = this.session
    if (this.disposed || !session || session.stopping || session.faulted) return false
    this.fault(session, {
      scope: 'system',
      code: 'SYSTEM_SUSPEND',
      message: '系统休眠，音频会话已中断',
      recoverable: true
    })
    return true
  }

  /** I2-only clock preparation; visible product renderers cannot invoke it. */
  async calibrateTimingProbe () {
    const session = this.requireSession()
    const [audioHostCalibration, utility] = await Promise.all([
      session.host.calibrateTimingClock(session.sourceIds[0]),
      session.worker.calibrateClock()
    ])
    if (this.session !== session || session.faulted || session.stopping) {
      throw new Error('runtime session changed during timing calibration')
    }
    session.clockCalibrations = {
      audioHost: audioHostCalibration || null,
      utility: utility || null
    }
    return structuredCloneSafe(session.clockCalibrations)
  }

  /** I2-only probe arm for one already-calibrated, scheduled source start. */
  async armTimingProbe (sourceStartMainClockMs) {
    const session = this.requireSession()
    if (!Number.isFinite(sourceStartMainClockMs) || sourceStartMainClockMs < 0) {
      throw new TypeError('sourceStartMainClockMs must be a finite non-negative number')
    }
    if (!session.clockCalibrations.audioHost || !session.clockCalibrations.utility) {
      throw new Error('timing clocks must be calibrated before arming')
    }
    /* The corpus has a frozen 140 ms leading-silence onset. Ignore only the
       first two 20 ms analysis windows after source t0 so pre-source ambient
       energy and sub-ms cross-clock uncertainty cannot become a fake onset;
       the authoritative source+140 ms acceptance origin is unchanged. */
    const captureFloorMainClockMs =
      sourceStartMainClockMs + CAPTURE_PROBE_FLOOR_AFTER_SOURCE_START_MS
    const audioHost = await session.host.armTimingProbe(session.sourceIds[0], captureFloorMainClockMs)
    if (this.session !== session || session.faulted || session.stopping) {
      throw new Error('runtime session changed while arming the timing probe')
    }
    return {
      ...audioHost,
      clockCalibrations: structuredCloneSafe(session.clockCalibrations)
    }
  }

  async stop (options = {}) {
    throwIfAborted(options.signal)
    const session = this.session
    if (!session) return
    if (session.cleanupPromise) {
      await session.cleanupPromise
      return
    }
    session.stopping = true
    try {
      /* 先停采集：host 发 end → worker flush 未收束段（final 在 stopping
         相位仍会被 coordinator 接受）→ 等 worker 的 endReceived 确定性
         信号（带上限）→ 再收拾 worker。 */
      const captureResult = await session.host.stopCapture()
      if (captureResult?.metrics) session.captureMetrics = captureResult.metrics
      await session.worker.waitForEnd()
    } finally {
      this.captureDiagnostics(session)
      await this.teardownSession(session, 'graceful')
    }
  }

  captureDiagnostics (session) {
    const workerStats = session.worker.lastStats || session.workerStats || null
    this.lastRunDiagnostics = {
      schemaVersion: 1,
      sessionId: session.sessionId,
      sourceIds: [...session.sourceIds],
      /* 只有来源 track 的哈希与非身份 settings；不含 PCM、正文或设备明文。 */
      input: structuredCloneSafe(session.captureEvidence || {}),
      capture: structuredCloneSafe(session.captureMetrics || {}),
      worker: structuredCloneSafe(workerStats),
      workerHost: {
        acceptedCaptionTimings: structuredCloneSafe(session.acceptedCaptionTimings)
      },
      timingCalibrations: structuredCloneSafe(session.clockCalibrations),
      droppedCaptionCount: session.worker.droppedCaptionCount,
      refinementEnabled: session.refineReady === true
    }
  }

  getLastRunDiagnostics () {
    return structuredCloneSafe(this.lastRunDiagnostics)
  }

  /**
   * A bounded, text-free view for a currently active acceptance scenario.
   * It is deliberately narrower than the session object: callers receive only
   * already-sanitized capture counters and worker statistics, never PCM,
   * device names, model paths or caption text.  It lets a DWM drag observer
   * compare transport before/after a visible interaction without waiting for
   * stopCapture() to retire the session.
   */
  getLiveDiagnostics () {
    const session = this.session
    if (!session || this.disposed) return null
    return {
      schemaVersion: 1,
      sourceIds: [...session.sourceIds],
      capture: structuredCloneSafe(session.captureMetrics || {}),
      worker: structuredCloneSafe(session.worker.lastStats || session.workerStats || null),
      droppedCaptionCount: session.worker.droppedCaptionCount,
      refinementEnabled: session.refineReady === true
    }
  }

  requireSession () {
    if (this.disposed) throw new Error('runtime adapter is disposed')
    if (!this.session) throw new Error('runtime adapter is not running')
    return this.session
  }

  async shutdownWorker (worker, mode, label) {
    if (!worker) return
    let outcome
    try {
      if (mode === 'graceful' && typeof worker.shutdown === 'function') {
        outcome = await worker.shutdown()
      } else if (typeof worker.terminateAndWait === 'function') {
        await worker.terminateAndWait()
        return
      } else if (typeof worker.dispose === 'function') {
        await worker.dispose()
        return
      }
    } catch (error) {
      if (error?.code !== 'UTILITY_TERMINATION_TIMEOUT' ||
          typeof worker.waitForExactExit !== 'function') {
        throw error
      }
      /* The 30s + 5s deadlines trigger escalation and diagnostics; they are
         not permission to abandon a live exact child.  Keep the application
         quit/adapter retirement promise pending until Electron reports exit. */
      await worker.waitForExactExit()
      this.onDegraded(`${label} exited after the termination deadline`)
      return
    }
    if (outcome && outcome.graceful === false) {
      this.onDegraded(`${label} required forced shutdown (${outcome.reason})`)
    }
  }

  teardownSession (session, mode = 'graceful') {
    if (session.teardownPromise) return session.teardownPromise
    session.stopping = true
    for (const unsubscribe of session.unsubscribers) {
      try { unsubscribe() } catch { /* best effort */ }
    }
    session.unsubscribers = []
    try { session.host.dispose() } catch { /* best effort */ }
    const refineWorker = session.refineWorker
    session.refineWorker = null
    const promise = Promise.all([
      this.shutdownWorker(session.worker, mode, 'realtime ASR'),
      this.shutdownWorker(refineWorker, mode, 'offline refinement')
    ]).catch((error) => {
      /* An unconfirmed old native generation must make this adapter unusable;
         a later retry may only proceed through a newly constructed adapter. */
      this.disposed = true
      throw error
    }).finally(() => {
      if (this.session === session) this.session = null
    })
    session.teardownPromise = promise
    return promise
  }

  dispose () {
    if (this.disposePromise) return this.disposePromise
    this.disposed = true
    const session = this.session
    if (session) {
      session.stopping = true
      this.disposePromise = this.teardownSession(session, 'graceful')
    } else {
      this.disposePromise = Promise.resolve()
    }
    this.captionHandler = null
    this.errorHandler = null
    return this.disposePromise
  }
}

function structuredCloneSafe (value) {
  if (value === undefined || value === null) return value ?? null
  return JSON.parse(JSON.stringify(value))
}

module.exports = {
  CAPTURE_PROBE_FLOOR_AFTER_SOURCE_START_MS,
  DEFAULT_PROFILE_MAP,
  RealtimeRuntimeAdapter
}
