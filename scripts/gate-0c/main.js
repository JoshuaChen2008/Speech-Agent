'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow, desktopCapturer, ipcMain, screen, session, systemPreferences } = require('electron')
const { analyzeSamples, evaluateCaptureChecks, evaluateGate0CDecision } = require('./audio-utils')

function parseArguments (argv) {
  const options = {
    workDir: '.artifacts/gate-0c',
    report: 'docs/validation/gate-0c-results.json',
    durationMs: 2600
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    if (argv[index] === '--work-dir') { options.workDir = value; index += 1 } else if (argv[index] === '--report') { options.report = value; index += 1 } else if (argv[index] === '--duration-ms') { options.durationMs = Number(value); index += 1 } else throw new Error(`Unknown argument: ${argv[index]}`)
  }
  if (!Number.isFinite(options.durationMs) || options.durationMs < 2000 || options.durationMs > 10000) throw new Error('--duration-ms must be between 2000 and 10000')
  return options
}

function withTimeout (promise, milliseconds, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds)
    })
  ]).finally(() => clearTimeout(timer))
}

function sanitizeOrigin (value) {
  return typeof value === 'string' && value.startsWith('file:') ? 'file://' : String(value || '')
}

function publicError (error) {
  return {
    name: typeof error?.name === 'string' ? error.name : 'Error',
    message: String(error?.message || error).replace(/[A-Za-z]:[\\/][^\s]+/g, '<local-path>').slice(0, 300)
  }
}

function coerceSamples (value) {
  if (value instanceof Float32Array) return new Float32Array(value)
  if (value instanceof ArrayBuffer) return new Float32Array(value.slice(0))
  if (ArrayBuffer.isView(value)) return new Float32Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
  if (Array.isArray(value)) return Float32Array.from(value)
  throw new TypeError('capture payload must contain Float32 samples')
}

async function main () {
  const options = parseArguments(process.argv.slice(2))
  const workDir = path.resolve(options.workDir)
  const reportPath = path.resolve(options.report)
  fs.mkdirSync(workDir, { recursive: true })
  const progressPath = path.join(workDir, 'progress.jsonl')
  fs.writeFileSync(progressPath, '')
  const progress = (stage, detail = null) => fs.appendFileSync(progressPath, JSON.stringify({ at: new Date().toISOString(), stage, detail }) + '\n')
  progress('process-started', { argvCount: process.argv.length })
  app.setPath('userData', path.join(workDir, 'electron-user-data'))
  app.commandLine.appendSwitch('disable-renderer-backgrounding')
  await app.whenReady()
  progress('app-ready')
  const mediaAccessBefore = {
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    screen: systemPreferences.getMediaAccessStatus('screen')
  }

  const runId = `gate-0c-${new Date().toISOString().replace(/[:.]/g, '-')}`
  const probe = { frequencyHz: 997, amplitude: 0.12, startDelayMs: 350, durationMs: 1000, fadeMs: 40 }
  const displayRequests = []
  const permissionChecks = []
  const permissionRequests = []
  const visibility = []
  const diagnostics = {}
  const partition = session.fromPartition(`gate-0c-${process.pid}`, { cache: false })
  let hostWindow = null
  let playerWindow = null
  const markVisibility = (stage, detail = null) => {
    visibility.push({ stage, visible: hostWindow ? hostWindow.isVisible() : null, detail })
  }

  const isTrustedHost = (webContents, origin) => webContents === hostWindow?.webContents && sanitizeOrigin(origin) === 'file://'
  const isTrustedPlayer = (webContents, origin) => webContents === playerWindow?.webContents && sanitizeOrigin(origin) === 'file://'
  partition.setPermissionCheckHandler((webContents, permission, origin, details) => {
    const allowed = (permission === 'media' && isTrustedHost(webContents, origin)) || (permission === 'speaker-selection' && isTrustedPlayer(webContents, origin))
    permissionChecks.push({ permission, origin: sanitizeOrigin(origin), allowed, mediaType: details?.mediaType || null })
    progress('permission-check', { permission, origin: sanitizeOrigin(origin), allowed })
    return allowed
  })
  partition.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = details?.requestingOrigin || webContents?.getURL() || ''
    const allowed = (permission === 'media' && isTrustedHost(webContents, origin)) || (permission === 'speaker-selection' && isTrustedPlayer(webContents, origin))
    permissionRequests.push({ permission, origin: sanitizeOrigin(origin), allowed, mediaTypes: Array.isArray(details?.mediaTypes) ? details.mediaTypes : [] })
    progress('permission-request', { permission, origin: sanitizeOrigin(origin), allowed })
    callback(allowed)
  })

  partition.setDisplayMediaRequestHandler(async (request, callback) => {
    const evidence = {
      securityOrigin: sanitizeOrigin(request.securityOrigin),
      videoRequested: request.videoRequested,
      audioRequested: request.audioRequested,
      userGesture: request.userGesture,
      frameMatchedHost: request.frame === hostWindow?.webContents.mainFrame,
      hostVisible: hostWindow?.isVisible() ?? null,
      callbackAudio: null,
      callbackVideoSourceType: null,
      error: null
    }
    displayRequests.push(evidence)
    progress('display-request', evidence)
    try {
      if (!evidence.frameMatchedHost || evidence.securityOrigin !== 'file://' || !request.videoRequested || !request.audioRequested) throw new Error('Unexpected display-media request')
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
      const primaryId = String(screen.getPrimaryDisplay().id)
      const selected = sources.find((source) => source.display_id === primaryId) || sources[0]
      if (!selected) throw new Error('No screen source is available')
      evidence.callbackAudio = 'loopback'
      evidence.callbackVideoSourceType = 'screen'
      evidence.availableScreenSourceCount = sources.length
      callback({ video: selected, audio: 'loopback' })
      progress('display-request-accepted', { userGesture: request.userGesture, sourceCount: sources.length })
    } catch (error) {
      evidence.error = publicError(error)
      callback({})
      progress('display-request-rejected', evidence.error)
    }
  }, { useSystemPicker: false })

  hostWindow = new BrowserWindow({
    width: 320,
    height: 200,
    show: false,
    webPreferences: {
      partition: `gate-0c-${process.pid}`,
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  playerWindow = new BrowserWindow({
    width: 240,
    height: 120,
    x: -10000,
    y: -10000,
    show: false,
    opacity: 0,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      partition: `gate-0c-${process.pid}`,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  playerWindow.webContents.setAudioMuted(false)
  for (const [name, window] of [['host', hostWindow], ['player', playerWindow]]) {
    window.webContents.on('console-message', (_event, details) => progress(`${name}-console`, { level: details?.level, message: String(details?.message || '').slice(0, 500) }))
    window.webContents.on('render-process-gone', (_event, details) => progress(`${name}-renderer-gone`, details))
  }

  ipcMain.on('gate-0c:mark', (event, payload) => {
    if (event.sender !== hostWindow.webContents) return
    markVisibility(String(payload?.stage || 'unknown'), payload?.detail || null)
  })
  ipcMain.handle('gate-0c:play-probe', async (event, requested) => {
    if (event.sender !== hostWindow.webContents) throw new Error('untrusted probe request')
    const sourceId = String(requested?.sourceId || '')
    const outputMode = sourceId === 'mic-probe' ? 'virtual-cable' : (sourceId === 'mic' ? 'physical-speaker' : (sourceId === 'loopback' ? 'default' : null))
    const fixed = { ...probe, sourceId, outputMode }
    if (!outputMode || JSON.stringify(requested) !== JSON.stringify(fixed)) throw new Error('probe parameters do not match the fixed challenge')
    progress('probe-playback-requested')
    const playbackPromise = playerWindow.webContents.executeJavaScript(`globalThis.playGate0CProbe(${JSON.stringify(fixed)})`, true)
    await new Promise((resolve) => setTimeout(resolve, fixed.startDelayMs + 250))
    const mainObservedAudible = playerWindow.webContents.isCurrentlyAudible()
    progress('probe-playback-audibility', { mainObservedAudible, playerVisible: playerWindow.isVisible() })
    const result = await withTimeout(playbackPromise, 5000, 'probe playback')
    result.mainObservedAudible = mainObservedAudible
    progress('probe-playback-complete', result)
    return result
  })
  ipcMain.handle('gate-0c:analyze-capture', async (event, payload) => {
    if (event.sender !== hostWindow.webContents) throw new Error('untrusted capture payload')
    const sourceId = String(payload?.sourceId || '')
    if (!['loopback', 'mic', 'mic-probe'].includes(sourceId) || diagnostics[sourceId]) throw new Error('invalid or duplicate sourceId')
    const inputSamples = coerceSamples(payload.samples)
    let inputPreClampOverRangeCount = 0
    let inputNonFiniteCount = 0
    for (const value of inputSamples) {
      if (!Number.isFinite(value)) inputNonFiniteCount += 1
      else if (Math.abs(value) > 1) inputPreClampOverRangeCount += 1
    }
    if (inputNonFiniteCount > 0) throw new Error(`${sourceId} contains non-finite PCM`)
    const analysis = analyzeSamples(inputSamples, 16000, Number(payload.expectedFrequencyHz), 1600, payload.probeWindow)
    const buffer = { channels: 1, sampleRate: 16000, sampleCount: inputSamples.length }
    const checks = evaluateCaptureChecks(sourceId, analysis, payload.pipeline, inputPreClampOverRangeCount)
    checks.bufferPass = payload.pipeline?.outputSampleRate === 16000 && payload.pipeline?.sampleCount === inputSamples.length
    checks.pass = checks.pass && checks.bufferPass
    const diagnostic = {
      buffer,
      inputPreClampOverRangeCount,
      pipeline: payload.pipeline,
      analysis,
      checks
    }
    diagnostics[sourceId] = diagnostic
    progress('capture-analyzed', { sourceId, checks })
    return diagnostic
  })

  await withTimeout(hostWindow.loadFile(path.join(__dirname, 'host.html')), 5000, 'host page load')
  progress('host-window-loaded')
  await withTimeout(playerWindow.loadFile(path.join(__dirname, 'player.html')), 5000, 'player page load')
  playerWindow.showInactive()
  progress('player-window-loaded')
  progress('windows-loaded')
  markVisibility('ready')

  const invocation = { durationMs: options.durationMs, probe }
  markVisibility('before-user-gesture-trigger')
  progress('user-gesture-capture-started')
  const capture = await withTimeout(hostWindow.webContents.executeJavaScript(`globalThis.runGate0C(${JSON.stringify(invocation)})`, true), 30000, 'user-gesture capture')
  progress('user-gesture-capture-complete', { loopback: capture.loopback?.status, mic: capture.mic?.status, micProbe: capture.micProbe?.status })
  await new Promise((resolve) => setTimeout(resolve, 1000))
  progress('no-gesture-probe-started')
  const noGestureProbe = await withTimeout(hostWindow.webContents.executeJavaScript('globalThis.probeDisplayMediaWithoutGesture()', false), 10000, 'no-gesture display probe')
  progress('no-gesture-probe-complete', noGestureProbe)
  markVisibility('after-no-gesture-probe')
  markVisibility('complete')

  const evaluated = evaluateGate0CDecision({ capture, diagnostics, displayRequests, visibility })
  const { result, hiddenSchemePass, loopbackPass, physicalMicrophonePass, deterministicMicrophoneProbePass, microphonePass } = evaluated
  const report = {
    schemaVersion: 2,
    gate: '0C',
    runId,
    executedAt: new Date().toISOString(),
    result,
    environment: {
      platform: process.platform,
      osRelease: os.release(),
      osVersion: os.version(),
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      node: process.versions.node
    },
    testSignal: { id: 'independent-player-sine-v1', ...probe },
    window: {
      showConfigured: false,
      backgroundThrottling: false,
      visibility
    },
    permissions: {
      microphoneBefore: mediaAccessBefore.microphone,
      screenBefore: mediaAccessBefore.screen,
      checks: permissionChecks,
      requests: permissionRequests
    },
    hiddenGestureControl: noGestureProbe,
    displayRequests,
    capture,
    diagnostics,
    decision: {
      hiddenThroughout: evaluated.hiddenThroughout,
      requiredVisibilityStagesPresent: evaluated.requiredVisibilityStagesPresent,
      displayRequestPass: evaluated.displayRequestPass,
      hiddenSchemePass,
      loopbackPass,
      physicalMicrophonePass,
      deterministicMicrophoneProbePass,
      microphonePass,
      diagnosticsComplete: evaluated.diagnosticsComplete,
      selectedTopology: hiddenSchemePass ? 'hidden-audio-host' : 'not-approved',
      captureInitiator: hiddenSchemePass ? 'main-execute-javascript-user-gesture' : null,
      toolbarFallbackTested: false,
      note: hiddenSchemePass
        ? 'The display handler observed a real userGesture on the hidden host and each in-memory source probe passed signal, clipping, and continuity checks.'
        : 'Do not claim toolbar fallback: no trusted-click fallback was exercised in this run.'
    },
    privacy: {
      rawAudioPersisted: false,
      absolutePathsCommitted: false,
      deviceLabelsCommitted: false,
      note: 'Captured samples are analyzed in memory and released; only structured settings, counters, and signal metrics are reported.'
    }
  }
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  progress('report-written', { result })
  process.stdout.write(JSON.stringify({ result, hiddenSchemePass, loopbackPass, microphonePass, report: path.basename(reportPath) }) + '\n')
  hostWindow.destroy()
  playerWindow.destroy()
  app.quit()
}

main().catch((error) => {
  try {
    const workIndex = process.argv.indexOf('--work-dir')
    const directory = path.resolve(workIndex >= 0 ? process.argv[workIndex + 1] : '.artifacts/gate-0c')
    fs.mkdirSync(directory, { recursive: true })
    fs.appendFileSync(path.join(directory, 'progress.jsonl'), JSON.stringify({ at: new Date().toISOString(), stage: 'fatal', detail: publicError(error) }) + '\n')
  } catch {}
  console.error(error?.stack || error)
  app.exit(1)
})
