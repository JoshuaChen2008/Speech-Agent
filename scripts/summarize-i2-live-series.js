'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { percentile } = require('./gate-0b/metrics')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')
const {
  validateI2ExactChildExitEvidenceBytes
} = require('./write-i2-exact-child-exit')
const {
  LATENCY_TRACE_KEYS,
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
  const options = { output: null, source: null, minimumRuns: 5, gate0cReport: null, exitEvidence: [], reports: [] }
  const singletonOptions = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    const value = argv[index + 1]
    if (name.startsWith('--') &&
        (!['--output', '--source', '--minimum-runs', '--gate-0c-report', '--exit-evidence'].includes(name) ||
         typeof value !== 'string' || value.length === 0 || value.startsWith('--'))) {
      throw new Error(`invalid or missing value for option: ${name}`)
    }
    if (name !== '--exit-evidence' && name.startsWith('--')) {
      if (singletonOptions.has(name)) throw new Error(`${name} must be provided exactly once`)
      singletonOptions.add(name)
    }
    if (name === '--output') { options.output = value; index += 1 } else if (name === '--source') {
      options.source = value; index += 1
    } else if (name === '--minimum-runs') {
      options.minimumRuns = Number(value); index += 1
    } else if (name === '--gate-0c-report') {
      options.gate0cReport = value; index += 1
    } else if (name === '--exit-evidence') {
      options.exitEvidence.push(value); index += 1
    } else {
      options.reports.push(name)
    }
  }
  if (!['loopback', 'mic'].includes(options.source)) throw new Error('--source must be loopback or mic')
  if (typeof options.output !== 'string' || options.output.length === 0) throw new Error('--output is required')
  if (options.minimumRuns !== 5) throw new Error('--minimum-runs must be exactly 5 for authoritative I2 evidence')
  if (options.reports.length !== 5) throw new Error('exactly 5 report paths are required')
  if (options.exitEvidence.length !== 5) throw new Error('exactly 5 exit evidence paths are required')
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
  assert.ok(Buffer.isBuffer(value), `${label} must provide exact bytes`)
  return value
}

function readGate0CBinding (gateReportBytes) {
  const bytes = normalizeBytes(gateReportBytes, 'Gate 0C evidence')
  return deriveGate0CBinding(bytes)
}

function summarizeI2LiveSeries (inputs, exitEvidenceInputs, sourceId, minimumRuns = 5, gateReportBytes = null) {
  assert.ok(['loopback', 'mic'].includes(sourceId), 'sourceId must be loopback or mic')
  assert.equal(minimumRuns, 5, 'authoritative I2 evidence requires exactly five runs')
  assert.ok(Array.isArray(inputs) && inputs.length === 5, 'exactly five child reports are required')
  assert.ok(Array.isArray(exitEvidenceInputs) && exitEvidenceInputs.length === 5,
    'exactly five child exit evidence records are required')
  const binding = sourceId === 'mic' ? readGate0CBinding(gateReportBytes) : null
  assert.equal(sourceId === 'loopback' ? gateReportBytes : null, null, 'loopback series must not accept Gate 0C evidence')

  const reports = inputs.map((input, index) => {
    const bytes = normalizeBytes(input, `report ${index + 1}`)
    const report = parseStrictEvidenceJson(bytes, `I2 ${sourceId} child ${index + 1}`)
    validateI2LiveReport(report, sourceId)
    if (sourceId === 'mic') assertGate0CBinding(report, binding)
    else assert.equal(report.stimulus.kind, 'controlled-playback', 'loopback series requires controlled playback')
    const exitEvidenceBytes = normalizeBytes(exitEvidenceInputs[index], `exit evidence ${index + 1}`)
    const exitEvidence = validateI2ExactChildExitEvidenceBytes(exitEvidenceBytes, sourceId, bytes)
    return {
      reportSha256: sha256(bytes),
      report,
      exitEvidenceSha256: sha256(exitEvidenceBytes),
      exitEvidence
    }
  }).sort((left, right) => {
    const byTime = Date.parse(left.report.executedAt) - Date.parse(right.report.executedAt)
    return byTime || left.reportSha256.localeCompare(right.reportSha256)
  })

  assert.equal(new Set(reports.map((run) => run.reportSha256)).size, reports.length, 'series child reports must be byte-distinct')
  assert.equal(new Set(reports.map((run) => run.exitEvidenceSha256)).size, reports.length,
    'series child exit evidence must be byte-distinct')
  assert.equal(new Set(reports.map((run) => run.report.executedAt)).size, reports.length, 'series child timestamps must be distinct')
  const runs = reports.map((run, index) => ({ ordinal: index + 1, ...run }))
  const values = (selector) => runs.map((run) => selector(run.report))
  const maxima = {
    finalCer: Math.max(...values((report) => report.accuracy.finalCer)),
    refinedCer: Math.max(...values((report) => report.accuracy.refinedCer))
  }
  for (const key of ZERO_TRANSPORT_KEYS) maxima[key] = Math.max(...values((report) => report.transport[key]))

  return {
    schemaVersion: 6,
    kind: 'i2-live-caption-series',
    generatedAt: new Date(Math.max(...values((report) => Date.parse(report.executedAt)))).toISOString(),
    sourceId,
    result: 'pass',
    runCount: runs.length,
    criteria: {
      minimumRuns,
      everyRunPassedSchema5: true,
      everyRunExitedZeroWithoutRunnerTermination: true,
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
      ...Object.fromEntries(LATENCY_TRACE_KEYS.map((key) => [
        key,
        distribution(values((report) => report.latencyTrace[key]))
      ])),
      capturedOnsetMinusFrozenEstimateMs: distribution(values((report) =>
        report.latencyDiagnostics.captureOnset.speechOnsetMinusFrozenEstimateMs)),
      capturedOnsetToCoordinatorPartialMs: distribution(values((report) =>
        report.latencyDiagnostics.derived.capturedOnsetToCoordinatorPartialMs)),
      audioNeededAfterCapturedOnsetMs: distribution(values((report) =>
        report.latencyDiagnostics.modelAudio.audioNeededAfterCapturedOnsetMs)),
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
    evidence.exitEvidenceInputs,
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

function writeI2SeriesSummaryExclusive (outputPath, summary, expectedSource, evidence) {
  validateI2SeriesSummary(summary, expectedSource, evidence)
  const resolvedOutput = path.resolve(outputPath)
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true })
  fs.writeFileSync(resolvedOutput, serializeI2SeriesSummary(summary), {
    encoding: 'utf8',
    flag: 'wx'
  })
  return resolvedOutput
}

if (require.main === module) {
  const options = parseArguments(process.argv.slice(2))
  const inputs = options.reports.map((reportPath) => fs.readFileSync(path.resolve(reportPath)))
  const exitEvidenceInputs = options.exitEvidence.map((evidencePath) => fs.readFileSync(path.resolve(evidencePath)))
  const gateReportBytes = options.gate0cReport ? fs.readFileSync(path.resolve(options.gate0cReport)) : null
  const summary = summarizeI2LiveSeries(inputs, exitEvidenceInputs, options.source, options.minimumRuns, gateReportBytes)
  const evidence = {
    inputs,
    exitEvidenceInputs,
    minimumRuns: options.minimumRuns,
    gateReportBytes
  }
  writeI2SeriesSummaryExclusive(options.output, summary, options.source, evidence)
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
  validateI2SeriesSummaryEvidence,
  writeI2SeriesSummaryExclusive
}
