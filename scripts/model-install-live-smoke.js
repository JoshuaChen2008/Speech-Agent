'use strict'

// @ts-check

/* Real B4 installation/callability smoke. It serves the repository's
   hash-identical approved release assets over a loopback HTTP transport while
   ModelManager still validates the immutable production HTTPS manifest. No
   captured audio or transcript text is written to the report. */

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')
const sherpa = require('sherpa-onnx-node')

const { ModelManager } = require('../src/main/services/model-manager')
const { PRODUCTION_MODEL_MANIFEST } = require('../src/main/services/model-manifest')
const {
  resolveApprovedRealtimeModel,
  resolveApprovedRefinementModel,
  resolveSileroVadModel
} = require('../src/main/services/model-resolver')
const { SherpaOnlineRecognizerAdapter } = require('../src/runtime/realtime-worker/sherpa-recognizer')
const { loadOfflineRecognizer, refineSamples } = require('../src/runtime/refine-worker/offline-recognizer')
const { SileroVad } = require('../src/runtime/realtime-worker/silero-vad')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const APPROVED_ASSETS = Object.freeze({
  'x-asr-160ms': path.join(PROJECT_ROOT, 'models', 'gate-0b', 'downloads', 'x-asr-160ms-punct-int8.tar.bz2'),
  'x-asr-offline': path.join(PROJECT_ROOT, 'models', 'gate-0b', 'downloads', 'sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03.tar.bz2'),
  'silero-vad': path.join(PROJECT_ROOT, 'models', 'vad', 'silero_vad.onnx')
})
const CORPUS_FILE = path.join(PROJECT_ROOT, 'models', 'gate-0b', 'corpus', 'zh-roadmap.wav')

function parseArguments (argv) {
  const options = { workDir: null, report: null }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    if (argv[index] === '--work-dir') { options.workDir = value; index += 1 } else if (argv[index] === '--report') { options.report = value; index += 1 } else throw new Error(`unknown argument: ${argv[index]}`)
  }
  if (!options.workDir || !options.report) throw new Error('--work-dir and --report are required')
  const workDir = path.resolve(PROJECT_ROOT, options.workDir)
  const report = path.resolve(PROJECT_ROOT, options.report)
  const artifactRoot = path.join(PROJECT_ROOT, '.artifacts')
  if (!isWithin(artifactRoot, workDir) || !isWithin(artifactRoot, report)) {
    throw new Error('live smoke outputs must stay under .artifacts')
  }
  if (fs.existsSync(workDir)) throw new Error('work directory must not already exist')
  return { workDir, report }
}

function isWithin (parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function digestText (text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function assertApprovedAssets () {
  for (const artifact of PRODUCTION_MODEL_MANIFEST.artifacts) {
    const file = APPROVED_ASSETS[artifact.id]
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size !== artifact.bytes) throw new Error(`approved asset is missing or has the wrong size: ${artifact.id}`)
  }
  if (!fs.statSync(CORPUS_FILE).isFile()) throw new Error('controlled corpus is missing')
}

function startAssetServer () {
  const rangeRequests = []
  const server = http.createServer((request, response) => {
    const match = /^\/artifact\/([a-z0-9-]+)$/.exec(request.url || '')
    const artifactId = match && match[1]
    const file = artifactId && APPROVED_ASSETS[artifactId]
    if (!file) {
      response.writeHead(404).end()
      return
    }
    const size = fs.statSync(file).size
    const header = request.headers.range
    let start = 0
    if (typeof header === 'string') {
      const parsed = /^bytes=(\d+)-$/.exec(header)
      if (!parsed || Number(parsed[1]) >= size) {
        response.writeHead(416, { 'content-range': `bytes */${size}` }).end()
        return
      }
      start = Number(parsed[1])
      rangeRequests.push({ artifactId, start })
      response.writeHead(206, {
        'accept-ranges': 'bytes',
        'content-length': size - start,
        'content-range': `bytes ${start}-${size - 1}/${size}`
      })
    } else {
      response.writeHead(200, { 'accept-ranges': 'bytes', 'content-length': size })
    }
    fs.createReadStream(file, { start }).pipe(response)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({ server, port: address.port, rangeRequests })
    })
  })
}

async function seedInterruptedPart (userDataDir) {
  const bytes = 1024 * 1024
  const target = path.join(userDataDir, 'models', '.downloads', 'x-asr-160ms.part')
  await fsp.mkdir(path.dirname(target), { recursive: true })
  const source = await fsp.open(APPROVED_ASSETS['x-asr-160ms'], 'r')
  const output = await fsp.open(target, 'wx')
  try {
    const buffer = Buffer.allocUnsafe(bytes)
    const { bytesRead } = await source.read(buffer, 0, bytes, 0)
    await output.write(buffer, 0, bytesRead)
    await output.sync()
    return bytesRead
  } finally {
    await Promise.all([source.close(), output.close()])
  }
}

function runOnline (model, wave) {
  const recognizer = new SherpaOnlineRecognizerAdapter({
    kind: model.kind,
    modelDir: model.modelDir,
    numThreads: model.numThreads,
    modelType: model.modelType
  })
  const chunk = 640
  let partialObserved = false
  for (let offset = 0; offset < wave.samples.length; offset += chunk) {
    recognizer.acceptFrame(wave.samples.subarray(offset, Math.min(wave.samples.length, offset + chunk)))
    if ((recognizer.poll() || '').length > 0) partialObserved = true
  }
  const text = recognizer.endSegment() || ''
  recognizer.dispose()
  if (text.length === 0) throw new Error('installed online recognizer returned no text')
  return { partialObserved, outputDigest: digestText(text) }
}

function runOffline (model, wave) {
  const recognizer = loadOfflineRecognizer({
    kind: model.kind,
    modelDir: model.modelDir,
    numThreads: model.numThreads
  })
  const text = refineSamples(recognizer, wave.samples)
  if (text.length === 0) throw new Error('installed offline recognizer returned no text')
  return { outputDigest: digestText(text) }
}

function runVad (model, wave) {
  const vad = new SileroVad(model)
  let speechStartObserved = false
  const chunk = 512
  for (let offset = 0; offset < wave.samples.length; offset += chunk) {
    const result = vad.push(wave.samples.subarray(offset, Math.min(wave.samples.length, offset + chunk)))
    if (result.event === 'speech-start') speechStartObserved = true
  }
  for (let index = 0; index < 40; index += 1) {
    const result = vad.push(new Float32Array(chunk))
    if (result.event === 'speech-start') speechStartObserved = true
  }
  vad.reset()
  if (!speechStartObserved) throw new Error('installed VAD did not detect the controlled speech')
  return { speechStartObserved }
}

async function main () {
  const options = parseArguments(process.argv.slice(2))
  assertApprovedAssets()
  await fsp.mkdir(options.workDir, { recursive: false })
  const userDataDir = path.join(options.workDir, 'user-data')
  await fsp.mkdir(userDataDir, { recursive: false })
  const seededBytes = await seedInterruptedPart(userDataDir)
  const transport = await startAssetServer()
  const statusStates = []
  const manager = new ModelManager({
    userDataDir,
    fetchImpl: (url, requestOptions) => {
      const artifact = PRODUCTION_MODEL_MANIFEST.artifacts.find((item) => item.url === url)
      if (!artifact) throw new Error('unexpected manifest URL')
      return fetch(`http://127.0.0.1:${transport.port}/artifact/${artifact.id}`, requestOptions)
    }
  })
  manager.onStatus((status) => statusStates.push(status.state))

  try {
    const initial = await manager.initialize()
    if (initial.state !== 'missing' || initial.downloadedBytes !== seededBytes) throw new Error('resume seed was not discovered')
    const installed = await manager.install()
    if (installed.state !== 'ready' || installed.resources.some((resource) => resource.state !== 'ready')) throw new Error('model bundle did not reach ready')

    const resolverOptions = { env: {}, userDataDir, repoRoot: path.join(options.workDir, 'empty-repo') }
    const realtime = resolveApprovedRealtimeModel(resolverOptions)
    const refinement = resolveApprovedRefinementModel(resolverOptions)
    const vad = resolveSileroVadModel(resolverOptions)
    if (!realtime || !refinement || !vad) throw new Error('installed model bundle was not resolved')
    for (const resolvedPath of [realtime.modelDir, refinement.modelDir, vad.modelPath]) {
      if (!isWithin(userDataDir, resolvedPath)) throw new Error('resolver did not use the installed bundle')
    }

    const wave = sherpa.readWave(CORPUS_FILE)
    if (wave.sampleRate !== 16000) throw new Error('controlled corpus must be 16 kHz')
    const online = runOnline(realtime, wave)
    const offline = runOffline(refinement, wave)
    const vadResult = runVad(vad, wave)
    const audioArtifacts = []
    for (const entry of fs.readdirSync(options.workDir, { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && /\.(?:wav|pcm|mp3|flac|m4a|ogg)$/i.test(entry.name)) audioArtifacts.push(entry.name)
    }
    if (audioArtifacts.length > 0) throw new Error('live smoke persisted an audio artifact')

    const report = {
      schemaVersion: 1,
      kind: 'model-install-live-smoke',
      generatedAt: new Date().toISOString(),
      manifestVersion: PRODUCTION_MODEL_MANIFEST.version,
      result: 'pass',
      transport: {
        source: 'loopback-http-from-hash-identical-approved-assets',
        resumeSeedBytes: seededBytes,
        rangeResumeObserved: transport.rangeRequests.some((item) => item.artifactId === 'x-asr-160ms' && item.start === seededBytes)
      },
      installation: {
        resourceCount: installed.resources.length,
        totalBytes: installed.totalBytes,
        finalState: installed.state,
        observedStates: [...new Set(statusStates)]
      },
      callability: {
        online: { loaded: true, partialObserved: online.partialObserved, finalNonEmpty: true, outputDigest: online.outputDigest },
        offline: { loaded: true, finalNonEmpty: true, outputDigest: offline.outputDigest },
        vad: { loaded: true, speechStartObserved: vadResult.speechStartObserved }
      },
      privacy: {
        capturedAudioPersisted: false,
        transcriptTextPersisted: false,
        localPathsPersisted: false
      }
    }
    if (!report.transport.rangeResumeObserved) throw new Error('Range resume was not observed')
    await fsp.mkdir(path.dirname(options.report), { recursive: true })
    await fsp.writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } finally {
    await manager.shutdown().catch(() => {})
    await new Promise((resolve) => transport.server.close(resolve))
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exitCode = 1
})
