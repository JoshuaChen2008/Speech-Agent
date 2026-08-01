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
const { app, BrowserWindow, dialog, utilityProcess } = require('electron')
const modelManagerModule = require('../src/main/services/model-manager')
const modelRuntimeModule = require('../src/main/services/model-runtime')
const { FakeRuntimeAdapter } = require('../src/main/session/fake-runtime-adapter')
const {
  computeProductPayloadIdentity
} = require('../src/main/services/product-payload-identity')
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
const B5_RUN_ID_PATTERN = /^b5-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

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

function readyMarkersUnder (directory) {
  let count = 0
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (entry.name === '.ready.json') count += 1
    }
  }
  visit(directory)
  return count
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
      startedAt
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

function inspectExportArtifacts (directory) {
  const contents = Object.fromEntries(EXPORT_FORMATS.map((format) => [
    format,
    fs.readFileSync(path.join(directory, `history.${format}`), 'utf8')
  ]))
  const counts = {
    txt: contents.txt.trimEnd().split(/\r?\n/).length,
    md: contents.md.split(/\r?\n/).filter((line) => line.startsWith('- ')).length,
    srt: (contents.srt.match(/^\d+$/gm) || []).length
  }
  if (EXPORT_FORMATS.some((format) => counts[format] !== LONG_HISTORY_SEGMENT_COUNT)) {
    throw new Error(`history export was truncated: ${JSON.stringify(counts)}`)
  }
  return Object.freeze({ artifactCount: EXPORT_FORMATS.length, fullSegmentCount: counts.txt })
}

const options = parseArguments(process.argv.slice(app.isPackaged ? 1 : 2))
const productPayloadIdentity = app.isPackaged ? computeProductPayloadIdentity() : null
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
  modelFixtures = Object.freeze({ manifest, payloadByPath: new Map() })
}
const resumeSeed = options.mode === 'fresh'
  ? seedInterruptedModelDownload(userDataDir, modelFixtures)
  : null
const saveDialogFormats = []
dialog.showSaveDialog = async (...args) => {
  const dialogOptions = args.at(-1)
  const format = dialogOptions?.filters?.[0]?.extensions?.[0]
  if (options.mode !== 'fresh' || !EXPORT_FORMATS.includes(format) ||
      saveDialogFormats.includes(format)) {
    throw new Error('unexpected product-shell save dialog request')
  }
  saveDialogFormats.push(format)
  return { canceled: false, filePath: path.join(exportDirectory, `history.${format}`) }
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
        this.emit('refined', current.revision + 2, entry.text)
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
          if (options.mode === 'restart') {
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

  await rendererValue(toolbar, `window.shell.action('open-model-manager'); true`)
  const settings = await waitFor(() => windowFor('/settings/settings.html'), 'restart settings renderer')
  await waitFor(() => !settings.webContents.isLoading(), 'restart settings load')
  await waitFor(() => rendererValue(settings,
    `window.shell.getModelStatus().then(s => s.state === 'ready' &&
      document.getElementById('modelInstallButton').textContent === '已就绪')`),
  'offline model readiness')
  const resourceCount = await rendererValue(settings,
    `document.querySelectorAll('[data-resource-id]').length`)
  if (offlineModelFetchAttemptCount !== 0 || readyMarkersUnder(path.join(userDataDir, 'models')) !== 3 ||
      resourceCount !== 3 || modelTransport !== null) {
    throw new Error('offline restart attempted transport or lost ready model resources')
  }

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

  await rendererValue(history,
    `document.querySelector('.session-card[data-session-id="${LONG_HISTORY_SESSION_ID}"]').click(); true`)
  const firstHistoryPage = await waitForHistoryPage(history, 1, 50)
  const exportQualification = inspectExportArtifacts(exportDirectory)
  const legacyJsonlFiles = fs.readdirSync(legacyDirectory)
    .filter((name) => name.toLowerCase().endsWith('.jsonl'))
  const legacyMigrationIdempotent = legacyJsonlFiles.length === 1 &&
    sha256File(legacyFixture.filePath) === legacyFixture.sha256
  if (!legacyMigrationIdempotent) throw new Error('legacy import was not read-only across restart')

  await waitFor(() => rendererValue(toolbar,
    `!!document.querySelector('button[data-act="start"]:not(:disabled)')`),
  'restart start control')
  await rendererValue(toolbar, `document.querySelector('button[data-act="start"]').click(); true`)
  const restartSessionId = await waitFor(async () => {
    const snapshot = await rendererValue(toolbar, `window.shell.getSnapshot()`)
    return snapshot.phase === 'listening' && snapshot.sessionId !== null ? snapshot.sessionId : null
  }, 'restart listening runtime')
  await waitFor(() => rendererValue(caption,
    `document.getElementById('liveRegion').textContent.length > 0`),
  'restart final caption', 15000)
  await rendererValue(toolbar, `document.querySelector('button[data-act="stop"]').click(); true`)
  await waitFor(() => rendererValue(toolbar,
    `window.shell.getSnapshot().then(s => s.phase === 'idle' && s.sessionId === null)`),
  'restart stopped runtime')
  await rendererValue(history, `document.getElementById('refresh').click(); true`)
  await waitFor(() => rendererValue(history,
    `document.querySelectorAll('.session-card').length === 4 &&
      !!document.querySelector('.session-card[data-session-id="${restartSessionId}"]')`),
  'restart session persisted to history')

  if (crashEvents.length > 0) throw new Error('Electron child process crashed during offline restart')
  if (audioFilesUnder(options.workDir).length > 0) throw new Error('offline restart persisted audio')
  const report = {
    schemaVersion: 1,
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
      readyModelSurvivedRestart: true,
      modelFetchAttemptCount: offlineModelFetchAttemptCount,
      fixtureServerStarted: false,
      modelReadyMarkerCount: 3,
      resourceCount,
      persistedTerminalHistoryCount: persistedSessionIds.length,
      previousLiveSessionVisible,
      legacySessionVisible: true,
      legacyMigrationIdempotent,
      longHistorySegmentCount: LONG_HISTORY_SEGMENT_COUNT,
      historyPageSize: firstHistoryPage.count,
      historyExportArtifactCount: exportQualification.artifactCount,
      historyExportFullSegmentCount: exportQualification.fullSegmentCount,
      restartCaptionRendered: true,
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
  const settings = await waitFor(() => windowFor('/settings/settings.html'), 'settings renderer')
  const toolbar = await waitFor(() => windowFor('/toolbar/index.html'), 'toolbar renderer')
  const caption = await waitFor(() => windowFor('/caption/index.html'), 'caption renderer')
  await Promise.all([settings, toolbar, caption].map((win) => waitFor(() => !win.webContents.isLoading(), 'renderer load')))

  await rendererValue(settings, `document.querySelector('[data-preset="dictation"]').click(); true`)
  await waitFor(() => rendererValue(settings, `document.getElementById('onboarding').hidden`), 'dictation onboarding')
  await waitFor(() => rendererValue(toolbar,
    `window.shell.getSnapshot().then(s => s.phase === 'unavailable' && !s.capabilities.canStart)`),
  'missing-model runtime')

  await rendererValue(settings, `document.querySelector('.nav-item[data-pane="resources"]').click(); true`)
  await waitFor(() => rendererValue(settings,
    `document.querySelector('.pane[data-pane="resources"]').classList.contains('active')`),
  'resource pane before install')
  const modelInitialState = await rendererValue(settings, `(async () => {
    window.__modelUiStates = []
    window.shell.onModelStatus((status) => window.__modelUiStates.push(status.state))
    const status = await window.shell.getModelStatus()
    window.__modelUiStates.push(status.state)
    return status.state
  })()`)
  if (modelInitialState !== 'missing') throw new Error(`model UI did not begin missing: ${modelInitialState}`)
  await waitFor(() => rendererValue(settings,
    `(() => { const b = document.getElementById('modelInstallButton'); return !b.disabled && b.textContent === '下载模型' })()`),
  'enabled model download button')
  await rendererValue(settings, `document.getElementById('modelInstallButton').click(); true`)
  await waitFor(() => rendererValue(settings,
    `window.shell.getModelStatus().then(s => s.state === 'ready' &&
      document.getElementById('modelInstallButton').textContent === '已就绪' &&
      document.getElementById('modelInstallButton').disabled)`),
  'model installation through settings', 20000)
  const observedModelStates = await rendererValue(settings,
    `[...new Set(window.__modelUiStates)]`)
  for (const state of ['missing', 'downloading', 'verifying', 'ready']) {
    if (!observedModelStates.includes(state)) throw new Error(`model UI missed state: ${state}`)
  }
  const firstArtifactPath = new URL(modelFixtures.manifest.artifacts[0].url).pathname
  const rangeResumeObserved = modelTransport.requests.some((request) =>
    request.pathname === firstArtifactPath && request.range === `bytes=${resumeSeed.resumeBytes}-`)
  if (!rangeResumeObserved) throw new Error('settings model install did not resume the seeded partial download')
  if (readyMarkersUnder(path.join(userDataDir, 'models')) !== 3) {
    throw new Error('settings model install did not create three ready markers')
  }

  await waitFor(() => rendererValue(toolbar, `window.shell.getSnapshot().then(s => s.phase === 'idle' && s.capabilities.canStart)`), 'idle runtime')
  await waitFor(() => rendererValue(toolbar, `!!document.querySelector('button[data-act="start"]:not(:disabled)')`), 'start control')

  await rendererValue(toolbar, `document.querySelector('button[data-act="start"]').click(); true`)
  const liveSessionId = await waitFor(async () => {
    const snapshot = await rendererValue(toolbar, `window.shell.getSnapshot()`)
    return snapshot.phase === 'listening' && snapshot.sessionId !== null ? snapshot.sessionId : null
  }, 'listening runtime')
  await waitFor(() => rendererValue(caption, `document.getElementById('liveRegion').textContent.length > 0`), 'final caption', 15000)

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
  const historyCount = await waitFor(async () => {
    const count = await rendererValue(history, `document.querySelectorAll('.session-card').length`)
    return count === 3 ? count : 0
  }, 'terminal history')
  await waitFor(() => rendererValue(history,
    `!!document.querySelector('.session-card[data-session-id="${liveSessionId}"]')`),
  'downloaded-model session history card')
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

  for (const format of EXPORT_FORMATS) {
    await rendererValue(history,
      `document.querySelector('[data-export="${format}"]').click(); true`)
    const target = path.join(exportDirectory, `history.${format}`)
    await waitFor(() => saveDialogFormats.includes(format) &&
      fs.statSync(target, { throwIfNoEntry: false })?.size > 0,
    `history ${format} export`)
  }
  const exportQualification = inspectExportArtifacts(exportDirectory)
  const legacyJsonlFiles = fs.readdirSync(legacyDirectory)
    .filter((name) => name.toLowerCase().endsWith('.jsonl'))
  const legacySourceReadOnly = legacyJsonlFiles.length === 1 &&
    sha256File(legacyFixture.filePath) === legacyFixture.sha256
  if (!legacySourceReadOnly) throw new Error('legacy JSONL changed or SQLite runtime created a second JSONL')

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
      modelInstallClicked: true,
      modelInitialState,
      modelObservedStates: observedModelStates,
      modelRangeResumeObserved: rangeResumeObserved,
      modelReadyMarkerCount: 3,
      modelHotActivation: true,
      startListeningStop: true,
      pauseResume: true,
      finalCaptionRendered: true,
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
      historyExportDialogCount: saveDialogFormats.length,
      historyExportFormats: [...saveDialogFormats],
      historyExportArtifactCount: exportQualification.artifactCount,
      historyExportFullSegmentCount: exportQualification.fullSegmentCount,
      resourcesPaneOpenedFromToolbar: true,
      modelState,
      resourceCount,
      modelReadinessSource: 'settings-click-controlled-install',
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
      'controlled-model-fixtures-no-real-tensors',
      'deterministic-205-segment-fixture-not-two-hour-i3',
      ...(app.isPackaged
        ? ['not-clean-machine-i4', 'packaged-test-variant-not-release-installer']
        : ['not-packaged-i4'])
    ]
  }
  await fsp.writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  process.stdout.write(`${JSON.stringify(report)}\n`)
  await closeModelTransport()
  if (watchdog) clearTimeout(watchdog)
  app.quit()
}

app.on('will-quit', (event) => {
  if (watchdog) clearTimeout(watchdog)
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
