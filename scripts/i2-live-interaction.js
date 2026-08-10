'use strict'

/*
 * Executable I2 interaction evidence.
 *
 * Unlike the baseline latency runner this script exercises recovery and UI
 * boundaries: the real AudioHostController, real model/VAD/refine utility
 * processes, SessionCoordinator and SqliteSessionRecorder are composed below.
 * It never writes captured PCM.  Caption text is held in memory only long
 * enough to count event kinds; neither stdout, progress nor report contains
 * it.  The DWM scenario is intentionally manual: it renders the product's
 * caption/toolbar assets in real transparent BrowserWindows and delegates the
 * visual drag observation to an external operator completion file. Device
 * removal and sleep/wake likewise wait for an external action, while product
 * state independently proves the fault, cleanup, explicit Retry and recovery.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { app, BrowserWindow, ipcMain, nativeTheme, powerMonitor, screen } = require('electron')
const CHANNELS = require('../src/main/ipc/channels')
const { isRoleAllowed } = require('../src/main/ipc/access-policy')
const { ManualWindowInteractionController } = require('../src/main/manual-window-interaction-controller')
const {
  ApplicationWindowLifecycleController,
  overlayWindowBehavior
} = require('../src/main/application-window-lifecycle-controller')
const {
  WindowInteractionGenerationController
} = require('../src/main/window-interaction-generation-controller')
const { isInteractionReadyIntent } = require('../src/contracts/window-interaction')
const { WindowLayerController } = require('../src/main/window-layer-controller')
const {
  ToolbarLayoutState,
  toolbarDockBoundsFor
} = require('../src/main/window-layout-contract')
const { computeProductPayloadIdentity } = require('../src/main/services/product-payload-identity')
const { DEFAULT_CONFIG } = require('../src/main/services/config-store')
const { SubtitleApplicationRuntime } = require('../src/main/services/subtitle-application-runtime')
const { PowerSessionGuard } = require('../src/main/services/power-session-guard')
const { SessionCoordinator } = require('../src/main/session/session-coordinator')
const { RealtimeRuntimeAdapter } = require('../src/runtime/realtime-runtime-adapter')
const { RealtimeWorkerHost } = require('../src/runtime/realtime-worker/worker-host')
const {
  resolveApprovedRealtimeModel,
  resolveApprovedRefinementModel,
  resolveSileroVadModel
} = require('../src/main/services/model-resolver')
const {
  SCENARIOS,
  RECOVERY_FAULT_CODES,
  RECOVERY_SCENARIOS,
  TRANSPORT_FIELDS,
  buildDwmProgress,
  buildInteractionReport,
  buildRecoveryProgress,
  parseArguments,
  parseOperatorCompletion,
  parseRecoveryOperatorCompletion,
  transportDelta,
  transportSnapshot,
  validateDwmProgress,
  validateInteractionReport
} = require('./i2-interaction-protocol')
const {
  WAV_PATH,
  playWave,
  readPcm16MonoWav,
  readPhysicalMicPreflight
} = require('./i2-live-caption-smoke')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const ARTIFACT_ROOT = path.join(PROJECT_ROOT, '.artifacts')
/* A short, existing controlled corpus for the event-driven pause/refine
 * smoke.  The runner waits for a real final rather than assuming its time,
 * but a ~3.9 s utterance makes the interactive acceptance loop practical. */
const PAUSE_REFINE_WAV_PATH = path.join(PROJECT_ROOT, 'models', 'gate-0b', 'corpus', 'zh-roadmap.wav')
/* The corpus is intentionally not assumed to have a final by a wall-clock
 * offset.  Pause only after the real worker has both emitted a final and
 * reported its matching refine request as pending. */
const PAUSE_AWAIT_FIRST_FINAL_MS = 20000
const PAUSE_AWAIT_REFINE_PENDING_MS = 5000
const PAUSE_REFINE_RESPONSE_DELAY_MS = 1200
const PAUSE_SETTLE_MS = 2600
const FINAL_SETTLE_MS = 3200
const LIVE_METRICS_SETTLE_MS = 700
const NO_AUTO_REACQUIRE_OBSERVATION_MS = 1500
const RECOVERY_CAPTURE_RELEASE_TIMEOUT_MS = 30000

function delay (milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function workspaceArtifactPath (input, label) {
  if (typeof input !== 'string' || input.trim().length === 0) throw new TypeError(`${label} must be a non-empty path`)
  const resolved = path.resolve(PROJECT_ROOT, input)
  const prefix = ARTIFACT_ROOT + path.sep
  if (!resolved.toLowerCase().startsWith(prefix.toLowerCase())) throw new Error(`${label} must stay under .artifacts`)
  return resolved
}

function workspaceReadPath (input, label) {
  if (typeof input !== 'string' || input.trim().length === 0) throw new TypeError(`${label} must be a non-empty path`)
  const resolved = path.resolve(PROJECT_ROOT, input)
  const prefix = PROJECT_ROOT + path.sep
  if (!resolved.toLowerCase().startsWith(prefix.toLowerCase())) throw new Error(`${label} must stay inside the workspace`)
  return resolved
}

function assertDistinctOutputPaths (paths) {
  const normalized = paths.filter(Boolean).map((filePath) => filePath.toLowerCase())
  if (new Set(normalized).size !== normalized.length) {
    throw new Error('report, progress, and completion paths must be distinct')
  }
}

function stimulusPathForScenario (scenario) {
  return scenario === 'pause-refine' ? PAUSE_REFINE_WAV_PATH : WAV_PATH
}

function writeAtomicJson (filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  fs.renameSync(temporary, filePath)
}

function blankTransport () {
  return Object.fromEntries(TRANSPORT_FIELDS.map((field) => [field, null]))
}

function cleanTransport (transport) {
  return transport.capturedFrames !== null && transport.capturedFrames > 0 &&
    transport.sentFrames !== null &&
    ['droppedFrames', 'lostInFlightFrames', 'sequenceGapCount', 'missedFrames', 'badSampleTypeFrames', 'droppedCaptionCount']
      .every((field) => transport[field] === 0)
}

async function readLiveTransport (adapter, sourceId) {
  if (!adapter || typeof adapter.getLiveDiagnostics !== 'function') {
    throw new Error('active runtime adapter diagnostics are unavailable')
  }
  const worker = adapter.session?.worker
  if (worker && typeof worker.requestStats === 'function') worker.requestStats()
  await delay(LIVE_METRICS_SETTLE_MS)
  const diagnostics = adapter.getLiveDiagnostics()
  if (!diagnostics) throw new Error('active runtime adapter produced no live diagnostics')
  return transportSnapshot(diagnostics, sourceId)
}

async function waitUntil (predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (predicate()) return true
    await delay(100)
  }
  throw new Error(`${label} timed out`)
}

async function waitForPendingRefinement (adapter) {
  const worker = adapter?.session?.worker
  if (!worker || typeof worker.requestStats !== 'function') {
    throw new Error('active realtime worker cannot report refinement state')
  }
  const deadline = Date.now() + PAUSE_AWAIT_REFINE_PENDING_MS
  while (Date.now() <= deadline) {
    worker.requestStats()
    await delay(100)
    const pending = worker.lastStats?.refine?.pending
    if (Number.isSafeInteger(pending) && pending > 0) return pending
  }
  throw new Error('real refinement request did not become pending before pause')
}

function stoppedTransport (adapter, sourceId, sessionId) {
  if (!adapter || typeof adapter.getLastRunDiagnostics !== 'function') {
    throw new Error('stopped runtime adapter diagnostics are unavailable')
  }
  const diagnostics = adapter.getLastRunDiagnostics()
  if (!diagnostics || diagnostics.sessionId !== sessionId) {
    throw new Error('stopped runtime diagnostics do not belong to the active session')
  }
  return transportSnapshot(diagnostics, sourceId)
}

function controlledPlaybackOptions (options, physicalPreflight) {
  if (options.source === 'loopback') return { outputMode: 'default', expectedOutputLabelSha256: null }
  return {
    outputMode: 'physical-speaker',
    expectedOutputLabelSha256: physicalPreflight.speakerLabelSha256
  }
}

function createRuntimeComposition ({ options, userDataPath, model, vad, refinement, physicalPreflight, workers }) {
  let adapter = null
  const configuration = options.source === 'loopback'
    ? { onboardingCompleted: true, onboardingPreset: 'meeting', mic: false, loopback: true }
    : { onboardingCompleted: true, onboardingPreset: 'dictation', mic: true, loopback: false }
  const applicationRuntime = new SubtitleApplicationRuntime({
    userDataDir: userDataPath,
    coordinatorFactory: ({ persistenceSink }) => new SessionCoordinator({
      adapterFactory: () => {
        adapter = new RealtimeRuntimeAdapter({
          profileMap: { [model.profile]: model.id },
          micLabelSha256: physicalPreflight?.micLabelSha256 || null,
          recognizer: { kind: model.kind, modelDir: model.modelDir, numThreads: model.numThreads, modelType: model.modelType },
          vad,
          refinement: { kind: refinement.kind, modelDir: refinement.modelDir, numThreads: refinement.numThreads },
          acceptanceRefineResponseDelayMs: options.scenario === 'pause-refine'
            ? PAUSE_REFINE_RESPONSE_DELAY_MS
            : null,
          workerFactory: () => {
            const worker = new RealtimeWorkerHost()
            workers.push(worker)
            return worker
          }
        })
        return adapter
      },
      persistenceSink,
      runtimeOptions: {
        modelOverride: { id: model.id, profile: model.profile, developmentOnly: false },
        refinementAvailable: true
      },
      transitionTimeoutMs: 30000,
      configuration,
      idFactory: () => `i2-interaction-${Date.now()}`
    })
  })
  return { applicationRuntime, getAdapter: () => adapter }
}

class DwmDragHarness {
  constructor ({ coordinator }) {
    this.coordinator = coordinator
    this.roles = new Map()
    this.captionWindow = null
    this.toolbarWindow = null
    this.settingsWindow = null
    this.historyWindow = null
    this.windows = new Map()
    this.locked = false
    this.disposed = false
    this.disposers = []
    this.unsubscribeSnapshot = null
    this.unsubscribeCaption = null
    this.scalePoll = null
    this.visitedScalePercents = new Set()
    this.layoutState = new ToolbarLayoutState()
    this.pendingPointerHitRefreshRoles = new Set()
    this.pointerHitRefreshScheduled = false
    this.counts = {
      windowLoadCount: 0,
      toolbarLayoutReportCount: 0,
      captionDragStartCount: 0,
      captionMovedDragCount: 0,
      captionStationaryPressReleaseCount: 0,
      toolbarGripDragStartCount: 0,
      resizeStartCount: 0,
      settingsTitlebarDragStartCount: 0,
      historyTitlebarDragStartCount: 0,
      lockTransitionCount: 0,
      focusPromotionCount: 0,
      focusDemotionCount: 0
    }
    this.layerController = new WindowLayerController({
      getCaptionWindow: () => this.captionWindow,
      getToolbarWindow: () => this.toolbarWindow
    })
    this.interactionGenerationController = new WindowInteractionGenerationController({
      getWindow: (role) => this.windows.get(role) || null,
      getCursorScreenPoint: () => screen.getCursorScreenPoint(),
      getLocked: () => this.locked,
      sendSync: (win, value) => this.send(win, CHANNELS.WINDOW_INTERACTION_SYNC, value),
      onFault: ({ role, code }) => console.error(`[i2.window.interaction] role=${role} code=${code}`)
    })
    this.interactionController = new ManualWindowInteractionController({
      getCursorScreenPoint: () => screen.getCursorScreenPoint(),
      getCaptionWindow: () => this.captionWindow,
      getToolbarWindow: () => this.toolbarWindow,
      getLocked: () => this.locked,
      getCaptionLimits: () => ({ minW: 480, maxW: 1600, minH: 140, maxH: 420 }),
      dock: () => this.dock(),
      onGeometrySettled: (roles) => this.schedulePointerHitRefresh(roles),
      onObservation: (event) => this.observeInteraction(event)
    })
    this.lifecycleController = new ApplicationWindowLifecycleController({
      getCaptionWindow: () => this.captionWindow,
      getToolbarWindow: () => this.toolbarWindow,
      getSettingsWindow: () => this.settingsWindow,
      getHistoryWindow: () => this.historyWindow,
      stopInteractions: () => this.interactionController.stopAll(),
      beginInteractionTransaction: () => this.interactionGenerationController.beginTransaction(),
      resumeInteractions: (generation) => this.interactionGenerationController.resume(generation),
      degradeInteractions: (generation) => this.interactionGenerationController.degradeForRestoreFailure(generation),
      restoreWindowStack: () => this.layerController.restoreWindowStack(),
      onFault: ({ role, code }) => console.error(`[i2.window.lifecycle] role=${role} code=${code}`)
    })
  }

  schedulePointerHitRefresh (roles = ['caption', 'toolbar']) {
    if (this.disposed) return
    for (const role of roles) this.pendingPointerHitRefreshRoles.add(role)
    if (this.pointerHitRefreshScheduled) return
    this.pointerHitRefreshScheduled = true
    setImmediate(() => {
      this.pointerHitRefreshScheduled = false
      if (this.disposed) {
        this.pendingPointerHitRefreshRoles.clear()
        return
      }
      const pendingRoles = [...this.pendingPointerHitRefreshRoles]
      this.pendingPointerHitRefreshRoles.clear()
      if (pendingRoles.length > 0) this.interactionGenerationController.refreshPointerHits(pendingRoles)
    })
  }

  windowFor (event, channel) {
    const role = this.roles.get(event.sender.id)
    const win = BrowserWindow.fromWebContents(event.sender)
    const mainFrame = event.senderFrame && event.senderFrame === event.sender.mainFrame
    if (!role || !win || win.isDestroyed() || !mainFrame || !isRoleAllowed(channel, role)) {
      throw new Error('untrusted DWM harness sender')
    }
    return { role, win, senderId: event.sender.id }
  }

  registerOn (channel, listener) {
    ipcMain.on(channel, listener)
    this.disposers.push(() => ipcMain.removeListener(channel, listener))
  }

  registerHandle (channel, listener) {
    ipcMain.handle(channel, listener)
    this.disposers.push(() => ipcMain.removeHandler(channel))
  }

  send (win, channel, value) {
    if (!win || win.isDestroyed()) return false
    win.webContents.send(channel, value)
    return true
  }

  publishToolbarOverlap (overlap = this.layoutState.getOverlap()) {
    this.send(this.captionWindow, CHANNELS.CAPTION_LAYOUT_TOOLBAR_OVERLAP, overlap)
  }

  createWindow (role, options, file, overlay) {
    const win = new BrowserWindow({
      ...options,
      ...(overlay
        ? overlayWindowBehavior(role, options.focusable !== false)
        : { titleBarStyle: 'hidden', backgroundColor: '#00000000' }),
      show: false,
      webPreferences: {
        preload: path.join(PROJECT_ROOT, 'src', 'preload', `${role}.js`),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    })
    this.windows.set(role, win)
    this.roles.set(win.webContents.id, role)
    const senderId = win.webContents.id
    let navigationEpoch = 0
    win.webContents.once('destroyed', () => {
      this.roles.delete(senderId)
      if (this.windows.get(role) === win) this.windows.delete(role)
      this.interactionController.stopForSender(senderId)
      this.interactionGenerationController.releaseRole(role)
      if (role === 'toolbar') this.publishToolbarOverlap(this.layoutState.invalidate())
    })
    win.on('blur', () => this.interactionController.stopForSender(senderId))
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.webContents.on('render-process-gone', () => {
      navigationEpoch += 1
      this.interactionController.stopForSender(senderId)
      this.interactionGenerationController.failClosedAfterRendererGone(role)
      if (role === 'toolbar') this.publishToolbarOverlap(this.layoutState.invalidate())
    })
    win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (!isMainFrame || isInPlace) return
      navigationEpoch += 1
      this.interactionController.stopForSender(senderId)
      this.interactionGenerationController.suspendRoleForReload(role)
      if (role === 'toolbar') this.publishToolbarOverlap(this.layoutState.invalidate())
    })
    win.webContents.on('did-finish-load', () => {
      const replayEpoch = navigationEpoch
      this.interactionController.stopForSender(senderId)
      if (role === 'caption') this.publishToolbarOverlap()
      setImmediate(() => {
        if (!this.disposed && replayEpoch === navigationEpoch &&
            this.roles.get(senderId) === role && !win.isDestroyed()) {
          this.interactionGenerationController.replay(role)
        }
      })
    })
    if (overlay) {
      win.setAlwaysOnTop(true, 'screen-saver')
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      const pinZoom = () => { if (!win.isDestroyed()) win.webContents.setZoomFactor(1) }
      pinZoom()
      win.webContents.on('did-finish-load', pinZoom)
    } else {
      this.layerController.bindForegroundWindow(win, role)
      win.on('focus', () => { this.counts.focusPromotionCount += 1 })
      win.on('blur', () => { this.counts.focusDemotionCount += 1 })
    }
    return win.loadFile(file).then(() => win)
  }

  dock () {
    const caption = this.captionWindow
    const toolbar = this.toolbarWindow
    if (!caption || !toolbar || caption.isDestroyed() || toolbar.isDestroyed()) return
    toolbar.setBounds(toolbarDockBoundsFor(caption.getBounds()))
    this.layerController.restoreWindowStack()
  }

  observeInteraction (event) {
    if (event.kind === 'drag-start') {
      if (event.role === 'caption') this.counts.captionDragStartCount += 1
      else if (event.role === 'toolbar') this.counts.toolbarGripDragStartCount += 1
      else if (event.role === 'settings') this.counts.settingsTitlebarDragStartCount += 1
      else if (event.role === 'history') this.counts.historyTitlebarDragStartCount += 1
    } else if (event.kind === 'drag-end' && event.role === 'caption') {
      if (event.moved) this.counts.captionMovedDragCount += 1
      else this.counts.captionStationaryPressReleaseCount += 1
    } else if (event.kind === 'resize-start') {
      this.counts.resizeStartCount += 1
    }
  }

  applyLock (value) {
    this.locked = value === true
    this.counts.lockTransitionCount += 1
    if (this.locked) this.interactionController.stopAll()
    if (this.locked) this.interactionGenerationController.prepareOverlay('caption')
    this.send(this.captionWindow, CHANNELS.LOCK_CHANGED, this.locked)
    this.send(this.toolbarWindow, CHANNELS.LOCK_CHANGED, this.locked)
    if (!this.locked) {
      this.dock()
      this.schedulePointerHitRefresh()
    }
  }

  registerIpc () {
    const config = {
      ...DEFAULT_CONFIG,
      onboardingCompleted: true,
      onboardingPreset: 'meeting',
      mic: false,
      loopback: true,
      systemDark: nativeTheme.shouldUseDarkColors
    }
    this.registerOn(CHANNELS.WINDOW_INTERACTION_READY, (event, intent) => {
      const { role, senderId } = this.windowFor(event, CHANNELS.WINDOW_INTERACTION_READY)
      if (!isInteractionReadyIntent(intent)) return
      this.interactionController.stopForSender(senderId)
      this.interactionGenerationController.replay(role)
    })
    this.registerOn(CHANNELS.MOUSE_THROUGH, (event, intent) => {
      const { role } = this.windowFor(event, CHANNELS.MOUSE_THROUGH)
      this.interactionGenerationController.acceptMouseThrough(role, intent)
    })
    this.registerOn(CHANNELS.DRAG_START, (event, intent) => {
      const sender = this.windowFor(event, CHANNELS.DRAG_START)
      if (!this.interactionGenerationController.acceptGesture(sender.role, intent)) return
      this.interactionController.startDrag(sender)
    })
    this.registerOn(CHANNELS.DRAG_END, (event, intent) => {
      const { role, senderId } = this.windowFor(event, CHANNELS.DRAG_END)
      if (!this.interactionGenerationController.acceptGesture(role, intent)) return
      this.interactionController.stopDrag(senderId)
    })
    this.registerOn(CHANNELS.RESIZE_START, (event, intent) => {
      const { role, win, senderId } = this.windowFor(event, CHANNELS.RESIZE_START)
      if (!this.interactionGenerationController.acceptResizeStart(role, intent)) return
      this.interactionController.startResize({ win, senderId, edge: intent.edge })
    })
    this.registerOn(CHANNELS.RESIZE_END, (event, intent) => {
      const { role, senderId } = this.windowFor(event, CHANNELS.RESIZE_END)
      if (!this.interactionGenerationController.acceptGesture(role, intent)) return
      this.interactionController.stopResize(senderId)
    })
    this.registerOn(CHANNELS.LOCK_TOGGLE, (event) => {
      this.windowFor(event, CHANNELS.LOCK_TOGGLE)
      this.applyLock(!this.locked)
    })
    this.registerHandle(CHANNELS.LOCK_GET, (event) => { this.windowFor(event, CHANNELS.LOCK_GET); return this.locked })
    this.registerHandle(CHANNELS.CONFIG_GET, (event) => { this.windowFor(event, CHANNELS.CONFIG_GET); return config })
    this.registerHandle(CHANNELS.CONFIG_UPDATE, (event) => { this.windowFor(event, CHANNELS.CONFIG_UPDATE); return config })
    this.registerHandle(CHANNELS.PRESET_SELECT, (event) => { this.windowFor(event, CHANNELS.PRESET_SELECT); return config })
    this.registerHandle(CHANNELS.MODEL_STATUS_GET, (event) => { this.windowFor(event, CHANNELS.MODEL_STATUS_GET); return null })
    this.registerHandle(CHANNELS.REFINEMENT_NOTICE_GET, (event) => { this.windowFor(event, CHANNELS.REFINEMENT_NOTICE_GET); return null })
    this.registerHandle(CHANNELS.CAPTION_STATE_GET, (event) => {
      this.windowFor(event, CHANNELS.CAPTION_STATE_GET)
      return this.coordinator.getCaptionState()
    })
    this.registerHandle(CHANNELS.RUNTIME_GET, (event) => {
      this.windowFor(event, CHANNELS.RUNTIME_GET)
      return this.coordinator.getSnapshot()
    })
    this.registerHandle(CHANNELS.RUNTIME_COMMAND, async (event, name) => {
      this.windowFor(event, CHANNELS.RUNTIME_COMMAND)
      return this.coordinator.command(String(name || ''))
    })
    this.registerHandle(CHANNELS.HISTORY_LIST, (event) => {
      this.windowFor(event, CHANNELS.HISTORY_LIST)
      return { ok: true, value: { items: [], nextCursor: null } }
    })
    this.registerHandle(CHANNELS.HISTORY_PAGE, (event) => {
      this.windowFor(event, CHANNELS.HISTORY_PAGE)
      return { ok: false, error: { code: 'DWM_HARNESS_EMPTY', message: 'No session selected' } }
    })
    this.registerHandle(CHANNELS.HISTORY_EXPORT, (event) => {
      this.windowFor(event, CHANNELS.HISTORY_EXPORT)
      return { ok: false, error: { code: 'DWM_HARNESS_EMPTY', message: 'No session selected' } }
    })
    this.registerHandle(CHANNELS.CAPTION_VIEWPORT_EVICT, (event) => {
      this.windowFor(event, CHANNELS.CAPTION_VIEWPORT_EVICT)
      return false
    })
    this.registerHandle(CHANNELS.TOOLBAR_LAYOUT_GET_CONTEXT, (event) => {
      this.windowFor(event, CHANNELS.TOOLBAR_LAYOUT_GET_CONTEXT)
      return this.layoutState.getContext()
    })
    this.registerOn(CHANNELS.TOOLBAR_LAYOUT_REPORT_RECT, (event, report) => {
      this.windowFor(event, CHANNELS.TOOLBAR_LAYOUT_REPORT_RECT)
      this.counts.toolbarLayoutReportCount += 1
      this.publishToolbarOverlap(this.layoutState.acceptReport(report))
    })
    this.registerOn(CHANNELS.TOOLBAR_ACTION, (event, action) => {
      this.windowFor(event, CHANNELS.TOOLBAR_ACTION)
      if (action === 'settings' || action === 'open-model-manager') {
        this.lifecycleController.showAuxiliaryWindow(this.settingsWindow, 'settings')
      } else if (action === 'history') {
        this.lifecycleController.showAuxiliaryWindow(this.historyWindow, 'history')
      } else if (action === 'minimize') {
        this.lifecycleController.minimize()
      } else if (action === 'close') {
        app.quit()
      }
    })
    this.registerOn(CHANNELS.SETTINGS_CLOSE, (event) => {
      const { win } = this.windowFor(event, CHANNELS.SETTINGS_CLOSE)
      win.hide()
    })
    this.registerOn(CHANNELS.HISTORY_CLOSE, (event) => {
      const { win } = this.windowFor(event, CHANNELS.HISTORY_CLOSE)
      win.hide()
    })
  }

  async start () {
    this.registerIpc()
    const display = screen.getPrimaryDisplay().workAreaSize
    const captionX = Math.round((display.width - 920) / 2)
    const captionBounds = { width: 920, height: 190, x: captionX, y: 72 }
    const toolbarBounds = toolbarDockBoundsFor(captionBounds)
    this.captionWindow = await this.createWindow('caption', {
      ...captionBounds, resizable: false, focusable: false, skipTaskbar: true
    }, path.join(PROJECT_ROOT, 'src', 'caption', 'index.html'), true)
    this.toolbarWindow = await this.createWindow('toolbar', {
      ...toolbarBounds, resizable: false, focusable: true, skipTaskbar: true
    }, path.join(PROJECT_ROOT, 'src', 'toolbar', 'index.html'), true)
    this.settingsWindow = await this.createWindow('settings', {
      width: 880, height: 620, resizable: false, maximizable: false, skipTaskbar: false
    }, path.join(PROJECT_ROOT, 'src', 'settings', 'settings.html'), false)
    this.historyWindow = await this.createWindow('history', {
      width: 1060, height: 720, minWidth: 780, minHeight: 520, resizable: true, skipTaskbar: false
    }, path.join(PROJECT_ROOT, 'src', 'history', 'index.html'), false)
    this.lifecycleController.bindPrimaryWindow(this.toolbarWindow)
    this.lifecycleController.bindAuxiliaryWindow(this.settingsWindow, 'settings')
    this.lifecycleController.bindAuxiliaryWindow(this.historyWindow, 'history')
    this.interactionGenerationController.prepareOverlay('caption')
    this.interactionGenerationController.prepareOverlay('toolbar')
    for (const role of ['caption', 'toolbar', 'settings', 'history']) {
      this.interactionGenerationController.replay(role)
    }
    this.counts.windowLoadCount = 4
    this.unsubscribeSnapshot = this.coordinator.onSnapshot((snapshot) => {
      if (this.toolbarWindow && !this.toolbarWindow.isDestroyed()) this.toolbarWindow.webContents.send(CHANNELS.RUNTIME_CHANGED, snapshot)
    })
    this.unsubscribeCaption = this.coordinator.onCaption((event) => {
      if (this.captionWindow && !this.captionWindow.isDestroyed()) this.captionWindow.webContents.send(CHANNELS.CAPTION_EVENT, event)
    })
    this.captionWindow.showInactive()
    this.toolbarWindow.showInactive()
    this.settingsWindow.show()
    this.historyWindow.show()
    this.dock()
    this.schedulePointerHitRefresh()
    this.layerController.restoreWindowStack()
    const observeScale = () => {
      if (!this.captionWindow || this.captionWindow.isDestroyed()) return
      const scalePercent = Math.round(screen.getDisplayMatching(this.captionWindow.getBounds()).scaleFactor * 100)
      this.visitedScalePercents.add(scalePercent)
    }
    observeScale()
    this.scalePoll = setInterval(observeScale, 250)
  }

  async automaticObservation (options) {
    const displays = screen.getAllDisplays()
    const scalePercents = displays.map((display) => Math.round(display.scaleFactor * 100))
    const currentScalePercent = Math.round(screen.getDisplayMatching(this.captionWindow.getBounds()).scaleFactor * 100)
    const highContrast = nativeTheme.shouldUseHighContrastColors === true
    const actualTheme = highContrast ? 'high-contrast' : (nativeTheme.shouldUseDarkColors ? 'dark' : 'light')
    const rendererScalePercents = await Promise.all([this.captionWindow, this.toolbarWindow].map((win) =>
      win.webContents.executeJavaScript('Math.round(window.devicePixelRatio * 100)')
    ))
    const crossScaleMoveObserved = options.crossScaleFromPercent !== null &&
      this.visitedScalePercents.has(options.crossScaleFromPercent) &&
      this.visitedScalePercents.has(options.scalePercent)
    return {
      actualScaleMatched: currentScalePercent === options.scalePercent,
      systemThemeMatched: actualTheme === options.theme,
      rendererScaleMatched: rendererScalePercents.every((value) => value === options.scalePercent),
      displayCount: displays.length,
      distinctScaleFactorCount: new Set(scalePercents).size,
      crossScaleMoveObserved,
      fromScalePercent: crossScaleMoveObserved ? options.crossScaleFromPercent : options.scalePercent,
      toScalePercent: options.scalePercent
    }
  }

  dispose () {
    this.disposed = true
    this.pendingPointerHitRefreshRoles.clear()
    this.interactionController.stopAll()
    this.layerController.dispose()
    if (this.scalePoll) clearInterval(this.scalePoll)
    this.scalePoll = null
    if (this.unsubscribeSnapshot) this.unsubscribeSnapshot()
    if (this.unsubscribeCaption) this.unsubscribeCaption()
    this.unsubscribeSnapshot = null
    this.unsubscribeCaption = null
    for (const dispose of this.disposers.splice(0)) {
      try { dispose() } catch { /* teardown isolation */ }
    }
    for (const win of [this.captionWindow, this.toolbarWindow, this.settingsWindow, this.historyWindow]) {
      if (win && !win.isDestroyed()) win.destroy()
    }
    this.captionWindow = null
    this.toolbarWindow = null
    this.settingsWindow = null
    this.historyWindow = null
    this.windows.clear()
  }
}

async function awaitDwmCompletion (completionPath, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000
  while (Date.now() <= deadline) {
    if (fs.existsSync(completionPath)) {
      const bytes = fs.readFileSync(completionPath)
      return {
        value: parseOperatorCompletion(bytes),
        sha256: crypto.createHash('sha256').update(bytes).digest('hex')
      }
    }
    await delay(250)
  }
  return null
}

async function awaitRecoveryCompletion (completionPath, scenario, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000
  while (Date.now() <= deadline) {
    if (fs.existsSync(completionPath)) {
      return parseRecoveryOperatorCompletion(fs.readFileSync(completionPath), scenario)
    }
    await delay(250)
  }
  return null
}

function captionCount (captions, kind, startIndex = 0) {
  return captions.slice(startIndex).filter((entry) => entry.kind === kind).length
}

function maximumCaptionSequence (captions) {
  return captions.reduce((maximum, entry) => Math.max(maximum, entry.sequence), 0)
}

async function runPauseRefine ({ coordinator, getAdapter, play, sourceId, captions }) {
  const started = await coordinator.command('start')
  if (!started.ok) throw new Error('coordinator start failed')
  const sessionId = coordinator.getSnapshot().sessionId
  const activeAdapter = getAdapter()
  await delay(800)
  const before = await readLiveTransport(activeAdapter, sourceId)
  const finalCountBeforePlayback = captions.filter((entry) => entry.kind === 'final').length
  const playback = play()
  await waitUntil(
    () => captions.filter((entry) => entry.kind === 'final').length > finalCountBeforePlayback,
    PAUSE_AWAIT_FIRST_FINAL_MS,
    'first real final before pause'
  )
  const refinementPendingAtPause = await waitForPendingRefinement(activeAdapter)
  const paused = await coordinator.command('pause')
  const finalBeforePause = captions.filter((entry) => entry.kind === 'final').length
  await playback
  await delay(PAUSE_SETTLE_MS)
  const refinedWhilePaused = captions.filter((entry) => entry.kind === 'refined' && entry.phase === 'paused').length
  const resumed = await coordinator.command('resume')
  const refinedBeforeResume = captions.filter((entry) => entry.kind === 'refined').length
  if (resumed.ok) await waitUntil(
    () => captions.filter((entry) => entry.kind === 'refined').length > refinedBeforeResume,
    12000,
    'refined caption after resume'
  )
  const refinedAfterResume = captions.filter((entry) => entry.kind === 'refined').length - refinedBeforeResume
  const stopped = await coordinator.command('stop')
  if (!stopped.ok) throw new Error('coordinator stop failed')
  const after = stoppedTransport(activeAdapter, sourceId, sessionId)
  return {
    result: paused.ok && resumed.ok && finalBeforePause > 0 && refinementPendingAtPause > 0 &&
      refinedWhilePaused === 0 && refinedAfterResume > 0 && cleanTransport(after)
      ? 'pass'
      : 'fail',
    scenarioEvidence: {
      pauseAcknowledged: paused.ok === true,
      resumeAcknowledged: resumed.ok === true,
      finalBeforePause,
      refinementPendingAtPause,
      refinedWhilePaused,
      refinedAfterResume
    },
    transport: { comparison: 'same-capture-generation', before, after, delta: transportDelta(before, after, true) }
  }
}

async function runWorkerCrashRetry ({ coordinator, getAdapter, play, sourceId, captions, workers }) {
  const started = await coordinator.command('start')
  if (!started.ok) throw new Error('coordinator start failed')
  const sessionId = coordinator.getSnapshot().sessionId
  const crashedAdapter = getAdapter()
  await delay(800)
  const before = await readLiveTransport(crashedAdapter, sourceId)
  await play()
  await delay(FINAL_SETTLE_MS)
  const finalBeforeCrash = captions.filter((entry) => entry.kind === 'final').length
  const worker = crashedAdapter?.session?.worker
  if (!worker || typeof worker.terminateAndWait !== 'function') throw new Error('active realtime worker is unavailable for exact crash scenario')
  await worker.terminateAndWait()
  await waitUntil(() => coordinator.getSnapshot().phase === 'error', 10000, 'worker crash error phase')
  const workerExitObserved = coordinator.getSnapshot().lastError?.code === 'REALTIME_WORKER_EXITED'
  const retried = await coordinator.command('retry')
  const sameSession = coordinator.getSnapshot().sessionId === sessionId
  const recoveredAdapter = getAdapter()
  /* Production retry deliberately reuses the runtime adapter so it can carry
     the same session/cursor while start() creates a fresh exact worker. */
  const runtimeAdapterReusedAfterRetry = recoveredAdapter !== null && recoveredAdapter === crashedAdapter
  const recoveredWorker = recoveredAdapter?.session?.worker
  const freshWorkerGenerationAfterRetry = recoveredWorker != null && recoveredWorker !== worker
  const captionCountAtRetry = captions.length
  if (retried.ok) {
    await play()
    await delay(FINAL_SETTLE_MS)
  }
  const finalAfterRetry = captions.slice(captionCountAtRetry).filter((entry) => entry.kind === 'final').length
  const stopped = await coordinator.command('stop')
  if (!stopped.ok) throw new Error('coordinator stop after retry failed')
  const after = stoppedTransport(recoveredAdapter, sourceId, sessionId)
  return {
    result: workerExitObserved && retried.ok && sameSession && runtimeAdapterReusedAfterRetry &&
      freshWorkerGenerationAfterRetry && workers.length >= 2 &&
      finalBeforeCrash > 0 && finalAfterRetry > 0 && cleanTransport(after)
      ? 'pass'
      : 'fail',
    scenarioEvidence: {
      crashMethod: 'forced-exact-realtime-worker-termination',
      workerExitObserved,
      retrySucceeded: retried.ok === true,
      sameSession,
      runtimeAdapterReusedAfterRetry,
      freshWorkerGenerationAfterRetry,
      workerGenerationCount: workers.length,
      finalBeforeCrash,
      finalAfterRetry
    },
    transport: { comparison: 'cross-recovery-generation', before, after, delta: null }
  }
}

async function runDwmDrag ({ coordinator, getAdapter, play, sourceId, options, writeProgress }) {
  const started = await coordinator.command('start')
  if (!started.ok) throw new Error('coordinator start failed')
  const sessionId = coordinator.getSnapshot().sessionId
  const activeAdapter = getAdapter()
  const harness = new DwmDragHarness({ coordinator })
  let stopPlayback = false
  let playbackFailure = null
  try {
    await harness.start()
    await delay(800)
    const before = await readLiveTransport(activeAdapter, sourceId)
    const initialTransport = { comparison: 'same-capture-generation', before, after: blankTransport(), delta: transportDelta(before, blankTransport(), true) }
    writeProgress('ready-for-dwm-drag', initialTransport, false)
    const playbackLoop = (async () => {
      while (!stopPlayback) await play()
    })().catch((error) => { playbackFailure = error })
    writeProgress('awaiting-operator-completion', initialTransport, false)
    const completionRecord = await awaitDwmCompletion(options.completion, options.timeoutSeconds)
    stopPlayback = true
    await playbackLoop
    if (playbackFailure) throw playbackFailure
    const after = await readLiveTransport(activeAdapter, sourceId)
    const transport = { comparison: 'same-capture-generation', before, after, delta: transportDelta(before, after, true) }
    const completion = completionRecord?.value || null
    const protocol = options.dwmProtocol
    const automaticObservation = await harness.automaticObservation(options)
    const completionMatches = completion?.schemaVersion === 5 &&
      completion.runBindingSha256 === protocol.runBindingSha256 &&
      completion.productPayloadVersion === protocol.productPayloadVersion &&
      completion.productPayloadFileCount === protocol.productPayloadFileCount &&
      completion.productPayloadSha256 === protocol.productPayloadSha256 &&
      JSON.stringify(completion.combination) === JSON.stringify(protocol.combination) &&
      completion.crossScale.observed === automaticObservation.crossScaleMoveObserved
    const operatorCompletionObserved = completionMatches === true
    writeProgress('completed', transport, operatorCompletionObserved)
    const stopped = await coordinator.command('stop')
    if (!stopped.ok) throw new Error('coordinator stop after DWM drag failed')
    const finalAfter = stoppedTransport(activeAdapter, sourceId, sessionId)
    const finalTransport = {
      comparison: 'same-capture-generation',
      before,
      after: finalAfter,
      delta: transportDelta(before, finalAfter, true)
    }
    const minimumCountsObserved =
      harness.counts.windowLoadCount >= 4 &&
      harness.counts.toolbarLayoutReportCount >= 3 &&
      harness.counts.captionDragStartCount >= 5 &&
      harness.counts.captionMovedDragCount >= 4 &&
      harness.counts.captionStationaryPressReleaseCount >= 1 &&
      harness.counts.toolbarGripDragStartCount >= 2 &&
      harness.counts.resizeStartCount >= 8 &&
      harness.counts.settingsTitlebarDragStartCount >= 1 &&
      harness.counts.historyTitlebarDragStartCount >= 1 &&
      harness.counts.lockTransitionCount >= 2 &&
      harness.counts.focusPromotionCount >= 2 &&
      harness.counts.focusDemotionCount >= 2
    const automaticBoundaryMatched = automaticObservation.actualScaleMatched &&
      automaticObservation.systemThemeMatched && automaticObservation.rendererScaleMatched
    return {
      result: operatorCompletionObserved && minimumCountsObserved && automaticBoundaryMatched && cleanTransport(finalAfter)
        ? 'pass-manual-observed'
        : 'inconclusive-manual-observation',
      scenarioEvidence: {
        mode: 'production-dwm-harness',
        rendererAssets: 'caption-toolbar-settings-history',
        manualSetBounds: true,
        runBindingSha256: protocol.runBindingSha256,
        operatorCompletionObserved,
        operatorCompletionSha256: operatorCompletionObserved ? completionRecord.sha256 : null,
        combination: { ...protocol.combination },
        checks: operatorCompletionObserved ? completion.checks : null,
        lifecycle: operatorCompletionObserved ? completion.lifecycle : null,
        stability: operatorCompletionObserved ? completion.stability : null,
        crossScale: operatorCompletionObserved ? completion.crossScale : null,
        productPayloadVersion: protocol.productPayloadVersion,
        productPayloadFileCount: protocol.productPayloadFileCount,
        productPayloadSha256: protocol.productPayloadSha256,
        productionReuse: {
          interactionController: true,
          interactionGenerationController: true,
          applicationWindowLifecycleController: true,
          windowLayerController: true,
          ipcAccessPolicy: true,
          windowRoles: ['caption', 'toolbar', 'settings', 'history'],
          preloadRoles: ['caption', 'toolbar', 'settings', 'history'],
          pageRoles: ['caption', 'toolbar', 'settings', 'history'],
          mainProcessManualBoundsUpdates: true
        },
        automaticObservation,
        controllerCounts: { ...harness.counts }
      },
      transport: finalTransport
    }
  } finally {
    stopPlayback = true
    harness.dispose()
  }
}

async function runRecoveryInteraction ({
  coordinator,
  getAdapter,
  applicationRuntime,
  play,
  sourceId,
  options,
  captions,
  workers,
  writeProgress
}) {
  const expectedFaultCode = RECOVERY_FAULT_CODES[options.scenario]
  let systemResumeEventObserved = false
  const onSystemResume = () => { systemResumeEventObserved = true }
  const powerGuard = options.scenario === 'sleep-wake-retry'
    ? new PowerSessionGuard({ powerMonitor, getCoordinator: () => coordinator })
    : null
  if (powerGuard) {
    powerMonitor.on('resume', onSystemResume)
    powerGuard.start()
  }

  try {
    writeProgress('starting', {})
    const started = await coordinator.command('start')
    if (!started.ok) throw new Error('coordinator start failed')
    const sessionId = coordinator.getSnapshot().sessionId
    const activeAdapter = getAdapter()
    const workerBeforeFault = activeAdapter?.session?.worker
    if (!workerBeforeFault) throw new Error('active realtime worker is unavailable for recovery scenario')
    await delay(800)

    const finalCountBeforePlayback = captionCount(captions, 'final')
    await play()
    await waitUntil(
      () => captionCount(captions, 'final') > finalCountBeforePlayback,
      PAUSE_AWAIT_FIRST_FINAL_MS,
      'first real final before external recovery action'
    )
    writeProgress(
      options.scenario === 'device-removal-retry' ? 'awaiting-device-removal' : 'awaiting-system-suspend',
      {}
    )

    await waitUntil(() => {
      const snapshot = coordinator.getSnapshot()
      return snapshot.phase === 'error' && snapshot.lastError?.code === expectedFaultCode
    }, options.timeoutSeconds * 1000, `${expectedFaultCode} product fault`)
    const faultPhaseObserved = true
    const workerGenerationCountAtFault = workers.length
    writeProgress('fault-observed', { faultCodeObserved: expectedFaultCode })

    await waitUntil(
      () => activeAdapter.getLiveDiagnostics() === null,
      RECOVERY_CAPTURE_RELEASE_TIMEOUT_MS,
      'faulted capture release'
    )
    const captureReleased = activeAdapter.getLiveDiagnostics() === null
    const faultGenerationTransport = stoppedTransport(activeAdapter, sourceId, sessionId)
    /* Capture cleanup is the stable boundary after which no further caption
       from the faulted generation can be accepted. Count and sequence the
       complete pre-Retry prefix here, including any event accepted while the
       external fault was still propagating. */
    const captionsBeforeFault = captions.length
    const finalBeforeFault = captionCount(captions, 'final')
    const maxSequenceBeforeFault = maximumCaptionSequence(captions)
    writeProgress('awaiting-operator-completion', {
      faultCodeObserved: expectedFaultCode,
      captureReleased
    })

    const completion = await awaitRecoveryCompletion(options.completion, options.scenario, options.timeoutSeconds)
    if (!completion) throw new Error('operator recovery completion was not observed')
    if (options.scenario === 'sleep-wake-retry') {
      await waitUntil(() => systemResumeEventObserved, 10000, 'real system resume event')
    }
    const workerGenerationCountBeforeRetry = workers.length
    await delay(NO_AUTO_REACQUIRE_OBSERVATION_MS)
    const noAutomaticReacquire = coordinator.getSnapshot().phase === 'error' &&
      coordinator.getSnapshot().lastError?.code === expectedFaultCode &&
      activeAdapter.getLiveDiagnostics() === null &&
      workers.length === workerGenerationCountBeforeRetry
    writeProgress('operator-completion-observed', {
      faultCodeObserved: expectedFaultCode,
      captureReleased,
      automaticReacquireObserved: !noAutomaticReacquire,
      operatorCompletionObserved: true
    })
    if (!noAutomaticReacquire) throw new Error('capture reacquired without explicit Retry')

    writeProgress('retrying', {
      faultCodeObserved: expectedFaultCode,
      captureReleased,
      operatorCompletionObserved: true,
      retryIssued: true
    })
    const retried = await coordinator.command('retry')
    const sameSession = coordinator.getSnapshot().sessionId === sessionId
    const recoveredAdapter = getAdapter()
    const runtimeAdapterReusedAfterRetry = recoveredAdapter === activeAdapter
    const recoveredWorker = recoveredAdapter?.session?.worker
    const freshWorkerGenerationAfterRetry = recoveredWorker != null && recoveredWorker !== workerBeforeFault
    const workerGenerationCountAfterRetry = workers.length
    const captionIndexAtRetry = captions.length
    if (retried.ok) {
      await waitUntil(() => coordinator.getSnapshot().phase === 'listening', 10000, 'listening after explicit Retry')
      await play()
      await waitUntil(
        () => captionCount(captions, 'final', captionIndexAtRetry) > 0,
        PAUSE_AWAIT_FIRST_FINAL_MS,
        'real final after explicit Retry'
      )
    }
    const captionsAfterRetry = captions.length - captionIndexAtRetry
    const finalAfterRetry = captionCount(captions, 'final', captionIndexAtRetry)
    const firstSequenceAfterRetry = captions[captionIndexAtRetry]?.sequence ?? null
    const sequenceStrictlyIncreased = firstSequenceAfterRetry !== null &&
      firstSequenceAfterRetry > maxSequenceBeforeFault

    const stopped = await coordinator.command('stop')
    if (!stopped.ok) throw new Error('coordinator stop after recovery failed')
    const recoveredGenerationTransport = stoppedTransport(recoveredAdapter, sourceId, sessionId)
    await applicationRuntime.gateway.flush()
    const transcript = await applicationRuntime.gateway.getSessionTranscript(sessionId)
    const sqliteSessionClosed = transcript.session.state === 'closed'
    const sqliteSourceMatched = transcript.session.sourceId === sourceId &&
      transcript.segments.every((segment) => segment.sourceId === sourceId)
    const sqlitePersistedSegmentCount = transcript.segments.length
    const sqlitePersistedAtLeastObservedFinals = sqlitePersistedSegmentCount >= finalBeforeFault + finalAfterRetry

    const scenarioEvidence = {
      faultCodeObserved: expectedFaultCode,
      faultPhaseObserved,
      captureReleased,
      operatorCompletionObserved: completion.observed === true,
      systemResumeEventObserved,
      workerGenerationCountAtFault,
      workerGenerationCountBeforeRetry,
      workerGenerationCountAfterRetry,
      noAutomaticReacquire,
      explicitRetryIssued: true,
      retrySucceeded: retried.ok === true,
      sameSession,
      runtimeAdapterReusedAfterRetry,
      freshWorkerGenerationAfterRetry,
      captionsBeforeFault,
      captionsAfterRetry,
      finalBeforeFault,
      finalAfterRetry,
      maxSequenceBeforeFault,
      firstSequenceAfterRetry,
      sequenceStrictlyIncreased,
      sqliteSessionClosed,
      sqliteSourceMatched,
      sqlitePersistedSegmentCount,
      sqlitePersistedAtLeastObservedFinals
    }
    const result = retried.ok && sameSession && runtimeAdapterReusedAfterRetry &&
      freshWorkerGenerationAfterRetry && workerGenerationCountAtFault === workerGenerationCountBeforeRetry &&
      workerGenerationCountAfterRetry === workerGenerationCountBeforeRetry + 1 && noAutomaticReacquire &&
      captionsBeforeFault > 0 && captionsAfterRetry > 0 && finalBeforeFault > 0 && finalAfterRetry > 0 &&
      sequenceStrictlyIncreased && sqliteSessionClosed && sqliteSourceMatched &&
      sqlitePersistedAtLeastObservedFinals && cleanTransport(faultGenerationTransport) &&
      cleanTransport(recoveredGenerationTransport) &&
      (options.scenario !== 'sleep-wake-retry' || systemResumeEventObserved)
      ? 'pass'
      : 'fail'
    writeProgress(result === 'pass' ? 'completed' : 'failed', {
      faultCodeObserved: expectedFaultCode,
      captureReleased,
      automaticReacquireObserved: !noAutomaticReacquire,
      operatorCompletionObserved: true,
      retryIssued: true,
      captionsAfterRetry
    })
    return {
      result,
      scenarioEvidence,
      transport: {
        comparison: 'cross-recovery-generation',
        before: faultGenerationTransport,
        after: recoveredGenerationTransport,
        delta: null
      },
      deviceRecovery: {
        simulatedTrackEnded: false,
        actualOsDeviceRemoval: options.scenario === 'device-removal-retry',
        actualSystemSleepWake: options.scenario === 'sleep-wake-retry',
        networkRecoveryNotApplicable: true
      }
    }
  } finally {
    if (powerGuard) {
      powerGuard.stop()
      powerMonitor.removeListener('resume', onSystemResume)
    }
  }
}

function failureEvidence (scenario, options = null, dwmProtocol = null) {
  if (scenario === 'pause-refine') {
    return {
      pauseAcknowledged: false, resumeAcknowledged: false, finalBeforePause: 0,
      refinementPendingAtPause: 0, refinedWhilePaused: 0, refinedAfterResume: 0
    }
  }
  if (scenario === 'worker-crash-retry') {
    return {
      crashMethod: 'forced-exact-realtime-worker-termination', workerExitObserved: false, retrySucceeded: false,
      sameSession: false, runtimeAdapterReusedAfterRetry: false, freshWorkerGenerationAfterRetry: false,
      workerGenerationCount: 0, finalBeforeCrash: 0, finalAfterRetry: 0
    }
  }
  if (RECOVERY_SCENARIOS.includes(scenario)) {
    return {
      faultCodeObserved: null,
      faultPhaseObserved: false,
      captureReleased: false,
      operatorCompletionObserved: false,
      systemResumeEventObserved: false,
      workerGenerationCountAtFault: 0,
      workerGenerationCountBeforeRetry: 0,
      workerGenerationCountAfterRetry: 0,
      noAutomaticReacquire: false,
      explicitRetryIssued: false,
      retrySucceeded: false,
      sameSession: false,
      runtimeAdapterReusedAfterRetry: false,
      freshWorkerGenerationAfterRetry: false,
      captionsBeforeFault: 0,
      captionsAfterRetry: 0,
      finalBeforeFault: 0,
      finalAfterRetry: 0,
      maxSequenceBeforeFault: 0,
      firstSequenceAfterRetry: null,
      sequenceStrictlyIncreased: false,
      sqliteSessionClosed: false,
      sqliteSourceMatched: false,
      sqlitePersistedSegmentCount: 0,
      sqlitePersistedAtLeastObservedFinals: false
    }
  }
  return {
    mode: 'production-dwm-harness',
    rendererAssets: 'caption-toolbar-settings-history',
    manualSetBounds: true,
    runBindingSha256: dwmProtocol.runBindingSha256,
    operatorCompletionObserved: false,
    operatorCompletionSha256: null,
    combination: { ...dwmProtocol.combination },
    checks: null,
    lifecycle: null,
    stability: null,
    crossScale: null,
    productPayloadVersion: dwmProtocol.productPayloadVersion,
    productPayloadFileCount: dwmProtocol.productPayloadFileCount,
    productPayloadSha256: dwmProtocol.productPayloadSha256,
    productionReuse: {
      interactionController: true,
      interactionGenerationController: true,
      applicationWindowLifecycleController: true,
      windowLayerController: true,
      ipcAccessPolicy: true,
      windowRoles: ['caption', 'toolbar', 'settings', 'history'],
      preloadRoles: ['caption', 'toolbar', 'settings', 'history'],
      pageRoles: ['caption', 'toolbar', 'settings', 'history'],
      mainProcessManualBoundsUpdates: true
    },
    automaticObservation: {
      actualScaleMatched: false,
      systemThemeMatched: false,
      rendererScaleMatched: false,
      displayCount: 0,
      distinctScaleFactorCount: 0,
      crossScaleMoveObserved: false,
      fromScalePercent: options.scalePercent,
      toScalePercent: options.scalePercent
    },
    controllerCounts: {
      windowLoadCount: 0,
      toolbarLayoutReportCount: 0,
      captionDragStartCount: 0,
      captionMovedDragCount: 0,
      captionStationaryPressReleaseCount: 0,
      toolbarGripDragStartCount: 0,
      resizeStartCount: 0,
      settingsTitlebarDragStartCount: 0,
      historyTitlebarDragStartCount: 0,
      lockTransitionCount: 0,
      focusPromotionCount: 0,
      focusDemotionCount: 0
    }
  }
}

async function main () {
  const options = parseArguments(process.argv.slice(2))
  const reportPath = workspaceArtifactPath(options.report, 'report')
  const progressPath = options.progress ? workspaceArtifactPath(options.progress, 'progress') : null
  const completionPath = options.completion ? workspaceArtifactPath(options.completion, 'completion') : null
  const preflightPath = options.physicalMicPreflight
    ? workspaceReadPath(options.physicalMicPreflight, 'physical microphone preflight')
    : null
  assertDistinctOutputPaths([reportPath, progressPath, completionPath])
  if (fs.existsSync(reportPath)) throw new Error('interaction report already exists; use a fresh artifact path')
  if (progressPath && fs.existsSync(progressPath)) throw new Error('interaction progress already exists; use a fresh artifact path')
  if (completionPath && fs.existsSync(completionPath)) throw new Error('interaction completion already exists; use a fresh artifact path')

  app.on('window-all-closed', () => {})
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
  const runUserDataPath = path.join(ARTIFACT_ROOT, 'i2-interaction-user-data', `${process.pid}-${Date.now()}`)
  fs.mkdirSync(runUserDataPath, { recursive: true })
  app.setPath('userData', runUserDataPath)
  await app.whenReady()

  const dwmProtocol = options.scenario === 'dwm-drag'
    ? (() => {
        const identity = computeProductPayloadIdentity()
        return {
          runBindingSha256: crypto.randomBytes(32).toString('hex'),
          productPayloadVersion: identity.version,
          productPayloadFileCount: identity.fileCount,
          productPayloadSha256: identity.sha256,
          combination: { scalePercent: options.scalePercent, theme: options.theme }
        }
      })()
    : null

  let applicationRuntime = null
  let result = 'fail'
  let scenarioOutcome = null
  let adapter = null
  const captions = []
  const workers = []
  let runtimeSummary = null
  const writeProgress = (state, payload, operatorCompletionObserved) => {
    if (!progressPath) return
    const progress = RECOVERY_SCENARIOS.includes(options.scenario)
      ? buildRecoveryProgress({
          scenario: options.scenario,
          sourceId: options.source,
          state,
          ...(payload || {})
        })
      : buildDwmProgress({
          sourceId: options.source,
          state,
          ...dwmProtocol,
          transport: payload,
          operatorCompletionObserved
        })
    if (options.scenario === 'dwm-drag') validateDwmProgress(progress)
    writeAtomicJson(progressPath, progress)
  }

  try {
    const model = resolveApprovedRealtimeModel({ userDataDir: app.getPath('userData') })
    const vad = resolveSileroVadModel({ userDataDir: app.getPath('userData') })
    const refinement = resolveApprovedRefinementModel({ userDataDir: app.getPath('userData') })
    if (!model || !vad || !refinement) throw new Error('approved realtime, Silero VAD, and offline refinement models are required')
    const physicalPreflight = preflightPath ? readPhysicalMicPreflight(preflightPath) : null
    const wave = readPcm16MonoWav(stimulusPathForScenario(options.scenario))
    const playbackOptions = controlledPlaybackOptions(options, physicalPreflight)
    const play = () => playWave(wave, playbackOptions.outputMode, playbackOptions.expectedOutputLabelSha256)
    const composition = createRuntimeComposition({
      options,
      userDataPath: app.getPath('userData'),
      model,
      vad,
      refinement,
      physicalPreflight,
      workers
    })
    applicationRuntime = composition.applicationRuntime
    const started = await applicationRuntime.start()
    const coordinator = started.coordinator
    adapter = composition.getAdapter()
    coordinator.onCaption((event) => {
      captions.push({ kind: event.kind, phase: coordinator.getSnapshot().phase, sequence: event.sequence })
    })
    runtimeSummary = {
      modelId: model.id,
      profile: model.profile,
      vad: 'silero',
      refinement: refinement.id,
      sqliteSessionRecorder: true
    }

    if (options.scenario === 'pause-refine') {
      scenarioOutcome = await runPauseRefine({ coordinator, getAdapter: composition.getAdapter, play, sourceId: options.source, captions })
    } else if (options.scenario === 'worker-crash-retry') {
      scenarioOutcome = await runWorkerCrashRetry({ coordinator, getAdapter: composition.getAdapter, play, sourceId: options.source, captions, workers })
    } else if (options.scenario === 'dwm-drag') {
      scenarioOutcome = await runDwmDrag({
        coordinator,
        getAdapter: composition.getAdapter,
        play,
        sourceId: options.source,
        options: { ...options, completion: completionPath, dwmProtocol },
        writeProgress
      })
    } else {
      scenarioOutcome = await runRecoveryInteraction({
        coordinator,
        getAdapter: composition.getAdapter,
        applicationRuntime,
        play,
        sourceId: options.source,
        options: { ...options, completion: completionPath },
        captions,
        workers,
        writeProgress
      })
    }
    result = scenarioOutcome.result
  } catch (error) {
    if (options.scenario === 'dwm-drag' && progressPath) {
      const empty = blankTransport()
      writeProgress('failed', { comparison: 'same-capture-generation', before: empty, after: empty, delta: transportDelta(empty, empty, true) }, false)
    } else if (RECOVERY_SCENARIOS.includes(options.scenario) && progressPath) {
      writeProgress('failed', {})
    }
    scenarioOutcome = scenarioOutcome || {
      scenarioEvidence: failureEvidence(options.scenario, options, dwmProtocol),
      transport: {
        comparison: options.scenario === 'worker-crash-retry' || RECOVERY_SCENARIOS.includes(options.scenario)
          ? 'cross-recovery-generation'
          : 'same-capture-generation',
        before: blankTransport(),
        after: blankTransport(),
        delta: options.scenario === 'worker-crash-retry' || RECOVERY_SCENARIOS.includes(options.scenario)
          ? null
          : transportDelta(blankTransport(), blankTransport(), true)
      }
    }
    process.stderr.write(JSON.stringify({ result: 'error', errorCode: 'i2-interaction-run-failed' }) + '\n')
  } finally {
    if (applicationRuntime) await applicationRuntime.shutdown().catch(() => applicationRuntime.terminate())
  }

  if (!runtimeSummary) {
    app.exit(1)
    return
  }
  const counts = {
    captions: captions.length,
    partials: captions.filter((entry) => entry.kind === 'partial').length,
    finals: captions.filter((entry) => entry.kind === 'final').length,
    refined: captions.filter((entry) => entry.kind === 'refined').length
  }
  const report = buildInteractionReport({
    executedAt: new Date().toISOString(),
    scenario: options.scenario,
    sourceId: options.source,
    result,
    runtime: runtimeSummary,
    counts,
    scenarioEvidence: scenarioOutcome.scenarioEvidence,
    transport: scenarioOutcome.transport,
    deviceRecovery: scenarioOutcome.deviceRecovery || {
      simulatedTrackEnded: false,
      actualOsDeviceRemoval: false,
      actualSystemSleepWake: false,
      networkRecoveryNotApplicable: true
    }
  })
  validateInteractionReport(report, options.scenario)
  writeAtomicJson(reportPath, report)
  process.stdout.write(JSON.stringify({ scenario: report.scenario, result: report.result, counts: report.counts }) + '\n')
  app.exit(result === 'pass' || result === 'pass-manual-observed' ? 0 : 2)
}

if (process.versions.electron && process.type === 'browser') {
  main().catch(() => {
    process.stderr.write(JSON.stringify({ result: 'error', errorCode: 'i2-interaction-entry-failed' }) + '\n')
    app.exit(1)
  })
}

module.exports = {
  DwmDragHarness,
  blankTransport,
  cleanTransport,
  controlledPlaybackOptions,
  createRuntimeComposition,
  failureEvidence,
  assertDistinctOutputPaths,
  runRecoveryInteraction,
  stoppedTransport,
  stimulusPathForScenario,
  workspaceArtifactPath
}
