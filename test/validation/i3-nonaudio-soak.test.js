'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { DEFAULT_SEGMENT_COUNT, runI3NonAudioSoak } = require('../../scripts/i3-nonaudio-soak')
const {
  readAndValidateI3NonAudioReport,
  validateI3NonAudioReport
} = require('../../scripts/verify-i3-nonaudio-report')

const ROOT = path.resolve(__dirname, '../..')
test('tracked I3 non-audio evidence remains strict, reproducible in shape, and explicitly partial', () => {
  const report = readAndValidateI3NonAudioReport(
    path.join(ROOT, 'docs', 'validation', 'i3-nonaudio-results.json')
  )
  assert.equal(report.fixture.segmentCount, 3600)
  assert.equal(report.fixture.captionEventCount, 4000)
  assert.equal(report.fixture.refinedSegmentCount, 400)
  assert.equal(report.boundaries.realTwoHourAudioSoak, false)
  assert.equal(report.gateStatus, 'partial')
  assert.equal(report.metrics.segmentCount, report.fixture.segmentCount)
  assert.equal(report.metrics.captionEventCount, report.fixture.captionEventCount)
  assert.equal(report.metrics.recoveredRefinedSegmentCount, report.fixture.refinedSegmentCount)
  assert.equal(report.metrics.historyPageCount, 72)
  assert.equal(report.metrics.pageQueryCount, 72)
  assert.equal(report.metrics.exportCount, 3)
  assert.equal(report.metrics.journalMode, 'wal')
  assert.ok(report.metrics.maxQueueDepth <= report.limits.maxQueueDepth)
  assert.ok(report.metrics.maxRssBytes <= report.limits.maxRssBytes)
  assert.ok(report.metrics.maxHeapUsedBytes <= report.limits.maxHeapUsedBytes)
  assert.ok(report.metrics.cpuPercent <= report.limits.maxCpuPercent)
  assert.ok(report.metrics.pageQueryP95Ms <= report.limits.maxQueryP95Ms)
  assert.ok(report.metrics.walBytes <= report.limits.maxWalBytes)
  assert.ok(report.metrics.historyDomMaxNodes <= report.limits.maxDomNodes)
})

test('I3 non-audio soak: deterministic thousands-segment virtual two-hour fixture stays bounded and is explicitly partial', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'i3-nonaudio-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const tracked = readAndValidateI3NonAudioReport(
    path.join(ROOT, 'docs', 'validation', 'i3-nonaudio-results.json')
  )
  const report = await runI3NonAudioSoak({
    batchSize: 100,
    rootDirectory: root,
    segmentCount: DEFAULT_SEGMENT_COUNT
  })
  assert.equal(report.result, 'pass')
  assert.equal(report.gateStatus, 'partial')
  assert.equal(report.boundaries.realTwoHourAudioSoak, false)
  assert.equal(report.boundaries.microphoneAccess, false)
  assert.equal(report.fixture.segmentCount, DEFAULT_SEGMENT_COUNT)
  assert.equal(report.fixture.virtualDurationMs, 2 * 60 * 60 * 1000)
  assert.equal(report.metrics.historyDomMaxNodes <= 50, true)
  assert.equal(report.metrics.recoveredRefinedSegmentCount, report.fixture.refinedSegmentCount)
  assert.doesNotMatch(JSON.stringify(report), /fixture subtitle|[A-Za-z]:[\\/]/)
  assert.deepEqual(report.fixture, tracked.fixture)
  assert.deepEqual(report.exports, tracked.exports)
  assert.deepEqual(report.provenance, tracked.provenance)
  assert.deepEqual(validateI3NonAudioReport(report), report)
  const reportPath = path.join(root, 'i3-nonaudio-report.json')
  fs.writeFileSync(reportPath, JSON.stringify(report), 'utf8')
  assert.deepEqual(readAndValidateI3NonAudioReport(reportPath), report)
  const duplicateKeyPath = path.join(root, 'i3-nonaudio-duplicate-key.json')
  fs.writeFileSync(duplicateKeyPath, '{"schemaVersion":1,"schemaVersion":1}', 'utf8')
  assert.throws(() => readAndValidateI3NonAudioReport(duplicateKeyPath), /duplicate object key/)
  const audioOverclaim = structuredClone(report)
  audioOverclaim.boundaries.realTwoHourAudioSoak = true
  assert.throws(() => validateI3NonAudioReport(audioOverclaim), /overclaims a real audio/i)
  const staleProvenance = structuredClone(report)
  staleProvenance.provenance.runnerSha256 = '0'.repeat(64)
  assert.throws(() => validateI3NonAudioReport(staleProvenance), /provenance drifted for runnerSha256/)
  const exportDrift = structuredClone(report)
  exportDrift.exports.text.sha256 = '0'.repeat(64)
  assert.throws(() => validateI3NonAudioReport(exportDrift), /exports differs from the tracked 3600-segment baseline/)
  const malformedGeneratedAt = structuredClone(report)
  malformedGeneratedAt.generatedAt = '2026-08-01T00:00:00Z'
  assert.throws(() => validateI3NonAudioReport(malformedGeneratedAt), /generatedAt must be a canonical UTC ISO-8601/i)
})
