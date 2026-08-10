'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const assert = require('node:assert/strict')
const {
  parseOperatorCompletion,
  validateInteractionReport
} = require('./i2-interaction-protocol')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')
const { computeProductPayloadIdentity } = require('../src/main/services/product-payload-identity')

function parseVerifierArguments (argv) {
  if (argv.length < 1 || argv.length > 4 || (argv.length > 2 && argv[2] !== '--completion')) {
    throw new Error('usage: node scripts/verify-i2-interaction-report.js <report.json> [scenario] [--completion <completion.json>]')
  }
  const [reportPath, expectedScenario = null] = argv
  return { reportPath, expectedScenario, completionPath: argv[3] || null }
}

function validateInteractionEvidence (bytes, expectedScenario = null) {
  const report = parseStrictEvidenceJson(bytes, 'I2 interaction report evidence')
  validateInteractionReport(report, expectedScenario)
  if (report.schemaVersion === 5 && report.scenario === 'dwm-drag') {
    const identity = computeProductPayloadIdentity()
    if (report.scenarioEvidence.productPayloadVersion !== identity.version ||
        report.scenarioEvidence.productPayloadFileCount !== identity.fileCount ||
        report.scenarioEvidence.productPayloadSha256 !== identity.sha256) {
      throw new Error('DWM product payload identity does not match the current candidate')
    }
  }
  return report
}

function validateDwmCompanion (report, completionBytes) {
  if (![3, 4, 5].includes(report.schemaVersion) || report.scenario !== 'dwm-drag') return null
  const completion = parseOperatorCompletion(completionBytes)
  assert.equal(completion.schemaVersion, report.schemaVersion,
    `DWM report requires a schema-v${report.schemaVersion} completion`)
  const evidence = report.scenarioEvidence
  assert.equal(completion.runBindingSha256, evidence.runBindingSha256)
  assert.equal(completion.productPayloadVersion, evidence.productPayloadVersion)
  assert.equal(completion.productPayloadFileCount, evidence.productPayloadFileCount)
  assert.equal(completion.productPayloadSha256, evidence.productPayloadSha256)
  assert.deepEqual(completion.combination, evidence.combination)
  assert.deepEqual(completion.checks, evidence.checks)
  if ([4, 5].includes(report.schemaVersion)) assert.deepEqual(completion.lifecycle, evidence.lifecycle)
  if (report.schemaVersion === 5) assert.deepEqual(completion.stability, evidence.stability)
  assert.deepEqual(completion.crossScale, evidence.crossScale)
  const digest = crypto.createHash('sha256').update(completionBytes).digest('hex')
  assert.equal(digest, evidence.operatorCompletionSha256, 'DWM completion SHA-256 does not match the report')
  return completion
}

if (require.main === module) {
  const { reportPath, expectedScenario, completionPath } = parseVerifierArguments(process.argv.slice(2))
  const report = validateInteractionEvidence(fs.readFileSync(path.resolve(reportPath)), expectedScenario)
  if ([3, 4, 5].includes(report.schemaVersion) && report.scenario === 'dwm-drag') {
    if (!completionPath) throw new Error(`schema-v${report.schemaVersion} dwm-drag verification requires --completion`)
    validateDwmCompanion(report, fs.readFileSync(path.resolve(completionPath)))
  } else if (completionPath) {
    throw new Error('--completion is only valid for schema-v3/schema-v4/schema-v5 dwm-drag reports')
  }
  process.stdout.write(`I2 ${report.scenario} interaction report validated (${report.result}).\n`)
}

module.exports = {
  parseVerifierArguments,
  validateDwmCompanion,
  validateInteractionEvidence
}
