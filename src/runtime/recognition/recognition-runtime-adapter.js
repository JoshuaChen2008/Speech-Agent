'use strict'

const { performance, monitorEventLoopDelay } = require('node:perf_hooks')
const { RealtimeRuntimeAdapter } = require('../realtime-runtime-adapter')
const { RecognitionSessionRouter } = require('./recognition-session-router')
const { NlsRealtimeProvider } = require('./nls-realtime-provider')
const { RECOGNITION_ERROR_CODES } = require('../../contracts/recognition')

function failure (code) { return Object.assign(new Error(code), { code }) }

class RecognitionRuntimeAdapter extends RealtimeRuntimeAdapter {
  constructor (options = {}) {
    super(options)
    this.recognitionSettings = options.recognitionSettings
    this.providerFactory = options.providerFactory || (options => new NlsRealtimeProvider(options))
    this.statusHandler = null
    this.progressHandler = null
    this.output = null
    this.router = null
    this.cloudPort = null
    this.provider = null
    this.pendingWrites = new Set()
    this.endWaitTimeoutMs = 10000
    this.takeoverTimeoutMs = options.takeoverTimeoutMs ?? 30000
    if (!Number.isInteger(this.takeoverTimeoutMs) || this.takeoverTimeoutMs < 1 || this.takeoverTimeoutMs > 30000) {
      throw new RangeError('takeoverTimeoutMs must be between 1 and 30000')
    }
    super.onCaption(event => this.router ? this.router.local(event) : this.output?.(event))
  }

  onCaption (handler) { this.output = handler; return () => { if (this.output === handler) this.output = null } }
  onRecognitionStatus (handler) { this.statusHandler = handler; return () => { if (this.statusHandler === handler) this.statusHandler = null } }
  onRecognitionProgress (handler) { this.progressHandler = handler; return () => { if (this.progressHandler === handler) this.progressHandler = null } }

  async start (context) {
    const binding = context.recognition
    if (binding?.strategy !== 'cloud-primary') {
      this.router = null
      return super.start(context)
    }
    if (!this.router || this.router.sessionId !== context.sessionId) {
      this.origin = performance.now()
      this.router = new RecognitionSessionRouter({ sessionId: context.sessionId, sourceId: context.sourceIds[0],
        sequence: context.resume?.sourceSequences?.[context.sourceIds[0]] || 0,
        now: () => performance.now() - this.origin,
        emit: event => this.output?.(event),
        control: message => this.cloudPort?.postMessage(message),
        status: value => this.statusHandler?.(value) })
    } else if (this.router.faultCode && this.router.actualProvider === 'nls') {
      // Explicit Retry after a bounded-buffer failure resumes locally, never
      // silently recaptures or loops on the failed network path.
      this.router.actualProvider = 'local'
      this.router.fallbackCode = this.router.faultCode
      this.router.fallbackAtMs = Math.round(performance.now() - this.origin)
    }
    this.context = { ...context, refinementEnabled: false }
    this.pausedCloudSession = false
    this.startingCloud = true
    try {
      await super.start(this.context)
      if (this.streamFault) {
        const error = this.streamFault
        await super.stop()
        throw error
      }
      this.router.report()
    } finally { this.startingCloud = false }
  }

  workerConfiguration () {
    return this.router?.actualProvider === 'nls'
      ? { cloudAudio: true, initialCredits: 2, creditBatch: 1,
          recognizer: undefined, draftRecognizer: undefined, vad: undefined, refinement: false }
      : {}
  }

  async beforeCapture (session, context) {
    if (!this.router) return
    this.streamFault = null
    this.audioEnded = false
    this.pendingWrites.clear()
    this.delayMonitor = monitorEventLoopDelay({ resolution: 10 })
    this.delayMonitor.enable()
    session.unsubscribers.push(session.worker.onControl(message => {
      if (this.session !== session || session.faulted) return
      if (message.type === 'recognition-fault') { this.failRecognition(session, message.code); return }
      if (session.stopping) return
      if (message.type === 'recognition-local-loading') {
        void this.loadLocalFallback(session, context)
      } else if (message.type === 'recognition-local-ready') {
        if (session.takeoverCancelled || !session.fallbackReady || !this.router.pendingFallback) return
        clearTimeout(this.takeoverTimer)
        this.router.confirmTakeover()
        this.progress(session, 'replaying')
        try { this.cloudPort.postMessage({ type: 'local-start' }) } catch { this.failRecognition(session, 'RECOGNITION_FALLBACK_FAILED') }
      } else if (message.type === 'recognition-local-progress') {
        this.progress(session, message.phase)
      }
    }))
    if (this.router.actualProvider === 'local') {
      this.router.openStream((performance.now() - this.origin) / 1000)
      return
    }
    const token = await this.recognitionSettings.getToken({ signal: context.signal })
    const generation = this.router.generation + 1
    const provider = this.providerFactory({ token, appKey: this.recognitionSettings.getAppKey(),
      onResult: result => {
        if (this.provider !== provider || this.session !== session || session.faulted) return
        try { this.router.result(generation, result) } catch (error) { this.providerFault(session, error.message) }
      },
      onFault: error => { if (this.provider === provider) this.providerFault(session, error.code) } })
    this.provider = provider
    await provider.open({ signal: context.signal })
    if (context.signal?.aborted || this.session !== session) { provider.abort(); throw failure('NLS_CANCELLED') }
    this.router.openStream((performance.now() - this.origin) / 1000)
    const channel = new this.electron.MessageChannelMain()
    this.cloudPort = channel.port1
    session.worker.attachCloudPort(channel.port2)
    const port = this.cloudPort
    port.on('message', ({ data }) => {
      if (this.session !== session || session.faulted || this.cloudPort !== port) return
      if (data?.type === 'fault') { this.failRecognition(session, data.code); return }
      if (data?.type === 'audio-end') { this.audioEnded = true; return }
      if (data?.type !== 'audio' || !this.router.accepting) return
      try {
        if (!(data.pcm instanceof Uint8Array) || data.pcm.byteLength !== data.sampleCount * 2 ||
            !Number.isInteger(data.id) || data.id < 0) throw failure('RECOGNITION_AUDIO_GAP')
        this.router.audio(data.startSample, data.sampleCount)
        const write = provider.writeAudio(data.pcm).then(() => {
          if (this.cloudPort === port) port.postMessage({ type: 'ack', id: data.id })
        }).catch(error => { if (this.provider === provider) this.providerFault(session, error.code) }).finally(() => this.pendingWrites.delete(write))
        this.pendingWrites.add(write)
      } catch (error) { this.failRecognition(session, error.code || error.message) }
    })
    port.start()
  }

  progress (session, phase) {
    if (this.session !== session || session.stopping || session.faulted || session.fallbackPhase === phase) return
    session.fallbackPhase = phase
    this.progressHandler?.({ sessionId: session.sessionId, phase })
  }

  async loadLocalFallback (session, context) {
    if (this.session !== session || session.stopping || session.faulted || session.fallbackWorker || session.fallbackLoading ||
        session.takeoverCancelled || !this.router.pendingFallback) return
    session.fallbackLoading = true
    this.progress(session, 'loading')
    try {
      // A stop requested by the newly published snapshot enters the adapter
      // on a microtask. Give it that turn before allocating a native child.
      await Promise.resolve()
      if (session.stopping || session.faulted || session.takeoverCancelled || !this.router.pendingFallback) return
      const worker = this.workerFactory()
      session.fallbackWorker = worker
      session.unsubscribers.push(worker.onCaption(event => {
        if (this.session === session && !session.faulted && !session.takeoverCancelled) this.captionHandler?.(event)
      }))
      session.unsubscribers.push(worker.onExit(() => {
        if (session.fallbackReady && !session.stopping) this.failRecognition(session, 'RECOGNITION_FALLBACK_FAILED')
      }))
      session.unsubscribers.push(worker.onControl(message => {
        // Draft failure still degrades to the authoritative recognizer only.
        if (message.type === 'draft-recognizer-fault' && this.session === session && !session.stopping && !session.draftRecognizerFaulted) {
          session.draftRecognizerFaulted = true
          session.draftRecognizerFaultStage = message.stage
          this.draftFaultHandler?.(Object.freeze({ code: message.code, stage: message.stage, count: 1 }))
        }
      }))
      const recognizerProfile = this.profileMap[context.profile]
      await worker.start({ sessionId: session.sessionId, sourceIds: session.sourceIds, recognizerProfile,
        recognizer: recognizerProfile !== 'null' ? this.recognizer : undefined,
        draftRecognizer: recognizerProfile !== 'null' ? this.draftRecognizer : undefined,
        vad: recognizerProfile !== 'null' ? this.vad : undefined,
        vadOptions: this.vadOptions, refinement: false,
        initialCredits: 1, creditBatch: 1, configureTimeoutMs: this.takeoverTimeoutMs,
        attempt: context.resume?.attempt || 0, sequenceBases: context.resume?.sourceSequences || {} })
      if (this.session !== session || session.stopping || session.faulted || session.takeoverCancelled || !this.router.pendingFallback) return
      session.fallbackReady = true
      const channel = new this.electron.MessageChannelMain()
      worker.attachPort(channel.port1)
      session.worker.attachFallbackPort(channel.port2)
    } catch {
      if (!session.stopping && !session.takeoverCancelled) this.failRecognition(session, 'RECOGNITION_FALLBACK_FAILED')
    }
  }

  providerFault (session, code) {
    if (this.session !== session || session.faulted) return
    if (session.stopping || this.startingCloud || this.context?.signal?.aborted) {
      this.streamFault = failure(this.safeCode(code))
      return
    }
    if (['RECOGNITION_BUFFER_LIMIT', 'NLS_BUFFER_EXCEEDED', 'RECOGNITION_AUDIO_GAP'].includes(code)) {
      this.failRecognition(session, code)
      return
    }
    let requested
    try { requested = this.router.fallback(this.safeCode(code)) } catch {
      this.failRecognition(session, 'RECOGNITION_FALLBACK_FAILED')
      return
    }
    if (requested) {
      this.takeoverTimer = setTimeout(() => this.failRecognition(session, 'RECOGNITION_FALLBACK_FAILED'), this.takeoverTimeoutMs)
      const provider = this.provider
      this.provider = null
      provider?.abort()
    }
  }

  safeCode (code) { return RECOGNITION_ERROR_CODES.includes(code) ? code : 'NLS_SERVICE_FAILED' }

  failRecognition (session, code) {
    if (this.session !== session || session.faulted) return
    const safe = this.safeCode(code)
    clearTimeout(this.takeoverTimer)
    session.takeoverCancelled = true
    try { this.cloudPort?.postMessage({ type: 'local-cancel' }) } catch {}
    this.streamFault = failure(safe)
    this.router.fail(safe)
    const provider = this.provider
    this.provider = null
    provider?.abort()
    if (session.stopping) return
    this.fault(session, { scope: 'audio', code: safe,
      message: '语音识别中断，已停止采集；请重试或停止会话', recoverable: true })
  }

  async afterCaptureEnd (session, options) {
    if (!this.router) return
    const capture = session.captureMetrics?.[session.sourceIds[0]]
    if (capture && ['droppedFrames', 'lostInFlightFrames', 'discardedAtStop'].some(key => capture[key] > 0)) {
      throw failure('RECOGNITION_AUDIO_GAP')
    }
    if (session.worker.lastStats?.endReceived !== true && !this.audioEnded) throw failure('RECOGNITION_AUDIO_GAP')
    const deadline = Date.now() + 10000
    while (this.pendingWrites.size) {
      if (Date.now() >= deadline || options.signal?.aborted) throw failure('NLS_STOP_TIMEOUT')
      await Promise.race([Promise.all([...this.pendingWrites]), new Promise(resolve => setTimeout(resolve, 25))])
    }
    if (this.streamFault) throw this.streamFault
    // Native captions and stats share its parent channel. Waiting for its end
    // ensures all flush captions are delivered before removing subscriptions.
    if (session.fallbackReady) await session.fallbackWorker.waitForEnd(this.endWaitTimeoutMs)
    if (this.provider && this.router.actualProvider === 'nls') {
      await this.provider.finishInput({ signal: options.signal })
      if (this.router.active) throw failure('NLS_INVALID_RESPONSE')
    }
    if (this.router.pendingFallback) throw failure('RECOGNITION_FALLBACK_FAILED')
    if (this.streamFault) throw this.streamFault
  }

  async pause (options = {}) {
    if (!this.router) return super.pause(options)
    await this.stop(options)
    this.pausedCloudSession = true
  }

  async resume (options = {}) {
    if (!this.router) return super.resume(options)
    if (!this.pausedCloudSession) throw failure('NLS_CONNECTION_CLOSED')
    await this.start({ ...this.context, signal: options.signal })
  }

  async stop (options = {}) {
    const session = this.session
    if (session && this.router?.pendingFallback) {
      session.takeoverCancelled = true
      clearTimeout(this.takeoverTimer)
      this.streamFault = failure('RECOGNITION_FALLBACK_FAILED')
      this.router.fail('RECOGNITION_FALLBACK_FAILED')
      try { this.cloudPort?.postMessage({ type: 'local-cancel' }) } catch {}
    }
    try { await super.stop(options) } catch (error) {
      if (this.router && !this.router.faultCode) this.router.fail(this.safeCode(error.code))
      throw error
    }
  }

  teardownSession (session, mode) {
    if (session.teardownPromise) return session.teardownPromise
    if (this.session !== session) return super.teardownSession(session, mode)
    clearTimeout(this.takeoverTimer)
    session.takeoverCancelled = true
    const provider = this.provider
    this.provider = null
    if (this.router) this.router.accepting = false
    provider?.abort()
    this.cloudPort?.close()
    this.cloudPort = null
    this.delayMonitor?.disable()
    if (this.delayMonitor) {
      this.recognitionMetrics = this.eventLoopMetrics()
    }
    return super.teardownSession(session, mode)
  }

  captureDiagnostics (session) {
    super.captureDiagnostics(session)
    if (session.fallbackWorker) this.lastRunDiagnostics.localFallback = session.fallbackWorker.lastStats
  }

  getLiveDiagnostics () {
    const value = super.getLiveDiagnostics()
    if (value && this.router && this.delayMonitor) value.recognition = this.eventLoopMetrics()
    return value
  }

  eventLoopMetrics () {
    return {
      eventLoopP95Ms: Number((this.delayMonitor.percentile(95) / 1e6).toFixed(3)),
      eventLoopP99Ms: Number((this.delayMonitor.percentile(99) / 1e6).toFixed(3))
    }
  }

  getLastRunDiagnostics () {
    const value = super.getLastRunDiagnostics()
    if (value && this.router && this.recognitionMetrics) value.recognition = { ...this.recognitionMetrics }
    return value
  }
}

module.exports = { RecognitionRuntimeAdapter }
