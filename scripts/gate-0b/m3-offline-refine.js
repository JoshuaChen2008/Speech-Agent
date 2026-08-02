'use strict'

/* M3 精修候选评估：离线 X-ASR（同家族非流式）对照 SenseVoice 的替换评估。
     node scripts/gate-0b/m3-offline-refine.js `
       --asset-root models/gate-0b `
       --observations models/gate-0b/private/cli-observations.json `
       --sweep models/gate-0b/private/m2-sweep/x160-cli-threads.json `
       --output models/gate-0b/runs/m3/m3-evaluation.json
   评估器复用冻结的 evaluate-transcripts（CER/WER/标点 F1 与净收益口径不变）；
   其输出字段名 senseVoice 在本评估中承载「精修候选 = 离线 X-ASR」。
   基线取两条：x480-controlled（原默认档）与 x160-controlled-t4（M2 最优配置），
   附带 SenseVoice 原评估口径的对照可直接来自 gate-0b-controlled-metrics.json。 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')

const { evaluate, inputFromObservations } = require('./evaluate-transcripts')
const { projectM3Report } = require('./evidence-projection')

const OFFLINE_MODEL_DIR = ['extracted', 'x-asr-offline', 'sherpa-onnx-x-asr-zipformer-transducer-zh-en-punct-int8-2026-06-03']
const CONTROLLED = ['zh-roadmap', 'en-onboarding', 'zh-en-code-switch', 'zh-date-itn']
const OFFLINE_RUN_ID = 'x-asr-offline-controlled'

function parseArguments (argv) {
  const options = {
    assetRoot: null,
    observations: null,
    sweep: null,
    numThreads: 3,
    output: null
  }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    if (argv[index] === '--asset-root') { options.assetRoot = value; index += 1 } else if (argv[index] === '--observations') { options.observations = value; index += 1 } else if (argv[index] === '--sweep') { options.sweep = value; index += 1 } else if (argv[index] === '--num-threads') { options.numThreads = Number(value); index += 1 } else if (argv[index] === '--output') { options.output = value; index += 1 } else throw new Error(`Unknown argument: ${argv[index]}`)
  }
  if (!options.assetRoot || !options.observations || !options.output) {
    throw new Error('--asset-root, --observations and --output are required')
  }
  if (!Number.isInteger(options.numThreads) || options.numThreads < 1 || options.numThreads > 16) {
    throw new Error('--num-threads must be an integer between 1 and 16')
  }
  return options
}

/* 批量模式输出解析：stdout 是按传入顺序的结果 JSON 行，stderr 是聚合
   Elapsed/RTF（与 SenseVoice 原评估同构，聚合 RTF 口径一致）。 */
function parseOfflineTransducerOutput (output, expectedWavs) {
  const rtfMatch = output.match(/Real time factor \(RTF\):\s*([0-9.]+)\s*\/\s*([0-9.]+)\s*=\s*([0-9.]+)/)
  const results = [...output.matchAll(/^(\{"lang":.*\})\r?$/gm)].map((match) => JSON.parse(match[1]))
  if (!rtfMatch || results.length !== expectedWavs.length) {
    throw new Error(`Could not parse offline output: ${results.length} results for ${expectedWavs.length} WAV files`)
  }
  return {
    elapsedSeconds: Number(rtfMatch[1]),
    durationSeconds: Number(rtfMatch[2]),
    rtf: Number(rtfMatch[3]),
    samples: expectedWavs.map((wav, index) => ({ wav: path.basename(wav), text: results[index].text }))
  }
}

function runOfflineTransducer (options) {
  const root = path.resolve(options.assetRoot)
  const cliBin = path.join(root, 'extracted', 'cli', 'sherpa-onnx-v1.13.4-win-x64-shared-MD-Release', 'bin')
  const modelDir = path.join(root, ...OFFLINE_MODEL_DIR)
  const wavs = CONTROLLED.map((name) => path.join(root, 'corpus', `${name}.wav`))
  const args = [
    `--tokens=${path.join(modelDir, 'tokens.txt')}`,
    `--encoder=${path.join(modelDir, 'encoder-epoch-99-avg-1.int8.onnx')}`,
    `--decoder=${path.join(modelDir, 'decoder-epoch-99-avg-1.onnx')}`,
    `--joiner=${path.join(modelDir, 'joiner-epoch-99-avg-1.int8.onnx')}`,
    `--num-threads=${options.numThreads}`,
    '--provider=cpu',
    '--print-args=false',
    ...wavs
  ]
  const child = spawnSync(path.join(cliBin, 'sherpa-onnx-offline.exe'), args, {
    cwd: cliBin,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true
  })
  if (child.error) throw child.error
  if (child.status !== 0) throw new Error(`sherpa-onnx-offline exited with ${child.status}`)
  const rawOutput = [child.stdout, child.stderr].filter(Boolean).join('\n')
  const parsed = parseOfflineTransducerOutput(rawOutput, wavs)
  return {
    run: {
      id: OFFLINE_RUN_ID,
      mode: 'offline-transducer',
      numThreads: options.numThreads,
      model: path.basename(modelDir),
      rawOutputSha256: crypto.createHash('sha256').update(rawOutput, 'utf8').digest('hex'),
      elapsedSeconds: parsed.elapsedSeconds,
      durationSeconds: parsed.durationSeconds,
      rtf: parsed.rtf,
      samples: parsed.samples
    },
    rawOutput
  }
}

function main () {
  const options = parseArguments(process.argv.slice(2))
  const root = path.resolve(options.assetRoot)
  const corpus = JSON.parse(fs.readFileSync(path.join(root, '..', '..', 'scripts', 'gate-0b', 'corpus.json'), 'utf8'))
  const observations = JSON.parse(fs.readFileSync(path.resolve(options.observations), 'utf8'))

  const offline = runOfflineTransducer(options)
  const runs = [...observations.runs, offline.run]
  if (options.sweep) {
    const sweep = JSON.parse(fs.readFileSync(path.resolve(options.sweep), 'utf8'))
    runs.push(...sweep.runs)
  }
  const merged = { ...observations, runs }

  const baselines = ['x480-controlled']
  if (options.sweep) baselines.push('x160-controlled-t4')
  const evaluations = {}
  for (const baseline of baselines) {
    evaluations[baseline] = evaluate(inputFromObservations(corpus, merged, baseline, OFFLINE_RUN_ID))
  }

  const report = {
    schemaVersion: 1,
    kind: 'gate-0b-m3-offline-refinement',
    generatedAt: new Date().toISOString(),
    refinementCandidate: {
      runId: OFFLINE_RUN_ID,
      model: offline.run.model,
      numThreads: offline.run.numThreads,
      aggregateRtf: offline.run.rtf,
      elapsedSeconds: offline.run.elapsedSeconds,
      durationSeconds: offline.run.durationSeconds
    },
    note: 'evaluate-transcripts 的 senseVoice 字段在本报告中承载精修候选（离线 X-ASR）',
    evaluations
  }

  const outputPath = path.resolve(options.output)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(projectM3Report(report), null, 2) + '\n')

  for (const [baseline, evaluation] of Object.entries(evaluations)) {
    const aggregate = evaluation.aggregate
    console.log(`baseline=${baseline}`)
    console.log(`  realtime macroCER=${aggregate.xAsrMacroCer.toFixed(4)} -> refined macroCER=${aggregate.senseVoiceMacroCer.toFixed(4)} (delta ${aggregate.refinementMacroCerDelta.toFixed(4)})`)
    console.log(`  improved=${aggregate.refinementImprovedCases} regressed=${aggregate.refinementRegressedCases}`)
    console.log(`  punctF1 realtime=${aggregate.xAsrMacroPunctuationF1.toFixed(4)} -> refined=${aggregate.senseVoiceMacroPunctuationF1.toFixed(4)}`)
  }
  console.log(`refine aggregateRtf=${report.refinementCandidate.aggregateRtf} (${report.refinementCandidate.elapsedSeconds}s / ${report.refinementCandidate.durationSeconds}s)`)
}

try {
  main()
} catch (error) {
  console.error(error && error.stack ? error.stack : error)
  process.exitCode = 1
}
