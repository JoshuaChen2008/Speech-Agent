'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { parseStrictEvidenceJson } = require('../../scripts/strict-evidence-json')

const EVIDENCE_ROOT = path.resolve(__dirname, '../../docs/validation/i2-live-v5')
const B96_LOOPBACK_EVIDENCE_ROOT = path.resolve(__dirname, '../../docs/validation/i2-live-b96b8fe-loopback')
const GATE_REPORT_PATH = path.join(EVIDENCE_ROOT, 'gate-0c-preflight.json')
const RUNNER_PATH = path.resolve(__dirname, '../../scripts/i2-live-caption-smoke.js')
const EXPECTED_GATE_SHA256 = '0f9f7668751c64fbce922883421ead41680226126800e0b7f6b3da81b39840ef'
const {
  buildFailureReport,
  buildMicPromptNotice,
  buildReport,
  isRefinementEvidenceMissing,
  isDirectElectronMainEntry,
  normalizeFailureCodes,
  parseArguments,
  provisionalDiagnosticsSummary,
  REFINEMENT_OBSERVATION_POLL_MS,
  REFINEMENT_OBSERVATION_TIMEOUT_MS,
  readPhysicalMicPreflight,
  startPreparedPlaybackAfterProbe,
  waitForRefinementObservation
} = require('../../scripts/i2-live-caption-smoke')
const { validateGate0CMetricsReport } = require('../../scripts/gate-0c/verify-report')
const {
  CORPUS_SHA256,
  REFERENCE_SHA256,
  ROOT_KEYS,
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
const {
  EXIT_EVIDENCE_KEYS,
  buildI2ExactChildExitEvidence,
  serializeI2ExactChildExitEvidence,
  validateI2ExactChildExitEvidenceBytes,
  writeI2ExactChildExitEvidenceExclusive
} = require('../../scripts/write-i2-exact-child-exit')

function sha256 (bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function readSourceEvidenceDirectory (directory, sourceId) {
  const reportNames = [...Array(5)].map((_, index) => `run-${String(index + 1).padStart(2, '0')}.json`)
  const exitEvidenceNames = [...Array(5)].map((_, index) => `run-${String(index + 1).padStart(2, '0')}.exit.json`)
  const expectedNames = [...reportNames, ...exitEvidenceNames, 'series.json']
  assert.deepEqual(fs.readdirSync(directory).sort(), expectedNames.sort(),
    `${sourceId} evidence directory must contain exactly five reports, five exit records and one summary`)
  const inputs = reportNames.map((name) => fs.readFileSync(path.join(directory, name)))
  const exitEvidenceInputs = exitEvidenceNames.map((name) => fs.readFileSync(path.join(directory, name)))
  const summaryBytes = fs.readFileSync(path.join(directory, 'series.json'))
  return { inputs, exitEvidenceInputs, summaryBytes, summary: parseStrictEvidenceJson(summaryBytes, `${sourceId} summary`) }
}

function sourceEvidence (sourceId) {
  return readSourceEvidenceDirectory(path.join(EVIDENCE_ROOT, sourceId), sourceId)
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

test('live smoke starts only when it is the direct Electron main entry', () => {
  assert.equal(isDirectElectronMainEntry(
    ['electron.exe', RUNNER_PATH],
    { electron: '43.2.0' },
    'browser'
  ), true)
  assert.equal(isDirectElectronMainEntry(
    ['electron.exe', path.resolve(__dirname, '../../scripts/i2-live-interaction.js')],
    { electron: '43.2.0' },
    'browser'
  ), false)
  assert.equal(isDirectElectronMainEntry(
    ['node.exe', RUNNER_PATH],
    {},
    undefined
  ), false)
})

test('exact-byte v5 evidence is pinned to LF across Windows checkouts', () => {
  const attributes = fs.readFileSync(path.resolve(__dirname, '../../.gitattributes'), 'utf8')
  assert.match(attributes, /^docs\/validation\/i2-live-v5\/\*\.json text eol=lf$/m)
  assert.match(attributes, /^docs\/validation\/i2-live-v5\/\*\*\/\*\.json text eol=lf$/m)
  assert.match(attributes, /^docs\/validation\/i2-live-b96b8fe-loopback\/\*\.json text eol=lf$/m)

  const evidenceBytes = [fs.readFileSync(GATE_REPORT_PATH)]
  for (const sourceId of ['loopback', 'mic']) {
    const evidence = sourceEvidence(sourceId)
    evidenceBytes.push(...evidence.inputs, ...evidence.exitEvidenceInputs, evidence.summaryBytes)
  }
  for (const bytes of evidenceBytes) assert.equal(bytes.includes(0x0d), false)
})

test('revision b96b8fe7 loopback supplement is an exact five-child refinement and exit-bound series', () => {
  const evidence = readSourceEvidenceDirectory(B96_LOOPBACK_EVIDENCE_ROOT, 'loopback')
  const rebuilt = validateI2SeriesSummaryEvidence(evidence.summaryBytes, 'loopback', {
    inputs: evidence.inputs,
    exitEvidenceInputs: evidence.exitEvidenceInputs,
    minimumRuns: 5,
    gateReportBytes: null
  })
  assert.equal(sha256(evidence.summaryBytes), '2a365e3c6a1075336b9c7df65ad5b3ca36094a991d5b68532d15e65556ab1b48')
  assert.equal(rebuilt.result, 'pass')
  assert.equal(rebuilt.runCount, 5)
  assert.deepEqual(rebuilt.distributions.firstPartialFromEstimatedSpeechOnsetMs, {
    p50: 1144,
    p95: 1242,
    min: 1054,
    max: 1242
  })
  assert.equal(rebuilt.maxima.finalCer, 0)
  assert.equal(rebuilt.maxima.refinedCer, 0)
  for (const key of ZERO_TRANSPORT_KEYS) assert.equal(rebuilt.maxima[key], 0)
  assert.deepEqual(rebuilt.privacy, {
    capturedAudioPersisted: false,
    reportContainsTranscriptText: false,
    reportContainsAudioPath: false,
    reportContainsInputPaths: false
  })
})

test('tracked Gate 0C preflight is the exact memory-only schema2 fixture bound by schema5 mic reports', () => {
  const bytes = fs.readFileSync(GATE_REPORT_PATH)
  const report = validateGate0CMetricsReport(parseStrictEvidenceJson(bytes, 'tracked Gate 0C'))
  assert.equal(sha256(bytes), EXPECTED_GATE_SHA256)
  assert.equal(report.runId, 'gate-0c-2026-07-31T09-52-00-521Z')
  assert.equal(report.executedAt, '2026-07-31T09:52:13.999Z')
  assert.equal(report.capture.mic.selection, 'physical-preferred')
  assert.equal(report.capture.mic.capture.playback.output.selected, 'physical-speaker-preferred')
  assert.equal(report.privacy.rawAudioPersisted, false)

  const reduced = readPhysicalMicPreflight(GATE_REPORT_PATH)
  assert.equal(reduced.reportSha256, EXPECTED_GATE_SHA256)
  assert.equal(reduced.runId, report.runId)
  assert.equal(reduced.micLabelSha256, report.capture.mic.stream.track.labelSha256)
  assert.equal(reduced.speakerLabelSha256, report.capture.mic.capture.playback.output.labelSha256)
})

test('ten tracked schema5 children and ten strict exit records exactly regenerate both schema6 series', () => {
  const gateReportBytes = fs.readFileSync(GATE_REPORT_PATH)
  const loopback = sourceEvidence('loopback')
  const mic = sourceEvidence('mic')
  const rebuiltLoopback = summarizeI2LiveSeries(loopback.inputs, loopback.exitEvidenceInputs, 'loopback', 5)
  const rebuiltMic = summarizeI2LiveSeries(mic.inputs, mic.exitEvidenceInputs, 'mic', 5, gateReportBytes)

  validateI2SeriesSummary(loopback.summary, 'loopback', { inputs: loopback.inputs, exitEvidenceInputs: loopback.exitEvidenceInputs, minimumRuns: 5 })
  validateI2SeriesSummary(mic.summary, 'mic', { inputs: mic.inputs, exitEvidenceInputs: mic.exitEvidenceInputs, minimumRuns: 5, gateReportBytes })
  validateI2SeriesSummaryEvidence(loopback.summaryBytes, 'loopback', { inputs: loopback.inputs, exitEvidenceInputs: loopback.exitEvidenceInputs, minimumRuns: 5 })
  validateI2SeriesSummaryEvidence(mic.summaryBytes, 'mic', { inputs: mic.inputs, exitEvidenceInputs: mic.exitEvidenceInputs, minimumRuns: 5, gateReportBytes })
  assert.deepEqual(loopback.summary, rebuiltLoopback)
  assert.deepEqual(mic.summary, rebuiltMic)
  assert.equal(loopback.summaryBytes.toString('utf8'), serializeI2SeriesSummary(rebuiltLoopback))
  assert.equal(mic.summaryBytes.toString('utf8'), serializeI2SeriesSummary(rebuiltMic))
  assert.equal(new Set(loopback.inputs.map(sha256)).size, 5)
  assert.equal(new Set(mic.inputs.map(sha256)).size, 5)
  assert.equal(new Set(loopback.exitEvidenceInputs.map(sha256)).size, 5)
  assert.equal(new Set(mic.exitEvidenceInputs.map(sha256)).size, 5)
  assert.equal(loopback.summary.schemaVersion, 6)
  assert.equal(mic.summary.schemaVersion, 6)
  assert.equal(loopback.summary.criteria.everyRunExitedZeroWithoutRunnerTermination, true)
  assert.equal(mic.summary.criteria.everyRunExitedZeroWithoutRunnerTermination, true)
  for (const evidence of [loopback, mic]) {
    for (const [index, run] of evidence.summary.runs.entries()) {
      assert.deepEqual(Object.keys(run), ['ordinal', 'reportSha256', 'report', 'exitEvidenceSha256', 'exitEvidence'])
      assert.equal(run.exitEvidence.reportSha256, run.reportSha256)
      assert.equal(run.exitEvidenceSha256, sha256(evidence.exitEvidenceInputs[index]))
    }
  }

  assert.deepEqual(loopback.summary.distributions.firstPartialFromEstimatedSpeechOnsetMs, { p50: 1133, p95: 1158, min: 1092, max: 1158 })
  assert.deepEqual(mic.summary.distributions.firstPartialFromEstimatedSpeechOnsetMs, { p50: 875, p95: 1005, min: 822, max: 1005 })
  assert.deepEqual(loopback.summary.distributions.estimatedSpeechOnsetToVadStartFrameAudioHostReceiptMs, { p50: 706, p95: 729, min: 658, max: 729 })
  assert.deepEqual(loopback.summary.distributions.vadStartFrameToPartialTriggerFrameAudioHostMs, { p50: 400, p95: 405, min: 400, max: 405 })
  assert.deepEqual(loopback.summary.distributions.partialTriggerFrameAudioHostToUtilityIngressMs, { p50: 0, p95: 1, min: 0, max: 1 })
  assert.deepEqual(loopback.summary.distributions.partialTriggerUtilityIngressToPublishMs, { p50: 26, p95: 33, min: 24, max: 33 })
  assert.deepEqual(loopback.summary.distributions.partialPublishUtilityToMainWorkerHostMs, { p50: 0, p95: 1, min: 0, max: 1 })
  assert.deepEqual(loopback.summary.distributions.mainWorkerHostToCoordinatorObserverMs, { p50: 1, p95: 1, min: 0, max: 1 })
  assert.deepEqual(loopback.summary.distributions.capturedOnsetMinusFrozenEstimateMs, { p50: 100, p95: 140, min: 60, max: 140 })
  assert.deepEqual(mic.summary.distributions.estimatedSpeechOnsetToVadStartFrameAudioHostReceiptMs, { p50: 516, p95: 557, min: 480, max: 557 })
  assert.deepEqual(mic.summary.distributions.vadStartFrameToPartialTriggerFrameAudioHostMs, { p50: 300, p95: 500, min: 300, max: 500 })
  assert.deepEqual(mic.summary.distributions.partialTriggerFrameAudioHostToUtilityIngressMs, { p50: 0, p95: 1, min: 0, max: 1 })
  assert.deepEqual(mic.summary.distributions.partialTriggerUtilityIngressToPublishMs, { p50: 24, p95: 28, min: 22, max: 28 })
  assert.deepEqual(mic.summary.distributions.partialPublishUtilityToMainWorkerHostMs, { p50: 0, p95: 1, min: 0, max: 1 })
  assert.deepEqual(mic.summary.distributions.mainWorkerHostToCoordinatorObserverMs, { p50: 1, p95: 1, min: 0, max: 1 })
  assert.deepEqual(mic.summary.distributions.capturedOnsetMinusFrozenEstimateMs, { p50: -100, p95: -99, min: -100, max: -99 })
  assert.equal(loopback.summary.maxima.finalCer, 0)
  assert.equal(mic.summary.maxima.finalCer, 0.03571428571428571)
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
    assert.equal(report.preflight.runId, 'gate-0c-2026-07-31T09-52-00-521Z')
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
  const duplicateExitEvidence = [...loopback.exitEvidenceInputs]
  duplicateExitEvidence[1] = duplicateExitEvidence[0]
  assert.throws(() => summarizeI2LiveSeries(duplicate, duplicateExitEvidence, 'loopback', 5), /byte-distinct/)

  for (const mutate of [
    (report) => { report.transcript = 'forbidden' },
    (report) => { report.capturedPcmBase64 = 'AAAA' },
    (report) => { report.refinement = null },
    (report) => { report.timings.firstPartialFromEstimatedSpeechOnsetMs = null },
    (report) => { report.stimulus.corpusSha256 = 'a'.repeat(64) }
  ]) {
    const inputs = [...loopback.inputs]
    inputs[1] = mutateBytes(inputs[1], mutate)
    assert.throws(() => summarizeI2LiveSeries(inputs, loopback.exitEvidenceInputs, 'loopback', 5))
  }

  for (const key of ZERO_TRANSPORT_KEYS) {
    const inputs = [...loopback.inputs]
    inputs[1] = mutateBytes(inputs[1], (report) => { report.transport[key] = 1 })
    assert.throws(() => summarizeI2LiveSeries(inputs, loopback.exitEvidenceInputs, 'loopback', 5), new RegExp(key))
  }

  for (const mutate of [
    (report) => { report.preflight.reportSha256 = 'a'.repeat(64) },
    (report) => { report.input.track.labelSha256 = 'a'.repeat(64) },
    (report) => { report.stimulus.output.labelSha256 = 'a'.repeat(64) }
  ]) {
    const inputs = [...mic.inputs]
    inputs[1] = mutateBytes(inputs[1], mutate)
    assert.throws(() => summarizeI2LiveSeries(inputs, mic.exitEvidenceInputs, 'mic', 5, gateReportBytes))
  }

  const alteredSummary = structuredClone(loopback.summary)
  alteredSummary.runs[1].reportSha256 = 'a'.repeat(64)
  assert.throws(() => validateI2SeriesSummary(alteredSummary, 'loopback', {
    inputs: loopback.inputs,
    exitEvidenceInputs: loopback.exitEvidenceInputs,
    minimumRuns: 5
  }), /exactly derivable/)

  const alteredGate = mutateBytes(gateReportBytes, (report) => { report.capturedPcmBase64 = 'AAAA' })
  assert.throws(() => summarizeI2LiveSeries(mic.inputs, mic.exitEvidenceInputs, 'mic', 5, alteredGate))

  const duplicateChildKey = injectDuplicateKey(loopback.inputs[1], 'labelSha256', 'C:/private/recording.wav')
  assert.throws(() => validateI2LiveReportEvidence(duplicateChildKey, 'loopback'), /duplicate object key/)
  const duplicateInputs = [...loopback.inputs]
  duplicateInputs[1] = duplicateChildKey
  assert.throws(() => summarizeI2LiveSeries(duplicateInputs, loopback.exitEvidenceInputs, 'loopback', 5), /duplicate object key/)

  const duplicateGateKey = injectDuplicateKey(gateReportBytes, 'runId', '\\\\private-host\\recording.wav')
  assert.throws(() => summarizeI2LiveSeries(mic.inputs, mic.exitEvidenceInputs, 'mic', 5, duplicateGateKey), /duplicate object key/)
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
    () => validateI2SeriesSummaryEvidence(duplicateSummaryKey, 'loopback', {
      inputs: loopback.inputs,
      exitEvidenceInputs: loopback.exitEvidenceInputs,
      minimumRuns: 5
    }),
    /duplicate object key/
  )
})

test('exact child exit evidence is closed, text-free, byte-bound, ordered and required five times', () => {
  const loopback = sourceEvidence('loopback')
  for (const [index, bytes] of loopback.exitEvidenceInputs.entries()) {
    const evidence = validateI2ExactChildExitEvidenceBytes(bytes, 'loopback', loopback.inputs[index])
    assert.deepEqual(Object.keys(evidence), EXIT_EVIDENCE_KEYS)
    assert.equal(evidence.reportSha256, sha256(loopback.inputs[index]))
    assert.doesNotMatch(bytes.toString('utf8'), /executedAt|time|pid|path|transcript|audio|diagnostic/i)
  }

  const unknown = mutateBytes(loopback.exitEvidenceInputs[0], (evidence) => {
    evidence.diagnostic = 'C:\\private\\recording.wav transcript words'
  })
  assert.throws(() => validateI2ExactChildExitEvidenceBytes(unknown, 'loopback', loopback.inputs[0]), /closed schema/)

  const uppercaseDigest = mutateBytes(loopback.exitEvidenceInputs[0], (evidence) => {
    evidence.reportSha256 = evidence.reportSha256.toUpperCase()
  })
  assert.throws(() => validateI2ExactChildExitEvidenceBytes(uppercaseDigest, 'loopback', loopback.inputs[0]), /lowercase/)

  const wrongSource = mutateBytes(loopback.exitEvidenceInputs[0], (evidence) => { evidence.sourceId = 'mic' })
  assert.throws(() => validateI2ExactChildExitEvidenceBytes(wrongSource, 'loopback', loopback.inputs[0]))

  const wrongBinding = mutateBytes(loopback.exitEvidenceInputs[0], (evidence) => {
    evidence.reportSha256 = 'a'.repeat(64)
  })
  assert.throws(() => validateI2ExactChildExitEvidenceBytes(wrongBinding, 'loopback', loopback.inputs[0]), /exact child report bytes/)

  const duplicateKey = injectDuplicateKey(loopback.exitEvidenceInputs[0], 'sourceId', 'mic')
  assert.throws(() => validateI2ExactChildExitEvidenceBytes(duplicateKey, 'loopback', loopback.inputs[0]), /duplicate object key/)

  const wrongOrder = [...loopback.exitEvidenceInputs]
  ;[wrongOrder[0], wrongOrder[1]] = [wrongOrder[1], wrongOrder[0]]
  assert.throws(() => summarizeI2LiveSeries(loopback.inputs, wrongOrder, 'loopback', 5), /exact child report bytes/)

  const duplicateProof = [...loopback.exitEvidenceInputs]
  duplicateProof[1] = duplicateProof[0]
  assert.throws(() => summarizeI2LiveSeries(loopback.inputs, duplicateProof, 'loopback', 5), /exact child report bytes/)
  assert.throws(() => summarizeI2LiveSeries(loopback.inputs, loopback.exitEvidenceInputs.slice(0, 4), 'loopback', 5), /exactly five/)
  assert.throws(() => summarizeI2LiveSeries(loopback.inputs, [...loopback.exitEvidenceInputs, loopback.exitEvidenceInputs[0]], 'loopback', 5), /exactly five/)

  const built = buildI2ExactChildExitEvidence(loopback.inputs[0], 'loopback')
  assert.equal(serializeI2ExactChildExitEvidence(built), loopback.exitEvidenceInputs[0].toString('utf8'))
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'i2-exit-proof-'))
  try {
    const outputPath = path.join(temporaryDirectory, 'exit.json')
    writeI2ExactChildExitEvidenceExclusive(outputPath, built)
    assert.deepEqual(fs.readFileSync(outputPath), loopback.exitEvidenceInputs[0])
    assert.throws(() => writeI2ExactChildExitEvidenceExclusive(outputPath, built), /EEXIST/)
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }
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
  assert.match(source, /await coordinator\.dispose\(\)\s*if \(result === 'pass'\) app\.quit\(\)/,
    'a passing real-audio run must dispose product resources before a graceful Electron quit')

  const fixedTailIndex = source.indexOf('await delay(3200)')
  const refinementObservationIndex = source.indexOf('await waitForRefinementObservation(captions)', fixedTailIndex)
  const stopIndex = source.indexOf("await coordinator.command('stop')", refinementObservationIndex)
  const stickyTimeoutCheckIndex = source.indexOf('if (isRefinementEvidenceMissing({', stopIndex)
  assert.equal(REFINEMENT_OBSERVATION_TIMEOUT_MS, 15000)
  assert.ok(fixedTailIndex >= 0 && refinementObservationIndex > fixedTailIndex && stopIndex > refinementObservationIndex &&
    stickyTimeoutCheckIndex > stopIndex,
  'bounded refinement observation must precede Stop and its frozen timeout must be checked after Stop')
  assert.match(source, /now = mainClockNowMs/,
    'the refinement observation deadline must use the Electron main monotonic clock')
  assert.match(source, /failures\.push\('refined-caption-missing'\)/,
    'a missing refinement must remain fail closed after the bounded observation window')
  assert.match(source, /if \(!refineModel\) throw new Error\('approved refinement model not found on this machine'\)/,
    'I2 evidence must fail closed before starting when the approved refinement model is absent')
  assert.equal((source.match(/refinementEnabled: true/g) || []).length, 2,
    'both source-specific I2 configurations must freeze refinement on')
  assert.match(source, /refinementAvailable: true/,
    'the I2 runtime capability must explicitly advertise the resolved refinement model')

  const playerSource = fs.readFileSync(path.resolve(__dirname, '../../scripts/i2-live-caption-player.js'), 'utf8')
  assert.match(playerSource, /startPreparedPcm16 = function startPreparedPcm16/)
  assert.match(playerSource, /source\.start\(startedAt\)/,
    'the player must schedule the source at the shared future clock instead of starting immediately')
  assert.match(playerSource, /finishPreparedPcm16 = async function finishPreparedPcm16/)
  const calibrationIndex = source.indexOf('await runtimeAdapter.calibrateTimingProbe()')
  const armIndex = source.indexOf('if (beforeStart) await beforeStart(scheduledSourceStartMainClockMs)')
  const startIndex = source.indexOf('`globalThis.startPreparedPcm16(', armIndex)
  const finishIndex = source.indexOf("executeJavaScript('globalThis.finishPreparedPcm16()'", startIndex)
  assert.ok(calibrationIndex >= 0 && armIndex >= 0 && startIndex > armIndex && finishIndex > startIndex,
    'controlled playback must calibrate, arm a shared future source floor, schedule t0, then finish')

  const fiveReports = ['run1.json', 'run2.json', 'run3.json', 'run4.json', 'run5.json']
  const fiveExitEvidence = ['run1.exit.json', 'run2.exit.json', 'run3.exit.json', 'run4.exit.json', 'run5.exit.json']
  const exitArguments = fiveExitEvidence.flatMap((exitPath) => ['--exit-evidence', exitPath])
  const loopbackSeries = parseSeriesArguments(['--source', 'loopback', '--output', 'series.json', '--minimum-runs', '5', ...exitArguments, ...fiveReports])
  assert.equal(loopbackSeries.source, 'loopback')
  assert.deepEqual(loopbackSeries.exitEvidence, fiveExitEvidence)
  assert.throws(
    () => parseSeriesArguments(['--source', 'loopback', '--output', 'series.json', '--minimum-runs', '2', 'run1.json', 'run2.json']),
    /exactly 5/
  )
  assert.throws(
    () => parseSeriesArguments(['--source', 'loopback', '--output', 'series.json', '--minimum-runs', '5', ...exitArguments, ...fiveReports, 'run6.json']),
    /exactly 5 report paths/
  )
  assert.throws(
    () => parseSeriesArguments(['--source', 'loopback', '--output', 'series.json', '--minimum-runs', '5', ...fiveReports]),
    /exactly 5 exit evidence paths/
  )
  assert.throws(
    () => parseSeriesArguments(['--source', 'mic', '--output', 'series.json', '--minimum-runs', '5', ...exitArguments, ...fiveReports]),
    /--gate-0c-report is required/
  )
  const micSeries = parseSeriesArguments(['--source', 'mic', '--output', 'series.json', '--minimum-runs', '5', '--gate-0c-report', 'gate.json', ...exitArguments, ...fiveReports])
  assert.equal(micSeries.gate0cReport, 'gate.json')
  const seriesRunnerSource = fs.readFileSync(path.resolve(__dirname, '../../scripts/run-i2-live-series.ps1'), 'utf8')
  assert.match(seriesRunnerSource, /\[ValidateSet\(5\)\]/)
  assert.match(seriesRunnerSource, /'--gate-0c-report', \$preflightPath/)
  const electronRunIndex = seriesRunnerSource.indexOf("'run-electron-smoke.ps1'")
  const strictVerifyIndex = seriesRunnerSource.indexOf("'verify-i2-live-report.js'", electronRunIndex)
  const strictVerifyGuardIndex = seriesRunnerSource.indexOf('I2 report verification failed', strictVerifyIndex)
  const exitWriterIndex = seriesRunnerSource.indexOf("'write-i2-exact-child-exit.js'", strictVerifyGuardIndex)
  const exitWriterGuardIndex = seriesRunnerSource.indexOf('I2 exact child exit evidence failed', exitWriterIndex)
  assert.ok(electronRunIndex >= 0 && strictVerifyIndex > electronRunIndex && strictVerifyGuardIndex > strictVerifyIndex &&
    exitWriterIndex > strictVerifyGuardIndex && exitWriterGuardIndex > exitWriterIndex,
  'exit evidence must be written only after the exact Electron process returns zero and the child report passes strict verification')
  assert.match(seriesRunnerSource, /'--exit-evidence', \$exitEvidencePath/)
  const childFreshnessIndex = seriesRunnerSource.indexOf('(Test-Path -LiteralPath $reportPath)')
  const proofFreshnessIndex = seriesRunnerSource.indexOf('(Test-Path -LiteralPath $exitEvidencePath)', childFreshnessIndex)
  const summaryFreshnessIndexes = [...seriesRunnerSource.matchAll(/Test-Path -LiteralPath \$summaryPath/g)]
    .map((match) => match.index)
  const summaryWriterIndex = seriesRunnerSource.indexOf("'summarize-i2-live-series.js'")
  assert.ok(childFreshnessIndex >= 0 && proofFreshnessIndex > childFreshnessIndex && childFreshnessIndex < electronRunIndex,
    'each authoritative child run must reject stale report or exit evidence before Electron starts')
  assert.equal(summaryFreshnessIndexes.length, 2,
    'series runner must reject a stale summary before running and recheck before generation')
  assert.ok(summaryFreshnessIndexes[1] < summaryWriterIndex,
    'series summary freshness must be checked after child runs and before the summary writer')
  const electronRunnerSource = fs.readFileSync(path.resolve(__dirname, '../../scripts/run-electron-smoke.ps1'), 'utf8')
  assert.match(electronRunnerSource, /\[ValidateRange\(5, 600\)\]/)
  assert.match(electronRunnerSource, /\$process\.WaitForExit\(\$TimeoutSeconds \* 1000\)/)
  assert.match(electronRunnerSource, /\$process\.Kill\(\)/,
    'timeout cleanup must target only the exact process object started by the runner')
  assert.doesNotMatch(electronRunnerSource, /Get-Process|taskkill|Stop-Process/,
    'the runner must not enumerate or terminate Electron by process name')

  const failureReport = buildFailureReport({
    sourceId: 'mic',
    phases: ['starting', 'private transcript', 'error'],
    error: '\\\\private-host\\recording.wav transcript: private words'
  })
  assert.deepEqual(failureReport, {
    schemaVersion: 5,
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

test('I2 refinement observation returns early and stops at its fixed timeout without wall-clock waiting', async () => {
  assert.equal(REFINEMENT_OBSERVATION_POLL_MS, 100)

  let immediateSleepCalls = 0
  assert.equal(await waitForRefinementObservation(
    [{ kind: 'refined' }],
    { now: () => 0, sleep: async () => { immediateSleepCalls += 1 } }
  ), true)
  assert.equal(immediateSleepCalls, 0)

  const captions = [{ kind: 'final' }]
  let earlyClockMs = 0
  assert.equal(await waitForRefinementObservation(captions, {
    now: () => earlyClockMs,
    sleep: async (milliseconds) => {
      earlyClockMs += milliseconds
      if (earlyClockMs === 300) captions.push({ kind: 'refined' })
    }
  }), true)
  assert.equal(earlyClockMs, 300, 'a real refinement must end observation immediately')

  let timeoutClockMs = 0
  assert.equal(await waitForRefinementObservation([{ kind: 'final' }], {
    now: () => timeoutClockMs,
    sleep: async (milliseconds) => { timeoutClockMs += milliseconds }
  }), false)
  assert.equal(timeoutClockMs, REFINEMENT_OBSERVATION_TIMEOUT_MS,
    'a missing refinement must not extend the fixed observation bound')

  const boundaryCaptions = [{ kind: 'final' }]
  let boundaryClockMs = 0
  assert.equal(await waitForRefinementObservation(boundaryCaptions, {
    pollMs: REFINEMENT_OBSERVATION_TIMEOUT_MS,
    now: () => boundaryClockMs,
    sleep: async (milliseconds) => {
      boundaryClockMs += milliseconds
      boundaryCaptions.push({ kind: 'refined' })
    }
  }), false, 'a refinement arriving at the monotonic deadline must remain timed out')
  assert.equal(boundaryClockMs, REFINEMENT_OBSERVATION_TIMEOUT_MS)

  assert.equal(isRefinementEvidenceMissing({
    observationTimedOut: true,
    finalCount: 1,
    refinedCount: 1
  }), true, 'a refinement arriving during Stop cannot erase a frozen observation timeout')
  assert.equal(isRefinementEvidenceMissing({
    observationTimedOut: false,
    finalCount: 1,
    refinedCount: 1
  }), false)
  assert.equal(isRefinementEvidenceMissing({
    observationTimedOut: false,
    finalCount: 1,
    refinedCount: 0
  }), true)
})

test('I2 runner can print only the text-free provisional worker counters for diagnosis', () => {
  const summary = provisionalDiagnosticsSummary({
    worker: {
      sources: {
        loopback: {
          provisionalCandidatesStarted: 1,
          provisionalFramesFed: 8,
          provisionalAudioMsFed: 320,
          provisionalDiscards: 0,
          provisionalSuppressions: 0,
          provisionalConfirmed: 1,
          provisionalConfirmedAfterSuppression: 0,
          provisionalFirstCandidateFrameSequence: 15,
          provisionalFirstCandidateAudioTimestampMs: 600,
          provisionalLastCandidateFirstFrameSequence: 15,
          provisionalLastCandidateFirstAudioTimestampMs: 600,
          provisionalLastCandidateFramesFed: 8,
          provisionalLastCandidateAudioMs: 320,
          provisionalMaxCandidateAudioMs: 320,
          text: 'must never leave worker diagnostics'
        }
      }
    }
  }, 'loopback')
  assert.deepEqual(summary, {
    provisionalCandidatesStarted: 1,
    provisionalFramesFed: 8,
    provisionalAudioMsFed: 320,
    provisionalDiscards: 0,
    provisionalSuppressions: 0,
    provisionalConfirmed: 1,
    provisionalConfirmedAfterSuppression: 0,
    provisionalFirstCandidateFrameSequence: 15,
    provisionalFirstCandidateAudioTimestampMs: 600,
    provisionalLastCandidateFirstFrameSequence: 15,
    provisionalLastCandidateFirstAudioTimestampMs: 600,
    provisionalLastCandidateFramesFed: 8,
    provisionalLastCandidateAudioMs: 320,
    provisionalMaxCandidateAudioMs: 320
  })
  assert.doesNotMatch(JSON.stringify(summary), /text|pcm|audio path/i)
})

test('a delayed timing probe arm must settle before controlled playback is scheduled', async () => {
  const calls = []
  let releaseProbe
  const probeGate = new Promise((resolve) => { releaseProbe = resolve })
  const window = {
    webContents: {
      async executeJavaScript (source, userGesture) {
        calls.push(['playback-start', source, userGesture])
        return { started: true, clockId: 'playback-renderer-performance-v1', sourceStartClockMs: 1234 }
      }
    }
  }
  let scheduledSourceStartMainClockMs = null
  const startPromise = startPreparedPlaybackAfterProbe(window, { offsetToMainMs: 0 }, async (sourceStartMainClockMs) => {
    scheduledSourceStartMainClockMs = sourceStartMainClockMs
    calls.push(['probe-start', sourceStartMainClockMs])
    await probeGate
    calls.push(['probe-ready', sourceStartMainClockMs])
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'probe-start')
  assert.equal(calls[0][1], scheduledSourceStartMainClockMs)
  releaseProbe()
  const started = await startPromise
  assert.deepEqual(calls.slice(0, 2), [
    ['probe-start', scheduledSourceStartMainClockMs],
    ['probe-ready', scheduledSourceStartMainClockMs]
  ])
  assert.equal(calls[2][0], 'playback-start')
  assert.match(calls[2][1], /^globalThis\.startPreparedPcm16\(\{"notBeforeClockMs":[0-9.]+\}\)$/)
  assert.equal(JSON.parse(calls[2][1].slice(
    'globalThis.startPreparedPcm16('.length,
    -1
  )).notBeforeClockMs, scheduledSourceStartMainClockMs)
  assert.equal(calls[2][2], true)
  assert.equal(started.sourceStartClockMs, 1234)
})

test('runner report builder emits the closed, text-free schema5 root shape', () => {
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
    latencyTrace: null,
    latencyDiagnostics: null,
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
  assert.deepEqual(Object.keys(report).sort(), [...ROOT_KEYS].sort())
  assert.equal(report.schemaVersion, 5)
  assert.equal(report.input.selection, 'system-default')
  assert.equal(report.input.matchedLabelHashCount, null)
  assert.equal(report.privacy.reportContainsTranscriptText, false)
  assert.doesNotMatch(JSON.stringify(report), /joined(?:Final|Refined)Text|captionArrivals|capturedPcmBase64|"text"\s*:/i)
})
