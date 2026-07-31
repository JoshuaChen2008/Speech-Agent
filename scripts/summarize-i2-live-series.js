'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { percentile } = require('./gate-0b/metrics')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')
const {
  ZERO_TRANSPORT_KEYS,
  assertGate0CBinding,
  deriveGate0CBinding,
  validateI2LiveReport
} = require('./verify-i2-live-report')

const LOOPBACK_SERIES_LIMITATIONS = Object.freeze([
  'Runs use one Windows host and one controlled corpus; they are not a cross-hardware benchmark.',
  'Device change, sleep/wake and user-driven window dragging remain separate I2 acceptance scenarios.'
])

const MIC_SERIES_LIMITATIONS = Object.freeze([
  'Runs use one fixed physical-preferred label-heuristic acoustic fixture; they do not attest hardware class or generalize acoustic quality.',
  'Device unplug/replug, sleep/wake and user-driven window dragging remain separate I2 acceptance scenarios.'
])

function parseArguments (argv) {
  const options = { output: null, source: null, minimumRuns: 5, gate0cReport: null, reports: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    if (argv[index] === '--output') { options.output = value; index += 1 } else if (argv[index] === '--source') {
      options.source = value; index += 1
    } else if (argv[index] === '--minimum-runs') {
      options.minimumRuns = Number(value); index += 1
    } else if (argv[index] === '--gate-0c-report') {
      options.gate0cReport = value; index += 1
    } else options.reports.push(argv[index])
  }
  if (!['loopback', 'mic'].includes(options.source)) throw new Error('--source must be loopback or mic')
  if (typeof options.output !== 'string' || options.output.length === 0) throw new Error('--output is required')
  if (options.minimumRuns !== 5) throw new Error('--minimum-runs must be exactly 5 for authoritative I2 evidence')
  if (options.reports.length !== 5) throw new Error('exactly 5 report paths are required')
  if (options.source === 'mic' && (typeof options.gate0cReport !== 'string' || options.gate0cReport.length === 0)) {
    throw new Error('--gate-0c-report is required for mic series')
  }
  if (options.source === 'loopback' && options.gate0cReport !== null) throw new Error('--gate-0c-report is only valid for mic series')
  return options
}

function distribution (values) {
  assert.ok(values.length > 0)
  return {
    p50: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    min: Math.min(...values),
    max: Math.max(...values)
  }
}

function sha256 (bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function normalizeBytes (input, label) {
  const value = Buffer.isBuffer(input) ? input : input?.bytes
  assert.ok(Buffer.isBuffer(value), `${label} must provide exact report bytes`)
  return value
}

function readGate0CBinding (gateReportBytes) {
  const bytes = normalizeBytes(gateReportBytes, 'Gate 0C evidence')
  return deriveGate0CBinding(bytes)
}

function summarizeI2LiveSeries (inputs, sourceId, minimumRuns = 5, gateReportBytes = null) {
  assert.ok(['loopback', 'mic'].includes(sourceId), 'sourceId must be loopback or mic')
  assert.equal(minimumRuns, 5, 'authoritative I2 evidence requires exactly five runs')
  assert.ok(Array.isArray(inputs) && inputs.length === 5, 'exactly five child reports are required')
  const binding = sourceId === 'mic' ? readGate0CBinding(gateReportBytes) : null
  assert.equal(sourceId === 'loopback' ? gateReportBytes : null, null, 'loopback series must not accept Gate 0C evidence')

  const reports = inputs.map((input, index) => {
    const bytes = normalizeBytes(input, `report ${index + 1}`)
    const report = parseStrictEvidenceJson(bytes, `I2 ${sourceId} child ${index + 1}`)
    validateI2LiveReport(report, sourceId)
    if (sourceId === 'mic') assertGate0CBinding(report, binding)
    else assert.equal(report.stimulus.kind, 'controlled-playback', 'loopback series requires controlled playback')
    return { reportSha256: sha256(bytes), report }
  }).sort((left, right) => {
    const byTime = Date.parse(left.report.executedAt) - Date.parse(right.report.executedAt)
    return byTime || left.reportSha256.localeCompare(right.reportSha256)
  })

  assert.equal(new Set(reports.map((run) => run.reportSha256)).size, reports.length, 'series child reports must be byte-distinct')
  assert.equal(new Set(reports.map((run) => run.report.executedAt)).size, reports.length, 'series child timestamps must be distinct')
  const runs = reports.map((run, index) => ({ ordinal: index + 1, ...run }))
  const values = (selector) => runs.map((run) => selector(run.report))
  const maxima = {
    finalCer: Math.max(...values((report) => report.accuracy.finalCer)),
    refinedCer: Math.max(...values((report) => report.accuracy.refinedCer))
  }
  for (const key of ZERO_TRANSPORT_KEYS) maxima[key] = Math.max(...values((report) => report.transport[key]))

  return {
    schemaVersion: 4,
    kind: 'i2-live-caption-series',
    generatedAt: new Date(Math.max(...values((report) => Date.parse(report.executedAt)))).toISOString(),
    sourceId,
    result: 'pass',
    runCount: runs.length,
    criteria: {
      minimumRuns,
      everyRunPassedSchema4: true,
      everyRunLossless: true,
      finalCerMax: 0.3,
      refinedCerMax: 0.3,
      latencyClassification: 'observed-series; release threshold remains governed by the frozen Gate 0B speech-onset criterion'
    },
    fixture: binding === null
      ? null
      : {
          classification: 'physical-preferred-label-heuristic',
          gate0cReportSha256: binding.reportSha256,
          gate0cRunId: binding.runId,
          gate0cExecutedAt: binding.executedAt,
          microphoneLabelSha256: binding.microphoneLabelSha256,
          speakerLabelSha256: binding.speakerLabelSha256
        },
    distributions: {
      firstPartialFromStimulusStartMs: distribution(values((report) => report.timings.firstPartialFromStimulusStartMs)),
      firstPartialFromEstimatedSpeechOnsetMs: distribution(values((report) => report.timings.firstPartialFromEstimatedSpeechOnsetMs)),
      firstFinalAfterStimulusEndMs: distribution(values((report) => report.timings.firstFinalAfterStimulusEndMs)),
      cpuP95Percent: distribution(values((report) => report.resources.cpuPercent.p95)),
      workingSetMaxMiB: distribution(values((report) => report.resources.workingSetMiB.max)),
      capturedFrames: distribution(values((report) => report.transport.capturedFrames))
    },
    maxima,
    runs,
    privacy: {
      capturedAudioPersisted: false,
      reportContainsTranscriptText: false,
      reportContainsAudioPath: false,
      reportContainsInputPaths: false
    },
    limitations: sourceId === 'mic' ? [...MIC_SERIES_LIMITATIONS] : [...LOOPBACK_SERIES_LIMITATIONS]
  }
}

function validateI2SeriesSummary (summary, expectedSource, evidence) {
  assert.ok(evidence && Array.isArray(evidence.inputs), 'exact child report evidence is required')
  const rebuilt = summarizeI2LiveSeries(
    evidence.inputs,
    expectedSource,
    evidence.minimumRuns ?? 5,
    evidence.gateReportBytes ?? null
  )
  assert.deepEqual(summary, rebuilt, 'series summary must be exactly derivable from tracked child bytes')
  return summary
}

function validateI2SeriesSummaryEvidence (summaryBytes, expectedSource, evidence) {
  const summary = parseStrictEvidenceJson(normalizeBytes(summaryBytes, 'I2 series summary'), 'I2 series summary')
  return validateI2SeriesSummary(summary, expectedSource, evidence)
}

function serializeI2SeriesSummary (summary) {
  return JSON.stringify(summary, null, 2) + '\n'
}

if (require.main === module) {
  const options = parseArguments(process.argv.slice(2))
  const inputs = options.reports.map((reportPath) => fs.readFileSync(path.resolve(reportPath)))
  const gateReportBytes = options.gate0cReport ? fs.readFileSync(path.resolve(options.gate0cReport)) : null
  const summary = summarizeI2LiveSeries(inputs, options.source, options.minimumRuns, gateReportBytes)
  validateI2SeriesSummary(summary, options.source, { inputs, minimumRuns: options.minimumRuns, gateReportBytes })
  const outputPath = path.resolve(options.output)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, serializeI2SeriesSummary(summary))
  process.stdout.write(`I2 ${options.source} ${summary.runCount}-run series passed.\n`)
}

module.exports = {
  LOOPBACK_SERIES_LIMITATIONS,
  MIC_SERIES_LIMITATIONS,
  distribution,
  parseArguments,
  readGate0CBinding,
  serializeI2SeriesSummary,
  summarizeI2LiveSeries,
  validateI2SeriesSummary,
  validateI2SeriesSummaryEvidence
}
