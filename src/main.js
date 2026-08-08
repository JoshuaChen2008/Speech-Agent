'use strict'

const {
  app,
  BrowserWindow,
  dialog,
  globalShortcut,
  ipcMain,
  nativeTheme,
  powerMonitor,
  screen
} = require('electron')
const path = require('node:path')
const config = require('./config')
const CHANNELS = require('./main/ipc/channels')
const {
  assertRendererConfigPatch,
  changesCaptureConfiguration,
  isRoleAllowed
} = require('./main/ipc/access-policy')
const { resolveRuntimeOptions } = require('./main/runtime-options')
const { FakeRuntimeAdapter } = require('./main/session/fake-runtime-adapter')
const { RealtimeRuntimeAdapter } = require('./runtime/realtime-runtime-adapter')
const { SessionCoordinator, failure, success } = require('./main/session/session-coordinator')
const {
  DEFAULT_MODEL_SHUTDOWN_TIMEOUT_MS,
  ModelManager
} = require('./main/services/model-manager')
const {
  activateApprovedRuntime,
  allowsExternalModelResources,
  createApprovedRuntimeDefinition,
  isExternalArtifactReady
} = require('./main/services/model-runtime')
const {
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  SubtitleApplicationRuntime
} = require('./main/services/subtitle-application-runtime')
const { HistoryService } = require('./main/services/history-service')
const { RefinementFaultLog } = require('./main/services/refinement-fault-log')
const { RefinementNoticeStore } = require('./main/services/refinement-notice')
const { createMainEvidenceBridge } = require('./main/services/electron-exit-evidence')
const { PowerSessionGuard } = require('./main/services/power-session-guard')
const {
  ToolbarLayoutState,
  WINDOW_LAYOUT,
  toolbarDockBoundsFor
} = require('./main/window-layout-contract')
const { WindowLayerController } = require('./main/window-layer-controller')
const {
  ManualWindowInteractionController,
  sameBounds
} = require('./main/manual-window-interaction-controller')
const { loadRendererFailClosed } = require('./main/renderer-entry')

const exitEvidence = createMainEvidenceBridge()
exitEvidence.markLifecycle('main-started')

/** @type {SubtitleApplicationRuntime | null} */ let applicationRuntime = null
/** @type {ModelManager | null} */ let modelManager = null

/** @type {BrowserWindow | null} */ let captionWin = null
/** @type {BrowserWindow | null} */ let toolbarWin = null
/** @type {BrowserWindow | null} */ let settingsWin = null
/** @type {BrowserWindow | null} */ let historyWin = null
/** @type {SessionCoordinator | null} */ let coordinator = null
/** @type {HistoryService | null} */ let historyService = null
/** @type {PowerSessionGuard | null} */ let powerSessionGuard = null
/** @type {RefinementFaultLog | null} */ let refinementFaultLog = null

let quitBarrierComplete = false
let quitBarrierPromise = null
let quitRequested = false
let refinementPreferenceFallbackNotice = false
const refinementNoticeStore = new RefinementNoticeStore({
  onListenerError: () => console.error('[refinement.notice] listener failed')
})

const windowRoles = new Map()
let locked = false
const toolbarLayoutState = new ToolbarLayoutState()
const windowLayerController = new WindowLayerController({
  getCaptionWindow: () => captionWin,
  getToolbarWindow: () => toolbarWin,
  onFault: ({ role, code }) => console.error(`[window.layer] role=${role} code=${code}`)
})

const CAP_W = 920
const CAP_H = 190
const CAP_LIMITS = Object.freeze({ minW: 480, maxW: 1600, minH: 140, maxH: 420 })
const TB_W = WINDOW_LAYOUT.toolbarViewportWidth
const TB_H = WINDOW_LAYOUT.toolbarViewportHeight
const windowInteractionController = new ManualWindowInteractionController({
  getCursorScreenPoint: () => screen.getCursorScreenPoint(),
  getCaptionWindow: () => captionWin,
  getLocked: () => locked,
  getCaptionLimits: captionLimits,
  dock,
  onCaptionResizeEnd: persistCaptionBounds
})
const CHILD_SERVICE_LABELS = Object.freeze([
  'Speech Agent realtime ASR',
  'Speech Agent offline refinement',
  'Speech Agent subtitle storage'
])
const CHILD_PROCESS_TYPES = Object.freeze([
  'Utility',
  'Zygote',
  'Sandbox helper',
  'GPU',
  'Pepper Plugin',
  'Pepper Plugin Broker',
  'Unknown'
])
const CHILD_PROCESS_REASONS = Object.freeze([
  'clean-exit',
  'abnormal-exit',
  'killed',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
  'memory-eviction'
])

const runtimeEvidenceOptions = Object.freeze({
  registerAudioHostWebContents: (webContents) => exitEvidence.registerWebContents(webContents, 'audio-host'),
  onAudioHostRenderProcessGone: (webContents, details) => exitEvidence.recordRenderProcessGone(webContents, details),
  onAudioHostPreloadError: (webContents) => exitEvidence.recordPreloadError(webContents),
  onAudioHostUnresponsive: (webContents) => exitEvidence.recordUnresponsive(webContents),
  onRealtimeUtilityFatal: () => exitEvidence.recordUtilityFatal('realtime'),
  onRefineUtilityFatal: () => exitEvidence.recordUtilityFatal('refine')
})

function logError (scope, error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[${scope}] ${message}`)
}

function preloadPath (role) {
  return path.join(__dirname, 'preload', `${role}.js`)
}

function payload () {
  return {
    ...config.get(),
    systemDark: nativeTheme.shouldUseDarkColors,
    refinementPreferenceFallback: refinementPreferenceFallbackNotice
  }
}

function send (win, channel, value) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, value)
}

function publishToolbarOverlap (overlap = toolbarLayoutState.getOverlap()) {
  send(captionWin, CHANNELS.CAPTION_LAYOUT_TOOLBAR_OVERLAP, overlap)
}

function invalidateToolbarOverlap () {
  const overlap = toolbarLayoutState.invalidate()
  publishToolbarOverlap(overlap)
  return overlap
}

function broadcastConfig () {
  const value = payload()
  for (const win of [captionWin, toolbarWin, settingsWin, historyWin]) send(win, CHANNELS.CONFIG_CHANGED, value)
}

function diagnosticLabel (value, allowlist) {
  return typeof value === 'string' && allowlist.includes(value) ? value : 'other'
}

function broadcastSnapshot (snapshot) {
  for (const win of [toolbarWin, settingsWin]) send(win, CHANNELS.RUNTIME_CHANGED, snapshot)
}

function broadcastModelStatus (status) {
  send(settingsWin, CHANNELS.MODEL_STATUS_CHANGED, status)
}

function broadcastRefinementNotice (notice) {
  send(toolbarWin, CHANNELS.REFINEMENT_NOTICE_CHANGED, notice)
}

refinementNoticeStore.onChanged(broadcastRefinementNotice)

function registerWindowRole (win, role) {
  const senderId = win.webContents.id
  const unregisterExitEvidence = exitEvidence.registerWebContents(win.webContents, role)
  windowRoles.set(senderId, role)
  win.webContents.once('destroyed', () => {
    unregisterExitEvidence()
    windowRoles.delete(senderId)
    windowInteractionController.stopForSender(senderId)
    if (role === 'toolbar') invalidateToolbarOverlap()
  })
  win.on('blur', () => {
    windowInteractionController.stopForSender(senderId)
  })
  win.on('unresponsive', () => {
    exitEvidence.recordUnresponsive(win.webContents)
    console.error(`[electron.window] role=${role} event=unresponsive`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    if (role === 'toolbar') invalidateToolbarOverlap()
    exitEvidence.recordRenderProcessGone(win.webContents, details)
    console.error(`[electron.renderer] role=${role} reason=${details.reason} exitCode=${details.exitCode}`)
  })
  if (role === 'toolbar') {
    win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) invalidateToolbarOverlap()
    })
  }
  win.webContents.on('preload-error', () => exitEvidence.recordPreloadError(win.webContents))
  win.webContents.on('did-fail-load', (_event, errorCode, _description, _url, isMainFrame) => {
    if (isMainFrame) console.error(`[electron.load] role=${role} errorCode=${errorCode}`)
  })
}

function hardenContents (win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
}

function requireSender (event, channel) {
  const role = windowRoles.get(event.sender.id)
  const win = BrowserWindow.fromWebContents(event.sender)
  const isMainFrame = event.senderFrame && event.senderFrame === event.sender.mainFrame
  if (!win || win.isDestroyed() || !isMainFrame || !isRoleAllowed(channel, role)) {
    throw new Error(`IPC denied for ${role || 'unknown'} on ${channel}`)
  }
  return { role, win, senderId: event.sender.id }
}

function makeOverlay (role, width, height, x, y, focusable = true) {
  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable,
    show: false,
    webPreferences: {
      preload: preloadPath(role),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  registerWindowRole(win, role)
  hardenContents(win)
  if (role === 'caption' || role === 'toolbar') {
    const pinZoom = () => {
      if (!win.isDestroyed()) win.webContents.setZoomFactor(1)
    }
    pinZoom()
    win.webContents.on('did-finish-load', pinZoom)
    win.webContents.on('zoom-changed', (event) => {
      event.preventDefault()
      pinZoom()
    })
  }
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  void loadRendererFailClosed(win, role, { isPackaged: app.isPackaged })
    .catch((error) => {
      logError(`renderer.${role}.load`, error)
      app.quit()
    })
  return win
}

function clamp (value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

function captionLimits (win) {
  const display = win && !win.isDestroyed()
    ? screen.getDisplayMatching(win.getBounds())
    : screen.getPrimaryDisplay()
  const area = display.workAreaSize
  return {
    minW: CAP_LIMITS.minW,
    maxW: Math.min(CAP_LIMITS.maxW, area.width),
    minH: CAP_LIMITS.minH,
    maxH: Math.min(CAP_LIMITS.maxH, area.height)
  }
}

function createWindows () {
  const { workAreaSize } = screen.getPrimaryDisplay()
  const saved = config.get()
  const capW = clamp(saved.captionWidth, CAP_LIMITS.minW, Math.min(CAP_LIMITS.maxW, workAreaSize.width))
  const capH = clamp(saved.captionHeight, CAP_LIMITS.minH, Math.min(CAP_LIMITS.maxH, workAreaSize.height))
  const cx = Math.round((workAreaSize.width - capW) / 2)
  const cy = 72

  captionWin = makeOverlay('caption', capW, capH, cx, cy, false)
  captionWin.setResizable(true)
  toolbarWin = makeOverlay('toolbar', TB_W, TB_H, cx, cy, true)

  captionWin.webContents.on('console-message', (details) => console.log('[caption]', details.message))
  toolbarWin.webContents.on('console-message', (details) => console.log('[toolbar]', details.message))
  captionWin.webContents.on('did-finish-load', () => publishToolbarOverlap())

  const restoreWindowStack = () => windowLayerController.restoreWindowStack()
  captionWin.once('ready-to-show', () => { captionWin.show(); restoreWindowStack() })
  toolbarWin.once('ready-to-show', () => { toolbarWin.show(); dock() })
  setTimeout(restoreWindowStack, 300)

  captionWin.on('closed', () => { windowInteractionController.stopAll(); captionWin = null })
  toolbarWin.on('closed', () => { windowInteractionController.stopAll(); toolbarWin = null })
}

function dock ({ restoreStack = true } = {}) {
  if (!captionWin || captionWin.isDestroyed() || !toolbarWin || toolbarWin.isDestroyed()) return
  const nextBounds = toolbarDockBoundsFor(captionWin.getBounds())
  if (!sameBounds(toolbarWin.getBounds(), nextBounds)) toolbarWin.setBounds(nextBounds)
  if (restoreStack) windowLayerController.restoreWindowStack()
}

function openSettingsWindow (initialPane = null) {
  if (settingsWin && !settingsWin.isDestroyed()) {
    if (settingsWin.isMinimized()) settingsWin.restore()
    settingsWin.show()
    settingsWin.focus()
    if (initialPane) send(settingsWin, CHANNELS.SETTINGS_NAVIGATE, initialPane)
    return
  }
  settingsWin = new BrowserWindow({
    width: 880,
    height: 620,
    titleBarStyle: 'hidden',
    backgroundMaterial: 'acrylic',
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    skipTaskbar: false,
    show: false,
    webPreferences: {
      preload: preloadPath('settings'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  registerWindowRole(settingsWin, 'settings')
  windowLayerController.bindForegroundWindow(settingsWin, 'settings')
  hardenContents(settingsWin)
  settingsWin.webContents.on('console-message', (details) => console.log('[settings]', details.message))
  settingsWin.once('ready-to-show', () => {
    settingsWin.show()
    settingsWin.focus()
    if (initialPane) send(settingsWin, CHANNELS.SETTINGS_NAVIGATE, initialPane)
  })
  settingsWin.on('closed', () => { windowInteractionController.stopAll(); settingsWin = null })
  void loadRendererFailClosed(settingsWin, 'settings', { isPackaged: app.isPackaged })
    .catch((error) => logError('renderer.settings.load', error))
}

function openHistoryWindow () {
  if (!historyService) return
  if (historyWin && !historyWin.isDestroyed()) {
    if (historyWin.isMinimized()) historyWin.restore()
    historyWin.show()
    historyWin.focus()
    return
  }
  historyWin = new BrowserWindow({
    width: 1060,
    height: 720,
    minWidth: 780,
    minHeight: 520,
    titleBarStyle: 'hidden',
    backgroundMaterial: 'acrylic',
    backgroundColor: '#00000000',
    resizable: true,
    maximizable: true,
    minimizable: true,
    skipTaskbar: false,
    show: false,
    webPreferences: {
      preload: preloadPath('history'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  registerWindowRole(historyWin, 'history')
  windowLayerController.bindForegroundWindow(historyWin, 'history')
  hardenContents(historyWin)
  historyWin.webContents.on('console-message', (details) => console.log('[history]', details.message))
  historyWin.once('ready-to-show', () => {
    historyWin.show()
    historyWin.focus()
  })
  historyWin.on('closed', () => { windowInteractionController.stopAll(); historyWin = null })
  void loadRendererFailClosed(historyWin, 'history', { isPackaged: app.isPackaged })
    .catch((error) => logError('renderer.history.load', error))
}

function persistCaptionBounds (bounds) {
  try {
    config.set({ captionWidth: bounds.width, captionHeight: bounds.height })
    broadcastConfig()
  } catch (error) {
    logError('config.resize', error)
  }
}

function applyLock (on) {
  locked = on
  if (on) windowInteractionController.stopAll()
  if (captionWin && !captionWin.isDestroyed()) {
    if (on) captionWin.setIgnoreMouseEvents(true, { forward: true })
    send(captionWin, CHANNELS.LOCK_CHANGED, on)
  }
  send(toolbarWin, CHANNELS.LOCK_CHANGED, on)
  if (!on) dock()
}

function createCoordinator (persistenceSink) {
  const devOptions = resolveRuntimeOptions(process.env, { packaged: app.isPackaged })
  if (devOptions.warning) console.warn(`[runtime] ${devOptions.warning}`)
  /* I2.1 结构模式（显式 dev 开关，默认关闭）：真实采集窗 + realtime worker，
     recognizer 为 null——状态机/背压/恢复全真，但不产任何字幕文本。
     仍需 LIVE_SUBTITLE_DEV_MODEL 才能 start。 */
  const structuralRuntime = !app.isPackaged && process.env.LIVE_SUBTITLE_DEV_RUNTIME === 'structural'
  if (structuralRuntime) {
    console.warn('[runtime] structural runtime enabled: real capture and worker, null recognizer, no captions')
  }
  /* 产品能力只在 ModelManager 审计核心字幕模型资源包后开启。仓库模型和显式
     env 路径只有在 LIVE_SUBTITLE_ALLOW_EXTERNAL_MODELS=1 时才通过
     externalReady 开发缝进入；普通 npm start 与打包应用都必须依赖 userData
     中清单匹配的 ready marker，不能被工作区模型悄悄遮蔽下载入口。 */
  const managerReady = modelManager?.isCoreReady() === true
  const approvedRuntime = (!devOptions.modelOverride && !structuralRuntime && managerReady)
    ? createApprovedRuntimeDefinition({
        userDataDir: app.getPath('userData'),
        allowExternal: allowsExternalModelResources(process.env, { packaged: app.isPackaged }),
        ...runtimeEvidenceOptions
      })
    : null
  let adapterFactory
  let runtimeOptions = devOptions
  let transitionTimeoutMs
  if (approvedRuntime) {
    console.log('[runtime] approved local core subtitle model bundle ready')
    adapterFactory = approvedRuntime.adapterFactory
    runtimeOptions = approvedRuntime.runtimeOptions
    transitionTimeoutMs = approvedRuntime.transitionTimeoutMs
  } else {
    if (managerReady && !devOptions.modelOverride && !structuralRuntime) {
      console.error('[runtime] model manager reported core ready but runtime bundle could not be resolved')
    }
    adapterFactory = () => structuralRuntime
      ? new RealtimeRuntimeAdapter(runtimeEvidenceOptions)
      : new FakeRuntimeAdapter()
  }
  const created = new SessionCoordinator({
    adapterFactory,
    runtimeOptions,
    transitionTimeoutMs,
    configuration: config.get(),
    persistenceSink,
    onListenerError: (error) => logError('runtime.listener', error)
  })
  created.onSnapshot(broadcastSnapshot)
  created.onCaption((event) => send(captionWin, CHANNELS.CAPTION_EVENT, event))
  created.onCaptionState((state) => send(captionWin, CHANNELS.CAPTION_STATE_CHANGED, state))
  created.onRefinementFault((fault) => {
    if (!refinementFaultLog) return
    void refinementFaultLog.record({
      code: fault.code,
      stage: fault.stage,
      faultAtMs: fault.faultAtMs
    }).catch(() => console.error('[refinement.fault-log] write failed'))
  })
  return created
}

async function updateConfig (patch) {
  try {
    assertRendererConfigPatch(patch)
    if (changesCaptureConfiguration(patch) && coordinator.getSnapshot().sessionId !== null) {
      return failure('SESSION_ACTIVE', '请先停止当前会话', true)
    }
    const next = { ...config.get(), ...patch }
    coordinator.validateConfiguration(next)
    config.set(patch)
    coordinator.updateConfiguration(config.get())
    broadcastConfig()
    return success()
  } catch (error) {
    logError('config.update', error)
    return failure('INVALID_CONFIG', '设置未保存', true)
  }
}

async function selectPreset (preset) {
  try {
    if (coordinator.getSnapshot().sessionId !== null) {
      return failure('SESSION_ACTIVE', '请先停止当前会话', true)
    }
    config.applyPreset(preset)
    coordinator.updateConfiguration(config.get())
    broadcastConfig()
    return success()
  } catch (error) {
    logError('preset.select', error)
    return failure('INVALID_PRESET', '场景未保存', true)
  }
}

function publicModelError (error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code)
    ? error.code
    : 'MODEL_INSTALL_FAILED'
  const messages = {
    ABORTED: '模型安装已停止',
    ARCHIVE_UNSAFE: '模型资源包无法安全安装',
    DOWNLOAD_FAILED: '模型下载失败',
    DOWNLOAD_HASH_MISMATCH: '模型校验失败',
    DOWNLOAD_HOST_BLOCKED: '模型下载来源不受信任',
    DOWNLOAD_SIZE_MISMATCH: '模型下载大小不符',
    INSTALL_FAILED: '模型安装失败',
    INVALID_MANIFEST: '模型资源清单无效',
    MODEL_FILES_MISSING: '模型文件不完整',
    MODEL_RUNTIME_UNAVAILABLE: '模型已安装但字幕运行时未就绪',
    REFINEMENT_MODEL_NOT_READY: '请先下载精修模型',
    MODEL_INSTALL_NOT_ACTIVE: '当前没有可取消的模型下载',
    SESSION_ACTIVE: '请先停止当前字幕会话',
    SHUTDOWN: '模型管理服务已关闭',
    TOO_MANY_REDIRECTS: '模型下载重定向过多'
  }
  return { code, message: messages[code] || '模型资源暂时不可用' }
}

async function installModelResourceGroup (install) {
  if (!modelManager || !coordinator) {
    return { ok: false, error: publicModelError({ code: 'MODEL_INSTALL_FAILED' }) }
  }
  if (coordinator.getSnapshot().sessionId !== null) {
    return { ok: false, error: publicModelError({ code: 'SESSION_ACTIVE' }) }
  }
  try {
    const status = await install()
    const devOptions = resolveRuntimeOptions(process.env, { packaged: app.isPackaged })
    const structuralRuntime = !app.isPackaged && process.env.LIVE_SUBTITLE_DEV_RUNTIME === 'structural'
    if (!devOptions.modelOverride && !structuralRuntime && modelManager.isCoreReady()) {
      activateApprovedRuntime({
        coordinator,
        userDataDir: app.getPath('userData'),
        allowExternal: allowsExternalModelResources(process.env, { packaged: app.isPackaged }),
        ...runtimeEvidenceOptions
      })
    }
    return { ok: true, value: status }
  } catch (error) {
    const safe = publicModelError(error)
    console.error(`[model.install] ${safe.code}`)
    return { ok: false, error: safe }
  }
}

async function installModelResources () {
  return installModelResourceGroup(() => modelManager.installCore())
}

async function installRefinementModelResources () {
  return installModelResourceGroup(() => modelManager.installRefinement())
}

function cancelModelInstall () {
  if (!modelManager || !coordinator) {
    return { ok: false, error: publicModelError({ code: 'MODEL_INSTALL_NOT_ACTIVE' }) }
  }
  if (coordinator.getSnapshot().sessionId !== null) {
    return { ok: false, error: publicModelError({ code: 'SESSION_ACTIVE' }) }
  }
  if (!modelManager.cancelInstall()) {
    return { ok: false, error: publicModelError({ code: 'MODEL_INSTALL_NOT_ACTIVE' }) }
  }
  return { ok: true, value: modelManager.getStatus() }
}

function setRefinementPreference (enabled) {
  if (typeof enabled !== 'boolean' || !modelManager || !coordinator) {
    return { ok: false, error: publicModelError({ code: 'REFINEMENT_MODEL_NOT_READY' }) }
  }
  try {
    const result = config.setRefinementPreference(enabled === true, modelManager.isRefinementReady())
    coordinator.updateConfiguration(config.get())
    if (!result.accepted) {
      broadcastConfig()
      return { ok: false, error: publicModelError({ code: result.reason }) }
    }
    refinementPreferenceFallbackNotice = false
    broadcastConfig()
    return { ok: true, value: payload() }
  } catch (error) {
    logError('refinement.preference', error)
    return { ok: false, error: publicModelError({ code: 'REFINEMENT_MODEL_NOT_READY' }) }
  }
}

ipcMain.on(CHANNELS.MOUSE_THROUGH, (event, ignore) => {
  const { win } = requireSender(event, CHANNELS.MOUSE_THROUGH)
  if (win === captionWin && locked && !ignore) return
  win.setIgnoreMouseEvents(!!ignore, { forward: true })
})
ipcMain.on(CHANNELS.DRAG_START, (event) => {
  const sender = requireSender(event, CHANNELS.DRAG_START)
  windowInteractionController.startDrag(sender)
})
ipcMain.on(CHANNELS.DRAG_END, (event) => {
  const { senderId } = requireSender(event, CHANNELS.DRAG_END)
  windowInteractionController.stopDrag(senderId)
})
ipcMain.on(CHANNELS.RESIZE_START, (event, edge) => {
  const { win, senderId } = requireSender(event, CHANNELS.RESIZE_START)
  windowInteractionController.startResize({ win, senderId, edge })
})
ipcMain.on(CHANNELS.RESIZE_END, (event) => {
  const { senderId } = requireSender(event, CHANNELS.RESIZE_END)
  windowInteractionController.stopResize(senderId)
})
ipcMain.on(CHANNELS.LOCK_TOGGLE, (event) => {
  requireSender(event, CHANNELS.LOCK_TOGGLE)
  applyLock(!locked)
})
ipcMain.handle(CHANNELS.LOCK_GET, (event) => {
  requireSender(event, CHANNELS.LOCK_GET)
  return locked
})
ipcMain.handle(CHANNELS.TOOLBAR_LAYOUT_GET_CONTEXT, (event) => {
  const { win } = requireSender(event, CHANNELS.TOOLBAR_LAYOUT_GET_CONTEXT)
  if (win !== toolbarWin) throw new Error('IPC denied for stale toolbar layout context')
  return toolbarLayoutState.getContext()
})
ipcMain.on(CHANNELS.TOOLBAR_LAYOUT_REPORT_RECT, (event, report) => {
  const { win } = requireSender(event, CHANNELS.TOOLBAR_LAYOUT_REPORT_RECT)
  if (win !== toolbarWin) throw new Error('IPC denied for stale toolbar layout report')
  publishToolbarOverlap(toolbarLayoutState.acceptReport(report))
})
ipcMain.on(CHANNELS.TOOLBAR_ACTION, (event, action) => {
  requireSender(event, CHANNELS.TOOLBAR_ACTION)
  if (action === 'settings') openSettingsWindow()
  else if (action === 'open-model-manager') openSettingsWindow('resources')
  else if (action === 'history') {
    refinementNoticeStore.clear()
    openHistoryWindow()
  } else if (action === 'dismiss-refinement-notice') refinementNoticeStore.clear()
  else if (action === 'close') app.quit()
})
ipcMain.on(CHANNELS.SETTINGS_CLOSE, (event) => {
  const { win } = requireSender(event, CHANNELS.SETTINGS_CLOSE)
  win.close()
})
ipcMain.on(CHANNELS.HISTORY_CLOSE, (event) => {
  const { win } = requireSender(event, CHANNELS.HISTORY_CLOSE)
  win.close()
})
ipcMain.handle(CHANNELS.CONFIG_GET, (event) => {
  requireSender(event, CHANNELS.CONFIG_GET)
  return payload()
})
ipcMain.handle(CHANNELS.CONFIG_UPDATE, (event, patch) => {
  requireSender(event, CHANNELS.CONFIG_UPDATE)
  return updateConfig(patch)
})
ipcMain.handle(CHANNELS.PRESET_SELECT, (event, preset) => {
  requireSender(event, CHANNELS.PRESET_SELECT)
  return selectPreset(preset)
})
ipcMain.handle(CHANNELS.RUNTIME_GET, (event) => {
  requireSender(event, CHANNELS.RUNTIME_GET)
  return coordinator.getSnapshot()
})
ipcMain.handle(CHANNELS.CAPTION_STATE_GET, (event) => {
  requireSender(event, CHANNELS.CAPTION_STATE_GET)
  return coordinator.getCaptionState()
})
ipcMain.handle(CHANNELS.CAPTION_VIEWPORT_EVICT, (event, report) => {
  requireSender(event, CHANNELS.CAPTION_VIEWPORT_EVICT)
  return coordinator.acceptCaptionViewportEviction(report)
})
ipcMain.handle(CHANNELS.REFINEMENT_NOTICE_GET, (event) => {
  requireSender(event, CHANNELS.REFINEMENT_NOTICE_GET)
  return refinementNoticeStore.get()
})

async function refreshPostSessionRefinementNotice (sessionId) {
  try {
    if (!historyService) return
    const page = await historyService.getSessionPage({ sessionId, limit: 1, cursor: null })
    refinementNoticeStore.setFromResult(sessionId, page.refinement)
  } catch {
    /* A status hint may never turn a successfully closed durable session into
       a command failure. Detailed facts remain available through history. */
    console.error('[refinement.notice] result unavailable')
  }
}

async function runRuntimeCommand (name) {
  const before = coordinator.getSnapshot()
  const operation = coordinator.command(name)
  if (name === 'start' && before.sessionId === null && coordinator.getSnapshot().sessionId !== null) {
    refinementNoticeStore.clear()
  }
  const result = await operation
  if (name === 'stop' && result.ok && before.sessionId !== null && before.phase !== 'error') {
    await refreshPostSessionRefinementNotice(before.sessionId)
  }
  return result
}

ipcMain.handle(CHANNELS.RUNTIME_COMMAND, async (event, name) => {
  requireSender(event, CHANNELS.RUNTIME_COMMAND)
  try {
    return await runRuntimeCommand(name)
  } catch (error) {
    logError('runtime.command', error)
    return failure('COMMAND_FAILED', '命令执行失败', true)
  }
})
ipcMain.handle(CHANNELS.MODEL_STATUS_GET, (event) => {
  requireSender(event, CHANNELS.MODEL_STATUS_GET)
  if (!modelManager) throw new Error('model manager is not ready')
  return modelManager.getStatus()
})
ipcMain.handle(CHANNELS.MODEL_INSTALL, (event) => {
  requireSender(event, CHANNELS.MODEL_INSTALL)
  return installModelResources()
})
ipcMain.handle(CHANNELS.MODEL_INSTALL_REFINEMENT, (event) => {
  requireSender(event, CHANNELS.MODEL_INSTALL_REFINEMENT)
  return installRefinementModelResources()
})
ipcMain.handle(CHANNELS.MODEL_CANCEL_INSTALL, (event) => {
  requireSender(event, CHANNELS.MODEL_CANCEL_INSTALL)
  return cancelModelInstall()
})
ipcMain.handle(CHANNELS.REFINEMENT_PREFERENCE_SET, (event, enabled) => {
  requireSender(event, CHANNELS.REFINEMENT_PREFERENCE_SET)
  return setRefinementPreference(enabled)
})

function publicHistoryError (error) {
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.code)
    ? error.code
    : 'HISTORY_UNAVAILABLE'
  const messages = {
    INVALID_HISTORY_REQUEST: '历史记录请求无效',
    INVALID_SESSION: '会话标识无效',
    INVALID_EXPORT_FORMAT: '不支持这种导出格式',
    SESSION_NOT_FOUND: '这条记录不存在或已移除',
    SESSION_ACTIVE: '活动会话尚未进入历史记录'
  }
  return { code, message: messages[code] || '历史记录暂时不可用' }
}

async function invokeHistory (scope, operation) {
  try {
    if (!historyService) throw new Error('history service is not ready')
    return { ok: true, value: await operation() }
  } catch (error) {
    const safe = publicHistoryError(error)
    console.error(`[history.${scope}] ${safe.code}`)
    return { ok: false, error: safe }
  }
}

ipcMain.handle(CHANNELS.HISTORY_LIST, (event, input) => {
  requireSender(event, CHANNELS.HISTORY_LIST)
  return invokeHistory('list', () => historyService.listSessions(input))
})
ipcMain.handle(CHANNELS.HISTORY_PAGE, (event, input) => {
  requireSender(event, CHANNELS.HISTORY_PAGE)
  return invokeHistory('page', () => historyService.getSessionPage(input))
})
ipcMain.handle(CHANNELS.HISTORY_EXPORT, (event, input) => {
  const { win } = requireSender(event, CHANNELS.HISTORY_EXPORT)
  return invokeHistory('export', () => historyService.exportSession(input, win))
})

nativeTheme.on('updated', broadcastConfig)

async function bootstrapApplication () {
  if (quitRequested) return false
  config.load()
  const userDataDir = app.getPath('userData')
  refinementFaultLog = new RefinementFaultLog({
    directory: path.join(userDataDir, 'logs', 'refinement')
  })
  const externalModelsAllowed = allowsExternalModelResources(process.env, { packaged: app.isPackaged })
  modelManager = new ModelManager({
    userDataDir,
    ...(externalModelsAllowed
      ? { externalReady: (artifactId) => isExternalArtifactReady(artifactId) }
      : {})
  })
  modelManager.onStatus(broadcastModelStatus)
  await modelManager.initialize()
  const refinementReadiness = config.reconcileRefinementReadiness(modelManager.isRefinementReady())
  refinementPreferenceFallbackNotice = refinementReadiness.changed
  if (refinementReadiness.changed) broadcastConfig()
  if (quitRequested) return false
  applicationRuntime = new SubtitleApplicationRuntime({
    userDataDir,
    coordinatorFactory: ({ persistenceSink }) => createCoordinator(persistenceSink),
    onError: (error) => logError('subtitle.storage', error),
    onStorageUtilityFatal: () => exitEvidence.recordUtilityFatal('storage')
  })
  const started = await applicationRuntime.start()
  if (quitRequested) return false
  coordinator = started.coordinator
  powerSessionGuard = new PowerSessionGuard({
    powerMonitor,
    getCoordinator: () => coordinator,
    onError: (error) => logError('power.session', error)
  })
  powerSessionGuard.start()
  historyService = new HistoryService({
    gateway: applicationRuntime.gateway,
    showSaveDialog: (ownerWindow, options) => ownerWindow
      ? dialog.showSaveDialog(ownerWindow, options)
      : dialog.showSaveDialog(options)
  })
  if (started.recoveryReport.recoveredSessionCount > 0) {
    console.warn(`[subtitle.storage] recovered ${started.recoveryReport.recoveredSessionCount} interrupted session`)
  }
  if (started.migrationReports.length > 0) {
    console.log(`[subtitle.storage] checked ${started.migrationReports.length} legacy transcript file(s)`)
  }
  createWindows()
  if (!config.get().onboardingCompleted) openSettingsWindow()

  globalShortcut.register('CommandOrControl+Alt+L', () => applyLock(!locked))
  return true
}

function cleanupUiRuntime () {
  globalShortcut.unregisterAll()
  windowInteractionController.stopAll()
  if (powerSessionGuard) {
    powerSessionGuard.stop()
    powerSessionGuard = null
  }
}

function beginQuitBarrier (event) {
  if (quitBarrierComplete) return
  quitRequested = true
  event.preventDefault()
  if (quitBarrierPromise) return
  exitEvidence.markLifecycle('quit-requested')
  cleanupUiRuntime()
  quitBarrierPromise = (async () => {
    const shutdownTasks = []
    if (modelManager) {
      shutdownTasks.push(modelManager.shutdownWithin(DEFAULT_MODEL_SHUTDOWN_TIMEOUT_MS).then((modelOutcome) => {
        if (!modelOutcome.graceful) {
          console.error(`[model.manager] forced shutdown (${modelOutcome.reason})`)
        }
      }))
    }
    if (applicationRuntime) {
      shutdownTasks.push(applicationRuntime.shutdownWithin(DEFAULT_SHUTDOWN_TIMEOUT_MS).then((outcome) => {
        if (!outcome.graceful) {
          console.error(`[subtitle.storage] forced shutdown (${outcome.reason})`)
        }
      }))
    } else if (coordinator) {
      shutdownTasks.push(coordinator.dispose())
    }
    if (refinementFaultLog) shutdownTasks.push(refinementFaultLog.close())
    const settlements = await Promise.allSettled(shutdownTasks)
    const failed = settlements.find((result) => result.status === 'rejected')
    if (failed) throw failed.reason
  })().then(() => {
    /* Only confirmed root termination may release Electron's before-quit
       barrier.  In particular, a failed exact-child reap must leave the app
       alive and prevent will-quit/main exit. */
    quitBarrierComplete = true
    app.quit()
  }).catch((error) => {
    logError('application.shutdown', error)
    quitBarrierPromise = null
  })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  quitRequested = true
  exitEvidence.markLifecycle('quit-requested')
  app.once('will-quit', () => exitEvidence.markLifecycle('will-quit'))
  app.quit()
} else {
  app.on('second-instance', () => {
    const primary = toolbarWin || captionWin
    if (!primary || primary.isDestroyed()) return
    if (primary.isMinimized()) primary.restore()
    primary.show()
    primary.focus()
  })
  app.on('child-process-gone', (_event, details) => {
    /* serviceName distinguishes our utilities; type distinguishes Chromium
       roles such as GPU. Every string is selected from a fixed allow-list,
       never scrubbed from an arbitrary Electron value, so a path-shaped name
       cannot survive as text fragments in the log. */
    exitEvidence.recordChildProcessGone(details)
    const service = diagnosticLabel(details.serviceName, CHILD_SERVICE_LABELS)
    const type = diagnosticLabel(details.type, CHILD_PROCESS_TYPES)
    const reason = diagnosticLabel(details.reason, CHILD_PROCESS_REASONS)
    const exitCode = Number.isInteger(details.exitCode) ? details.exitCode : 'unknown'
    console.error(`[electron.child] service=${service} type=${type} reason=${reason} exitCode=${exitCode}`)
  })
  app.on('before-quit', beginQuitBarrier)
  app.on('will-quit', () => {
    exitEvidence.markLifecycle('will-quit')
    cleanupUiRuntime()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && coordinator && !quitBarrierPromise) createWindows()
  })
  app.whenReady().then(async () => {
    exitEvidence.markLifecycle('app-ready')
    const bootstrapped = await bootstrapApplication()
    if (bootstrapped) exitEvidence.markLifecycle('bootstrap-complete')
  }).catch((error) => {
    if (quitRequested) return
    logError('application.startup', error)
    process.exitCode = 1
    app.quit()
  })
}
