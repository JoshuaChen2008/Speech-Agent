'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { app, BrowserWindow, ipcMain } = require('electron')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { HistoryService } = require('../../src/main/services/history-service')
const { FakeRuntimeAdapter } = require('../../src/main/session/fake-runtime-adapter')
const { SessionCoordinator } = require('../../src/main/session/session-coordinator')
const { DEV_MODEL_VALUE, resolveRuntimeOptions } = require('../../src/main/runtime-options')
const { AgentRunService } = require('../../src/agent/formal-run/agent-run-service')
const { SessionSummaryRunService } = require('../../src/agent/formal-run/session-summary-run-service')
const { registerAgentRunIpc } = require('../../src/main/ipc/agent-run-ipc')
const { registerSessionSummaryRunIpc } = require('../../src/main/ipc/session-summary-run-ipc')
const CHANNELS = require('../../src/main/ipc/channels')

const origin = process.env.AGENT_BAR_JOURNEY_ORIGIN
const userData = process.env.AGENT_BAR_JOURNEY_USER_DATA
const projectRoot = path.resolve(__dirname, '..', '..')
const toolbarPreload = path.join(projectRoot, 'src', 'preload', 'toolbar.js')
const captionPreload = path.join(projectRoot, 'src', 'preload', 'caption.js')
const agentPreload = path.join(projectRoot, 'src', 'preload', 'agent.js')
const databasePath = typeof userData === 'string' ? path.join(userData, 'speech-agent.sqlite') : ''

const state = {
  toolbar: null,
  caption: null,
  coordinator: null,
  subtitleLifecycle: { started: false, stopped: false },
  agent: null,
  agentWindow: null,
  agentOpenCount: 0,
  agentFocusCount: 0,
  agentCloseCount: 0
}

function validEnvironment () {
  return origin === 'http://127.0.0.1:5173' && typeof userData === 'string' && path.isAbsolute(userData)
}

function wait (milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitFor (predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true
    } catch { /* the renderer may still be loading */ }
    await wait(25)
  }
  return false
}

async function waitForRenderer (win, expression, timeoutMs = 10000) {
  return waitFor(async () => !win.isDestroyed() && Boolean(await win.webContents.executeJavaScript(expression, true)), timeoutMs)
}

function createWindow (options) {
  return new BrowserWindow({
    show: false,
    ...options,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      ...(options.webPreferences || {})
    }
  })
}

function createAgentWindow () {
  if (state.agent && !state.agent.isDestroyed()) {
    state.agent.show()
    state.agent.focus()
    state.agentFocusCount += 1
    return state.agent
  }
  state.agentOpenCount += 1
  const win = createWindow({
    width: 720,
    height: 640,
    minWidth: 520,
    minHeight: 420,
    title: 'Agent Bar',
    webPreferences: { preload: agentPreload }
  })
  state.agent = win
  state.agentWindow = win
  win.once('closed', () => {
    state.agentCloseCount += 1
    if (state.agent === win) state.agent = null
  })
  void win.loadURL(`${origin}/agent/index.html`).catch(() => {})
  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) {
      win.show()
      win.focus()
    }
  })
  return win
}

function installToolbarHandlers () {
  ipcMain.handle(CHANNELS.LOCK_GET, () => false)
  ipcMain.handle(CHANNELS.TOOLBAR_LAYOUT_GET_CONTEXT, () => ({ generation: 1 }))
  ipcMain.handle(CHANNELS.CONFIG_GET, () => ({
    theme: 'dark', systemDark: false, fontSize: 30, radius: 10, opacity: 0.86,
    toolbarOpacity: 0.82, barColor: '', captionTextColor: ''
  }))
  ipcMain.handle(CHANNELS.RUNTIME_GET, () => null)
  ipcMain.handle(CHANNELS.REFINEMENT_NOTICE_GET, () => null)
  ipcMain.handle(CHANNELS.CAPTION_STATE_GET, (event) => {
    if (!state.caption || state.caption.isDestroyed() || event.sender !== state.caption.webContents) throw new Error('fixture caption sender denied')
    return state.coordinator?.getCaptionState() || { schemaVersion: 1, revision: 0, sessionId: null, segments: [] }
  })
  ipcMain.handle(CHANNELS.CAPTION_VIEWPORT_EVICT, (event, report) => {
    if (!state.caption || state.caption.isDestroyed() || event.sender !== state.caption.webContents) throw new Error('fixture caption sender denied')
    return state.coordinator?.acceptCaptionViewportEviction(report) === true
  })
  ipcMain.handle(CHANNELS.RUNTIME_COMMAND, () => ({ ok: false, message: 'fixture command unavailable' }))
  ipcMain.handle(CHANNELS.AGENT_OPEN, (event) => {
    if (!state.toolbar || state.toolbar.isDestroyed() || event.sender !== state.toolbar.webContents) throw new Error('fixture toolbar sender denied')
    createAgentWindow()
    return { schemaVersion: 1, phase: 'ready', message: '' }
  })
  ipcMain.on(CHANNELS.TOOLBAR_LAYOUT_REPORT_RECT, () => {})
  ipcMain.on(CHANNELS.TOOLBAR_ACTION, (event, action) => {
    if (!state.toolbar || state.toolbar.isDestroyed() || event.sender !== state.toolbar.webContents) return
    if (action === 'agent') createAgentWindow()
  })
  ipcMain.on(CHANNELS.AGENT_CLOSE, (event) => {
    if (!state.agent || state.agent.isDestroyed() || event.sender !== state.agent.webContents) return
    state.agent.close()
  })
}

async function seedSubtitleSession (gateway) {
  const recorder = new SqliteSessionRecorder({ gateway, now: () => 1800000000000 })
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  const coordinator = new SessionCoordinator({
    adapter,
    persistenceSink: recorder,
    runtimeOptions: { ...resolveRuntimeOptions({ LIVE_SUBTITLE_DEV_MODEL: DEV_MODEL_VALUE }), refinementAvailable: false },
    configuration: { onboardingCompleted: true, onboardingPreset: 'meeting', mic: false, loopback: true, refinementEnabled: false },
    idFactory: () => 'session.s5.real'
  })
  const started = await coordinator.command('start')
  if (!started.ok) throw new Error('subtitle session did not start')
  adapter.emitCaption({
    schemaVersion: 1,
    sessionId: 'session.s5.real',
    sourceId: 'loopback',
    segmentId: 'segment.s5.real',
    sequence: 1,
    revision: 1,
    kind: 'final',
    t0: 0,
    t1: 1200,
    text: '确定性测试字幕',
    translation: null
  })
  const stopped = await coordinator.command('stop')
  if (!stopped.ok) throw new Error('subtitle session did not stop')
  await recorder.flush()
  state.coordinator = coordinator
  state.subtitleLifecycle = { started: true, stopped: true }
}

async function runJourney () {
  if (!validEnvironment()) return 64
  fs.mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
  app.on('window-all-closed', () => {})
  installToolbarHandlers()

  const gateway = new StorageGateway({ databasePath })
  await gateway.start()
  await seedSubtitleSession(gateway)

  const history = new HistoryService({
    gateway,
    showSaveDialog: async () => ({ canceled: false, filePath: path.join(userData, 'subtitle-export.txt') })
  })
  const agentService = new AgentRunService({ storage: gateway, modelAccess: null })
  registerAgentRunIpc({
    ipcMain,
    service: agentService,
    authorize: (event) => {
      if (!state.agent || state.agent.isDestroyed() || event.sender !== state.agent.webContents) throw new Error('fixture IPC sender denied')
    }
  })
  registerSessionSummaryRunIpc({
    ipcMain,
    service: new SessionSummaryRunService({ storage: gateway, runService: agentService }),
    authorize: (event) => {
      if (!state.agent || state.agent.isDestroyed() || event.sender !== state.agent.webContents) throw new Error('fixture IPC sender denied')
    }
  })

  state.caption = createWindow({ width: 800, height: 420, webPreferences: { preload: captionPreload } })
  await state.caption.loadURL(`${origin}/caption/index.html`)
  if (!await waitForRenderer(state.caption, "Boolean(document.querySelector('.caption-card'))")) throw new Error('caption renderer did not initialize')

  state.toolbar = createWindow({ width: 720, height: 120, webPreferences: { preload: toolbarPreload } })
  await state.toolbar.loadURL(`${origin}/toolbar/index.html`)
  if (!await waitForRenderer(state.toolbar, "Boolean(document.querySelector('#windowControls button[data-act=\\\"agent\\\"]'))")) throw new Error('toolbar Agent entry did not initialize')
  await state.toolbar.webContents.executeJavaScript("window.shell.openAgent(); true", true)
  if (!await waitFor(() => state.agent && !state.agent.isDestroyed())) throw new Error('Agent window did not open')
  if (!await waitForRenderer(state.agent, "Boolean(window.agentApi && document.querySelector('.agent-shell'))")) throw new Error('Agent preload bridge did not initialize')
  if (!await waitForRenderer(state.agent, "(document.querySelector('.eligibility')?.textContent || '').includes('请先在设置中选择助手模型')")) throw new Error('Agent eligibility did not cross exact IPC')

  const submitResponse = await state.agent.webContents.executeJavaScript(`window.agentApi.submit(${JSON.stringify({
    contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0',
    scope: { kind: 'session', reference: 'session.s5.real' },
    prompt: '请生成会后结构化纪要', client_idempotency_key: 'agent.fixture.unavailable'
  })})`, true)
  if (!submitResponse || submitResponse.ok !== false || submitResponse.error?.code !== 'AGENT_RUN_UNAVAILABLE') throw new Error('Agent unavailable response was not exact')

  await state.toolbar.webContents.executeJavaScript("window.shell.openAgent(); true", true)
  if (state.agentOpenCount !== 1 || state.agentFocusCount < 1) throw new Error('Agent window reuse and focus were not observed')
  const agentClosePromise = new Promise((resolve) => state.agent.once('closed', resolve))
  await state.agent.webContents.executeJavaScript('window.agentApi.close()', true)
  await agentClosePromise
  if (!state.agentWindow.isDestroyed() || state.caption.isDestroyed() || !state.subtitleLifecycle.started || !state.subtitleLifecycle.stopped) throw new Error('Agent close affected subtitle window')

  const sessions = await history.listSessions({ limit: 50, cursor: null })
  const page = await history.getSessionPage({ sessionId: 'session.s5.real', limit: 50, cursor: null })
  const exported = await history.exportSession({ sessionId: 'session.s5.real', format: 'txt' })
  const exportPath = path.join(userData, 'subtitle-export.txt')
  const exportBytes = fs.readFileSync(exportPath)
  if (exported.status !== 'saved' || sessions.items.length !== 1 || page.items.length !== 1 || exportBytes.length < 1) throw new Error('subtitle history/export did not survive Agent unavailability')

  const report = {
    schemaVersion: 1,
    result: 'pass',
    toolbarAgentEntry: true,
    agentOpenCount: state.agentOpenCount,
    agentFocusObserved: state.agentFocusCount >= 1,
    agentClosed: state.agentCloseCount === 1,
    providerEligibilityObserved: true,
    subtitleLifecycleStarted: state.subtitleLifecycle.started,
    subtitleLifecycleStopped: state.subtitleLifecycle.stopped,
    subtitleWindowAlive: !state.caption.isDestroyed(),
    subtitleSessionCount: sessions.items.length,
    subtitlePageItems: page.items.length,
    subtitleExportBytes: exportBytes.length,
    subtitleExportSha256: crypto.createHash('sha256').update(exportBytes).digest('hex')
  }
  process.stdout.write(`${JSON.stringify(report)}\n`)
  await state.coordinator?.dispose()
  await gateway.shutdown()
  if (!state.toolbar.isDestroyed()) state.toolbar.destroy()
  if (!state.caption.isDestroyed()) state.caption.destroy()
  return 0
}

if (!validEnvironment()) {
  app.exit(64)
} else {
  app.whenReady().then(async () => {
    try {
      const code = await runJourney()
      setTimeout(() => app.exit(code), 10)
    } catch {
      process.stderr.write(`${JSON.stringify({ schemaVersion: 1, result: 'fail', error: 'journey_failed' })}\n`)
      try { if (state.agent && !state.agent.isDestroyed()) state.agent.destroy() } catch {}
      try { if (state.toolbar && !state.toolbar.isDestroyed()) state.toolbar.destroy() } catch {}
      try { if (state.caption && !state.caption.isDestroyed()) state.caption.destroy() } catch {}
      setTimeout(() => app.exit(1), 10)
    }
  }).catch(() => app.exit(1))
}
