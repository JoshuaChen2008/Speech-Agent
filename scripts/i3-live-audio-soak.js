'use strict'

// @ts-check

/*
 * I3 real two-hour audio soak.
 *
 * This runner is intentionally separate from i3-nonaudio-soak.js.  The
 * acceptance path starts Electron, a visible BrowserWindow, the real audio
 * host/realtime utility/refinement utility (when available), and the product
 * SubtitleApplicationRuntime backed by the real SQLite utility process.
 * Captured PCM is never written by this runner; only transient, controlled
 * corpus PCM is supplied to WebAudio in memory.
 *
 * The short synthetic-fixture mode is deliberately a partial planning
 * artifact.  The full verifier rejects it and it cannot stand in for a real
 * two-hour acceptance run.
 */

const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

const { app, BrowserWindow, session } = require('electron')
const { SessionCoordinator } = require('../src/main/session/session-coordinator')
const { SubtitleApplicationRuntime } = require('../src/main/services/subtitle-application-runtime')
const { HistoryService } = require('../src/main/services/history-service')
const { StorageGateway } = require('../src/main/services/storage-gateway')
const { RealtimeRuntimeAdapter } = require('../src/runtime/realtime-runtime-adapter')
const { resolveApprovedRealtimeModel, resolveApprovedRefinementModel, resolveSileroVadModel } = require('../src/main/services/model-resolver')
const { PRODUCTION_MODEL_MANIFEST } = require('../src/main/services/model-manifest')
const { validateGate0CMetricsReport } = require('./gate-0c/verify-report')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')
const { computeProductPayloadIdentity } = require('../src/main/services/product-payload-identity')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const DEFAULT_MODEL_USER_DATA = path.join(PROJECT_ROOT, '.artifacts', 'model-install-live-20260731-3', 'user-data')
const STIMULUS_DEFINITION = require('./i3-live-stimulus.json')
const DEFAULT_DURATION_SECONDS = 2 * 60 * 60
const QUALIFICATION_DURATION_SECONDS = 75
const MIN_ACCEPTANCE_WALL_DURATION_MS = DEFAULT_DURATION_SECONDS * 1000
const MIN_FINAL_SEGMENTS = 3000
const MIN_QUALIFICATION_FINAL_SEGMENTS = 25
const MIN_QUALIFICATION_PRE_RECOVERY_FINAL_SEGMENTS = 12
const MIN_QUALIFICATION_POST_RECOVERY_FINAL_SEGMENTS = 8
const QUALIFICATION_CRASH_TARGET_MS = 30 * 1000
const HISTORY_PAGE_SIZE = 50
/* I3 measures durability, not cross-clock first-partial latency.  A short
   future start keeps WebAudio scheduling deterministic without consuming the
   segment-capacity margin required by the 3,000-final two-hour gate. */
const PLAYBACK_SCHEDULE_LEAD_MS = 80
const RESOURCE_SAMPLE_INTERVAL_MS = 1000
const PROGRESS_INTERVAL_MS = 5000
const WINDOW_HEARTBEAT_INTERVAL_MS = 5000
const MIN_WINDOW_HEARTBEATS = Math.floor(MIN_ACCEPTANCE_WALL_DURATION_MS / WINDOW_HEARTBEAT_INTERVAL_MS)
const MIN_QUALIFICATION_RESOURCE_SAMPLES = 30
const SOAK_LIMITS = Object.freeze({
  maxAppCpuP95Percent: 800,
  maxAppWorkingSetMiB: 2048,
  maxGatewayQueueDepth: 512,
  maxHistoryPageP95Ms: 1000,
  maxProcessCount: 20,
  maxStimulusCycleDurationMs: STIMULUS_DEFINITION.maximumCycleDurationMs,
  minFinalSegments: MIN_FINAL_SEGMENTS,
  minResourceSamples: 3600,
  minWallDurationMs: MIN_ACCEPTANCE_WALL_DURATION_MS,
  pageSize: HISTORY_PAGE_SIZE
})
const PROVENANCE_FILES = Object.freeze({
  historyServiceSha256: 'src/main/services/history-service.js',
  i2PlaybackPageSha256: 'scripts/i2-live-caption-player.html',
  i2PlaybackScriptSha256: 'scripts/i2-live-caption-player.js',
  modelManifestSha256: 'src/main/services/model-manifest.js',
  modelResolverSha256: 'src/main/services/model-resolver.js',
  realtimeRuntimeAdapterSha256: 'src/runtime/realtime-runtime-adapter.js',
  runnerSha256: 'scripts/i3-live-audio-soak.js',
  sqliteRuntimeSha256: 'src/main/services/subtitle-application-runtime.js',
  statusWindowSha256: 'scripts/i3-live-soak-window.html',
  stimulusDefinitionSha256: 'scripts/i3-live-stimulus.json',
  stimulusGeneratorSha256: 'scripts/generate-i3-live-stimulus.ps1',
  verifierSha256: 'scripts/verify-i3-live-audio-report.js'
})

function sha256 (value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function currentProvenance () {
  return {
    ...Object.fromEntries(Object.entries(PROVENANCE_FILES).map(([name, relativePath]) => [
      name,
      sha256(fs.readFileSync(path.join(PROJECT_ROOT, relativePath)))
    ])),
    productPayloadSha256: computeProductPayloadIdentity(path.join(PROJECT_ROOT, 'src')).sha256
  }
}

function delay (milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function rounded (value, decimals = 3) {
  const multiplier = 10 ** decimals
  return Math.round(value * multiplier) / multiplier
}

function percentile (values, quantile) {
  if (!Array.isArray(values) || values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1))]
}

function canonicalTimestamp () {
  return new Date().toISOString()
}

function safeRunId () {
  return crypto.randomBytes(12).toString('hex')
}

function nonEmptyString (value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be a non-empty string`)
  return value
}

function positiveInteger (value, label, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new RangeError(`${label} must be an integer >= ${minimum}`)
  return value
}

function assertSafeReport (report) {
  const rendered = JSON.stringify(report)
  if (/[A-Za-z]:[\\/]|(?:^|[^:])\/Users\/|(?:^|[^:])\/home\//.test(rendered)) {
    throw new Error('I3 live report must not contain an absolute path')
  }
  if (/我们下周|onboarding drop-off|二零二六年|fixture subtitle/i.test(rendered)) {
    throw new Error('I3 live report must not contain transcript text')
  }
  return report
}

function parseArguments (argv) {
  const options = {
    artifactDirectory: null,
    keepArtifacts: false,
    modelUserData: null,
    mode: 'acceptance',
    physicalMicPreflight: null,
    progress: null,
    report: null,
    source: null,
    syntheticSegments: 12,
    durationSeconds: null
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = argv[index + 1]
    if (argument === '--report') { options.report = next; index += 1 } else if (argument === '--progress') {
      options.progress = next; index += 1
    } else if (argument === '--source') {
      options.source = next; index += 1
    } else if (argument === '--physical-mic-preflight') {
      options.physicalMicPreflight = next; index += 1
    } else if (argument === '--artifact-directory') {
      options.artifactDirectory = next; index += 1
    } else if (argument === '--model-user-data') {
      options.modelUserData = next; index += 1
    } else if (argument === '--mode') {
      options.mode = next; index += 1
    } else if (argument === '--synthetic-segments') {
      options.syntheticSegments = Number(next); index += 1
    } else if (argument === '--duration-seconds') {
      options.durationSeconds = Number(next)
      index += 1
    } else if (argument === '--keep-artifacts') {
      options.keepArtifacts = true
    } else {
      throw new Error(`unknown argument: ${argument}`)
    }
  }
  nonEmptyString(options.report, '--report')
  if (!['acceptance', 'qualification', 'synthetic-fixture'].includes(options.mode)) {
    throw new Error('--mode must be acceptance, qualification, or synthetic-fixture')
  }
  if (['acceptance', 'qualification'].includes(options.mode)) {
    const expectedDurationSeconds = options.mode === 'acceptance'
      ? DEFAULT_DURATION_SECONDS
      : QUALIFICATION_DURATION_SECONDS
    if (options.durationSeconds !== null && options.durationSeconds !== expectedDurationSeconds) {
      throw new Error(`--duration-seconds is frozen at ${expectedDurationSeconds} for I3 ${options.mode}`)
    }
    options.durationSeconds = expectedDurationSeconds
    if (options.modelUserData !== null) nonEmptyString(options.modelUserData, '--model-user-data')
    if (!['loopback', 'mic'].includes(options.source)) throw new Error('--source must be loopback or mic for a real I3 run')
    if (options.source === 'loopback' && options.physicalMicPreflight !== null) {
      throw new Error('--physical-mic-preflight is only valid for --source mic')
    }
    if (options.source === 'mic' && typeof options.physicalMicPreflight !== 'string') {
      throw new Error('--physical-mic-preflight is required for microphone acoustic soak')
    }
  } else {
    if (options.durationSeconds !== null) throw new Error('--duration-seconds is not valid for synthetic-fixture mode')
    if (options.source !== null || options.physicalMicPreflight !== null || options.modelUserData !== null) {
      throw new Error('synthetic-fixture mode never selects or accesses an audio source')
    }
    positiveInteger(options.syntheticSegments, '--synthetic-segments')
  }
  return options
}

function buildI3CoordinatorSessionOptions ({ source, model, refinementModel }) {
  if (!['loopback', 'mic'].includes(source)) throw new Error('I3 coordinator source must be loopback or mic')
  if (!model || typeof model.id !== 'string' || typeof model.profile !== 'string') {
    throw new Error('I3 coordinator requires an approved realtime model')
  }
  const refinementAvailable = Boolean(refinementModel)
  return {
    configuration: source === 'loopback'
      ? {
          onboardingCompleted: true,
          onboardingPreset: 'meeting',
          loopback: true,
          mic: false,
          refinementEnabled: refinementAvailable
        }
      : {
          onboardingCompleted: true,
          onboardingPreset: 'dictation',
          loopback: false,
          mic: true,
          refinementEnabled: refinementAvailable
        },
    runtimeOptions: {
      modelOverride: { developmentOnly: false, id: model.id, profile: model.profile },
      refinementAvailable
    }
  }
}

function resolveWorkspacePath (value, label) {
  const candidate = path.resolve(value)
  const rootPrefix = `${PROJECT_ROOT}${path.sep}`
  if (candidate !== PROJECT_ROOT && !candidate.startsWith(rootPrefix)) {
    throw new Error(`${label} must stay inside the project workspace`)
  }
  return candidate
}

function markerEvidence (directory, expectedId) {
  const markerPath = path.join(directory, '.ready.json')
  const markerBytes = fs.readFileSync(markerPath)
  const marker = parseStrictEvidenceJson(markerBytes, `model marker ${expectedId}`)
  const artifact = PRODUCTION_MODEL_MANIFEST.artifacts.find((item) => item.id === expectedId)
  if (!artifact || !marker || marker.artifactId !== expectedId || marker.manifestVersion !== PRODUCTION_MODEL_MANIFEST.version ||
      marker.sha256 !== artifact.sha256 || marker.bytes !== artifact.bytes) {
    throw new Error(`model marker is not approved: ${expectedId}`)
  }
  return { artifactId: expectedId, markerSha256: sha256(markerBytes), manifestSha256: artifact.sha256 }
}

function resolveAuditedModels (optionValue) {
  const userDataDir = resolveWorkspacePath(optionValue || DEFAULT_MODEL_USER_DATA, '--model-user-data')
  const resolverOptions = { allowExternal: false, repoRoot: PROJECT_ROOT, userDataDir }
  const model = resolveApprovedRealtimeModel(resolverOptions)
  const refinement = resolveApprovedRefinementModel(resolverOptions)
  const vad = resolveSileroVadModel(resolverOptions)
  if (!model) throw new Error('APPROVED_REALTIME_MODEL_MISSING')
  if (!refinement) throw new Error('APPROVED_REFINEMENT_MODEL_MISSING')
  if (!vad) throw new Error('APPROVED_VAD_MODEL_MISSING')
  return {
    model,
    refinement,
    vad,
    evidence: {
      realtime: markerEvidence(model.modelDir, model.id),
      refinement: markerEvidence(refinement.modelDir, refinement.id),
      vad: markerEvidence(path.dirname(vad.modelPath), 'silero-vad')
    }
  }
}

function internalSeedArguments (argv) {
  /* Normal acceptance/qualification arguments belong to parseArguments().
     Only enter this closed parser when the dedicated child-process marker is
     present; otherwise every legitimate public option would be rejected as
     an unknown internal argument before a report could be written. */
  if (!argv.includes('--internal-recovery-seed')) return null
  const values = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = argv[index + 1]
    if (argument === '--internal-recovery-seed') values.internal = true
    else if (argument === '--database-path') { values.databasePath = next; index += 1 } else if (argument === '--seed-path') {
      values.seedPath = next; index += 1
    } else if (argument === '--session-id') { values.sessionId = next; index += 1 } else {
      throw new Error(`unknown internal argument: ${argument}`)
    }
  }
  for (const key of ['databasePath', 'seedPath', 'sessionId']) nonEmptyString(values[key], key)
  return values
}

function readPcm16MonoWav (filePath) {
  const buffer = fs.readFileSync(filePath)
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('controlled I3 stimulus is not a RIFF/WAVE file')
  }
  let offset = 12
  let format = null
  let data = null
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    if (chunkId === 'fmt ') {
      format = {
        audioFormat: buffer.readUInt16LE(offset + 8),
        channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        bitsPerSample: buffer.readUInt16LE(offset + 22)
      }
    } else if (chunkId === 'data') {
      data = buffer.subarray(offset + 8, offset + 8 + chunkSize)
    }
    offset += 8 + chunkSize + (chunkSize % 2)
  }
  if (!format || !data || format.audioFormat !== 1 || format.channels !== 1 || format.bitsPerSample !== 16) {
    throw new Error('controlled I3 stimulus must be PCM16 mono')
  }
  return {
    corpusSha256: sha256(buffer),
    durationSeconds: (data.length / 2) / format.sampleRate,
    pcm16Base64: Buffer.from(data).toString('base64'),
    sampleRate: format.sampleRate
  }
}

function readI3ShortStimulus () {
  const definition = STIMULUS_DEFINITION
  const required = [
    'schemaVersion', 'id', 'sourceCorpus', 'referenceSha256', 'sampleRate', 'bitsPerSample', 'channels',
    'sliceStartMs', 'sliceLengthMs', 'sliceLeadingSilenceMs', 'silenceDurationMs', 'maximumCycleDurationMs',
    'expectedDerivedWavSha256'
  ]
  if (Object.keys(definition).length !== required.length || required.some((key) => !Object.hasOwn(definition, key)) ||
      definition.schemaVersion !== 1 || !/^[a-z0-9-]+$/.test(definition.id) ||
      !definition.sourceCorpus || Object.keys(definition.sourceCorpus).length !== 4 ||
      ['id', 'file', 'sha256', 'referenceSha256'].some((key) => !Object.hasOwn(definition.sourceCorpus, key)) ||
      definition.sourceCorpus.id !== 'gate-0b-zh-roadmap' || definition.sourceCorpus.file !== 'zh-roadmap.wav' ||
      !/^[a-f0-9]{64}$/.test(definition.sourceCorpus.sha256 || '') ||
      !/^[a-f0-9]{64}$/.test(definition.sourceCorpus.referenceSha256 || '') ||
      !/^[a-f0-9]{64}$/.test(definition.referenceSha256 || '') || definition.sampleRate !== 16000 ||
      definition.bitsPerSample !== 16 || definition.channels !== 1 || definition.sliceStartMs !== 0 ||
      definition.sliceLengthMs !== 1000 || definition.sliceLeadingSilenceMs !== 140 || definition.silenceDurationMs !== 1100 ||
      definition.maximumCycleDurationMs !== 2200 || !/^[a-f0-9]{64}$/.test(definition.expectedDerivedWavSha256 || '')) {
    throw new Error('I3 tracked short-stimulus definition is invalid')
  }
  const directory = path.join(PROJECT_ROOT, 'models', 'i3-live-audio-stimulus')
  const metadataPath = path.join(directory, 'metadata.json')
  const wavPath = path.join(directory, `${definition.id}.wav`)
  if (!fs.existsSync(metadataPath) || !fs.existsSync(wavPath)) {
    throw new Error('I3 short stimulus is missing; run scripts/generate-i3-live-stimulus.ps1 before acceptance')
  }
  const metadata = parseStrictEvidenceJson(fs.readFileSync(metadataPath), 'I3 short stimulus metadata')
  const metadataKeys = [
    'schemaVersion', 'id', 'file', 'sourceCorpusSha256', 'sourceReferenceSha256', 'referenceSha256', 'sliceStartMs',
    'sliceLengthMs', 'sliceLeadingSilenceMs', 'sliceSampleCount', 'derivedWavSha256', 'silenceDurationMs', 'cycleDurationMs'
  ]
  const expectedSliceSampleCount = (definition.sliceLengthMs * definition.sampleRate) / 1000
  if (Object.keys(metadata).length !== metadataKeys.length || metadataKeys.some((key) => !Object.hasOwn(metadata, key)) ||
      metadata.schemaVersion !== 1 || metadata.id !== definition.id || metadata.file !== `${definition.id}.wav` ||
      metadata.sourceCorpusSha256 !== definition.sourceCorpus.sha256 ||
      metadata.sourceReferenceSha256 !== definition.sourceCorpus.referenceSha256 || metadata.referenceSha256 !== definition.referenceSha256 ||
      metadata.sliceStartMs !== definition.sliceStartMs || metadata.sliceLengthMs !== definition.sliceLengthMs ||
      metadata.sliceLeadingSilenceMs !== definition.sliceLeadingSilenceMs || metadata.sliceSampleCount !== expectedSliceSampleCount ||
      metadata.derivedWavSha256 !== definition.expectedDerivedWavSha256 || metadata.silenceDurationMs !== definition.silenceDurationMs ||
      !Number.isInteger(metadata.cycleDurationMs) || metadata.cycleDurationMs !== definition.sliceLengthMs + definition.silenceDurationMs ||
      metadata.cycleDurationMs > definition.maximumCycleDurationMs) {
    throw new Error('I3 short stimulus metadata does not match the tracked definition')
  }
  const wave = readPcm16MonoWav(wavPath)
  const actualDurationMs = Math.round(wave.durationSeconds * 1000)
  if (wave.sampleRate !== definition.sampleRate || wave.corpusSha256 !== metadata.derivedWavSha256 || actualDurationMs !== metadata.cycleDurationMs ||
      actualDurationMs > definition.maximumCycleDurationMs || actualDurationMs !== definition.silenceDurationMs + definition.sliceLengthMs ||
      Math.floor(MIN_ACCEPTANCE_WALL_DURATION_MS / actualDurationMs) < MIN_FINAL_SEGMENTS + 100) {
    throw new Error('I3 short stimulus WAV does not match its generated metadata')
  }
  return {
    ...wave,
    cycleDurationMs: actualDurationMs,
    derivedWavSha256: wave.corpusSha256,
    id: definition.id,
    referenceSha256: definition.referenceSha256,
    silenceDurationMs: definition.silenceDurationMs,
    sliceLeadingSilenceMs: definition.sliceLeadingSilenceMs,
    sliceLengthMs: definition.sliceLengthMs,
    sliceSampleCount: expectedSliceSampleCount,
    sourceCorpusSha256: definition.sourceCorpus.sha256,
    sourceReferenceSha256: definition.sourceCorpus.referenceSha256
  }
}

function readPhysicalMicPreflight (filePath) {
  const bytes = fs.readFileSync(path.resolve(filePath))
  const report = parseStrictEvidenceJson(bytes, 'Gate 0C microphone preflight')
  validateGate0CMetricsReport(report)
  const track = report?.capture?.mic?.stream?.track
  const output = report?.capture?.mic?.capture?.playback?.output
  if (report?.result !== 'pass' || report?.decision?.physicalMicrophonePass !== true ||
      report?.capture?.mic?.selection !== 'physical-preferred' ||
      !/^[a-f0-9]{64}$/.test(track?.labelSha256 || '') ||
      !/^[a-f0-9]{64}$/.test(output?.labelSha256 || '') || report?.privacy?.rawAudioPersisted !== false) {
    throw new Error('a passing physical-preferred Gate 0C preflight is required for microphone I3')
  }
  return {
    micLabelSha256: track.labelSha256,
    reportSha256: sha256(bytes),
    speakerLabelSha256: output.labelSha256
  }
}

function audioFilesUnder (directory) {
  const found = []
  const visit = (current) => {
    if (!fs.existsSync(current)) return
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (/\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)$/i.test(entry.name)) found.push(target)
    }
  }
  visit(directory)
  return found
}

function startResourceSampler (gateway) {
  const samples = []
  const take = () => {
    try {
      const appMetrics = app.getAppMetrics()
      const totalCpuPercent = appMetrics.reduce((sum, item) => sum + (Number(item.cpu?.percentCPUUsage) || 0), 0)
      const workingSetKiB = appMetrics.reduce((sum, item) => sum + (Number(item.memory?.workingSetSize) || 0), 0)
      samples.push({
        cpuPercent: rounded(totalCpuPercent),
        gatewayQueueDepth: Number.isInteger(gateway?.queue?.length) ? gateway.queue.length : null,
        processCount: appMetrics.length,
        workingSetMiB: rounded(workingSetKiB / 1024)
      })
    } catch { /* Sampling is observational; the resulting count is validated. */ }
  }
  take()
  const timer = setInterval(take, RESOURCE_SAMPLE_INTERVAL_MS)
  return {
    stop () {
      clearInterval(timer)
      take()
      const cpu = samples.map((item) => item.cpuPercent)
      const memory = samples.map((item) => item.workingSetMiB)
      const queue = samples.map((item) => item.gatewayQueueDepth).filter(Number.isFinite)
      const processCount = samples.map((item) => item.processCount)
      return {
        appCpuP95Percent: percentile(cpu, 0.95),
        appWorkingSetMiBMax: memory.length ? Math.max(...memory) : null,
        maxGatewayQueueDepth: queue.length ? Math.max(...queue) : null,
        maxProcessCount: processCount.length ? Math.max(...processCount) : null,
        sampleCount: samples.length
      }
    }
  }
}

function createProgressWriter (progressPath, soakId) {
  const write = (state) => {
    const safe = {
      elapsedWallMs: Math.max(0, Math.round(state.elapsedWallMs || 0)),
      mode: state.mode,
      phase: state.phase,
      soakId,
      statusWindow: {
        dragObserved: state.dragObserved === true,
        visible: state.visible === true
      },
      workerCrash: state.workerCrash
    }
    fs.mkdirSync(path.dirname(progressPath), { recursive: true })
    fs.writeFileSync(progressPath, `${JSON.stringify(safe, null, 2)}\n`, 'utf8')
  }
  return { write }
}

async function createVisibleStatusWindow () {
  const window = new BrowserWindow({
    width: 410,
    height: 168,
    frame: false,
    resizable: false,
    show: false,
    alwaysOnTop: true,
    title: 'I3 Audio Soak — drag once',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  let rendered = false
  let heartbeatCount = 0
  let dragObserved = false
  let origin = null
  await window.loadFile(path.join(__dirname, 'i3-live-soak-window.html'))
  window.show()
  origin = window.getBounds()
  rendered = true
  window.on('move', () => {
    const current = window.getBounds()
    if (origin && Math.hypot(current.x - origin.x, current.y - origin.y) >= 16) dragObserved = true
  })
  return {
    get dragObserved () { return dragObserved },
    get heartbeatCount () { return heartbeatCount },
    get rendered () { return rendered },
    get visible () { return !window.isDestroyed() && window.isVisible() },
    async heartbeat (phase, elapsedSeconds) {
      if (window.isDestroyed()) return
      const result = await window.webContents.executeJavaScript(
        `globalThis.updateI3SoakWindow(${JSON.stringify(phase)}, ${Number(elapsedSeconds)})`, true)
      heartbeatCount = Math.max(heartbeatCount, Number(result?.heartbeat) || 0)
    },
    destroy () { if (!window.isDestroyed()) window.destroy() }
  }
}

async function createPlaybackController (wave, sourceId, preflight) {
  const partition = `i3-live-playback-${process.pid}-${Date.now()}`
  const playbackSession = session.fromPartition(partition, { cache: false })
  const window = new BrowserWindow({
    width: 240,
    height: 120,
    x: -10000,
    y: -10000,
    show: false,
    opacity: 0,
    focusable: false,
    skipTaskbar: true,
    webPreferences: { partition, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  })
  const trustedContentsId = window.webContents.id
  playbackSession.setPermissionCheckHandler((webContents, permission) =>
    webContents?.id === trustedContentsId && permission === 'speaker-selection')
  playbackSession.setPermissionRequestHandler((webContents, permission, callback) =>
    callback(webContents?.id === trustedContentsId && permission === 'speaker-selection'))
  await window.loadFile(path.join(__dirname, 'i2-live-caption-player.html'))
  window.showInactive()
  window.webContents.setAudioMuted(false)
  const invocation = {
    expectedOutputLabelSha256: sourceId === 'mic' ? preflight.speakerLabelSha256 : null,
    outputMode: sourceId === 'mic' ? 'physical-speaker' : 'default',
    pcm16Base64: wave.pcm16Base64,
    sampleRate: wave.sampleRate
  }
  return {
    async play () {
      const prepared = await window.webContents.executeJavaScript(
        `globalThis.preparePcm16(${JSON.stringify(invocation)})`, true)
      if (prepared?.prepared !== true) throw new Error('I3 controlled playback was not prepared')
      const probe = await window.webContents.executeJavaScript('globalThis.readPlaybackClockProbe()', true)
      const started = await window.webContents.executeJavaScript(
        `globalThis.startPreparedPcm16({"notBeforeClockMs":${Number(probe?.remoteSentClockMs) + PLAYBACK_SCHEDULE_LEAD_MS}})`, true)
      if (started?.started !== true) throw new Error('I3 controlled playback did not start')
      return window.webContents.executeJavaScript('globalThis.finishPreparedPcm16()', true)
    },
    destroy () { if (!window.isDestroyed()) window.destroy() }
  }
}

function transportProjection (diagnostics, sourceId) {
  const capture = diagnostics?.capture?.[sourceId] || {}
  const source = diagnostics?.worker?.sources?.[sourceId] || {}
  const worker = diagnostics?.worker || {}
  return {
    acknowledgedFrames: capture.acknowledgedFrames ?? null,
    badSampleTypeFrames: worker.badSampleTypeFrames ?? null,
    capturedFrames: capture.capturedFrames ?? null,
    creditStalls: capture.creditStalls ?? null,
    droppedCaptionCount: diagnostics?.droppedCaptionCount ?? null,
    droppedFrames: capture.droppedFrames ?? null,
    ingestedFrames: source.framesIngested ?? null,
    lostInFlightFrames: capture.lostInFlightFrames ?? null,
    missedFrames: source.missedFrames ?? null,
    portReplacements: capture.portReplacements ?? null,
    sentFrames: capture.sentFrames ?? null,
    sequenceGapCount: source.sequenceGapCount ?? null
  }
}

function sumTransport (generations) {
  const keys = Object.keys(transportProjection(null, 'loopback'))
  return Object.fromEntries(keys.map((key) => {
    const values = generations.map((entry) => entry[key]).filter(Number.isFinite)
    return [key, values.length === generations.length ? values.reduce((sum, value) => sum + value, 0) : null]
  }))
}

async function waitFor (probe, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (probe()) return
    await delay(50)
  }
  throw new Error(`timed out waiting for ${label}`)
}

async function forceRealtimeWorkerCrashAndRetry ({ coordinator, onRecovered, runtimeAdapter, onProgress, elapsedWallMs }) {
  const worker = runtimeAdapter?.session?.worker
  if (!worker || typeof worker.terminateAndWait !== 'function') throw new Error('realtime worker fault hook is unavailable')
  onProgress('forcing-realtime-worker-exit', elapsedWallMs, 'requested')
  await worker.terminateAndWait()
  await waitFor(() => coordinator.getSnapshot().phase === 'error', 'worker fault propagation')
  const snapshot = coordinator.getSnapshot()
  if (snapshot.lastError?.code !== 'REALTIME_WORKER_EXITED' || snapshot.lastError?.scope !== 'worker') {
    throw new Error('forced realtime worker exit did not surface the expected recoverable error')
  }
  onProgress('retrying-after-realtime-worker-exit', elapsedWallMs, 'observed')
  const retried = await coordinator.command('retry')
  if (!retried.ok) throw new Error('coordinator retry after forced realtime worker exit failed')
  await waitFor(() => coordinator.getSnapshot().phase === 'listening', 'realtime worker retry')
  /* Switch the caption accounting generation before yielding back to the
     playback loop. This avoids racing the first final IPC event after retry
     against assignment of the returned workerCrash object. */
  onRecovered()
  onProgress('listening-after-realtime-worker-exit', elapsedWallMs, 'recovered')
  return { errorObserved: true, retrySucceeded: true, workerExitForced: true }
}

async function inspectHistoryAndExports ({ gateway, sessionId, artifactDirectory }) {
  const history = new HistoryService({
    gateway,
    showSaveDialog: async (_owner, options) => {
      const extension = options.filters[0].extensions[0]
      return { canceled: false, filePath: path.join(artifactDirectory, `i3-export.${extension}`) }
    }
  })
  const querySamples = []
  const segmentIds = new Set()
  let cursor = null
  let pageCount = 0
  while (true) {
    const began = performance.now()
    const page = await history.getSessionPage({ sessionId, limit: HISTORY_PAGE_SIZE, cursor })
    querySamples.push(performance.now() - began)
    pageCount += 1
    for (const item of page.items) segmentIds.add(item.segmentId)
    if (page.nextCursor === null) break
    cursor = page.nextCursor
  }
  const records = {}
  for (const format of ['txt', 'md', 'srt']) {
    const result = await history.exportSession({ sessionId, format })
    if (result.status !== 'saved') throw new Error(`history ${format} export was not saved`)
    const extension = format === 'md' ? 'md' : format
    const filePath = path.join(artifactDirectory, `i3-export.${extension}`)
    const content = fs.readFileSync(filePath, 'utf8')
    const recordCount = format === 'txt'
      ? (content.trimEnd() === '' ? 0 : content.trimEnd().split('\n').length)
      : format === 'md'
        ? (content.match(/^- /gm) || []).length
        : (content.match(/^\d+$/gm) || []).length
    records[format === 'md' ? 'markdown' : format === 'txt' ? 'text' : 'srt'] = {
      bytes: Buffer.byteLength(content, 'utf8'),
      recordCount,
      sha256: sha256(content)
    }
    fs.rmSync(filePath, { force: true })
  }
  return {
    exports: records,
    historyPageCount: pageCount,
    historyPageP95Ms: rounded(percentile(querySamples, 0.95) || 0),
    historySegmentCount: segmentIds.size
  }
}

function buildSyntheticFixtureReport (options) {
  const report = {
    boundaries: {
      actualElectronBrowserWindow: false,
      actualRealtimeAudioPipeline: false,
      actualSqliteStorage: false,
      controlledSpeakerPlayback: false,
      syntheticFixture: true,
      wallClockTwoHourRun: false
    },
    generatedAt: canonicalTimestamp(),
    kind: 'i3-live-audio-soak-synthetic-fixture',
    mode: 'synthetic-fixture',
    privacy: {
      capturedAudioPersisted: false,
      reportContainsAbsolutePath: false,
      reportContainsTranscriptText: false
    },
    result: 'pass',
    schemaVersion: 1,
    synthetic: { segmentCount: options.syntheticSegments }
  }
  return assertSafeReport(report)
}

function buildFailureReport (mode, code) {
  return assertSafeReport({
    errorCode: String(code || 'I3_LIVE_RUN_FAILED').replace(/[^A-Z0-9_]/g, '_').slice(0, 64) || 'I3_LIVE_RUN_FAILED',
    generatedAt: canonicalTimestamp(),
    kind: 'i3-live-audio-soak-failure',
    mode,
    privacy: {
      capturedAudioPersisted: false,
      reportContainsAbsolutePath: false,
      reportContainsTranscriptText: false
    },
    result: 'error',
    schemaVersion: 1
  })
}

async function runRecoverySeed (databasePath, seedPath, sessionId) {
  const args = [__filename, '--internal-recovery-seed', '--database-path', databasePath, '--seed-path', seedPath, '--session-id', sessionId]
  await new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`recovery seed exited with ${code}`)))
  })
  const seeded = parseStrictEvidenceJson(fs.readFileSync(seedPath), 'I3 recovery seed')
  if (seeded?.seeded !== true || seeded?.sessionId !== sessionId) throw new Error('recovery seed did not acknowledge SQLite commit')
}

async function runInternalRecoverySeed (options) {
  app.on('window-all-closed', () => {})
  await app.whenReady()
  const gateway = new StorageGateway({ databasePath: path.resolve(options.databasePath) })
  await gateway.start()
  await gateway.openSession({ sessionId: options.sessionId, sourceId: 'loopback', startedAt: Date.now() })
  await gateway.flush()
  fs.mkdirSync(path.dirname(options.seedPath), { recursive: true })
  fs.writeFileSync(options.seedPath, JSON.stringify({ seeded: true, sessionId: options.sessionId }), 'utf8')
  /* Intentional ungraceful main-process exit: no gateway shutdown or terminal
     close.  The parent process must observe real SQLite stale-session repair. */
  process.exit(0)
}

async function runRealAudioSoak (options) {
  const acceptance = options.mode === 'acceptance'
  const requiredDurationMs = options.durationSeconds * 1000
  const requiredFinalSegments = acceptance ? MIN_FINAL_SEGMENTS : MIN_QUALIFICATION_FINAL_SEGMENTS
  const requiredResourceSamples = acceptance ? SOAK_LIMITS.minResourceSamples : MIN_QUALIFICATION_RESOURCE_SAMPLES
  const soakId = safeRunId()
  const reportPath = path.resolve(options.report)
  const progressPath = path.resolve(options.progress || `${options.report}.progress.json`)
  const artifactDirectory = options.artifactDirectory
    ? path.resolve(options.artifactDirectory)
    : path.join(PROJECT_ROOT, '.artifacts', 'i3-live-audio', `run-${soakId}`)
  const databasePath = path.join(artifactDirectory, 'user-data', 'data', 'speech-agent.sqlite3')
  const seedPath = path.join(artifactDirectory, 'recovery-seed.json')
  const progress = createProgressWriter(progressPath, soakId)
  let statusWindow = null
  let playback = null
  let runtime = null
  let resourceSampler = null
  let cleanupArtifacts = options.keepArtifacts !== true
  let listeningStartedAt = null
  const captions = { events: 0, finals: 0, partials: 0, postRecoveryFinals: 0, preRecoveryFinals: 0, refined: 0 }
  const transportGenerations = []
  let workerCrash = { errorObserved: false, retrySucceeded: false, workerExitForced: false }
  let captionGeneration = 'pre-recovery'
  let playbackCycles = 0
  let postRecoveryPlaybackCycles = 0
  let heartbeatTimer = null
  let progressTimer = null
  let listeningStopInitiatedAt = null
  let phase = 'preparing'

  /* The acceptance stopwatch begins only after SessionCoordinator confirms
     listening. Model loading, storage startup, and window preparation are
     deliberately excluded from the two-hour wall-clock proof. */
  const elapsed = () => listeningStartedAt === null ? 0 : Math.max(0, performance.now() - listeningStartedAt)
  const writeProgress = (nextPhase = phase, elapsedWallMs = elapsed(), crash = workerCrash.workerExitForced ? 'recovered' : 'pending') => {
    phase = nextPhase
    progress.write({
      dragObserved: statusWindow?.dragObserved === true,
      elapsedWallMs,
      mode: options.mode,
      phase,
      visible: statusWindow?.visible === true,
      workerCrash: crash
    })
  }
  try {
    fs.mkdirSync(artifactDirectory, { recursive: true })
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    app.on('window-all-closed', () => {})
    app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
    app.setPath('userData', path.join(artifactDirectory, 'electron-user-data'))
    await app.whenReady()
    statusWindow = await createVisibleStatusWindow()
    await statusWindow.heartbeat('Preparing real audio pipeline', 0)
    writeProgress('starting-real-runtime', 0, 'not-yet-requested')

    /* Electron profile/SQLite are run-isolated, while models are read only
       from an explicitly supplied (or frozen shared) audited user-data root.
       `allowExternal:false` forbids a silent fallback to env/repo paths. */
    const auditedModels = resolveAuditedModels(options.modelUserData)
    const model = auditedModels.model
    const vadModel = auditedModels.vad
    const refinementModel = auditedModels.refinement
    const preflight = options.source === 'mic' ? readPhysicalMicPreflight(options.physicalMicPreflight) : null
    const wave = readI3ShortStimulus()
    const coordinatorSessionOptions = buildI3CoordinatorSessionOptions({
      source: options.source,
      model,
      refinementModel
    })
    let runtimeAdapter = null
    const sessionId = `i3-live-${soakId}`
    runtime = new SubtitleApplicationRuntime({
      userDataDir: path.join(artifactDirectory, 'user-data'),
      databasePath,
      coordinatorFactory: ({ persistenceSink }) => new SessionCoordinator({
        adapterFactory: () => {
          runtimeAdapter = new RealtimeRuntimeAdapter({
            micLabelSha256: preflight?.micLabelSha256 || null,
            profileMap: { [model.profile]: model.id },
            recognizer: { kind: model.kind, modelDir: model.modelDir, modelType: model.modelType, numThreads: model.numThreads },
            refinement: refinementModel
              ? { kind: refinementModel.kind, modelDir: refinementModel.modelDir, numThreads: refinementModel.numThreads }
              : undefined,
            vad: vadModel || undefined
          })
          return runtimeAdapter
        },
        configuration: coordinatorSessionOptions.configuration,
        idFactory: () => sessionId,
        persistenceSink,
        runtimeOptions: coordinatorSessionOptions.runtimeOptions,
        transitionTimeoutMs: 30000
      })
    })
    const started = await runtime.start()
    const coordinator = started.coordinator
    coordinator.onCaption((event) => {
      captions.events += 1
      if (event.kind === 'partial') captions.partials += 1
      else if (event.kind === 'final') {
        captions.finals += 1
        if (captionGeneration === 'post-recovery') captions.postRecoveryFinals += 1
        else captions.preRecoveryFinals += 1
      }
      else if (event.kind === 'refined') captions.refined += 1
    })
    playback = await createPlaybackController(wave, options.source, preflight)
    const startedSession = await coordinator.command('start')
    if (!startedSession.ok || coordinator.getSnapshot().phase !== 'listening') throw new Error('COORDINATOR_START_FAILED')
    listeningStartedAt = performance.now()
    resourceSampler = startResourceSampler(runtime.gateway)
    await statusWindow.heartbeat('Listening through real audio pipeline', 0)
    writeProgress('listening-real-audio', elapsed(), acceptance ? 'scheduled-at-halfway' : 'scheduled-at-30-seconds')
    heartbeatTimer = setInterval(() => {
      void statusWindow.heartbeat('Listening through real audio pipeline', elapsed() / 1000).catch(() => {})
    }, WINDOW_HEARTBEAT_INTERVAL_MS)
    progressTimer = setInterval(() => writeProgress(
      'listening-real-audio', elapsed(), workerCrash.workerExitForced ? 'recovered' : (acceptance ? 'scheduled-at-halfway' : 'scheduled-at-30-seconds')
    ), PROGRESS_INTERVAL_MS)

    let crashInjected = false
    const workerCrashTargetMs = acceptance ? requiredDurationMs / 2 : QUALIFICATION_CRASH_TARGET_MS
    while (elapsed() < requiredDurationMs) {
      await playback.play()
      playbackCycles += 1
      if (!crashInjected && elapsed() >= workerCrashTargetMs) {
        const paused = await coordinator.command('pause')
        if (!paused.ok) throw new Error('PAUSE_BEFORE_WORKER_CRASH_FAILED')
        workerCrash = await forceRealtimeWorkerCrashAndRetry({
          coordinator,
          onRecovered: () => { captionGeneration = 'post-recovery' },
          runtimeAdapter,
          elapsedWallMs: elapsed(),
          onProgress: writeProgress
        })
        transportGenerations.push(transportProjection(runtimeAdapter.getLastRunDiagnostics(), options.source))
        crashInjected = true
      }
      if (crashInjected) postRecoveryPlaybackCycles += 1
    }
    if (!crashInjected) throw new Error('WORKER_CRASH_HOOK_NOT_REACHED')
    writeProgress('flushing-and-closing-real-session', elapsed(), 'recovered')
    /* The tracked stimulus already includes 1.1 seconds of digital silence,
       so no extra tail can lower the >3,000 segment capacity of a two-hour
       run.  This tiny yield only lets final/refined IPC settle. */
    await delay(100)
    /* Freeze the wall-clock measurement at the real stop boundary.  SQLite
       paging/export and the later crash-recovery proof must never pad a
       short audio session into an apparent two-hour soak. */
    listeningStopInitiatedAt = performance.now()
    const stopped = await coordinator.command('stop')
    if (!stopped.ok || coordinator.getSnapshot().phase !== 'idle') throw new Error('COORDINATOR_STOP_FAILED')
    await runtime.gateway.flush()
    transportGenerations.push(transportProjection(runtimeAdapter.getLastRunDiagnostics(), options.source))
    const resources = resourceSampler.stop()
    resourceSampler = null
    const sessionTranscript = await runtime.gateway.getSessionTranscript(sessionId)
    const sqliteStats = await runtime.gateway.getStats()
    const history = await inspectHistoryAndExports({ gateway: runtime.gateway, sessionId, artifactDirectory })
    await runtime.shutdownWithin(45000)
    runtime = null

    /* This isolated second Electron main process commits an active session and
       exits without graceful cleanup.  Reopening through the product root is
       the evidence for stale-session recovery, distinct from the in-session
       realtime worker kill/retry above. */
    writeProgress('seeding-isolated-main-process-crash-recovery', elapsed(), 'recovered')
    const recoverySessionId = `i3-recovery-${soakId}`
    await runRecoverySeed(databasePath, seedPath, recoverySessionId)
    const recoveryRuntime = new SubtitleApplicationRuntime({
      userDataDir: path.join(artifactDirectory, 'user-data'),
      databasePath,
      coordinatorFactory: ({ persistenceSink }) => new SessionCoordinator({
        adapterFactory: () => new RealtimeRuntimeAdapter({ profileMap: { [model.profile]: model.id } }),
        configuration: { onboardingCompleted: true, onboardingPreset: 'meeting', loopback: true, mic: false },
        idFactory: () => `i3-recovery-reader-${soakId}`,
        persistenceSink,
        runtimeOptions: { modelOverride: { developmentOnly: false, id: model.id, profile: model.profile } }
      })
    })
    const recoveryStarted = await recoveryRuntime.start()
    const recoveredTranscript = await recoveryRuntime.gateway.getSessionTranscript(recoverySessionId)
    const recovery = {
      recoveredSessionCount: recoveryStarted.recoveryReport?.recoveredSessionCount ?? null,
      recoveryStatus: recoveryStarted.recoveryReport?.status ?? null,
      recoveredSessionTerminal: recoveredTranscript?.session?.state === 'interrupted',
      separateMainProcessForcedExit: true
    }
    const finalStats = await recoveryRuntime.gateway.getStats()
    await recoveryRuntime.shutdownWithin(45000)
    fs.rmSync(seedPath, { force: true })

    const measuredListeningWallDurationMs = listeningStopInitiatedAt === null
      ? 0
      : Math.max(0, listeningStopInitiatedAt - listeningStartedAt)
    if (transportGenerations.length !== 2) throw new Error('I3 transport generations were not both captured')
    const transport = {
      forcedCrashGeneration: transportGenerations[0],
      postRecoveryGeneration: transportGenerations[1]
    }
    const forcedCrashHealthyBeforeExit = ['badSampleTypeFrames', 'droppedCaptionCount', 'missedFrames', 'sequenceGapCount']
      .every((key) => transport.forcedCrashGeneration[key] === 0)
    const recoveredTransportHealthy = Object.values(transport.postRecoveryGeneration).every(Number.isFinite) &&
      ['badSampleTypeFrames', 'droppedCaptionCount', 'droppedFrames', 'lostInFlightFrames', 'missedFrames', 'sequenceGapCount']
        .every((key) => transport.postRecoveryGeneration[key] === 0)
    const acceptanceChecks = {
      audioArtifactsAbsent: audioFilesUnder(artifactDirectory).length === 0,
      actualWallClockTwoHours: measuredListeningWallDurationMs >= MIN_ACCEPTANCE_WALL_DURATION_MS,
      captionsPersisted: sessionTranscript.segments.length >= requiredFinalSegments,
      exportsComplete: Object.values(history.exports).every((entry) => entry.bytes > 0 &&
        entry.recordCount === sessionTranscript.segments.length && /^[a-f0-9]{64}$/.test(entry.sha256)),
      historyPaginationComplete: history.historySegmentCount === sessionTranscript.segments.length,
      nativeWindowDragObserved: statusWindow.dragObserved === true,
      noCapturePersisted: audioFilesUnder(artifactDirectory).length === 0,
      realBrowserWindowLongLived: statusWindow.rendered && statusWindow.visible && statusWindow.heartbeatCount >= MIN_WINDOW_HEARTBEATS,
      refinedObservedWhenEnabled: !refinementModel || captions.refined > 0,
      resourceBounds: resources.sampleCount >= requiredResourceSamples &&
        resources.appCpuP95Percent !== null && resources.appCpuP95Percent <= SOAK_LIMITS.maxAppCpuP95Percent &&
        resources.appWorkingSetMiBMax !== null && resources.appWorkingSetMiBMax <= SOAK_LIMITS.maxAppWorkingSetMiB &&
        resources.maxGatewayQueueDepth !== null && resources.maxGatewayQueueDepth <= SOAK_LIMITS.maxGatewayQueueDepth &&
        resources.maxProcessCount !== null && resources.maxProcessCount <= SOAK_LIMITS.maxProcessCount &&
        history.historyPageP95Ms <= SOAK_LIMITS.maxHistoryPageP95Ms,
      sqliteIntegrity: sqliteStats?.journalMode === 'wal' && sqliteStats?.integrity === 'ok' && finalStats?.integrity === 'ok',
      storageRecoveryAfterForcedMainExit: recovery.separateMainProcessForcedExit && recovery.recoveryStatus === 'committed' &&
        recovery.recoveredSessionCount === 1 && recovery.recoveredSessionTerminal,
      /* A forced worker exit can legitimately discard in-flight PCM at the
         injection boundary.  It is retained as a separate counter set, not
         summed away or called loss-free.  The recovered generation itself
         must be entirely loss-free. */
      transportHealthy: Object.values(transport.forcedCrashGeneration).every(Number.isFinite) &&
        forcedCrashHealthyBeforeExit && recoveredTransportHealthy,
      workerCrashRecovered: workerCrash.errorObserved && workerCrash.retrySucceeded && workerCrash.workerExitForced &&
        captions.postRecoveryFinals > 0
    }
    const metrics = {
      captionEvents: captions.events,
      finalSegments: captions.finals,
      historyPageCount: history.historyPageCount,
      historySegmentCount: history.historySegmentCount,
      historyPageP95Ms: history.historyPageP95Ms,
      measuredListeningWallDurationMs: rounded(measuredListeningWallDurationMs),
      playbackCycles,
      postRecoveryFinalSegments: captions.postRecoveryFinals,
      postRecoveryPlaybackCycles,
      preRecoveryFinalSegments: captions.preRecoveryFinals,
      refinedSegments: captions.refined,
      resource: resources,
      sqliteCaptionEvents: finalStats?.captionEvents ?? null,
      sqliteSegments: finalStats?.segments ?? null
    }
    const stimulus = {
      cycleDurationMs: wave.cycleDurationMs,
      derivedWavSha256: wave.derivedWavSha256,
      referenceSha256: wave.referenceSha256,
      scheduleLeadMs: PLAYBACK_SCHEDULE_LEAD_MS,
      silenceDurationMs: wave.silenceDurationMs,
      sliceLeadingSilenceMs: wave.sliceLeadingSilenceMs,
      sliceLengthMs: wave.sliceLengthMs,
      sliceSampleCount: wave.sliceSampleCount,
      sourceCorpusSha256: wave.sourceCorpusSha256,
      sourceId: options.source,
      sourceReferenceSha256: wave.sourceReferenceSha256,
      ...(preflight ? { physicalMicPreflightSha256: preflight.reportSha256 } : {})
    }
    const qualificationChecks = {
      audioArtifactsAbsent: acceptanceChecks.audioArtifactsAbsent,
      captionsPersisted: acceptanceChecks.captionsPersisted,
      controlledCycleBounded: wave.cycleDurationMs <= STIMULUS_DEFINITION.maximumCycleDurationMs &&
        Math.floor(QUALIFICATION_DURATION_SECONDS * 1000 /
          (wave.cycleDurationMs + PLAYBACK_SCHEDULE_LEAD_MS)) >= MIN_QUALIFICATION_FINAL_SEGMENTS + 9,
      exportsComplete: acceptanceChecks.exportsComplete,
      historyPaginationComplete: acceptanceChecks.historyPaginationComplete,
      noCapturePersisted: acceptanceChecks.noCapturePersisted,
      postRecoveryFinalsPersisted: captions.postRecoveryFinals >= MIN_QUALIFICATION_POST_RECOVERY_FINAL_SEGMENTS,
      preRecoveryFinalsPersisted: captions.preRecoveryFinals >= MIN_QUALIFICATION_PRE_RECOVERY_FINAL_SEGMENTS,
      realAudioDurationSeventyFiveSeconds: measuredListeningWallDurationMs >= QUALIFICATION_DURATION_SECONDS * 1000,
      refinedObservedWhenEnabled: acceptanceChecks.refinedObservedWhenEnabled,
      resourceBounds: acceptanceChecks.resourceBounds,
      sqliteIntegrity: acceptanceChecks.sqliteIntegrity,
      storageRecoveryAfterForcedMainExit: acceptanceChecks.storageRecoveryAfterForcedMainExit,
      transportHealthy: acceptanceChecks.transportHealthy,
      workerCrashRecovered: acceptanceChecks.workerCrashRecovered
    }
    const report = acceptance ? {
      boundaries: {
        actualElectronBrowserWindow: true,
        actualRealtimeAudioPipeline: true,
        actualSqliteStorage: true,
        controlledSpeakerPlayback: true,
        syntheticFixture: false,
        wallClockTwoHourRun: true
      },
      checks: acceptanceChecks,
      crashRecovery: recovery,
      environment: { electron: process.versions.electron, node: process.versions.node },
      exports: history.exports,
      generatedAt: canonicalTimestamp(),
      kind: 'i3-live-audio-soak',
      limits: SOAK_LIMITS,
      model: auditedModels.evidence,
      metrics,
      mode: 'acceptance',
      privacy: {
        capturedAudioPersisted: false,
        reportContainsAbsolutePath: false,
        reportContainsTranscriptText: false
      },
      progress: { soakId, statusWindowDragRequired: true, workerCrashInjectionRequired: true },
      provenance: currentProvenance(),
      result: Object.values(acceptanceChecks).every((value) => value === true) ? 'pass' : 'fail',
      schemaVersion: 1,
      stimulus,
      transport,
      window: {
        heartbeatCount: statusWindow.heartbeatCount,
        nativeDragObserved: statusWindow.dragObserved,
        rendered: statusWindow.rendered,
        visibleAtCompletion: statusWindow.visible
      }
    } : {
      boundaries: {
        actualElectronBrowserWindow: true,
        actualRealtimeAudioPipeline: true,
        actualSqliteStorage: true,
        controlledSpeakerPlayback: true,
        syntheticFixture: false,
        wallClockTwoHourRun: false
      },
      checks: qualificationChecks,
      crashRecovery: recovery,
      environment: { electron: process.versions.electron, node: process.versions.node },
      exports: history.exports,
      gateStatus: 'partial',
      generatedAt: canonicalTimestamp(),
      kind: 'i3-live-audio-qualification',
      limits: {
        crashTargetSeconds: QUALIFICATION_CRASH_TARGET_MS / 1000,
        durationSeconds: QUALIFICATION_DURATION_SECONDS,
        maxHistoryPageP95Ms: SOAK_LIMITS.maxHistoryPageP95Ms,
        maxStimulusCycleDurationMs: STIMULUS_DEFINITION.maximumCycleDurationMs,
        minFinalSegments: MIN_QUALIFICATION_FINAL_SEGMENTS,
        minPostRecoveryFinalSegments: MIN_QUALIFICATION_POST_RECOVERY_FINAL_SEGMENTS,
        minPreRecoveryFinalSegments: MIN_QUALIFICATION_PRE_RECOVERY_FINAL_SEGMENTS,
        minResourceSamples: MIN_QUALIFICATION_RESOURCE_SAMPLES
      },
      model: auditedModels.evidence,
      metrics,
      mode: 'qualification',
      privacy: {
        capturedAudioPersisted: false,
        reportContainsAbsolutePath: false,
        reportContainsTranscriptText: false
      },
      progress: { soakId, statusWindowDragRequired: false, workerCrashInjectionRequired: true },
      provenance: currentProvenance(),
      result: Object.values(qualificationChecks).every((value) => value === true) ? 'pass' : 'fail',
      schemaVersion: 1,
      stimulus,
      transport,
      window: {
        heartbeatCount: statusWindow.heartbeatCount,
        nativeDragObserved: statusWindow.dragObserved,
        rendered: statusWindow.rendered,
        visibleAtCompletion: statusWindow.visible
      }
    }
    assertSafeReport(report)
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    writeProgress(report.result === 'pass' ? 'completed-pass' : 'completed-fail', elapsed(), 'recovered')
    if (report.result !== 'pass') throw new Error(acceptance ? 'I3_LIVE_ACCEPTANCE_CHECK_FAILED' : 'I3_LIVE_QUALIFICATION_CHECK_FAILED')
    return report
  } finally {
    if (progressTimer) clearInterval(progressTimer)
    if (heartbeatTimer) clearInterval(heartbeatTimer)
    if (resourceSampler) resourceSampler.stop()
    if (playback) playback.destroy()
    if (runtime) await runtime.shutdownWithin(45000).catch(() => runtime.terminate())
    if (statusWindow) statusWindow.destroy()
    if (cleanupArtifacts) {
      /* Native SQLite/utility teardown can release its final Windows handle a
         few milliseconds after the logical shutdown boundary. Cleanup is
         best-effort evidence hygiene and must never replace an already-built
         pass/fail report with EPERM. */
      try {
        fs.rmSync(artifactDirectory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
      } catch { /* no captured audio is ever present; later artifact scans retain the failure */ }
    }
  }
}

async function main () {
  const internal = internalSeedArguments(process.argv.slice(2))
  if (internal) return runInternalRecoverySeed(internal)
  const options = parseArguments(process.argv.slice(2))
  const reportPath = path.resolve(options.report)
  if (fs.existsSync(reportPath)) throw new Error('I3 report already exists; use a fresh evidence path')
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  if (options.mode === 'synthetic-fixture') {
    const report = buildSyntheticFixtureReport(options)
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stdout.write(JSON.stringify({ gateStatus: 'partial', mode: report.mode, result: report.result }) + '\n')
    app.exit(0)
    return
  }
  try {
    const report = await runRealAudioSoak(options)
    process.stdout.write(JSON.stringify({ result: report.result, mode: report.mode, sourceId: report.stimulus.sourceId }) + '\n')
    app.quit()
  } catch (error) {
    const failure = buildFailureReport(options.mode, error?.code || 'I3_LIVE_RUN_FAILED')
    /* A completed check-fail report is more diagnostic and more truthful than
       replacing it with the generic exception raised to set exit code 1. */
    try {
      if (!fs.existsSync(reportPath)) fs.writeFileSync(reportPath, `${JSON.stringify(failure, null, 2)}\n`, 'utf8')
    } catch { /* best effort */ }
    app.exit(1)
  }
}

if (process.versions.electron && process.type === 'browser') {
  main().catch(() => app.exit(1))
}

module.exports = {
  DEFAULT_DURATION_SECONDS,
  MIN_ACCEPTANCE_WALL_DURATION_MS,
  MIN_FINAL_SEGMENTS,
  MIN_QUALIFICATION_FINAL_SEGMENTS,
  MIN_QUALIFICATION_POST_RECOVERY_FINAL_SEGMENTS,
  MIN_QUALIFICATION_PRE_RECOVERY_FINAL_SEGMENTS,
  PLAYBACK_SCHEDULE_LEAD_MS,
  PROVENANCE_FILES,
  QUALIFICATION_CRASH_TARGET_MS,
  QUALIFICATION_DURATION_SECONDS,
  SOAK_LIMITS,
  assertSafeReport,
  buildI3CoordinatorSessionOptions,
  buildFailureReport,
  buildSyntheticFixtureReport,
  currentProvenance,
  forceRealtimeWorkerCrashAndRetry,
  internalSeedArguments,
  parseArguments,
  resolveAuditedModels,
  sumTransport,
  transportProjection
}
