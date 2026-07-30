'use strict'

// @ts-check

/* 隐藏音频宿主的主进程控制器（B2.1）。
   职责：非持久化 session、最小权限 handler、display-media 处理、宿主窗
   生命周期，以及有界诊断采集与结构化指标的编排。
   非职责（后续阶段）：连续 MessagePort PCM 直通（B2.2）、崩溃自动重启
   策略、与 SessionCoordinator 的运行时接线。
   拓扑严格沿用 Gate 0C 批准版本（docs/validation/gate-0c.md）。 */

const path = require('node:path')
const CHANNELS = require('./channels')
const {
  evaluateDisplayRequest,
  isPermissionAllowed,
  publicError,
  sanitizeControlMessage,
  sanitizeOrigin,
  scrubLocalPaths,
  selectScreenSource,
  validateCaptureOptions,
  validateDiagnosticOptions
} = require('./policy')
const {
  analyzeLevels,
  evaluateDiagnostic
} = require('./pcm-metrics')

const LOAD_TIMEOUT_MS = 5000

function withTimeout (promise, milliseconds, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds)
    })
  ]).finally(() => clearTimeout(timer))
}

function coerceSamples (value) {
  if (value instanceof Float32Array) return new Float32Array(value)
  if (value instanceof ArrayBuffer) return new Float32Array(value.slice(0))
  if (ArrayBuffer.isView(value)) {
    return new Float32Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
  }
  throw new TypeError('diagnostic payload must contain Float32 samples')
}

class AudioHostController {
  constructor (options = {}) {
    this.electron = options.electron || require('electron')
    this.partitionName = options.partitionName || `audio-host-${process.pid}`
    this.onEvidence = options.onEvidence || (() => {})
    this.hostWindow = null
    this.partitionReady = false
    this.ipcRegistered = false
    this.activeDiagnostic = null
    this.activeCapture = null
    this.controlListeners = new Set()
    this.disposed = false
  }

  /** 低频控制事件（track-ended / metrics / stopped / host-gone）。 */
  onControl (listener) {
    if (typeof listener !== 'function') throw new TypeError('control listener must be a function')
    this.controlListeners.add(listener)
    return () => this.controlListeners.delete(listener)
  }

  emitControl (message) {
    for (const listener of this.controlListeners) {
      try { listener(message) } catch { /* observer failures stay isolated */ }
    }
  }

  record (stage, detail = null) {
    try { this.onEvidence({ stage, detail }) } catch { /* observer failures stay isolated */ }
  }

  isTrustedHostSender (webContents) {
    return !!this.hostWindow && !this.hostWindow.isDestroyed() && webContents === this.hostWindow.webContents
  }

  setupPartition () {
    if (this.partitionReady) return
    const { desktopCapturer, screen, session } = this.electron
    const partition = session.fromPartition(this.partitionName, { cache: false })

    partition.setPermissionCheckHandler((webContents, permission, origin) => {
      const allowed = isPermissionAllowed(permission, this.isTrustedHostSender(webContents)) &&
        sanitizeOrigin(origin) === 'file://'
      this.record('permission-check', { permission, origin: sanitizeOrigin(origin), allowed })
      return allowed
    })
    partition.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const origin = details?.requestingOrigin || webContents?.getURL() || ''
      const allowed = isPermissionAllowed(permission, this.isTrustedHostSender(webContents)) &&
        sanitizeOrigin(origin) === 'file://'
      this.record('permission-request', { permission, origin: sanitizeOrigin(origin), allowed })
      callback(allowed)
    })

    partition.setDisplayMediaRequestHandler(async (request, callback) => {
      const evaluation = evaluateDisplayRequest({
        frameMatchesHost: request.frame === this.hostWindow?.webContents.mainFrame,
        securityOrigin: request.securityOrigin,
        videoRequested: request.videoRequested,
        audioRequested: request.audioRequested
      })
      const evidence = {
        securityOrigin: sanitizeOrigin(request.securityOrigin),
        videoRequested: request.videoRequested,
        audioRequested: request.audioRequested,
        userGesture: request.userGesture,
        allowed: evaluation.allowed,
        reason: evaluation.reason,
        error: null
      }
      try {
        if (!evaluation.allowed) throw new Error(evaluation.reason)
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
          fetchWindowIcons: false
        })
        const selected = selectScreenSource(sources, screen.getPrimaryDisplay().id)
        if (!selected) throw new Error('No screen source is available')
        callback({ video: selected, audio: 'loopback' })
      } catch (error) {
        evidence.error = publicError(error)
        callback({})
      }
      this.record('display-request', evidence)
    }, { useSystemPicker: false })

    this.partitionReady = true
  }

  registerIpc () {
    if (this.ipcRegistered) return
    const { ipcMain } = this.electron
    ipcMain.handle(CHANNELS.SAVE_DIAGNOSTIC, (event, payload) => this.acceptDiagnostic(event, payload))
    ipcMain.on(CHANNELS.MARK, (event, payload) => {
      if (!this.isTrustedHostSender(event.sender)) return
      this.record('host-mark', { stage: scrubLocalPaths(payload?.stage || 'unknown').slice(0, 100) })
    })
    ipcMain.on(CHANNELS.CONTROL, (event, payload) => {
      if (!this.isTrustedHostSender(event.sender)) return
      const message = sanitizeControlMessage(payload)
      if (!message) return
      /* 控制消息必须属于当前采集会话——宿主窗被替换或重载后的迟到消息丢弃。
         两侧都用清洗后的形式对比，清洗不会误杀合法会话。 */
      if (!this.activeCapture) return
      const expected = scrubLocalPaths(this.activeCapture.options.sessionId).slice(0, 128)
      if (message.sessionId !== expected) return
      this.record('host-control', { type: message.type })
      this.emitControl(message)
    })
    this.ipcRegistered = true
  }

  acceptDiagnostic (event, payload) {
    if (!this.isTrustedHostSender(event.sender)) throw new Error('untrusted diagnostic payload')
    if (event.senderFrame && event.senderFrame !== event.sender.mainFrame) throw new Error('diagnostic must come from the main frame')
    const active = this.activeDiagnostic
    if (!active) throw new Error('no diagnostic capture is running')
    const sourceId = String(payload?.sourceId || '')
    if (payload?.sessionId !== active.options.sessionId) throw new Error('diagnostic sessionId mismatch')
    if (!active.options.sourceIds.includes(sourceId) || active.saved[sourceId]) {
      throw new Error('invalid or duplicate diagnostic sourceId')
    }
    const samples = coerceSamples(payload.samples)
    const levels = analyzeLevels(samples)
    const checks = evaluateDiagnostic(payload.pipeline, levels, active.options.durationMs)
    const entry = { pipeline: payload.pipeline, levels, checks }
    active.saved[sourceId] = entry
    this.record('diagnostic-analyzed', { sourceId, pass: checks.pass })
    return { checks }
  }

  createHostWindow () {
    const { BrowserWindow } = this.electron
    const win = new BrowserWindow({
      width: 320,
      height: 200,
      show: false,
      /* webPreferences 与 Gate 0C spike 完全一致：不关闭默认 Chromium
         sandbox —— 本窗持有回环/麦克风流，是全应用唯一拿到 media 权限的
         renderer，必须保持最强隔离。preload 因此不 require 本地模块。 */
      webPreferences: {
        partition: this.partitionName,
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.on('console-message', (details) => {
      this.record('host-console', { message: scrubLocalPaths(details?.message) })
    })
    win.webContents.on('render-process-gone', (_event, details) => {
      this.record('host-renderer-gone', { reason: details?.reason || null })
      const active = this.activeDiagnostic
      if (active) active.reject(new Error(`audio host renderer exited: ${details?.reason || 'unknown'}`))
      if (this.activeCapture) {
        const sessionId = this.activeCapture.options.sessionId
        this.activeCapture = null
        this.destroyHostWindow()
        this.emitControl({ type: 'host-gone', sessionId, reason: String(details?.reason || 'unknown').slice(0, 64) })
      }
    })
    return win
  }

  /**
   * 有界诊断采集：创建宿主窗 → user-gesture 触发采集 → 只返回结构化指标
   * → 销毁宿主窗。现场 PCM 只存在于内存，一次只允许一个诊断在跑。
   */
  async runDiagnosticCapture (rawOptions = {}) {
    if (this.disposed) throw new Error('audio host controller is disposed')
    /* 与连续采集互斥：否则诊断会覆盖 hostWindow 引用，把正在采集
       麦克风/回环的隐藏窗孤儿化（失去控制句柄却仍在采集）。 */
    if (this.activeDiagnostic || this.activeCapture) throw new Error('audio host is busy')
    if (Object.hasOwn(rawOptions, 'dumpDir')) {
      throw new TypeError('diagnostic audio persistence is not supported')
    }
    const options = validateDiagnosticOptions(rawOptions)

    let rejectDiagnostic
    const aborted = new Promise((_resolve, reject) => { rejectDiagnostic = reject })
    /* reject 可能在 loadFile 期间（Promise.race 挂上 handler 之前）就被
       render-process-gone 或 dispose 触发；先挂空 catch 防 unhandledRejection，
       race 消费的是原 promise，语义不变。 */
    aborted.catch(() => {})
    this.activeDiagnostic = { options, saved: {}, reject: rejectDiagnostic }
    try {
      this.setupPartition()
      this.registerIpc()
      this.hostWindow = this.createHostWindow()
      await withTimeout(this.hostWindow.loadFile(path.join(__dirname, 'host.html')), LOAD_TIMEOUT_MS, 'audio host page load')
      if (this.disposed || !this.hostWindow) throw new Error('audio host controller disposed')
      this.record('host-loaded', { visible: this.hostWindow.isVisible() })
      const invocation = {
        sessionId: options.sessionId,
        sourceIds: options.sourceIds,
        durationMs: options.durationMs
      }
      const budgetMs = (options.durationMs + 8000) * options.sourceIds.length
      const capture = await withTimeout(Promise.race([
        this.hostWindow.webContents.executeJavaScript(
          `globalThis.runAudioHostDiagnostic(${JSON.stringify(invocation)})`, true),
        aborted
      ]), budgetMs, 'audio host diagnostic capture')
      const active = this.activeDiagnostic
      const sources = {}
      let pass = true
      for (const sourceId of options.sourceIds) {
        const outcome = capture[sourceId] || { status: 'error', error: { name: 'Error', message: 'missing capture result' } }
        /* renderer 提供的错误文本在进入报告前统一脱敏。 */
        if (outcome.error) outcome.error = publicError(outcome.error)
        const saved = active.saved[sourceId] || null
        sources[sourceId] = { ...outcome, diagnostic: saved }
        pass = pass && outcome.status === 'ok' && !!saved && saved.checks.pass === true
      }
      return {
        result: pass ? 'pass' : 'fail',
        sessionId: options.sessionId,
        durationMs: options.durationMs,
        hostRemainedHidden: !this.hostWindow.isVisible(),
        sources
      }
    } finally {
      this.activeDiagnostic = null
      this.destroyHostWindow()
    }
  }

  /**
   * 连续 PCM 直通采集（B2.2）：把 MessagePort 交给宿主窗后启动采集。
   * PCM 帧经该端口直达消费端（utility process），不经过主进程；
   * 主进程只收低频控制/指标（onControl）。
   * @param {*} rawOptions { sessionId, sourceIds, maxQueueMs?, port: MessagePortMain }
   */
  async startCapture (rawOptions = {}) {
    if (this.disposed) throw new Error('audio host controller is disposed')
    if (this.activeDiagnostic || this.activeCapture) throw new Error('audio host is busy')
    const options = validateCaptureOptions(rawOptions)
    const port = rawOptions.port
    if (!port || typeof port.postMessage !== 'function') throw new TypeError('a MessagePortMain is required')

    const capture = { options, phase: 'starting' }
    this.activeCapture = capture
    const window = () => {
      /* 世代守卫：host-gone/dispose 清态后，旧调用的每一步都必须失效，
         不能碰到后续新 capture 的窗口或状态。 */
      if (this.disposed || this.activeCapture !== capture || !this.hostWindow) {
        throw new Error('audio host capture superseded or disposed')
      }
      return this.hostWindow
    }
    try {
      this.setupPartition()
      this.registerIpc()
      this.hostWindow = this.createHostWindow()
      await withTimeout(window().loadFile(path.join(__dirname, 'host.html')), LOAD_TIMEOUT_MS, 'audio host page load')
      window().webContents.postMessage(CHANNELS.PCM_PORT, { sessionId: options.sessionId }, [port])
      const invocation = {
        sessionId: options.sessionId,
        sourceIds: options.sourceIds,
        maxQueueMs: options.maxQueueMs
      }
      const evidence = await withTimeout(
        window().webContents.executeJavaScript(
          `globalThis.startAudioCapture(${JSON.stringify(invocation)})`, true),
        15000,
        'audio host capture start')
      window()
      capture.phase = 'capturing'
      this.record('capture-started', { sourceIds: options.sourceIds })
      return evidence
    } catch (error) {
      if (this.activeCapture === capture) {
        this.activeCapture = null
        this.destroyHostWindow()
      }
      throw error
    }
  }

  /** 停止连续采集：flush worklet、上报最终指标、销毁宿主窗。 */
  async stopCapture () {
    const active = this.activeCapture
    if (!active) return { stopped: false }
    const win = this.hostWindow
    try {
      if (!win || win.isDestroyed()) return { stopped: false }
      return await withTimeout(
        win.webContents.executeJavaScript('globalThis.stopAudioCapture()', true),
        8000,
        'audio host capture stop')
    } finally {
      /* 只清理自己那一代的状态与窗口——host-gone 后的新 capture 不受影响。 */
      if (this.activeCapture === active) this.activeCapture = null
      if (this.hostWindow === win) this.destroyHostWindow()
    }
  }

  /**
   * 采集中途更换消费端端口（worker 重建后）。宿主 renderer 关闭旧端口、
   * 作废旧 credit；队列中的帧在新消费端授信后继续流动。
   */
  replacePort (port) {
    if (!this.activeCapture || !this.hostWindow || this.hostWindow.isDestroyed()) {
      throw new Error('no active capture to replace the port for')
    }
    /* starting 阶段禁止替换：初始端口尚未送达/attach，先后顺序无法保证，
       可能出现「替换端口先到、原端口后到反而当成最新」的错乱。 */
    if (this.activeCapture.phase !== 'capturing') {
      throw new Error('cannot replace the port before capture start completes')
    }
    if (!port || typeof port.postMessage !== 'function') throw new TypeError('a MessagePortMain is required')
    this.hostWindow.webContents.postMessage(CHANNELS.PCM_PORT, { sessionId: this.activeCapture.options.sessionId }, [port])
    this.record('pcm-port-replaced', null)
  }

  destroyHostWindow () {
    if (this.hostWindow && !this.hostWindow.isDestroyed()) this.hostWindow.destroy()
    this.hostWindow = null
  }

  dispose () {
    if (this.disposed) return
    this.disposed = true
    const active = this.activeDiagnostic
    if (active) active.reject(new Error('audio host controller disposed'))
    this.activeDiagnostic = null
    this.activeCapture = null
    this.controlListeners.clear()
    this.destroyHostWindow()
    if (this.ipcRegistered) {
      this.electron.ipcMain.removeHandler(CHANNELS.SAVE_DIAGNOSTIC)
      this.electron.ipcMain.removeAllListeners(CHANNELS.MARK)
      this.electron.ipcMain.removeAllListeners(CHANNELS.CONTROL)
      this.ipcRegistered = false
    }
  }
}

module.exports = { AudioHostController, coerceSamples, withTimeout }
