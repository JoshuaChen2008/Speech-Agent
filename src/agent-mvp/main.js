'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const electron = require('electron')
const { AgentMvpRuntimeHost } = require('./runtime-host')
const { AgentMvpSettingsStore } = require('./settings-store')
const { CredentialVault } = require('./credential-vault')
const { exact, publicError } = require('./protocol')
const { AgentCoreError } = require('../agent-core/errors')

const { app, BrowserWindow, ipcMain, safeStorage } = electron
const smokeMode = process.env.AGENT_MVP_SMOKE === '1'
const dataRoot = smokeMode && process.env.AGENT_MVP_USER_DATA
  ? path.resolve(process.env.AGENT_MVP_USER_DATA)
  : path.join(app.getPath('appData'), 'Live Subtitle Agent MVP')
app.setPath('userData', dataRoot)
app.setName('Live Subtitle Agent MVP')

let window = null; let runtime = null; let shuttingDown = false
const rendererPath = path.join(__dirname, 'renderer-dist', 'index.html')
const rendererUrl = pathToFileURL(rendererPath).toString()

function allowedSender (event) { return event.senderFrame?.url === rendererUrl }
function reply (handler) {
  return async (event, payload) => {
    if (!allowedSender(event)) return { ok: false, error: { code: 'AGENT_PERMISSION_DENIED' } }
    try { return { ok: true, result: await handler(payload) } } catch (error) { return { ok: false, error: publicError(error) } }
  }
}

function send (channel, payload) {
  if (window && !window.isDestroyed()) window.webContents.send(channel, payload)
}

async function bootstrap () {
  fs.mkdirSync(path.join(dataRoot, 'agent-diagnostics'), { recursive: true })
  const settings = new AgentMvpSettingsStore(path.join(dataRoot, 'agent-mvp-settings.json'))
  const vault = new CredentialVault({ safeStorage, credentialPath: path.join(dataRoot, 'agent-provider.credential') })
  const providerSnapshot = async (job = null) => {
    const value = settings.get()
    if (job && (job.provider !== value.provider || job.model !== value.model)) throw new AgentCoreError('AGENT_REQUEST_INVALID')
    if (value.provider === 'deterministic-test') {
      return { provider: value.provider, configuration: { provider: value.provider, baseUrl: '', model: value.model }, apiKey: null }
    }
    const apiKey = vault.get()
    if (!apiKey) throw new AgentCoreError('AGENT_PROVIDER_AUTH_FAILED')
    return { provider: value.provider, configuration: { provider: value.provider, baseUrl: value.baseUrl, model: value.model }, apiKey }
  }
  runtime = new AgentMvpRuntimeHost({
    electron, databasePath: path.join(dataRoot, 'agent-mvp.sqlite'), providerSnapshot,
    onChanged: (snapshot) => send('agent-mvp:state', snapshot), onEvent: (event) => send('agent-mvp:event', event)
  })
  await runtime.start()

  const getState = async () => ({
    runtime: await runtime.snapshot(),
    provider: { ...settings.get(), ...vault.status() }
  })
  ipcMain.handle('agent-mvp:get-state', reply(async (payload) => { exact(payload, []); return getState() }))
  ipcMain.handle('agent-mvp:save-provider', reply(async (payload) => {
    exact(payload, ['provider', 'baseUrl', 'model', 'cloudDisclosureAccepted', 'apiKey'])
    const saved = settings.save({ provider: payload.provider, baseUrl: payload.baseUrl, model: payload.model, cloudDisclosureAccepted: payload.cloudDisclosureAccepted })
    if (payload.apiKey !== '') vault.set(payload.apiKey)
    const status = vault.status(); send('agent-mvp:state', (await getState()).runtime)
    return { ...saved, ...status }
  }))
  ipcMain.handle('agent-mvp:create-fixture', reply(async (payload) => { exact(payload, ['sourceId']); return runtime.createFixture(payload.sourceId) }))
  ipcMain.handle('agent-mvp:messages', reply(async (payload) => { exact(payload, ['sessionId']); return runtime.messages(payload.sessionId) }))
  ipcMain.handle('agent-mvp:chat', reply(async (payload) => { exact(payload, ['sessionId', 'prompt']); return runtime.chat(payload) }))
  ipcMain.handle('agent-mvp:preview', reply(async (payload) => { exact(payload, ['sessionId']); return runtime.preview(payload) }))
  ipcMain.handle('agent-mvp:confirm', reply(async (payload) => {
    exact(payload, ['previewId', 'decision']); if (!['accepted', 'rejected'].includes(payload.decision)) throw new AgentCoreError('AGENT_REQUEST_INVALID')
    return runtime.confirm(payload)
  }))
  ipcMain.handle('agent-mvp:cancel', reply(async (payload) => { exact(payload, ['runId']); return runtime.cancel(payload.runId) }))

  window = new BrowserWindow({
    width: 1000, height: 680, minWidth: 820, minHeight: 560, show: false, backgroundColor: '#f3f3f3',
    title: 'Live Subtitle Agent · 调试聊天',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  window.removeMenu(); if (!smokeMode) window.once('ready-to-show', () => window?.show()); await window.loadFile(rendererPath)
  window.on('closed', () => { window = null })
  if (smokeMode) {
    try {
      const fixture = await runtime.createFixture('loopback')
      const chat = await runtime.chat({ sessionId: fixture.inputRef.sessionId, prompt: '验证固定上下文工具。' })
      const preview = await runtime.preview({ sessionId: fixture.inputRef.sessionId })
      await runtime.confirm({ previewId: preview.previewId, decision: 'accepted' })
      let snapshot = await runtime.snapshot()
      const deadline = Date.now() + 10000
      while (!snapshot.jobs.some((job) => job.state === 'succeeded') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25)); snapshot = await runtime.snapshot()
      }
      const succeeded = snapshot.jobs.some((job) => job.state === 'succeeded')
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, result: succeeded ? 'pass' : 'fail', sessionCount: snapshot.sessions.length, messageCount: chat.messages.length, jobCount: snapshot.jobs.length, artifactCount: snapshot.artifacts.length, transcriptInReport: false, audioPersisted: false })}\n`)
      app.quit()
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, result: 'fail', errorCode: publicError(error).code, transcriptInReport: false, audioPersisted: false })}\n`)
      app.exit(1)
    }
  }
}

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.show(); window.focus() } })
  app.whenReady().then(bootstrap).catch(() => { app.exit(1) })
  app.on('window-all-closed', () => app.quit())
  app.on('before-quit', (event) => {
    if (shuttingDown || !runtime) return
    event.preventDefault(); shuttingDown = true
    runtime.stop().finally(() => app.quit())
  })
}
