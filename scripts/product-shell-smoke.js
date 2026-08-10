'use strict'

// @ts-check

/* Real Electron product-shell journey. It loads src/main.js with an isolated
   userData directory, drives a real settings click through preload/IPC and the
   production ModelManager, then hot-activates a controlled subtitle adapter.
   It never opens a physical audio source and never kills a process by
   executable name. */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { app, BrowserWindow, dialog, ipcMain, nativeTheme, screen, utilityProcess } = require('electron')
const CHANNELS = require('../src/main/ipc/channels')
const modelManagerModule = require('../src/main/services/model-manager')
const modelRuntimeModule = require('../src/main/services/model-runtime')
const { FakeRuntimeAdapter } = require('../src/main/session/fake-runtime-adapter')
const {
  computeProductPayloadIdentity
} = require('../src/main/services/product-payload-identity')
const windowLayoutContract = require('../src/main/window-layout-contract')
const { ToolbarLayoutState } = windowLayoutContract
const {
  WindowInteractionGenerationController
} = require('../src/main/window-interaction-generation-controller')
const {
  ManualWindowInteractionController
} = require('../src/main/manual-window-interaction-controller')
const {
  restoreBoundsEquivalent
} = require('../src/main/application-window-lifecycle-controller')
const { toolbarViewportStateEquivalent } = require('../src/main/toolbar-dock-invariant')
const {
  OPERATIONS,
  PROTOCOL_VERSION,
  makeCaptionEventId,
  makeCloseSessionKey,
  makeOpenSessionKey
} = require('../src/runtime/storage-worker/protocol')

const { StorageWorkerService } = require('../src/runtime/storage-worker/worker-service')
const { WORKER_PATH: STORAGE_WORKER_PATH } = require('../src/runtime/storage-worker/worker-host')
const {
  closeFixtureModelServer,
  createFixtureModelBundle,
  seedInterruptedModelDownload,
  startFixtureModelServer
} = require('./model-ui-fixture-support')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const LONG_HISTORY_SESSION_ID = 'ci-long-history-session'
const LEGACY_HISTORY_SESSION_ID = 'ci-legacy-history-session'
const LONG_HISTORY_SEGMENT_COUNT = 205
const HISTORY_PAGE_SIZE = 50
const EXPORT_FORMATS = Object.freeze(['txt', 'md', 'srt'])
const CORE_RESOURCE_IDS = Object.freeze([
  'zipformer-bilingual-zh-en-2023-02-20',
  'x-asr-160ms',
  'silero-vad'
])
const REFINEMENT_RESOURCE_IDS = Object.freeze(['x-asr-offline'])
const B5_RUN_ID_PATTERN = /^b5-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

/* Read-only product-shell instrumentation. The production class still owns
   every generation transition and projection; this wrapper records only an
   in-memory source/generation sequence so the report never contains geometry. */
const toolbarLayoutProbe = []
for (const method of ['getOverlap', 'invalidate', 'acceptReport']) {
  const original = ToolbarLayoutState.prototype[method]
  ToolbarLayoutState.prototype[method] = function observedToolbarLayout (...args) {
    const result = original.apply(this, args)
    toolbarLayoutProbe.push({
      method,
      generation: result.generation,
      source: result.source,
      width: result.rect.width,
      height: result.rect.height
    })
    return result
  }
}
class ObservedToolbarLayoutState extends ToolbarLayoutState {
  constructor (...args) {
    super(...args)
    this.getOverlap()
  }
}
windowLayoutContract.ToolbarLayoutState = ObservedToolbarLayoutState

const windowInteractionGenerationProbe = []
let observedWindowInteractionGenerationController = null
for (const method of [
  'beginTransaction', 'resume', 'acceptMouseThrough', 'acceptGesture',
  'acceptResizeStart', 'suspendRoleForReload', 'replay', 'setNativeIgnore',
  'refreshPointerHits'
]) {
  const original = WindowInteractionGenerationController.prototype[method]
  WindowInteractionGenerationController.prototype[method] = function observedWindowInteractionGeneration (...args) {
    observedWindowInteractionGenerationController = this
    let result
    try {
      result = original.apply(this, args)
      return result
    } finally {
      const state = this.getState()
      windowInteractionGenerationProbe.push({
        method,
        role: typeof args[0] === 'string' ? args[0] : null,
        roles: Array.isArray(args[0]) ? [...args[0]] : null,
        argumentGeneration: Number.isSafeInteger(args[0])
          ? args[0]
          : (Number.isSafeInteger(args[1]?.generation) ? args[1].generation : null),
        generation: state.generation,
        phase: state.phase,
        ignore: typeof args[1] === 'boolean'
          ? args[1]
          : (typeof args[1]?.ignore === 'boolean' ? args[1].ignore : null),
        accepted: result === true
      })
    }
  }
}

let observedManualWindowInteractionController = null
let beforeObservedStopAll = null
for (const method of ['startDrag', 'stopDrag', 'startResize', 'stopResize', 'stopAll']) {
  const original = ManualWindowInteractionController.prototype[method]
  ManualWindowInteractionController.prototype[method] = function observedManualWindowInteraction (...args) {
    observedManualWindowInteractionController = this
    if (method === 'stopAll' && beforeObservedStopAll) {
      const inject = beforeObservedStopAll
      beforeObservedStopAll = null
      inject()
    }
    return original.apply(this, args)
  }
}

function isWithin (parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function parseArguments (argv) {
  const values = {
    artifactsRoot: null,
    workDir: null,
    report: null,
    mode: 'fresh',
    qualificationRunId: null,
    freshProductReportSha256: null
  }
  for (let index = 0; index < argv.length; index += 1) {
    const next = argv[index + 1]
    if (argv[index] === '--artifacts-root') { values.artifactsRoot = next; index += 1 } else if (argv[index] === '--work-dir') { values.workDir = next; index += 1 } else if (argv[index] === '--report') { values.report = next; index += 1 } else if (argv[index] === '--mode') { values.mode = next; index += 1 } else if (argv[index] === '--qualification-run-id') { values.qualificationRunId = next; index += 1 } else if (argv[index] === '--fresh-product-report-sha256') { values.freshProductReportSha256 = next; index += 1 } else throw new Error(`unknown argument: ${argv[index]}`)
  }
  if (!values.workDir || !values.report) throw new Error('--work-dir and --report are required')
  if (!['fresh', 'restart'].includes(values.mode)) throw new Error('--mode must be fresh or restart')
  if (values.artifactsRoot !== null && (!path.isAbsolute(values.artifactsRoot) ||
      path.resolve(values.artifactsRoot) === path.parse(path.resolve(values.artifactsRoot)).root)) {
    throw new Error('--artifacts-root must be an absolute non-root directory')
  }
  const artifacts = values.artifactsRoot === null
    ? path.join(PROJECT_ROOT, '.artifacts')
    : path.resolve(values.artifactsRoot)
  const workDir = values.artifactsRoot === null
    ? path.resolve(PROJECT_ROOT, values.workDir)
    : path.resolve(artifacts, values.workDir)
  const report = values.artifactsRoot === null
    ? path.resolve(PROJECT_ROOT, values.report)
    : path.resolve(artifacts, values.report)
  if (!isWithin(artifacts, workDir) || !isWithin(artifacts, report)) throw new Error('smoke outputs must stay under .artifacts')
  if (values.mode === 'fresh' && fs.existsSync(workDir)) throw new Error('work directory must not already exist')
  if (values.mode === 'restart' && !fs.statSync(workDir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('restart work directory must already exist')
  }
  if (fs.existsSync(report)) throw new Error('smoke report must not already exist')
  if (app.isPackaged && !B5_RUN_ID_PATTERN.test(String(values.qualificationRunId || ''))) {
    throw new Error('packaged smoke requires a valid qualification run id')
  }
  if (app.isPackaged && values.mode === 'restart' &&
      !SHA256_PATTERN.test(String(values.freshProductReportSha256 || ''))) {
    throw new Error('packaged restart requires the exact fresh product report digest')
  }
  if (values.mode === 'fresh' && values.freshProductReportSha256 !== null) {
    throw new Error('fresh smoke cannot accept a previous product report digest')
  }
  return {
    artifacts,
    workDir,
    report,
    mode: values.mode,
    qualificationRunId: values.qualificationRunId,
    freshProductReportSha256: values.freshProductReportSha256
  }
}

function sha256File (filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function windowFor (suffix) {
  const normalized = suffix.replace(/\\/g, '/')
  return BrowserWindow.getAllWindows().find((win) => {
    if (win.isDestroyed()) return false
    return decodeURIComponent(win.webContents.getURL()).replace(/\\/g, '/').endsWith(normalized)
  }) || null
}

async function waitFor (probe, label, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) { lastError = error }
    await new Promise((resolve) => setTimeout(resolve, 80))
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`)
}

function rendererValue (win, expression) {
  if (!win || win.isDestroyed()) throw new Error('renderer window is unavailable')
  return win.webContents.executeJavaScript(expression)
}

function sameWindowBounds (left, right) {
  return left.x === right.x && left.y === right.y &&
    left.width === right.width && left.height === right.height
}

function productWindowBounds (role, win) {
  return role === 'toolbar' ? win.getContentBounds() : win.getBounds()
}

function visibleApplicationWindowRoles ({ caption, toolbar, settings, history }) {
  return [
    ['caption', caption],
    ['toolbar', toolbar],
    ['settings', settings],
    ['history', history]
  ].filter(([, win]) => win && !win.isDestroyed() && win.isVisible() && !win.isMinimized())
    .map(([role]) => role)
}

function applicationBoundsPreserved (windows, expected) {
  return Object.entries(windows)
    .every(([role, win]) => role === 'toolbar'
      ? toolbarViewportStateEquivalent(win, expected[role])
      : restoreBoundsEquivalent(role, productWindowBounds(role, win), expected[role]))
}

function applicationBoundsMismatchRoles (windows, expected) {
  return Object.entries(windows)
    .filter(([role, win]) => role === 'toolbar'
      ? !toolbarViewportStateEquivalent(win, expected[role])
      : !restoreBoundsEquivalent(role, productWindowBounds(role, win), expected[role]))
    .map(([role]) => role)
}

async function exerciseApplicationLifecycle ({ caption, toolbar, settings, rawSessionId, cursor }) {
  const minimizeControlVisible = await rendererValue(toolbar, `(() => {
    const button = document.querySelector('button[data-act="minimize"]')
    return !!button && button.getAttribute('aria-label') === '最小化'
  })()`)
  await rendererValue(toolbar, `document.querySelector('button[data-act="history"]').click(); true`)
  const history = await waitFor(() => windowFor('/history/index.html'), 'lifecycle history renderer')
  await waitFor(() => !history.webContents.isLoading(), 'lifecycle history load')
  history.focus()
  await waitFor(() => history.isFocused(), 'lifecycle history focus')

  const windows = { caption, toolbar, settings, history }
  await Promise.all(Object.entries(windows).map(([role, win]) => rendererValue(win, `(() => {
    window.__j19InteractionSync = []
    const interactionApi = ${role === 'history' ? 'window.historyApi' : 'window.shell'}
    interactionApi.onInteractionSync((value) => window.__j19InteractionSync.push({
      schemaVersion: value.schemaVersion,
      generation: value.generation,
      phase: value.phase,
      pointerPresent: value.phase === 'resume' && value.pointer !== null
    }))
    return '${role}'
  })()`)))
  const generationProbeStart = windowInteractionGenerationProbe.length
  const initialGeneration = observedWindowInteractionGenerationController?.getState().generation
  if (!Number.isSafeInteger(initialGeneration)) throw new Error('window interaction generation controller was not observed')
  await Promise.all(Object.entries(windows).map(([role, win]) => waitFor(() => rendererValue(win,
    `window.__j19InteractionSync.at(-1)?.phase === 'resume'`), `${role} initial interaction resume`)))
  const visibleBefore = visibleApplicationWindowRoles(windows)
  const snapshotBefore = await rendererValue(toolbar, `window.shell.getSnapshot()`)
  if (snapshotBefore.phase !== 'listening' || snapshotBefore.sessionId !== rawSessionId ||
      visibleBefore.join(',') !== 'caption,toolbar,settings,history') {
    throw new Error('application lifecycle did not start from four visible windows and one listening session')
  }
  const toolbarBoundsBeforeGesture = toolbar.getContentBounds()
  if (toolbarBoundsBeforeGesture.width !== windowLayoutContract.WINDOW_LAYOUT.toolbarViewportWidth ||
      toolbarBoundsBeforeGesture.height !== windowLayoutContract.WINDOW_LAYOUT.toolbarViewportHeight) {
    throw new Error('pre-gesture toolbar viewport unsettled')
  }

  const captionCard = "document.getElementById('captionCard')"
  const captionDragPoint = `target => { const r = target.getBoundingClientRect(); return { x: r.left + 80, y: r.top + r.height * 0.55 } }`
  const activePoint = await rendererPointerPoint(caption, captionCard, captionDragPoint)
  const activeOrigin = screenPointForRenderer(caption, activePoint)
  const captionBoundsBeforeGesture = caption.getBounds()
  cursor.set(activeOrigin)
  await dispatchRendererPointer(caption, captionCard, activePoint, 'pointerdown', 901)
  const preMinimizeRendererState = await rendererValue(caption, `(() => ({
    dragging: document.getElementById('captionCard').classList.contains('dragging'),
    locked: document.getElementById('wrap').dataset.locked === 'on',
    phase: window.__j19InteractionSync.at(-1)?.phase || null,
    generation: window.__j19InteractionSync.at(-1)?.generation || null
  }))()`)
  if (!preMinimizeRendererState.dragging) {
    throw new Error(`pre-minimize renderer gesture rejected locked=${preMinimizeRendererState.locked} phase=${preMinimizeRendererState.phase} generation=${preMinimizeRendererState.generation}`)
  }
  cursor.set({ x: activeOrigin.x + 7, y: activeOrigin.y + 5 })
  const captionBoundsBeforeMinimize = await waitFor(() => {
    const next = caption.getBounds()
    return sameWindowBounds(next, captionBoundsBeforeGesture) ? null : next
  }, 'pre-minimize active caption gesture')
  const toolbarBoundsBeforeMinimize = await waitFor(() => {
    const bounds = toolbar.getContentBounds()
    return bounds.width === windowLayoutContract.WINDOW_LAYOUT.toolbarViewportWidth &&
      bounds.height === windowLayoutContract.WINDOW_LAYOUT.toolbarViewportHeight
      ? bounds
      : null
  }, 'active group drag fixed toolbar viewport before minimize', 1000)
  const boundsBefore = Object.fromEntries(Object.entries(windows)
    .map(([role, win]) => [role, productWindowBounds(role, win)]))
  const stationaryOrigin = screenPointForRenderer(caption, activePoint)

  await rendererValue(toolbar, `document.querySelector('button[data-act="minimize"]').click(); true`)
  await waitFor(() => toolbar.isMinimized() && !caption.isVisible() &&
    settings.isMinimized() && history.isMinimized(), 'application minimize')
  const snapshotWhileMinimized = await rendererValue(toolbar, `window.shell.getSnapshot()`)
  const activeSessionContinuedWhileMinimized =
    JSON.stringify(snapshotWhileMinimized) === JSON.stringify(snapshotBefore) &&
    snapshotWhileMinimized.phase === 'listening' && snapshotWhileMinimized.sessionId === rawSessionId
  const captionHiddenWhileMinimized = !caption.isVisible()
  const minimizedAuxiliaryWindowCount = [settings, history].filter((win) => win.isMinimized()).length
  cursor.set({ x: stationaryOrigin.x + 29, y: stationaryOrigin.y + 17 })
  await new Promise((resolve) => setTimeout(resolve, 40))
  const preMinimizeGestureResetObserved = sameWindowBounds(caption.getBounds(), captionBoundsBeforeMinimize)

  cursor.set(stationaryOrigin)
  let lateBoundsListenerInstalled = false
  let lateBoundsDriftInjected = false
  let lateBoundsDriftInjectedDuringSuspend = false
  let lateBoundsInjectionStarted = false
  let lateMoveObserved = false
  let lateResizeObserved = false
  const injectedHistoryBounds = {
    ...boundsBefore.history,
    x: boundsBefore.history.x + 11,
    width: boundsBefore.history.width + 7
  }
  const observeLateBoundsListener = (eventName) => {
    if (eventName !== 'resize' || lateBoundsListenerInstalled) return
    lateBoundsListenerInstalled = true
    queueMicrotask(() => {
      lateBoundsDriftInjectedDuringSuspend =
        observedWindowInteractionGenerationController.getState().phase === 'suspend'
      lateBoundsInjectionStarted = true
      history.setBounds(injectedHistoryBounds)
      lateBoundsDriftInjected = true
    })
  }
  const observeLateMove = () => {
    if (lateBoundsInjectionStarted) lateMoveObserved = true
  }
  const observeLateResize = () => {
    if (lateBoundsInjectionStarted) lateResizeObserved = true
  }
  history.on('move', observeLateMove)
  history.on('resize', observeLateResize)
  history.on('newListener', observeLateBoundsListener)
  toolbar.restore()
  try {
    await waitFor(() => visibleApplicationWindowRoles(windows).join(',') === visibleBefore.join(',') &&
      !toolbar.isMinimized() && !settings.isMinimized() && !history.isMinimized() &&
      observedWindowInteractionGenerationController.getState().phase === 'suspend' &&
      lateBoundsListenerInstalled && lateBoundsDriftInjected && lateBoundsDriftInjectedDuringSuspend &&
      lateMoveObserved && lateResizeObserved,
    'native taskbar restore settlement')
  } finally {
    history.off('newListener', observeLateBoundsListener)
  }
  try {
    await waitFor(() => restoreBoundsEquivalent('history', history.getBounds(), boundsBefore.history) &&
      observedWindowInteractionGenerationController.getState().phase === 'suspend',
    'late native bounds correction before interaction resume')
    try {
      await waitFor(() => visibleApplicationWindowRoles(windows).join(',') === visibleBefore.join(',') &&
        !toolbar.isMinimized() && !settings.isMinimized() && !history.isMinimized() &&
        observedWindowInteractionGenerationController.getState().phase === 'resume', 'native taskbar restore')
    } catch {
      const mismatchRoles = applicationBoundsMismatchRoles(windows, boundsBefore)
      const phase = observedWindowInteractionGenerationController.getState().phase
      throw new Error(`native taskbar restore unresolved bounds roles=${mismatchRoles.join(',') || 'none'} phase=${phase}`)
    }
  } finally {
    history.off('move', observeLateMove)
    history.off('resize', observeLateResize)
  }
  await new Promise((resolve) => setTimeout(resolve, 80))
  const nativeSnapshot = await rendererValue(toolbar, `window.shell.getSnapshot()`)
  const nativeRestorePreservedWindowSet =
    visibleApplicationWindowRoles(windows).join(',') === visibleBefore.join(',')
  const nativeRestorePreservedBounds = applicationBoundsPreserved(windows, boundsBefore)
  if (!nativeRestorePreservedBounds) {
    const mismatchRoles = applicationBoundsMismatchRoles(windows, boundsBefore)
    throw new Error(`native taskbar restore changed bounds for roles=${mismatchRoles.join(',')}`)
  }
  const nativeRestorePreservedRuntimeSnapshot =
    JSON.stringify(nativeSnapshot) === JSON.stringify(snapshotBefore)

  const nativeRestoreGeneration = observedWindowInteractionGenerationController.getState().generation
  const stationaryPointerHitIntentObserved = await waitFor(() => windowInteractionGenerationProbe
    .slice(generationProbeStart)
    .some((entry) => entry.method === 'acceptMouseThrough' && entry.role === 'caption' &&
      entry.argumentGeneration === nativeRestoreGeneration && entry.ignore === false && entry.accepted),
  'stationary caption hit intent after native restore')
  await assertRendererGestureMoves({
    sourceWindow: caption,
    targetWindow: caption,
    targetExpression: captionCard,
    pointExpression: captionDragPoint,
    pointerId: 902,
    cursor,
    endType: 'pointerup'
  })
  const postRestoreCaptionDragIntentObserved = true

  const staleGenerationIntentRejected = observedWindowInteractionGenerationController.acceptGesture('caption', {
    schemaVersion: 1,
    generation: nativeRestoreGeneration - 1
  }) === false
  const boundsBeforeSecondMinimize = Object.fromEntries(
    Object.entries(windows).map(([role, win]) => [role, productWindowBounds(role, win)])
  )

  await rendererValue(toolbar, `document.querySelector('button[data-act="lock"]').click(); true`)
  await waitFor(() => rendererValue(toolbar, 'window.shell.getLock()'), 'lifecycle lock before second restore')

  await rendererValue(toolbar, `document.querySelector('button[data-act="minimize"]').click(); true`)
  await waitFor(() => toolbar.isMinimized() && !caption.isVisible() &&
    settings.isMinimized() && history.isMinimized(), 'second application minimize')
  app.emit('second-instance')
  await waitFor(() => visibleApplicationWindowRoles(windows).join(',') === visibleBefore.join(',') &&
    !toolbar.isMinimized() &&
    observedWindowInteractionGenerationController.getState().phase === 'resume',
  'second-instance restore visibility')
  const secondInstanceMismatchRoles = applicationBoundsMismatchRoles(windows, boundsBeforeSecondMinimize)
  if (secondInstanceMismatchRoles.length > 0) {
    throw new Error(`second-instance restore changed bounds for roles=${secondInstanceMismatchRoles.join(',')}`)
  }
  const secondInstanceRestoredPrimary = toolbar.isVisible() && !toolbar.isMinimized()
  const secondInstancePreservedWindowSet =
    visibleApplicationWindowRoles(windows).join(',') === visibleBefore.join(',')
  const secondInstancePreservedBounds = applicationBoundsPreserved(windows, boundsBeforeSecondMinimize)
  const secondInstanceRestoreGeneration = observedWindowInteractionGenerationController.getState().generation
  const lockedCaptionPassThroughIntentObserved = await waitFor(() => windowInteractionGenerationProbe
    .slice(generationProbeStart)
    .some((entry) => entry.method === 'acceptMouseThrough' && entry.role === 'caption' &&
      entry.argumentGeneration === secondInstanceRestoreGeneration && entry.ignore === true && entry.accepted),
  'locked caption pass-through intent after second-instance restore')
  await rendererValue(toolbar, `document.querySelector('button[data-act="lock"]').click(); true`)
  await waitFor(async () => (await rendererValue(toolbar, 'window.shell.getLock()')) === false,
    'lifecycle unlock after second restore')

  const rendererSyncs = Object.fromEntries(await Promise.all(Object.entries(windows).map(async ([role, win]) => [
    role,
    await rendererValue(win, '[...window.__j19InteractionSync]')
  ])))
  const beginGenerations = windowInteractionGenerationProbe.slice(generationProbeStart)
    .filter((entry) => entry.method === 'beginTransaction')
    .map((entry) => entry.generation)
  const expectedGenerations = [1, 2, 3, 4].map((offset) => initialGeneration + offset)
  const sameGenerationSuspendResumeObserved = [nativeRestoreGeneration, secondInstanceRestoreGeneration]
    .every((generation) => Object.values(rendererSyncs).every((events) =>
      events.some((entry) => entry.generation === generation && entry.phase === 'suspend') &&
      events.some((entry) => entry.generation === generation && entry.phase === 'resume')))

  await rendererValue(settings, `document.getElementById('close').click(); true`)
  await waitFor(() => settings.isDestroyed(), 'settings local close')
  await rendererValue(history, `document.getElementById('close').click(); true`)
  await waitFor(() => history.isDestroyed(), 'history local close')
  const auxiliaryCloseKeptPrimary = !toolbar.isDestroyed() && toolbar.isVisible() &&
    !caption.isDestroyed() && caption.isVisible()

  await rendererValue(toolbar, `document.querySelector('button[data-act="settings"]').click(); true`)
  const reopenedSettings = await waitFor(() => windowFor('/settings/settings.html'), 'reopened settings renderer')
  await waitFor(() => !reopenedSettings.webContents.isLoading(), 'reopened settings load')

  return {
    settings: reopenedSettings,
    interactionContext: {
      generationProbeStart,
      generationAdvanceCount: beginGenerations.length,
      preMinimizeGestureResetObserved,
      minimizeGenerationAdvanced: beginGenerations[0] === expectedGenerations[0],
      nativeRestoreGenerationAdvanced: beginGenerations[1] === expectedGenerations[1],
      secondInstanceRestoreGenerationAdvanced:
        beginGenerations[2] === expectedGenerations[2] && beginGenerations[3] === expectedGenerations[3],
      sameGenerationSuspendResumeObserved,
      stationaryPointerHitIntentObserved,
      postRestoreCaptionDragIntentObserved,
      staleGenerationIntentRejected,
      nativePassThroughIntentObserved: windowInteractionGenerationProbe.slice(generationProbeStart).some((entry) =>
        entry.method === 'setNativeIgnore' && entry.role === 'caption' && entry.ignore === true && entry.accepted),
      lockedCaptionPassThroughIntentObserved
    },
    evidence: {
      primaryWindowMinimizable: toolbar.isMinimizable(),
      primaryWindowTitleStable: toolbar.getTitle() === 'Live Subtitle',
      minimizeControlVisible,
      activeSessionContinuedWhileMinimized,
      captionHiddenWhileMinimized,
      visibleAuxiliaryWindowCountBeforeMinimize: 2,
      minimizedAuxiliaryWindowCount,
      nativeRestorePreservedWindowSet,
      nativeRestorePreservedBounds,
      nativeRestorePreservedRuntimeSnapshot,
      secondInstanceRestoredPrimary,
      secondInstancePreservedWindowSet,
      secondInstancePreservedBounds,
      auxiliaryCloseKeptPrimary,
      rendererExitRequested: false
    }
  }
}

function installControlledCursorBoundary () {
  const original = screen.getCursorScreenPoint
  let point = original.call(screen)
  screen.getCursorScreenPoint = () => ({ ...point })
  if (screen.getCursorScreenPoint().x !== point.x || screen.getCursorScreenPoint().y !== point.y) {
    throw new Error('controlled cursor boundary could not be installed')
  }
  return {
    set (next) { point = { x: Math.round(next.x), y: Math.round(next.y) } },
    restore () { screen.getCursorScreenPoint = original }
  }
}

async function rendererPointerPoint (win, targetExpression, pointExpression) {
  return rendererValue(win, `(() => {
    const target = ${targetExpression}
    if (!target) throw new Error('pointer target unavailable')
    const point = (${pointExpression})(target)
    return { x: Number(point.x), y: Number(point.y) }
  })()`)
}

async function dispatchRendererPointer (win, targetExpression, point, type, pointerId) {
  const literal = JSON.stringify({ ...point, type, pointerId })
  return rendererValue(win, `(() => {
    const target = ${targetExpression}
    const detail = ${literal}
    if (!target) throw new Error('pointer target unavailable')
    return target.dispatchEvent(new PointerEvent(detail.type, {
      bubbles: true,
      composed: true,
      cancelable: true,
      pointerId: detail.pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: detail.type === 'pointerdown' || detail.type === 'pointermove' ? 1 : 0,
      clientX: detail.x,
      clientY: detail.y
    }))
  })()`)
}

function screenPointForRenderer (win, point) {
  const bounds = win.getContentBounds()
  return { x: bounds.x + point.x, y: bounds.y + point.y }
}

async function assertRendererGestureMoves ({
  sourceWindow,
  targetWindow,
  targetExpression,
  pointExpression,
  pointerId,
  cursor,
  delta = { x: 13, y: 9 },
  armDelta = null,
  endType = 'pointerup',
  afterStart = null
}) {
  const localPoint = await rendererPointerPoint(sourceWindow, targetExpression, pointExpression)
  const origin = screenPointForRenderer(sourceWindow, localPoint)
  const before = targetWindow.getBounds()
  cursor.set(origin)
  await dispatchRendererPointer(sourceWindow, targetExpression, localPoint, 'pointerdown', pointerId)
  if (armDelta) {
    cursor.set({ x: origin.x + armDelta.x, y: origin.y + armDelta.y })
    await dispatchRendererPointer(sourceWindow, 'window', {
      x: localPoint.x + armDelta.x,
      y: localPoint.y + armDelta.y
    }, 'pointermove', pointerId)
  }
  if (afterStart) await afterStart()
  cursor.set({ x: origin.x + delta.x, y: origin.y + delta.y })
  const moved = await waitFor(() => {
    const next = targetWindow.getBounds()
    return sameWindowBounds(next, before) ? null : next
  }, 'manual window first pointer delta', 3000)
  const endTarget = endType === 'lostpointercapture' ? targetExpression : 'window'
  await dispatchRendererPointer(sourceWindow, endTarget, localPoint, endType, pointerId)
  const ended = targetWindow.getBounds()
  cursor.set({ x: origin.x + delta.x * 2, y: origin.y + delta.y * 2 })
  await new Promise((resolve) => setTimeout(resolve, 40))
  if (!sameWindowBounds(targetWindow.getBounds(), ended)) throw new Error(`${endType} did not stop manual window movement`)
  return { before, moved, ended }
}

async function assertRendererGestureStatic ({
  sourceWindow,
  targetWindow,
  targetExpression,
  pointExpression,
  pointerId,
  cursor,
  endType = 'pointerup'
}) {
  const localPoint = await rendererPointerPoint(sourceWindow, targetExpression, pointExpression)
  const origin = screenPointForRenderer(sourceWindow, localPoint)
  const before = targetWindow.getBounds()
  cursor.set(origin)
  await dispatchRendererPointer(sourceWindow, targetExpression, localPoint, 'pointerdown', pointerId)
  cursor.set({ x: origin.x + 19, y: origin.y + 11 })
  await new Promise((resolve) => setTimeout(resolve, 40))
  const endTarget = endType === 'lostpointercapture' ? targetExpression : 'window'
  await dispatchRendererPointer(sourceWindow, endTarget, localPoint, endType, pointerId)
  if (!sameWindowBounds(targetWindow.getBounds(), before)) throw new Error('excluded pointer target moved a window')
  return true
}

async function reportCurrentToolbarContour (toolbar, generationOverride = null) {
  return rendererValue(toolbar, `(async () => {
    const context = await window.shell.getToolbarLayoutContext()
    const rect = document.getElementById('toolbar').getBoundingClientRect()
    const generation = ${generationOverride === null ? 'context.generation' : Number(generationOverride)}
    window.shell.reportToolbarLayout({
      generation,
      rect: { x: Number(rect.x), y: Number(rect.y), width: Number(rect.width), height: Number(rect.height) }
    })
    return { generation: context.generation, width: Number(rect.width), height: Number(rect.height) }
  })()`)
}

async function waitForLayoutProbe (startIndex, predicate, label) {
  return waitFor(() => toolbarLayoutProbe.slice(startIndex).find(predicate) || null, label, 5000)
}

async function beginWindowInteractionLayoutProbe (toolbar, caption) {
  await rendererValue(caption, `(() => {
    window.__j17ToolbarOverlapEvents = []
    window.shell.onToolbarOverlap((value) => window.__j17ToolbarOverlapEvents.push(value))
    return true
  })()`)
  const firstFrameFallbackObserved = toolbarLayoutProbe.some((entry) =>
    entry.generation === 1 && entry.source === 'fallback')
  const beforeValid = toolbarLayoutProbe.length
  const beforeValidRehit = windowInteractionGenerationProbe.length
  const attention = await reportCurrentToolbarContour(toolbar)
  await waitForLayoutProbe(beforeValid, (entry) => entry.method === 'acceptReport' && entry.source === 'toolbar',
    'initial valid toolbar contour')
  const validContourRehitObserved = await waitFor(() => windowInteractionGenerationProbe
    .slice(beforeValidRehit)
    .some((entry) => entry.method === 'refreshPointerHits' && entry.accepted === true &&
      entry.roles?.join(',') === 'caption,toolbar'), 'valid contour dual-renderer rehit')
  return {
    attention,
    firstFrameFallbackObserved,
    validContourRehitObserved
  }
}

async function observeToolbarStateContourChange (toolbar, probe, cursor) {
  await rendererValue(toolbar, `(() => {
    const element = document.getElementById('toolbar')
    const rect = element.getBoundingClientRect()
    const width = Math.min(480, Math.max(280, Math.floor(rect.width) - 48))
    element.style.width = width + 'px'
    element.style.minWidth = width + 'px'
    element.style.maxWidth = width + 'px'
    element.style.flex = '0 0 ' + width + 'px'
    element.style.overflow = 'hidden'
    return true
  })()`)
  const before = toolbarLayoutProbe.length
  const quiet = await reportCurrentToolbarContour(toolbar)
  await waitForLayoutProbe(before, (entry) => entry.method === 'acceptReport' && entry.source === 'toolbar',
    'quiet toolbar contour')
  probe.quiet = quiet
  probe.toolbarStateContourChangeObserved = quiet.width !== probe.attention.width || quiet.height !== probe.attention.height

  /* Hold a real renderer-local pointer just outside the quiet contour, then
     expand the real DOM contour without another mousemove. ResizeObserver must
     make toolbar solid before the deferred layout report asks main to re-hit
     both HWNDs; otherwise the first button in the new area can fall through. */
  const expansion = await rendererValue(toolbar, `(() => {
    const element = document.getElementById('toolbar')
    const rect = element.getBoundingClientRect()
    return {
      point: { x: Math.max(1, Math.floor(rect.left) - 8), y: Math.floor(rect.top + rect.height / 2) },
      width: Math.min(568, Math.ceil(rect.width) + 32)
    }
  })()`)
  cursor.set(screenPointForRenderer(toolbar, expansion.point))
  await rendererValue(toolbar, `document.dispatchEvent(new MouseEvent('mousemove', {
    bubbles: true,
    clientX: ${Number(expansion.point.x)},
    clientY: ${Number(expansion.point.y)}
  })); true`)
  const expansionProbeStart = windowInteractionGenerationProbe.length
  const expansionLayoutStart = toolbarLayoutProbe.length
  await rendererValue(toolbar, `(() => {
    const element = document.getElementById('toolbar')
    element.style.width = '${Number(expansion.width)}px'
    element.style.minWidth = '${Number(expansion.width)}px'
    element.style.maxWidth = '${Number(expansion.width)}px'
    element.style.flex = '0 0 ${Number(expansion.width)}px'
    return true
  })()`)
  await waitFor(() => windowInteractionGenerationProbe.slice(expansionProbeStart)
    .some((entry) => entry.method === 'acceptMouseThrough' &&
      entry.role === 'toolbar' && entry.ignore === false && entry.accepted === true),
  'stationary expanded contour becomes solid locally')
  const expanded = await reportCurrentToolbarContour(toolbar)
  if (expanded.width <= quiet.width) throw new Error('toolbar contour style did not expand')
  await waitForLayoutProbe(expansionLayoutStart,
    (entry) => entry.method === 'acceptReport' && entry.source === 'toolbar' && entry.width > quiet.width,
    'expanded toolbar contour report')
  await waitFor(() => {
    const entries = windowInteractionGenerationProbe.slice(expansionProbeStart)
    const solidIndex = entries.findIndex((entry) => entry.method === 'acceptMouseThrough' &&
      entry.role === 'toolbar' && entry.ignore === false && entry.accepted === true)
    const refreshIndex = entries.findIndex((entry) => entry.method === 'refreshPointerHits' &&
      entry.roles?.join(',') === 'caption,toolbar')
    return solidIndex >= 0 && refreshIndex >= 0 && solidIndex < refreshIndex
  }, 'stationary expanded contour becomes solid before dual rehit')
  const shrinkProbeStart = windowInteractionGenerationProbe.length
  await rendererValue(toolbar, `(() => {
    const element = document.getElementById('toolbar')
    element.style.width = '${Number(quiet.width)}px'
    element.style.minWidth = '${Number(quiet.width)}px'
    element.style.maxWidth = '${Number(quiet.width)}px'
    element.style.flex = '0 0 ${Number(quiet.width)}px'
    return true
  })()`)
  await waitFor(() => windowInteractionGenerationProbe.slice(shrinkProbeStart)
    .some((entry) => entry.method === 'acceptMouseThrough' && entry.role === 'toolbar' &&
      entry.ignore === true && entry.accepted === true), 'stationary shrunken contour becomes pass-through')
  await rendererValue(toolbar, `(() => {
    const element = document.getElementById('toolbar')
    element.style.width = ''
    element.style.minWidth = ''
    element.style.maxWidth = ''
    element.style.flex = ''
    element.style.overflow = ''
    return true
  })()`)
  probe.stationaryContourExpansionSolidObserved = true
}

async function completeWindowInteractionLayoutProbe (toolbar, probe) {
  const current = await rendererValue(toolbar, 'window.shell.getToolbarLayoutContext()')
  const beforeInvalid = toolbarLayoutProbe.length
  await rendererValue(toolbar, `(() => {
    window.shell.reportToolbarLayout({
      generation: ${current.generation},
      rect: { x: -1, y: 0, width: 1, height: 1 }
    })
    return true
  })()`)
  await waitForLayoutProbe(beforeInvalid,
    (entry) => entry.method === 'acceptReport' && entry.source === 'fallback',
    'invalid toolbar contour fallback')
  const beforeInvalidRecovery = toolbarLayoutProbe.length
  await reportCurrentToolbarContour(toolbar)
  await waitForLayoutProbe(beforeInvalidRecovery,
    (entry) => entry.method === 'acceptReport' && entry.source === 'toolbar',
    'invalid toolbar contour recovery')

  const generationBeforeReload = current.generation
  const beforeReload = toolbarLayoutProbe.length
  toolbar.webContents.reload()
  await waitFor(() => !toolbar.webContents.isLoading(), 'toolbar renderer reload')
  const generationAfterReload = await waitFor(async () => {
    const next = await rendererValue(toolbar, 'window.shell.getToolbarLayoutContext()')
    return next.generation > generationBeforeReload ? next.generation : 0
  }, 'toolbar reload generation')
  await waitForLayoutProbe(beforeReload,
    (entry) => entry.method === 'invalidate' && entry.source === 'fallback' && entry.generation === generationAfterReload,
    'toolbar reload fallback')
  await waitForLayoutProbe(beforeReload,
    (entry) => entry.method === 'acceptReport' && entry.source === 'toolbar' && entry.generation === generationAfterReload,
    'toolbar reload recovery')

  const beforeStale = toolbarLayoutProbe.length
  await reportCurrentToolbarContour(toolbar, generationBeforeReload)
  await waitForLayoutProbe(beforeStale,
    (entry) => entry.method === 'acceptReport' && entry.source === 'fallback' && entry.generation === generationAfterReload,
    'stale toolbar generation fallback')
  const beforeStaleRecovery = toolbarLayoutProbe.length
  await reportCurrentToolbarContour(toolbar)
  await waitForLayoutProbe(beforeStaleRecovery,
    (entry) => entry.method === 'acceptReport' && entry.source === 'toolbar' && entry.generation === generationAfterReload,
    'stale toolbar generation recovery')

  const fallbacks = toolbarLayoutProbe.filter((entry) => entry.source === 'fallback')
  const recoveries = toolbarLayoutProbe.filter((entry) => entry.source === 'toolbar')
  return {
    firstFrameFallbackObserved: probe.firstFrameFallbackObserved,
    validContourObserved: recoveries.length > 0 && probe.validContourRehitObserved === true &&
      probe.stationaryContourExpansionSolidObserved === true,
    validContourShrinkObserved: recoveries.some((entry) => entry.width < 588 || entry.height < 64),
    toolbarStateContourChangeObserved: probe.toolbarStateContourChangeObserved,
    reloadGenerationFallbackObserved: true,
    reloadValidRecoveryObserved: true,
    invalidContourFallbackObserved: true,
    staleGenerationFallbackObserved: true,
    postFailureRecoveryObserved: true,
    layoutFallbackObservationCount: fallbacks.length,
    layoutRecoveryObservationCount: recoveries.length
  }
}

async function assertStationaryPressRelease ({
  sourceWindow,
  targetWindow,
  targetExpression,
  pointExpression,
  pointerId,
  cursor
}) {
  const point = await rendererPointerPoint(sourceWindow, targetExpression, pointExpression)
  const origin = screenPointForRenderer(sourceWindow, point)
  const before = targetWindow.getBounds()
  cursor.set(origin)
  await dispatchRendererPointer(sourceWindow, targetExpression, point, 'pointerdown', pointerId)
  await dispatchRendererPointer(sourceWindow, 'window', point, 'pointerup', pointerId)
  await new Promise((resolve) => setTimeout(resolve, 40))
  if (!sameWindowBounds(targetWindow.getBounds(), before)) throw new Error('stationary press/release changed window bounds')
  return true
}

async function assertCancellationBeforeMove ({
  sourceWindow,
  targetWindow,
  targetExpression,
  pointExpression,
  pointerId,
  cursor,
  cancel
}) {
  const point = await rendererPointerPoint(sourceWindow, targetExpression, pointExpression)
  const origin = screenPointForRenderer(sourceWindow, point)
  const before = targetWindow.getBounds()
  cursor.set(origin)
  await dispatchRendererPointer(sourceWindow, targetExpression, point, 'pointerdown', pointerId)
  await cancel(point)
  cursor.set({ x: origin.x + 23, y: origin.y + 15 })
  await new Promise((resolve) => setTimeout(resolve, 40))
  if (!sameWindowBounds(targetWindow.getBounds(), before)) throw new Error('gesture cancellation left manual movement active')
  return true
}

async function assertResizeClickSlop ({ caption, toolbar, cursor, targetExpression, pointExpression, pointerId }) {
  const point = await rendererPointerPoint(caption, targetExpression, pointExpression)
  const origin = screenPointForRenderer(caption, point)
  const captionBefore = caption.getBounds()
  const toolbarBefore = toolbar.getBounds()
  const resizeIntentStart = windowInteractionGenerationProbe.length
  cursor.set(origin)
  await dispatchRendererPointer(caption, targetExpression, point, 'pointerdown', pointerId)
  cursor.set({ x: origin.x - 3, y: origin.y + 1 })
  await dispatchRendererPointer(caption, 'window', { x: point.x - 3, y: point.y + 1 }, 'pointermove', pointerId)
  await new Promise((resolve) => setTimeout(resolve, 40))
  await dispatchRendererPointer(caption, 'window', point, 'pointerup', pointerId)
  if (!sameWindowBounds(caption.getBounds(), captionBefore) ||
      !sameWindowBounds(toolbar.getBounds(), toolbarBefore)) {
    throw new Error('sub-threshold resize click changed caption or toolbar bounds')
  }
  if (windowInteractionGenerationProbe.slice(resizeIntentStart)
    .some((entry) => entry.method === 'acceptResizeStart') ||
      observedManualWindowInteractionController?.isResizing() !== false) {
    throw new Error('sub-threshold resize click started a resize intent or main timer')
  }
}

async function assertPendingResizeCrossOverlayTerminal ({ caption, toolbar, cursor, targetExpression, pointExpression }) {
  const point = await rendererPointerPoint(caption, targetExpression, pointExpression)
  const origin = screenPointForRenderer(caption, point)
  const generationBefore = observedWindowInteractionGenerationController.getState().generation
  const resizeIntentStart = windowInteractionGenerationProbe.length
  cursor.set(origin)
  await dispatchRendererPointer(caption, targetExpression, point, 'pointerdown', 119)
  caption.webContents.emit('before-mouse-event', {}, {
    type: 'mouseDown', button: 'left', modifiers: ['leftbuttondown']
  })
  toolbar.webContents.emit('before-mouse-event', {}, {
    type: 'mouseUp', button: 'left', modifiers: []
  })
  await waitFor(() => {
    const state = observedWindowInteractionGenerationController.getState()
    return state.generation > generationBefore && state.phase === 'resume'
  }, 'pending resize cross-overlay generation reset')
  if (windowInteractionGenerationProbe.slice(resizeIntentStart)
    .some((entry) => entry.method === 'acceptResizeStart') ||
      observedManualWindowInteractionController?.isResizing() !== false) {
    throw new Error('pending resize cross-overlay release started a resize timer')
  }
  await assertRendererGestureMoves({
    sourceWindow: caption,
    targetWindow: caption,
    targetExpression,
    pointExpression: `target => { const r = target.getBoundingClientRect(); return {
      x: r.left + 80, y: r.top + r.height * 0.55
    } }`,
    pointerId: 1119,
    cursor,
    delta: { x: 11, y: 7 },
    endType: 'pointerup'
  })
  const lockBefore = await rendererValue(toolbar, 'window.shell.getLock()')
  await rendererValue(toolbar, `document.querySelector('button[data-act="lock"]').click(); true`)
  await waitFor(async () => (await rendererValue(toolbar, 'window.shell.getLock()')) !== lockBefore,
    'first toolbar button after pending resize cross-overlay release')
  await rendererValue(toolbar, `document.querySelector('button[data-act="lock"]').click(); true`)
  await waitFor(async () => (await rendererValue(toolbar, 'window.shell.getLock()')) === lockBefore,
    'toolbar lock state after pending resize recovery')
}

async function assertToolbarDockInvariant ({ caption, toolbar, cursor }) {
  const expected = windowLayoutContract.toolbarDockBoundsFor(caption.getBounds())
  const localPoint = await rendererPointerPoint(
    toolbar,
    "document.querySelector('button[data-act=\"lock\"]')",
    'target => { const r = target.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }'
  )
  cursor.set(screenPointForRenderer(toolbar, localPoint))
  await rendererValue(toolbar, `document.dispatchEvent(new MouseEvent('mousemove', {
    bubbles: true,
    clientX: ${Number(localPoint.x)},
    clientY: ${Number(localPoint.y)}
  })); true`)
  const rehitStart = windowInteractionGenerationProbe.length
  toolbar.setContentBounds({
    x: expected.x - 2,
    y: expected.y - 3,
    width: expected.width + 1,
    height: expected.height + 2
  })
  await waitFor(() => sameWindowBounds(toolbar.getContentBounds(), expected),
    'fixed toolbar viewport after native resize')
  await waitFor(() => {
    const entries = windowInteractionGenerationProbe.slice(rehitStart)
    const refreshIndex = entries.findIndex((entry) => entry.method === 'refreshPointerHits' &&
      entry.roles?.join(',') === 'toolbar' && entry.accepted === true)
    if (refreshIndex < 0) return false
    const refreshGeneration = entries[refreshIndex].generation
    const ackIndex = entries.findIndex((entry, index) => index > refreshIndex &&
      entry.method === 'acceptMouseThrough' && entry.role === 'toolbar' &&
      entry.argumentGeneration === refreshGeneration && entry.ignore === false && entry.accepted === true)
    return ackIndex > refreshIndex &&
      observedWindowInteractionGenerationController.getState().generation === refreshGeneration
  }, 'stationary toolbar hit after fixed viewport correction')

  const lockBefore = await rendererValue(toolbar, 'window.shell.getLock()')
  await rendererValue(toolbar, `document.querySelector('button[data-act="lock"]').click(); true`)
  await waitFor(async () => (await rendererValue(toolbar, 'window.shell.getLock()')) !== lockBefore,
    'first toolbar button after fixed viewport correction')
  await rendererValue(toolbar, `document.querySelector('button[data-act="lock"]').click(); true`)
  await waitFor(async () => (await rendererValue(toolbar, 'window.shell.getLock()')) === lockBefore,
    'toolbar lock state after fixed viewport correction')
}

async function assertCrossOverlayTerminal ({
  sourceWindow,
  terminalWindow,
  targetWindow,
  cursor,
  targetExpression,
  pointExpression,
  pointerId,
  label
}) {
  const point = await rendererPointerPoint(sourceWindow, targetExpression, pointExpression)
  const origin = screenPointForRenderer(sourceWindow, point)
  const generationBefore = observedWindowInteractionGenerationController.getState().generation
  cursor.set(origin)
  await dispatchRendererPointer(sourceWindow, targetExpression, point, 'pointerdown', pointerId)
  await new Promise((resolve) => setTimeout(resolve, 20))

  terminalWindow.webContents.sendInputEvent({
    type: 'mouseUp',
    x: 300,
    y: 30,
    button: 'left',
    clickCount: 1
  })
  await waitFor(() => {
    const state = observedWindowInteractionGenerationController.getState()
    return state.generation > generationBefore && state.phase === 'resume'
  }, `${label} cross-overlay generation reset`)
  const ended = targetWindow.getBounds()
  cursor.set({ x: origin.x + 27, y: origin.y + 13 })
  await new Promise((resolve) => setTimeout(resolve, 50))
  if (!sameWindowBounds(targetWindow.getBounds(), ended)) {
    throw new Error(`${label} cross-overlay mouseUp left a main-process gesture active`)
  }
  await assertRendererGestureMoves({
    sourceWindow,
    targetWindow,
    targetExpression,
    pointExpression,
    pointerId: pointerId + 1000,
    cursor,
    delta: { x: 11, y: 7 },
    endType: 'pointerup'
  })
}

async function exerciseOverlayWindowInteractions ({ caption, toolbar, cursor }) {
  const card = "document.getElementById('captionCard')"
  const grip = "document.getElementById('grip')"
  const center = `target => { const r = target.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }`
  const cardLeft = `target => { const r = target.getBoundingClientRect(); return { x: r.left + 80, y: r.top + r.height * 0.55 } }`
  const cardMiddle = `target => { const r = target.getBoundingClientRect(); return { x: r.left + r.width * 0.42, y: r.bottom - 28 } }`
  const cardResizeWest = `target => { const r = target.getBoundingClientRect(); return { x: r.left + 3, y: r.top + r.height * 0.55 } }`

  await assertToolbarDockInvariant({ caption, toolbar, cursor })

  await assertRendererGestureStatic({
    sourceWindow: caption,
    targetWindow: caption,
    targetExpression: 'document.documentElement',
    pointExpression: 'target => ({ x: 4, y: 4 })',
    pointerId: 101,
    cursor
  })
  await assertRendererGestureStatic({
    sourceWindow: caption,
    targetWindow: caption,
    targetExpression: "document.querySelector('.tb-hole')",
    pointExpression: center,
    pointerId: 102,
    cursor
  })

  await assertRendererGestureMoves({
    sourceWindow: caption,
    targetWindow: caption,
    targetExpression: card,
    pointExpression: cardLeft,
    pointerId: 103,
    cursor,
    endType: 'pointerup'
  })
  await assertRendererGestureMoves({
    sourceWindow: caption,
    targetWindow: caption,
    targetExpression: card,
    pointExpression: cardMiddle,
    pointerId: 104,
    cursor,
    endType: 'pointercancel'
  })
  await assertRendererGestureMoves({
    sourceWindow: caption,
    targetWindow: caption,
    targetExpression: card,
    pointExpression: cardLeft,
    pointerId: 105,
    cursor,
    endType: 'lostpointercapture'
  })
  await assertStationaryPressRelease({
    sourceWindow: caption,
    targetWindow: caption,
    targetExpression: card,
    pointExpression: cardMiddle,
    pointerId: 106,
    cursor
  })
  await assertResizeClickSlop({
    caption,
    toolbar,
    cursor,
    targetExpression: card,
    pointExpression: cardResizeWest,
    pointerId: 116
  })
  await assertPendingResizeCrossOverlayTerminal({
    caption,
    toolbar,
    cursor,
    targetExpression: card,
    pointExpression: cardResizeWest
  })
  await assertRendererGestureMoves({
    sourceWindow: caption,
    targetWindow: caption,
    targetExpression: card,
    pointExpression: cardResizeWest,
    pointerId: 107,
    cursor,
    armDelta: { x: -4, y: 0 },
    delta: { x: -12, y: 0 },
    endType: 'pointerup'
  })

  await assertCrossOverlayTerminal({
    sourceWindow: caption,
    terminalWindow: toolbar,
    targetWindow: caption,
    cursor,
    targetExpression: card,
    pointExpression: cardLeft,
    pointerId: 117,
    label: 'caption-to-toolbar'
  })

  await assertCancellationBeforeMove({
    sourceWindow: caption,
    targetWindow: caption,
    targetExpression: card,
    pointExpression: cardLeft,
    pointerId: 108,
    cursor,
    cancel: (point) => dispatchRendererPointer(caption, 'window', point, 'blur', 108)
  })
  await assertRendererGestureStatic({
    sourceWindow: toolbar,
    targetWindow: caption,
    targetExpression: "document.getElementById('status')",
    pointExpression: center,
    pointerId: 109,
    cursor
  })
  const unlockedGripState = await rendererValue(toolbar, `(() => {
    const target = document.getElementById('grip')
    const rect = target.getBoundingClientRect()
    return { display: getComputedStyle(target).display, width: rect.width, height: rect.height }
  })()`)
  if (unlockedGripState.display !== 'none' || unlockedGripState.width !== 0 || unlockedGripState.height !== 0) {
    throw new Error('unlocked toolbar grip still participates in layout')
  }
  const toolbarBeforeHiddenGrip = toolbar.getBounds()
  await assertRendererGestureStatic({
    sourceWindow: toolbar,
    targetWindow: caption,
    targetExpression: grip,
    pointExpression: center,
    pointerId: 110,
    cursor,
    endType: 'pointerup'
  })
  if (!sameWindowBounds(toolbar.getBounds(), toolbarBeforeHiddenGrip) ||
      observedManualWindowInteractionController?.isDragging() !== false) {
    throw new Error('unlocked hidden grip started a toolbar drag')
  }

  const captionBeforeLock = caption.getBounds()
  const expectedToolbarAtLock = windowLayoutContract.toolbarDockBoundsFor(captionBeforeLock)
  let lockTransitionDriftInjected = false
  await assertCancellationBeforeMove({
    sourceWindow: caption,
    targetWindow: caption,
    targetExpression: card,
    pointExpression: cardLeft,
    pointerId: 112,
    cursor,
    cancel: async () => {
      beforeObservedStopAll = () => {
        lockTransitionDriftInjected = true
        toolbar.setContentBounds({
          ...expectedToolbarAtLock,
          x: expectedToolbarAtLock.x - 7,
          y: expectedToolbarAtLock.y + 5
        })
      }
      await rendererValue(toolbar, `document.querySelector('button[data-act="lock"]').click(); true`)
      await waitFor(() => rendererValue(toolbar, 'window.shell.getLock()'), 'toolbar lock state')
    }
  })
  if (!lockTransitionDriftInjected) throw new Error('lock-transition native drift injection was not consumed')
  await waitFor(() => sameWindowBounds(toolbar.getContentBounds(), expectedToolbarAtLock),
    'lock transition preserves the old unlocked dock target')
  await assertRendererGestureStatic({
    sourceWindow: caption,
    targetWindow: caption,
    targetExpression: card,
    pointExpression: cardLeft,
    pointerId: 113,
    cursor
  })
  const toolbarBeforeLockedGrip = toolbar.getBounds()
  await assertRendererGestureMoves({
    sourceWindow: toolbar,
    targetWindow: toolbar,
    targetExpression: grip,
    pointExpression: center,
    pointerId: 114,
    cursor,
    endType: 'pointerup'
  })
  if (!sameWindowBounds(caption.getBounds(), captionBeforeLock) ||
      sameWindowBounds(toolbar.getBounds(), toolbarBeforeLockedGrip)) {
    throw new Error('locked grip did not isolate movement to the toolbar')
  }
  await assertCrossOverlayTerminal({
    sourceWindow: toolbar,
    terminalWindow: caption,
    targetWindow: toolbar,
    cursor,
    targetExpression: grip,
    pointExpression: center,
    pointerId: 118,
    label: 'toolbar-to-caption'
  })
  await assertCancellationBeforeMove({
    sourceWindow: toolbar,
    targetWindow: toolbar,
    targetExpression: grip,
    pointExpression: center,
    pointerId: 111,
    cursor,
    cancel: () => rendererValue(toolbar, `window.dispatchEvent(new Event('beforeunload')); true`)
  })
  const lockedToolbarPosition = toolbar.getContentBounds()
  toolbar.setContentBounds({
    x: lockedToolbarPosition.x - 2,
    y: lockedToolbarPosition.y - 3,
    width: lockedToolbarPosition.width + 1,
    height: lockedToolbarPosition.height + 2
  })
  await waitFor(() => sameWindowBounds(toolbar.getContentBounds(), {
    ...lockedToolbarPosition,
    width: windowLayoutContract.WINDOW_LAYOUT.toolbarViewportWidth,
    height: windowLayoutContract.WINDOW_LAYOUT.toolbarViewportHeight
  }), 'locked toolbar fixed viewport without redocking')
  if (!sameWindowBounds(caption.getBounds(), captionBeforeLock)) {
    throw new Error('locked toolbar viewport correction moved the caption')
  }
  await rendererValue(toolbar, `document.querySelector('button[data-act="lock"]').click(); true`)
  await waitFor(async () => (await rendererValue(toolbar, 'window.shell.getLock()')) === false, 'toolbar unlock state')

  return {
    transparentMarginPassThroughObserved: true,
    toolbarContourPriorityObserved: true,
    resizeBandObserved: true,
    visibleCardDragPointCount: 2,
    firstPointerDeltaObserved: true,
    stationaryPressReleaseStable: true,
    gestureCancellationObservationCount: 6,
    nonGripToolbarDragRejected: true,
    unlockedGripHiddenAndRejected: true,
    lockedGripMovesToolbarOnly: true
  }
}

async function exerciseNormalWindowInteractions ({ settings, history, toolbar, cursor }) {
  const center = `target => { const r = target.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } }`
  await assertRendererGestureMoves({
    sourceWindow: settings,
    targetWindow: settings,
    targetExpression: "document.querySelector('.titlebar')",
    pointExpression: center,
    pointerId: 201,
    cursor
  })
  await assertRendererGestureMoves({
    sourceWindow: history,
    targetWindow: history,
    targetExpression: "document.querySelector('.titlebar')",
    pointExpression: center,
    pointerId: 202,
    cursor
  })
  await assertRendererGestureStatic({
    sourceWindow: settings,
    targetWindow: settings,
    targetExpression: "document.getElementById('close')",
    pointExpression: center,
    pointerId: 203,
    cursor
  })
  await assertRendererGestureStatic({
    sourceWindow: history,
    targetWindow: history,
    targetExpression: "document.getElementById('close')",
    pointExpression: center,
    pointerId: 204,
    cursor
  })
  await assertRendererGestureStatic({
    sourceWindow: settings,
    targetWindow: settings,
    targetExpression: "document.querySelector('main.content')",
    pointExpression: center,
    pointerId: 205,
    cursor
  })
  await assertRendererGestureStatic({
    sourceWindow: history,
    targetWindow: history,
    targetExpression: "document.querySelector('main.history-layout')",
    pointExpression: center,
    pointerId: 206,
    cursor
  })

  settings.show(); settings.focus()
  await waitFor(() => settings.isAlwaysOnTop(), 'settings foreground promotion')
  history.show(); history.focus()
  await waitFor(() => history.isAlwaysOnTop() && !settings.isAlwaysOnTop(), 'settings to history rapid focus switch')
  toolbar.focus()
  await waitFor(() => !history.isAlwaysOnTop(), 'history focus loss demotion')

  settings.show(); settings.focus()
  await waitFor(() => settings.isAlwaysOnTop(), 'settings promotion before blur cancellation')
  await assertCancellationBeforeMove({
    sourceWindow: settings,
    targetWindow: settings,
    targetExpression: "document.querySelector('.titlebar')",
    pointExpression: center,
    pointerId: 207,
    cursor,
    cancel: async () => {
      settings.blur()
      await waitFor(() => !settings.isAlwaysOnTop(), 'settings drag blur demotion')
    }
  })

  return {
    normalTitlebarDragCount: 2,
    normalInteractiveExclusionCount: 2,
    normalBodyExclusionCount: 2,
    normalForegroundPromotionCount: 2,
    rapidFocusSwitchObserved: true,
    focusLossDemotionObserved: true,
    focusedDragBlurCancellationObserved: true
  }
}

async function exerciseSharedTitlebarThemes (settings, history, toolbar, caption) {
  const originalThemeSource = nativeTheme.themeSource
  const originalConfig = await rendererValue(settings, 'window.shell.getConfig()')
  const originalLocked = await rendererValue(toolbar, 'window.shell.getLock()')
  const inspectTitlebar = (win) => rendererValue(win, `(() => {
    const root = getComputedStyle(document.documentElement)
    const titlebar = document.querySelector('.titlebar')
    const titlebarStyle = getComputedStyle(titlebar)
    return {
      surface: root.getPropertyValue('--surface-window-titlebar').trim(),
      border: root.getPropertyValue('--border-window-titlebar').trim(),
      background: titlebarStyle.backgroundColor,
      borderBottom: titlebarStyle.borderBottomColor
    }
  })()`)
  const inspectToolbar = () => rendererValue(toolbar, `(() => {
    const bar = document.getElementById('toolbar')
    const button = bar.querySelector('.act')
    const grip = document.getElementById('grip')
    const phase = bar.querySelector('.status-icon')
    const style = getComputedStyle(bar)
    const rect = bar.getBoundingClientRect()
    return {
      theme: document.documentElement.dataset.theme,
      background: style.backgroundColor,
      shadow: style.boxShadow,
      button: getComputedStyle(button).color,
      grip: getComputedStyle(grip).color,
      phase: getComputedStyle(phase).color,
      width: rect.width,
      height: rect.height
    }
  })()`)
  const inspectCaption = () => rendererValue(caption, `(() => {
    const card = document.getElementById('captionCard')
    const style = getComputedStyle(card)
    return { background: style.backgroundColor, width: card.getBoundingClientRect().width }
  })()`)
  const variants = []
  const toolbarVariants = []
  try {
    for (const theme of ['dark', 'light']) {
      nativeTheme.themeSource = theme
      await rendererValue(settings, `window.shell.setConfig({ theme: '${theme}' })`)
      await new Promise((resolve) => setTimeout(resolve, 80))
      const [settingsValue, historyValue, toolbarValue] = await Promise.all([
        inspectTitlebar(settings), inspectTitlebar(history), inspectToolbar()
      ])
      if (!settingsValue.surface || !settingsValue.border ||
          settingsValue.surface !== historyValue.surface || settingsValue.border !== historyValue.border ||
          !settingsValue.background || !historyValue.background ||
          !settingsValue.borderBottom || !historyValue.borderBottom) {
        throw new Error(`shared titlebar token mismatch in ${theme}`)
      }
      variants.push(settingsValue.surface)
      toolbarVariants.push(toolbarValue)
    }

    nativeTheme.themeSource = 'dark'
    await rendererValue(settings, `window.shell.setConfig({ theme: 'auto' })`)
    await waitFor(async () => (await inspectToolbar()).theme === 'dark', 'automatic dark toolbar theme')
    toolbarVariants.push(await inspectToolbar())

    const fixedProjection = (value) => ({
      background: value.background,
      shadow: value.shadow,
      button: value.button,
      grip: value.grip,
      phase: value.phase,
      width: value.width,
      height: value.height
    })
    if (toolbarVariants.some((value) =>
      JSON.stringify(fixedProjection(value)) !== JSON.stringify(fixedProjection(toolbarVariants[0])))) {
      throw new Error('toolbar palette or contour changed across dark, light, and automatic themes')
    }

    const captionBeforeColor = await inspectCaption()
    const toolbarBeforeColor = await inspectToolbar()
    await rendererValue(settings, `window.shell.setConfig({ barColor: '#123456' })`)
    const captionWithColor = await waitFor(async () => {
      const value = await inspectCaption()
      return value.background !== captionBeforeColor.background ? value : null
    }, 'caption-only custom background')
    const toolbarWithColor = await inspectToolbar()
    if (toolbarWithColor.background !== toolbarBeforeColor.background ||
        toolbarWithColor.button !== toolbarBeforeColor.button ||
        toolbarWithColor.grip !== toolbarBeforeColor.grip ||
        toolbarWithColor.width !== toolbarBeforeColor.width ||
        toolbarWithColor.height !== toolbarBeforeColor.height ||
        captionWithColor.width !== captionBeforeColor.width) {
      throw new Error('caption custom background leaked into toolbar palette or contour')
    }

    if (!originalLocked) {
      await rendererValue(toolbar, `document.querySelector('button[data-act="lock"]').click(); true`)
      await waitFor(() => rendererValue(toolbar, 'window.shell.getLock()'), 'toolbar surface lock state')
    }
    const captionBeforeOpacity = await inspectCaption()
    const toolbarBeforeOpacity = await inspectToolbar()
    await rendererValue(settings, `window.shell.setConfig({ toolbarOpacity: 0.31 })`)
    const toolbarWithOpacity = await waitFor(async () => {
      const value = await inspectToolbar()
      return value.background !== toolbarBeforeOpacity.background ? value : null
    }, 'toolbar-only surface opacity')
    const captionWithOpacity = await inspectCaption()
    if (toolbarWithOpacity.button !== toolbarBeforeOpacity.button ||
        toolbarWithOpacity.grip !== toolbarBeforeOpacity.grip ||
        toolbarWithOpacity.phase !== toolbarBeforeOpacity.phase ||
        toolbarWithOpacity.width !== toolbarBeforeOpacity.width ||
        toolbarWithOpacity.height !== toolbarBeforeOpacity.height ||
        captionWithOpacity.background !== captionBeforeOpacity.background ||
        captionWithOpacity.width !== captionBeforeOpacity.width) {
      throw new Error('toolbar surface opacity leaked into controls, caption, or contour')
    }
  } finally {
    await rendererValue(settings, `window.shell.setConfig(${JSON.stringify({
      theme: originalConfig.theme,
      barColor: originalConfig.barColor,
      toolbarOpacity: originalConfig.toolbarOpacity
    })})`)
    nativeTheme.themeSource = originalThemeSource
    const currentLocked = await rendererValue(toolbar, 'window.shell.getLock()')
    if (currentLocked !== originalLocked) {
      await rendererValue(toolbar, `document.querySelector('button[data-act="lock"]').click(); true`)
      await waitFor(async () => (await rendererValue(toolbar, 'window.shell.getLock()')) === originalLocked,
        'toolbar surface lock state restore')
    }
  }
  const forcedColorsTitlebarRuleObserved = await rendererValue(settings, `(() => {
    const visit = (rules) => [...rules].some((rule) => {
      if (rule.conditionText && rule.conditionText.includes('forced-colors') &&
          rule.cssText.includes('--surface-window-titlebar') &&
          rule.cssText.includes('--border-window-titlebar')) return true
      return rule.cssRules ? visit(rule.cssRules) : false
    })
    return [...document.styleSheets].some((sheet) => visit(sheet.cssRules))
  })()`)
  if (!forcedColorsTitlebarRuleObserved || variants.length !== 2 || variants[0] === variants[1] ||
      toolbarVariants.length !== 3) {
    throw new Error('shared titlebar theme variants are incomplete')
  }
  return {
    sharedTitlebarStructureObserved: true,
    sharedTitlebarThemeVariantsObserved: true,
    forcedColorsTitlebarRuleObserved: true
  }
}

async function waitForHistoryPage (win, firstPosition, lastPosition) {
  return waitFor(async () => {
    const state = await rendererValue(win, `(() => {
      const timeline = document.getElementById('timeline')
      const items = [...timeline.children]
      return {
        busy: timeline.getAttribute('aria-busy'),
        count: items.length,
        first: Number(items[0]?.getAttribute('aria-posinset')),
        last: Number(items.at(-1)?.getAttribute('aria-posinset')),
        setSize: Number(items[0]?.getAttribute('aria-setsize')),
        positionsAligned: items.every((item, index) =>
          Number(item.getAttribute('aria-posinset')) === ${firstPosition} + index &&
          Number(item.getAttribute('aria-setsize')) === ${LONG_HISTORY_SEGMENT_COUNT})
      }
    })()`)
    return state.busy === 'false' &&
      state.count === lastPosition - firstPosition + 1 &&
      state.first === firstPosition && state.last === lastPosition &&
      state.setSize === LONG_HISTORY_SEGMENT_COUNT && state.positionsAligned === true
      ? state
      : null
  }, `history page ${firstPosition}-${lastPosition}`)
}

function audioFilesUnder (directory) {
  const found = []
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (/\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)$/i.test(entry.name)) found.push(entry.name)
    }
  }
  visit(directory)
  return found
}

function readyMarkerCountFor (directory, artifactIds) {
  const countMarkers = (root) => {
    let count = 0
    const visit = (current) => {
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
        const target = path.join(current, entry.name)
        if (entry.isDirectory()) visit(target)
        else if (entry.name === '.ready.json') count += 1
      }
    }
    visit(root)
    return count
  }
  return artifactIds.reduce((count, artifactId) => {
    const root = path.join(directory, artifactId)
    return count + (fs.statSync(root, { throwIfNoEntry: false })?.isDirectory() ? countMarkers(root) : 0)
  }, 0)
}

function seedLongHistoryFixture (databasePath) {
  const service = new StorageWorkerService()
  let requestSequence = 0
  const call = (operation, payload, idempotencyKey) => {
    const response = service.handle({
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId: `product-shell-fixture-${++requestSequence}`,
      operation,
      payload,
      ...(idempotencyKey ? { idempotencyKey } : {})
    })
    if (!response.ok) throw new Error(`long history fixture failed: ${response.error.code}`)
    return response.result
  }
  const startedAt = 1700000000000
  let captionSequence = 0
  try {
    call(OPERATIONS.INITIALIZE, { databasePath })
    call(OPERATIONS.OPEN_SESSION, {
      sessionId: LONG_HISTORY_SESSION_ID,
      sourceId: 'mic',
      startedAt,
      refinementEnabled: true
    }, makeOpenSessionKey(LONG_HISTORY_SESSION_ID))
    for (let index = 0; index < LONG_HISTORY_SEGMENT_COUNT; index += 1) {
      const t0 = Math.floor(index / 7) / 10
      const segmentId = `ci-long-segment-${String(index + 1).padStart(3, '0')}`
      const finalEvent = {
        schemaVersion: 1,
        sessionId: LONG_HISTORY_SESSION_ID,
        sourceId: 'mic',
        segmentId,
        sequence: ++captionSequence,
        revision: 1,
        kind: 'final',
        t0,
        t1: t0 + 0.08,
        text: `fixture subtitle ${String(index + 1).padStart(3, '0')}`,
        translation: null
      }
      call(OPERATIONS.APPEND_CAPTION, { event: finalEvent }, makeCaptionEventId(finalEvent))
      if (index % 11 === 0 || index % 17 === 0 || [49, 50, 99, 100, 149, 150, 199, 200].includes(index)) {
        const refinedEvent = {
          ...finalEvent,
          sequence: ++captionSequence,
          revision: 2,
          kind: 'refined',
          text: `fixture refined subtitle ${String(index + 1).padStart(3, '0')}`
        }
        call(OPERATIONS.APPEND_CAPTION, { event: refinedEvent }, makeCaptionEventId(refinedEvent))
      }
    }
    call(OPERATIONS.CLOSE_SESSION, {
      sessionId: LONG_HISTORY_SESSION_ID,
      sourceId: 'mic',
      endedAt: startedAt + 30000,
      state: 'closed'
    }, makeCloseSessionKey(LONG_HISTORY_SESSION_ID))
  } finally {
    if (!service.shuttingDown) call(OPERATIONS.SHUTDOWN, {})
  }
}

function seedLegacyHistoryFixture (directory) {
  fs.mkdirSync(directory, { recursive: true })
  const startedAt = 1700000100000
  const filePath = path.join(directory, 'legacy-meeting.jsonl')
  const records = [
    JSON.stringify({
      v: 1,
      event: 'session.open',
      sessionId: LEGACY_HISTORY_SESSION_ID,
      at: new Date(startedAt).toISOString()
    }),
    JSON.stringify({
      v: 1,
      event: 'segment.final',
      sessionId: LEGACY_HISTORY_SESSION_ID,
      sourceId: 'loopback',
      segmentId: 'ci-legacy-segment',
      sequence: 1,
      revision: 1,
      t0: 0,
      t1: 1,
      text: 'legacy product shell fixture'
    }),
    JSON.stringify({
      v: 1,
      event: 'session.close',
      sessionId: LEGACY_HISTORY_SESSION_ID,
      at: new Date(startedAt + 1000).toISOString()
    }),
    ''
  ]
  fs.writeFileSync(filePath, records.join('\n'), { encoding: 'utf8', flag: 'wx' })
  return Object.freeze({ filePath, sha256: sha256File(filePath) })
}

function exportSegmentCount (format, content) {
  if (format === 'txt') return content.trimEnd().split(/\r?\n/).length
  if (format === 'md') return content.split(/\r?\n/).filter((line) => line.startsWith('- ')).length
  return (content.match(/^\d+$/gm) || []).length
}

function inspectOriginalExportArtifacts (directory, key) {
  const contents = Object.fromEntries(EXPORT_FORMATS.map((format) => [
    format,
    fs.readFileSync(path.join(directory, `${key}.${format}`), 'utf8')
  ]))
  const counts = {
    txt: exportSegmentCount('txt', contents.txt),
    md: exportSegmentCount('md', contents.md),
    srt: exportSegmentCount('srt', contents.srt)
  }
  if (EXPORT_FORMATS.some((format) => counts[format] !== LONG_HISTORY_SEGMENT_COUNT)) {
    throw new Error(`history export was truncated: ${JSON.stringify(counts)}`)
  }
  return Object.freeze({ artifactCount: EXPORT_FORMATS.length, fullSegmentCount: counts.txt })
}

function inspectRefinedExportArtifact (filePath) {
  const content = fs.readFileSync(filePath, 'utf8')
  /* An incomplete refined TXT export deliberately begins with its one-line
     coverage disclosure and one blank separator. They are metadata, not
     subtitle rows, so exclude them from the segment-count evidence. */
  const lines = content.trimEnd().split(/\r?\n/)
  const fullSegmentCount = lines.length - 2
  const containsRefinedFixture = content.includes('fixture refined subtitle')
  const containsOriginalFallback = content.includes('[原始版回退]')
  if (fullSegmentCount !== LONG_HISTORY_SEGMENT_COUNT || !containsRefinedFixture || !containsOriginalFallback) {
    throw new Error('history refinement export did not retain both selected drafts and original fallback')
  }
  return Object.freeze({ fullSegmentCount, containsRefinedFixture, containsOriginalFallback })
}

function inspectRawOriginalExportArtifact (filePath) {
  const content = fs.readFileSync(filePath, 'utf8')
  const segmentCount = exportSegmentCount('txt', content)
  if (segmentCount < 1 || content.includes('fixture refined subtitle') || content.includes('[原始版回退]')) {
    throw new Error('history session B did not export its original transcript')
  }
  return Object.freeze({ segmentCount })
}

const options = parseArguments(process.argv.slice(app.isPackaged ? 1 : 2))
const productPayloadIdentity = computeProductPayloadIdentity()
const userDataDir = path.join(options.workDir, 'user-data')
const legacyDirectory = path.join(userDataDir, 'sessions')
const exportDirectory = path.join(options.workDir, 'exports')
if (options.mode === 'fresh') {
  fs.mkdirSync(options.workDir, { recursive: false })
  fs.mkdirSync(userDataDir, { recursive: false })
} else if (!fs.statSync(userDataDir, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error('restart userData directory is missing')
}
app.setPath('userData', userDataDir)
let legacyFixture
if (options.mode === 'fresh') {
  seedLongHistoryFixture(path.join(userDataDir, 'data', 'speech-agent.sqlite3'))
  legacyFixture = seedLegacyHistoryFixture(legacyDirectory)
  fs.mkdirSync(exportDirectory, { recursive: false })
} else {
  const filePath = path.join(legacyDirectory, 'legacy-meeting.jsonl')
  if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('restart legacy fixture is missing')
  }
  legacyFixture = Object.freeze({ filePath, sha256: sha256File(filePath) })
}
const fixtureManifestPath = path.join(options.workDir, 'fixture-model-manifest.json')
let modelFixtures
if (options.mode === 'fresh') {
  modelFixtures = createFixtureModelBundle(options.workDir)
  fs.writeFileSync(fixtureManifestPath, `${JSON.stringify(modelFixtures.manifest, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx'
  })
} else {
  const manifest = JSON.parse(fs.readFileSync(fixtureManifestPath, 'utf8'))
  const payloadRoot = path.join(options.workDir, 'fixture-model-downloads')
  const payloadByPath = new Map(manifest.artifacts.map((artifact) => {
    const extension = artifact.artifactKind === 'archive' ? 'tar' : 'bin'
    const payload = fs.readFileSync(path.join(payloadRoot, `${artifact.id}.${extension}`))
    return [new URL(artifact.url).pathname, payload]
  }))
  modelFixtures = Object.freeze({ manifest, payloadByPath })
}
const refinementFixtureArtifact = modelFixtures.manifest.artifacts.find((artifact) =>
  artifact.resourceGroup === 'refinement'
)
if (!refinementFixtureArtifact || refinementFixtureArtifact.id !== REFINEMENT_RESOURCE_IDS[0]) {
  throw new Error('fixture manifest refinement resource is not aligned')
}
const resumeSeed = options.mode === 'fresh'
  ? seedInterruptedModelDownload(userDataDir, modelFixtures)
  : null
const saveDialogEvents = []
let expectedExportTarget = null
dialog.showSaveDialog = async (...args) => {
  const dialogOptions = args.at(-1)
  const format = dialogOptions?.filters?.[0]?.extensions?.[0]
  if (options.mode !== 'fresh' || !EXPORT_FORMATS.includes(format) || !expectedExportTarget ||
      expectedExportTarget.format !== format) {
    throw new Error('unexpected product-shell save dialog request')
  }
  const target = expectedExportTarget
  expectedExportTarget = null
  saveDialogEvents.push(Object.freeze({ key: target.key, format: target.format, version: target.version }))
  return { canceled: false, filePath: path.join(exportDirectory, `${target.key}.${format}`) }
}
delete process.env.LIVE_SUBTITLE_MODEL_DIR
delete process.env.LIVE_SUBTITLE_REFINE_MODEL_DIR
delete process.env.LIVE_SUBTITLE_VAD_MODEL
delete process.env.LIVE_SUBTITLE_DEV_MODEL
delete process.env.LIVE_SUBTITLE_ALLOW_EXTERNAL_MODELS

let modelTransport = null
let offlineModelFetchAttemptCount = 0

function packagedNativeLayout () {
  if (!app.isPackaged) return null
  const nativeRoot = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    'sherpa-onnx-win-x64'
  )
  const required = [
    'sherpa-onnx.node',
    'onnxruntime.dll',
    'onnxruntime_providers_shared.dll',
    'sherpa-onnx-c-api.dll',
    'sherpa-onnx-cxx-api.dll'
  ]
  return {
    nativeBinaryCount: required.filter((name) => fs.existsSync(path.join(nativeRoot, name))).length,
    requiredNativeBinaryCount: required.length
  }
}

function runPackagedNativeProbe () {
  if (!app.isPackaged) return Promise.resolve(null)
  const probePath = path.join(__dirname, 'packaged-native-load-probe.js')
  return new Promise((resolve, reject) => {
    let result = null
    let fatalObserved = false
    let settled = false
    const child = utilityProcess.fork(probePath, [], {
      serviceName: 'Speech Agent packaged native qualification'
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* exact disposable probe child */ }
      reject(new Error('packaged native utility probe timed out'))
    }, 10000)
    child.on('error', () => { fatalObserved = true })
    child.on('message', (message) => {
      if (message?.type !== 'packaged-native-load-result' ||
          typeof message.loaded !== 'boolean' ||
          typeof message.apiSurfaceReady !== 'boolean') return
      result = {
        addonLoaded: message.loaded,
        apiSurfaceReady: message.apiSurfaceReady
      }
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (code !== 0 || fatalObserved || !result?.addonLoaded || !result?.apiSurfaceReady) {
        reject(new Error('packaged native utility probe failed'))
        return
      }
      resolve({ ...result, exactExitCode: code, fatalObserved })
    })
  })
}

function packagedStorageRequest (child, operation, requestId, payload = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      clearTimeout(timer)
      child.removeListener('message', onMessage)
      child.removeListener('exit', onExit)
    }
    const finish = (action) => {
      if (settled) return
      settled = true
      cleanup()
      action()
    }
    const timer = setTimeout(() => finish(() => reject(new Error('packaged DB0 request timed out'))), 15000)
    const onMessage = (message) => {
      if (message?.type !== 'storage:response' || message.requestId !== requestId) return
      finish(() => message.ok
        ? resolve(message.result)
        : reject(new Error('packaged DB0 worker rejected its fixed request')))
    }
    const onExit = () => finish(() => reject(new Error('packaged DB0 worker exited during request')))
    child.on('message', onMessage)
    child.once('exit', onExit)
    child.postMessage({
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId,
      operation,
      payload
    })
  })
}

async function runPackagedDb0Qualification () {
  if (!app.isPackaged) return null
  const child = utilityProcess.fork(STORAGE_WORKER_PATH, [], {
    serviceName: 'Speech Agent packaged SQLite qualification'
  })
  let exitCode = null
  const exited = new Promise((resolve) => child.once('exit', (code) => {
    exitCode = code
    resolve(code)
  }))
  child.on('error', () => {})
  try {
    const qualification = await packagedStorageRequest(
      child,
      OPERATIONS.DB0_QUALIFY,
      'packaged-db0-qualify',
      {
        databasePath: path.join(
          options.workDir,
          options.mode === 'restart' ? 'packaged-db0-restart.sqlite3' : 'packaged-db0.sqlite3'
        )
      }
    )
    await packagedStorageRequest(child, OPERATIONS.SHUTDOWN, 'packaged-db0-shutdown')
    const observedExit = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 5000))
    ])
    if (observedExit !== 0 || qualification?.status !== 'pass' ||
        !Array.isArray(qualification.failedChecks) || qualification.failedChecks.length !== 0 ||
        qualification.checks?.journalModeWal !== true ||
        qualification.checks?.reopenPreservesData !== true ||
        qualification.checks?.integrityAfterReopen !== true) {
      throw new Error('packaged DB0 qualification failed')
    }
    return {
      status: qualification.status,
      checkCount: Object.keys(qualification.checks).length,
      journalModeWal: qualification.checks.journalModeWal,
      reopenPreservesData: qualification.checks.reopenPreservesData,
      integrityAfterReopen: qualification.checks.integrityAfterReopen,
      exactExitCode: observedExit
    }
  } catch (error) {
    if (exitCode === null) {
      try { child.kill() } catch { /* exact disposable qualification child */ }
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 1000))])
    }
    throw error
  }
}

const fixtureRuntimeTelemetry = {
  firstPostFinalCycle: new Set(),
  refinedSessionIds: new Set(),
  sessionRefinementEnabled: new Map(),
  injectFaultForNextRefinedSession: false,
  faultTargetSessionId: null,
  faultedSessionIds: new Set()
}

/* This boundary double deliberately emits subtitle lifecycle events only.
   It accepts the production fast profile selected by the installed bundle,
   while the shared B1 FakeRuntimeAdapter remains strict about its balanced
   development profile. No translated/Agent event is emitted here. */
class ProductShellSubtitleAdapter extends FakeRuntimeAdapter {
  assertContext (context) {
    if (!context || context.profile !== 'fast') {
      throw new TypeError('product-shell subtitle adapter only supports the installed fast profile')
    }
    super.assertContext({ ...context, profile: 'balanced' })
  }

  async start (context) {
    await super.start(context)
    fixtureRuntimeTelemetry.sessionRefinementEnabled.set(context.sessionId, context.refinementEnabled === true)
    if (context.refinementEnabled === true && fixtureRuntimeTelemetry.injectFaultForNextRefinedSession) {
      fixtureRuntimeTelemetry.injectFaultForNextRefinedSession = false
      fixtureRuntimeTelemetry.faultTargetSessionId = context.sessionId
    }
  }

  typeLine (entry) {
    const current = { entry, length: 0, revision: 0 }
    this.currentLine = current
    this.characterTimer = setInterval(() => {
      if (!this.context || this.paused) return
      current.length += 1
      current.revision += 1
      this.emit('partial', current.revision, entry.text.slice(0, current.length))
      if (current.length < entry.text.length) return

      clearInterval(this.characterTimer)
      this.characterTimer = null
      this.currentLine = null
      this.emit('final', current.revision + 1, entry.text)
      this.lineTimer = setTimeout(() => {
        /* The double is intentionally governed by the frozen context, not
           the mutable global preference. This mirrors the real adapter
           boundary while keeping B5 free from physical audio and tensors. */
        if (this.context?.refinementEnabled === true) {
          fixtureRuntimeTelemetry.refinedSessionIds.add(this.context.sessionId)
          this.emit('refined', current.revision + 2, entry.text)
          if (fixtureRuntimeTelemetry.faultTargetSessionId === this.context.sessionId &&
              !fixtureRuntimeTelemetry.faultedSessionIds.has(this.context.sessionId)) {
            /* Let the accepted refined event reach the durable FIFO before the
               controlled worker-exit signal. This is still entirely within
               the fake adapter boundary: no audio host or native worker is
               created by B5. */
            setTimeout(() => {
              if (!this.context || this.context.sessionId !== fixtureRuntimeTelemetry.faultTargetSessionId) return
              fixtureRuntimeTelemetry.faultedSessionIds.add(this.context.sessionId)
              this.emitRefinementFault({
                sessionId: this.context.sessionId,
                code: 'REFINE_WORKER_EXITED',
                stage: 'fixture',
                faultAtMs: 1
              })
            }, 60)
          }
        }
        fixtureRuntimeTelemetry.firstPostFinalCycle.add(this.context?.sessionId)
        this.lineTimer = setTimeout(() => this.nextLine(), this.betweenLinesMs)
      }, this.translationDelayMs)
    }, this.characterIntervalMs)
  }
}

function fixtureRuntimeDefinition () {
  return Object.freeze({
    adapterFactory: () => new ProductShellSubtitleAdapter(),
    runtimeOptions: Object.freeze({
      modelOverride: Object.freeze({
        id: 'x-asr-160ms',
        profile: 'fast',
        developmentOnly: false
      }),
      refinementAvailable: true
    }),
    transitionTimeoutMs: 5000
  })
}

async function launchSmokeApplication () {
  if (options.mode === 'fresh') {
    modelTransport = await startFixtureModelServer(modelFixtures.payloadByPath)
  }
  const BaseModelManager = modelManagerModule.ModelManager
  let randomSequence = 0
  class ProductShellModelManager extends BaseModelManager {
    constructor (managerOptions) {
      super({
        ...managerOptions,
        manifest: modelFixtures.manifest,
        externalReady: null,
        randomId: () => `product-shell-${++randomSequence}`,
        fetchImpl: (url, requestOptions = {}) => {
          if (modelTransport === null) {
            offlineModelFetchAttemptCount += 1
            throw new Error('offline restart attempted a model download')
          }
          const original = new URL(url)
          if (original.protocol !== 'https:' || original.hostname !== 'github.com' ||
              !modelFixtures.payloadByPath.has(original.pathname)) {
            throw new Error('unexpected model manifest URL')
          }
          return fetch(`http://127.0.0.1:${modelTransport.port}${original.pathname}`, {
            method: requestOptions.method,
            headers: requestOptions.headers,
            redirect: requestOptions.redirect,
            signal: requestOptions.signal
          })
        }
      })
    }
  }
  modelManagerModule.ModelManager = ProductShellModelManager
  modelRuntimeModule.createApprovedRuntimeDefinition = () => fixtureRuntimeDefinition()
  modelRuntimeModule.activateApprovedRuntime = ({ coordinator }) =>
    coordinator.replaceRuntime(fixtureRuntimeDefinition())
  require('../src/main')
}

async function closeModelTransport () {
  if (!modelTransport) return
  const server = modelTransport.server
  modelTransport = null
  await closeFixtureModelServer(server)
}

async function exportHistorySelection (history, target) {
  if (!target || typeof target.key !== 'string' || !EXPORT_FORMATS.includes(target.format) ||
      !['original', 'refined'].includes(target.version) || expectedExportTarget !== null) {
    throw new Error('invalid controlled history export target')
  }
  await waitFor(() => rendererValue(history,
    `document.querySelector('[data-version="${target.version}"]').getAttribute('aria-checked') === 'true' &&
      document.querySelector('[data-export="${target.format}"]').disabled === false`),
  `history ${target.key} export readiness`)
  expectedExportTarget = Object.freeze({ ...target })
  await rendererValue(history,
    `document.querySelector('[data-export="${target.format}"]').click(); true`)
  const filePath = path.join(exportDirectory, `${target.key}.${target.format}`)
  await waitFor(() => saveDialogEvents.some((entry) => entry.key === target.key) &&
    fs.statSync(filePath, { throwIfNoEntry: false })?.size > 0,
  `history ${target.key} export`)
  return filePath
}

async function getSessionRefinementEvidence (history, sessionId) {
  const literalSessionId = JSON.stringify(sessionId)
  return rendererValue(history, `window.historyApi.getSessionPage(${literalSessionId}, 1, null).then((result) => {
    const value = result && result.ok === true ? result.value : null
    const refinement = value && value.refinement
    return refinement && typeof refinement === 'object'
      ? {
          refinementEnabled: refinement.refinementEnabled,
          refinedSegmentCount: refinement.refinedSegmentCount,
          refinementResultStatus: refinement.refinementResultStatus,
          refinementFaultCode: refinement.refinementFaultCode
        }
      : null
  })`)
}

const crashEvents = []
app.on('child-process-gone', (_event, details) => {
  if (details.reason === 'clean-exit' && details.exitCode === 0) return
  crashEvents.push({ role: details.type, reason: details.reason, exitCode: details.exitCode })
})
app.on('web-contents-created', (_event, contents) => {
  contents.on('render-process-gone', (_goneEvent, details) => {
    if (details.reason === 'clean-exit' && details.exitCode === 0) return
    crashEvents.push({ role: 'renderer', reason: details.reason, exitCode: details.exitCode })
  })
})

let watchdog = null
let smokeFailed = false
let controlledCursorBoundary = null

app.whenReady().then(() => {
  watchdog = setTimeout(() => {
    console.error('product shell smoke watchdog expired')
    app.exit(1)
  }, 45000)
  const journey = options.mode === 'restart' ? runRestartJourney : runJourney
  void journey().catch(async (error) => {
    smokeFailed = true
    console.error(error && error.stack ? error.stack : error)
    const failure = {
      schemaVersion: 1,
      kind: options.mode === 'restart'
        ? 'product-shell-offline-restart-smoke'
        : 'product-shell-smoke',
      result: 'fail',
      errorCode: 'PRODUCT_SHELL_SMOKE_FAILED',
      crashEventCount: crashEvents.length
    }
    await fsp.writeFile(options.report, `${JSON.stringify(failure, null, 2)}\n`, { flag: 'wx' }).catch(() => {})
    await closeModelTransport().catch(() => {})
    process.exitCode = 1
    app.quit()
  })
})

async function runRestartJourney () {
  const nativeProbe = await runPackagedNativeProbe()
  const packagedDb0 = await runPackagedDb0Qualification()
  const nativeLayout = packagedNativeLayout()
  if (app.isPackaged && (!nativeLayout ||
      nativeLayout.nativeBinaryCount !== nativeLayout.requiredNativeBinaryCount)) {
    throw new Error('packaged native binaries are not colocated in app.asar.unpacked')
  }

  const toolbar = await waitFor(() => windowFor('/toolbar/index.html'), 'restart toolbar renderer')
  const caption = await waitFor(() => windowFor('/caption/index.html'), 'restart caption renderer')
  await Promise.all([toolbar, caption].map((win) =>
    waitFor(() => !win.webContents.isLoading(), 'restart renderer load')))
  await waitFor(() => rendererValue(toolbar,
    `window.shell.getSnapshot().then(s => s.phase === 'idle' && s.capabilities.canStart)`),
  'offline-ready runtime')
  const refinementNoticeNotReplayed = await rendererValue(toolbar,
    `window.shell.getRefinementNotice().then(notice => notice === null &&
      document.querySelector('.refinement-notice') === null)`)
  if (!refinementNoticeNotReplayed) {
    throw new Error('post-session refinement notice replayed after application restart')
  }

  await rendererValue(toolbar, `window.shell.action('open-model-manager'); true`)
  const settings = await waitFor(() => windowFor('/settings/settings.html'), 'restart settings renderer')
  await waitFor(() => !settings.webContents.isLoading(), 'restart settings load')
  const restartReadiness = await waitFor(() => rendererValue(settings, `(async () => {
    const status = await window.shell.getModelStatus()
    const cfg = await window.shell.getConfig()
    const coreReady = status.core?.state === 'ready'
    const refinementMissing = status.refinement?.state === 'missing'
    return coreReady && refinementMissing && cfg.refinementEnabled === false &&
      document.getElementById('modelInstallButton').textContent === '已就绪' &&
      document.getElementById('refinementInstallButton').textContent === '继续下载'
      ? {
          resourceCount: status.resources.length,
          refinementDownloadedBytes: status.refinement.downloadedBytes,
          refinementTotalBytes: status.refinement.totalBytes
        }
      : null
  })()`), 'offline core readiness and retained refinement part')
  const resourceCount = restartReadiness.resourceCount
  const retainedRefinementPartOnRestart = restartReadiness.refinementDownloadedBytes > 0 &&
    restartReadiness.refinementDownloadedBytes < restartReadiness.refinementTotalBytes
  const modelFetchAttemptCountBeforeExplicitContinue = offlineModelFetchAttemptCount
  if (modelFetchAttemptCountBeforeExplicitContinue !== 0 ||
      readyMarkerCountFor(path.join(userDataDir, 'models'), CORE_RESOURCE_IDS) !== CORE_RESOURCE_IDS.length ||
      readyMarkerCountFor(path.join(userDataDir, 'models'), REFINEMENT_RESOURCE_IDS) !== 0 ||
      !retainedRefinementPartOnRestart ||
      resourceCount !== 4 || modelTransport !== null) {
    throw new Error('restart did not preserve offline core readiness and the cancelled refinement part')
  }

  modelTransport = await startFixtureModelServer(modelFixtures.payloadByPath)
  await rendererValue(settings, `document.getElementById('refinementInstallButton').click(); true`)
  await waitFor(() => rendererValue(settings,
    `window.shell.getModelStatus().then(s => s.refinement?.state === 'ready' &&
      document.getElementById('refinementInstallButton').textContent === '已就绪')`),
  'explicit refinement download continuation after restart', 20000)
  const refinementPath = new URL(refinementFixtureArtifact.url).pathname
  const refinementContinueRangeObserved = modelTransport.requests.filter((request) =>
    request.pathname === refinementPath &&
    request.range === `bytes=${restartReadiness.refinementDownloadedBytes}-`
  ).length === 1
  const refinementPreferenceStillDisabledAfterDownload = await rendererValue(settings,
    `window.shell.getConfig().then(cfg => cfg.refinementEnabled === false &&
      document.getElementById('refinementPreferenceToggle').checked === false)`)
  if (!refinementContinueRangeObserved || !refinementPreferenceStillDisabledAfterDownload ||
      readyMarkerCountFor(path.join(userDataDir, 'models'), REFINEMENT_RESOURCE_IDS) !== REFINEMENT_RESOURCE_IDS.length) {
    throw new Error('explicit post-restart refinement continuation is not independently ready')
  }
  await rendererValue(settings, `document.getElementById('refinementPreferenceToggle').click(); true`)
  const refinementPreferenceExplicitlyEnabled = await waitFor(() => rendererValue(settings,
    `window.shell.getConfig().then(cfg => cfg.refinementEnabled === true &&
      document.getElementById('refinementPreferenceToggle').checked === true)`),
  'explicit refinement preference enablement after resource installation')

  await rendererValue(toolbar, `document.querySelector('button[data-act="history"]').click(); true`)
  const history = await waitFor(() => windowFor('/history/index.html'), 'restart history renderer')
  await waitFor(() => !history.webContents.isLoading(), 'restart history load')
  const persistedSessionIds = await waitFor(async () => {
    const ids = await rendererValue(history,
      `[...document.querySelectorAll('.session-card')].map(card => card.dataset.sessionId)`)
    return ids.length === 3 ? ids : null
  }, 'persisted restart history')
  if (!persistedSessionIds.includes(LONG_HISTORY_SESSION_ID) ||
      !persistedSessionIds.includes(LEGACY_HISTORY_SESSION_ID)) {
    throw new Error('persisted restart history lost a seeded session')
  }
  const previousLiveSessionVisible = persistedSessionIds.some((sessionId) =>
    ![LONG_HISTORY_SESSION_ID, LEGACY_HISTORY_SESSION_ID].includes(sessionId))
  if (!previousLiveSessionVisible) throw new Error('fresh-run session did not survive restart')

  const persistedRefinementFreeze = await rendererValue(history, `Promise.all(
    [...document.querySelectorAll('.session-card')].map(async (card) => {
      const result = await window.historyApi.getSessionPage(card.dataset.sessionId, 1, null)
      return result && result.ok === true ? result.value.refinement : null
    })
  ).then((entries) => ({
    rawSessionFrozenOriginal: entries.some((entry) => entry?.refinementResultStatus === 'known' &&
      entry.refinementEnabled === false && entry.refinedSegmentCount === 0),
    legacyResultNotRecorded: entries.some((entry) => entry?.refinementResultStatus === 'not_recorded')
  }))`)
  if (!persistedRefinementFreeze.rawSessionFrozenOriginal ||
      !persistedRefinementFreeze.legacyResultNotRecorded) {
    throw new Error('restart history lost frozen refinement facts')
  }

  await rendererValue(history,
    `document.querySelector('.session-card[data-session-id="${LONG_HISTORY_SESSION_ID}"]').click(); true`)
  const firstHistoryPage = await waitForHistoryPage(history, 1, 50)
  const exportQualification = inspectOriginalExportArtifacts(exportDirectory, 'long-original')
  const legacyJsonlFiles = fs.readdirSync(legacyDirectory)
    .filter((name) => name.toLowerCase().endsWith('.jsonl'))
  const legacyMigrationIdempotent = legacyJsonlFiles.length === 1 &&
    sha256File(legacyFixture.filePath) === legacyFixture.sha256
  if (!legacyMigrationIdempotent) throw new Error('legacy import was not read-only across restart')

  await waitFor(() => rendererValue(toolbar,
    `!!document.querySelector('button[data-act="start"]:not(:disabled)')`),
  'restart start control')
  fixtureRuntimeTelemetry.injectFaultForNextRefinedSession = true
  const toolbarBoundsBeforeRefinementFault = toolbar.getBounds()
  const captionBoundsBeforeRefinementFault = caption.getBounds()
  await rendererValue(toolbar, `document.querySelector('button[data-act="start"]').click(); true`)
  const restartSessionId = await waitFor(async () => {
    const snapshot = await rendererValue(toolbar, `window.shell.getSnapshot()`)
    return snapshot.phase === 'listening' && snapshot.sessionId !== null ? snapshot.sessionId : null
  }, 'restart listening runtime')
  await waitFor(() => rendererValue(caption,
    `document.getElementById('liveRegion').textContent.length > 0`),
  'restart final caption', 15000)
  await waitFor(() => fixtureRuntimeTelemetry.firstPostFinalCycle.has(restartSessionId) &&
    fixtureRuntimeTelemetry.refinedSessionIds.has(restartSessionId),
  'restart session uses the explicitly enabled refinement preference', 15000)
  await waitFor(() => fixtureRuntimeTelemetry.faultedSessionIds.has(restartSessionId),
    'controlled refinement worker fault after restart', 15000)
  const refinementFaultSilentDuringSession = await waitFor(async () => {
    const noNotice = await rendererValue(toolbar,
      `window.shell.getRefinementNotice().then(notice => notice === null &&
        document.querySelector('.refinement-notice') === null)`)
    const toolbarBounds = toolbar.getBounds()
    const captionBounds = caption.getBounds()
    const boundsStable = toolbarBounds.x === toolbarBoundsBeforeRefinementFault.x &&
      toolbarBounds.y === toolbarBoundsBeforeRefinementFault.y &&
      toolbarBounds.width === toolbarBoundsBeforeRefinementFault.width &&
      toolbarBounds.height === toolbarBoundsBeforeRefinementFault.height &&
      captionBounds.x === captionBoundsBeforeRefinementFault.x &&
      captionBounds.y === captionBoundsBeforeRefinementFault.y &&
      captionBounds.width === captionBoundsBeforeRefinementFault.width &&
      captionBounds.height === captionBoundsBeforeRefinementFault.height
    return noNotice && boundsStable
  }, 'no modal notice or resize during refinement fault')
  await rendererValue(settings, `document.getElementById('refinementPreferenceToggle').click(); true`)
  await waitFor(() => rendererValue(settings,
    `window.shell.getConfig().then(cfg => cfg.refinementEnabled === false &&
      document.getElementById('refinementPreferenceToggle').checked === false)`),
  'refinement preference changed for a future session')
  await waitFor(() => fixtureRuntimeTelemetry.firstPostFinalCycle.has(restartSessionId) &&
    fixtureRuntimeTelemetry.refinedSessionIds.has(restartSessionId),
  'restart session retains its frozen refinement preference', 15000)
  await rendererValue(toolbar, `document.querySelector('button[data-act="stop"]').click(); true`)
  await waitFor(() => rendererValue(toolbar,
    `window.shell.getSnapshot().then(s => s.phase === 'idle' && s.sessionId === null)`),
  'restart stopped runtime')
  const postSessionRefinementNoticeShown = await waitFor(() => rendererValue(toolbar,
    `window.shell.getRefinementNotice().then(notice => notice !== null &&
      !!document.querySelector('.refinement-notice .notice-history'))`),
  'post-session refinement status notice')
  await rendererValue(toolbar, `document.querySelector('.refinement-notice .notice-history').click(); true`)
  const refinementNoticeClearedByHistory = await waitFor(() => rendererValue(toolbar,
    `window.shell.getRefinementNotice().then(notice => notice === null &&
      document.querySelector('.refinement-notice') === null)`),
  'history action clears the post-session refinement notice')
  await rendererValue(history, `document.getElementById('refresh').click(); true`)
  await waitFor(() => rendererValue(history,
    `document.querySelectorAll('.session-card').length === 4 &&
      !!document.querySelector('.session-card[data-session-id="${restartSessionId}"]')`),
  'restart session persisted to history')
  const restartSessionRefinement = await getSessionRefinementEvidence(history, restartSessionId)
  const restartSessionFrozenWithPersistedPreference =
    restartSessionRefinement?.refinementResultStatus === 'known' &&
    restartSessionRefinement.refinementEnabled === true &&
    restartSessionRefinement.refinedSegmentCount > 0
  if (!restartSessionFrozenWithPersistedPreference) {
    throw new Error('restart session did not keep its start-time refinement preference')
  }
  await rendererValue(history,
    `document.querySelector('.session-card[data-session-id="${restartSessionId}"]').click(); true`)
  const historyRefinementFaultVisible = await waitFor(() => rendererValue(history,
    `document.getElementById('detailRefinement').textContent.length > 0 &&
      document.querySelector('[data-version="refined"]').disabled === false`),
  'post-restart refinement fault history detail')
  if (!refinementFaultSilentDuringSession || !postSessionRefinementNoticeShown ||
      !refinementNoticeClearedByHistory || !historyRefinementFaultVisible) {
    throw new Error('post-restart refinement fault evidence is incomplete')
  }

  if (crashEvents.length > 0) throw new Error('Electron child process crashed during offline restart')
  if (audioFilesUnder(options.workDir).length > 0) throw new Error('offline restart persisted audio')
  const report = {
    schemaVersion: 4,
    kind: 'product-shell-offline-restart-smoke',
    generatedAt: new Date().toISOString(),
    result: 'pass',
    gateStatus: 'partial',
    runtime: {
      electron: process.versions.electron,
      node: process.versions.node,
      rendererCount: BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).length,
      crashEventCount: crashEvents.length
    },
    ...(app.isPackaged
      ? {
          qualification: {
            runId: options.qualificationRunId,
            phase: 'restart',
            freshProductReportSha256: options.freshProductReportSha256,
            productPayloadVersion: productPayloadIdentity.version,
            productPayloadFileCount: productPayloadIdentity.fileCount,
            productPayloadSha256: productPayloadIdentity.sha256
          }
        }
      : {}),
    ...(app.isPackaged
      ? {
          packaging: {
            appIsPackaged: true,
            defaultApp: process.defaultApp === true,
            smokeMainFromAsar: __dirname.replace(/\\/g, '/').includes('/app.asar/'),
            productMainFromAsar: require.resolve('../src/main').replace(/\\/g, '/').includes('/app.asar/'),
            storageUtilityRoundTrip: true,
            nativeBinaryCount: nativeLayout.nativeBinaryCount,
            nativeAddonLoadedInUtility: nativeProbe.addonLoaded,
            nativeApiSurfaceReady: nativeProbe.apiSurfaceReady,
            nativeProbeExactExitCode: nativeProbe.exactExitCode,
            nativeProbeFatalObserved: nativeProbe.fatalObserved,
            packagedDb0Status: packagedDb0.status,
            packagedDb0CheckCount: packagedDb0.checkCount,
            packagedDb0Wal: packagedDb0.journalModeWal,
            packagedDb0Reopen: packagedDb0.reopenPreservesData,
            packagedDb0Integrity: packagedDb0.integrityAfterReopen,
            packagedDb0ExactExitCode: packagedDb0.exactExitCode,
            releaseCandidate: false,
            installedViaNsis: false
          }
        }
      : {}),
    journey: {
      coreReadySurvivedRestart: true,
      refinementMissingWithRetainedPart: retainedRefinementPartOnRestart,
      modelFetchAttemptCountBeforeExplicitContinue,
      fixtureServerStartedBeforeExplicitContinue: false,
      coreReadyMarkerCount: CORE_RESOURCE_IDS.length,
      refinementReadyMarkerCount: REFINEMENT_RESOURCE_IDS.length,
      resourceCount,
      refinementContinueRangeObserved,
      refinementExplicitDownloadReady: true,
      refinementPreferenceStillDisabledAfterDownload,
      refinementPreferenceExplicitlyEnabled,
      refinementNoticeNotReplayed,
      persistedTerminalHistoryCount: persistedSessionIds.length,
      previousLiveSessionVisible,
      legacySessionVisible: true,
      legacyMigrationIdempotent,
      persistedRawSessionFrozenOriginal: persistedRefinementFreeze.rawSessionFrozenOriginal,
      longHistorySegmentCount: LONG_HISTORY_SEGMENT_COUNT,
      historyPageSize: firstHistoryPage.count,
      historyOriginalExportArtifactCount: exportQualification.artifactCount,
      historyOriginalExportFullSegmentCount: exportQualification.fullSegmentCount,
      restartCaptionRendered: true,
      restartSessionFrozenWithPersistedPreference,
      refinementPreferenceChangedForFutureSessions: true,
      refinementFaultSilentDuringSession,
      postSessionRefinementNoticeShown,
      refinementNoticeClearedByHistory,
      historyRefinementFaultVisible,
      restartSessionPersisted: true,
      terminalHistoryCountAfterRestart: 4
    },
    privacy: {
      physicalAudioSourceOpened: false,
      audioPersisted: false,
      transcriptTextPersistedInReport: false,
      localPathsPersistedInReport: false
    },
    limitations: [
      'fake-asr-no-physical-audio',
      'controlled-ready-model-fixtures-no-real-tensors',
      'deterministic-205-segment-fixture-not-two-hour-i3',
      ...(app.isPackaged
        ? ['not-clean-machine-i4', 'packaged-test-variant-not-release-installer']
        : ['not-packaged-i4'])
    ]
  }
  await fsp.writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(`${JSON.stringify(report)}\n`)
  if (watchdog) clearTimeout(watchdog)
  app.quit()
}

async function runJourney () {
  const nativeProbe = await runPackagedNativeProbe()
  const packagedDb0 = await runPackagedDb0Qualification()
  const nativeLayout = packagedNativeLayout()
  if (app.isPackaged && (!nativeLayout ||
      nativeLayout.nativeBinaryCount !== nativeLayout.requiredNativeBinaryCount)) {
    throw new Error('packaged native binaries are not colocated in app.asar.unpacked')
  }
  let settings = await waitFor(() => windowFor('/settings/settings.html'), 'settings renderer')
  const toolbar = await waitFor(() => windowFor('/toolbar/index.html'), 'toolbar renderer')
  const caption = await waitFor(() => windowFor('/caption/index.html'), 'caption renderer')
  await Promise.all([settings, toolbar, caption].map((win) => waitFor(() => !win.webContents.isLoading(), 'renderer load')))
  controlledCursorBoundary = installControlledCursorBoundary()
  const layoutProbe = await beginWindowInteractionLayoutProbe(toolbar, caption)

  await rendererValue(settings, `document.querySelector('[data-preset="dictation"]').click(); true`)
  await waitFor(() => rendererValue(settings, `document.getElementById('onboarding').hidden`), 'dictation onboarding')
  await waitFor(() => rendererValue(toolbar,
    `window.shell.getSnapshot().then(s => s.phase === 'unavailable' && !s.capabilities.canStart)`),
  'missing-model runtime')

  await rendererValue(settings, `document.querySelector('.nav-item[data-pane="resources"]').click(); true`)
  await waitFor(() => rendererValue(settings,
    `document.querySelector('.pane[data-pane="resources"]').classList.contains('active')`),
  'resource pane before install')
  const initialModelState = await rendererValue(settings, `(async () => {
    window.__modelUiStates = []
    window.shell.onModelStatus((status) => window.__modelUiStates.push({
      core: status.core?.state,
      refinement: status.refinement?.state
    }))
    const status = await window.shell.getModelStatus()
    const cfg = await window.shell.getConfig()
    window.__modelUiStates.push({ core: status.core?.state, refinement: status.refinement?.state })
    return { core: status.core?.state, refinement: status.refinement?.state, enabled: cfg.refinementEnabled === true }
  })()`)
  if (initialModelState.core !== 'missing' || initialModelState.refinement !== 'missing' || initialModelState.enabled) {
    throw new Error('model resources did not begin with core missing and refinement disabled')
  }

  await rendererValue(settings, `document.getElementById('refinementPreferenceToggle').click(); true`)
  const refinementPreferenceRejectedWhileMissing = await waitFor(() => rendererValue(settings,
    `Promise.all([window.shell.getConfig(), window.shell.getModelStatus()]).then(([cfg, status]) =>
      cfg.refinementEnabled === false && status.refinement?.state === 'missing' &&
      document.getElementById('refinementPreferenceToggle').checked === false)`),
  'missing refinement preference remains disabled')
  const refinementFetchAttemptCountBeforeExplicitDownload = modelTransport.requests.length
  if (!refinementPreferenceRejectedWhileMissing || refinementFetchAttemptCountBeforeExplicitDownload !== 0) {
    throw new Error('missing refinement preference attempted an implicit download')
  }

  await waitFor(() => rendererValue(settings,
    `(() => { const b = document.getElementById('modelInstallButton'); return !b.disabled && b.textContent === '下载核心模型' })()`),
  'enabled core model download button')
  await rendererValue(settings, `document.getElementById('modelInstallButton').click(); true`)
  await waitFor(() => rendererValue(settings,
    `window.shell.getModelStatus().then(s => s.core?.state === 'ready' && s.refinement?.state === 'missing' &&
      document.getElementById('modelInstallButton').textContent === '已就绪' &&
      document.getElementById('modelInstallButton').disabled)`),
  'core model installation through settings', 20000)
  const observedCoreStates = await rendererValue(settings,
    `[...new Set(window.__modelUiStates.map((status) => status.core))]`)
  for (const state of ['missing', 'downloading', 'verifying', 'ready']) {
    if (!observedCoreStates.includes(state)) throw new Error(`core model UI missed state: ${state}`)
  }
  const firstArtifactPath = new URL(modelFixtures.manifest.artifacts[0].url).pathname
  const coreRangeResumeObserved = modelTransport.requests.some((request) =>
    request.pathname === firstArtifactPath && request.range === `bytes=${resumeSeed.resumeBytes}-`)
  if (!coreRangeResumeObserved) throw new Error('settings core install did not resume the seeded partial download')
  if (readyMarkerCountFor(path.join(userDataDir, 'models'), CORE_RESOURCE_IDS) !== CORE_RESOURCE_IDS.length ||
      readyMarkerCountFor(path.join(userDataDir, 'models'), REFINEMENT_RESOURCE_IDS) !== 0) {
    throw new Error('core installation did not preserve independent refinement readiness')
  }

  await waitFor(() => rendererValue(toolbar, `window.shell.getSnapshot().then(s => s.phase === 'idle' && s.capabilities.canStart)`), 'idle runtime')
  await waitFor(() => rendererValue(toolbar, `!!document.querySelector('button[data-act="start"]:not(:disabled)')`), 'start control')
  await observeToolbarStateContourChange(toolbar, layoutProbe, controlledCursorBoundary)

  const refinementResumeSeed = seedInterruptedModelDownload(
    userDataDir,
    modelFixtures,
    refinementFixtureArtifact.id
  )
  const refinementPath = new URL(refinementFixtureArtifact.url).pathname
  const heldRefinementResponse = modelTransport.holdNextResponse({
    pathname: refinementPath,
    range: `bytes=${refinementResumeSeed.resumeBytes}-`,
    prefixBytes: 1
  })
  await rendererValue(settings, `document.getElementById('refinementInstallButton').click(); true`)
  await waitFor(() => rendererValue(settings,
    `window.shell.getModelStatus().then(s => s.refinement?.state === 'downloading' &&
      s.refinement.downloadedBytes > ${refinementResumeSeed.resumeBytes} && s.canCancelInstall === true)`),
  'explicit refinement download started before cancellation', 20000)
  if (!heldRefinementResponse.started) throw new Error('controlled refinement response did not start')
  await rendererValue(settings, `document.getElementById('refinementCancelButton').click(); true`)
  await waitFor(() => heldRefinementResponse.connectionClosed,
    'Electron fetch stream closed after explicit refinement cancellation', 12000)
  const cancelledRefinementStatus = await waitFor(() => rendererValue(settings,
    `window.shell.getModelStatus().then(s => s.refinement?.state === 'missing' &&
      s.refinement.downloadedBytes > ${refinementResumeSeed.resumeBytes} &&
      s.refinement.downloadedBytes < s.refinement.totalBytes && s.canCancelInstall === false
        ? s.refinement : null)`),
  'cancelled refinement download retained a resumable part', 12000)
  const cancelledRefinementPart = path.join(
    userDataDir,
    'models',
    '.downloads',
    `${refinementFixtureArtifact.id}.part`
  )
  const refinementCancellationRetainedPart = fs.statSync(cancelledRefinementPart).isFile() &&
    fs.statSync(cancelledRefinementPart).size === cancelledRefinementStatus.downloadedBytes
  if (!heldRefinementResponse.requestAborted || !refinementCancellationRetainedPart) {
    throw new Error('explicit refinement cancellation did not preserve the streamed resumable part')
  }

  await rendererValue(toolbar, `document.querySelector('button[data-act="start"]').click(); true`)
  const rawSessionId = await waitFor(async () => {
    const snapshot = await rendererValue(toolbar, `window.shell.getSnapshot()`)
    return snapshot.phase === 'listening' && snapshot.sessionId !== null ? snapshot.sessionId : null
  }, 'listening runtime')
  await waitFor(() => rendererValue(caption, `document.getElementById('liveRegion').textContent.length > 0`), 'final caption', 15000)
  await waitFor(() => fixtureRuntimeTelemetry.firstPostFinalCycle.has(rawSessionId) &&
    !fixtureRuntimeTelemetry.refinedSessionIds.has(rawSessionId),
  'raw session keeps the missing-model refinement preference frozen', 15000)

  /* J15a：真实产品组合根下的最小字幕断言。最小布局宿主不启动主进程，够不到
     「设置改配置 → 主进程广播 → 字幕窗重算」这条接线，这两条在这里兜底。

     一、可见字幕就是那条定稿本身：此前 CI 只检查过给屏幕阅读器用的隐藏元素
     非空，从未断言过一个字符的可见字幕，实时 partial 更是从未被观察。
     二、改字号后 --fs 生效且仍不横向溢出。
     按 SEM-F14，比对在进程内完成，报告只落布尔值，不写字幕正文。 */
  const visibleCaptionMatchesFinal = await waitFor(() => rendererValue(caption, `(() => {
    const flow = document.getElementById('captionFlow')
    const announced = document.getElementById('liveRegion').textContent
    const last = flow.lastElementChild
    return !!last && last.textContent.length > 0 && last.textContent === announced
  })()`), 'visible caption equals the announced final', 15000)

  const captionFontApplied = await (async () => {
    await rendererValue(settings, `window.shell.setConfig({ fontSize: 38 })`)
    return waitFor(() => rendererValue(caption, `(() => {
      const root = getComputedStyle(document.documentElement)
      const flow = document.getElementById('captionFlow')
      const captions = document.getElementById('captions')
      const lines = parseInt(root.getPropertyValue('--visible-lines'), 10)
      const linePx = parseFloat(root.getPropertyValue('--fs')) * parseFloat(root.getPropertyValue('--lh-caption'))
      return parseFloat(root.getPropertyValue('--fs')) === 38 &&
        Number.isInteger(lines) && lines >= 1 &&
        Math.abs(flow.clientHeight - lines * linePx) < 0.6 &&
        flow.scrollWidth <= flow.clientWidth &&
        captions.scrollWidth <= captions.clientWidth
    })()`), 'caption viewport follows the configured font size', 15000)
  })()

  const lifecycleResult = await exerciseApplicationLifecycle({
    caption,
    toolbar,
    settings,
    rawSessionId,
    cursor: controlledCursorBoundary
  })
  settings = lifecycleResult.settings
  const applicationLifecycle = lifecycleResult.evidence
  const interactionLifecycleContext = lifecycleResult.interactionContext

  await waitFor(() => rendererValue(toolbar, `!!document.querySelector('button[data-act="pause"]:not(:disabled)')`), 'pause control')
  await rendererValue(toolbar, `document.querySelector('button[data-act="pause"]').click(); true`)
  await waitFor(() => rendererValue(toolbar, `window.shell.getSnapshot().then(s => s.phase === 'paused')`), 'paused runtime')
  await waitFor(() => rendererValue(toolbar, `!!document.querySelector('button[data-act="resume"]:not(:disabled)')`), 'resume control')
  await rendererValue(toolbar, `document.querySelector('button[data-act="resume"]').click(); true`)
  await waitFor(() => rendererValue(toolbar, `window.shell.getSnapshot().then(s => s.phase === 'listening')`), 'resumed runtime')

  await waitFor(() => rendererValue(toolbar, `!!document.querySelector('button[data-act="stop"]:not(:disabled)')`), 'stop control')
  await rendererValue(toolbar, `document.querySelector('button[data-act="stop"]').click(); true`)
  await waitFor(() => rendererValue(toolbar, `window.shell.getSnapshot().then(s => s.phase === 'idle' && s.sessionId === null)`), 'stopped runtime')

  await rendererValue(toolbar, `document.querySelector('button[data-act="history"]').click(); true`)
  const history = await waitFor(() => windowFor('/history/index.html'), 'history renderer')
  await waitFor(() => !history.webContents.isLoading(), 'history load')
  const windowInteraction = {
    ...await completeWindowInteractionLayoutProbe(toolbar, layoutProbe),
    ...await exerciseOverlayWindowInteractions({
      caption,
      toolbar,
      cursor: controlledCursorBoundary
    }),
    ...await exerciseNormalWindowInteractions({
      settings,
      history,
      toolbar,
      cursor: controlledCursorBoundary
    }),
    ...await exerciseSharedTitlebarThemes(settings, history, toolbar, caption)
  }
  const reloadProbe = windowInteractionGenerationProbe.slice(interactionLifecycleContext.generationProbeStart)
  const interactionLifecycle = {
    generationAdvanceCount: interactionLifecycleContext.generationAdvanceCount,
    preMinimizeGestureResetObserved: interactionLifecycleContext.preMinimizeGestureResetObserved,
    minimizeGenerationAdvanced: interactionLifecycleContext.minimizeGenerationAdvanced,
    nativeRestoreGenerationAdvanced: interactionLifecycleContext.nativeRestoreGenerationAdvanced,
    secondInstanceRestoreGenerationAdvanced: interactionLifecycleContext.secondInstanceRestoreGenerationAdvanced,
    sameGenerationSuspendResumeObserved: interactionLifecycleContext.sameGenerationSuspendResumeObserved,
    stationaryPointerHitIntentObserved: interactionLifecycleContext.stationaryPointerHitIntentObserved,
    postRestoreCaptionDragIntentObserved: interactionLifecycleContext.postRestoreCaptionDragIntentObserved,
    staleGenerationIntentRejected: interactionLifecycleContext.staleGenerationIntentRejected,
    reloadCurrentGenerationReplayed: reloadProbe.some((entry) => entry.method === 'suspendRoleForReload' && entry.role === 'toolbar') &&
      reloadProbe.some((entry) => entry.method === 'replay' && entry.role === 'toolbar' && entry.accepted),
    nativePassThroughIntentObserved: interactionLifecycleContext.nativePassThroughIntentObserved,
    lockedCaptionPassThroughIntentObserved: interactionLifecycleContext.lockedCaptionPassThroughIntentObserved
  }
  controlledCursorBoundary.restore()
  controlledCursorBoundary = null
  const historyCount = await waitFor(async () => {
    const count = await rendererValue(history, `document.querySelectorAll('.session-card').length`)
    return count === 3 ? count : 0
  }, 'terminal history')
  await waitFor(() => rendererValue(history,
    `!!document.querySelector('.session-card[data-session-id="${rawSessionId}"]')`),
  'raw session history card')
  await waitFor(() => rendererValue(history,
    `!!document.querySelector('.session-card[data-session-id="${LONG_HISTORY_SESSION_ID}"]')`),
  'long history fixture card')
  await waitFor(() => rendererValue(history,
    `!!document.querySelector('.session-card[data-session-id="${LEGACY_HISTORY_SESSION_ID}"]')`),
  'migrated legacy history fixture card')
  await rendererValue(history, `(() => {
    const timeline = document.getElementById('timeline')
    const probe = { maxNodes: timeline.childElementCount, appendCalls: 0 }
    const appendChild = timeline.appendChild.bind(timeline)
    timeline.appendChild = (node) => {
      const result = appendChild(node)
      probe.appendCalls += 1
      probe.maxNodes = Math.max(probe.maxNodes, timeline.childElementCount)
      return result
    }
    window.__historyDomProbe = probe
    return true
  })()`)
  await rendererValue(history,
    `document.querySelector('.session-card[data-session-id="${LONG_HISTORY_SESSION_ID}"]').click(); true`)

  const visitedHistoryPages = []
  visitedHistoryPages.push(await waitForHistoryPage(history, 1, 50))
  const historyVersionStartsOriginal = await rendererValue(history,
    `document.querySelector('[data-version="original"]').getAttribute('aria-checked') === 'true' &&
      document.querySelector('[data-version="refined"]').getAttribute('aria-checked') === 'false'`)
  await rendererValue(history, `document.querySelector('[data-version="refined"]').click(); true`)
  const historyRefinedVersionSelected = await waitFor(() => rendererValue(history,
    `document.querySelector('[data-version="refined"]').getAttribute('aria-checked') === 'true'`),
  'history refinement version selection')
  for (const [first, last] of [[51, 100], [101, 150], [151, 200], [201, 205]]) {
    await rendererValue(history, `document.getElementById('nextPage').click(); true`)
    visitedHistoryPages.push(await waitForHistoryPage(history, first, last))
  }
  const reachedHistoryEnd = await rendererValue(history,
    `document.getElementById('nextPage').disabled === true && document.getElementById('previousPage').disabled === false`)
  await rendererValue(history, `document.getElementById('previousPage').click(); true`)
  await waitForHistoryPage(history, 151, 200)
  await rendererValue(history, `document.getElementById('nextPage').click(); true`)
  await waitForHistoryPage(history, 201, 205)
  const historyProbe = await rendererValue(history, `({
    maxNodes: window.__historyDomProbe.maxNodes,
    appendCalls: window.__historyDomProbe.appendCalls,
    currentNodes: document.getElementById('timeline').childElementCount
  })`)
  const historyBackForwardNavigation = historyProbe.currentNodes === 5
  const historyAriaRangeAligned = visitedHistoryPages.every((state, index) =>
    state.first === index * HISTORY_PAGE_SIZE + 1 &&
    state.last === Math.min((index + 1) * HISTORY_PAGE_SIZE, LONG_HISTORY_SEGMENT_COUNT) &&
    state.setSize === LONG_HISTORY_SEGMENT_COUNT && state.positionsAligned === true)
  if (visitedHistoryPages.length !== 5 || !reachedHistoryEnd || !historyBackForwardNavigation ||
      !historyAriaRangeAligned || historyProbe.maxNodes > HISTORY_PAGE_SIZE || historyProbe.appendCalls < 260) {
    throw new Error('bounded history paging contract is not aligned: ' +
      `pages=${visitedHistoryPages.length} reachedEnd=${reachedHistoryEnd} ` +
      `backForward=${historyBackForwardNavigation} aria=${historyAriaRangeAligned} ` +
      `maxNodes=${historyProbe.maxNodes} appendCalls=${historyProbe.appendCalls}`)
  }

  const historyRefinedVersionPersistsAcrossPaging = await rendererValue(history,
    `document.querySelector('[data-version="refined"]').getAttribute('aria-checked') === 'true'`)
  const refinedExportPath = await exportHistorySelection(history, {
    key: 'long-refined', format: 'txt', version: 'refined'
  })
  const refinedExportQualification = inspectRefinedExportArtifact(refinedExportPath)
  await rendererValue(history, `document.querySelector('[data-version="original"]').click(); true`)
  await waitFor(() => rendererValue(history,
    `document.querySelector('[data-version="original"]').getAttribute('aria-checked') === 'true'`),
  'history original version reselection')
  for (const format of EXPORT_FORMATS) {
    await exportHistorySelection(history, {
      key: 'long-original', format, version: 'original'
    })
  }
  const exportQualification = inspectOriginalExportArtifacts(exportDirectory, 'long-original')
  await rendererValue(history,
    `document.querySelector('.session-card[data-session-id="${rawSessionId}"]').click(); true`)
  await waitFor(() => rendererValue(history,
    `document.querySelector('[data-version="original"]').getAttribute('aria-checked') === 'true' &&
      document.querySelector('[data-version="refined"]').disabled === true`),
  'session change resets history to original version')
  const historySessionChangeResetsOriginal = true
  const rawOriginalExportPath = await exportHistorySelection(history, {
    key: 'raw-original', format: 'txt', version: 'original'
  })
  const rawOriginalExportQualification = inspectRawOriginalExportArtifact(rawOriginalExportPath)
  const rawSessionRefinement = await getSessionRefinementEvidence(history, rawSessionId)
  const rawSessionFrozenOriginal = rawSessionRefinement?.refinementResultStatus === 'known' &&
    rawSessionRefinement.refinementEnabled === false && rawSessionRefinement.refinedSegmentCount === 0
  if (!historyVersionStartsOriginal || !historyRefinedVersionSelected || !historyRefinedVersionPersistsAcrossPaging ||
      !rawSessionFrozenOriginal) {
    throw new Error('history version selection or frozen refinement session evidence is incomplete')
  }
  const legacyJsonlFiles = fs.readdirSync(legacyDirectory)
    .filter((name) => name.toLowerCase().endsWith('.jsonl'))
  const legacySourceReadOnly = legacyJsonlFiles.length === 1 &&
    sha256File(legacyFixture.filePath) === legacyFixture.sha256
  if (!legacySourceReadOnly) throw new Error('legacy JSONL changed or SQLite runtime created a second JSONL')

  await rendererValue(toolbar, `window.shell.action('open-model-manager'); true`)
  await waitFor(() => rendererValue(settings, `document.querySelector('.pane[data-pane="resources"]').classList.contains('active')`), 'resource navigation')
  const finalModelState = await rendererValue(settings, `window.shell.getModelStatus().then(s => ({
    core: s.core?.state,
    refinement: s.refinement?.state,
    resourceCount: s.resources.length
  }))`)
  const resourceCount = finalModelState.resourceCount
  const translationTogglePresent = await rendererValue(settings, `document.body.textContent.includes('显示双语译文')`)
  if (finalModelState.core !== 'ready' || finalModelState.refinement !== 'missing' ||
      resourceCount !== 4 || translationTogglePresent) throw new Error('model resources UI contract is not aligned')
  if (crashEvents.length > 0) throw new Error('Electron child process crashed during the product journey')
  if (audioFilesUnder(options.workDir).length > 0) throw new Error('product shell smoke persisted audio')

  const report = {
    schemaVersion: 8,
    kind: 'product-shell-smoke',
    generatedAt: new Date().toISOString(),
    result: 'pass',
    gateStatus: 'partial',
    runtime: {
      electron: process.versions.electron,
      node: process.versions.node,
      rendererCount: BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).length,
      crashEventCount: crashEvents.length
    },
    ...(app.isPackaged
      ? {
          qualification: {
            runId: options.qualificationRunId,
            phase: 'fresh',
            freshProductReportSha256: null,
            productPayloadVersion: productPayloadIdentity.version,
            productPayloadFileCount: productPayloadIdentity.fileCount,
            productPayloadSha256: productPayloadIdentity.sha256
          }
        }
      : {}),
    ...(app.isPackaged
      ? {
          packaging: {
            appIsPackaged: true,
            defaultApp: process.defaultApp === true,
            smokeMainFromAsar: __dirname.replace(/\\/g, '/').includes('/app.asar/'),
            productMainFromAsar: require.resolve('../src/main').replace(/\\/g, '/').includes('/app.asar/'),
            storageUtilityRoundTrip: true,
            nativeBinaryCount: nativeLayout.nativeBinaryCount,
            nativeAddonLoadedInUtility: nativeProbe.addonLoaded,
            nativeApiSurfaceReady: nativeProbe.apiSurfaceReady,
            nativeProbeExactExitCode: nativeProbe.exactExitCode,
            nativeProbeFatalObserved: nativeProbe.fatalObserved,
            packagedDb0Status: packagedDb0.status,
            packagedDb0CheckCount: packagedDb0.checkCount,
            packagedDb0Wal: packagedDb0.journalModeWal,
            packagedDb0Reopen: packagedDb0.reopenPreservesData,
            packagedDb0Integrity: packagedDb0.integrityAfterReopen,
            packagedDb0ExactExitCode: packagedDb0.exactExitCode,
            releaseCandidate: false,
            installedViaNsis: false
          }
        }
      : {}),
    journey: {
      onboardingPreset: 'dictation',
      coreInstallClicked: true,
      coreInitialState: initialModelState.core,
      refinementInitialState: initialModelState.refinement,
      refinementPreferenceInitiallyDisabled: initialModelState.enabled === false,
      refinementPreferenceRejectedWhileMissing,
      refinementFetchAttemptCountBeforeExplicitDownload,
      coreObservedStates: observedCoreStates,
      coreRangeResumeObserved,
      coreReadyMarkerCount: CORE_RESOURCE_IDS.length,
      refinementReadyMarkerCountBeforeExplicitDownload: 0,
      coreHotActivation: true,
      refinementDownloadStartedBeforeCancellation: heldRefinementResponse.started,
      refinementCancellationClosedFetchStream: heldRefinementResponse.connectionClosed,
      refinementCancellationRetainedPart,
      refinementReadyMarkerCount: 0,
      rawSessionFrozenOriginal,
      startListeningStop: true,
      pauseResume: true,
      finalCaptionRendered: true,
      visibleCaptionMatchesFinal,
      captionFontApplied,
      downloadedModelSessionInHistory: true,
      terminalHistoryCount: historyCount,
      legacyJsonlMigrated: true,
      legacySessionVisible: true,
      legacySourceReadOnly,
      longHistorySegmentCount: LONG_HISTORY_SEGMENT_COUNT,
      historyPageCount: visitedHistoryPages.length,
      historyPageSize: HISTORY_PAGE_SIZE,
      historyMaxTimelineNodes: historyProbe.maxNodes,
      historyReachedEnd: reachedHistoryEnd,
      historyBackForwardNavigation,
      historyAriaRangeAligned,
      historyVersionStartsOriginal,
      historyRefinedVersionSelected,
      historyRefinedVersionPersistsAcrossPaging,
      historyRefinedExportHonored: refinedExportQualification.containsRefinedFixture &&
        refinedExportQualification.containsOriginalFallback &&
        refinedExportQualification.fullSegmentCount === LONG_HISTORY_SEGMENT_COUNT,
      historySessionChangeResetsOriginal,
      historyOriginalExportHonored: rawOriginalExportQualification.segmentCount > 0 &&
        exportQualification.fullSegmentCount === LONG_HISTORY_SEGMENT_COUNT,
      historyExportDialogCount: saveDialogEvents.length,
      historyOriginalExportFormats: [...EXPORT_FORMATS],
      historyOriginalExportArtifactCount: exportQualification.artifactCount,
      historyOriginalExportFullSegmentCount: exportQualification.fullSegmentCount,
      historyRefinedExportArtifactCount: 1,
      historyRawOriginalExportArtifactCount: 1,
      resourcesPaneOpenedFromToolbar: true,
      coreState: finalModelState.core,
      refinementState: finalModelState.refinement,
      resourceCount,
      coreReadinessSource: 'settings-click-controlled-install',
      translationAdvertised: false
    },
    windowInteraction,
    applicationLifecycle,
    interactionLifecycle,
    sourceIdentity: {
      productPayloadVersion: productPayloadIdentity.version,
      productPayloadFileCount: productPayloadIdentity.fileCount,
      productPayloadSha256: productPayloadIdentity.sha256
    },
    privacy: {
      physicalAudioSourceOpened: false,
      audioPersisted: false,
      transcriptTextPersistedInReport: false,
      localPathsPersistedInReport: false
    },
    limitations: [
      'fake-asr-no-physical-audio',
      'controlled-model-fixtures-no-real-tensors',
      'deterministic-205-segment-fixture-not-two-hour-i3',
      'controlled-pointer-and-focus-no-human-dwm',
      'no-system-dpi-or-mixed-scale-qualification',
      ...(app.isPackaged
        ? ['not-clean-machine-i4', 'packaged-test-variant-not-release-installer']
        : ['not-packaged-i4'])
    ]
  }
  await closeModelTransport()
  let rendererExitObserved = false
  const observeRendererExit = (_event, action) => {
    if (action !== 'close' || rendererExitObserved) return
    rendererExitObserved = true
    applicationLifecycle.rendererExitRequested = true
    fs.writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    process.stdout.write(`${JSON.stringify(report)}\n`)
    ipcMain.removeListener(CHANNELS.TOOLBAR_ACTION, observeRendererExit)
  }
  ipcMain.prependListener(CHANNELS.TOOLBAR_ACTION, observeRendererExit)
  await rendererValue(toolbar, `document.querySelector('button[data-act="close"]').click(); true`).catch(() => false)
  if (!rendererExitObserved) throw new Error('toolbar renderer exit action was not observed')
}

app.on('will-quit', (event) => {
  if (watchdog) clearTimeout(watchdog)
  if (controlledCursorBoundary) {
    controlledCursorBoundary.restore()
    controlledCursorBoundary = null
  }
  void closeModelTransport().catch(() => {})
  if (smokeFailed) {
    /* Electron's app.quit() may otherwise normalize a failed smoke to status
       zero after the product's graceful before-quit barrier. Let every
       will-quit listener record its evidence, then preserve a failing status. */
    event.preventDefault()
    setImmediate(() => app.exit(1))
  }
})

void launchSmokeApplication().catch(async (error) => {
  smokeFailed = true
  console.error(error && error.stack ? error.stack : error)
  await closeModelTransport().catch(() => {})
  process.exitCode = 1
  app.exit(1)
})
