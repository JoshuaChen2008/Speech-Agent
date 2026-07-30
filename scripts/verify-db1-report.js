'use strict'

// @ts-check

const fs = require('node:fs')
const path = require('node:path')

const REQUIRED_CHECKS = Object.freeze([
  'initialized',
  'openIdempotent',
  'fifoProjection',
  'eventIdempotent',
  'divergentPayloadRejected',
  'partialRejected',
  'unsafeCaptionFieldsRejected',
  'closeCommitted',
  'retryAfterClose',
  'newAfterCloseRejected',
  'xorSessionsIsolated',
  'realDatabaseCounts',
  'databaseHealthy',
  'workerNaturalExit'
])

function validateDb1Report (report) {
  if (!report || report.schemaVersion !== 1 || report.kind !== 'db1-storage-worker-composition') {
    throw new Error('invalid DB1 report envelope')
  }
  if (report.result !== 'pass' || report.gateStatus !== 'pass' || !/^43\./.test(String(report.runtime?.electron || ''))) {
    throw new Error('DB1 Electron composition did not pass')
  }
  const missing = REQUIRED_CHECKS.filter((name) => report.checks?.[name] !== true)
  if (missing.length > 0 || !Array.isArray(report.failedChecks) || report.failedChecks.length !== 0) {
    throw new Error(`DB1 checks failed or missing: ${missing.join(', ')}`)
  }
  if (report.metrics?.sessions !== 2 || report.metrics?.activeSessions !== 0 ||
      report.metrics?.captionEvents !== 4 || report.metrics?.segments !== 2) {
    throw new Error('DB1 persisted counts do not match the journey')
  }
  if (report.scope?.productAuthorityCutover !== false || report.scope?.jsonlMigration !== false ||
      report.scope?.historyUi !== false || report.scope?.workerAutoRecovery !== false ||
      report.scope?.packagedRuntime !== false || report.scope?.db6FullGate !== false) {
    throw new Error('DB1 report overclaims a pending product scope')
  }
  if (report.privacy?.noBrowserWindowCreated !== true || report.privacy?.isolatedUserData !== true ||
      report.privacy?.unsafeCaptionFieldsRejected !== true ||
      report.privacy?.reportContainsTranscriptText !== false || report.privacy?.reportContainsAbsolutePath !== false ||
      report.privacy?.persistedAudio !== false) {
    throw new Error('DB1 privacy evidence failed')
  }
  return report
}

function readAndValidateDb1Report (reportPath) {
  return validateDb1Report(JSON.parse(fs.readFileSync(path.resolve(reportPath), 'utf8')))
}

if (require.main === module) {
  if (process.argv.length !== 3) throw new Error('usage: node scripts/verify-db1-report.js <report.json>')
  const report = readAndValidateDb1Report(process.argv[2])
  process.stdout.write(JSON.stringify({
    result: report.result,
    runtime: report.runtime,
    metrics: report.metrics
  }) + '\n')
}

module.exports = { REQUIRED_CHECKS, readAndValidateDb1Report, validateDb1Report }
