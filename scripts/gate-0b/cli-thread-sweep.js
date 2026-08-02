'use strict'

/* M2 线程扫描（Gate 0B 复测辅助）：
     node scripts/gate-0b/cli-thread-sweep.js `
       --asset-root models/gate-0b `
       --model x160 --threads 3,4,6 --wav-set both `
       --private-transcript-output models/gate-0b/private/m2-sweep/x160-cli-threads.json `
       --output models/gate-0b/runs/m2-sweep/x160-cli-threads.json
   复用 cli-bench 的官方 CLI 调用（Gate 0B 的选择级 RTF 权威来源），只把
   numThreads 作为运行时候选配置展开；测量方法学（CLI、语料、解析）不变，
   线程数逐条披露在结果里。不修改冻结的 run-cli-suite.js。 */

const fs = require('node:fs')
const path = require('node:path')
const { runOnline } = require('./cli-bench')
const { projectObservationReport } = require('./evidence-projection')
const { resolvePrivateTranscriptOutputPath } = require('./private-output-policy')

const MODELS = {
  x480: {
    dir: ['extracted', 'x-asr', 'sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05'],
    files: { tokens: 'tokens.txt', encoder: 'encoder.int8.onnx', decoder: 'decoder.onnx', joiner: 'joiner.int8.onnx' }
  },
  x160: {
    dir: ['extracted', 'x-asr-160', 'sherpa-onnx-x-asr-160ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05'],
    files: { tokens: 'tokens.txt', encoder: 'encoder.int8.onnx', decoder: 'decoder.onnx', joiner: 'joiner.int8.onnx' }
  }
}
const CONTROLLED = ['zh-roadmap', 'en-onboarding', 'zh-en-code-switch', 'zh-date-itn']

function parseArguments (argv) {
  const options = { assetRoot: null, model: 'x160', threads: [3, 4, 6], wavSet: 'both', output: null, privateTranscriptOutput: null }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    if (argv[index] === '--asset-root') { options.assetRoot = value; index += 1 } else if (argv[index] === '--model') { options.model = value; index += 1 } else if (argv[index] === '--threads') { options.threads = String(value).split(',').map(Number); index += 1 } else if (argv[index] === '--wav-set') { options.wavSet = value; index += 1 } else if (argv[index] === '--output') { options.output = value; index += 1 } else if (argv[index] === '--private-transcript-output') { options.privateTranscriptOutput = value; index += 1 } else throw new Error(`Unknown argument: ${argv[index]}`)
  }
  if (!options.assetRoot || !options.output) throw new Error('--asset-root and --output are required')
  if (!MODELS[options.model]) throw new Error(`--model must be one of: ${Object.keys(MODELS).join(', ')}`)
  if (!['official', 'controlled', 'both'].includes(options.wavSet)) throw new Error('--wav-set must be official|controlled|both')
  if (options.threads.some((n) => !Number.isInteger(n) || n < 1 || n > 16)) throw new Error('--threads must be integers 1..16')
  return options
}

function main () {
  const options = parseArguments(process.argv.slice(2))
  const privateTranscriptPath = options.privateTranscriptOutput
    ? resolvePrivateTranscriptOutputPath(options.privateTranscriptOutput)
    : null
  const root = path.resolve(options.assetRoot)
  const cliBin = path.join(root, 'extracted', 'cli', 'sherpa-onnx-v1.13.4-win-x64-shared-MD-Release', 'bin')
  const spec = MODELS[options.model]
  const modelDir = path.join(root, ...spec.dir)
  const model = Object.fromEntries(Object.entries(spec.files).map(([key, name]) => [key, path.join(modelDir, name)]))

  const wavSets = []
  if (options.wavSet !== 'controlled') {
    wavSets.push({ id: 'official', wavs: ['0', '1', '2', '3'].map((n) => path.join(modelDir, 'test_wavs', `${n}.wav`)) })
  }
  if (options.wavSet !== 'official') {
    wavSets.push({ id: 'controlled', wavs: CONTROLLED.map((n) => path.join(root, 'corpus', `${n}.wav`)) })
  }

  const runs = []
  for (const threads of options.threads) {
    for (const wavSet of wavSets) {
      const result = runOnline({
        id: `${options.model}-${wavSet.id}-t${threads}`,
        cliBin,
        numThreads: threads,
        model,
        wavs: wavSet.wavs
      })
      const rtfs = result.report.samples.map((sample) => sample.rtf)
      runs.push({
        ...result.report,
        rtfMax: Math.max(...rtfs),
        rtfMean: Number((rtfs.reduce((sum, value) => sum + value, 0) / rtfs.length).toFixed(4))
      })
      console.log(`${result.report.id}: rtf per wav = ${rtfs.map((value) => value.toFixed(3)).join(', ')} (max ${Math.max(...rtfs).toFixed(3)})`)
    }
  }

  const report = {
    schemaVersion: 1,
    kind: 'gate-0b-m2-thread-sweep',
    generatedAt: new Date().toISOString(),
    model: path.basename(modelDir),
    provider: 'cpu',
    runs
  }
  const outputPath = path.resolve(options.output)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(projectObservationReport(report), null, 2) + '\n')
  if (privateTranscriptPath) {
    fs.mkdirSync(path.dirname(privateTranscriptPath), { recursive: true })
    fs.writeFileSync(privateTranscriptPath, JSON.stringify(report, null, 2) + '\n')
  }
}

try {
  main()
} catch (error) {
  console.error(error && error.stack ? error.stack : error)
  process.exitCode = 1
}
