'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { parseStrictEvidenceJson } = require('../../scripts/strict-evidence-json')

const EVIDENCE_ROOT = path.resolve(__dirname, '../../docs/validation/i2-live-v4')
const GATE_REPORT_PATH = path.join(EVIDENCE_ROOT, 'gate-0c-preflight.json')
const RUNNER_PATH = path.resolve(__dirname, '../../scripts/i2-live-caption-smoke.js')
const EXPECTED_GATE_SHA256 = '43e97770e3508c88ff5843df2c897825f7e8b717bc1010fccb750c5beb2d1f0b'
const {
  buildFailureReport,
  buildMicPromptNotice,
  buildReport,
  normalizeFailureCodes,
  parseArguments,
  readPhysicalMicPreflight
} = require('../../scripts/i2-live-caption-smoke')
const { validateGate0CMetricsReport } = require('../../scripts/gate-0c/verify-report')
const {
  CORPUS_SHA256,
  REFERENCE_SHA256,
  ZERO_TRANSPORT_KEYS,
  validateI2LiveReportEvidence,
  validateI2LiveReport
} = require('../../scripts/verify-i2-live-report')
const {
  parseArguments: parseSeriesArguments,
  serializeI2SeriesSummary,
  summarizeI2LiveSeries,
  validateI2SeriesSummary,
  validateI2SeriesSummaryEvidence
} = require('../../scripts/summarize-i2-live-series')

function sha256 (bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function sourceEvidence (sourceId) {
  const directory = path.join(EVIDENCE_ROOT, sourceId)
  const expectedNames = [...Array(5)].map((_, index) => `run-${String(index + 1).padStart(2, '0')}.json`).concat('series.json')
  assert.deepEqual(fs.readdirSync(directory).sort(), expectedNames.sort(), `${sourceId} evidence directory must contain exactly five children and one summary`)
  const inputs = expectedNames.filter((name) => name.startsWith('run-')).map((name) => fs.readFileSync(path.join(directory, name)))
  const summaryBytes = fs.readFileSync(path.join(directory, 'series.json'))
  return { inputs, summaryBytes, summary: parseStrictEvidenceJson(summaryBytes, `${sourceId} summary`) }
}

function mutateBytes (bytes, mutate) {
  const report = parseStrictEvidenceJson(bytes, 'mutation input')
  mutate(report)
  return Buffer.from(JSON.stringify(report, null, 2) + '\n')
}

function injectDuplicateKey (bytes, key, hiddenValue) {
  const source = bytes.toString('utf8')
  const needle = `"${key}": `
  assert.ok(source.includes(needle), `fixture must contain ${key}`)
  return Buffer.from(source.replace(needle, `"${key}": ${JSON.stringify(hiddenValue)},\n    ${needle}`))
}

test('tracked Gate 0C preflight is the exact memory-only schema2 fixture bound by mic reports', () => {
  const bytes = fs.readFileSync(GATE_REPORT_PATH)
  const report = validateGate0CMetricsReport(parseStrictEvidenceJson(bytes, 'tracked Gate 0C'))
  assert.equal(sha256(bytes), EXPECTED_GATE_SHA256)
  assert.equal(report.runId, 'gate-0c-2026-07-31T06-00-04-063Z')
  assert.equal(report.executedAt, '2026-07-31T06:00:17.189Z')
  assert.equal(report.capture.mic.selection, 'physical-preferred')
  assert.equal(report.capture.mic.capture.playback.output.selected, 'physical-speaker-preferred')
  assert.equal(report.privacy.rawAudioPersisted, false)

  const reduced = readPhysicalMicPreflight(GATE_REPORT_PATH)
  assert.equal(reduced.reportSha256, EXPECTED_GATE_SHA256)
  assert.equal(reduced.runId, report.runId)
  assert.equal(reduced.micLabelSha256, report.capture.mic.stream.track.labelSha256)
  assert.equal(reduced.speakerLabelSha256, report.capture.mic.capture.playback.output.labelSha256)
})

test('ten tracked schema4 children exactly regenerate both deterministic series', () => {
  const gateReportBytes = fs.readFileSync(GATE_REPORT_PATH)
  const loopback = sourceEvidence('loopback')
  const mic = sourceEvidence('mic')
  const rebuiltLoopback = summarizeI2LiveSeries(loopback.inputs, 'loopback', 5)
  const rebuiltMic = summarizeI2LiveSeries(mic.inputs, 'mic', 5, gateReportBytes)

  validateI2SeriesSummary(loopback.summary, 'loopback', { inputs: loopback.inputs, minimumRuns: 5 })
  validateI2SeriesSummary(mic.summary, 'mic', { inputs: mic.inputs, minimumRuns: 5, gateReportBytes })
  validateI2SeriesSummaryEvidence(loopback.summaryBytes, 'loopback', { inputs: loopback.inputs, minimumRuns: 5 })
  validateI2SeriesSummaryEvidence(mic.summaryBytes, 'mic', { inputs: mic.inputs, minimumRuns: 5, gateReportBytes })
  assert.deepEqual(loopback.summary, rebuiltLoopback)
  assert.deepEqual(mic.summary, rebuiltMic)
  assert.equal(loopback.summaryBytes.toString('utf8'), serializeI2SeriesSummary(rebuiltLoopback))
  assert.equal(mic.summaryBytes.toString('utf8'), serializeI2SeriesSummary(rebuiltMic))
  assert.equal(new Set(loopback.inputs.map(sha256)).size, 5)
  assert.equal(new Set(mic.inputs.map(sha256)).size, 5)

  assert.deepEqual(loopback.summary.distributions.firstPartialFromEstimatedSpeechOnsetMs, { p50: 1112, p95: 1126, min: 1042, max: 1126 })
  assert.deepEqual(mic.summary.distributions.firstPartialFromEstimatedSpeechOnsetMs, { p50: 843, p95: 1024, min: 819, max: 1024 })
  assert.equal(loopback.summary.maxima.finalCer, 0)
  assert.equal(mic.summary.maxima.finalCer, 0)
  assert.equal(loopback.summary.maxima.refinedCer, 0)
  assert.equal(mic.summary.maxima.refinedCer, 0)
  for (const key of ZERO_TRANSPORT_KEYS) {
    assert.equal(loopback.summary.maxima[key], 0)
    assert.equal(mic.summary.maxima[key], 0)
  }

  for (const bytes of loopback.inputs) {
    const report = validateI2LiveReportEvidence(bytes, 'loopback')
    assert.equal(report.stimulus.corpusSha256, CORPUS_SHA256)
    assert.equal(report.stimulus.referenceSha256, REFERENCE_SHA256)
  }
  for (const bytes of mic.inputs) {
    const report = validateI2LiveReportEvidence(bytes, 'mic', gateReportBytes)
    assert.equal(report.stimulus.corpusSha256, CORPUS_SHA256)
    assert.equal(report.stimulus.referenceSha256, REFERENCE_SHA256)
  }
  for (const bytes of mic.inputs) {
    const report = parseStrictEvidenceJson(bytes, 'tracked mic child')
    assert.equal(report.preflight.reportSha256, EXPECTED_GATE_SHA256)
    assert.equal(report.preflight.runId, 'gate-0c-2026-07-31T06-00-04-063Z')
    assert.equal(report.input.matchedLabelHashCount, 1)
    assert.equal(report.stimulus.output.matchedLabelHashCount, 1)
  }
})

test('series reconstruction rejects byte, fixture, privacy, refinement and every loss-axis mutation', () => {
  const gateReportBytes = fs.readFileSync(GATE_REPORT_PATH)
  const loopback = sourceEvidence('loopback')
  const mic = sourceEvidence('mic')

  const duplicate = [...loopback.inputs]
  duplicate[1] = duplicate[0]
  assert.throws(() => summarizeI2LiveSeries(duplicate, 'loopback', 5), /byte-distinct/)

  for (const mutate of [
    (report) => { report.transcript = 'forbidden' },
    (report) => { report.capturedPcmBase64 = 'AAAA' },
    (report) => { report.refinement = null },
    (report) => { report.timings.firstPartialFromEstimatedSpeechOnsetMs = null },
    (report) => { report.stimulus.corpusSha256 = 'a'.repeat(64) }
  ]) {
    const inputs = [...loopback.inputs]
    inputs[1] = mutateBytes(inputs[1], mutate)
    assert.throws(() => summarizeI2LiveSeries(inputs, 'loopback', 5))
  }

  for (const key of ZERO_TRANSPORT_KEYS) {
    const inputs = [...loopback.inputs]
    inputs[1] = mutateBytes(inputs[1], (report) => { report.transport[key] = 1 })
    assert.throws(() => summarizeI2LiveSeries(inputs, 'loopback', 5), new RegExp(key))
  }

  for (const mutate of [
    (report) => { report.preflight.reportSha256 = 'a'.repeat(64) },
    (report) => { report.input.track.labelSha256 = 'a'.repeat(64) },
    (report) => { report.stimulus.output.labelSha256 = 'a'.repeat(64) }
  ]) {
    const inputs = [...mic.inputs]
    inputs[1] = mutateBytes(inputs[1], mutate)
    assert.throws(() => summarizeI2LiveSeries(inputs, 'mic', 5, gateReportBytes))
  }

  const alteredSummary = structuredClone(loopback.summary)
  alteredSummary.runs[1].reportSha256 = 'a'.repeat(64)
  assert.throws(() => validateI2SeriesSummary(alteredSummary, 'loopback', { inputs: loopback.inputs, minimumRuns: 5 }), /exactly derivable/)

  const alteredGate = mutateBytes(gateReportBytes, (report) => { report.capturedPcmBase64 = 'AAAA' })
  assert.throws(() => summarizeI2LiveSeries(mic.inputs, 'mic', 5, alteredGate))

  const duplicateChildKey = injectDuplicateKey(loopback.inputs[1], 'labelSha256', 'C:/private/recording.wav')
  assert.throws(() => validateI2LiveReportEvidence(duplicateChildKey, 'loopback'), /duplicate object key/)
  const duplicateInputs = [...loopback.inputs]
  duplicateInputs[1] = duplicateChildKey
  assert.throws(() => summarizeI2LiveSeries(duplicateInputs, 'loopback', 5), /duplicate object key/)

  const duplicateGateKey = injectDuplicateKey(gateReportBytes, 'runId', '\\\\private-host\\recording.wav')
  assert.throws(() => summarizeI2LiveSeries(mic.inputs, 'mic', 5, duplicateGateKey), /duplicate object key/)
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'i2-strict-gate-'))
  try {
    const duplicateGatePath = path.join(temporaryDirectory, 'gate.json')
    fs.writeFileSync(duplicateGatePath, duplicateGateKey)
    assert.throws(() => readPhysicalMicPreflight(duplicateGatePath), /duplicate object key/)
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }

  const duplicateSummaryKey = injectDuplicateKey(loopback.summaryBytes, 'sourceId', '/tmp/private-caption.wav')
  assert.throws(
    () => validateI2SeriesSummaryEvidence(duplicateSummaryKey, 'loopback', { inputs: loopback.inputs, minimumRuns: 5 }),
    /duplicate object key/
  )
})

test('I2 live runner requires exactly one explicit source and self-validates before writing pass', () => {
  assert.throws(() => parseArguments([]), /--source is required/)
  assert.equal(parseArguments(['--source', 'loopback']).source, 'loopback')
  assert.equal(parseArguments(['--source', 'mic', '--listen-seconds', '15']).source, 'mic')
  const acoustic = parseArguments(['--source', 'mic', '--mic-stimulus', 'acoustic-replay', '--physical-mic-preflight', 'gate.json'])
  assert.equal(acoustic.micStimulus, 'acoustic-replay')
  assert.equal(acoustic.physicalMicPreflight, 'gate.json')
  assert.throws(() => parseArguments(['--source', 'mic', '--mic-stimulus', 'acoustic-replay']), /preflight is required/)
  assert.throws(() => parseArguments(['--source', 'loopback', '--physical-mic-preflight', 'gate.json']), /only valid/)
  assert.throws(() => parseArguments(['--source', 'loopback,mic']), /--source is required/)
  assert.throws(() => parseArguments(['--source', 'loopback', '--source', 'mic']), /exactly once/)
  assert.deepEqual(buildMicPromptNotice(15), {
    status: 'awaiting-microphone-speech',
    seconds: 15,
    promptId: 'zh-en-code-switch'
  }, 'mic notice identifies the frozen corpus without logging its text')

  const source = fs.readFileSync(RUNNER_PATH, 'utf8')
  const writeTargets = [...source.matchAll(/fs\.writeFileSync\(([^,\n]+)/g)].map((match) => match[1].trim())
  assert.deepEqual([...new Set(writeTargets)], ['reportPath'], 'runner may persist only its JSON report')
  assert.match(source, /if \(result === 'pass'\) validateI2LiveReport\(report, options\.source\)/)

  const fiveReports = ['run1.json', 'run2.json', 'run3.json', 'run4.json', 'run5.json']
  const loopbackSeries = parseSeriesArguments(['--source', 'loopback', '--output', 'series.json', '--minimum-runs', '5', ...fiveReports])
  assert.equal(loopbackSeries.source, 'loopback')
  assert.throws(
    () => parseSeriesArguments(['--source', 'loopback', '--output', 'series.json', '--minimum-runs', '2', 'run1.json', 'run2.json']),
    /exactly 5/
  )
  assert.throws(
    () => parseSeriesArguments(['--source', 'loopback', '--output', 'series.json', '--minimum-runs', '5', ...fiveReports, 'run6.json']),
    /exactly 5 report paths/
  )
  assert.throws(
    () => parseSeriesArguments(['--source', 'mic', '--output', 'series.json', '--minimum-runs', '5', ...fiveReports]),
    /--gate-0c-report is required/
  )
  const micSeries = parseSeriesArguments(['--source', 'mic', '--output', 'series.json', '--minimum-runs', '5', '--gate-0c-report', 'gate.json', ...fiveReports])
  assert.equal(micSeries.gate0cReport, 'gate.json')
  const seriesRunnerSource = fs.readFileSync(path.resolve(__dirname, '../../scripts/run-i2-live-series.ps1'), 'utf8')
  assert.match(seriesRunnerSource, /\[ValidateSet\(5\)\]/)
  assert.match(seriesRunnerSource, /'--gate-0c-report', \$preflightPath/)

  const failureReport = buildFailureReport({
    sourceId: 'mic',
    phases: ['starting', 'private transcript', 'error'],
    error: '\\\\private-host\\recording.wav transcript: private words'
  })
  assert.deepEqual(failureReport, {
    schemaVersion: 4,
    kind: 'i2-live-caption-smoke-failure',
    sourceId: 'mic',
    result: 'error',
    errorCode: 'i2-live-run-failed',
    phases: ['starting', 'error'],
    privacy: {
      capturedAudioPersisted: false,
      reportContainsTranscriptText: false,
      reportContainsAudioPath: false,
      reportContainsDiagnosticText: false
    }
  })
  assert.doesNotMatch(JSON.stringify(failureReport), /private-host|recording\.wav|private words/)
  assert.doesNotMatch(source, /error:\s*safeDiagnosticText|error\?\.message|error\?\.stack/)
  assert.deepEqual(normalizeFailureCodes(['listener-error', 'final-cer-exceeded']), ['listener-error', 'final-cer-exceeded'])
  assert.throws(() => normalizeFailureCodes(['transcript: private words']), /fixed codes/)
  assert.throws(() => normalizeFailureCodes(['C:/private/recording.wav']), /fixed codes/)
})

test('runner report builder emits the same closed, text-free schema4 root shape', () => {
  const report = buildReport({
    executedAt: '2026-07-31T00:00:00.000Z',
    environment: { electron: '43.2.0', node: '24.18.0' },
    sourceId: 'mic',
    result: 'pass',
    model: { id: 'x-asr-160ms', profile: 'fast', numThreads: 4 },
    vad: 'silero',
    refinement: 'x-asr-offline',
    stimulus: { kind: 'operator-spoken-prompt', corpusId: 'zh-en-code-switch', corpusSha256: CORPUS_SHA256, referenceSha256: REFERENCE_SHA256, listenSeconds: 12 },
    preflight: null,
    failures: [],
    phases: ['starting', 'listening', 'stopping', 'idle'],
    counts: { captions: 3, partials: 1, finals: 1, refined: 1 },
    accuracy: { finalCer: 0, refinedCer: 0, refinedHasPunctuation: true },
    timings: { firstPartialFromStimulusStartMs: 100, firstPartialFromEstimatedSpeechOnsetMs: null, firstFinalFromStimulusStartMs: 200, firstRefinedFromStimulusStartMs: 300, firstFinalAfterStimulusEndMs: 10, captionArrivalCount: 3 },
    resources: { sampleCount: 2, cpuPercent: { p50: 1, p95: 2, max: 3 }, workingSetMiB: { p50: 1, p95: 2, max: 3 }, maxProcessCount: 1 },
    peakRms: 0.2,
    diagnostics: {
      input: {
        sources: {
          mic: {
            selection: 'system-default',
            matchedLabelHashCount: null,
            track: {
              kind: 'audio',
              labelSha256: 'a'.repeat(64),
              settings: { autoGainControl: false, channelCount: 2, echoCancellation: false, latency: 0.01, noiseSuppression: false, sampleRate: 48000, sampleSize: 16 }
            }
          }
        }
      },
      capture: { mic: { capturedFrames: 2, sentFrames: 2, droppedFrames: 0, creditStalls: 0, maxQueuedMsObserved: 0, acknowledgedFrames: 2, lostInFlightFrames: 0, portReplacements: 0, queuedFrames: 0, queuedMs: 0, discardedAtStop: 0 } },
      worker: { badSampleTypeFrames: 0, sources: { mic: { framesIngested: 2, sequenceGapCount: 0, missedFrames: 0 } } },
      droppedCaptionCount: 0
    }
  })
  const tracked = JSON.parse(fs.readFileSync(path.join(EVIDENCE_ROOT, 'mic', 'run-01.json'), 'utf8'))
  assert.deepEqual(Object.keys(report), Object.keys(tracked))
  assert.equal(report.schemaVersion, 4)
  assert.equal(report.input.selection, 'system-default')
  assert.equal(report.input.matchedLabelHashCount, null)
  assert.equal(report.privacy.reportContainsTranscriptText, false)
  assert.doesNotMatch(JSON.stringify(report), /joined(?:Final|Refined)Text|captionArrivals|capturedPcmBase64|"text"\s*:/i)
})
