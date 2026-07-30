'use strict'

// @ts-check

/* Real Electron product-shell journey. It loads src/main.js with an isolated
   userData directory and the explicit fake-ASR development seam, then drives
   the actual settings/toolbar/caption/history renderers through their DOM and
   preload IPC. It never opens a physical audio source and never kills a
   process by executable name. */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { PRODUCTION_MODEL_MANIFEST } = require('../src/main/services/model-manifest')

const PROJECT_ROOT = path.resolve(__dirname, '..')

function isWithin (parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function parseArguments (argv) {
  const values = { workDir: null, report: null }
  for (let index = 0; index < argv.length; index += 1) {
    const next = argv[index + 1]
    if (argv[index] === '--work-dir') { values.workDir = next; index += 1 } else if (argv[index] === '--report') { values.report = next; index += 1 } else throw new Error(`unknown argument: ${argv[index]}`)
  }
  if (!values.workDir || !values.report) throw new Error('--work-dir and --report are required')
  const artifacts = path.join(PROJECT_ROOT, '.artifacts')
  const workDir = path.resolve(PROJECT_ROOT, values.workDir)
  const report = path.resolve(PROJECT_ROOT, values.report)
  if (!isWithin(artifacts, workDir) || !isWithin(artifacts, report)) throw new Error('smoke outputs must stay under .artifacts')
  if (fs.existsSync(workDir)) throw new Error('work directory must not already exist')
  return { workDir, report }
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

function createDevelopmentModelFixtures (workDir) {
  const fixtureRoot = path.join(workDir, 'model-fixtures')
  const realtime = PRODUCTION_MODEL_MANIFEST.artifacts.find((artifact) => artifact.id === 'x-asr-160ms')
  const refinement = PRODUCTION_MODEL_MANIFEST.artifacts.find((artifact) => artifact.id === 'x-asr-offline')
  const vad = PRODUCTION_MODEL_MANIFEST.artifacts.find((artifact) => artifact.id === 'silero-vad')
  if (!realtime || !refinement || !vad) throw new Error('production model manifest is incomplete')

  const realtimeRoot = path.join(fixtureRoot, 'realtime')
  const refinementRoot = path.join(fixtureRoot, 'refinement')
  const vadRoot = path.join(fixtureRoot, 'vad')
  for (const directory of [realtimeRoot, refinementRoot, vadRoot]) fs.mkdirSync(directory, { recursive: true })
  for (const file of realtime.requiredFiles) fs.writeFileSync(path.join(realtimeRoot, file), 'product-shell-fixture\n')
  for (const file of refinement.requiredFiles) fs.writeFileSync(path.join(refinementRoot, file), 'product-shell-fixture\n')
  const vadPath = path.join(vadRoot, vad.fileName)
  fs.writeFileSync(vadPath, 'product-shell-fixture\n')
  return { realtimeRoot, refinementRoot, vadPath }
}

const options = parseArguments(process.argv.slice(2))
fs.mkdirSync(options.workDir, { recursive: false })
const userDataDir = path.join(options.workDir, 'user-data')
fs.mkdirSync(userDataDir, { recursive: false })
app.setPath('userData', userDataDir)
const modelFixtures = createDevelopmentModelFixtures(options.workDir)
process.env.LIVE_SUBTITLE_MODEL_DIR = modelFixtures.realtimeRoot
process.env.LIVE_SUBTITLE_REFINE_MODEL_DIR = modelFixtures.refinementRoot
process.env.LIVE_SUBTITLE_VAD_MODEL = modelFixtures.vadPath
process.env.LIVE_SUBTITLE_DEV_MODEL = 'x-asr-480ms'

const crashEvents = []
app.on('child-process-gone', (_event, details) => {
  crashEvents.push({ role: details.type, reason: details.reason, exitCode: details.exitCode })
})
app.on('web-contents-created', (_event, contents) => {
  contents.on('render-process-gone', (_goneEvent, details) => {
    crashEvents.push({ role: 'renderer', reason: details.reason, exitCode: details.exitCode })
  })
})

let watchdog = null
let smokeFailed = false

app.whenReady().then(() => {
  watchdog = setTimeout(() => {
    console.error('product shell smoke watchdog expired')
    app.exit(1)
  }, 30000)
  void runJourney().catch(async (error) => {
    smokeFailed = true
    console.error(error && error.stack ? error.stack : error)
    const failure = {
      schemaVersion: 1,
      kind: 'product-shell-smoke',
      result: 'fail',
      errorCode: 'PRODUCT_SHELL_SMOKE_FAILED',
      crashEventCount: crashEvents.length
    }
    await fsp.writeFile(options.report, `${JSON.stringify(failure, null, 2)}\n`, { flag: 'wx' }).catch(() => {})
    process.exitCode = 1
    app.quit()
  })
})

async function runJourney () {
  const settings = await waitFor(() => windowFor('/settings/settings.html'), 'settings renderer')
  const toolbar = await waitFor(() => windowFor('/toolbar/index.html'), 'toolbar renderer')
  const caption = await waitFor(() => windowFor('/caption/index.html'), 'caption renderer')
  await Promise.all([settings, toolbar, caption].map((win) => waitFor(() => !win.webContents.isLoading(), 'renderer load')))

  await rendererValue(settings, `document.querySelector('[data-preset="dictation"]').click(); true`)
  await waitFor(() => rendererValue(settings, `document.getElementById('onboarding').hidden`), 'dictation onboarding')
  await waitFor(() => rendererValue(toolbar, `window.shell.getSnapshot().then(s => s.phase === 'idle' && s.capabilities.canStart)`), 'idle runtime')
  await waitFor(() => rendererValue(toolbar, `!!document.querySelector('button[data-act="start"]:not(:disabled)')`), 'start control')

  await rendererValue(toolbar, `document.querySelector('button[data-act="start"]').click(); true`)
  await waitFor(() => rendererValue(toolbar, `window.shell.getSnapshot().then(s => s.phase === 'listening' && s.sessionId !== null)`), 'listening runtime')
  await waitFor(() => rendererValue(caption, `document.getElementById('liveRegion').textContent.length > 0`), 'final caption', 15000)

  await waitFor(() => rendererValue(toolbar, `!!document.querySelector('button[data-act="stop"]:not(:disabled)')`), 'stop control')
  await rendererValue(toolbar, `document.querySelector('button[data-act="stop"]').click(); true`)
  await waitFor(() => rendererValue(toolbar, `window.shell.getSnapshot().then(s => s.phase === 'idle' && s.sessionId === null)`), 'stopped runtime')

  await rendererValue(toolbar, `document.querySelector('button[data-act="history"]').click(); true`)
  const history = await waitFor(() => windowFor('/history/index.html'), 'history renderer')
  await waitFor(() => !history.webContents.isLoading(), 'history load')
  const historyCount = await waitFor(async () => {
    const count = await rendererValue(history, `document.querySelectorAll('.session-card').length`)
    return count > 0 ? count : 0
  }, 'terminal history')

  await rendererValue(toolbar, `window.shell.action('open-model-manager'); true`)
  await waitFor(() => rendererValue(settings, `document.querySelector('.pane[data-pane="resources"]').classList.contains('active')`), 'resource navigation')
  const modelState = await rendererValue(settings, `window.shell.getModelStatus().then(s => s.state)`)
  const resourceCount = await rendererValue(settings, `document.querySelectorAll('[data-resource-id]').length`)
  const translationTogglePresent = await rendererValue(settings, `document.body.textContent.includes('显示双语译文')`)
  if (modelState !== 'ready' || resourceCount !== 3 || translationTogglePresent) throw new Error('model resources UI contract is not aligned')
  if (crashEvents.length > 0) throw new Error('Electron child process crashed during the product journey')
  if (audioFilesUnder(options.workDir).length > 0) throw new Error('product shell smoke persisted audio')

  const report = {
    schemaVersion: 1,
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
    journey: {
      onboardingPreset: 'dictation',
      startListeningStop: true,
      finalCaptionRendered: true,
      terminalHistoryCount: historyCount,
      resourcesPaneOpenedFromToolbar: true,
      modelState,
      resourceCount,
      modelReadinessSource: 'development-fixture-files',
      translationAdvertised: false
    },
    privacy: {
      physicalAudioSourceOpened: false,
      audioPersisted: false,
      transcriptTextPersistedInReport: false,
      localPathsPersistedInReport: false
    },
    limitations: [
      'fake-asr-no-physical-audio',
      'development-model-fixtures-no-real-inference',
      'not-packaged-i4'
    ]
  }
  await fsp.writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(`${JSON.stringify(report)}\n`)
  if (watchdog) clearTimeout(watchdog)
  app.quit()
}

app.on('will-quit', () => {
  if (watchdog) clearTimeout(watchdog)
  if (smokeFailed) process.exitCode = 1
})

require('../src/main')
