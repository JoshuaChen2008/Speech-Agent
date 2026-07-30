'use strict'

// @ts-check

const fs = require('node:fs')
const path = require('node:path')

const REQUIRED_CHECKS = Object.freeze([
  'openBeforeCapture',
  'persistenceEnqueuedBeforeUi',
  'stopBarrierBeforeIdle',
  'pauseResumeSameSession',
  'idleWorkerExitRecovered',
  'xorSessionsIsolated',
  'partialAndTranslatedExcluded',
  'databaseHealthy',
  'beforeCommitReplay',
  'afterCommitReplay',
  'allGatewayShutdownsCompleted',
  'noJsonlDualWrite',
  'noAudioArtifacts'
])

function validateStorageGatewayReport (report) {
  if (!report || report.schemaVersion !== 1 || report.kind !== 'storage-gateway-coordinator-composition') {
    throw new Error('invalid storage gateway report envelope')
  }
  if (report.result !== 'pass' || report.gateStatus !== 'pass' ||
      !/^43\./.test(String(report.runtime?.electron || ''))) {
    throw new Error('storage gateway Electron composition did not pass')
  }
  const missing = REQUIRED_CHECKS.filter((name) => report.checks?.[name] !== true)
  if (missing.length > 0 || !Array.isArray(report.failedChecks) || report.failedChecks.length !== 0) {
    throw new Error(`storage gateway checks failed or missing: ${missing.join(', ')}`)
  }
  if (report.metrics?.sessions !== 2 || report.metrics?.captionEvents !== 3 || report.metrics?.segments !== 2 ||
      report.metrics?.beforeCommitGenerations !== 2 || report.metrics?.afterCommitGenerations !== 2) {
    throw new Error('storage gateway metrics do not match the required journeys')
  }
  if (report.scope?.defaultProductAuthorityCutover !== false || report.scope?.jsonlMigration !== false ||
      report.scope?.historyUi !== false || report.scope?.beforeQuitProductWiring !== false ||
      report.scope?.packagedRuntime !== false || report.scope?.db6FullGate !== false) {
    throw new Error('storage gateway report overclaims pending product scope')
  }
  if (report.privacy?.noBrowserWindowCreated !== true || report.privacy?.isolatedUserData !== true ||
      report.privacy?.reportContainsTranscriptText !== false || report.privacy?.reportContainsAbsolutePath !== false ||
      report.privacy?.persistedAudio !== false) {
    throw new Error('storage gateway privacy evidence failed')
  }
  return report
}

function readAndValidateStorageGatewayReport (reportPath) {
  return validateStorageGatewayReport(JSON.parse(fs.readFileSync(path.resolve(reportPath), 'utf8')))
}

if (require.main === module) {
  if (process.argv.length !== 3) {
    throw new Error('usage: node scripts/verify-storage-gateway-report.js <report.json>')
  }
  const report = readAndValidateStorageGatewayReport(process.argv[2])
  process.stdout.write(JSON.stringify({
    result: report.result,
    runtime: report.runtime,
    metrics: report.metrics
  }) + '\n')
}

module.exports = {
  REQUIRED_CHECKS,
  readAndValidateStorageGatewayReport,
  validateStorageGatewayReport
}
