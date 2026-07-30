'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { validateStorageGatewayReport } = require('../../scripts/verify-storage-gateway-report')

const REPORT_PATH = path.join(__dirname, '..', '..', 'docs', 'validation', 'storage-gateway-results.json')

test('tracked Gateway evidence proves Coordinator persistence barriers and real worker replay', () => {
  const report = validateStorageGatewayReport(JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8')))
  assert.equal(report.result, 'pass')
  assert.deepEqual(report.failedChecks, [])
  assert.equal(report.metrics.beforeCommitGenerations, 2)
  assert.equal(report.metrics.afterCommitGenerations, 2)
  assert.equal(report.scope.defaultProductAuthorityCutover, false)
  assert.equal(report.scope.beforeQuitProductWiring, false)
})

test('Gateway evidence verifier rejects cutover, quit and privacy overclaims', () => {
  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'))
  assert.throws(
    () => validateStorageGatewayReport({
      ...report,
      scope: { ...report.scope, defaultProductAuthorityCutover: true }
    }),
    /overclaims/
  )
  assert.throws(
    () => validateStorageGatewayReport({
      ...report,
      scope: { ...report.scope, beforeQuitProductWiring: true }
    }),
    /overclaims/
  )
  assert.throws(
    () => validateStorageGatewayReport({ ...report, privacy: { ...report.privacy, persistedAudio: true } }),
    /privacy/
  )
})
