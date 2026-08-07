'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  buildCandidateEvaluationReport,
  validateCandidateEvaluationReport,
  validateStreamingReport
} = require('../../scripts/gate-0b/evaluate-realtime-candidate')
const {
  validateRealtimeCandidateSummary
} = require('../../scripts/gate-0b/summarize-realtime-candidates')
const {
  readAndValidateRealtimeCandidateRegistry,
  selectRealtimeCandidate
} = require('../../scripts/gate-0b/realtime-candidate-registry')
const { parseStrictEvidenceJson } = require('../../scripts/strict-evidence-json')

const ROOT = path.resolve(__dirname, '../..')
const REGISTRY_PATH = path.join(ROOT, 'scripts/gate-0b/realtime-candidates.json')
const CORPUS_PATH = path.join(ROOT, 'scripts/gate-0b/corpus.json')
const SUMMARY_PATH = path.join(ROOT, 'docs/validation/gate-0b-realtime-candidate-summary.json')
const PRODUCTION_MANIFEST_PATH = path.join(ROOT, 'src/main/services/model-manifest.js')
const registryEvidence = readAndValidateRealtimeCandidateRegistry(REGISTRY_PATH)
const candidate = selectRealtimeCandidate(registryEvidence.registry, 'zipformer-bilingual-zh-en-2023-02-20')
const paraformer = selectRealtimeCandidate(registryEvidence.registry, 'paraformer-bilingual-zh-en')
const corpusBytes = fs.readFileSync(CORPUS_PATH)
const corpus = JSON.parse(corpusBytes)
const corpusSha256 = crypto.createHash('sha256').update(corpusBytes).digest('hex')
const HASH = 'a'.repeat(64)

function makeStreamingReport (profile = candidate) {
  return {
    schemaVersion: 2,
    engine: 'sherpa-onnx-node',
    engineVersion: '1.13.4',
    model: profile.runtime.directoryName,
    modelType: profile.runtime.modelType,
    numThreads: profile.runtime.numThreads,
    chunkMs: profile.benchmark.chunkMs,
    paced: true,
    runsPerCase: profile.benchmark.runsPerCase,
    modelLoadMs: 100,
    candidateBinding: {
      candidateId: profile.id,
      candidateRegistrySha256: registryEvidence.sha256,
      archiveBytes: profile.archive.bytes,
      archiveSha256: profile.archive.sha256,
      evaluationOnly: true,
      productionApproved: false
    },
    cases: corpus.cases.map((item, caseIndex) => ({
      id: item.id,
      sampleRate: 16000,
      samples: 16000,
      durationSeconds: 1,
      speechOnsetMs: 140,
      firstPartialLatencyMs: {
        p50: 402,
        p95: 404,
        samples: [400, 401, 402, 403, 404]
      },
      processingRtf: { p50: 0.1, p95: 0.1 },
      runs: Array.from({ length: 5 }, (_, runIndex) => ({
        processingMs: 100,
        processingRtf: 0.1,
        firstPartial: {
          wallFromStartMs: 500,
          audioFedMs: 440,
          latencyFromSpeechOnsetMs: 400 + runIndex,
          audioNeededAfterSpeechOnsetMs: item.id === 'zh-en-code-switch' ? 320 + runIndex : 400,
          transcriptSha256: HASH
        },
        finalTranscriptSha256: HASH
      }))
    })),
    privacy: {
      audioFileNamePersisted: false,
      transcriptTextPersisted: false
    }
  }
}

function makeOnlineReport (profile = candidate) {
  return {
    id: profile.id,
    mode: profile.runtime.modelType === 'paraformer' ? 'online-paraformer' : 'online-transducer',
    numThreads: profile.runtime.numThreads,
    modelFiles: { ...profile.runtime.requiredFiles },
    recognizerLoadSeconds: 1,
    rawOutputSha256: HASH,
    samples: corpus.cases.map((item) => ({
      wav: `${item.id}.wav`,
      numThreads: profile.runtime.numThreads,
      elapsedSeconds: 0.1,
      durationSeconds: 1,
      rtf: 0.1,
      text: item.reference,
      result: { text: item.reference }
    }))
  }
}

function buildReport (overrides = {}, profile = candidate) {
  const streamingReport = overrides.streamingReport || makeStreamingReport(profile)
  return buildCandidateEvaluationReport({
    candidate: profile,
    candidateRegistrySha256: registryEvidence.sha256,
    cliVersionOutputSha256: HASH,
    corpus,
    corpusSha256,
    onlineReport: overrides.onlineReport || makeOnlineReport(profile),
    streamingReport,
    streamingReportSha256: HASH
  })
}

test('Gate 0B candidate evaluation combines CLI quality/RTF and five-run streaming evidence without transcript text', () => {
  const report = buildReport()

  assert.equal(report.aggregate.macroCer, 0)
  assert.equal(report.aggregate.englishWer, 0)
  assert.equal(report.criteria.cliRtf.result, 'pass')
  assert.equal(report.criteria.firstPartial.result, 'pass')
  assert.equal(report.criteria.conditionalCodeSwitchAudioNeedScreen.result, 'pass')
  assert.equal(report.criteria.conditionalCodeSwitchAudioNeedScreen.releaseGate, false)
  assert.equal(report.criteria.eligibleForProductionSelection, true)
  assert.equal(report.criteria.productionApproved, false)

  const serialized = JSON.stringify(report)
  assert.doesNotMatch(serialized, /\.wav/i)
  assert.doesNotMatch(serialized, /[A-Z]:\\/i)
  for (const item of corpus.cases) {
    assert.equal(serialized.includes(item.reference), false)
  }
})

test('Gate 0B candidate evaluation keeps a quality regression evaluation-only', () => {
  const onlineReport = makeOnlineReport()
  onlineReport.samples.find((item) => item.wav === 'zh-en-code-switch.wav').text = '不匹配'
  const report = buildReport({ onlineReport })

  assert.equal(report.criteria.macroCer.result, 'fail')
  assert.equal(report.criteria.eligibleForProductionSelection, false)
  assert.equal(report.criteria.productionApproved, false)
})

test('Gate 0B candidate evaluation accepts the registered Paraformer observation shape without production approval', () => {
  const report = buildReport({}, paraformer)

  assert.equal(report.candidateBinding.candidateId, paraformer.id)
  assert.equal(report.criteria.eligibleForProductionSelection, true)
  assert.equal(report.criteria.productionApproved, false)

  const wrongMode = makeOnlineReport(paraformer)
  wrongMode.mode = 'online-transducer'
  assert.throws(() => buildReport({ onlineReport: wrongMode }, paraformer), /CLI observation/i)
})

test('Gate 0B candidate streaming evidence fails closed on binding, privacy and unknown-field drift', () => {
  const bindingDrift = makeStreamingReport()
  bindingDrift.candidateBinding.productionApproved = true
  assert.throws(() => validateStreamingReport(bindingDrift, candidate, registryEvidence.sha256, corpus), /binding/i)

  const privacyDrift = makeStreamingReport()
  privacyDrift.privacy.transcriptTextPersisted = true
  assert.throws(() => validateStreamingReport(privacyDrift, candidate, registryEvidence.sha256, corpus), /privacy/i)

  const unknownField = makeStreamingReport()
  unknownField.cases[0].transcript = 'forbidden'
  assert.throws(() => validateStreamingReport(unknownField, candidate, registryEvidence.sha256, corpus), /keys must be exactly/i)

  const aggregateDrift = makeStreamingReport()
  aggregateDrift.cases[0].firstPartialLatencyMs.p95 = 399
  assert.throws(() => validateStreamingReport(
    aggregateDrift,
    candidate,
    registryEvidence.sha256,
    corpus
  ), /aggregates are inconsistent/i)
})

test('Gate 0B historical candidate summary reconstructs the no-replacement decision without qualifying the current Draft Recognizer manifest', () => {
  const summaryBytes = fs.readFileSync(SUMMARY_PATH)
  const summary = parseStrictEvidenceJson(summaryBytes, 'tracked realtime candidate summary')
  const historicalSummarySha256 = '682d71b5bb8ff7851ceec15e0673bf52943cc74ca9611f9617306d18c4c08a1f'
  const historicalManifestSha256 = '54af5df4069015927cff2e40dd57314e70306c4e2ce1ebb2bb9807e9a2bf225f'
  const productionManifestSha256 = crypto.createHash('sha256')
    .update(fs.readFileSync(PRODUCTION_MANIFEST_PATH))
    .digest('hex')

  assert.equal(crypto.createHash('sha256').update(summaryBytes).digest('hex'), historicalSummarySha256)
  assert.equal(summary.productionManifestSourceSha256, historicalManifestSha256)

  validateRealtimeCandidateSummary(
    summary,
    registryEvidence,
    corpus,
    historicalManifestSha256
  )
  assert.notEqual(summary.productionManifestSourceSha256, productionManifestSha256)
  assert.equal(summary.candidateRegistrySha256, registryEvidence.sha256)
  assert.equal(summary.candidateEvaluations.length, 3)
  assert.deepEqual(summary.decision.eligibleCandidateIds, [])
  assert.equal(summary.decision.result, 'no-eligible-candidate')
  assert.equal(summary.decision.replacementCandidateSelected, null)
  assert.equal(summary.decision.productionManifestChanged, false)
  assert.equal(summary.decision.i2Status, '实现完成·尚未验收')
  assert.deepEqual(
    summary.candidateEvaluations.map((item) => item.report.aggregate.macroCer),
    [0.05998168498168498, 0.024267399267399264, 0.21543040293040294]
  )
  assert.deepEqual(
    summary.candidateEvaluations.map((item) => item.report.criteria.eligibleForProductionSelection),
    [false, false, false]
  )

  const serialized = JSON.stringify(summary)
  assert.doesNotMatch(serialized, /\.wav/i)
  assert.doesNotMatch(serialized, /[A-Z]:\\/i)
  for (const item of corpus.cases) assert.equal(serialized.includes(item.reference), false)

  const drift = structuredClone(summary)
  drift.candidateEvaluations[0].report.criteria.macroCer.result = 'pass'
  assert.throws(() => validateRealtimeCandidateSummary(
    drift,
    registryEvidence,
    corpus,
    historicalManifestSha256
  ), /inconsistent/i)

  const sourceDigestDrift = structuredClone(summary)
  sourceDigestDrift.candidateEvaluations[0].report.runtime.recognizerLoadSeconds += 0.001
  assert.throws(() => validateRealtimeCandidateSummary(
    sourceDigestDrift,
    registryEvidence,
    corpus,
    historicalManifestSha256
  ), /source SHA-256 is inconsistent/i)
})

test('Gate 0B candidate evaluation report validator rejects report text and aggregate drift', () => {
  const report = buildReport()
  validateCandidateEvaluationReport(report, candidate, registryEvidence.sha256, corpus)

  const textLeak = structuredClone(report)
  textLeak.cases[0].text = 'forbidden'
  assert.throws(() => validateCandidateEvaluationReport(
    textLeak,
    candidate,
    registryEvidence.sha256,
    corpus
  ), /keys must be exactly/i)

  const aggregateDrift = structuredClone(report)
  aggregateDrift.aggregate.macroCer = 0.5
  assert.throws(() => validateCandidateEvaluationReport(
    aggregateDrift,
    candidate,
    registryEvidence.sha256,
    corpus
  ), /aggregate macroCer is inconsistent/i)
})
