'use strict'

const {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  nativeTheme,
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
const { SessionCoordinator, failure, success } = require('./main/session/session-coordinator')

/** @type {BrowserWindow | null} */ let captionWin = null
/** @type {BrowserWindow | null} */ let toolbarWin = null
/** @type {BrowserWindow | null} */ let settingsWin = null
/** @type {SessionCoordinator | null} */ let coordinator = null

const windowRoles = new Map()
let locked = false

const MARGIN = 20
const TB_MARGIN = 16
const INSET = 12
const CAP_W = 920
const CAP_H = 190
const CAP_LIMITS = Object.freeze({ minW: 480, maxW: 1600, minH: 140, maxH: 420 })
const TB_W = 568 + TB_MARGIN * 2
const TB_H = 40 + TB_MARGIN * 2
const RESIZE_EDGES = Object.freeze(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'])

function logError (scope, error) {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`[${scope}] ${message}`)
}

function preloadPath (role) {
  return path.join(__dirname, 'preload', `${role}.js`)
}

function payload () {
  return { ...config.get(), systemDark: nativeTheme.shouldUseDarkColors }
}

function send (win, channel, value) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, value)
}

function broadcastConfig () {
  const value = payload()
  for (const win of [captionWin, toolbarWin, settingsWin]) send(win, CHANNELS.CONFIG_CHANGED, value)
}

function broadcastSnapshot (snapshot) {
  for (const win of [toolbarWin, settingsWin]) send(win, CHANNELS.RUNTIME_CHANGED, snapshot)
}

function registerWindowRole (win, role) {
  const senderId = win.webContents.id
  windowRoles.set(senderId, role)
  win.webContents.once('destroyed', () => {
    windowRoles.delete(senderId)
    stopDrag(senderId)
    stopResize(senderId)
  })
  win.on('blur', () => {
    stopDrag(senderId)
    stopResize(senderId)
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

function makeOverlay (role, width, height, x, y, file, focusable = true) {
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
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.loadFile(file)
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

  captionWin = makeOverlay('caption', capW, capH, cx, cy, path.join(__dirname, 'caption', 'index.html'), false)
  captionWin.setResizable(true)
  toolbarWin = makeOverlay('toolbar', TB_W, TB_H, cx, cy, path.join(__dirname, 'toolbar', 'index.html'), true)

  captionWin.webContents.on('console-message', (details) => console.log('[caption]', details.message))
  toolbarWin.webContents.on('console-message', (details) => console.log('[toolbar]', details.message))

  const raiseToolbar = () => {
    if (toolbarWin && !toolbarWin.isDestroyed()) toolbarWin.moveTop()
  }
  captionWin.once('ready-to-show', () => { captionWin.show(); raiseToolbar() })
  toolbarWin.once('ready-to-show', () => { toolbarWin.show(); dock() })
  setTimeout(raiseToolbar, 300)

  captionWin.on('closed', () => { stopResize(null, true); stopDrag(null, true); captionWin = null })
  toolbarWin.on('closed', () => { stopDrag(null, true); toolbarWin = null })
}

function dock () {
  if (!captionWin || captionWin.isDestroyed() || !toolbarWin || toolbarWin.isDestroyed()) return
  const caption = captionWin.getBounds()
  const toolbar = toolbarWin.getBounds()
  const cardRight = caption.x + caption.width - MARGIN
  const cardTop = caption.y + MARGIN
  const x = Math.round(cardRight - INSET - (toolbar.width - TB_MARGIN))
  const y = Math.round(cardTop + INSET - TB_MARGIN)
  toolbarWin.setBounds({ x, y, width: TB_W, height: TB_H })
  toolbarWin.moveTop()
}

function intendedSize (win) {
  if (win === toolbarWin) return { width: TB_W, height: TB_H }
  const bounds = win.getBounds()
  return { width: bounds.width, height: bounds.height }
}

function openSettingsWindow () {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus()
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
  hardenContents(settingsWin)
  settingsWin.webContents.on('console-message', (details) => console.log('[settings]', details.message))
  settingsWin.once('ready-to-show', () => settingsWin.show())
  settingsWin.on('closed', () => { stopDrag(null, true); settingsWin = null })
  settingsWin.loadFile(path.join(__dirname, 'settings', 'settings.html'))
}

let dragState = null

function dragTick () {
  const state = dragState
  if (!state) return
  if (!state.win || state.win.isDestroyed()) {
    stopDrag(null, true)
    return
  }
  const point = screen.getCursorScreenPoint()
  state.win.setBounds({
    x: point.x - state.offX,
    y: point.y - state.offY,
    width: state.width,
    height: state.height
  })
  if (state.redock) dock()
  if (dragState === state) state.timer = setTimeout(dragTick, 8)
}

function startDrag (event) {
  const { role, win: sender, senderId } = requireSender(event, CHANNELS.DRAG_START)
  stopDrag(null, true)
  stopResize(null, true)
  let target = sender
  let redock = false
  if (role === 'toolbar' && !locked) {
    target = captionWin
    redock = true
  } else if (role === 'caption') {
    if (locked) return
    redock = true
  }
  if (!target || target.isDestroyed()) return
  const point = screen.getCursorScreenPoint()
  const bounds = target.getBounds()
  const size = intendedSize(target)
  dragState = {
    senderId,
    win: target,
    offX: point.x - bounds.x,
    offY: point.y - bounds.y,
    width: size.width,
    height: size.height,
    redock,
    timer: null
  }
  dragTick()
}

function stopDrag (senderId, force = false) {
  if (!dragState || (!force && dragState.senderId !== senderId)) return
  if (dragState.timer) clearTimeout(dragState.timer)
  dragState = null
}

let resizeState = null

function resizeTick () {
  const state = resizeState
  if (!state) return
  if (!state.win || state.win.isDestroyed()) {
    stopResize(null, true)
    return
  }
  const point = screen.getCursorScreenPoint()
  const dx = point.x - state.origin.x
  const dy = point.y - state.origin.y
  let width = state.start.width
  let height = state.start.height
  if (state.edge.includes('e')) width = state.start.width + dx
  if (state.edge.includes('w')) width = state.start.width - dx
  if (state.edge.includes('s')) height = state.start.height + dy
  if (state.edge.includes('n')) height = state.start.height - dy
  width = clamp(width, state.limits.minW, state.limits.maxW)
  height = clamp(height, state.limits.minH, state.limits.maxH)
  const x = state.edge.includes('w') ? state.start.x + state.start.width - width : state.start.x
  const y = state.edge.includes('n') ? state.start.y + state.start.height - height : state.start.y
  state.win.setBounds({ x, y, width, height })
  dock()
  if (resizeState === state) state.timer = setTimeout(resizeTick, 8)
}

function startResize (event, edge) {
  const { win, senderId } = requireSender(event, CHANNELS.RESIZE_START)
  if (win !== captionWin || locked || !RESIZE_EDGES.includes(edge)) return
  stopDrag(null, true)
  stopResize(null, true)
  resizeState = {
    senderId,
    win,
    edge,
    start: win.getBounds(),
    origin: screen.getCursorScreenPoint(),
    limits: captionLimits(win),
    timer: null
  }
  resizeTick()
}

function stopResize (senderId, force = false) {
  if (!resizeState || (!force && resizeState.senderId !== senderId)) return
  const state = resizeState
  if (state.timer) clearTimeout(state.timer)
  resizeState = null
  if (!state.win || state.win.isDestroyed()) return
  const bounds = state.win.getBounds()
  try {
    config.set({ captionWidth: bounds.width, captionHeight: bounds.height })
    broadcastConfig()
  } catch (error) {
    logError('config.resize', error)
  }
}

function applyLock (on) {
  locked = on
  if (on) {
    stopResize(null, true)
    stopDrag(null, true)
  }
  if (captionWin && !captionWin.isDestroyed()) {
    if (on) captionWin.setIgnoreMouseEvents(true, { forward: true })
    send(captionWin, CHANNELS.LOCK_CHANGED, on)
  }
  send(toolbarWin, CHANNELS.LOCK_CHANGED, on)
  if (!on) dock()
}

function createCoordinator () {
  const runtimeOptions = resolveRuntimeOptions()
  if (runtimeOptions.warning) console.warn(`[runtime] ${runtimeOptions.warning}`)
  coordinator = new SessionCoordinator({
    adapterFactory: () => new FakeRuntimeAdapter(),
    runtimeOptions,
    configuration: config.get(),
    onListenerError: (error) => logError('runtime.listener', error)
  })
  coordinator.onSnapshot(broadcastSnapshot)
  coordinator.onCaption((event) => send(captionWin, CHANNELS.CAPTION_EVENT, event))
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

ipcMain.on(CHANNELS.MOUSE_THROUGH, (event, ignore) => {
  const { win } = requireSender(event, CHANNELS.MOUSE_THROUGH)
  if (win === captionWin && locked && !ignore) return
  win.setIgnoreMouseEvents(!!ignore, { forward: true })
})
ipcMain.on(CHANNELS.DRAG_START, startDrag)
ipcMain.on(CHANNELS.DRAG_END, (event) => {
  const { senderId } = requireSender(event, CHANNELS.DRAG_END)
  stopDrag(senderId)
})
ipcMain.on(CHANNELS.RESIZE_START, startResize)
ipcMain.on(CHANNELS.RESIZE_END, (event) => {
  const { senderId } = requireSender(event, CHANNELS.RESIZE_END)
  stopResize(senderId)
})
ipcMain.on(CHANNELS.LOCK_TOGGLE, (event) => {
  requireSender(event, CHANNELS.LOCK_TOGGLE)
  applyLock(!locked)
})
ipcMain.handle(CHANNELS.LOCK_GET, (event) => {
  requireSender(event, CHANNELS.LOCK_GET)
  return locked
})
ipcMain.on(CHANNELS.TOOLBAR_ACTION, (event, action) => {
  requireSender(event, CHANNELS.TOOLBAR_ACTION)
  if (action === 'settings') openSettingsWindow()
  else if (action === 'close') app.quit()
})
ipcMain.on(CHANNELS.SETTINGS_CLOSE, (event) => {
  const { win } = requireSender(event, CHANNELS.SETTINGS_CLOSE)
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
ipcMain.handle(CHANNELS.RUNTIME_COMMAND, async (event, name) => {
  requireSender(event, CHANNELS.RUNTIME_COMMAND)
  try {
    return await coordinator.command(name)
  } catch (error) {
    logError('runtime.command', error)
    return failure('COMMAND_FAILED', '命令执行失败', true)
  }
})

nativeTheme.on('updated', broadcastConfig)

app.whenReady().then(() => {
  config.load()
  createCoordinator()
  createWindows()
  if (!config.get().onboardingCompleted) openSettingsWindow()

  globalShortcut.register('CommandOrControl+Alt+L', () => applyLock(!locked))
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindows()
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopDrag(null, true)
  stopResize(null, true)
  if (coordinator) coordinator.dispose()
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
