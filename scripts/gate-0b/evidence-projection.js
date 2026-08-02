'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

function sha256 (value) {
  const bytes = typeof value === 'string' ? value : JSON.stringify(value)
  return crypto.createHash('sha256').update(bytes, 'utf8').digest('hex')
}

function caseIdFromAudioName (value) {
  if (typeof value !== 'string' || !/\.wav$/i.test(value)) throw new TypeError('sample audio name must end in .wav')
  return path.basename(value).replace(/\.wav$/i, '')
}

function projectSample (sample) {
  if (!sample || typeof sample !== 'object' || typeof sample.text !== 'string' || !sample.result) {
    throw new TypeError('sample must include in-memory text and parsed result before projection')
  }
  const { wav, text, result, ...metrics } = sample
  return {
    caseId: caseIdFromAudioName(wav),
    ...metrics,
    transcriptSha256: sha256(text),
    resultSha256: sha256(result)
  }
}

function projectObservationReport (report) {
  if (!report || report.schemaVersion !== 1 || !Array.isArray(report.runs)) {
    throw new TypeError('raw Gate 0B observations must use schemaVersion 1')
  }
  return {
    ...report,
    schemaVersion: 2,
    runs: report.runs.map((run) => ({
      ...run,
      samples: run.samples.map(projectSample)
    })),
    privacy: {
      audioFileNamePersisted: false,
      transcriptTextPersisted: false
    }
  }
}

function projectCandidateMetrics (candidate) {
  if (!candidate || typeof candidate.text !== 'string') throw new TypeError('candidate metrics must include in-memory text before projection')
  const { text, ...metrics } = candidate
  return { ...metrics, transcriptSha256: sha256(text) }
}

function projectEvaluation (evaluation) {
  if (!evaluation || evaluation.schemaVersion !== 1 || !Array.isArray(evaluation.cases)) {
    throw new TypeError('raw Gate 0B evaluation must use schemaVersion 1')
  }
  return {
    ...evaluation,
    schemaVersion: 2,
    cases: evaluation.cases.map((item) => {
      if (typeof item.reference !== 'string') throw new TypeError('evaluation case must include an in-memory reference before projection')
      return {
        id: item.id,
        category: item.category,
        referenceSha256: sha256(item.reference),
        xAsr: projectCandidateMetrics(item.xAsr),
        senseVoice: projectCandidateMetrics(item.senseVoice),
        refinementCerDelta: item.refinementCerDelta
      }
    }),
    privacy: {
      transcriptTextPersisted: false
    }
  }
}

function projectM3Report (report) {
  if (!report || report.schemaVersion !== 1 || !report.evaluations) {
    throw new TypeError('raw Gate 0B M3 report must use schemaVersion 1')
  }
  return {
    ...report,
    schemaVersion: 2,
    evaluations: Object.fromEntries(
      Object.entries(report.evaluations).map(([id, evaluation]) => [id, projectEvaluation(evaluation)])
    ),
    privacy: {
      transcriptTextPersisted: false
    }
  }
}

function projectStreamingRun (run) {
  if (!run || typeof run !== 'object' || typeof run.finalText !== 'string') {
    throw new TypeError('streaming run must include in-memory finalText before projection')
  }
  const { firstPartial, finalText, ...metrics } = run
  let projectedFirstPartial = null
  if (firstPartial !== null) {
    if (!firstPartial || typeof firstPartial !== 'object' || typeof firstPartial.text !== 'string') {
      throw new TypeError('streaming firstPartial must be null or include in-memory text before projection')
    }
    const { text, ...partialMetrics } = firstPartial
    projectedFirstPartial = { ...partialMetrics, transcriptSha256: sha256(text) }
  }
  return {
    ...metrics,
    firstPartial: projectedFirstPartial,
    finalTranscriptSha256: sha256(finalText)
  }
}

function projectStreamingBenchReport (report) {
  if (!report || report.schemaVersion !== 1 || !Array.isArray(report.cases)) {
    throw new TypeError('raw streaming benchmark must use schemaVersion 1 with cases')
  }
  return {
    ...report,
    schemaVersion: 2,
    cases: report.cases.map((item) => {
      if (!item || typeof item !== 'object' || typeof item.id !== 'string' || !Array.isArray(item.runs)) {
        throw new TypeError('streaming case must include an id and runs')
      }
      const { wav, runs, ...metrics } = item
      return { ...metrics, runs: runs.map(projectStreamingRun) }
    }),
    privacy: {
      audioFileNamePersisted: false,
      transcriptTextPersisted: false
    }
  }
}

function projectFileInPlace (file, projector) {
  const absolute = path.resolve(file)
  const source = JSON.parse(fs.readFileSync(absolute, 'utf8'))
  fs.writeFileSync(absolute, JSON.stringify(projector(source), null, 2) + '\n')
}

function main (argv) {
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!value || !['--observations', '--metrics', '--m3'].includes(name)) throw new Error('provide --observations, --metrics and --m3 paths')
    options[name.slice(2)] = value
  }
  if (!options.observations || !options.metrics || !options.m3) throw new Error('provide --observations, --metrics and --m3 paths')
  projectFileInPlace(options.observations, projectObservationReport)
  projectFileInPlace(options.metrics, projectEvaluation)
  projectFileInPlace(options.m3, projectM3Report)
}

module.exports = {
  projectEvaluation,
  projectM3Report,
  projectObservationReport,
  projectStreamingBenchReport,
  sha256
}

if (require.main === module) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error?.stack || error)
    process.exitCode = 1
  }
}
