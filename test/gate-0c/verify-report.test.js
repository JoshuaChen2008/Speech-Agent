'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { validateGate0CMetricsReport } = require('../../scripts/gate-0c/verify-report')
const { parseStrictEvidenceJson } = require('../../scripts/strict-evidence-json')

const REPORT_PATH = path.resolve(__dirname, '../../docs/validation/i2-live-v4/gate-0c-preflight.json')
const TRACKED_REPORT_BYTES = fs.readFileSync(REPORT_PATH)
const TRACKED_REPORT = parseStrictEvidenceJson(TRACKED_REPORT_BYTES, 'tracked Gate 0C report')

function mutateReport (mutate) {
  const report = structuredClone(TRACKED_REPORT)
  mutate(report)
  return report
}

function rejectsMutation (mutate) {
  assert.throws(() => validateGate0CMetricsReport(mutateReport(mutate)))
}

test('schema2 validator accepts the tracked Gate 0C report', () => {
  assert.equal(validateGate0CMetricsReport(structuredClone(TRACKED_REPORT)).result, 'pass')
})

test('Gate evidence parser rejects duplicate raw keys before object validation', () => {
  const source = TRACKED_REPORT_BYTES.toString('utf8')
  const duplicated = Buffer.from(source.replace(
    '"runId": ',
    '"runId": "C:/private/recording.wav",\n  "runId": '
  ))
  assert.throws(() => parseStrictEvidenceJson(duplicated, 'tampered Gate 0C report'), /duplicate object key/)
})

test('schema2 validator closes root, nested objects, and array elements', () => {
  const mutations = [
    (report) => { report.operatorAlias = 'private-operator' },
    (report) => { report.environment.debugTranscript = 'private transcript' },
    (report) => { report.window.visibility[0].operatorAlias = 'private-operator' },
    (report) => { report.window.visibility[2].detail.debugTranscript = 'private transcript' },
    (report) => { report.permissions.checks[0].operatorAlias = 'private-operator' },
    (report) => { report.permissions.requests[0].debugTranscript = 'private transcript' },
    (report) => { report.displayRequests[0].operatorAlias = 'private-operator' },
    (report) => { report.capture.mic.stream.track.debugTranscript = 'private transcript' },
    (report) => { report.capture.mic.capture.diagnostic.analysis.probe.operatorAlias = 'private-operator' },
    (report) => { report.diagnostics.loopback.checks.debugTranscript = 'private transcript' },
    (report) => { report.decision.operatorAlias = 'private-operator' },
    (report) => { report.privacy.debugTranscript = 'private transcript' }
  ]
  for (const mutate of mutations) rejectsMutation(mutate)
})

test('schema2 validator requires plain objects and closed dense arrays', () => {
  rejectsMutation((report) => { Object.setPrototypeOf(report.capture.mic.stream.track.settings, { inherited: true }) })
  rejectsMutation((report) => { report.displayRequests.extra = true })
  rejectsMutation((report) => { delete report.window.visibility[3] })
  rejectsMutation((report) => { report.permissions.requests[0].mediaTypes.extra = 'audio' })
})

test('schema2 validator requires canonical run identity and UTC millisecond time', () => {
  const mutations = [
    (report) => { delete report.runId },
    (report) => { report.runId = 'gate-0c-2026-07-31T06:00:04.063Z' },
    (report) => { report.runId = 'gate-0c-2026-02-30T06-00-04-063Z' },
    (report) => { report.runId = 'gate-0c-2026-07-31T07-00-04-063Z' },
    (report) => { report.runId = 'gate-0c-2026-07-30T06-00-04-063Z' },
    (report) => { report.executedAt = '2026-07-31T14:00:17.189+08:00' },
    (report) => { report.executedAt = '2026-07-31T06:00:17Z' },
    (report) => { report.executedAt = '2026-02-30T06:00:17.189Z' }
  ]
  for (const mutate of mutations) rejectsMutation(mutate)
})

test('schema2 validator whitelists every persisted string including canonical notes', () => {
  const mutations = [
    (report) => { report.environment.osVersion = 'Windows 11 Home - operator Joshua' },
    (report) => { report.environment.node = '24.18.0-private' },
    (report) => { report.permissions.checks[0].permission = 'debug-transcript' },
    (report) => { report.capture.mic.stream.track.labelSha256 = 'A'.repeat(64) },
    (report) => { report.decision.note = 'Passed for operator Joshua at a private location.' },
    (report) => { report.privacy.note = 'Private transcript: secret customer discussion.' }
  ]
  for (const mutate of mutations) rejectsMutation(mutate)
})

test('schema2 validator rejects coercible, non-finite, fractional, unsafe, and negative numbers', () => {
  const mutations = [
    (report) => { report.testSignal.frequencyHz = '997' },
    (report) => { report.capture.loopback.capture.diagnostic.analysis.peak = Number.NaN },
    (report) => { report.capture.mic.capture.pipeline.wallElapsedSeconds = Number.POSITIVE_INFINITY },
    (report) => { report.capture.micProbe.capture.pipeline.frameCount = 27.5 },
    (report) => { report.displayRequests[0].availableScreenSourceCount = Number.MAX_SAFE_INTEGER + 1 },
    (report) => { report.diagnostics.mic.analysis.clippingCount = -1 }
  ]
  for (const mutate of mutations) rejectsMutation(mutate)
})

test('schema2 validator preserves decision and duplicate diagnostic consistency', () => {
  rejectsMutation((report) => { report.decision.hiddenThroughout = false })
  rejectsMutation((report) => { report.capture.mic.capture.diagnostic.analysis.peak += 0.001 })
  rejectsMutation((report) => { report.capture.loopback.capture.pipeline.sampleCount += 1 })
})
