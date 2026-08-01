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
 * visual drag observation to an external operator completion file.
 */

const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, ipcMain, screen } = require('electron')
const CHANNELS = require('../src/main/ipc/channels')
const { DEFAULT_CONFIG } = require('../src/main/services/config-store')
const { SubtitleApplicationRuntime } = require('../src/main/services/subtitle-application-runtime')
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
  TRANSPORT_FIELDS,
  buildDwmProgress,
  buildInteractionReport,
  parseArguments,
  parseOperatorCompletion,
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
    this.dragState = null
    this.disposers = []
    this.unsubscribeSnapshot = null
    this.unsubscribeCaption = null
  }

  windowFor (event) {
    const role = this.roles.get(event.sender.id)
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!role || !win || win.isDestroyed()) throw new Error('untrusted DWM harness sender')
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

  createWindow (role, options, file) {
    const win = new BrowserWindow({
      ...options,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: path.join(PROJECT_ROOT, 'src', 'preload', `${role}.js`),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    })
    this.roles.set(win.webContents.id, role)
    win.webContents.once('destroyed', () => this.roles.delete(win.webContents.id))
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event) => event.preventDefault())
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    return win.loadFile(file).then(() => win)
  }

  dock () {
    const caption = this.captionWindow
    const toolbar = this.toolbarWindow
    if (!caption || !toolbar || caption.isDestroyed() || toolbar.isDestroyed()) return
    const bounds = caption.getBounds()
    toolbar.setBounds({ x: bounds.x + bounds.width - 568 - 16, y: bounds.y + 16, width: 600, height: 72 })
    toolbar.moveTop()
  }

  stopDrag (senderId = null, force = false) {
    if (!this.dragState || (!force && this.dragState.senderId !== senderId)) return
    if (this.dragState.timer) clearTimeout(this.dragState.timer)
    this.dragState = null
  }

  dragTick () {
    const state = this.dragState
    if (!state || !state.win || state.win.isDestroyed()) return this.stopDrag(null, true)
    const point = screen.getCursorScreenPoint()
    state.win.setBounds({ x: point.x - state.offX, y: point.y - state.offY, width: state.width, height: state.height })
    if (state.redock) this.dock()
    if (this.dragState === state) state.timer = setTimeout(() => this.dragTick(), 8)
  }

  startDrag (event) {
    const { role, win: sender, senderId } = this.windowFor(event)
    this.stopDrag(null, true)
    const target = role === 'toolbar' ? this.captionWindow : sender
    if (!target || target.isDestroyed()) return
    const point = screen.getCursorScreenPoint()
    const bounds = target.getBounds()
    this.dragState = {
      senderId,
      win: target,
      offX: point.x - bounds.x,
      offY: point.y - bounds.y,
      width: bounds.width,
      height: bounds.height,
      redock: role === 'toolbar' || role === 'caption',
      timer: null
    }
    this.dragTick()
  }

  registerIpc () {
    const config = {
      ...DEFAULT_CONFIG,
      onboardingCompleted: true,
      onboardingPreset: 'meeting',
      mic: false,
      loopback: true,
      systemDark: true
    }
    this.registerOn(CHANNELS.MOUSE_THROUGH, (event, ignore) => {
      const { win } = this.windowFor(event)
      win.setIgnoreMouseEvents(!!ignore, { forward: true })
    })
    this.registerOn(CHANNELS.DRAG_START, (event) => this.startDrag(event))
    this.registerOn(CHANNELS.DRAG_END, (event) => {
      const { senderId } = this.windowFor(event)
      this.stopDrag(senderId)
    })
    this.registerHandle(CHANNELS.LOCK_GET, (event) => { this.windowFor(event); return false })
    this.registerHandle(CHANNELS.CONFIG_GET, (event) => { this.windowFor(event); return config })
    this.registerHandle(CHANNELS.CAPTION_STATE_GET, (event) => {
      this.windowFor(event)
      return this.coordinator.getCaptionState()
    })
    this.registerHandle(CHANNELS.RUNTIME_GET, (event) => {
      this.windowFor(event)
      return this.coordinator.getSnapshot()
    })
    this.registerHandle(CHANNELS.RUNTIME_COMMAND, async (event, name) => {
      this.windowFor(event)
      return this.coordinator.command(String(name || ''))
    })
  }

  async start () {
    this.registerIpc()
    const display = screen.getPrimaryDisplay().workAreaSize
    const captionX = Math.round((display.width - 920) / 2)
    this.captionWindow = await this.createWindow('caption', {
      width: 920, height: 190, x: captionX, y: 72, resizable: false, focusable: false, skipTaskbar: true
    }, path.join(PROJECT_ROOT, 'src', 'caption', 'index.html'))
    this.toolbarWindow = await this.createWindow('toolbar', {
      width: 600, height: 72, x: captionX + 304, y: 88, resizable: false, focusable: true, skipTaskbar: true
    }, path.join(PROJECT_ROOT, 'src', 'toolbar', 'index.html'))
    this.unsubscribeSnapshot = this.coordinator.onSnapshot((snapshot) => {
      if (this.toolbarWindow && !this.toolbarWindow.isDestroyed()) this.toolbarWindow.webContents.send(CHANNELS.RUNTIME_CHANGED, snapshot)
    })
    this.unsubscribeCaption = this.coordinator.onCaption((event) => {
      if (this.captionWindow && !this.captionWindow.isDestroyed()) this.captionWindow.webContents.send(CHANNELS.CAPTION_EVENT, event)
    })
    this.captionWindow.showInactive()
    this.toolbarWindow.showInactive()
    this.dock()
  }

  dispose () {
    this.stopDrag(null, true)
    if (this.unsubscribeSnapshot) this.unsubscribeSnapshot()
    if (this.unsubscribeCaption) this.unsubscribeCaption()
    this.unsubscribeSnapshot = null
    this.unsubscribeCaption = null
    for (const dispose of this.disposers.splice(0)) {
      try { dispose() } catch { /* teardown isolation */ }
    }
    for (const win of [this.captionWindow, this.toolbarWindow]) {
      if (win && !win.isDestroyed()) win.destroy()
    }
    this.captionWindow = null
    this.toolbarWindow = null
  }
}

async function awaitDwmCompletion (completionPath, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000
  while (Date.now() <= deadline) {
    if (fs.existsSync(completionPath)) return parseOperatorCompletion(fs.readFileSync(completionPath))
    await delay(250)
  }
  return null
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
    const completion = await awaitDwmCompletion(options.completion, options.timeoutSeconds)
    stopPlayback = true
    await playbackLoop
    if (playbackFailure) throw playbackFailure
    const after = await readLiveTransport(activeAdapter, sourceId)
    const transport = { comparison: 'same-capture-generation', before, after, delta: transportDelta(before, after, true) }
    const operatorCompletionObserved = completion !== null
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
    return {
      result: operatorCompletionObserved && cleanTransport(finalAfter)
        ? 'pass-manual-observed'
        : 'inconclusive-manual-observation',
      scenarioEvidence: {
        mode: 'manual-dwm-harness',
        rendererAssets: 'caption-toolbar',
        manualSetBounds: true,
        operatorCompletionObserved
      },
      transport: finalTransport
    }
  } finally {
    stopPlayback = true
    harness.dispose()
  }
}

function failureEvidence (scenario) {
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
  return { mode: 'manual-dwm-harness', rendererAssets: 'caption-toolbar', manualSetBounds: true, operatorCompletionObserved: false }
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
  if (progressPath && fs.existsSync(progressPath)) throw new Error('DWM progress already exists; use a fresh artifact path')
  if (completionPath && fs.existsSync(completionPath)) throw new Error('DWM completion already exists; use a fresh artifact path')

  app.on('window-all-closed', () => {})
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
  const runUserDataPath = path.join(ARTIFACT_ROOT, 'i2-interaction-user-data', `${process.pid}-${Date.now()}`)
  fs.mkdirSync(runUserDataPath, { recursive: true })
  app.setPath('userData', runUserDataPath)
  await app.whenReady()

  let applicationRuntime = null
  let result = 'fail'
  let scenarioOutcome = null
  let adapter = null
  const captions = []
  const workers = []
  let runtimeSummary = null
  const writeProgress = (state, transport, operatorCompletionObserved) => {
    if (!progressPath) return
    const progress = buildDwmProgress({ sourceId: options.source, state, transport, operatorCompletionObserved })
    validateDwmProgress(progress)
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
      captions.push({ kind: event.kind, phase: coordinator.getSnapshot().phase })
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
    } else {
      scenarioOutcome = await runDwmDrag({ coordinator, getAdapter: composition.getAdapter, play, sourceId: options.source, options: { ...options, completion: completionPath }, writeProgress })
    }
    result = scenarioOutcome.result
  } catch (error) {
    if (options.scenario === 'dwm-drag' && progressPath) {
      const empty = blankTransport()
      writeProgress('failed', { comparison: 'same-capture-generation', before: empty, after: empty, delta: transportDelta(empty, empty, true) }, false)
    }
    scenarioOutcome = scenarioOutcome || {
      scenarioEvidence: failureEvidence(options.scenario),
      transport: {
        comparison: options.scenario === 'worker-crash-retry' ? 'cross-recovery-generation' : 'same-capture-generation',
        before: blankTransport(),
        after: blankTransport(),
        delta: options.scenario === 'worker-crash-retry' ? null : transportDelta(blankTransport(), blankTransport(), true)
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
    deviceRecovery: {
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
  stoppedTransport,
  stimulusPathForScenario,
  workspaceArtifactPath
}
