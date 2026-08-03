'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { performance } = require('node:perf_hooks')

const sherpa = require('sherpa-onnx-node')
const { percentile } = require('./metrics')
const { projectStreamingBenchReport } = require('./evidence-projection')
const {
  readAndValidateRealtimeCandidateRegistry,
  selectRealtimeCandidate
} = require('./realtime-candidate-registry')

function parseArguments (argv) {
  const result = {
    wavs: [], runs: 5, chunkMs: 40, pace: true, output: null, modelDir: null,
    modelType: 'zipformer2', numThreads: 3, candidateRegistry: null, candidateId: null,
    modelTypeExplicit: false, numThreadsExplicit: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = argv[index + 1]
    switch (arg) {
      case '--model-dir': result.modelDir = value; index += 1; break
      case '--wav': result.wavs.push(value); index += 1; break
      case '--runs': result.runs = Number(value); index += 1; break
      case '--chunk-ms': result.chunkMs = Number(value); index += 1; break
      case '--output': result.output = value; index += 1; break
      case '--model-type': result.modelType = value; result.modelTypeExplicit = true; index += 1; break
      case '--num-threads': result.numThreads = Number(value); result.numThreadsExplicit = true; index += 1; break
      case '--candidate-registry': result.candidateRegistry = value; index += 1; break
      case '--candidate-id': result.candidateId = value; index += 1; break
      case '--no-pace': result.pace = false; break
      default: throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!result.modelDir) throw new Error('--model-dir is required')
  if (result.wavs.length === 0) throw new Error('at least one --wav is required')
  if (Boolean(result.candidateRegistry) !== Boolean(result.candidateId)) {
    throw new Error('--candidate-registry and --candidate-id must be provided together')
  }
  if (!Number.isInteger(result.runs) || result.runs < 1) throw new Error('--runs must be a positive integer')
  if (!Number.isFinite(result.chunkMs) || result.chunkMs <= 0) throw new Error('--chunk-ms must be positive')
  /* 测量方法学不变：线程数只是运行时候选配置，进入报告披露。 */
  if (!Number.isInteger(result.numThreads) || result.numThreads < 1 || result.numThreads > 16) {
    throw new Error('--num-threads must be an integer between 1 and 16')
  }
  return result
}

function sleep (milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)))
}

function findSpeechOnsetMs (samples, sampleRate) {
  const windowSamples = Math.max(1, Math.round(sampleRate * 0.02))
  const threshold = 10 ** (-45 / 20)
  let consecutive = 0
  for (let offset = 0; offset < samples.length; offset += windowSamples) {
    const end = Math.min(samples.length, offset + windowSamples)
    let energy = 0
    for (let index = offset; index < end; index += 1) energy += samples[index] * samples[index]
    const rms = Math.sqrt(energy / Math.max(1, end - offset))
    consecutive = rms >= threshold ? consecutive + 1 : 0
    if (consecutive >= 2) return (Math.max(0, offset - windowSamples) / sampleRate) * 1000
  }
  return null
}

function findModelFile (modelDir, preferredName, fallbackPattern) {
  const preferredPath = path.join(modelDir, preferredName)
  if (fs.existsSync(preferredPath)) return preferredPath
  const matches = fs.readdirSync(modelDir).filter((name) => fallbackPattern.test(name)).sort()
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one ${fallbackPattern} file in ${modelDir}, found ${matches.length}`)
  }
  return path.join(modelDir, matches[0])
}

function createRecognizer (modelDir, modelType, numThreads, requiredFiles = null) {
  if (modelType === 'paraformer' && !requiredFiles) {
    throw new Error('paraformer benchmarks require a registered candidate runtime profile')
  }
  const modelFiles = requiredFiles || {
    encoder: path.basename(findModelFile(modelDir, 'encoder.int8.onnx', /^encoder.*\.int8\.onnx$/)),
    decoder: path.basename(findModelFile(modelDir, 'decoder.onnx', /^decoder.*\.int8\.onnx$/)),
    joiner: path.basename(findModelFile(modelDir, 'joiner.int8.onnx', /^joiner.*\.int8\.onnx$/)),
    tokens: 'tokens.txt'
  }
  for (const fileName of Object.values(modelFiles)) {
    if (!fs.statSync(path.join(modelDir, fileName), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`candidate runtime file is missing: ${fileName}`)
    }
  }
  const architecture = modelType === 'paraformer'
    ? {
        paraformer: {
          encoder: path.join(modelDir, modelFiles.encoder),
          decoder: path.join(modelDir, modelFiles.decoder)
        }
      }
    : {
        transducer: {
          encoder: path.join(modelDir, modelFiles.encoder),
          decoder: path.join(modelDir, modelFiles.decoder),
          joiner: path.join(modelDir, modelFiles.joiner)
        }
      }
  return new sherpa.OnlineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      ...architecture,
      tokens: path.join(modelDir, modelFiles.tokens),
      numThreads,
      provider: 'cpu',
      modelType
    },
    decodingMethod: 'greedy_search',
    enableEndpoint: 0
  })
}

async function runStream (recognizer, wave, options) {
  const stream = recognizer.createStream()
  const chunkSamples = Math.max(1, Math.round((wave.sampleRate * options.chunkMs) / 1000))
  const onsetMs = findSpeechOnsetMs(wave.samples, wave.sampleRate)
  const startedAt = performance.now()
  let processingMs = 0
  let firstPartial = null
  let fedSamples = 0

  for (let offset = 0; offset < wave.samples.length; offset += chunkSamples) {
    const end = Math.min(wave.samples.length, offset + chunkSamples)
    if (options.pace) {
      const targetMs = (end / wave.sampleRate) * 1000
      await sleep(targetMs - (performance.now() - startedAt))
    }

    const processStarted = performance.now()
    stream.acceptWaveform({ samples: wave.samples.subarray(offset, end), sampleRate: wave.sampleRate })
    fedSamples = end
    while (recognizer.isReady(stream)) recognizer.decode(stream)
    const current = recognizer.getResult(stream)
    processingMs += performance.now() - processStarted

    if (firstPartial === null && current.text.trim().length > 0) {
      const wallFromStartMs = performance.now() - startedAt
      const audioFedMs = (fedSamples / wave.sampleRate) * 1000
      firstPartial = {
        text: current.text,
        wallFromStartMs,
        audioFedMs,
        latencyFromSpeechOnsetMs: !options.pace || onsetMs === null ? null : wallFromStartMs - onsetMs,
        audioNeededAfterSpeechOnsetMs: onsetMs === null ? null : audioFedMs - onsetMs
      }
    }
  }

  const tail = new Float32Array(Math.round(wave.sampleRate * 0.4))
  const tailStarted = performance.now()
  stream.acceptWaveform({ samples: tail, sampleRate: wave.sampleRate })
  stream.inputFinished()
  while (recognizer.isReady(stream)) recognizer.decode(stream)
  const result = recognizer.getResult(stream)
  processingMs += performance.now() - tailStarted

  return {
    firstPartial,
    finalText: result.text,
    processingMs,
    processingRtf: processingMs / ((wave.samples.length / wave.sampleRate) * 1000)
  }
}

async function main () {
  const options = parseArguments(process.argv.slice(2))
  const modelDir = path.resolve(options.modelDir)
  let candidate = null
  let candidateRegistrySha256 = null
  if (options.candidateRegistry) {
    const evidence = readAndValidateRealtimeCandidateRegistry(options.candidateRegistry)
    candidate = selectRealtimeCandidate(evidence.registry, options.candidateId)
    candidateRegistrySha256 = evidence.sha256
    if (path.basename(modelDir) !== candidate.runtime.directoryName) {
      throw new Error('candidate model directory does not match the registered directory name')
    }
    if ((options.modelTypeExplicit && options.modelType !== candidate.runtime.modelType) ||
        (options.numThreadsExplicit && options.numThreads !== candidate.runtime.numThreads)) {
      throw new Error('candidate runtime arguments differ from the registered profile')
    }
    options.modelType = candidate.runtime.modelType
    options.numThreads = candidate.runtime.numThreads
  }
  const modelLoadStarted = performance.now()
  const recognizer = createRecognizer(
    modelDir,
    options.modelType,
    options.numThreads,
    candidate?.runtime.requiredFiles || null
  )
  const modelLoadMs = performance.now() - modelLoadStarted
  const cases = []

  for (const wavPath of options.wavs) {
    const absoluteWav = path.resolve(wavPath)
    const wave = sherpa.readWave(absoluteWav)
    const runs = []
    for (let run = 0; run < options.runs; run += 1) {
      runs.push(await runStream(recognizer, wave, options))
    }
    const latencies = runs
      .map((item) => item.firstPartial && item.firstPartial.latencyFromSpeechOnsetMs)
      .filter((value) => Number.isFinite(value))
    cases.push({
      id: path.basename(absoluteWav, path.extname(absoluteWav)),
      wav: path.basename(absoluteWav),
      sampleRate: wave.sampleRate,
      samples: wave.samples.length,
      durationSeconds: wave.samples.length / wave.sampleRate,
      speechOnsetMs: findSpeechOnsetMs(wave.samples, wave.sampleRate),
      firstPartialLatencyMs: {
        p50: percentile(latencies, 0.5),
        p95: percentile(latencies, 0.95),
        samples: latencies
      },
      processingRtf: {
        p50: percentile(runs.map((item) => item.processingRtf), 0.5),
        p95: percentile(runs.map((item) => item.processingRtf), 0.95)
      },
      runs
    })
  }

  const report = {
    schemaVersion: 1,
    engine: 'sherpa-onnx-node',
    engineVersion: require('sherpa-onnx-node/package.json').version,
    model: path.basename(modelDir),
    modelType: options.modelType,
    numThreads: options.numThreads,
    chunkMs: options.chunkMs,
    paced: options.pace,
    runsPerCase: options.runs,
    modelLoadMs,
    candidateBinding: candidate
      ? {
          candidateId: candidate.id,
          candidateRegistrySha256,
          archiveBytes: candidate.archive.bytes,
          archiveSha256: candidate.archive.sha256,
          evaluationOnly: candidate.evaluationOnly,
          productionApproved: candidate.productionApproved
        }
      : null,
    cases
  }
  /* File and stdout share the same content-free projection. Captions are used
     only in memory to compute per-run digests. */
  const json = JSON.stringify(projectStreamingBenchReport(report), null, 2)
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true })
    fs.writeFileSync(path.resolve(options.output), json + '\n')
  } else {
    process.stdout.write(json + '\n')
  }
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error)
  process.exitCode = 1
})
