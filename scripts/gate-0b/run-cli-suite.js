'use strict'

const fs = require('node:fs')
const path = require('node:path')

const { runOnline, runSenseVoice } = require('./cli-bench')

function parseArguments (argv) {
  const options = { assetRoot: null, output: null, rawDir: null }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    if (argv[index] === '--asset-root') { options.assetRoot = value; index += 1 } else if (argv[index] === '--output') { options.output = value; index += 1 } else if (argv[index] === '--raw-dir') { options.rawDir = value; index += 1 } else throw new Error(`Unknown argument: ${argv[index]}`)
  }
  if (!options.assetRoot || !options.output) throw new Error('--asset-root and --output are required')
  return options
}

function files (directory, names) {
  return Object.fromEntries(Object.entries(names).map(([key, name]) => [key, path.join(directory, name)]))
}

function wavs (directory, names) {
  return names.map((name) => path.join(directory, `${name}.wav`))
}

function main () {
  const options = parseArguments(process.argv.slice(2))
  const root = path.resolve(options.assetRoot)
  const cliBin = path.join(root, 'extracted', 'cli', 'sherpa-onnx-v1.13.4-win-x64-shared-MD-Release', 'bin')
  const x480 = path.join(root, 'extracted', 'x-asr', 'sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05')
  const x160 = path.join(root, 'extracted', 'x-asr-160', 'sherpa-onnx-x-asr-160ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05')
  const small = path.join(root, 'extracted', 'small-bilingual', 'sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16')
  const sense = path.join(root, 'extracted', 'sense-voice', 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2025-09-09')
  const corpus = path.join(root, 'corpus')
  const controlledNames = ['zh-roadmap', 'en-onboarding', 'zh-en-code-switch', 'zh-date-itn']
  const numThreads = 3

  const online = [
    {
      id: 'x480-official', modelDir: x480,
      modelNames: { tokens: 'tokens.txt', encoder: 'encoder.int8.onnx', decoder: 'decoder.onnx', joiner: 'joiner.int8.onnx' },
      wavs: wavs(path.join(x480, 'test_wavs'), ['0', '1', '2', '3'])
    },
    {
      id: 'x480-controlled', modelDir: x480,
      modelNames: { tokens: 'tokens.txt', encoder: 'encoder.int8.onnx', decoder: 'decoder.onnx', joiner: 'joiner.int8.onnx' },
      wavs: wavs(corpus, controlledNames)
    },
    {
      id: 'x160-official', modelDir: x160,
      modelNames: { tokens: 'tokens.txt', encoder: 'encoder.int8.onnx', decoder: 'decoder.onnx', joiner: 'joiner.int8.onnx' },
      wavs: wavs(path.join(x160, 'test_wavs'), ['0', '1', '2', '3'])
    },
    {
      id: 'small-official', modelDir: small,
      modelNames: { tokens: 'tokens.txt', encoder: 'encoder-epoch-99-avg-1.int8.onnx', decoder: 'decoder-epoch-99-avg-1.int8.onnx', joiner: 'joiner-epoch-99-avg-1.int8.onnx' },
      wavs: wavs(path.join(small, 'test_wavs'), ['0', '1', '2', '3', '4', '46'])
    },
    {
      id: 'small-controlled', modelDir: small,
      modelNames: { tokens: 'tokens.txt', encoder: 'encoder-epoch-99-avg-1.int8.onnx', decoder: 'decoder-epoch-99-avg-1.int8.onnx', joiner: 'joiner-epoch-99-avg-1.int8.onnx' },
      wavs: wavs(corpus, ['zh-en-code-switch'])
    }
  ].map((item) => ({
    id: item.id,
    cliBin,
    numThreads,
    model: files(item.modelDir, item.modelNames),
    wavs: item.wavs
  }))

  const runs = []
  const raw = []
  for (const config of online) {
    const result = runOnline(config)
    runs.push(result.report)
    raw.push({ id: config.id, output: result.rawOutput })
  }

  const senseResult = runSenseVoice({
    id: 'sense-controlled',
    cliBin,
    numThreads,
    model: files(sense, { tokens: 'tokens.txt', model: 'model.int8.onnx' }),
    wavs: wavs(corpus, controlledNames)
  })
  runs.push(senseResult.report)
  raw.push({ id: 'sense-controlled', output: senseResult.rawOutput })

  const version = require('node:child_process').spawnSync(path.join(cliBin, 'sherpa-onnx-version.exe'), [], { cwd: cliBin, encoding: 'utf8', windowsHide: true })
  if (version.status !== 0) throw new Error('sherpa-onnx-version.exe failed')
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    cliVersionOutput: version.stdout.trim(),
    provider: 'cpu',
    numThreads,
    runs
  }

  const outputPath = path.resolve(options.output)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n')

  if (options.rawDir) {
    const rawDirectory = path.resolve(options.rawDir)
    fs.mkdirSync(rawDirectory, { recursive: true })
    for (const item of raw) fs.writeFileSync(path.join(rawDirectory, `${item.id}.log`), item.output)
  }
}

try {
  main()
} catch (error) {
  console.error(error && error.stack ? error.stack : error)
  process.exitCode = 1
}
