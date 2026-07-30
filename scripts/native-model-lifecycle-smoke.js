'use strict'

// @ts-check

/* Native UtilityProcess lifecycle diagnostic.
   It resolves the already-installed, manifest-approved model bundle from an
   explicit read-only userData tree, then repeatedly loads the realtime ASR +
   VAD and offline refinement workers concurrently and asks both workers to
   exit through their product shutdown protocol. No BrowserWindow, capture
   source, MessagePort carrying PCM, transcript text or audio artifact is
   created. This diagnoses native model ABI/lifecycle pressure; it does not
   reproduce an interactive user crash or satisfy the two-hour I3 gate. */

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

const PROJECT_ROOT = path.resolve(__dirname, '..')
const ARTIFACT_ROOT = path.join(PROJECT_ROOT, '.artifacts')
const AUDIO_EXTENSION = /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)$/i

function isWithin (parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function parseArguments (argv) {
  const values = { modelUserData: null, workDir: null, report: null, iterations: 3 }
  for (let index = 0; index < argv.length; index += 1) {
    const next = argv[index + 1]
    if (argv[index] === '--model-user-data') { values.modelUserData = next; index += 1 } else if (argv[index] === '--work-dir') { values.workDir = next; index += 1 } else if (argv[index] === '--report') { values.report = next; index += 1 } else if (argv[index] === '--iterations') { values.iterations = Number(next); index += 1 } else throw new Error(`unknown argument: ${argv[index]}`)
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
  if (fs.existsSync(workDir)) throw new Error('work directory must not already exist')
  if (!Number.isInteger(values.iterations) || values.iterations < 1 || values.iterations > 20) {
    throw new Error('iterations must be an integer from 1 through 20')
  }
  return { modelUserData, workDir, report, iterations: values.iterations }
}

function delay (milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitForStats (host, label, timeoutMs = 2000) {
  let unsubscribe = () => {}
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe()
        reject(new Error(`${label} stats timed out`))
      }, timeoutMs)
      unsubscribe = host.onStats(() => {
        clearTimeout(timer)
        unsubscribe()
        resolve()
      })
      host.requestStats()
    })
  } finally {
    unsubscribe()
  }
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

function createReport (state, result, errorCode = null) {
  return {
    schemaVersion: 1,
    kind: 'native-model-lifecycle-smoke',
    generatedAt: new Date().toISOString(),
    result,
    gateStatus: 'diagnostic-only',
    runtime: {
      electron: process.versions.electron,
      node: process.versions.node
    },
    scope: {
      approvedInstalledBundleResolved: state.bundleResolved,
      realtimeModelAndVadLoaded: state.realtimeLoaded,
      offlineRefinementModelLoaded: state.refinementLoaded,
      audioCaptureOpened: false,
      pcmFramesSent: 0,
      packagedRuntime: false,
      userDialogReproduced: false,
      browserWindowCount: state.browserWindowCount
    },
    metrics: {
      requestedIterations: state.requestedIterations,
      completedIterations: state.completedIterations,
      responsiveWorkerPairs: state.responsiveWorkerPairs,
      gracefulRealtimeExits: state.gracefulRealtimeExits,
      gracefulRefinementExits: state.gracefulRefinementExits,
      zeroExitCodeCount: state.zeroExitCodeCount,
      fatalErrorCount: state.fatalErrorCount,
      abnormalChildProcessCount: state.abnormalChildProcessCount,
      cleanChildProcessCount: state.cleanChildProcessCount
    },
    privacy: {
      capturedAudioPersisted: false,
      transcriptTextPersisted: false,
      localPathsPersisted: false,
      diagnosticAudioArtifacts: state.audioArtifactCount
    },
    limitations: [
      'no-audio-capture-or-pcm',
      'does-not-reproduce-user-dialog',
      'does-not-prove-two-hour-stability',
      'not-packaged-i4'
    ],
    errorCode
  }
}

async function writeReport (reportPath, report) {
  await fsp.mkdir(path.dirname(reportPath), { recursive: true })
  await fsp.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
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
    completedIterations: 0,
    responsiveWorkerPairs: 0,
    gracefulRealtimeExits: 0,
    gracefulRefinementExits: 0,
    zeroExitCodeCount: 0,
    fatalErrorCount: 0,
    abnormalChildProcessCount: 0,
    cleanChildProcessCount: 0,
    audioArtifactCount: 0,
    bundleResolved: false,
    realtimeLoaded: false,
    refinementLoaded: false,
    browserWindowCount: 0
  }

  app.on('child-process-gone', (_event, details) => {
    if (details?.reason === 'clean-exit') state.cleanChildProcessCount += 1
    else state.abnormalChildProcessCount += 1
  })

  await app.whenReady()
  let activeHosts = []
  try {
    const resolverOptions = {
      env: {},
      userDataDir: options.modelUserData,
      repoRoot: path.join(options.workDir, 'empty-repo')
    }
    const realtime = resolveApprovedRealtimeModel(resolverOptions)
    const refinement = resolveApprovedRefinementModel(resolverOptions)
    const vad = resolveSileroVadModel(resolverOptions)
    if (!realtime || !refinement || !vad) throw new Error('approved installed model bundle was not resolved')
    if (!isWithin(options.modelUserData, realtime.modelDir) ||
        !isWithin(options.modelUserData, refinement.modelDir) ||
        !isWithin(options.modelUserData, vad.modelPath)) {
      throw new Error('resolver escaped the approved installed bundle')
    }
    state.bundleResolved = true

    for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
      const onFatalError = () => { state.fatalErrorCount += 1 }
      const realtimeHost = new RealtimeWorkerHost({ onFatalError })
      const refinementHost = new RefineWorkerHost({ onFatalError })
      activeHosts = [realtimeHost, refinementHost]

      await Promise.all([
        realtimeHost.start({
          sessionId: `native-lifecycle-${iteration}`,
          sourceIds: ['mic'],
          recognizerProfile: realtime.id,
          recognizer: {
            kind: realtime.kind,
            modelDir: realtime.modelDir,
            numThreads: realtime.numThreads,
            modelType: realtime.modelType
          },
          vad,
          refinement: true
        }),
        refinementHost.start({
          model: {
            kind: refinement.kind,
            modelDir: refinement.modelDir,
            numThreads: refinement.numThreads
          }
        })
      ])
      state.realtimeLoaded = true
      state.refinementLoaded = true

      const refinementChannel = new MessageChannelMain()
      realtimeHost.attachRefinePort(refinementChannel.port1)
      refinementHost.attachPort(refinementChannel.port2)

      await Promise.all([
        waitForStats(realtimeHost, 'realtime'),
        waitForStats(refinementHost, 'refinement')
      ])
      state.responsiveWorkerPairs += 1

      const [realtimeOutcome, refinementOutcome] = await Promise.all([
        realtimeHost.shutdown(),
        refinementHost.shutdown()
      ])
      activeHosts = []
      if (realtimeOutcome.graceful && realtimeOutcome.exitCode === 0) state.gracefulRealtimeExits += 1
      if (refinementOutcome.graceful && refinementOutcome.exitCode === 0) state.gracefulRefinementExits += 1
      if (realtimeOutcome.exitCode === 0) state.zeroExitCodeCount += 1
      if (refinementOutcome.exitCode === 0) state.zeroExitCodeCount += 1
      state.completedIterations += 1
      await delay(100)
    }

    state.audioArtifactCount = audioFilesUnder(options.workDir).length
    state.browserWindowCount = BrowserWindow.getAllWindows().filter((win) => !win.isDestroyed()).length
    const passed = state.completedIterations === options.iterations &&
      state.responsiveWorkerPairs === options.iterations &&
      state.gracefulRealtimeExits === options.iterations &&
      state.gracefulRefinementExits === options.iterations &&
      state.zeroExitCodeCount === options.iterations * 2 &&
      state.fatalErrorCount === 0 &&
      state.abnormalChildProcessCount === 0 &&
      state.browserWindowCount === 0 &&
      state.audioArtifactCount === 0
    if (!passed) throw new Error('native lifecycle diagnostic checks did not pass')

    const report = createReport(state, 'pass')
    await writeReport(options.report, report)
    process.stdout.write(`${JSON.stringify({ result: report.result, gateStatus: report.gateStatus, metrics: report.metrics })}\n`)
    app.exit(0)
  } catch {
    await Promise.allSettled(activeHosts.map((host) => host.dispose()))
    state.audioArtifactCount = audioFilesUnder(options.workDir).length
    const report = createReport(state, 'fail', 'NATIVE_MODEL_LIFECYCLE_FAILED')
    await writeReport(options.report, report).catch(() => {})
    console.error('native model lifecycle diagnostic failed')
    app.exit(1)
  }
}

run().catch(() => {
  console.error('native model lifecycle diagnostic failed before report creation')
  app.exit(1)
})
