'use strict'

// @ts-check

const fs = require('node:fs')
const path = require('node:path')

function validateDb0DevelopmentReport (report) {
  if (!report || report.schemaVersion !== 1 || report.kind !== 'db0-sqlite-development-qualification') {
    throw new Error('invalid DB0 report envelope')
  }
  if (report.result !== 'pass' || report.development?.status !== 'pass') {
    throw new Error(`DB0 development qualification did not pass (${report.result || 'unknown'})`)
  }
  if (report.gateStatus !== 'partial' || report.packaged?.status !== 'pending') {
    throw new Error('DB0 report must not claim the packaged gate before B5/I4')
  }
  if (!Array.isArray(report.development.failedChecks) || report.development.failedChecks.length !== 0) {
    throw new Error('DB0 report contains failed checks')
  }
  if (!/^43\./.test(String(report.development.runtime?.electron || ''))) {
    throw new Error('DB0 report was not produced by Electron 43')
  }
  const checks = report.development.checks || {}
  const requiredChecks = [
    'driverLoaded',
    'schemaVersion',
    'migrationCount',
    'journalModeWal',
    'busyTimeout',
    'uncommittedInvisibleToReader',
    'committedVisibleToReader',
    'sessionIdentityImmutable',
    'transactionRollback',
    'eventProjectionAtomicCommit',
    'captionEventsImmutable',
    'subtitleOnlyTables',
    'noAudioPersistenceSchema',
    'integrity',
    'reopenPreservesData',
    'migrationIdempotent',
    'integrityAfterReopen'
  ]
  const missing = requiredChecks.filter((name) => checks[name] !== true)
  if (missing.length > 0) throw new Error(`DB0 checks failed or missing: ${missing.join(', ')}`)
  if (report.development.schema?.privacy?.containsAudioPersistenceSchema !== false ||
      report.development.schema?.privacy?.blobColumnCount !== 0) {
    throw new Error('DB0 schema privacy audit failed')
  }
  if (report.process?.workerExitCode !== 0 || report.process?.noBrowserWindowCreated !== true ||
      report.process?.isolatedUserData !== true || report.process?.reportContainsTranscriptText !== false ||
      report.process?.reportContainsAbsolutePath !== false) {
    throw new Error('DB0 process isolation or report privacy evidence failed')
  }
  return report
}

function readAndValidateDb0DevelopmentReport (reportPath) {
  const resolved = path.resolve(reportPath)
  return validateDb0DevelopmentReport(JSON.parse(fs.readFileSync(resolved, 'utf8')))
}

if (require.main === module) {
  const reportPath = process.argv[2]
  if (!reportPath || process.argv.length !== 3) {
    throw new Error('usage: node scripts/verify-db0-report.js <report.json>')
  }
  const report = readAndValidateDb0DevelopmentReport(reportPath)
  process.stdout.write(JSON.stringify({
    result: report.result,
    gateStatus: report.gateStatus,
    runtime: report.development.runtime,
    workerExitCode: report.process.workerExitCode
  }) + '\n')
}

module.exports = {
  readAndValidateDb0DevelopmentReport,
  validateDb0DevelopmentReport
}
