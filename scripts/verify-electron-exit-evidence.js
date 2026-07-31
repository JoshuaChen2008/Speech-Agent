'use strict'

// @ts-check

const fs = require('node:fs')
const path = require('node:path')
const {
  validateEvidenceReport
} = require('../src/main/services/electron-exit-evidence')

function readAndValidateElectronExitEvidence (reportPath) {
  if (typeof reportPath !== 'string' || reportPath.length === 0) {
    throw new TypeError('evidence file is required')
  }
  const parsed = JSON.parse(fs.readFileSync(path.resolve(reportPath), 'utf8'))
  return validateEvidenceReport(parsed)
}

if (require.main === module) {
  if (process.argv.length !== 3) {
    process.stderr.write('usage: node scripts/verify-electron-exit-evidence.js <evidence.json>\n')
    process.exitCode = 1
  } else {
    try {
      const report = readAndValidateElectronExitEvidence(process.argv[2])
      process.stdout.write(JSON.stringify({
        outcome: report.outcome,
        breakpointObserved: report.attribution.breakpointObserved,
        role: report.attribution.role,
        incidentCount: report.counters.incidentCount
      }) + '\n')
    } catch {
      process.stderr.write('Electron exit evidence is invalid.\n')
      process.exitCode = 1
    }
  }
}

module.exports = {
  readAndValidateElectronExitEvidence,
  validateElectronExitEvidence: validateEvidenceReport
}
