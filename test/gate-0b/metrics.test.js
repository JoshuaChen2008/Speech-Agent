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
