'use strict'

// @ts-check

const fs = require('node:fs')
const path = require('node:path')

const { TRACKED_LAYOUT_PATH, readTrackedLayoutEvidence } = require('./verify-i4-nonaudio-nsis-report')
const {
  readAndValidateI4AudioChildReport,
  readNonAudioEvidence,
  sha256Bytes
} = require('./verify-i4-audio-child-report')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')

const EXPECTED_LIMITATIONS = Object.freeze([
  'unsigned-internal-candidate',
  'operator-driven-permission-and-gui-observation',
  'does-not-close-i2-performance-or-i3-soak'
])
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function exactKeys (value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has unexpected keys`)
  }
  return value
}

function requireSha256 (value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`)
  }
}

function requireCanonicalUtc (value) {
  if (typeof value !== 'string' || !UTC_PATTERN.test(value) ||
      new Date(Date.parse(value)).toISOString() !== value) {
    throw new TypeError('generatedAt must be a canonical UTC ISO-8601 millisecond timestamp')
  }
}

function readI4ReleaseChildren ({
  nonAudioReportPath,
  loopbackReportPath,
  micReportPath,
  layoutPath = TRACKED_LAYOUT_PATH
}) {
  const layoutEvidence = readTrackedLayoutEvidence(layoutPath)
  const nonAudioEvidence = readNonAudioEvidence(nonAudioReportPath, layoutPath)
  const loopbackEvidence = readAndValidateI4AudioChildReport({
    reportPath: loopbackReportPath,
    expectedSource: 'loopback',
    nonAudioReportPath,
    layoutPath
  })
  const micEvidence = readAndValidateI4AudioChildReport({
    reportPath: micReportPath,
    expectedSource: 'mic',
    nonAudioReportPath,
    layoutPath,
    priorLoopbackReportPath: loopbackReportPath
  })
  return Object.freeze({ layoutEvidence, nonAudioEvidence, loopbackEvidence, micEvidence })
}

function buildI4ReleaseSummary ({ generatedAt, children }) {
  const { layoutEvidence, nonAudioEvidence, loopbackEvidence, micEvidence } = children
  const layout = layoutEvidence.layout
  return {
    schemaVersion: 1,
    kind: 'i4-release-acceptance-summary',
    generatedAt,
    result: 'pass',
    gateStatus: 'release-acceptance-complete',
    artifact: {
      b5LayoutEvidenceSha256: layoutEvidence.sha256,
      installerSha256: layout.artifact.installerSha256,
      productPayloadVersion: layout.artifact.productPayloadVersion,
      productPayloadFileCount: layout.artifact.productPayloadFileCount,
      productPayloadSha256: layout.artifact.productPayloadSha256,
      exactCandidateBound: true
    },
    children: {
      nonAudio: {
        reportSha256: nonAudioEvidence.sha256,
        result: nonAudioEvidence.report.result,
        gateStatus: nonAudioEvidence.report.gateStatus
      },
      loopback: {
        reportSha256: loopbackEvidence.sha256,
        result: loopbackEvidence.report.result,
        gateStatus: loopbackEvidence.report.gateStatus,
        sourceId: loopbackEvidence.report.sourceId
      },
      mic: {
        reportSha256: micEvidence.sha256,
        result: micEvidence.report.result,
        gateStatus: micEvidence.report.gateStatus,
        sourceId: micEvidence.report.sourceId,
        priorLoopbackChildReportSha256: micEvidence.report.ordering.priorLoopbackChildReportSha256
      }
    },
    coverage: {
      sourceOrder: ['loopback', 'mic'],
      mutuallyExclusiveSourceChildren: true,
      permissionDeniedAndApprovedForBothSources: true,
      startPauseResumeStopForBothSources: true,
      firstPassFinalAndRefinementForBothSources: true,
      historyAndNativeExportForBothSources: true,
      offlineRestartForBothSources: true,
      nonAudioLifecycleBound: true
    },
    privacy: {
      childAudioFileCount: 0,
      childPersistedAudioReferenceCount: 0,
      summaryContainsTranscriptText: false,
      summaryContainsDeviceName: false,
      summaryContainsAbsolutePath: false
    },
    limitations: [...EXPECTED_LIMITATIONS]
  }
}

function validateI4ReleaseSummary (summary, children) {
  exactKeys(children, ['layoutEvidence', 'loopbackEvidence', 'micEvidence', 'nonAudioEvidence'], 'I4 release children')
  const expected = buildI4ReleaseSummary({ generatedAt: summary.generatedAt, children })
  exactKeys(summary, [
    'artifact', 'children', 'coverage', 'gateStatus', 'generatedAt', 'kind',
    'limitations', 'privacy', 'result', 'schemaVersion'
  ], 'I4 release summary')
  if (summary.schemaVersion !== 1 || summary.kind !== 'i4-release-acceptance-summary' ||
      summary.result !== 'pass' || summary.gateStatus !== 'release-acceptance-complete') {
    throw new Error('invalid I4 release summary envelope')
  }
  requireCanonicalUtc(summary.generatedAt)

  exactKeys(summary.artifact, [
    'b5LayoutEvidenceSha256', 'exactCandidateBound', 'installerSha256',
    'productPayloadFileCount', 'productPayloadSha256', 'productPayloadVersion'
  ], 'artifact')
  for (const key of ['b5LayoutEvidenceSha256', 'installerSha256', 'productPayloadSha256']) {
    requireSha256(summary.artifact[key], `artifact.${key}`)
  }
  if (JSON.stringify(summary.artifact) !== JSON.stringify(expected.artifact)) {
    throw new Error('I4 release summary artifact binding is inconsistent')
  }

  exactKeys(summary.children, ['loopback', 'mic', 'nonAudio'], 'children')
  exactKeys(summary.children.nonAudio, ['gateStatus', 'reportSha256', 'result'], 'children.nonAudio')
  exactKeys(summary.children.loopback, ['gateStatus', 'reportSha256', 'result', 'sourceId'], 'children.loopback')
  exactKeys(summary.children.mic, [
    'gateStatus', 'priorLoopbackChildReportSha256', 'reportSha256', 'result', 'sourceId'
  ], 'children.mic')
  for (const child of ['nonAudio', 'loopback', 'mic']) {
    requireSha256(summary.children[child].reportSha256, `children.${child}.reportSha256`)
  }
  requireSha256(summary.children.mic.priorLoopbackChildReportSha256,
    'children.mic.priorLoopbackChildReportSha256')
  if (JSON.stringify(summary.children) !== JSON.stringify(expected.children)) {
    throw new Error('I4 release summary child digests or source order are inconsistent')
  }

  exactKeys(summary.coverage, [
    'firstPassFinalAndRefinementForBothSources', 'historyAndNativeExportForBothSources',
    'mutuallyExclusiveSourceChildren', 'nonAudioLifecycleBound', 'offlineRestartForBothSources',
    'permissionDeniedAndApprovedForBothSources', 'sourceOrder', 'startPauseResumeStopForBothSources'
  ], 'coverage')
  if (JSON.stringify(summary.coverage) !== JSON.stringify(expected.coverage)) {
    throw new Error('I4 release summary coverage is incomplete')
  }

  exactKeys(summary.privacy, [
    'childAudioFileCount', 'childPersistedAudioReferenceCount',
    'summaryContainsAbsolutePath', 'summaryContainsDeviceName', 'summaryContainsTranscriptText'
  ], 'privacy')
  if (JSON.stringify(summary.privacy) !== JSON.stringify(expected.privacy)) {
    throw new Error('I4 release summary violates the SEM-F14 privacy boundary')
  }
  if (JSON.stringify(summary.limitations) !== JSON.stringify(EXPECTED_LIMITATIONS)) {
    throw new Error('I4 release summary limitations are inconsistent')
  }

  const serialized = JSON.stringify(summary)
  if (/[A-Za-z]:[\\/]/.test(serialized) || /file:\/\//i.test(serialized) ||
      /https?:\/\//i.test(serialized) ||
      /\"(?:deviceName|deviceLabel|captionText|transcriptText|localPath|modelPath|audioPath)\"\s*:/i.test(serialized) ||
      /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)(?:$|[?#"'])/i.test(serialized)) {
    throw new Error('I4 release summary leaked a path, device, caption text or audio reference')
  }
  return summary
}

function readAndValidateI4ReleaseSummary ({
  summaryPath,
  nonAudioReportPath,
  loopbackReportPath,
  micReportPath,
  layoutPath = TRACKED_LAYOUT_PATH
}) {
  const children = readI4ReleaseChildren({
    nonAudioReportPath,
    loopbackReportPath,
    micReportPath,
    layoutPath
  })
  const resolved = path.resolve(summaryPath)
  const bytes = fs.readFileSync(resolved)
  const summary = parseStrictEvidenceJson(bytes, `I4 release summary ${path.basename(resolved)}`)
  return Object.freeze({ summary: validateI4ReleaseSummary(summary, children), sha256: sha256Bytes(bytes) })
}

if (require.main === module) {
  const [summaryPath, nonAudioReportPath, loopbackReportPath, micReportPath, layoutPath] = process.argv.slice(2)
  if (!summaryPath || !nonAudioReportPath || !loopbackReportPath || !micReportPath ||
      process.argv.length > 7) {
    throw new Error('usage: node scripts/verify-i4-release-summary.js <summary.json> <non-audio.json> <loopback.json> <mic.json> [b5-layout.json]')
  }
  const evidence = readAndValidateI4ReleaseSummary({
    summaryPath,
    nonAudioReportPath,
    loopbackReportPath,
    micReportPath,
    layoutPath: layoutPath || TRACKED_LAYOUT_PATH
  })
  process.stdout.write(JSON.stringify({
    result: evidence.summary.result,
    gateStatus: evidence.summary.gateStatus,
    summarySha256: evidence.sha256
  }) + '\n')
}

module.exports = {
  EXPECTED_LIMITATIONS,
  buildI4ReleaseSummary,
  readAndValidateI4ReleaseSummary,
  readI4ReleaseChildren,
  validateI4ReleaseSummary
}
