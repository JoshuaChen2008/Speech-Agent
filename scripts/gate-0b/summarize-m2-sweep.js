'use strict'

/* M2 参数扫描 + M4 补测的 tracked 摘要生成器。
     node scripts/gate-0b/summarize-m2-sweep.js `
       --sweep-dir models/gate-0b/runs/m2-sweep `
       --output docs/validation/gate-0b-m2-sweep.json
   当前扫描输出已在生成处投影为只含 ID、数字与哈希；本脚本再提取
   re-judgment 判定所需的数字（RTF、首 partial P95、audioNeeded），并以
   rawOutputSha256 / 逐 case 数值保持同轮绑定。输出必须 path-free。
   160ms-t4-c40.json 是 M4 re-judgment 期间补测的 x160@t4 全语料首 partial
   基准（streaming-bench.js 同方法学），存在时并入摘要。 */

const fs = require('node:fs')
const path = require('node:path')

const X480_THREAD_CONFIGS = [3, 4, 6]

function parseArguments (argv) {
  const options = { sweepDir: null, output: null }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    if (argv[index] === '--sweep-dir') { options.sweepDir = value; index += 1 } else if (argv[index] === '--output') { options.output = value; index += 1 } else throw new Error(`Unknown argument: ${argv[index]}`)
  }
  if (!options.sweepDir || !options.output) throw new Error('--sweep-dir and --output are required')
  return options
}

function summarizeX160 (sweep) {
  return {
    model: sweep.model,
    provider: sweep.provider,
    runs: sweep.runs.map((run) => ({
      id: run.id,
      numThreads: run.numThreads,
      sampleRtf: run.samples.map((sample) => sample.rtf),
      maxRtf: Math.max(...run.samples.map((sample) => sample.rtf)),
      rawOutputSha256: run.rawOutputSha256
    }))
  }
}

function summarizeX480 (bench) {
  return {
    numThreads: bench.numThreads,
    cases: bench.cases.map((item) => ({
      id: item.id,
      firstPartialLatencyP50Ms: item.firstPartialLatencyMs.p50,
      firstPartialLatencyP95Ms: item.firstPartialLatencyMs.p95,
      audioNeededAfterSpeechOnsetMsMax: Math.max(...item.runs.map((run) => run.firstPartial.audioNeededAfterSpeechOnsetMs))
    }))
  }
}

function main () {
  const options = parseArguments(process.argv.slice(2))
  const sweepDir = path.resolve(options.sweepDir)

  const threadSweep = JSON.parse(fs.readFileSync(path.join(sweepDir, 'x160-cli-threads.json'), 'utf8'))
  const benches = X480_THREAD_CONFIGS.map((threads) =>
    JSON.parse(fs.readFileSync(path.join(sweepDir, `480ms-t${threads}-c40.json`), 'utf8')))
  const x160BenchPath = path.join(sweepDir, '160ms-t4-c40.json')
  const x160Bench = fs.existsSync(x160BenchPath) ? JSON.parse(fs.readFileSync(x160BenchPath, 'utf8')) : null

  const summary = {
    schemaVersion: 1,
    kind: 'gate-0b-m2-sweep-summary',
    sourceReport: 'gate-0b-m2-sweep.md',
    reproduce: '../../scripts/gate-0b/README.md',
    note: 'Sweep outputs are content-free; this summary stays path-free and binds each CLI run by rawOutputSha256.',
    x160CliThreadSweep: summarizeX160(threadSweep),
    x480FirstPartialSweep: {
      model: benches[0].model,
      engine: benches[0].engine,
      engineVersion: benches[0].engineVersion,
      chunkMs: benches[0].chunkMs,
      paced: benches[0].paced,
      runsPerCase: benches[0].runsPerCase,
      configs: benches.map((bench) => summarizeX480(bench))
    }
  }
  if (x160Bench) {
    summary.x160FirstPartialBench = {
      measuredDuring: 'M4 re-judgment (2026-07-27)',
      model: x160Bench.model,
      engine: x160Bench.engine,
      engineVersion: x160Bench.engineVersion,
      chunkMs: x160Bench.chunkMs,
      paced: x160Bench.paced,
      runsPerCase: x160Bench.runsPerCase,
      numThreads: x160Bench.numThreads,
      cases: summarizeX480(x160Bench).cases
    }
  }

  const outputPath = path.resolve(options.output)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2) + '\n')
  console.log(`wrote ${path.basename(outputPath)}: x160 runs=${summary.x160CliThreadSweep.runs.length}, x480 configs=${summary.x480FirstPartialSweep.configs.length}`)
}

try {
  main()
} catch (error) {
  console.error(error && error.stack ? error.stack : error)
  process.exitCode = 1
}
