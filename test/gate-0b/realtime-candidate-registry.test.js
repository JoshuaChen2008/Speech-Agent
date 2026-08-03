'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  readAndValidateRealtimeCandidateRegistry,
  selectRealtimeCandidate,
  validateRealtimeCandidateRegistry
} = require('../../scripts/gate-0b/realtime-candidate-registry')
const { PRODUCTION_MODEL_MANIFEST } = require('../../src/main/services/model-manifest')

const ROOT = path.resolve(__dirname, '../..')
const REGISTRY_PATH = path.join(ROOT, 'scripts', 'gate-0b', 'realtime-candidates.json')

function sha256File (file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

test('SEM-F17/SEM-T11/J14 replacement candidate freezes supply chain without changing production', () => {
  const evidence = readAndValidateRealtimeCandidateRegistry(REGISTRY_PATH)
  const candidate = selectRealtimeCandidate(evidence.registry, 'zipformer-bilingual-zh-en-2023-02-20')
  const paraformer = selectRealtimeCandidate(evidence.registry, 'paraformer-bilingual-zh-en')
  const trilingual = selectRealtimeCandidate(evidence.registry, 'paraformer-trilingual-zh-cantonese-en')
  const productionRealtime = PRODUCTION_MODEL_MANIFEST.artifacts.find((item) => item.id === 'x-asr-160ms')

  assert.equal(candidate.evaluationOnly, true)
  assert.equal(candidate.productionApproved, false)
  assert.equal(candidate.archive.bytes, 511274346)
  assert.equal(candidate.archive.sha256, '27ffbd9ee24ad186d99acc2f6354d7992b27bcab490812510665fa8f9389c5f8')
  assert.equal(candidate.benchmark.corpusSha256,
    sha256File(path.join(ROOT, candidate.benchmark.corpusRelativePath)))
  assert.equal(candidate.j14.currentProductionArchiveBytes, productionRealtime.bytes)
  assert.equal(candidate.j14.productionManifestChanged, false)
  assert.equal(PRODUCTION_MODEL_MANIFEST.artifacts.some((item) => item.id === candidate.id), false)
  assert.notEqual(candidate.upstream.url, productionRealtime.url)
  assert.equal(paraformer.evaluationOnly, true)
  assert.equal(paraformer.productionApproved, false)
  assert.equal(paraformer.archive.bytes, 1047319737)
  assert.equal(paraformer.archive.sha256, '5462a1fce42693deae572af1e8c4687124b12aa85fe61ff4d3168bb5280e205f')
  assert.equal(paraformer.runtime.modelType, 'paraformer')
  assert.deepEqual(Object.keys(paraformer.runtime.requiredFiles).sort(), ['decoder', 'encoder', 'tokens'])
  assert.equal(paraformer.j14.candidateArchiveBytesDelta, 913421730)
  assert.equal(paraformer.j14.currentProductionArchiveBytes, productionRealtime.bytes)
  assert.equal(paraformer.j14.productionManifestChanged, false)
  assert.equal(PRODUCTION_MODEL_MANIFEST.artifacts.some((item) => item.id === paraformer.id), false)
  assert.equal(trilingual.evaluationOnly, true)
  assert.equal(trilingual.archive.bytes, 1047671211)
  assert.equal(trilingual.archive.sha256, 'd479167d8752628d9032d29de1060493865389d1e295a1c2e8e011e7062f1932')
  assert.equal(trilingual.j14.candidateArchiveBytesDelta, 913773204)
  assert.equal(PRODUCTION_MODEL_MANIFEST.artifacts.some((item) => item.id === trilingual.id), false)
})

test('SEM-T14 candidate benchmark preserves frozen timing and conditional-screen boundaries', () => {
  const { registry } = readAndValidateRealtimeCandidateRegistry(REGISTRY_PATH)
  const expectedBenchmark = {
    corpusRelativePath: 'scripts/gate-0b/corpus.json',
    corpusSha256: '7edd6dff286b84619a3b68f385ba04622103ffe17cc57dbe5e1f16521deb156d',
    runsPerCase: 5,
    chunkMs: 40,
    cliRtfLimitExclusive: 0.6,
    macroCerLimitInclusive: 0,
    englishWerLimitInclusive: 0,
    realtimePunctuationIsReplacementGate: false,
    firstPartialLimitMsExclusive: 1000,
    conditionalCodeSwitchAudioNeedScreenMs: 534.562,
    conditionalScreenIsReleaseGate: false
  }
  for (const candidate of registry.candidates) {
    assert.deepEqual(candidate.benchmark, expectedBenchmark)
  }

  const semantic = fs.readFileSync(path.join(ROOT, 'docs', 'semantic-contract.md'), 'utf8')
  const strategy = fs.readFileSync(path.join(ROOT, 'docs', 'testing-strategy.md'), 'utf8')
  for (const text of [semantic, strategy]) {
    assert.match(text, /zipformer-bilingual-zh-en-2023-02-20/)
    assert.match(text, /511274346/)
    assert.match(text, /27ffbd9ee24ad186d99acc2f6354d7992b27bcab490812510665fa8f9389c5f8/)
    assert.match(text, /paraformer-bilingual-zh-en/)
    assert.match(text, /1047319737/)
    assert.match(text, /5462a1fce42693deae572af1e8c4687124b12aa85fe61ff4d3168bb5280e205f/)
    assert.match(text, /paraformer-trilingual-zh-cantonese-en/)
    assert.match(text, /1047671211/)
    assert.match(text, /d479167d8752628d9032d29de1060493865389d1e295a1c2e8e011e7062f1932/)
    assert.match(text, /534\.562ms/)
    assert.match(text, /不是.*验收门槛|不是冻结字幕可见延迟门槛/)
  }
})

test('Gate 0B registry fails closed on approval, timing, supply-chain or unknown-field drift', () => {
  const source = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'))
  const mutate = (callback) => {
    const value = structuredClone(source)
    callback(value.candidates[0], value)
    return value
  }
  assert.throws(() => validateRealtimeCandidateRegistry(mutate((candidate) => {
    candidate.productionApproved = true
  })), /evaluation-only/i)
  assert.throws(() => validateRealtimeCandidateRegistry(mutate((candidate) => {
    candidate.benchmark.firstPartialLimitMsExclusive = 1200
  })), /boundaries/i)
  assert.throws(() => validateRealtimeCandidateRegistry(mutate((candidate) => {
    candidate.benchmark.macroCerLimitInclusive = 0.01
  })), /boundaries/i)
  assert.throws(() => validateRealtimeCandidateRegistry(mutate((candidate) => {
    candidate.upstream.url = 'https://example.com/model.tar.bz2'
  })), /URL/i)
  assert.throws(() => validateRealtimeCandidateRegistry(mutate((candidate) => {
    candidate.runtime.requiredFiles.encoder = '../encoder.onnx'
  })), /unsafe/i)
  assert.throws(() => validateRealtimeCandidateRegistry(mutate((candidate) => {
    candidate.note = 'unknown'
  })), /keys/i)
  assert.throws(() => validateRealtimeCandidateRegistry(mutate((_candidate, registry) => {
    registry.candidates[1].runtime.requiredFiles.joiner = 'joiner.int8.onnx'
  })), /keys/i)
})

test('streaming benchmark binds a registered candidate and exact runtime files without report text', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'gate-0b', 'streaming-bench.js'), 'utf8')
  assert.match(source, /--candidate-registry/)
  assert.match(source, /--candidate-id/)
  assert.match(source, /candidateRegistrySha256/)
  assert.match(source, /candidate\?\.runtime\.requiredFiles/)
  assert.match(source, /paraformer:/)
  assert.match(source, /productionApproved: candidate\.productionApproved/)
  assert.match(source, /projectStreamingBenchReport\(report\)/)
  assert.doesNotMatch(source, /writeFileSync[^\n]+finalText/)

  const cliSource = fs.readFileSync(path.join(ROOT, 'scripts', 'gate-0b', 'cli-bench.js'), 'utf8')
  assert.match(cliSource, /--paraformer-encoder=/)
  assert.match(cliSource, /--paraformer-decoder=/)
  assert.match(cliSource, /online-paraformer/)
})
