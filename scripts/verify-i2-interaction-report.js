'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { validateInteractionReport } = require('./i2-interaction-protocol')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')

function parseVerifierArguments (argv) {
  if (argv.length < 1 || argv.length > 2) {
    throw new Error('usage: node scripts/verify-i2-interaction-report.js <report.json> [pause-refine|worker-crash-retry|dwm-drag|device-removal-retry|sleep-wake-retry]')
  }
  const [reportPath, expectedScenario = null] = argv
  return { reportPath, expectedScenario }
}

function validateInteractionEvidence (bytes, expectedScenario = null) {
  const report = parseStrictEvidenceJson(bytes, 'I2 interaction report evidence')
  return validateInteractionReport(report, expectedScenario)
}

if (require.main === module) {
  const { reportPath, expectedScenario } = parseVerifierArguments(process.argv.slice(2))
  const report = validateInteractionEvidence(fs.readFileSync(path.resolve(reportPath)), expectedScenario)
  process.stdout.write(`I2 ${report.scenario} interaction report validated (${report.result}).\n`)
}

module.exports = {
  parseVerifierArguments,
  validateInteractionEvidence
}
