'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')
const { validateI2LiveReport } = require('./verify-i2-live-report')

const EXIT_EVIDENCE_KEYS = Object.freeze([
  'schemaVersion',
  'kind',
  'sourceId',
  'reportSha256',
  'outcome'
])
const EXIT_OUTCOME = 'exited-zero-without-runner-termination'
const SHA256_PATTERN = /^[0-9a-f]{64}$/

function normalizeBytes (value, label) {
  assert.ok(Buffer.isBuffer(value) || typeof value === 'string', `${label} must be exact UTF-8 bytes or text`)
  return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
}

function sha256 (bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function assertExactKeys (value, expectedKeys, label) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  assert.deepEqual(Object.keys(value).sort(), [...expectedKeys].sort(), `${label} must use the closed schema`)
}

function parseArguments (argv) {
  const options = { source: null, report: null, output: null }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!['--source', '--report', '--output'].includes(name) || typeof value !== 'string' || value.length === 0) {
      throw new Error('usage: node scripts/write-i2-exact-child-exit.js --source <loopback|mic> --report <report.json> --output <exit.json>')
    }
    if (seen.has(name)) throw new Error(`${name} must be provided exactly once`)
    seen.add(name)
    options[name.slice(2)] = value
  }
  if (!['loopback', 'mic'].includes(options.source)) throw new Error('--source must be loopback or mic')
  if (typeof options.report !== 'string' || options.report.length === 0) throw new Error('--report is required')
  if (typeof options.output !== 'string' || options.output.length === 0) throw new Error('--output is required')
  return options
}

function buildI2ExactChildExitEvidence (reportBytes, sourceId) {
  assert.ok(['loopback', 'mic'].includes(sourceId), 'sourceId must be loopback or mic')
  const bytes = normalizeBytes(reportBytes, 'I2 child report')
  const report = parseStrictEvidenceJson(bytes, 'I2 child report')
  validateI2LiveReport(report, sourceId)
  return {
    schemaVersion: 1,
    kind: 'i2-exact-child-exit',
    sourceId,
    reportSha256: sha256(bytes),
    outcome: EXIT_OUTCOME
  }
}

function validateI2ExactChildExitEvidence (evidence, expectedSource = null, reportBytes = null) {
  assertExactKeys(evidence, EXIT_EVIDENCE_KEYS, 'I2 exact child exit evidence')
  assert.equal(evidence.schemaVersion, 1)
  assert.equal(evidence.kind, 'i2-exact-child-exit')
  assert.ok(['loopback', 'mic'].includes(evidence.sourceId), 'sourceId must be loopback or mic')
  if (expectedSource !== null) {
    assert.ok(['loopback', 'mic'].includes(expectedSource), 'expectedSource must be loopback or mic')
    assert.equal(evidence.sourceId, expectedSource)
  }
  assert.match(evidence.reportSha256, SHA256_PATTERN, 'reportSha256 must be a lowercase SHA-256 digest')
  assert.equal(evidence.outcome, EXIT_OUTCOME)

  if (reportBytes !== null) {
    const bytes = normalizeBytes(reportBytes, 'I2 child report')
    const report = parseStrictEvidenceJson(bytes, 'I2 child report')
    validateI2LiveReport(report, evidence.sourceId)
    assert.equal(evidence.reportSha256, sha256(bytes), 'exit evidence must bind the exact child report bytes')
  }
  return evidence
}

function validateI2ExactChildExitEvidenceBytes (evidenceBytes, expectedSource = null, reportBytes = null) {
  const evidence = parseStrictEvidenceJson(
    normalizeBytes(evidenceBytes, 'I2 exact child exit evidence'),
    'I2 exact child exit evidence'
  )
  return validateI2ExactChildExitEvidence(evidence, expectedSource, reportBytes)
}

function serializeI2ExactChildExitEvidence (evidence) {
  validateI2ExactChildExitEvidence(evidence)
  return JSON.stringify(evidence, null, 2) + '\n'
}

function writeI2ExactChildExitEvidenceExclusive (outputPath, evidence) {
  const resolvedOutput = path.resolve(outputPath)
  fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true })
  fs.writeFileSync(resolvedOutput, serializeI2ExactChildExitEvidence(evidence), {
    encoding: 'utf8',
    flag: 'wx'
  })
  return resolvedOutput
}

if (require.main === module) {
  const options = parseArguments(process.argv.slice(2))
  const reportBytes = fs.readFileSync(path.resolve(options.report))
  const evidence = buildI2ExactChildExitEvidence(reportBytes, options.source)
  writeI2ExactChildExitEvidenceExclusive(options.output, evidence)
  process.stdout.write(`I2 ${options.source} exact child exit evidence written.\n`)
}

module.exports = {
  EXIT_EVIDENCE_KEYS,
  EXIT_OUTCOME,
  buildI2ExactChildExitEvidence,
  parseArguments,
  serializeI2ExactChildExitEvidence,
  validateI2ExactChildExitEvidence,
  validateI2ExactChildExitEvidenceBytes,
  writeI2ExactChildExitEvidenceExclusive
}
