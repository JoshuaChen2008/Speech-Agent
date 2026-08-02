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

test('Gateway 旅程按会话冻结精修偏好并保持首次稳定转写与精修稿独立', () => {
  const smoke = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'storage-gateway-smoke.js'), 'utf8')

  assert.match(smoke, /const DEV_RUNTIME_WITH_REFINEMENT = Object\.freeze\(\{ \.\.\.DEV_RUNTIME, refinementAvailable: true \}\)/)
  assert.match(smoke,
    /configuration: \{[\s\S]*?onboardingPreset: 'meeting'[\s\S]*?mic: false[\s\S]*?loopback: true[\s\S]*?refinementEnabled: true[\s\S]*?\}/)
  assert.match(smoke,
    /coordinator\.updateConfiguration\(\{[\s\S]*?onboardingPreset: 'dictation'[\s\S]*?mic: true[\s\S]*?loopback: false[\s\S]*?refinementEnabled: false[\s\S]*?\}\)/)
  assert.match(smoke, /loopbackHistory\.refinement\.refinementEnabled === true/)
  assert.match(smoke, /loopbackHistory\.segments\[0\]\?\.textRevision \|\| 0/)
  assert.match(smoke, /loopbackHistory\.segments\[0\]\?\.refinedText !== null/)
  assert.match(smoke, /micHistory\.refinement\.refinementEnabled === false/)
  assert.match(smoke, /micHistory\.segments\[0\]\?\.refinedText === null/)
})
