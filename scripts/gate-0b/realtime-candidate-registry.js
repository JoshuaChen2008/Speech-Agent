'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { parseStrictEvidenceJson } = require('../strict-evidence-json')

const SHA256 = /^[a-f0-9]{64}$/
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,199}$/
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
const SEMANTIC_REFS = Object.freeze(['SEM-F17', 'SEM-T11', 'SEM-T14', 'J1', 'J14'])

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

function requirePositiveInteger (value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`)
}

function validateCandidate (candidate) {
  exactKeys(candidate, [
    'archive', 'benchmark', 'evaluationOnly', 'id', 'j14',
    'productionApproved', 'runtime', 'upstream'
  ], 'realtime candidate')
  if (!SAFE_ID.test(candidate.id) || candidate.evaluationOnly !== true ||
      candidate.productionApproved !== false) {
    throw new Error('realtime candidate must be a safe evaluation-only identity')
  }

  exactKeys(candidate.upstream, ['asset', 'project', 'release', 'url'], 'candidate upstream')
  if (candidate.upstream.project !== 'k2-fsa/sherpa-onnx' ||
      candidate.upstream.release !== 'asr-models' || !SAFE_FILE.test(candidate.upstream.asset)) {
    throw new Error('candidate upstream must be the frozen sherpa-onnx release asset')
  }
  let upstreamUrl
  try { upstreamUrl = new URL(candidate.upstream.url) } catch { throw new Error('candidate upstream URL is invalid') }
  if (upstreamUrl.protocol !== 'https:' || upstreamUrl.hostname !== 'github.com' ||
      upstreamUrl.pathname !== `/k2-fsa/sherpa-onnx/releases/download/asr-models/${candidate.upstream.asset}`) {
    throw new Error('candidate upstream URL does not match its frozen release asset')
  }

  exactKeys(candidate.archive, ['bytes', 'sha256'], 'candidate archive')
  requirePositiveInteger(candidate.archive.bytes, 'candidate archive bytes')
  if (!SHA256.test(candidate.archive.sha256)) throw new TypeError('candidate archive SHA-256 is invalid')

  exactKeys(candidate.runtime, [
    'decodingMethod', 'directoryName', 'modelType', 'numThreads',
    'provider', 'requiredFiles'
  ], 'candidate runtime')
  if (!SAFE_ID.test(candidate.runtime.directoryName) ||
      !['zipformer', 'paraformer'].includes(candidate.runtime.modelType) ||
      candidate.runtime.provider !== 'cpu' || candidate.runtime.decodingMethod !== 'greedy_search' ||
      !Number.isSafeInteger(candidate.runtime.numThreads) || candidate.runtime.numThreads < 1 ||
      candidate.runtime.numThreads > 16) {
    throw new Error('candidate runtime profile is invalid')
  }
  const requiredFileRoles = candidate.runtime.modelType === 'paraformer'
    ? ['decoder', 'encoder', 'tokens']
    : ['decoder', 'encoder', 'joiner', 'tokens']
  exactKeys(candidate.runtime.requiredFiles, requiredFileRoles, 'candidate runtime files')
  for (const [role, fileName] of Object.entries(candidate.runtime.requiredFiles)) {
    if (typeof fileName !== 'string' || !SAFE_FILE.test(fileName)) {
      throw new Error(`candidate runtime file ${role} is unsafe`)
    }
  }
  if (new Set(Object.values(candidate.runtime.requiredFiles)).size !== requiredFileRoles.length) {
    throw new Error('candidate runtime files must be distinct')
  }

  exactKeys(candidate.benchmark, [
    'chunkMs', 'cliRtfLimitExclusive', 'conditionalCodeSwitchAudioNeedScreenMs',
    'conditionalScreenIsReleaseGate', 'corpusRelativePath', 'corpusSha256',
    'englishWerLimitInclusive', 'firstPartialLimitMsExclusive',
    'macroCerLimitInclusive', 'realtimePunctuationIsReplacementGate', 'runsPerCase'
  ], 'candidate benchmark')
  if (candidate.benchmark.corpusRelativePath !== 'scripts/gate-0b/corpus.json' ||
      !SHA256.test(candidate.benchmark.corpusSha256) || candidate.benchmark.runsPerCase !== 5 ||
      candidate.benchmark.chunkMs !== 40 || candidate.benchmark.cliRtfLimitExclusive !== 0.6 ||
      candidate.benchmark.macroCerLimitInclusive !== 0 ||
      candidate.benchmark.englishWerLimitInclusive !== 0 ||
      candidate.benchmark.realtimePunctuationIsReplacementGate !== false ||
      candidate.benchmark.firstPartialLimitMsExclusive !== 1000 ||
      candidate.benchmark.conditionalCodeSwitchAudioNeedScreenMs !== 534.562 ||
      candidate.benchmark.conditionalScreenIsReleaseGate !== false) {
    throw new Error('candidate benchmark does not preserve the frozen Gate 0B/I2 boundaries')
  }

  exactKeys(candidate.j14, [
    'candidateArchiveBytesDelta', 'currentProductionArchiveBytes',
    'productionManifestChanged', 'requiresFullSupplyChainRequalificationIfSelected'
  ], 'candidate J14 impact')
  requirePositiveInteger(candidate.j14.currentProductionArchiveBytes, 'current production archive bytes')
  if (candidate.j14.candidateArchiveBytesDelta !==
      candidate.archive.bytes - candidate.j14.currentProductionArchiveBytes ||
      candidate.j14.productionManifestChanged !== false ||
      candidate.j14.requiresFullSupplyChainRequalificationIfSelected !== true) {
    throw new Error('candidate J14 impact is inconsistent')
  }
  return candidate
}

function validateRealtimeCandidateRegistry (registry) {
  exactKeys(registry, ['candidates', 'schemaVersion', 'semanticRefs'], 'realtime candidate registry')
  if (registry.schemaVersion !== 1 || JSON.stringify(registry.semanticRefs) !== JSON.stringify(SEMANTIC_REFS) ||
      !Array.isArray(registry.candidates) || registry.candidates.length < 1) {
    throw new Error('invalid realtime candidate registry envelope')
  }
  const seen = new Set()
  for (const candidate of registry.candidates) {
    validateCandidate(candidate)
    if (seen.has(candidate.id)) throw new Error('duplicate realtime candidate id')
    seen.add(candidate.id)
  }
  return registry
}

function readAndValidateRealtimeCandidateRegistry (registryPath) {
  const bytes = fs.readFileSync(path.resolve(registryPath))
  return Object.freeze({
    registry: validateRealtimeCandidateRegistry(parseStrictEvidenceJson(bytes, 'realtime candidate registry')),
    sha256: crypto.createHash('sha256').update(bytes).digest('hex')
  })
}

function selectRealtimeCandidate (registry, candidateId) {
  validateRealtimeCandidateRegistry(registry)
  const candidate = registry.candidates.find((item) => item.id === candidateId)
  if (!candidate) throw new Error('unknown realtime candidate id')
  return candidate
}

module.exports = {
  SEMANTIC_REFS,
  readAndValidateRealtimeCandidateRegistry,
  selectRealtimeCandidate,
  validateRealtimeCandidateRegistry
}
