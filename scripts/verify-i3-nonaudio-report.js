'use strict'

// @ts-check

const fs = require('node:fs')
const path = require('node:path')

const { parseStrictEvidenceJson } = require('./strict-evidence-json')
const {
  LIMITS,
  MIN_SEGMENTS,
  MIN_VIRTUAL_DURATION_MS,
  PAGE_SIZE,
  PROVENANCE_FILES,
  currentProvenance
} = require('./i3-nonaudio-soak')

const TRACKED_REPORT_PATH = path.resolve(__dirname, '..', 'docs', 'validation', 'i3-nonaudio-results.json')

function exactKeys (value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has unexpected keys`)
  }
  return value
}

function finiteNonNegative (value, label) {
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be a non-negative finite number`)
  return value
}

function positiveInteger (value, label, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError(`${label} must be an integer >= ${minimum}`)
  return value
}

function sha256 (value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${label} must be a SHA-256 digest`)
}

function strictGeneratedAt (value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TypeError('generatedAt must be a canonical UTC ISO-8601 millisecond timestamp')
  }
  const milliseconds = Date.parse(value)
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError('generatedAt must be a real canonical UTC timestamp')
  }
}

function trackedBaseline () {
  return parseStrictEvidenceJson(fs.readFileSync(TRACKED_REPORT_PATH), 'tracked I3 non-audio report')
}

function assertCurrentProvenance (provenance) {
  const expected = currentProvenance()
  exactKeys(provenance, Object.keys(expected), 'provenance')
  for (const [key, digest] of Object.entries(expected)) {
    sha256(provenance[key], `provenance.${key}`)
    if (provenance[key] !== digest) throw new Error(`I3 non-audio provenance drifted for ${key}`)
  }
}

function assertTrackedDeterministicBaseline (report) {
  const tracked = trackedBaseline()
  for (const key of ['fixture', 'exports', 'provenance']) {
    if (JSON.stringify(report[key]) !== JSON.stringify(tracked[key])) {
      throw new Error(`I3 non-audio ${key} differs from the tracked 3600-segment baseline`)
    }
  }
}

function validateExport (value, label, segmentCount) {
  exactKeys(value, ['bytes', 'recordCount', 'sha256'], label)
  positiveInteger(value.bytes, `${label}.bytes`, 1)
  if (value.recordCount !== segmentCount) throw new Error(`${label} must contain every fixture segment`)
  sha256(value.sha256, `${label}.sha256`)
}

function validateI3NonAudioReport (report) {
  exactKeys(report, [
    'boundaries', 'checks', 'exports', 'fixture', 'gateStatus', 'generatedAt', 'kind', 'limits',
    'metrics', 'privacy', 'provenance', 'result', 'schemaVersion'
  ], 'I3 non-audio report')
  if (report.schemaVersion !== 1 || report.kind !== 'i3-nonaudio-soak') throw new Error('invalid I3 non-audio report envelope')
  if (report.result !== 'pass' || report.gateStatus !== 'partial') {
    throw new Error('a non-audio qualification must be pass/partial, never an I3 full acceptance')
  }
  strictGeneratedAt(report.generatedAt)

  exactKeys(report.boundaries, [
    'deterministicCaptionFixture', 'electronBrowserWindow', 'fakeRuntimeAdapter',
    'historyRendererVmHarness', 'inProcessStorageHost', 'loopbackAccess', 'microphoneAccess',
    'qualification', 'realTwoHourAudioSoak', 'speakerPlayback', 'usesHistoryRendererScript'
  ], 'boundaries')
  if (report.boundaries.deterministicCaptionFixture !== true ||
      report.boundaries.historyRendererVmHarness !== true ||
      report.boundaries.usesHistoryRendererScript !== true ||
      report.boundaries.fakeRuntimeAdapter !== true ||
      report.boundaries.inProcessStorageHost !== true ||
      report.boundaries.electronBrowserWindow !== false ||
      report.boundaries.loopbackAccess !== false || report.boundaries.microphoneAccess !== false ||
      report.boundaries.speakerPlayback !== false || report.boundaries.realTwoHourAudioSoak !== false ||
      report.boundaries.qualification !== 'deterministic-nonaudio-prequalification-only') {
    throw new Error('I3 non-audio report overclaims a real audio or Electron acceptance scope')
  }

  exactKeys(report.fixture, [
    'captionEventCount', 'clockSemantics', 'fixtureId', 'refinedSegmentCount', 'segmentCount',
    'segmentIntervalMs', 'timelineEndMs', 'virtualDurationMs'
  ], 'fixture')
  if (report.fixture.fixtureId !== 'i3-nonaudio-deterministic-v1' ||
      report.fixture.clockSemantics !== 'accelerated-virtual-caption-time') {
    throw new Error('I3 non-audio fixture identity is invalid')
  }
  const segmentCount = positiveInteger(report.fixture.segmentCount, 'fixture.segmentCount', MIN_SEGMENTS)
  const refinedSegmentCount = positiveInteger(report.fixture.refinedSegmentCount, 'fixture.refinedSegmentCount')
  positiveInteger(report.fixture.captionEventCount, 'fixture.captionEventCount', segmentCount)
  finiteNonNegative(report.fixture.segmentIntervalMs, 'fixture.segmentIntervalMs')
  if (report.fixture.virtualDurationMs < MIN_VIRTUAL_DURATION_MS ||
      report.fixture.timelineEndMs !== report.fixture.virtualDurationMs ||
      report.fixture.segmentIntervalMs * segmentCount !== report.fixture.virtualDurationMs ||
      report.fixture.captionEventCount !== segmentCount + refinedSegmentCount) {
    throw new Error('I3 non-audio fixture does not encode a complete two-hour virtual timeline')
  }

  exactKeys(report.limits, Object.keys(LIMITS), 'limits')
  for (const [key, value] of Object.entries(LIMITS)) {
    if (report.limits[key] !== value) throw new Error(`I3 non-audio report changed fixed limit ${key}`)
  }

  const requiredChecks = [
    'acceleratedTimelineCoversTwoHours', 'captionsCommitted', 'cpuBounded', 'exportsComplete',
    'historyDomBounded', 'historyPaginationComplete', 'memoryBounded', 'noAudioArtifacts',
    'queryP95Bounded', 'queueBounded', 'refinedProjectionRecovered', 'thousandsOfSegments',
    'walBounded', 'walMode'
  ]
  exactKeys(report.checks, requiredChecks, 'checks')
  if (requiredChecks.some((key) => report.checks[key] !== true)) throw new Error('I3 non-audio qualification has failed checks')

  exactKeys(report.metrics, [
    'captionEventCount', 'checkpointedWalFrames', 'cpuPercent', 'cpuSystemMs', 'cpuUserMs',
    'exportCount', 'historyDomMaxNodes', 'historyPageCount', 'journalMode', 'maxHeapUsedBytes',
    'maxQueueDepth', 'maxRssBytes', 'pageCount', 'pageQueryCount', 'pageQueryP95Ms',
    'recoveredRefinedSegmentCount', 'segmentCount', 'walBytes', 'walFrames', 'wallDurationMs'
  ], 'metrics')
  for (const key of Object.keys(report.metrics).filter((key) => key !== 'journalMode')) {
    finiteNonNegative(report.metrics[key], `metrics.${key}`)
  }
  if (report.metrics.journalMode !== 'wal') throw new Error('I3 non-audio SQLite journal mode is not WAL')
  if (report.metrics.segmentCount !== segmentCount || report.metrics.captionEventCount !== report.fixture.captionEventCount ||
      report.metrics.recoveredRefinedSegmentCount !== refinedSegmentCount || report.metrics.exportCount !== 3 ||
      report.metrics.historyPageCount !== Math.ceil(segmentCount / PAGE_SIZE) ||
      report.metrics.pageQueryCount !== Math.ceil(segmentCount / PAGE_SIZE)) {
    throw new Error('I3 non-audio report counts do not match its fixture')
  }
  if (report.metrics.maxQueueDepth > LIMITS.maxQueueDepth || report.metrics.maxRssBytes > LIMITS.maxRssBytes ||
      report.metrics.maxHeapUsedBytes > LIMITS.maxHeapUsedBytes || report.metrics.cpuPercent > LIMITS.maxCpuPercent ||
      report.metrics.pageQueryP95Ms > LIMITS.maxQueryP95Ms || report.metrics.walBytes > LIMITS.maxWalBytes ||
      report.metrics.historyDomMaxNodes > LIMITS.maxDomNodes) {
    throw new Error('I3 non-audio report exceeds a fixed bounded-resource threshold')
  }

  exactKeys(report.exports, ['markdown', 'srt', 'text'], 'exports')
  validateExport(report.exports.text, 'exports.text', segmentCount)
  validateExport(report.exports.markdown, 'exports.markdown', segmentCount)
  validateExport(report.exports.srt, 'exports.srt', segmentCount)
  assertCurrentProvenance(report.provenance)
  assertTrackedDeterministicBaseline(report)

  exactKeys(report.privacy, ['persistedAudio', 'reportContainsAbsolutePath', 'reportContainsTranscriptText'], 'privacy')
  if (report.privacy.persistedAudio !== false || report.privacy.reportContainsAbsolutePath !== false ||
      report.privacy.reportContainsTranscriptText !== false) {
    throw new Error('I3 non-audio privacy report is invalid')
  }
  const rendered = JSON.stringify(report)
  if (/fixture subtitle|[A-Za-z]:[\\/]|(?:^|[^:])\/Users\//.test(rendered)) {
    throw new Error('I3 non-audio report leaks transcript text or absolute paths')
  }
  return report
}

function readAndValidateI3NonAudioReport (reportPath) {
  const resolved = path.resolve(reportPath)
  return validateI3NonAudioReport(parseStrictEvidenceJson(fs.readFileSync(resolved), `I3 non-audio report ${path.basename(resolved)}`))
}

if (require.main === module) {
  if (process.argv.length !== 3) throw new Error('usage: node scripts/verify-i3-nonaudio-report.js <report.json>')
  const report = readAndValidateI3NonAudioReport(process.argv[2])
  process.stdout.write(JSON.stringify({
    gateStatus: report.gateStatus,
    result: report.result,
    segmentCount: report.fixture.segmentCount,
    virtualDurationMs: report.fixture.virtualDurationMs
  }) + '\n')
}

module.exports = {
  TRACKED_REPORT_PATH,
  readAndValidateI3NonAudioReport,
  validateI3NonAudioReport
}
