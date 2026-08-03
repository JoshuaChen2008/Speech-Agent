'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { runOnline } = require('./cli-bench')
const {
  characterErrorRate,
  percentile,
  punctuationMetrics,
  wordErrorRate
} = require('./metrics')
const {
  readAndValidateRealtimeCandidateRegistry,
  selectRealtimeCandidate
} = require('./realtime-candidate-registry')
const { parseStrictEvidenceJson } = require('../strict-evidence-json')

const SHA256 = /^[a-f0-9]{64}$/
const EXPECTED_CLI_VERSION = '1.13.4'

function exactKeys (value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} keys must be exactly [${wanted.join(', ')}]`)
  }
  return value
}

function requireFiniteNonNegative (value, label) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be finite and non-negative`)
  return value
}

function sha256 (value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function average (values) {
  if (!Array.isArray(values) || values.length === 0) throw new TypeError('average requires values')
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function readStrictJsonWithSha256 (file, label) {
  const bytes = fs.readFileSync(path.resolve(file))
  return {
    value: parseStrictEvidenceJson(bytes, label),
    sha256: sha256(bytes)
  }
}

function validateCorpus (corpus, candidate) {
  exactKeys(corpus, ['bitsPerSample', 'cases', 'channels', 'sampleRate', 'schemaVersion'], 'candidate corpus')
  if (corpus.schemaVersion !== 1 || corpus.sampleRate !== 16000 || corpus.bitsPerSample !== 16 ||
      corpus.channels !== 1 || !Array.isArray(corpus.cases) || corpus.cases.length !== 4) {
    throw new Error('candidate corpus envelope differs from the frozen benchmark')
  }
  const ids = new Set()
  for (const item of corpus.cases) {
    if (!item || typeof item.id !== 'string' || typeof item.category !== 'string' ||
        typeof item.reference !== 'string' || item.reference.length === 0 || ids.has(item.id)) {
      throw new Error('candidate corpus case is invalid')
    }
    ids.add(item.id)
  }
  if (!ids.has('en-onboarding') || !ids.has('zh-en-code-switch')) {
    throw new Error('candidate corpus is missing frozen English or code-switch cases')
  }
  return corpus
}

function validateCandidateBinding (binding, candidate, registrySha256) {
  exactKeys(binding, [
    'archiveBytes', 'archiveSha256', 'candidateId', 'candidateRegistrySha256',
    'evaluationOnly', 'productionApproved'
  ], 'streaming candidate binding')
  if (binding.candidateId !== candidate.id || binding.candidateRegistrySha256 !== registrySha256 ||
      binding.archiveBytes !== candidate.archive.bytes || binding.archiveSha256 !== candidate.archive.sha256 ||
      binding.evaluationOnly !== true || binding.productionApproved !== false) {
    throw new Error('streaming report candidate binding differs from the registry')
  }
}

function validateStreamingRun (run, label) {
  exactKeys(run, ['finalTranscriptSha256', 'firstPartial', 'processingMs', 'processingRtf'], label)
  requireFiniteNonNegative(run.processingMs, `${label}.processingMs`)
  requireFiniteNonNegative(run.processingRtf, `${label}.processingRtf`)
  if (!SHA256.test(run.finalTranscriptSha256)) throw new TypeError(`${label}.finalTranscriptSha256 is invalid`)
  exactKeys(run.firstPartial, [
    'audioFedMs', 'audioNeededAfterSpeechOnsetMs', 'latencyFromSpeechOnsetMs',
    'transcriptSha256', 'wallFromStartMs'
  ], `${label}.firstPartial`)
  for (const field of ['audioFedMs', 'audioNeededAfterSpeechOnsetMs', 'latencyFromSpeechOnsetMs', 'wallFromStartMs']) {
    requireFiniteNonNegative(run.firstPartial[field], `${label}.firstPartial.${field}`)
  }
  if (!SHA256.test(run.firstPartial.transcriptSha256)) {
    throw new TypeError(`${label}.firstPartial.transcriptSha256 is invalid`)
  }
}

function validateStreamingReport (report, candidate, registrySha256, corpus) {
  exactKeys(report, [
    'candidateBinding', 'cases', 'chunkMs', 'engine', 'engineVersion', 'model',
    'modelLoadMs', 'modelType', 'numThreads', 'paced', 'privacy',
    'runsPerCase', 'schemaVersion'
  ], 'streaming report')
  if (report.schemaVersion !== 2 || report.engine !== 'sherpa-onnx-node' ||
      report.engineVersion !== EXPECTED_CLI_VERSION || report.model !== candidate.runtime.directoryName ||
      report.modelType !== candidate.runtime.modelType || report.numThreads !== candidate.runtime.numThreads ||
      report.chunkMs !== candidate.benchmark.chunkMs || report.paced !== true ||
      report.runsPerCase !== candidate.benchmark.runsPerCase) {
    throw new Error('streaming report does not match the registered benchmark profile')
  }
  requireFiniteNonNegative(report.modelLoadMs, 'streaming report modelLoadMs')
  validateCandidateBinding(report.candidateBinding, candidate, registrySha256)
  exactKeys(report.privacy, ['audioFileNamePersisted', 'transcriptTextPersisted'], 'streaming privacy')
  if (report.privacy.audioFileNamePersisted !== false || report.privacy.transcriptTextPersisted !== false) {
    throw new Error('streaming report privacy projection is invalid')
  }
  if (!Array.isArray(report.cases) || report.cases.length !== corpus.cases.length) {
    throw new Error('streaming report case count differs from the frozen corpus')
  }

  const expectedIds = corpus.cases.map((item) => item.id)
  report.cases.forEach((item, caseIndex) => {
    const label = `streaming report case ${caseIndex}`
    exactKeys(item, [
      'durationSeconds', 'firstPartialLatencyMs', 'id', 'processingRtf', 'runs',
      'sampleRate', 'samples', 'speechOnsetMs'
    ], label)
    if (item.id !== expectedIds[caseIndex] || item.sampleRate !== 16000 ||
        !Number.isSafeInteger(item.samples) || item.samples < 1) {
      throw new Error(`${label} identity differs from the frozen corpus`)
    }
    for (const field of ['durationSeconds', 'speechOnsetMs']) {
      requireFiniteNonNegative(item[field], `${label}.${field}`)
    }
    exactKeys(item.firstPartialLatencyMs, ['p50', 'p95', 'samples'], `${label}.firstPartialLatencyMs`)
    exactKeys(item.processingRtf, ['p50', 'p95'], `${label}.processingRtf`)
    requireFiniteNonNegative(item.firstPartialLatencyMs.p50, `${label}.firstPartialLatencyMs.p50`)
    requireFiniteNonNegative(item.firstPartialLatencyMs.p95, `${label}.firstPartialLatencyMs.p95`)
    requireFiniteNonNegative(item.processingRtf.p50, `${label}.processingRtf.p50`)
    requireFiniteNonNegative(item.processingRtf.p95, `${label}.processingRtf.p95`)
    if (!Array.isArray(item.firstPartialLatencyMs.samples) ||
        item.firstPartialLatencyMs.samples.length !== candidate.benchmark.runsPerCase ||
        !Array.isArray(item.runs) || item.runs.length !== candidate.benchmark.runsPerCase) {
      throw new Error(`${label} does not contain the registered number of runs`)
    }
    item.firstPartialLatencyMs.samples.forEach((value, index) => {
      requireFiniteNonNegative(value, `${label}.firstPartialLatencyMs.samples[${index}]`)
    })
    item.runs.forEach((run, runIndex) => validateStreamingRun(run, `${label}.runs[${runIndex}]`))
    const latencySamples = item.runs.map((run) => run.firstPartial.latencyFromSpeechOnsetMs)
    const processingRtfSamples = item.runs.map((run) => run.processingRtf)
    if (JSON.stringify(item.firstPartialLatencyMs.samples) !== JSON.stringify(latencySamples) ||
        item.firstPartialLatencyMs.p50 !== percentile(latencySamples, 0.5) ||
        item.firstPartialLatencyMs.p95 !== percentile(latencySamples, 0.95) ||
        item.processingRtf.p50 !== percentile(processingRtfSamples, 0.5) ||
        item.processingRtf.p95 !== percentile(processingRtfSamples, 0.95)) {
      throw new Error(`${label} aggregates are inconsistent with its five runs`)
    }
  })
  return report
}

function buildCandidateEvaluationReport (input) {
  const {
    candidate, candidateRegistrySha256, cliVersionOutputSha256, corpus,
    corpusSha256, onlineReport, streamingReport, streamingReportSha256
  } = input
  validateCorpus(corpus, candidate)
  validateStreamingReport(streamingReport, candidate, candidateRegistrySha256, corpus)
  if (!SHA256.test(candidateRegistrySha256) || !SHA256.test(corpusSha256) ||
      !SHA256.test(streamingReportSha256) || !SHA256.test(cliVersionOutputSha256)) {
    throw new TypeError('candidate evaluation binding SHA-256 is invalid')
  }
  const expectedOnlineMode = candidate.runtime.modelType === 'paraformer'
    ? 'online-paraformer'
    : 'online-transducer'
  if (!onlineReport || onlineReport.id !== candidate.id || onlineReport.mode !== expectedOnlineMode ||
      onlineReport.numThreads !== candidate.runtime.numThreads || !Array.isArray(onlineReport.samples) ||
      onlineReport.samples.length !== corpus.cases.length || !SHA256.test(onlineReport.rawOutputSha256)) {
    throw new Error('CLI observation does not match the registered candidate')
  }

  const samples = new Map(onlineReport.samples.map((sample) => [sample.wav, sample]))
  const cases = corpus.cases.map((item) => {
    const sample = samples.get(`${item.id}.wav`)
    const streaming = streamingReport.cases.find((entry) => entry.id === item.id)
    if (!sample || !streaming || typeof sample.text !== 'string' || !sample.result) {
      throw new Error(`candidate observation is missing case ${item.id}`)
    }
    const cer = characterErrorRate(item.reference, sample.text)
    const wer = item.category === 'en' ? wordErrorRate(item.reference, sample.text) : null
    const audioNeeded = streaming.runs.map((run) => run.firstPartial.audioNeededAfterSpeechOnsetMs)
    return {
      id: item.id,
      category: item.category,
      referenceSha256: sha256(item.reference),
      transcriptSha256: sha256(sample.text),
      resultSha256: sha256(JSON.stringify(sample.result)),
      cer,
      wer,
      punctuation: punctuationMetrics(item.reference, sample.text),
      cli: {
        elapsedSeconds: requireFiniteNonNegative(sample.elapsedSeconds, `${item.id}.elapsedSeconds`),
        durationSeconds: requireFiniteNonNegative(sample.durationSeconds, `${item.id}.durationSeconds`),
        rtf: requireFiniteNonNegative(sample.rtf, `${item.id}.rtf`)
      },
      streaming: {
        firstPartialP95Ms: streaming.firstPartialLatencyMs.p95,
        audioNeededAfterSpeechOnsetMsMax: Math.max(...audioNeeded),
        processingRtfP95: streaming.processingRtf.p95
      }
    }
  })
  if (samples.size !== cases.length) throw new Error('CLI observation contains an unexpected case')

  const macroCer = average(cases.map((item) => item.cer))
  const englishCases = cases.filter((item) => item.wer !== null)
  const englishWer = average(englishCases.map((item) => item.wer))
  const cliRtfMax = Math.max(...cases.map((item) => item.cli.rtf))
  const firstPartialP95MaxMs = Math.max(...cases.map((item) => item.streaming.firstPartialP95Ms))
  const codeSwitch = cases.find((item) => item.id === 'zh-en-code-switch')
  const checks = {
    cliRtf: cliRtfMax < candidate.benchmark.cliRtfLimitExclusive,
    macroCer: macroCer <= candidate.benchmark.macroCerLimitInclusive,
    englishWer: englishWer <= candidate.benchmark.englishWerLimitInclusive,
    firstPartial: firstPartialP95MaxMs < candidate.benchmark.firstPartialLimitMsExclusive
  }

  return {
    schemaVersion: 1,
    kind: 'gate-0b-realtime-candidate-evaluation',
    semanticRefs: ['SEM-F17', 'SEM-T11', 'SEM-T14', 'J1', 'J14'],
    candidateBinding: {
      candidateId: candidate.id,
      candidateRegistrySha256,
      archiveBytes: candidate.archive.bytes,
      archiveSha256: candidate.archive.sha256,
      evaluationOnly: true,
      productionApproved: false
    },
    evidenceBindings: {
      corpusSha256,
      streamingReportSha256,
      cliRawOutputSha256: onlineReport.rawOutputSha256,
      cliVersionOutputSha256
    },
    runtime: {
      cliVersion: EXPECTED_CLI_VERSION,
      provider: candidate.runtime.provider,
      numThreads: candidate.runtime.numThreads,
      recognizerLoadSeconds: requireFiniteNonNegative(onlineReport.recognizerLoadSeconds, 'recognizerLoadSeconds')
    },
    cases,
    aggregate: {
      cliRtfMax,
      macroCer,
      englishWer,
      firstPartialP95MaxMs
    },
    criteria: {
      cliRtf: {
        limitExclusive: candidate.benchmark.cliRtfLimitExclusive,
        observedMax: cliRtfMax,
        result: checks.cliRtf ? 'pass' : 'fail'
      },
      macroCer: {
        limitInclusive: candidate.benchmark.macroCerLimitInclusive,
        observed: macroCer,
        result: checks.macroCer ? 'pass' : 'fail'
      },
      englishWer: {
        limitInclusive: candidate.benchmark.englishWerLimitInclusive,
        observed: englishWer,
        result: checks.englishWer ? 'pass' : 'fail'
      },
      firstPartial: {
        limitExclusiveMs: candidate.benchmark.firstPartialLimitMsExclusive,
        observedP95MaxMs: firstPartialP95MaxMs,
        result: checks.firstPartial ? 'pass' : 'fail'
      },
      conditionalCodeSwitchAudioNeedScreen: {
        limitExclusiveMs: candidate.benchmark.conditionalCodeSwitchAudioNeedScreenMs,
        observedMaxMs: codeSwitch.streaming.audioNeededAfterSpeechOnsetMsMax,
        result: codeSwitch.streaming.audioNeededAfterSpeechOnsetMsMax <
          candidate.benchmark.conditionalCodeSwitchAudioNeedScreenMs ? 'pass' : 'fail',
        releaseGate: candidate.benchmark.conditionalScreenIsReleaseGate
      },
      realtimePunctuationReplacementGate: candidate.benchmark.realtimePunctuationIsReplacementGate,
      eligibleForProductionSelection: Object.values(checks).every(Boolean),
      productionApproved: false
    },
    privacy: {
      absolutePathPersisted: false,
      audioFileNamePersisted: false,
      transcriptTextPersisted: false
    }
  }
}

function validateCandidateEvaluationReport (report, candidate, registrySha256, corpus) {
  exactKeys(report, [
    'aggregate', 'candidateBinding', 'cases', 'criteria', 'evidenceBindings',
    'kind', 'privacy', 'runtime', 'schemaVersion', 'semanticRefs'
  ], 'candidate evaluation report')
  if (report.schemaVersion !== 1 || report.kind !== 'gate-0b-realtime-candidate-evaluation' ||
      JSON.stringify(report.semanticRefs) !== JSON.stringify(['SEM-F17', 'SEM-T11', 'SEM-T14', 'J1', 'J14'])) {
    throw new Error('candidate evaluation report envelope is invalid')
  }
  validateCorpus(corpus, candidate)
  validateCandidateBinding(report.candidateBinding, candidate, registrySha256)
  exactKeys(report.evidenceBindings, [
    'cliRawOutputSha256', 'cliVersionOutputSha256', 'corpusSha256', 'streamingReportSha256'
  ], 'candidate evaluation evidence bindings')
  for (const [name, value] of Object.entries(report.evidenceBindings)) {
    if (!SHA256.test(value)) throw new TypeError(`candidate evaluation ${name} is invalid`)
  }
  if (report.evidenceBindings.corpusSha256 !== candidate.benchmark.corpusSha256) {
    throw new Error('candidate evaluation corpus binding differs from the registry')
  }
  exactKeys(report.runtime, [
    'cliVersion', 'numThreads', 'provider', 'recognizerLoadSeconds'
  ], 'candidate evaluation runtime')
  if (report.runtime.cliVersion !== EXPECTED_CLI_VERSION ||
      report.runtime.numThreads !== candidate.runtime.numThreads ||
      report.runtime.provider !== candidate.runtime.provider) {
    throw new Error('candidate evaluation runtime differs from the registry')
  }
  requireFiniteNonNegative(report.runtime.recognizerLoadSeconds, 'candidate evaluation recognizerLoadSeconds')
  if (!Array.isArray(report.cases) || report.cases.length !== corpus.cases.length) {
    throw new Error('candidate evaluation case count differs from the frozen corpus')
  }

  report.cases.forEach((item, index) => {
    const expected = corpus.cases[index]
    const label = `candidate evaluation case ${index}`
    exactKeys(item, [
      'category', 'cer', 'cli', 'id', 'punctuation', 'referenceSha256',
      'resultSha256', 'streaming', 'transcriptSha256', 'wer'
    ], label)
    if (item.id !== expected.id || item.category !== expected.category ||
        item.referenceSha256 !== sha256(expected.reference) ||
        !SHA256.test(item.transcriptSha256) || !SHA256.test(item.resultSha256)) {
      throw new Error(`${label} identity or digest differs from the frozen corpus`)
    }
    requireFiniteNonNegative(item.cer, `${label}.cer`)
    if (expected.category === 'en') {
      requireFiniteNonNegative(item.wer, `${label}.wer`)
    } else if (item.wer !== null) {
      throw new Error(`${label}.wer must be null outside the English case`)
    }
    exactKeys(item.punctuation, [
      'f1', 'hypothesisCount', 'precision', 'recall', 'referenceCount'
    ], `${label}.punctuation`)
    for (const field of ['f1', 'hypothesisCount', 'precision', 'recall', 'referenceCount']) {
      requireFiniteNonNegative(item.punctuation[field], `${label}.punctuation.${field}`)
    }
    exactKeys(item.cli, ['durationSeconds', 'elapsedSeconds', 'rtf'], `${label}.cli`)
    for (const field of ['durationSeconds', 'elapsedSeconds', 'rtf']) {
      requireFiniteNonNegative(item.cli[field], `${label}.cli.${field}`)
    }
    exactKeys(item.streaming, [
      'audioNeededAfterSpeechOnsetMsMax', 'firstPartialP95Ms', 'processingRtfP95'
    ], `${label}.streaming`)
    for (const field of ['audioNeededAfterSpeechOnsetMsMax', 'firstPartialP95Ms', 'processingRtfP95']) {
      requireFiniteNonNegative(item.streaming[field], `${label}.streaming.${field}`)
    }
  })

  const expectedAggregate = {
    cliRtfMax: Math.max(...report.cases.map((item) => item.cli.rtf)),
    macroCer: average(report.cases.map((item) => item.cer)),
    englishWer: average(report.cases.filter((item) => item.wer !== null).map((item) => item.wer)),
    firstPartialP95MaxMs: Math.max(...report.cases.map((item) => item.streaming.firstPartialP95Ms))
  }
  exactKeys(report.aggregate, Object.keys(expectedAggregate), 'candidate evaluation aggregate')
  for (const [name, value] of Object.entries(expectedAggregate)) {
    if (report.aggregate[name] !== value) throw new Error(`candidate evaluation aggregate ${name} is inconsistent`)
  }

  exactKeys(report.criteria, [
    'cliRtf', 'conditionalCodeSwitchAudioNeedScreen', 'eligibleForProductionSelection',
    'englishWer', 'firstPartial', 'macroCer', 'productionApproved',
    'realtimePunctuationReplacementGate'
  ], 'candidate evaluation criteria')
  const expectedChecks = {
    cliRtf: expectedAggregate.cliRtfMax < candidate.benchmark.cliRtfLimitExclusive,
    macroCer: expectedAggregate.macroCer <= candidate.benchmark.macroCerLimitInclusive,
    englishWer: expectedAggregate.englishWer <= candidate.benchmark.englishWerLimitInclusive,
    firstPartial: expectedAggregate.firstPartialP95MaxMs < candidate.benchmark.firstPartialLimitMsExclusive
  }
  const criteriaShapes = {
    cliRtf: ['limitExclusive', 'observedMax', 'result'],
    macroCer: ['limitInclusive', 'observed', 'result'],
    englishWer: ['limitInclusive', 'observed', 'result'],
    firstPartial: ['limitExclusiveMs', 'observedP95MaxMs', 'result']
  }
  for (const [name, keys] of Object.entries(criteriaShapes)) {
    exactKeys(report.criteria[name], keys, `candidate evaluation criteria ${name}`)
    if (report.criteria[name].result !== (expectedChecks[name] ? 'pass' : 'fail')) {
      throw new Error(`candidate evaluation criteria ${name} result is inconsistent`)
    }
  }
  if (report.criteria.cliRtf.limitExclusive !== candidate.benchmark.cliRtfLimitExclusive ||
      report.criteria.cliRtf.observedMax !== expectedAggregate.cliRtfMax ||
      report.criteria.macroCer.limitInclusive !== candidate.benchmark.macroCerLimitInclusive ||
      report.criteria.macroCer.observed !== expectedAggregate.macroCer ||
      report.criteria.englishWer.limitInclusive !== candidate.benchmark.englishWerLimitInclusive ||
      report.criteria.englishWer.observed !== expectedAggregate.englishWer ||
      report.criteria.firstPartial.limitExclusiveMs !== candidate.benchmark.firstPartialLimitMsExclusive ||
      report.criteria.firstPartial.observedP95MaxMs !== expectedAggregate.firstPartialP95MaxMs) {
    throw new Error('candidate evaluation criteria observations differ from the aggregate or registry')
  }
  const codeSwitch = report.cases.find((item) => item.id === 'zh-en-code-switch')
  const conditionalPass = codeSwitch.streaming.audioNeededAfterSpeechOnsetMsMax <
    candidate.benchmark.conditionalCodeSwitchAudioNeedScreenMs
  exactKeys(report.criteria.conditionalCodeSwitchAudioNeedScreen, [
    'limitExclusiveMs', 'observedMaxMs', 'releaseGate', 'result'
  ], 'candidate evaluation conditional code-switch screen')
  if (report.criteria.conditionalCodeSwitchAudioNeedScreen.limitExclusiveMs !==
        candidate.benchmark.conditionalCodeSwitchAudioNeedScreenMs ||
      report.criteria.conditionalCodeSwitchAudioNeedScreen.observedMaxMs !==
        codeSwitch.streaming.audioNeededAfterSpeechOnsetMsMax ||
      report.criteria.conditionalCodeSwitchAudioNeedScreen.releaseGate !== false ||
      report.criteria.conditionalCodeSwitchAudioNeedScreen.result !== (conditionalPass ? 'pass' : 'fail') ||
      report.criteria.realtimePunctuationReplacementGate !== false ||
      report.criteria.eligibleForProductionSelection !== Object.values(expectedChecks).every(Boolean) ||
      report.criteria.productionApproved !== false) {
    throw new Error('candidate evaluation selection criteria are inconsistent')
  }
  exactKeys(report.privacy, [
    'absolutePathPersisted', 'audioFileNamePersisted', 'transcriptTextPersisted'
  ], 'candidate evaluation privacy')
  if (Object.values(report.privacy).some((value) => value !== false)) {
    throw new Error('candidate evaluation privacy projection is invalid')
  }
  return report
}

function parseArguments (argv) {
  const options = {}
  const allowed = new Set([
    '--candidate-registry', '--candidate-id', '--model-dir', '--cli-bin',
    '--corpus', '--wav-dir', '--streaming-report', '--output'
  ])
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!allowed.has(name) || !value) throw new Error('candidate evaluation arguments are incomplete or unknown')
    options[name.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
  }
  const required = [
    'candidateRegistry', 'candidateId', 'modelDir', 'cliBin',
    'corpus', 'wavDir', 'streamingReport', 'output'
  ]
  if (required.some((name) => !options[name])) throw new Error(`required arguments: ${required.join(', ')}`)
  return options
}

function readCliVersion (cliBin) {
  const executable = path.join(cliBin, 'sherpa-onnx-version.exe')
  const child = spawnSync(executable, [], { cwd: cliBin, encoding: 'utf8', windowsHide: true })
  if (child.error) throw child.error
  if (child.status !== 0) throw new Error('sherpa-onnx-version.exe failed')
  const output = [child.stdout, child.stderr].filter(Boolean).join('\n')
  const match = output.match(/sherpa-onnx version\s*:\s*([^\s]+)/i)
  if (!match || match[1] !== EXPECTED_CLI_VERSION) throw new Error('unexpected sherpa-onnx CLI version')
  return { sha256: sha256(output) }
}

function main () {
  const options = parseArguments(process.argv.slice(2))
  const registryEvidence = readAndValidateRealtimeCandidateRegistry(options.candidateRegistry)
  const candidate = selectRealtimeCandidate(registryEvidence.registry, options.candidateId)
  const modelDir = path.resolve(options.modelDir)
  const cliBin = path.resolve(options.cliBin)
  if (path.basename(modelDir) !== candidate.runtime.directoryName) {
    throw new Error('candidate model directory does not match the registered directory name')
  }
  for (const fileName of Object.values(candidate.runtime.requiredFiles)) {
    if (!fs.statSync(path.join(modelDir, fileName), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`candidate runtime file is missing: ${fileName}`)
    }
  }

  const corpusEvidence = readStrictJsonWithSha256(options.corpus, 'candidate corpus')
  if (corpusEvidence.sha256 !== candidate.benchmark.corpusSha256) {
    throw new Error('candidate corpus SHA-256 differs from the registry')
  }
  const corpus = validateCorpus(corpusEvidence.value, candidate)
  const streamingEvidence = readStrictJsonWithSha256(options.streamingReport, 'candidate streaming report')
  validateStreamingReport(streamingEvidence.value, candidate, registryEvidence.sha256, corpus)
  const cliVersion = readCliVersion(cliBin)
  const wavDirectory = path.resolve(options.wavDir)
  const wavs = corpus.cases.map((item) => path.join(wavDirectory, `${item.id}.wav`))
  wavs.forEach((wav) => {
    if (!fs.statSync(wav, { throwIfNoEntry: false })?.isFile()) throw new Error('candidate corpus WAV is missing')
  })
  const online = runOnline({
    id: candidate.id,
    cliBin,
    modelType: candidate.runtime.modelType,
    numThreads: candidate.runtime.numThreads,
    model: Object.fromEntries(Object.entries(candidate.runtime.requiredFiles).map(([role, file]) => [role, path.join(modelDir, file)])),
    wavs
  })
  const report = buildCandidateEvaluationReport({
    candidate,
    candidateRegistrySha256: registryEvidence.sha256,
    cliVersionOutputSha256: cliVersion.sha256,
    corpus,
    corpusSha256: corpusEvidence.sha256,
    onlineReport: online.report,
    streamingReport: streamingEvidence.value,
    streamingReportSha256: streamingEvidence.sha256
  })
  validateCandidateEvaluationReport(report, candidate, registryEvidence.sha256, corpus)
  const outputPath = path.resolve(options.output)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2) + '\n')
}

module.exports = {
  buildCandidateEvaluationReport,
  validateCandidateEvaluationReport,
  validateStreamingReport
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
}
