'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { fileURLToPath } = require('node:url')
const electron = require('electron')
const { AgentMvpRuntimeHost } = require('./runtime-host')
const { AgentMvpSettingsStore } = require('./settings-store')
const { CredentialVault } = require('./credential-vault')
const { exact, publicError } = require('./protocol')
const { AgentCoreError } = require('../agent-core/errors')
const { REPORT_SCHEMA_VERSION, runSmokeScenario } = require('./smoke-harness')

const { app, BrowserWindow, ipcMain, safeStorage } = electron
const smokeMode = process.env.AGENT_MVP_SMOKE === '1'
const smokeScenario = smokeMode ? (process.env.AGENT_MVP_SMOKE_SCENARIO || 'happy-restart') : 'happy-restart'
const smokePhase = smokeMode ? (process.env.AGENT_MVP_SMOKE_PHASE || 'first') : 'first'
const smokeCredential = smokeMode && typeof process.env.AGENT_MVP_SMOKE_CREDENTIAL === 'string' && /^[a-f0-9]{48}$/.test(process.env.AGENT_MVP_SMOKE_CREDENTIAL)
  ? process.env.AGENT_MVP_SMOKE_CREDENTIAL
  : 'journey-credential'
const SMOKE_SCENARIOS = new Set(['happy-restart', 'boundary-matrix', 'interruption-recovery', 'worker-replacement', 'credential-session-only'])
const dataRoot = smokeMode && process.env.AGENT_MVP_USER_DATA
  ? path.resolve(process.env.AGENT_MVP_USER_DATA)
  : path.join(app.getPath('appData'), 'Live Subtitle Agent MVP')
app.setPath('userData', dataRoot)
app.setName('Live Subtitle Agent MVP')

let window = null; let runtime = null; let shuttingDown = false
const rendererPath = path.join(__dirname, 'renderer-dist', 'index.html')

function allowedSender (event) {
  if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false
  try { return path.resolve(fileURLToPath(event.senderFrame.url)) === path.resolve(rendererPath) } catch { return false }
}
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
  if (!SMOKE_SCENARIOS.has(smokeScenario)) throw new AgentCoreError('AGENT_REQUEST_INVALID')
  let claimsEnabled = smokeScenario !== 'boundary-matrix'
  let delayNextClaimContinuation = smokeMode && smokeScenario === 'boundary-matrix'
  fs.mkdirSync(path.join(dataRoot, 'agent-diagnostics'), { recursive: true })
  const settings = new AgentMvpSettingsStore(path.join(dataRoot, 'agent-mvp-settings.json'))
  const credentialStorage = smokeMode && smokeScenario === 'credential-session-only'
    ? { isEncryptionAvailable: () => false }
    : safeStorage
  const vault = new CredentialVault({ safeStorage: credentialStorage, credentialPath: path.join(dataRoot, 'agent-provider.credential') })
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
    onChanged: (snapshot) => send('agent-mvp:state', snapshot), onEvent: (event) => send('agent-mvp:event', event),
    leaseMs: smokeMode && smokeScenario === 'interruption-recovery' ? 1000 : smokeMode && smokeScenario === 'boundary-matrix' ? 10000 : smokeMode ? 5000 : 60000,
    retryDelaysMs: smokeMode && smokeScenario === 'boundary-matrix' ? [300, 600] : smokeMode && smokeScenario === 'worker-replacement' ? [500, 1000] : smokeMode ? [100, 200] : [2000, 10000],
    claimGate: () => claimsEnabled,
    afterClaim: async () => {
      if (!delayNextClaimContinuation) return
      delayNextClaimContinuation = false
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
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
      const report = await runSmokeScenario({
        window, runtime, scenario: smokeScenario, phase: smokePhase,
        resumeClaims: () => { claimsEnabled = true }, smokeCredential
      })
      const line = `${JSON.stringify(report)}\n`
      if (smokeScenario === 'interruption-recovery' && smokePhase === 'interrupt') {
        await new Promise((resolve) => process.stdout.write(line, resolve))
        process.exit(86)
        return
      }
      process.stdout.write(line)
      app.quit()
    } catch (error) {
      const failureStep = await window?.webContents.executeJavaScript('window.__agentMvpSmokeStep || "bootstrap"').catch(() => 'bootstrap')
      const rendererErrorCode = await window?.webContents.executeJavaScript('window.__agentMvpSmokeErrorCode || document.querySelector("[role=alert]")?.dataset.errorCode || null').catch(() => null)
      process.stdout.write(`${JSON.stringify({
        schemaVersion: REPORT_SCHEMA_VERSION, result: 'fail', scenario: smokeScenario, phase: smokePhase,
        errorCode: rendererErrorCode || publicError(error).code, failureStep,
        transcriptInReport: false, audioPersisted: false, credentialInReport: false,
        internalThoughtInReport: false, localPathInReport: false
      })}\n`)
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
