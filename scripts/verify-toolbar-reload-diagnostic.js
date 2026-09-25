'use strict'

const fs = require('node:fs')
const { validateReport } = require('./toolbar-reload-diagnostic')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')

function readAndValidate (filename) {
  return validateReport(parseStrictEvidenceJson(fs.readFileSync(filename), 'toolbar reload diagnostic'))
}

if (require.main === module) {
  try {
    if (process.argv.length !== 3) throw new Error('diagnostic file required')
    const report = readAndValidate(process.argv[2])
    process.stdout.write(`${JSON.stringify({ outcome: report.outcome, rendererStatus: report.renderer.status, facts: report.facts })}\n`)
  } catch {
    process.stderr.write('Toolbar reload diagnostic is invalid.\n')
    process.exitCode = 1
  }
}

module.exports = { readAndValidate }
