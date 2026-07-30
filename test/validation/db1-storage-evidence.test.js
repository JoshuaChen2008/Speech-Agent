'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { validateDb1Report } = require('../../scripts/verify-db1-report')

const REPORT_PATH = path.join(__dirname, '..', '..', 'docs', 'validation', 'db1-storage-results.json')

test('tracked DB1 evidence proves real worker composition without claiming product cutover', () => {
  const report = validateDb1Report(JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8')))
  assert.equal(report.result, 'pass')
  assert.match(report.runtime.electron, /^43\./)
  assert.deepEqual(report.failedChecks, [])
  assert.equal(report.metrics.sessions, 2)
  assert.equal(report.metrics.activeSessions, 0)
  assert.equal(report.privacy.unsafeCaptionFieldsRejected, true)
  assert.equal(report.scope.productAuthorityCutover, false)
  assert.equal(report.scope.workerAutoRecovery, false)
  assert.equal(report.scope.db6FullGate, false)
})

test('DB1 verifier rejects product-authority and privacy overclaims', () => {
  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'))
  assert.throws(
    () => validateDb1Report({ ...report, scope: { ...report.scope, productAuthorityCutover: true } }),
    /overclaims/
  )
  assert.throws(
    () => validateDb1Report({ ...report, privacy: { ...report.privacy, persistedAudio: true } }),
    /privacy/
  )
})
