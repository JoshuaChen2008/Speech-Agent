'use strict'

// @ts-check

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const packageJson = require('../package.json')
const { PRODUCTION_MODEL_MANIFEST } = require('../src/main/services/model-manifest')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')
const { validatePackageLayoutReport } = require('./verify-package-layout')

const ROOT = path.resolve(__dirname, '..')
const TRACKED_LAYOUT_PATH = path.join(ROOT, 'docs', 'validation', 'b5-packaged-layout-results.json')
const TRACKED_FIXTURE_PATH = path.join(ROOT, 'scripts', 'fixtures', 'i4-nonaudio-legacy-session.jsonl')
const EXPECTED_ALLOWED_HOSTS = Object.freeze([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
])
const EXPECTED_LIMITATIONS = Object.freeze([
  'no-physical-audio',
  'no-media-permission-acceptance',
  'no-real-asr-inference',
  'no-active-session-preference-freeze',
  'no-per-process-network-attempt-audit',
  'operator-driven-windows-ui',
  'unsigned-installer',
  'i4-full-status-partial'
])
const CORE_ARTIFACTS = Object.freeze(PRODUCTION_MODEL_MANIFEST.artifacts
  .filter((artifact) => artifact.resourceGroup === 'core'))
const REFINEMENT_ARTIFACTS = Object.freeze(PRODUCTION_MODEL_MANIFEST.artifacts
  .filter((artifact) => artifact.resourceGroup === 'refinement'))

function totalBytes (artifacts) {
  return artifacts.reduce((total, artifact) => total + artifact.bytes, 0)
}

function totalFileCount (artifacts) {
  return artifacts.reduce((total, artifact) => total + artifact.requiredFiles.length, 0)
}

const EXPECTED_CORE_MODEL_BYTES = totalBytes(CORE_ARTIFACTS)
const EXPECTED_REFINEMENT_MODEL_BYTES = totalBytes(REFINEMENT_ARTIFACTS)
const EXPECTED_MODEL_BYTES = totalBytes(PRODUCTION_MODEL_MANIFEST.artifacts)
const EXPECTED_CORE_MODEL_FILE_COUNT = totalFileCount(CORE_ARTIFACTS)
const EXPECTED_REFINEMENT_MODEL_FILE_COUNT = totalFileCount(REFINEMENT_ARTIFACTS)
const EXPECTED_MODEL_FILE_COUNT = totalFileCount(PRODUCTION_MODEL_MANIFEST.artifacts)
const EXPECTED_PRESERVATION_ENTRY_COUNT = 3 +
  PRODUCTION_MODEL_MANIFEST.artifacts.length + EXPECTED_MODEL_FILE_COUNT

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
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`)
  }
  return value
}

function requireCanonicalUtc (value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) ||
      new Date(Date.parse(value)).toISOString() !== value) {
    throw new TypeError('generatedAt must be a canonical UTC ISO-8601 millisecond timestamp')
  }
}

function requireTrueFields (value, fields, label) {
  for (const field of fields) {
    if (value[field] !== true) throw new Error(`${label}.${field} must be true`)
  }
}

function requireFalseFields (value, fields, label) {
  for (const field of fields) {
    if (value[field] !== false) throw new Error(`${label}.${field} must be false`)
  }
}

function expectedMarkerDigest (artifact) {
  const marker = {
    manifestVersion: PRODUCTION_MODEL_MANIFEST.version,
    artifactId: artifact.id,
    sha256: artifact.sha256,
    bytes: artifact.bytes
  }
  return sha256Bytes(Buffer.from(`${JSON.stringify(marker)}\n`, 'utf8'))
}

function validateReadyMarkers (markers, artifacts = PRODUCTION_MODEL_MANIFEST.artifacts, label = 'dataLifecycle.readyMarkers') {
  if (!Array.isArray(markers) || markers.length !== artifacts.length) {
    throw new Error(`${label} has the wrong ready-marker count`)
  }
  for (let index = 0; index < markers.length; index += 1) {
    const marker = exactKeys(markers[index], [
      'artifactId', 'bytes', 'markerSha256', 'sourceSha256'
    ], `${label}[${index}]`)
    const artifact = artifacts[index]
    if (marker.artifactId !== artifact.id || marker.bytes !== artifact.bytes ||
        marker.sourceSha256 !== artifact.sha256 ||
        marker.markerSha256 !== expectedMarkerDigest(artifact)) {
      throw new Error(`${label}[${index}] is not the expected production marker`)
    }
  }
}

function validateExportEvidence (value, label) {
  exactKeys(value, ['bytes', 'recordCount', 'sha256'], label)
  if (!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.recordCount !== 1) {
    throw new Error(`${label} must be a non-empty one-segment export`)
  }
  requireSha256(value.sha256, `${label}.sha256`)
}

function validateExportSet (value, label) {
  exactKeys(value, ['markdown', 'srt', 'text'], label)
  validateExportEvidence(value.text, `${label}.text`)
  validateExportEvidence(value.markdown, `${label}.markdown`)
  validateExportEvidence(value.srt, `${label}.srt`)
  if (new Set(Object.values(value).map((entry) => entry.sha256)).size !== 3) {
    throw new Error(`${label} must contain three distinct artifacts`)
  }
}

function readTrackedLayoutEvidence (layoutPath = TRACKED_LAYOUT_PATH) {
  const resolved = path.resolve(layoutPath)
  const bytes = fs.readFileSync(resolved)
  return Object.freeze({
    layout: validatePackageLayoutReport(parseStrictEvidenceJson(
      bytes,
      `tracked B5 layout ${path.basename(resolved)}`
    ), 'release'),
    sha256: sha256Bytes(bytes)
  })
}

function validateI4NonAudioNsisReport (report, layoutEvidence = readTrackedLayoutEvidence()) {
  exactKeys(layoutEvidence, ['layout', 'sha256'], 'B5 layout evidence')
  const layout = layoutEvidence.layout
  requireSha256(layoutEvidence.sha256, 'B5 layout evidence SHA-256')

  exactKeys(report, [
    'artifact', 'dataLifecycle', 'environment', 'firstLaunch', 'gateStatus', 'generatedAt',
    'kind', 'limitations', 'offlineRestart', 'privacy', 'refinementSetup', 'result', 'schemaVersion'
  ], 'I4 non-audio report')
  if (report.schemaVersion !== 3 || report.kind !== 'i4-nonaudio-nsis-qualification') {
    throw new Error('invalid I4 non-audio report envelope')
  }
  if (report.result !== 'pass' || report.gateStatus !== 'partial') {
    throw new Error('I4 non-audio qualification must be pass/partial and cannot close full I4')
  }
  requireCanonicalUtc(report.generatedAt)

  exactKeys(report.environment, [
    'harnessVerifiedInteractiveDesktop', 'harnessVerifiedNodeCommandAbsent',
    'harnessVerifiedNonElevated', 'harnessVerifiedPriorKnownApplicationDataAbsent',
    'harnessVerifiedPriorKnownProductModelsAbsent', 'harnessVerifiedRepositoryAncestorsAbsent',
    'operatorAttestedCleanUserProfile', 'operatorAttestedCleanWindowsSnapshot',
    'operatorAttestedDedicatedStandardUser', 'osBuild', 'osFamily'
  ], 'environment')
  if (report.environment.osFamily !== 'windows' ||
      !Number.isSafeInteger(report.environment.osBuild) || report.environment.osBuild < 22000) {
    throw new Error('I4 non-audio qualification requires Windows 11')
  }
  requireTrueFields(report.environment, [
    'harnessVerifiedInteractiveDesktop', 'harnessVerifiedNodeCommandAbsent',
    'harnessVerifiedNonElevated', 'harnessVerifiedPriorKnownApplicationDataAbsent',
    'harnessVerifiedPriorKnownProductModelsAbsent', 'harnessVerifiedRepositoryAncestorsAbsent',
    'operatorAttestedCleanUserProfile', 'operatorAttestedCleanWindowsSnapshot',
    'operatorAttestedDedicatedStandardUser'
  ], 'environment')

  exactKeys(report.artifact, [
    'arch', 'b5LayoutEvidenceSha256', 'exactCandidateBound', 'installedAsarSha256',
    'installedExecutableSha256', 'installedViaNsis', 'installerSha256', 'installerTarget',
    'productPayloadFileCount', 'productPayloadIdentitySource', 'productPayloadSha256',
    'productPayloadVersion', 'reinstalledAsarSha256', 'reinstalledExecutableSha256',
    'releaseMain', 'signingStatus'
  ], 'artifact')
  for (const key of [
    'b5LayoutEvidenceSha256', 'installerSha256', 'installedExecutableSha256',
    'installedAsarSha256', 'reinstalledExecutableSha256', 'reinstalledAsarSha256',
    'productPayloadSha256'
  ]) requireSha256(report.artifact[key], `artifact.${key}`)
  if (report.artifact.b5LayoutEvidenceSha256 !== layoutEvidence.sha256 ||
      report.artifact.installerSha256 !== layout.artifact.installerSha256 ||
      report.artifact.installedExecutableSha256 !== layout.artifact.appExecutableSha256 ||
      report.artifact.installedAsarSha256 !== layout.artifact.appAsarSha256 ||
      report.artifact.reinstalledExecutableSha256 !== layout.artifact.appExecutableSha256 ||
      report.artifact.reinstalledAsarSha256 !== layout.artifact.appAsarSha256 ||
      report.artifact.installerTarget !== 'nsis' || report.artifact.arch !== 'x64' ||
      report.artifact.installedViaNsis !== true || report.artifact.releaseMain !== layout.artifact.mainEntry ||
      report.artifact.signingStatus !== layout.artifact.signingStatus ||
      report.artifact.exactCandidateBound !== true ||
      report.artifact.productPayloadIdentitySource !== 'tracked-b5-layout-installed-asar-binding' ||
      report.artifact.productPayloadVersion !== layout.artifact.productPayloadVersion ||
      report.artifact.productPayloadFileCount !== layout.artifact.productPayloadFileCount ||
      report.artifact.productPayloadSha256 !== layout.artifact.productPayloadSha256) {
    throw new Error('I4 non-audio report is not bound to the installed files of the tracked exact B5 candidate')
  }

  exactKeys(report.firstLaunch, [
    'coreDownloadedBytesFromReadyMarkers', 'coreModelArtifactCount', 'coreModelFileCount',
    'coreReadyMarkerCount', 'downloadHostReachabilityVerified',
    'harnessLaunchedBoundReleaseExecutable', 'harnessObservedNormalExit',
    'harnessVerifiedCoreModelFilesPresent', 'harnessVerifiedCoreReadyMarkers',
    'harnessVerifiedRefinementModelFilesAbsent', 'harnessVerifiedRefinementPreferenceDisabled',
    'harnessVerifiedRefinementReadyMarkersAbsent', 'harnessVerifiedStagingClean',
    'manifestAllowedDownloadHosts', 'modelTransportEvidence', 'operatorAttestedInteractiveInstall',
    'operatorAttestedMissingRefinementPreferenceAttempted',
    'operatorAttestedMissingRefinementPreferenceStayedDisabled',
    'operatorAttestedNoCaptureCommand', 'operatorAttestedNoMediaPermissionPrompt',
    'operatorAttestedPublicHttpsCoreDownloadFromSettings',
    'operatorAttestedRuntimeCoreReadyBeforeCapture', 'refinementModelFileCount',
    'refinementNetworkAttemptCountAssessed', 'refinementPreferenceInitiallyDisabled',
    'refinementReadyMarkerCount'
  ], 'firstLaunch')
  requireTrueFields(report.firstLaunch, [
    'downloadHostReachabilityVerified', 'harnessLaunchedBoundReleaseExecutable',
    'harnessObservedNormalExit', 'harnessVerifiedCoreModelFilesPresent',
    'harnessVerifiedCoreReadyMarkers', 'harnessVerifiedRefinementModelFilesAbsent',
    'harnessVerifiedRefinementPreferenceDisabled', 'harnessVerifiedRefinementReadyMarkersAbsent',
    'harnessVerifiedStagingClean',
    'operatorAttestedInteractiveInstall', 'operatorAttestedNoCaptureCommand',
    'operatorAttestedNoMediaPermissionPrompt', 'operatorAttestedPublicHttpsCoreDownloadFromSettings',
    'operatorAttestedRuntimeCoreReadyBeforeCapture',
    'operatorAttestedMissingRefinementPreferenceAttempted',
    'operatorAttestedMissingRefinementPreferenceStayedDisabled',
    'refinementPreferenceInitiallyDisabled'
  ], 'firstLaunch')
  requireFalseFields(report.firstLaunch, ['refinementNetworkAttemptCountAssessed'], 'firstLaunch')
  if (report.firstLaunch.modelTransportEvidence !== 'operator-attested-settings-public-https' ||
      report.firstLaunch.coreDownloadedBytesFromReadyMarkers !== EXPECTED_CORE_MODEL_BYTES ||
      report.firstLaunch.coreReadyMarkerCount !== CORE_ARTIFACTS.length ||
      report.firstLaunch.coreModelArtifactCount !== CORE_ARTIFACTS.length ||
      report.firstLaunch.coreModelFileCount !== EXPECTED_CORE_MODEL_FILE_COUNT ||
      report.firstLaunch.refinementReadyMarkerCount !== 0 ||
      report.firstLaunch.refinementModelFileCount !== 0 ||
      JSON.stringify(report.firstLaunch.manifestAllowedDownloadHosts) !== JSON.stringify(EXPECTED_ALLOWED_HOSTS)) {
    throw new Error('first launch core-resource evidence is incomplete or overclaimed')
  }

  exactKeys(report.refinementSetup, [
    'downloadHostReachabilityVerified', 'harnessLaunchedBoundReleaseExecutable',
    'harnessObservedPreferenceEnableNormalExit', 'harnessObservedRefinementDownloadNormalExit',
    'harnessVerifiedCoreReadyMarkers', 'harnessVerifiedRefinementModelFilesPresent',
    'harnessVerifiedRefinementPreferenceDisabledAfterDownload',
    'harnessVerifiedRefinementPreferenceEnabled', 'harnessVerifiedRefinementReadyMarkers',
    'harnessVerifiedStagingClean', 'manifestAllowedDownloadHosts', 'modelTransportEvidence',
    'operatorAttestedNoCaptureCommand', 'operatorAttestedNoMediaPermissionPrompt',
    'operatorAttestedPublicHttpsRefinementDownloadFromSettings',
    'operatorAttestedRefinementPreferenceExplicitlyEnabled',
    'operatorAttestedRefinementPreferenceStayedDisabledAfterDownload',
    'refinementDownloadedBytesFromReadyMarkers', 'refinementModelArtifactCount',
    'refinementModelFileCount', 'refinementReadyMarkerCount'
  ], 'refinementSetup')
  requireTrueFields(report.refinementSetup, [
    'downloadHostReachabilityVerified', 'harnessLaunchedBoundReleaseExecutable',
    'harnessObservedPreferenceEnableNormalExit', 'harnessObservedRefinementDownloadNormalExit',
    'harnessVerifiedCoreReadyMarkers', 'harnessVerifiedRefinementModelFilesPresent',
    'harnessVerifiedRefinementPreferenceDisabledAfterDownload',
    'harnessVerifiedRefinementPreferenceEnabled', 'harnessVerifiedRefinementReadyMarkers',
    'harnessVerifiedStagingClean', 'operatorAttestedNoCaptureCommand',
    'operatorAttestedNoMediaPermissionPrompt',
    'operatorAttestedPublicHttpsRefinementDownloadFromSettings',
    'operatorAttestedRefinementPreferenceExplicitlyEnabled',
    'operatorAttestedRefinementPreferenceStayedDisabledAfterDownload'
  ], 'refinementSetup')
  if (report.refinementSetup.modelTransportEvidence !== 'operator-attested-settings-public-https' ||
      report.refinementSetup.refinementDownloadedBytesFromReadyMarkers !== EXPECTED_REFINEMENT_MODEL_BYTES ||
      report.refinementSetup.refinementReadyMarkerCount !== REFINEMENT_ARTIFACTS.length ||
      report.refinementSetup.refinementModelArtifactCount !== REFINEMENT_ARTIFACTS.length ||
      report.refinementSetup.refinementModelFileCount !== EXPECTED_REFINEMENT_MODEL_FILE_COUNT ||
      JSON.stringify(report.refinementSetup.manifestAllowedDownloadHosts) !== JSON.stringify(EXPECTED_ALLOWED_HOSTS)) {
    throw new Error('explicit refinement-resource evidence is incomplete or overclaimed')
  }

  exactKeys(report.offlineRestart, [
    'coreReadyMarkerCount', 'downloadHostsUnreachableAtRestart', 'exportArtifactCount', 'exportFormats',
    'exportedSegmentCount', 'harnessLaunchedBoundReleaseExecutable', 'harnessObservedNormalExit',
    'harnessVerifiedExports', 'harnessVerifiedRefinementPreferencePersisted',
    'networkAttemptCountAssessed', 'offlineControl',
    'operatorAttestedLegacySessionCount', 'operatorAttestedCoreReady',
    'operatorAttestedRefinementPreferenceEnabledAfterRestart', 'operatorAttestedRefinementReady',
    'operatorAttestedNativeSaveDialogs', 'operatorAttestedNoCaptureCommand',
    'operatorAttestedNoMediaPermissionPrompt', 'refinementReadyMarkerCount'
  ], 'offlineRestart')
  requireTrueFields(report.offlineRestart, [
    'downloadHostsUnreachableAtRestart', 'harnessLaunchedBoundReleaseExecutable',
    'harnessObservedNormalExit', 'harnessVerifiedExports',
    'harnessVerifiedRefinementPreferencePersisted', 'operatorAttestedCoreReady',
    'operatorAttestedRefinementPreferenceEnabledAfterRestart', 'operatorAttestedRefinementReady',
    'operatorAttestedNativeSaveDialogs', 'operatorAttestedNoCaptureCommand',
    'operatorAttestedNoMediaPermissionPrompt'
  ], 'offlineRestart')
  requireFalseFields(report.offlineRestart, ['networkAttemptCountAssessed'], 'offlineRestart')
  if (!['vm-host-vnic-disconnect', 'preconfigured-outbound-block'].includes(report.offlineRestart.offlineControl) ||
      report.offlineRestart.coreReadyMarkerCount !== CORE_ARTIFACTS.length ||
      report.offlineRestart.refinementReadyMarkerCount !== REFINEMENT_ARTIFACTS.length ||
      report.offlineRestart.operatorAttestedLegacySessionCount !== 1 ||
      report.offlineRestart.exportArtifactCount !== 3 || report.offlineRestart.exportedSegmentCount !== 1 ||
      JSON.stringify(report.offlineRestart.exportFormats) !== JSON.stringify(['txt', 'md', 'srt'])) {
    throw new Error('offline restart history/export evidence is incomplete')
  }

  exactKeys(report.dataLifecycle, [
    'applicationDataWritten', 'configPresent', 'downloadHostsUnreachableAtReinstall', 'exports',
    'coreReadyMarkerCount',
    'harnessObservedReinstallNormalExit', 'harnessVerifiedReinstallExportsMatch',
    'harnessVerifiedRefinementPreferencePreservedAfterReinstall',
    'harnessVerifiedSelectedDataPresentAfterReinstall', 'installDirectoryRemoved',
    'legacyFixtureSha256', 'legacySourceUnchanged', 'modelFileCount',
    'operatorAttestedInteractiveReinstall', 'operatorAttestedInteractiveUninstall',
    'operatorAttestedLegacySessionCountAfterReinstall', 'operatorAttestedCoreReadyAfterReinstall',
    'operatorAttestedRefinementPreferenceEnabledAfterReinstall',
    'operatorAttestedRefinementReadyAfterReinstall',
    'preservationManifestEntryCount', 'preservationManifestSha256AfterReinstall',
    'preservationManifestSha256AfterUninstall', 'preservationManifestSha256BeforeUninstall',
    'preservationManifestUnchangedThroughReinstall', 'preservationScope', 'readyMarkers',
    'reinstallExitCode', 'reinstallExports', 'selectedApplicationDataPreservedAfterUninstall',
    'refinementReadyMarkerCount', 'sqliteHeaderValid', 'uninstallExitCode',
    'userDataDirectoryName', 'userDataDiscovery'
  ], 'dataLifecycle')
  requireTrueFields(report.dataLifecycle, [
    'applicationDataWritten', 'configPresent', 'downloadHostsUnreachableAtReinstall',
    'harnessObservedReinstallNormalExit', 'harnessVerifiedReinstallExportsMatch',
    'harnessVerifiedSelectedDataPresentAfterReinstall', 'installDirectoryRemoved',
    'legacySourceUnchanged', 'operatorAttestedInteractiveReinstall',
    'operatorAttestedInteractiveUninstall', 'operatorAttestedCoreReadyAfterReinstall',
    'operatorAttestedRefinementPreferenceEnabledAfterReinstall',
    'operatorAttestedRefinementReadyAfterReinstall',
    'preservationManifestUnchangedThroughReinstall',
    'selectedApplicationDataPreservedAfterUninstall', 'sqliteHeaderValid',
    'harnessVerifiedRefinementPreferencePreservedAfterReinstall'
  ], 'dataLifecycle')
  if (report.dataLifecycle.userDataDirectoryName !== packageJson.name ||
      report.dataLifecycle.userDataDiscovery !== 'new-roaming-directory-with-product-data' ||
      report.dataLifecycle.preservationScope !== 'config-sqlite-legacy-ready-markers-and-model-files' ||
      report.dataLifecycle.modelFileCount !== EXPECTED_MODEL_FILE_COUNT ||
      report.dataLifecycle.coreReadyMarkerCount !== CORE_ARTIFACTS.length ||
      report.dataLifecycle.refinementReadyMarkerCount !== REFINEMENT_ARTIFACTS.length ||
      report.dataLifecycle.preservationManifestEntryCount !== EXPECTED_PRESERVATION_ENTRY_COUNT ||
      report.dataLifecycle.operatorAttestedLegacySessionCountAfterReinstall !== 1 ||
      report.dataLifecycle.uninstallExitCode !== 0 || report.dataLifecycle.reinstallExitCode !== 0) {
    throw new Error('selected application userData lifecycle evidence is incomplete')
  }
  const fixtureSha256 = sha256Bytes(fs.readFileSync(TRACKED_FIXTURE_PATH))
  if (report.dataLifecycle.legacyFixtureSha256 !== fixtureSha256) {
    throw new Error('I4 non-audio report used a different legacy fixture')
  }
  const manifestBefore = requireSha256(
    report.dataLifecycle.preservationManifestSha256BeforeUninstall,
    'dataLifecycle.preservationManifestSha256BeforeUninstall'
  )
  const manifestAfterUninstall = requireSha256(
    report.dataLifecycle.preservationManifestSha256AfterUninstall,
    'dataLifecycle.preservationManifestSha256AfterUninstall'
  )
  const manifestAfterReinstall = requireSha256(
    report.dataLifecycle.preservationManifestSha256AfterReinstall,
    'dataLifecycle.preservationManifestSha256AfterReinstall'
  )
  if (manifestBefore !== manifestAfterUninstall || manifestBefore !== manifestAfterReinstall) {
    throw new Error('selected application userData changed during uninstall or offline reinstall')
  }
  validateReadyMarkers(report.dataLifecycle.readyMarkers)
  validateExportSet(report.dataLifecycle.exports, 'dataLifecycle.exports')
  validateExportSet(report.dataLifecycle.reinstallExports, 'dataLifecycle.reinstallExports')
  for (const format of ['text', 'markdown', 'srt']) {
    if (report.dataLifecycle.exports[format].sha256 !== report.dataLifecycle.reinstallExports[format].sha256 ||
        report.dataLifecycle.exports[format].bytes !== report.dataLifecycle.reinstallExports[format].bytes) {
      throw new Error(`reinstall ${format} export differs from the pre-uninstall export`)
    }
  }

  exactKeys(report.privacy, [
    'harnessAudioFileCount', 'harnessPersistedAudioReferenceCount',
    'operatorAttestedNoCaptureCommand', 'operatorAttestedNoPhysicalAudioSource',
    'operatorAttestedNoSpeakerPlayback', 'reportContainsAbsolutePath',
    'reportContainsSensitiveNetworkData', 'reportContainsTranscriptText'
  ], 'privacy')
  requireTrueFields(report.privacy, [
    'operatorAttestedNoCaptureCommand', 'operatorAttestedNoPhysicalAudioSource',
    'operatorAttestedNoSpeakerPlayback'
  ], 'privacy')
  requireFalseFields(report.privacy, [
    'reportContainsAbsolutePath', 'reportContainsSensitiveNetworkData', 'reportContainsTranscriptText'
  ], 'privacy')
  if (report.privacy.harnessAudioFileCount !== 0 ||
      report.privacy.harnessPersistedAudioReferenceCount !== 0) {
    throw new Error('I4 non-audio application data contains an audio artifact or reference')
  }

  if (JSON.stringify(report.limitations) !== JSON.stringify(EXPECTED_LIMITATIONS)) {
    throw new Error('I4 non-audio report must preserve the exact full-I4 limitations')
  }
  const serialized = JSON.stringify(report)
  if (/[A-Za-z]:[\\/]/.test(serialized) || /file:\/\//i.test(serialized) ||
      /I4 non-audio migration fixture/i.test(serialized) ||
      /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)(?:$|[?#"'])/i.test(serialized) ||
      /https?:\/\//i.test(serialized) || /(?:authorization|cookie|bearer|password)/i.test(serialized)) {
    throw new Error('I4 non-audio report leaked a path, transcript, audio reference or sensitive network data')
  }
  return report
}

function readAndValidateI4NonAudioNsisReport (reportPath, layoutPath = TRACKED_LAYOUT_PATH) {
  const resolved = path.resolve(reportPath)
  return validateI4NonAudioNsisReport(parseStrictEvidenceJson(
    fs.readFileSync(resolved),
    `I4 non-audio report ${path.basename(resolved)}`
  ), readTrackedLayoutEvidence(layoutPath))
}

if (require.main === module) {
  if (process.argv.length < 3 || process.argv.length > 4) {
    throw new Error('usage: node scripts/verify-i4-nonaudio-nsis-report.js <report.json> [b5-layout.json]')
  }
  const report = readAndValidateI4NonAudioNsisReport(process.argv[2], process.argv[3])
  process.stdout.write(JSON.stringify({
    result: report.result,
    gateStatus: report.gateStatus,
    installerSha256: report.artifact.installerSha256,
    coreReadyMarkerCount: report.firstLaunch.coreReadyMarkerCount,
    refinementReadyMarkerCount: report.refinementSetup.refinementReadyMarkerCount,
    preservedEntryCount: report.dataLifecycle.preservationManifestEntryCount
  }) + '\n')
}

module.exports = {
  EXPECTED_ALLOWED_HOSTS,
  CORE_ARTIFACTS,
  REFINEMENT_ARTIFACTS,
  EXPECTED_LIMITATIONS,
  EXPECTED_CORE_MODEL_BYTES,
  EXPECTED_REFINEMENT_MODEL_BYTES,
  EXPECTED_MODEL_BYTES,
  EXPECTED_CORE_MODEL_FILE_COUNT,
  EXPECTED_REFINEMENT_MODEL_FILE_COUNT,
  EXPECTED_MODEL_FILE_COUNT,
  EXPECTED_PRESERVATION_ENTRY_COUNT,
  TRACKED_FIXTURE_PATH,
  TRACKED_LAYOUT_PATH,
  expectedMarkerDigest,
  readAndValidateI4NonAudioNsisReport,
  readTrackedLayoutEvidence,
  validateI4NonAudioNsisReport
}
