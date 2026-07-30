'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { validateDb0DevelopmentReport } = require('../../scripts/verify-db0-report')

const REPORT_PATH = path.join(__dirname, '..', '..', 'docs', 'validation', 'db0-sqlite-development-results.json')

test('tracked DB0 evidence proves the Electron development lane without overclaiming packaging', () => {
  const report = validateDb0DevelopmentReport(JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8')))
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.kind, 'db0-sqlite-development-qualification')
  assert.equal(report.result, 'pass')
  assert.equal(report.gateStatus, 'partial')
  assert.equal(report.development.status, 'pass')
  assert.deepEqual(report.development.failedChecks, [])
  assert.match(report.development.runtime.electron, /^43\./)
  assert.equal(report.packaged.status, 'pending')
  assert.equal(report.process.workerExitCode, 0)
  assert.equal(report.process.noBrowserWindowCreated, true)
  assert.equal(report.process.isolatedUserData, true)
  assert.equal(report.process.reportContainsTranscriptText, false)
  assert.equal(report.process.reportContainsAbsolutePath, false)
  assert.equal(report.development.schema.privacy.containsAudioPersistenceSchema, false)
})

test('DB0 report verification rejects unit-only or packaged-gate overclaims', () => {
  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf8'))
  assert.throws(
    () => validateDb0DevelopmentReport({ ...report, process: { ...report.process, workerExitCode: null } }),
    /process isolation/
  )
  assert.throws(
    () => validateDb0DevelopmentReport({ ...report, gateStatus: 'pass', packaged: { status: 'pass' } }),
    /must not claim/
  )
})
