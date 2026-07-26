'use strict'

// @ts-check

/* 隐藏音频宿主的主进程控制器（B2.1）。
   职责：非持久化 session、最小权限 handler、display-media 处理、宿主窗
   生命周期，以及有界诊断采集的编排与落盘。
   非职责（后续阶段）：连续 MessagePort PCM 直通（B2.2）、崩溃自动重启
   策略、与 SessionCoordinator 的运行时接线。
   拓扑严格沿用 Gate 0C 批准版本（docs/validation/gate-0c.md）。 */

const fs = require('node:fs')
const path = require('node:path')
const CHANNELS = require('./channels')
const {
  evaluateDisplayRequest,
  isPermissionAllowed,
  publicError,
  sanitizeOrigin,
  scrubLocalPaths,
  selectScreenSource,
  validateDiagnosticOptions
} = require('./policy')
const {
  analyzeLevels,
  encodePcm16Wav,
  evaluateDiagnostic,
  sha256
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
    this.disposed = false
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
    const entry = { pipeline: payload.pipeline, levels, checks, artifact: null }
    if (active.dumpDir) {
      const wav = encodePcm16Wav(samples, payload.pipeline.outputSampleRate)
      const fileName = `${sourceId}.wav`
      fs.writeFileSync(path.join(active.dumpDir, fileName), wav)
      entry.artifact = { file: fileName, bytes: wav.length, sha256: sha256(wav) }
    }
    active.saved[sourceId] = entry
    this.record('diagnostic-saved', { sourceId, pass: checks.pass })
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
    })
    return win
  }

  /**
   * 有界诊断采集：创建宿主窗 → user-gesture 触发采集 → 指标与可选 WAV
   * 落盘 → 销毁宿主窗。一次只允许一个诊断在跑。
   */
  async runDiagnosticCapture (rawOptions = {}) {
    if (this.disposed) throw new Error('audio host controller is disposed')
    if (this.activeDiagnostic) throw new Error('a diagnostic capture is already running')
    const options = validateDiagnosticOptions(rawOptions)
    const dumpDir = rawOptions.dumpDir ? path.resolve(String(rawOptions.dumpDir)) : null
    if (dumpDir) fs.mkdirSync(dumpDir, { recursive: true })

    let rejectDiagnostic
    const aborted = new Promise((_resolve, reject) => { rejectDiagnostic = reject })
    /* reject 可能在 loadFile 期间（Promise.race 挂上 handler 之前）就被
       render-process-gone 或 dispose 触发；先挂空 catch 防 unhandledRejection，
       race 消费的是原 promise，语义不变。 */
    aborted.catch(() => {})
    this.activeDiagnostic = { options, dumpDir, saved: {}, reject: rejectDiagnostic }
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
    this.destroyHostWindow()
    if (this.ipcRegistered) {
      this.electron.ipcMain.removeHandler(CHANNELS.SAVE_DIAGNOSTIC)
      this.electron.ipcMain.removeAllListeners(CHANNELS.MARK)
      this.ipcRegistered = false
    }
  }
}

module.exports = { AudioHostController, coerceSamples, withTimeout }
