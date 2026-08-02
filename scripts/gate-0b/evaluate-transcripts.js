'use strict'

const fs = require('node:fs')
const path = require('node:path')

const {
  characterErrorRate,
  punctuationMetrics,
  wordErrorRate
} = require('./metrics')
const { projectEvaluation } = require('./evidence-projection')

function parseArguments (argv) {
  const options = { input: null, corpus: null, observations: null, xRun: 'x480-controlled', senseRun: 'sense-controlled', output: null }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    if (argv[index] === '--input') { options.input = value; index += 1 } else if (argv[index] === '--corpus') { options.corpus = value; index += 1 } else if (argv[index] === '--observations') { options.observations = value; index += 1 } else if (argv[index] === '--x-run') { options.xRun = value; index += 1 } else if (argv[index] === '--sense-run') { options.senseRun = value; index += 1 } else if (argv[index] === '--output') { options.output = value; index += 1 } else throw new Error(`Unknown argument: ${argv[index]}`)
  }
  if (!options.input && !(options.corpus && options.observations)) {
    throw new Error('provide --input, or both --corpus and --observations')
  }
  return options
}

function average (values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length
}

function evaluate (input) {
  if (!input || input.schemaVersion !== 1 || !Array.isArray(input.cases) || input.cases.length === 0) {
    throw new TypeError('input must contain a non-empty schemaVersion 1 cases array')
  }

  const cases = input.cases.map((item) => {
    for (const field of ['id', 'category', 'reference', 'xAsr', 'senseVoice']) {
      if (typeof item[field] !== 'string') throw new TypeError(`${item.id || 'case'}.${field} must be a string`)
    }
    const xCer = characterErrorRate(item.reference, item.xAsr)
    const refinedCer = characterErrorRate(item.reference, item.senseVoice)
    return {
      id: item.id,
      category: item.category,
      reference: item.reference,
      xAsr: {
        text: item.xAsr,
        cer: xCer,
        wer: item.category === 'en' ? wordErrorRate(item.reference, item.xAsr) : null,
        punctuation: punctuationMetrics(item.reference, item.xAsr)
      },
      senseVoice: {
        text: item.senseVoice,
        cer: refinedCer,
        wer: item.category === 'en' ? wordErrorRate(item.reference, item.senseVoice) : null,
        punctuation: punctuationMetrics(item.reference, item.senseVoice)
      },
      refinementCerDelta: xCer - refinedCer
    }
  })

  return {
    schemaVersion: 1,
    cases,
    aggregate: {
      xAsrMacroCer: average(cases.map((item) => item.xAsr.cer)),
      senseVoiceMacroCer: average(cases.map((item) => item.senseVoice.cer)),
      refinementMacroCerDelta: average(cases.map((item) => item.refinementCerDelta)),
      refinementImprovedCases: cases.filter((item) => item.refinementCerDelta > 0).length,
      refinementRegressedCases: cases.filter((item) => item.refinementCerDelta < 0).length,
      xAsrMacroPunctuationF1: average(cases.map((item) => item.xAsr.punctuation.f1)),
      senseVoiceMacroPunctuationF1: average(cases.map((item) => item.senseVoice.punctuation.f1))
    }
  }
}

function inputFromObservations (corpus, observations, xRunId, senseRunId) {
  const xRun = observations.runs.find((run) => run.id === xRunId)
  const senseRun = observations.runs.find((run) => run.id === senseRunId)
  if (!xRun || !senseRun) throw new Error(`Missing observation run ${!xRun ? xRunId : senseRunId}`)
  const byWav = (run) => new Map(run.samples.map((sample) => [sample.wav, sample.text]))
  const xSamples = byWav(xRun)
  const senseSamples = byWav(senseRun)
  return {
    schemaVersion: 1,
    cases: corpus.cases.map((item) => {
      const wav = `${item.id}.wav`
      if (!xSamples.has(wav) || !senseSamples.has(wav)) throw new Error(`Missing transcript for ${wav}`)
      return {
        id: item.id,
        category: item.category,
        reference: item.reference,
        xAsr: xSamples.get(wav),
        senseVoice: senseSamples.get(wav)
      }
    })
  }
}

function main () {
  const options = parseArguments(process.argv.slice(2))
  const input = options.input
    ? JSON.parse(fs.readFileSync(path.resolve(options.input), 'utf8'))
    : inputFromObservations(
        JSON.parse(fs.readFileSync(path.resolve(options.corpus), 'utf8')),
        JSON.parse(fs.readFileSync(path.resolve(options.observations), 'utf8')),
        options.xRun,
        options.senseRun
      )
  const report = projectEvaluation(evaluate(input))
  const json = JSON.stringify(report, null, 2) + '\n'
  if (options.output) {
    fs.mkdirSync(path.dirname(path.resolve(options.output)), { recursive: true })
    fs.writeFileSync(path.resolve(options.output), json)
  } else {
    process.stdout.write(json)
  }
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
}

module.exports = { evaluate, inputFromObservations }
