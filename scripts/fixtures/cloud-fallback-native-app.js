'use strict'

// Isolated diagnostic: real Electron utility workers/native models, controlled
// cloud and capture boundaries. Only corpus PCM in memory; report has no text.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const { performance } = require('node:perf_hooks')
const { app, MessageChannelMain } = require('electron')
const { RealtimeWorkerHost } = require('../../src/runtime/realtime-worker/worker-host')
const { parsePcm16MonoWav } = require('../native-model-activity-support')
const { FIXTURE_SHA256 } = require('../verify-native-model-activity-lifecycle-report')
const { createMainEvidenceBridge } = require('../../src/main/services/electron-exit-evidence')

const evidence = createMainEvidenceBridge()
evidence.markLifecycle('main-started')

const root = path.resolve(__dirname, '../..')
const target = process.argv.find(value => value.startsWith('--report='))?.slice(9)
const relative = target && path.relative(path.join(root, '.artifacts'), target)
if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || path.extname(target) !== '.json') {
  app.exit(2)
} else {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-native-'))
  app.setPath('userData', userData)
  app.disableHardwareAcceleration()
  app.on('window-all-closed', () => {})
  app.whenReady().then(() => {
    evidence.markLifecycle('app-ready')
    evidence.markLifecycle('bootstrap-complete')
    return run()
  }).then(report => {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
    console.log(JSON.stringify({ result: report.result, cases: report.cases.length }))
    evidence.markLifecycle('quit-requested')
    app.once('will-quit', () => evidence.markLifecycle('will-quit'))
    app.quit()
  }).catch(() => { console.error('CLOUD_NATIVE_QUALIFICATION_FAILED'); app.exit(1) })
}

async function until (predicate, timeoutMs = 30000) {
  const deadline = performance.now() + timeoutMs
  while (!predicate()) {
    if (performance.now() > deadline) throw new Error('QUALIFICATION_TIMEOUT')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

function workingSetMiB (worker) {
  const metric = app.getAppMetrics().find(item => item.pid === worker.child?.pid)
  return metric ? Number((metric.memory.workingSetSize / 1024).toFixed(2)) : null
}

async function run () {
  const authoritative = path.join(root, 'models/gate-0b/extracted/x-asr-160/sherpa-onnx-x-asr-160ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05')
  const draft = path.join(root, 'models/gate-0b/extracted/replacement-candidates/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20')
  const vad = path.join(root, 'models/vad/silero_vad.onnx')
  const bytes = fs.readFileSync(path.join(root, 'models/gate-0b/corpus/zh-en-code-switch.wav'))
  const fixtureSha256 = createHash('sha256').update(bytes).digest('hex')
  if (fixtureSha256 !== FIXTURE_SHA256) throw new Error('FIXTURE_MISMATCH')
  const samples = parsePcm16MonoWav(bytes).samples
  const cases = []
  for (const cutSample of [0, 800]) {
    const transport = new RealtimeWorkerHost()
    const local = new RealtimeWorkerHost()
    const faultCodes = []
    const phases = []
    const transcript = createHash('sha256')
    let finalCount = 0; let partialCount = 0; let sentFrames = 0; let consumedFrames = 0
    let credits = 0; let ready = false; let loading = false
    transport.onControl(message => {
      if (message.type === 'recognition-fault') faultCodes.push(message.code)
      if (message.type === 'recognition-local-loading') loading = true
      if (message.type === 'recognition-local-ready') ready = true
      if (message.type === 'recognition-local-progress') phases.push(message.phase)
    })
    local.onCaption(event => {
      if (event.kind === 'final') { finalCount++; transcript.update(event.text) }
      if (event.kind === 'partial') partialCount++
    })
    const capture = new MessageChannelMain()
    const cloud = new MessageChannelMain()
    const pcm = capture.port1
    pcm.on('message', ({ data }) => {
      if (data.type === 'credits') { credits += data.count; consumedFrames += data.consumed }
    })
    pcm.start()
    cloud.port1.on('message', ({ data }) => {
      if (data.type === 'audio') { sentFrames++; cloud.port1.postMessage({ type: 'ack', id: data.id }) }
    })
    cloud.port1.start()
    try {
      await transport.start({ sessionId: 'qualification', sourceIds: ['mic'], cloudAudio: true,
        recognizerProfile: 'native-fallback', initialCredits: 2, creditBatch: 1,
        recognizer: { modelDir: authoritative }, draftRecognizer: { modelDir: draft }, vad: { modelPath: vad } })
      transport.attachCloudPort(cloud.port2)
      transport.attachPort(capture.port2)
      pcm.postMessage({ type: 'ready', sessionId: 'qualification', sourceIds: ['mic'] })
      let sequence = 0
      for (let offset = 0; offset < samples.length + 32000; offset += 1600) {
        await until(() => credits > 0)
        const frame = new Float32Array(1600)
        if (offset < samples.length) frame.set(samples.subarray(offset, Math.min(samples.length, offset + 1600)))
        credits--
        pcm.postMessage({ type: 'frame', sourceId: 'mic', sequence: sequence++,
          timestampSeconds: offset / 16000, sampleCount: 1600, samples: frame })
      }
      await until(() => sentFrames === sequence && consumedFrames === sequence)
      const cloudWorkingSetMiB = workingSetMiB(transport)
      const coldStart = performance.now()
      cloud.port1.postMessage({ type: 'takeover', sample: cutSample })
      await until(() => loading)
      await local.start({ sessionId: 'qualification', sourceIds: ['mic'], recognizerProfile: 'native-fallback',
        initialCredits: 1, creditBatch: 1,
        recognizer: { kind: 'sherpa-online-transducer', modelDir: authoritative, modelType: 'zipformer2', numThreads: 4 },
        draftRecognizer: { kind: 'sherpa-online-transducer', modelDir: draft, modelType: 'zipformer', numThreads: 4 },
        vad: { kind: 'silero', modelPath: vad } })
      const bridge = new MessageChannelMain()
      local.attachPort(bridge.port1)
      transport.attachFallbackPort(bridge.port2)
      await until(() => ready)
      const coldLoadMs = Math.round(performance.now() - coldStart)
      const localWorkingSetMiB = workingSetMiB(local)
      cloud.port1.postMessage({ type: 'local-start' })
      await until(() => phases.includes('local'))
      pcm.postMessage({ type: 'end' })
      await transport.waitForEnd(10000)
      await local.waitForEnd(10000)
      const ingestedFrames = local.lastStats.sources.mic.framesIngested
      if (faultCodes.length || !finalCount || !partialCount || ingestedFrames !== sequence ||
          transport.lastStats.sources.mic || transport.lastStats.cloudAudio.retainedSamples !== 0) throw new Error('NATIVE_ASSERTION_FAILED')
      cases.push({ cutSample, cloudWorkingSetMiB, localWorkingSetMiB, coldLoadMs, sentFrames,
        ingestedFrames, finalCount, partialCount, faultCount: faultCodes.length, transcriptSha256: transcript.digest('hex') })
    } finally {
      pcm.close(); cloud.port1.close()
      await Promise.all([transport.shutdown(), local.shutdown()])
    }
    if (transport.exited?.code !== 0 || local.exited?.code !== 0) throw new Error('CHILD_EXIT_FAILED')
    cases.at(-1).exactChildrenExited = true
  }
  return { schemaVersion: 1, result: 'pass', gateStatus: 'diagnostic-only', realNativeRecognition: true,
    realElectronWorkers: true, realCloud: false, realCapture: false, fixtureSha256, cases }
}
