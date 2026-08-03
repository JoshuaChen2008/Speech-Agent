'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const {
  readAndValidateRealtimeCandidateRegistry,
  selectRealtimeCandidate
} = require('./realtime-candidate-registry')
const { validateCandidateEvaluationReport } = require('./evaluate-realtime-candidate')
const { parseStrictEvidenceJson } = require('../strict-evidence-json')

const SHA256 = /^[a-f0-9]{64}$/
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

function sha256 (bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function readStrictJsonWithSha256 (file, label) {
  const bytes = fs.readFileSync(path.resolve(file))
  return {
    value: parseStrictEvidenceJson(bytes, label),
    sha256: sha256(bytes)
  }
}

function canonicalEvaluationSha256 (report) {
  return sha256(Buffer.from(JSON.stringify(report, null, 2) + '\n', 'utf8'))
}

function expectedDecision (evaluations) {
  const eligibleCandidateIds = evaluations
    .filter((item) => item.report.criteria.eligibleForProductionSelection)
    .map((item) => item.report.candidateBinding.candidateId)
  return {
    result: eligibleCandidateIds.length === 0
      ? 'no-eligible-candidate'
      : 'eligible-candidate-requires-production-selection',
    eligibleCandidateIds,
    replacementCandidateSelected: null,
    currentImplementationBaseline: 'x-asr-160ms',
    productionManifestChanged: false,
    nextAction: eligibleCandidateIds.length === 0
      ? 'register-new-model-or-recognition-architecture'
      : 'register-production-selection-and-full-requalification',
    i2Status: '实现完成·尚未验收'
  }
}

function buildRealtimeCandidateSummary (input) {
  const {
    registryEvidence, corpus, evaluations, productionManifestSourceSha256
  } = input
  if (!SHA256.test(productionManifestSourceSha256)) {
    throw new TypeError('production manifest source SHA-256 is invalid')
  }
  if (!Array.isArray(evaluations) || evaluations.length !== registryEvidence.registry.candidates.length) {
    throw new Error('candidate summary requires exactly one evaluation per registered candidate')
  }
  const wrappers = registryEvidence.registry.candidates.map((candidate, index) => {
    const evaluation = evaluations[index]
    if (!evaluation || !SHA256.test(evaluation.sha256)) {
      throw new TypeError('candidate evaluation source SHA-256 is invalid')
    }
    validateCandidateEvaluationReport(evaluation.report, candidate, registryEvidence.sha256, corpus)
    if (evaluation.sha256 !== canonicalEvaluationSha256(evaluation.report)) {
      throw new Error('candidate evaluation source SHA-256 does not bind its canonical report')
    }
    return {
      evaluationReportSha256: evaluation.sha256,
      report: evaluation.report
    }
  })
  return {
    schemaVersion: 1,
    kind: 'gate-0b-realtime-candidate-summary',
    semanticRefs: [...SEMANTIC_REFS],
    candidateRegistrySha256: registryEvidence.sha256,
    corpusSha256: registryEvidence.registry.candidates[0].benchmark.corpusSha256,
    productionManifestSourceSha256,
    candidateEvaluations: wrappers,
    decision: expectedDecision(wrappers),
    privacy: {
      absolutePathPersisted: false,
      audioFileNamePersisted: false,
      transcriptTextPersisted: false
    }
  }
}

function validateRealtimeCandidateSummary (summary, registryEvidence, corpus, productionManifestSourceSha256) {
  exactKeys(summary, [
    'candidateEvaluations', 'candidateRegistrySha256', 'corpusSha256', 'decision',
    'kind', 'privacy', 'productionManifestSourceSha256', 'schemaVersion', 'semanticRefs'
  ], 'realtime candidate summary')
  if (summary.schemaVersion !== 1 || summary.kind !== 'gate-0b-realtime-candidate-summary' ||
      JSON.stringify(summary.semanticRefs) !== JSON.stringify(SEMANTIC_REFS) ||
      summary.candidateRegistrySha256 !== registryEvidence.sha256 ||
      summary.corpusSha256 !== registryEvidence.registry.candidates[0].benchmark.corpusSha256 ||
      summary.productionManifestSourceSha256 !== productionManifestSourceSha256) {
    throw new Error('realtime candidate summary binding is invalid')
  }
  if (!Array.isArray(summary.candidateEvaluations) ||
      summary.candidateEvaluations.length !== registryEvidence.registry.candidates.length) {
    throw new Error('realtime candidate summary evaluation count is invalid')
  }
  summary.candidateEvaluations.forEach((item, index) => {
    exactKeys(item, ['evaluationReportSha256', 'report'], `candidate summary evaluation ${index}`)
    if (!SHA256.test(item.evaluationReportSha256)) {
      throw new TypeError(`candidate summary evaluation ${index} SHA-256 is invalid`)
    }
    const candidate = selectRealtimeCandidate(
      registryEvidence.registry,
      registryEvidence.registry.candidates[index].id
    )
    validateCandidateEvaluationReport(item.report, candidate, registryEvidence.sha256, corpus)
    if (item.evaluationReportSha256 !== canonicalEvaluationSha256(item.report)) {
      throw new Error(`candidate summary evaluation ${index} source SHA-256 is inconsistent`)
    }
  })
  const decision = expectedDecision(summary.candidateEvaluations)
  exactKeys(summary.decision, Object.keys(decision), 'realtime candidate summary decision')
  if (JSON.stringify(summary.decision) !== JSON.stringify(decision)) {
    throw new Error('realtime candidate summary decision is inconsistent')
  }
  exactKeys(summary.privacy, [
    'absolutePathPersisted', 'audioFileNamePersisted', 'transcriptTextPersisted'
  ], 'realtime candidate summary privacy')
  if (Object.values(summary.privacy).some((value) => value !== false)) {
    throw new Error('realtime candidate summary privacy projection is invalid')
  }
  return summary
}

function parseArguments (argv) {
  const options = {
    candidateRegistry: null,
    corpus: null,
    evaluations: [],
    productionManifestSource: null,
    output: null
  }
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!value) throw new Error('candidate summary argument value is missing')
    if (name === '--candidate-registry') options.candidateRegistry = value
    else if (name === '--corpus') options.corpus = value
    else if (name === '--evaluation') options.evaluations.push(value)
    else if (name === '--production-manifest-source') options.productionManifestSource = value
    else if (name === '--output') options.output = value
    else throw new Error(`unknown candidate summary argument: ${name}`)
    index += 1
  }
  if (!options.candidateRegistry || !options.corpus || !options.productionManifestSource || !options.output ||
      options.evaluations.length === 0) {
    throw new Error('candidate summary arguments are incomplete')
  }
  return options
}

function main () {
  const options = parseArguments(process.argv.slice(2))
  const registryEvidence = readAndValidateRealtimeCandidateRegistry(options.candidateRegistry)
  const corpusEvidence = readStrictJsonWithSha256(options.corpus, 'candidate summary corpus')
  if (corpusEvidence.sha256 !== registryEvidence.registry.candidates[0].benchmark.corpusSha256) {
    throw new Error('candidate summary corpus SHA-256 differs from the registry')
  }
  const evaluations = options.evaluations.map((file, index) => {
    const evidence = readStrictJsonWithSha256(file, `candidate evaluation ${index}`)
    return { report: evidence.value, sha256: evidence.sha256 }
  })
  const productionManifestSourceSha256 = sha256(fs.readFileSync(path.resolve(options.productionManifestSource)))
  const summary = buildRealtimeCandidateSummary({
    registryEvidence,
    corpus: corpusEvidence.value,
    evaluations,
    productionManifestSourceSha256
  })
  validateRealtimeCandidateSummary(
    summary,
    registryEvidence,
    corpusEvidence.value,
    productionManifestSourceSha256
  )
  const outputPath = path.resolve(options.output)
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2) + '\n')
}

module.exports = {
  buildRealtimeCandidateSummary,
  validateRealtimeCandidateSummary
}

if (require.main === module) {
  try {
    main()
  } catch (error) {
    console.error(error && error.stack ? error.stack : error)
    process.exitCode = 1
  }
}
