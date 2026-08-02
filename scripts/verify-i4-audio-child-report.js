'use strict'

// @ts-check

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const {
  TRACKED_LAYOUT_PATH,
  readAndValidateI4NonAudioNsisReport,
  readTrackedLayoutEvidence
} = require('./verify-i4-nonaudio-nsis-report')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')

const SOURCES = Object.freeze(['loopback', 'mic'])
const FORMATS = Object.freeze(['txt', 'md', 'srt'])
const EXPECTED_LIMITATIONS = Object.freeze([
  'operator-driven-permission-and-gui-observation',
  'single-source-child-only',
  'does-not-close-i2-performance-or-i3-soak',
  'unsigned-installer',
  'i4-full-status-partial'
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

function sha256Bytes (bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function requireSha256 (value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`)
  }
  return value
}

function requireCanonicalUtc (value) {
  if (typeof value !== 'string' || !UTC_PATTERN.test(value) ||
      new Date(Date.parse(value)).toISOString() !== value) {
    throw new TypeError('generatedAt must be a canonical UTC ISO-8601 millisecond timestamp')
  }
}

function requireTrueFields (value, fields, label) {
  for (const field of fields) {
    if (value[field] !== true) throw new Error(`${label}.${field} must be true`)
  }
}

function validateExportEvidence (value, label) {
  exactKeys(value, ['bytes', 'recordCount', 'sha256'], label)
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 ||
      !Number.isSafeInteger(value.recordCount) || value.recordCount < 1) {
    throw new Error(`${label} must describe a non-empty text export`)
  }
  requireSha256(value.sha256, `${label}.sha256`)
}

function validateExportSet (value, label) {
  exactKeys(value, ['markdown', 'srt', 'text'], label)
  validateExportEvidence(value.text, `${label}.text`)
  validateExportEvidence(value.markdown, `${label}.markdown`)
  validateExportEvidence(value.srt, `${label}.srt`)
  const records = [value.text.recordCount, value.markdown.recordCount, value.srt.recordCount]
  if (new Set(records).size !== 1) throw new Error(`${label} record counts must agree`)
  if (new Set(Object.values(value).map((entry) => entry.sha256)).size !== FORMATS.length) {
    throw new Error(`${label} must bind three distinct export artifacts`)
  }
}

function readNonAudioEvidence (reportPath, layoutPath = TRACKED_LAYOUT_PATH) {
  const bytes = fs.readFileSync(path.resolve(reportPath))
  return Object.freeze({
    report: readAndValidateI4NonAudioNsisReport(reportPath, layoutPath),
    sha256: sha256Bytes(bytes)
  })
}

function readAudioEvidence (reportPath) {
  const resolved = path.resolve(reportPath)
  const bytes = fs.readFileSync(resolved)
  return Object.freeze({
    bytes,
    report: parseStrictEvidenceJson(bytes, `I4 audio child ${path.basename(resolved)}`),
    sha256: sha256Bytes(bytes)
  })
}

function validateI4AudioChildReport (report, options) {
  exactKeys(options, ['layoutEvidence', 'nonAudioEvidence', 'priorLoopbackEvidence'], 'I4 audio validation options')
  const { layoutEvidence, nonAudioEvidence, priorLoopbackEvidence } = options
  exactKeys(layoutEvidence, ['layout', 'sha256'], 'B5 layout evidence')
  exactKeys(nonAudioEvidence, ['report', 'sha256'], 'I4 non-audio evidence')
  requireSha256(layoutEvidence.sha256, 'B5 layout evidence SHA-256')
  requireSha256(nonAudioEvidence.sha256, 'I4 non-audio evidence SHA-256')

  exactKeys(report, [
    'artifact', 'environment', 'exports', 'gateStatus', 'generatedAt', 'journey', 'kind',
    'limitations', 'ordering', 'permission', 'privacy', 'result', 'schemaVersion',
    'sourceEvidence', 'sourceId', 'sqlite'
  ], 'I4 audio child report')
  if (report.schemaVersion !== 1 || report.kind !== 'i4-audio-source-child' ||
      report.result !== 'pass' || report.gateStatus !== 'partial') {
    throw new Error('invalid I4 audio child envelope or full-I4 overclaim')
  }
  requireCanonicalUtc(report.generatedAt)
  if (!SOURCES.includes(report.sourceId)) throw new Error('I4 audio child sourceId is invalid')

  exactKeys(report.environment, [
    'downloadHostsUnreachable', 'harnessVerifiedInteractiveDesktop',
    'harnessVerifiedNodeCommandAbsent', 'harnessVerifiedNonElevated',
    'harnessVerifiedRepositoryAncestorsAbsent', 'offlineControl', 'osBuild', 'osFamily'
  ], 'environment')
  if (report.environment.osFamily !== 'windows' ||
      !Number.isSafeInteger(report.environment.osBuild) || report.environment.osBuild < 22000) {
    throw new Error('I4 audio child requires Windows 11')
  }
  requireTrueFields(report.environment, [
    'downloadHostsUnreachable', 'harnessVerifiedInteractiveDesktop',
    'harnessVerifiedNodeCommandAbsent', 'harnessVerifiedNonElevated',
    'harnessVerifiedRepositoryAncestorsAbsent'
  ], 'environment')
  if (report.environment.offlineControl !== nonAudioEvidence.report.offlineRestart.offlineControl) {
    throw new Error('I4 audio child offline control differs from the non-audio child')
  }

  const layout = layoutEvidence.layout
  const nonAudioArtifact = nonAudioEvidence.report.artifact
  exactKeys(report.artifact, [
    'b5LayoutEvidenceSha256', 'exactCandidateBound', 'installedAsarSha256',
    'installedExecutableSha256', 'installerSha256', 'nonAudioReportSha256',
    'productPayloadFileCount', 'productPayloadSha256', 'productPayloadVersion'
  ], 'artifact')
  for (const key of [
    'b5LayoutEvidenceSha256', 'installedAsarSha256', 'installedExecutableSha256',
    'installerSha256', 'nonAudioReportSha256', 'productPayloadSha256'
  ]) requireSha256(report.artifact[key], `artifact.${key}`)
  if (report.artifact.b5LayoutEvidenceSha256 !== layoutEvidence.sha256 ||
      report.artifact.nonAudioReportSha256 !== nonAudioEvidence.sha256 ||
      report.artifact.installerSha256 !== layout.artifact.installerSha256 ||
      report.artifact.installerSha256 !== nonAudioArtifact.installerSha256 ||
      report.artifact.installedExecutableSha256 !== layout.artifact.appExecutableSha256 ||
      report.artifact.installedAsarSha256 !== layout.artifact.appAsarSha256 ||
      report.artifact.productPayloadVersion !== layout.artifact.productPayloadVersion ||
      report.artifact.productPayloadFileCount !== layout.artifact.productPayloadFileCount ||
      report.artifact.productPayloadSha256 !== layout.artifact.productPayloadSha256 ||
      report.artifact.exactCandidateBound !== true) {
    throw new Error('I4 audio child is not bound to the non-audio child and exact B5 candidate')
  }

  exactKeys(report.ordering, [
    'harnessVerifiedNoExactCandidateProcessBeforeLaunch',
    'harnessVerifiedSerializedExactLaunches', 'ordinal',
    'operatorAttestedOtherSourceInactive', 'priorLoopbackChildReportSha256'
  ], 'ordering')
  requireTrueFields(report.ordering, [
    'harnessVerifiedNoExactCandidateProcessBeforeLaunch',
    'harnessVerifiedSerializedExactLaunches', 'operatorAttestedOtherSourceInactive'
  ], 'ordering')
  if (report.sourceId === 'loopback') {
    if (report.ordering.ordinal !== 1 || report.ordering.priorLoopbackChildReportSha256 !== null ||
        priorLoopbackEvidence !== null) {
      throw new Error('loopback must be the first isolated I4 audio child')
    }
  } else {
    if (report.ordering.ordinal !== 2 || !priorLoopbackEvidence) {
      throw new Error('mic must follow one validated loopback child')
    }
    exactKeys(priorLoopbackEvidence, ['report', 'sha256'], 'prior loopback evidence')
    requireSha256(priorLoopbackEvidence.sha256, 'prior loopback child SHA-256')
    if (priorLoopbackEvidence.report.sourceId !== 'loopback' ||
        report.ordering.priorLoopbackChildReportSha256 !== priorLoopbackEvidence.sha256 ||
        priorLoopbackEvidence.report.artifact?.b5LayoutEvidenceSha256 !== layoutEvidence.sha256 ||
        priorLoopbackEvidence.report.artifact?.nonAudioReportSha256 !== nonAudioEvidence.sha256 ||
        priorLoopbackEvidence.report.artifact?.installerSha256 !== layout.artifact.installerSha256) {
      throw new Error('mic child is not bound to the prior loopback child')
    }
  }

  exactKeys(report.permission, [
    'operatorAttestedNoCaptionDuringDenial', 'operatorAttestedPermissionApproved',
    'operatorAttestedPermissionDenialVisible', 'operatorAttestedPermissionDenied'
  ], 'permission')
  requireTrueFields(report.permission, Object.keys(report.permission), 'permission')

  exactKeys(report.sourceEvidence, [
    'operatorAttestedNoFixtureOrVirtualReplay', 'operatorAttestedPhysicalMicrophoneSource',
    'operatorAttestedRealSourceAudio', 'operatorAttestedSystemAudioSource'
  ], 'sourceEvidence')
  requireTrueFields(report.sourceEvidence, [
    'operatorAttestedNoFixtureOrVirtualReplay', 'operatorAttestedRealSourceAudio'
  ], 'sourceEvidence')
  if (report.sourceEvidence.operatorAttestedPhysicalMicrophoneSource !== (report.sourceId === 'mic') ||
      report.sourceEvidence.operatorAttestedSystemAudioSource !== (report.sourceId === 'loopback')) {
    throw new Error('source evidence does not match the isolated audio source')
  }

  exactKeys(report.journey, [
    'harnessObservedCaptureLaunchNormalExit', 'harnessObservedOfflineRestartNormalExit',
    'harnessObservedPermissionDenialLaunchNormalExit', 'operatorAttestedCaptionAfterResume',
    'operatorAttestedFirstPassFinalVisible', 'operatorAttestedHistorySessionVisible',
    'operatorAttestedNativeSaveDialogs', 'operatorAttestedNoCaptureDuringOfflineRestart',
    'operatorAttestedNoNewCaptionWhilePaused', 'operatorAttestedPartialVisible',
    'operatorAttestedPaused', 'operatorAttestedRefinementVisible', 'operatorAttestedResumed',
    'operatorAttestedSourceSelected', 'operatorAttestedStarted', 'operatorAttestedStopped'
  ], 'journey')
  requireTrueFields(report.journey, Object.keys(report.journey), 'journey')

  exactKeys(report.sqlite, [
    'bytesAfterStop', 'bytesBeforeCapture', 'harnessSqliteChangedAfterJourney',
    'harnessSqliteHeaderValidAfter', 'harnessSqliteHeaderValidBefore',
    'sha256AfterStop', 'sha256BeforeCapture'
  ], 'sqlite')
  requireTrueFields(report.sqlite, [
    'harnessSqliteChangedAfterJourney', 'harnessSqliteHeaderValidAfter',
    'harnessSqliteHeaderValidBefore'
  ], 'sqlite')
  requireSha256(report.sqlite.sha256BeforeCapture, 'sqlite.sha256BeforeCapture')
  requireSha256(report.sqlite.sha256AfterStop, 'sqlite.sha256AfterStop')
  if (!Number.isSafeInteger(report.sqlite.bytesBeforeCapture) || report.sqlite.bytesBeforeCapture < 16 ||
      !Number.isSafeInteger(report.sqlite.bytesAfterStop) || report.sqlite.bytesAfterStop < 16 ||
      report.sqlite.sha256BeforeCapture === report.sqlite.sha256AfterStop) {
    throw new Error('SQLite did not change across the real-source journey')
  }

  exactKeys(report.exports, [
    'afterOfflineRestart', 'beforeOfflineRestart', 'harnessVerifiedOfflineExportsMatch'
  ], 'exports')
  validateExportSet(report.exports.beforeOfflineRestart, 'exports.beforeOfflineRestart')
  validateExportSet(report.exports.afterOfflineRestart, 'exports.afterOfflineRestart')
  if (report.exports.harnessVerifiedOfflineExportsMatch !== true) {
    throw new Error('offline exports must be harness-verified')
  }
  for (const format of ['text', 'markdown', 'srt']) {
    const before = report.exports.beforeOfflineRestart[format]
    const after = report.exports.afterOfflineRestart[format]
    if (before.bytes !== after.bytes || before.recordCount !== after.recordCount || before.sha256 !== after.sha256) {
      throw new Error(`offline ${format} export differs from the stopped-session export`)
    }
  }

  exactKeys(report.privacy, [
    'harnessAudioFileCount', 'harnessPersistedAudioReferenceCount',
    'reportContainsAbsolutePath', 'reportContainsDeviceName', 'reportContainsTranscriptText'
  ], 'privacy')
  if (report.privacy.harnessAudioFileCount !== 0 || report.privacy.harnessPersistedAudioReferenceCount !== 0 ||
      report.privacy.reportContainsAbsolutePath !== false || report.privacy.reportContainsDeviceName !== false ||
      report.privacy.reportContainsTranscriptText !== false) {
    throw new Error('I4 audio child violates the SEM-F14 privacy boundary')
  }
  if (JSON.stringify(report.limitations) !== JSON.stringify(EXPECTED_LIMITATIONS)) {
    throw new Error('I4 audio child limitations are incomplete')
  }

  const serialized = JSON.stringify(report)
  if (/[A-Za-z]:[\\/]/.test(serialized) || /file:\/\//i.test(serialized) ||
      /https?:\/\//i.test(serialized) ||
      /\"(?:deviceName|deviceLabel|captionText|transcriptText|localPath|modelPath|audioPath)\"\s*:/i.test(serialized) ||
      /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)(?:$|[?#"'])/i.test(serialized)) {
    throw new Error('I4 audio child leaked a path, device, caption text or audio reference')
  }
  return report
}

function readAndValidateI4AudioChildReport ({
  reportPath,
  expectedSource,
  nonAudioReportPath,
  layoutPath = TRACKED_LAYOUT_PATH,
  priorLoopbackReportPath = null
}) {
  if (!SOURCES.includes(expectedSource)) throw new Error('expectedSource must be loopback or mic')
  const layoutEvidence = readTrackedLayoutEvidence(layoutPath)
  const nonAudioEvidence = readNonAudioEvidence(nonAudioReportPath, layoutPath)
  const audioEvidence = readAudioEvidence(reportPath)
  let priorLoopbackEvidence = null
  if (priorLoopbackReportPath !== null) {
    const priorRaw = readAudioEvidence(priorLoopbackReportPath)
    priorLoopbackEvidence = Object.freeze({
      report: validateI4AudioChildReport(priorRaw.report, {
        layoutEvidence,
        nonAudioEvidence,
        priorLoopbackEvidence: null
      }),
      sha256: priorRaw.sha256
    })
  }
  const report = validateI4AudioChildReport(audioEvidence.report, {
    layoutEvidence,
    nonAudioEvidence,
    priorLoopbackEvidence
  })
  if (report.sourceId !== expectedSource) throw new Error('I4 audio child source differs from expectedSource')
  return Object.freeze({ report, sha256: audioEvidence.sha256 })
}

if (require.main === module) {
  const [reportPath, expectedSource, nonAudioReportPath, layoutPath, priorLoopbackReportPath] = process.argv.slice(2)
  if (!reportPath || !expectedSource || !nonAudioReportPath || !layoutPath ||
      (expectedSource === 'mic' && !priorLoopbackReportPath) || process.argv.length > 7) {
    throw new Error('usage: node scripts/verify-i4-audio-child-report.js <report.json> <loopback|mic> <non-audio.json> <b5-layout.json> [prior-loopback.json]')
  }
  const evidence = readAndValidateI4AudioChildReport({
    reportPath,
    expectedSource,
    nonAudioReportPath,
    layoutPath,
    priorLoopbackReportPath: priorLoopbackReportPath || null
  })
  process.stdout.write(JSON.stringify({
    result: evidence.report.result,
    gateStatus: evidence.report.gateStatus,
    sourceId: evidence.report.sourceId,
    reportSha256: evidence.sha256
  }) + '\n')
}

module.exports = {
  EXPECTED_LIMITATIONS,
  FORMATS,
  SOURCES,
  readAndValidateI4AudioChildReport,
  readAudioEvidence,
  readNonAudioEvidence,
  sha256Bytes,
  validateI4AudioChildReport
}
