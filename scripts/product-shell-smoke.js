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
const CORE_RESOURCE_IDS = Object.freeze(['x-asr-160ms', 'silero-vad'])
const REFINEMENT_RESOURCE_IDS = Object.freeze(['x-asr-offline'])
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
      resourceCount !== 3 || modelTransport !== null) {
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
    schemaVersion: 3,
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
      resourceCount !== 3 || translationTogglePresent) throw new Error('model resources UI contract is not aligned')
  if (crashEvents.length > 0) throw new Error('Electron child process crashed during the product journey')
  if (audioFilesUnder(options.workDir).length > 0) throw new Error('product shell smoke persisted audio')

  const report = {
    schemaVersion: 3,
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
