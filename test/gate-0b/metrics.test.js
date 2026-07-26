'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  characterErrorRate,
  editDistance,
  normalizeContent,
  percentile,
  punctuationMetrics,
  wordErrorRate
} = require('../../scripts/gate-0b/metrics')
const { evaluate, inputFromObservations } = require('../../scripts/gate-0b/evaluate-transcripts')
const { parseOnlineOutput, parseSenseVoiceOutput } = require('../../scripts/gate-0b/cli-bench')

test('editDistance handles insertions, deletions, and substitutions', () => {
  assert.equal(editDistance('kitten', 'sitting'), 3)
  assert.equal(editDistance([], []), 0)
  assert.equal(editDistance(['a', 'b'], ['a']), 1)
})

test('content normalization ignores case, spacing, and punctuation', () => {
  assert.equal(normalizeContent('我们 review。'), '我们review')
  assert.equal(characterErrorRate('Hello, world!', 'hello world'), 0)
})

test('CER and WER expose content regressions', () => {
  assert.equal(characterErrorRate('路线图', '路线'), 1 / 3)
  assert.equal(wordErrorRate('one two three', 'one three'), 1 / 3)
})

test('punctuation metrics use mark counts and handle empty inputs', () => {
  assert.deepEqual(punctuationMetrics('hello', 'hello'), {
    referenceCount: 0,
    hypothesisCount: 0,
    precision: 1,
    recall: 1,
    f1: 1
  })
  const result = punctuationMetrics('你好，世界。', '你好，世界')
  assert.equal(result.precision, 1)
  assert.equal(result.recall, 0.5)
  assert.equal(result.f1, 2 / 3)
})

test('percentile uses nearest-rank semantics', () => {
  assert.equal(percentile([40, 10, 30, 20], 0.5), 20)
  assert.equal(percentile([40, 10, 30, 20], 0.95), 40)
  assert.equal(percentile([], 0.5), null)
})

test('transcript evaluation reports refinement gains and regressions', () => {
  const report = evaluate({
    schemaVersion: 1,
    cases: [
      { id: 'gain', category: 'zh', reference: '路线图', xAsr: '路线', senseVoice: '路线图' },
      { id: 'regression', category: 'en', reference: 'one two', xAsr: 'one two', senseVoice: 'one' }
    ]
  })
  assert.equal(report.aggregate.refinementImprovedCases, 1)
  assert.equal(report.aggregate.refinementRegressedCases, 1)
  assert.equal(report.cases[1].senseVoice.wer, 0.5)
})

test('transcript evaluation rejects malformed input', () => {
  assert.throws(() => evaluate({ schemaVersion: 1, cases: [] }), /non-empty/)
})

test('CLI parsers preserve transcripts and RTF without absolute paths', () => {
  const online = parseOnlineOutput('C:\\model\\0.wav\nNumber of threads: 3, Elapsed seconds: 0.5, Audio duration (s): 5, Real time factor (RTF) = 0.5/5 = 0.1\n你好\n{ "text": "你好" }\n', ['0.wav'])
  assert.equal(online[0].wav, '0.wav')
  assert.equal(online[0].rtf, 0.1)
  assert.equal(online[0].text, '你好')

  const sense = parseSenseVoiceOutput('Elapsed seconds: 0.25 s\r\nReal time factor (RTF): 0.25 / 5 = 0.05\r\n{"lang": "<|zh|>", "text": "你好"}\r\n', ['0.wav'])
  assert.equal(sense.rtf, 0.05)
  assert.equal(sense.samples[0].result.lang, '<|zh|>')
})

test('refinement input is built from structured observations', () => {
  const corpus = { cases: [{ id: 'one', category: 'zh', reference: '你好' }] }
  const observations = {
    runs: [
      { id: 'x', samples: [{ wav: 'one.wav', text: '你号' }] },
      { id: 'sense', samples: [{ wav: 'one.wav', text: '你好' }] }
    ]
  }
  assert.deepEqual(inputFromObservations(corpus, observations, 'x', 'sense').cases[0], {
    id: 'one', category: 'zh', reference: '你好', xAsr: '你号', senseVoice: '你好'
  })
})

test('published Gate 0B summary matches the structured CLI evidence', () => {
  const validationDir = path.resolve(__dirname, '../../docs/validation')
  const observations = JSON.parse(fs.readFileSync(path.join(validationDir, 'gate-0b-cli-observations.json'), 'utf8'))
  const metrics = JSON.parse(fs.readFileSync(path.join(validationDir, 'gate-0b-controlled-metrics.json'), 'utf8'))
  const summary = JSON.parse(fs.readFileSync(path.join(validationDir, 'gate-0b-results.json'), 'utf8'))
  const run = (id) => observations.runs.find((item) => item.id === id)
  const candidate = (id) => summary.realtimeCandidates.find((item) => item.id === id)

  assert.deepEqual(candidate('x-asr-480ms').officialSampleRtf, run('x480-official').samples.map((item) => item.rtf))
  assert.deepEqual(candidate('x-asr-480ms').controlledSampleRtf, run('x480-controlled').samples.map((item) => item.rtf))
  assert.deepEqual(candidate('x-asr-160ms').officialSampleRtf, run('x160-official').samples.map((item) => item.rtf))
  assert.deepEqual(candidate('small-bilingual').officialSampleRtf, run('small-official').samples.map((item) => item.rtf))
  assert.equal(candidate('small-bilingual').controlledCliRtf, run('small-controlled').samples[0].rtf)
  assert.equal(summary.refinement.controlledAggregateRtf, run('sense-controlled').rtf)
  assert.equal(summary.refinement.xAsrMacroCer, metrics.aggregate.xAsrMacroCer)
  assert.equal(summary.refinement.senseVoiceMacroCer, metrics.aggregate.senseVoiceMacroCer)
  assert.equal(summary.refinement.macroCerDelta, metrics.aggregate.refinementMacroCerDelta)

  const serialized = JSON.stringify(observations)
  assert.doesNotMatch(serialized, /[A-Za-z]:\\\\|Joshua|A1Project|Speech-Agent2\.0/i)
})

test('Gate 0B re-judgment decision matches the tracked M2/M3 evidence', () => {
  const validationDir = path.resolve(__dirname, '../../docs/validation')
  const summary = JSON.parse(fs.readFileSync(path.join(validationDir, 'gate-0b-results.json'), 'utf8'))
  const sweep = JSON.parse(fs.readFileSync(path.join(validationDir, 'gate-0b-m2-sweep.json'), 'utf8'))
  const m3 = JSON.parse(fs.readFileSync(path.join(validationDir, 'gate-0b-m3-evaluation.json'), 'utf8'))
  const rejudgment = summary.rejudgment

  // A non-empty approval may only exist alongside the explicit re-judgment record,
  // and the original FAIL must stay on the record.
  assert.ok(rejudgment, 'approved profiles require a recorded re-judgment')
  assert.equal(summary.result, 'pass-rejudged')
  assert.equal(summary.originalResult, 'fail')
  assert.equal(summary.decision.governedBy, 'rejudgment')
  assert.deepEqual(summary.decision.approvedProfiles, ['fast'])
  assert.equal(summary.decision.approvedRefinement, true)
  assert.equal(rejudgment.realtime.revisedCriteria.realtimeRtf.original, summary.criteria.realtimeRtf.target)

  // Realtime numbers must equal the tracked sweep evidence, not hand-typed values.
  const run = (id) => sweep.x160CliThreadSweep.runs.find((item) => item.id === id)
  const realtime = rejudgment.realtime
  assert.equal(realtime.evidence.officialMaxRtf, run(realtime.evidence.officialRunId).maxRtf)
  assert.equal(realtime.evidence.controlledMaxRtf, run(realtime.evidence.controlledRunId).maxRtf)
  assert.equal(run(realtime.evidence.officialRunId).numThreads, realtime.runtimeConfig.numThreads)
  assert.equal(run(realtime.evidence.controlledRunId).numThreads, realtime.runtimeConfig.numThreads)

  // The revised RTF gate must actually cover what was measured.
  const revisedLimit = Number(realtime.revisedCriteria.realtimeRtf.revised.match(/< ([0-9.]+)/)[1])
  assert.ok(realtime.evidence.officialMaxRtf < revisedLimit)
  assert.ok(realtime.evidence.controlledMaxRtf < revisedLimit)

  // First-partial evidence comes from the tracked full-corpus t=4 bench. The
  // zh-date-itn case rides the frozen 1000 ms line and must stay recorded as a
  // marginal case, never silently upgraded to a clean pass.
  const bench = sweep[realtime.evidence.firstPartialBench]
  assert.equal(bench.numThreads, realtime.runtimeConfig.numThreads)
  const benchCase = (id) => bench.cases.find((item) => item.id === id)
  // The decision-record map must cover every bench case - dropping an
  // unfavorable case from the record must fail here.
  assert.deepEqual(
    Object.keys(realtime.evidence.firstPartialLatencyP95MsByCase).sort(),
    bench.cases.map((item) => item.id).sort()
  )
  for (const [caseId, p95] of Object.entries(realtime.evidence.firstPartialLatencyP95MsByCase)) {
    assert.equal(p95, benchCase(caseId).firstPartialLatencyP95Ms)
  }
  const firstPartial = realtime.revisedCriteria.firstPartialLatency
  const overFrozenLine = bench.cases.filter((item) => item.firstPartialLatencyP95Ms >= 1000)
  if (overFrozenLine.length > 0) {
    assert.equal(firstPartial.result, 'pass-with-marginal-case')
    assert.deepEqual(overFrozenLine.map((item) => item.id), [firstPartial.marginalCase.id])
    const marginalBench = benchCase(firstPartial.marginalCase.id)
    assert.equal(firstPartial.marginalCase.latencyP95Ms, marginalBench.firstPartialLatencyP95Ms)
    assert.equal(firstPartial.marginalCase.latencyP50Ms, marginalBench.firstPartialLatencyP50Ms)
    assert.equal(firstPartial.marginalCase.audioNeededAfterSpeechOnsetMs, marginalBench.audioNeededAfterSpeechOnsetMsMax)
  } else {
    assert.equal(firstPartial.result, 'pass')
  }

  // Refinement approval must match the tracked M3 evaluation on both baselines.
  // The evaluator's `senseVoice` field carries the refinement candidate (offline
  // X-ASR) in the M3 file - documented in its `note` - so these are candidate
  // metrics, not SenseVoice metrics.
  const refinement = rejudgment.refinement
  assert.equal(refinement.model, m3.refinementCandidate.model)
  assert.equal(refinement.evidence.aggregateRtf, m3.refinementCandidate.aggregateRtf)
  for (const baseline of refinement.evidence.baselines) {
    const aggregate = m3.evaluations[baseline].aggregate
    assert.equal(aggregate.refinementMacroCerDelta, refinement.evidence.macroCerDelta)
    assert.equal(aggregate.refinementRegressedCases, refinement.evidence.regressedCases)
    assert.equal(aggregate.senseVoiceMacroPunctuationF1, refinement.evidence.refinedMacroPunctuationF1)
  }
  // Absolute floor: approval requires zero content regression and full
  // punctuation restoration, independent of what the tracked files say.
  assert.equal(refinement.evidence.regressedCases, 0)
  assert.ok(refinement.evidence.macroCerDelta >= 0)
  assert.equal(refinement.evidence.refinedMacroPunctuationF1, 1)

  const serialized = JSON.stringify(sweep) + JSON.stringify(m3)
  assert.doesNotMatch(serialized, /[A-Za-z]:\\\\|Joshua|A1Project|Speech-Agent2\.0/i)
})
