'use strict'

// @ts-check

/* Real native model activity + UtilityProcess lifecycle diagnostic.

   Example (PowerShell):
     ./scripts/run-electron-smoke.ps1 `
       -EntryPoint scripts/native-model-activity-lifecycle-smoke.js `
       -EntryArguments @(
         '--model-user-data', '.artifacts/model-install-live-20260731-3/user-data',
         '--work-dir', '.artifacts/native-model-activity-1',
         '--report', '.artifacts/native-model-activity-1-report.json',
         '--iterations', '3'
       )

   The diagnostic resolves only the manifest-approved installed realtime,
   Silero VAD and offline refinement bundle. It reads one hash-pinned frozen
   corpus fixture, converts it to Float32 only in memory, sends it directly to
   the realtime utility through the product credit protocol, observes final +
   refined activity as counters, then requests graceful shutdown from both
   native utility processes and waits for their exact exit codes. It never
   creates an audio capture source or BrowserWindow and never persists raw
   audio, PCM, caption text or an audio/model path in its report or logs. */

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { app, BrowserWindow, MessageChannelMain } = require('electron')
const {
  resolveApprovedRealtimeModel,
  resolveApprovedRefinementModel,
  resolveSileroVadModel
} = require('../src/main/services/model-resolver')
const { RealtimeWorkerHost } = require('../src/runtime/realtime-worker/worker-host')
const { RefineWorkerHost } = require('../src/runtime/refine-worker/worker-host')
const {
  CreditControlledPcmSender,
  DEFAULT_FRAME_SAMPLES,
  feedWaveInMemory,
  parsePcm16MonoWav
} = require('./native-model-activity-support')
const {
  FIXTURE_SHA256,
  createNativeModelActivityReport,
  validateNativeModelActivityReport
} = require('./verify-native-model-activity-lifecycle-report')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const ARTIFACT_ROOT = path.join(PROJECT_ROOT, '.artifacts')
const FIXTURE_PATH = path.join(PROJECT_ROOT, 'models', 'gate-0b', 'corpus', 'zh-en-code-switch.wav')
const AUDIO_EXTENSION = /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)$/i
const TRAILING_SILENCE_FRAMES = 15

function isWithin (parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function parseArguments (argv) {
  const values = {
    modelUserData: null,
    workDir: null,
    report: null,
    iterations: 3,
    activityTimeoutMs: 30000
  }
  for (let index = 0; index < argv.length; index += 1) {
    const next = argv[index + 1]
    if (argv[index] === '--model-user-data') { values.modelUserData = next; index += 1 } else if (argv[index] === '--work-dir') { values.workDir = next; index += 1 } else if (argv[index] === '--report') { values.report = next; index += 1 } else if (argv[index] === '--iterations') { values.iterations = Number(next); index += 1 } else if (argv[index] === '--activity-timeout-ms') { values.activityTimeoutMs = Number(next); index += 1 } else throw new Error('unknown diagnostic argument')
  }
  if (!values.modelUserData || !values.workDir || !values.report) {
    throw new Error('--model-user-data, --work-dir and --report are required')
  }
  const modelUserData = path.resolve(PROJECT_ROOT, values.modelUserData)
  const workDir = path.resolve(PROJECT_ROOT, values.workDir)
  const report = path.resolve(PROJECT_ROOT, values.report)
  if (!isWithin(ARTIFACT_ROOT, modelUserData) || !fs.statSync(modelUserData).isDirectory()) {
    throw new Error('model userData must be an existing directory under .artifacts')
  }
  if (!isWithin(ARTIFACT_ROOT, workDir) || !isWithin(ARTIFACT_ROOT, report)) {
    throw new Error('diagnostic outputs must stay under .artifacts')
  }
  if (fs.existsSync(workDir) || fs.existsSync(report)) {
    throw new Error('diagnostic output targets must not already exist')
  }
  if (!Number.isInteger(values.iterations) || values.iterations < 1 || values.iterations > 20) {
    throw new Error('iterations must be an integer from 1 through 20')
  }
  if (!Number.isInteger(values.activityTimeoutMs) || values.activityTimeoutMs < 5000 || values.activityTimeoutMs > 120000) {
    throw new Error('activity timeout must be an integer from 5000 through 120000 milliseconds')
  }
  return {
    modelUserData,
    workDir,
    report,
    iterations: values.iterations,
    activityTimeoutMs: values.activityTimeoutMs
  }
}

function delay (milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitUntil (predicate, poll, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    poll()
    if (predicate()) return
    await delay(100)
  }
  throw new Error('native model activity timed out')
}

function audioFilesUnder (directory) {
  const found = []
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (AUDIO_EXTENSION.test(entry.name)) found.push(entry.name)
    }
  }
  visit(directory)
  return found
}

async function writeReport (reportPath, report) {
  await fsp.mkdir(path.dirname(reportPath), { recursive: true })
  await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
}

function readFrozenFixture () {
  const buffer = fs.readFileSync(FIXTURE_PATH)
  const digest = crypto.createHash('sha256').update(buffer).digest('hex')
  if (digest !== FIXTURE_SHA256) throw new Error('frozen diagnostic fixture digest mismatch')
  return parsePcm16MonoWav(buffer)
}

async function runIteration (context, ordinal) {
  const captionCounts = { final: 0, refined: 0 }
  const onFatalError = () => { context.state.fatalErrorCount += 1 }
  const realtimeHost = new RealtimeWorkerHost({ onFatalError })
  const refinementHost = new RefineWorkerHost({ onFatalError })
  context.activeHosts = [realtimeHost, refinementHost]
  let sender = null
  context.activeSender = null

  realtimeHost.onCaption((event) => {
    // Deliberately count and discard. Do not retain, hash, print or report text.
    if (event?.kind === 'final') captionCounts.final += 1
    else if (event?.kind === 'refined') captionCounts.refined += 1
  })

  await Promise.all([
    realtimeHost.start({
      sessionId: `native-activity-${ordinal}`,
      sourceIds: ['mic'],
      recognizerProfile: context.models.realtime.id,
      recognizer: {
        kind: context.models.realtime.kind,
        modelDir: context.models.realtime.modelDir,
        numThreads: context.models.realtime.numThreads,
        modelType: context.models.realtime.modelType
      },
      vad: context.models.vad,
      refinement: true
    }),
    refinementHost.start({
      model: {
        kind: context.models.refinement.kind,
        modelDir: context.models.refinement.modelDir,
        numThreads: context.models.refinement.numThreads
      }
    })
  ])
  context.state.realtimeLoaded = true
  context.state.vadLoaded = true
  context.state.refinementLoaded = true

  const realtimePid = realtimeHost.child?.pid
  const refinementPid = refinementHost.child?.pid
  const distinctProcessPair = Number.isInteger(realtimePid) && Number.isInteger(refinementPid) && realtimePid > 0 && refinementPid > 0 && realtimePid !== refinementPid
  if (!distinctProcessPair) throw new Error('native utility process identity was unavailable')

  const refinementChannel = new MessageChannelMain()
  realtimeHost.attachRefinePort(refinementChannel.port1)
  refinementHost.attachPort(refinementChannel.port2)
  const pcmChannel = new MessageChannelMain()
  realtimeHost.attachPort(pcmChannel.port1)
  sender = new CreditControlledPcmSender({
    port: pcmChannel.port2,
    sessionId: `native-activity-${ordinal}`,
    sourceId: 'mic',
    creditTimeoutMs: context.options.activityTimeoutMs
  })
  context.activeSender = sender
  sender.start()

  const fed = await feedWaveInMemory(sender, context.fixture.samples, {
    frameSamples: DEFAULT_FRAME_SAMPLES,
    trailingSilenceFrames: TRAILING_SILENCE_FRAMES
  })
  await waitUntil(
    () => {
      const realtime = realtimeHost.lastStats
      const refinement = refinementHost.lastStats
      return realtime?.sources?.mic?.framesIngested === fed.framesFed &&
        realtime.sources.mic.segmentsDetected >= 1 &&
        realtime.badSampleTypeFrames === 0 &&
        realtime.sources.mic.sequenceGapCount === 0 &&
        realtime.refine?.pending === 0 &&
        captionCounts.final >= 1 && captionCounts.refined >= 1 &&
        refinement?.refined >= 1 && refinement.failed === 0
    },
    () => {
      realtimeHost.requestStats()
      refinementHost.requestStats()
    },
    context.options.activityTimeoutMs
  )

  const concurrentDuringActivity = !!realtimeHost.child && !!refinementHost.child
  if (!concurrentDuringActivity) throw new Error('native utility process exited during activity')
  sender.end()
  await waitUntil(
    () => realtimeHost.lastStats?.endReceived === true,
    () => realtimeHost.requestStats(),
    5000
  )
  sender.close()
  sender = null
  context.activeSender = null

  const realtimeStats = realtimeHost.lastStats
  const refinementStats = refinementHost.lastStats
  const [realtimeOutcome, refinementOutcome] = await Promise.all([
    realtimeHost.shutdown(),
    refinementHost.shutdown()
  ])
  context.activeHosts = []

  return {
    ordinal,
    utility: { distinctProcessPair, concurrentDuringActivity },
    activity: {
      framesFed: fed.framesFed,
      framesIngested: realtimeStats.sources.mic.framesIngested,
      sequenceGapCount: realtimeStats.sources.mic.sequenceGapCount,
      badSampleTypeFrames: realtimeStats.badSampleTypeFrames,
      speechSegmentsDetected: realtimeStats.sources.mic.segmentsDetected,
      finalCaptionCount: captionCounts.final,
      refinedCaptionCount: captionCounts.refined,
      offlineDecodeCount: refinementStats.refined
    },
    shutdown: {
      realtimeGraceful: realtimeOutcome.graceful,
      realtimeExitCode: realtimeOutcome.exitCode,
      refinementGraceful: refinementOutcome.graceful,
      refinementExitCode: refinementOutcome.exitCode
    }
  }
}

async function run () {
  const options = parseArguments(process.argv.slice(2))
  await fsp.mkdir(options.workDir, { recursive: false })
  const electronUserData = path.join(options.workDir, 'electron-user-data')
  await fsp.mkdir(electronUserData, { recursive: false })
  app.setPath('userData', electronUserData)
  app.on('window-all-closed', () => {})

  const state = {
    requestedIterations: options.iterations,
    bundleResolved: false,
    realtimeLoaded: false,
    vadLoaded: false,
    refinementLoaded: false,
    fatalErrorCount: 0,
    browserWindowCount: 0,
    audioArtifactCount: 0
  }

  await app.whenReady()
  const context = {
    options,
    state,
    fixture: null,
    models: null,
    activeHosts: [],
    activeSender: null
  }
  const iterations = []
  try {
    const resolverOptions = {
      env: {},
      userDataDir: options.modelUserData,
      repoRoot: path.join(options.workDir, 'empty-repo')
    }
    const realtime = resolveApprovedRealtimeModel(resolverOptions)
    const refinement = resolveApprovedRefinementModel(resolverOptions)
    const vad = resolveSileroVadModel(resolverOptions)
    if (!realtime || !refinement || !vad ||
        !isWithin(options.modelUserData, realtime.modelDir) ||
        !isWithin(options.modelUserData, refinement.modelDir) ||
        !isWithin(options.modelUserData, vad.modelPath)) {
      throw new Error('approved installed model bundle was not resolved')
    }
    state.bundleResolved = true
    context.models = { realtime, refinement, vad }
    context.fixture = readFrozenFixture()

    for (let ordinal = 1; ordinal <= options.iterations; ordinal += 1) {
      iterations.push(await runIteration(context, ordinal))
      await delay(100)
    }

    state.audioArtifactCount = audioFilesUnder(options.workDir).length
    state.browserWindowCount = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).length
    const report = createNativeModelActivityReport({
      result: 'pass',
      runtime: { electron: process.versions.electron, node: process.versions.node },
      state,
      iterations
    })
    validateNativeModelActivityReport(report)
    await writeReport(options.report, report)
    process.stdout.write(`${JSON.stringify({ result: report.result, gateStatus: report.gateStatus, metrics: report.metrics })}\n`)
    app.exit(0)
  } catch {
    if (context.activeSender) context.activeSender.close()
    await Promise.allSettled(context.activeHosts.map((host) => host.dispose()))
    state.audioArtifactCount = audioFilesUnder(options.workDir).length
    state.browserWindowCount = BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed()).length
    const report = createNativeModelActivityReport({
      result: 'fail',
      runtime: { electron: process.versions.electron, node: process.versions.node },
      state,
      iterations,
      errorCode: 'NATIVE_MODEL_ACTIVITY_FAILED'
    })
    await writeReport(options.report, report).catch(() => {})
    console.error('native model activity lifecycle diagnostic failed')
    app.exit(1)
  }
}

run().catch(() => {
  console.error('native model activity lifecycle diagnostic failed before report creation')
  app.exit(1)
})
