'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { PRODUCTION_MODEL_MANIFEST } = require('../../src/main/services/model-manifest')
const {
  CORE_ARTIFACTS,
  REFINEMENT_ARTIFACTS,
  EXPECTED_ALLOWED_HOSTS,
  EXPECTED_LIMITATIONS,
  EXPECTED_CORE_MODEL_BYTES,
  EXPECTED_CORE_MODEL_FILE_COUNT,
  EXPECTED_MODEL_FILE_COUNT,
  EXPECTED_PRESERVATION_ENTRY_COUNT,
  EXPECTED_REFINEMENT_MODEL_BYTES,
  EXPECTED_REFINEMENT_MODEL_FILE_COUNT,
  TRACKED_FIXTURE_PATH,
  expectedMarkerDigest,
  readAndValidateI4NonAudioNsisReport,
  readTrackedLayoutEvidence,
  validateI4NonAudioNsisReport
} = require('../../scripts/verify-i4-nonaudio-nsis-report')

const ROOT = path.resolve(__dirname, '../..')

function sha256File (filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function exportSet () {
  return {
    text: { bytes: 31, recordCount: 1, sha256: '4'.repeat(64) },
    markdown: { bytes: 64, recordCount: 1, sha256: '5'.repeat(64) },
    srt: { bytes: 76, recordCount: 1, sha256: '6'.repeat(64) }
  }
}

function validReport (layoutEvidence = readTrackedLayoutEvidence()) {
  const layout = layoutEvidence.layout
  return {
    schemaVersion: 3,
    kind: 'i4-nonaudio-nsis-qualification',
    generatedAt: '2026-08-01T00:00:00.000Z',
    result: 'pass',
    gateStatus: 'partial',
    environment: {
      osFamily: 'windows',
      osBuild: 22631,
      operatorAttestedDedicatedStandardUser: true,
      operatorAttestedCleanWindowsSnapshot: true,
      operatorAttestedCleanUserProfile: true,
      harnessVerifiedRepositoryAncestorsAbsent: true,
      harnessVerifiedNodeCommandAbsent: true,
      harnessVerifiedPriorKnownApplicationDataAbsent: true,
      harnessVerifiedPriorKnownProductModelsAbsent: true,
      harnessVerifiedInteractiveDesktop: true,
      harnessVerifiedNonElevated: true
    },
    artifact: {
      b5LayoutEvidenceSha256: layoutEvidence.sha256,
      installerTarget: 'nsis',
      arch: 'x64',
      installerSha256: layout.artifact.installerSha256,
      installedExecutableSha256: layout.artifact.appExecutableSha256,
      installedAsarSha256: layout.artifact.appAsarSha256,
      reinstalledExecutableSha256: layout.artifact.appExecutableSha256,
      reinstalledAsarSha256: layout.artifact.appAsarSha256,
      productPayloadVersion: layout.artifact.productPayloadVersion,
      productPayloadFileCount: layout.artifact.productPayloadFileCount,
      productPayloadSha256: layout.artifact.productPayloadSha256,
      productPayloadIdentitySource: 'tracked-b5-layout-installed-asar-binding',
      installedViaNsis: true,
      releaseMain: layout.artifact.mainEntry,
      signingStatus: layout.artifact.signingStatus,
      exactCandidateBound: true
    },
    firstLaunch: {
      harnessLaunchedBoundReleaseExecutable: true,
      operatorAttestedInteractiveInstall: true,
      harnessVerifiedCoreReadyMarkers: true,
      harnessVerifiedCoreModelFilesPresent: true,
      harnessVerifiedRefinementReadyMarkersAbsent: true,
      harnessVerifiedRefinementModelFilesAbsent: true,
      refinementPreferenceInitiallyDisabled: true,
      operatorAttestedMissingRefinementPreferenceAttempted: true,
      operatorAttestedMissingRefinementPreferenceStayedDisabled: true,
      harnessVerifiedRefinementPreferenceDisabled: true,
      operatorAttestedPublicHttpsCoreDownloadFromSettings: true,
      downloadHostReachabilityVerified: true,
      modelTransportEvidence: 'operator-attested-settings-public-https',
      manifestAllowedDownloadHosts: [...EXPECTED_ALLOWED_HOSTS],
      coreDownloadedBytesFromReadyMarkers: EXPECTED_CORE_MODEL_BYTES,
      coreReadyMarkerCount: CORE_ARTIFACTS.length,
      coreModelArtifactCount: CORE_ARTIFACTS.length,
      coreModelFileCount: EXPECTED_CORE_MODEL_FILE_COUNT,
      refinementReadyMarkerCount: 0,
      refinementModelFileCount: 0,
      refinementNetworkAttemptCountAssessed: false,
      harnessVerifiedStagingClean: true,
      operatorAttestedRuntimeCoreReadyBeforeCapture: true,
      operatorAttestedNoCaptureCommand: true,
      operatorAttestedNoMediaPermissionPrompt: true,
      harnessObservedNormalExit: true
    },
    refinementSetup: {
      harnessLaunchedBoundReleaseExecutable: true,
      harnessObservedRefinementDownloadNormalExit: true,
      harnessObservedPreferenceEnableNormalExit: true,
      operatorAttestedPublicHttpsRefinementDownloadFromSettings: true,
      downloadHostReachabilityVerified: true,
      modelTransportEvidence: 'operator-attested-settings-public-https',
      manifestAllowedDownloadHosts: [...EXPECTED_ALLOWED_HOSTS],
      harnessVerifiedCoreReadyMarkers: true,
      harnessVerifiedRefinementReadyMarkers: true,
      harnessVerifiedRefinementModelFilesPresent: true,
      harnessVerifiedStagingClean: true,
      refinementDownloadedBytesFromReadyMarkers: EXPECTED_REFINEMENT_MODEL_BYTES,
      refinementReadyMarkerCount: REFINEMENT_ARTIFACTS.length,
      refinementModelArtifactCount: REFINEMENT_ARTIFACTS.length,
      refinementModelFileCount: EXPECTED_REFINEMENT_MODEL_FILE_COUNT,
      operatorAttestedRefinementPreferenceStayedDisabledAfterDownload: true,
      harnessVerifiedRefinementPreferenceDisabledAfterDownload: true,
      operatorAttestedRefinementPreferenceExplicitlyEnabled: true,
      harnessVerifiedRefinementPreferenceEnabled: true,
      operatorAttestedNoCaptureCommand: true,
      operatorAttestedNoMediaPermissionPrompt: true
    },
    offlineRestart: {
      downloadHostsUnreachableAtRestart: true,
      offlineControl: 'vm-host-vnic-disconnect',
      networkAttemptCountAssessed: false,
      harnessLaunchedBoundReleaseExecutable: true,
      operatorAttestedCoreReady: true,
      operatorAttestedRefinementReady: true,
      operatorAttestedRefinementPreferenceEnabledAfterRestart: true,
      harnessVerifiedRefinementPreferencePersisted: true,
      coreReadyMarkerCount: CORE_ARTIFACTS.length,
      refinementReadyMarkerCount: REFINEMENT_ARTIFACTS.length,
      operatorAttestedLegacySessionCount: 1,
      operatorAttestedNativeSaveDialogs: true,
      exportFormats: ['txt', 'md', 'srt'],
      exportArtifactCount: 3,
      exportedSegmentCount: 1,
      harnessVerifiedExports: true,
      operatorAttestedNoCaptureCommand: true,
      operatorAttestedNoMediaPermissionPrompt: true,
      harnessObservedNormalExit: true
    },
    dataLifecycle: {
      userDataDirectoryName: 'live-subtitle-agent',
      userDataDiscovery: 'new-roaming-directory-with-product-data',
      configPresent: true,
      sqliteHeaderValid: true,
      legacyFixtureSha256: sha256File(TRACKED_FIXTURE_PATH),
      legacySourceUnchanged: true,
      readyMarkers: PRODUCTION_MODEL_MANIFEST.artifacts.map((artifact) => ({
        artifactId: artifact.id,
        bytes: artifact.bytes,
        sourceSha256: artifact.sha256,
        markerSha256: expectedMarkerDigest(artifact)
      })),
      coreReadyMarkerCount: CORE_ARTIFACTS.length,
      refinementReadyMarkerCount: REFINEMENT_ARTIFACTS.length,
      modelFileCount: EXPECTED_MODEL_FILE_COUNT,
      applicationDataWritten: true,
      preservationScope: 'config-sqlite-legacy-ready-markers-and-model-files',
      preservationManifestEntryCount: EXPECTED_PRESERVATION_ENTRY_COUNT,
      preservationManifestSha256BeforeUninstall: '3'.repeat(64),
      preservationManifestSha256AfterUninstall: '3'.repeat(64),
      selectedApplicationDataPreservedAfterUninstall: true,
      operatorAttestedInteractiveUninstall: true,
      uninstallExitCode: 0,
      installDirectoryRemoved: true,
      downloadHostsUnreachableAtReinstall: true,
      operatorAttestedInteractiveReinstall: true,
      reinstallExitCode: 0,
      operatorAttestedCoreReadyAfterReinstall: true,
      operatorAttestedRefinementReadyAfterReinstall: true,
      operatorAttestedRefinementPreferenceEnabledAfterReinstall: true,
      harnessVerifiedRefinementPreferencePreservedAfterReinstall: true,
      operatorAttestedLegacySessionCountAfterReinstall: 1,
      harnessVerifiedSelectedDataPresentAfterReinstall: true,
      preservationManifestSha256AfterReinstall: '3'.repeat(64),
      preservationManifestUnchangedThroughReinstall: true,
      harnessObservedReinstallNormalExit: true,
      harnessVerifiedReinstallExportsMatch: true,
      exports: exportSet(),
      reinstallExports: exportSet()
    },
    privacy: {
      operatorAttestedNoPhysicalAudioSource: true,
      operatorAttestedNoCaptureCommand: true,
      operatorAttestedNoSpeakerPlayback: true,
      harnessAudioFileCount: 0,
      harnessPersistedAudioReferenceCount: 0,
      reportContainsTranscriptText: false,
      reportContainsAbsolutePath: false,
      reportContainsSensitiveNetworkData: false
    },
    limitations: [...EXPECTED_LIMITATIONS]
  }
}

test('strict I4 non-audio report binds installed and reinstalled files but remains partial', () => {
  const layoutEvidence = readTrackedLayoutEvidence()
  const report = validReport(layoutEvidence)
  assert.equal(validateI4NonAudioNsisReport(report, layoutEvidence), report)

  assert.throws(() => validateI4NonAudioNsisReport({ ...report, gateStatus: 'full' }, layoutEvidence),
    /cannot close full I4/)
  assert.throws(() => validateI4NonAudioNsisReport({
    ...report,
    artifact: { ...report.artifact, installedAsarSha256: 'f'.repeat(64) }
  }, layoutEvidence), /installed files/)
  assert.throws(() => validateI4NonAudioNsisReport({
    ...report,
    artifact: { ...report.artifact, reinstalledExecutableSha256: 'd'.repeat(64) }
  }, layoutEvidence), /installed files/)
  assert.throws(() => validateI4NonAudioNsisReport({
    ...report,
    artifact: { ...report.artifact, reinstalledAsarSha256: 'c'.repeat(64) }
  }, layoutEvidence), /installed files/)
  assert.throws(() => validateI4NonAudioNsisReport({
    ...report,
    artifact: { ...report.artifact, b5LayoutEvidenceSha256: 'e'.repeat(64) }
  }, layoutEvidence), /installed files/)
  assert.throws(() => validateI4NonAudioNsisReport({
    ...report,
    firstLaunch: { ...report.firstLaunch, operatorAttestedPublicHttpsCoreDownloadFromSettings: false }
  }, layoutEvidence), /operatorAttestedPublicHttpsCoreDownloadFromSettings/)
  assert.throws(() => validateI4NonAudioNsisReport({
    ...report,
    firstLaunch: { ...report.firstLaunch, refinementReadyMarkerCount: 1 }
  }, layoutEvidence), /core-resource evidence/)
  assert.throws(() => validateI4NonAudioNsisReport({
    ...report,
    refinementSetup: {
      ...report.refinementSetup,
      harnessVerifiedRefinementPreferenceDisabledAfterDownload: false
    }
  }, layoutEvidence), /harnessVerifiedRefinementPreferenceDisabledAfterDownload/)
  assert.throws(() => validateI4NonAudioNsisReport({
    ...report,
    refinementSetup: { ...report.refinementSetup, refinementModelFileCount: 0 }
  }, layoutEvidence), /explicit refinement-resource evidence/)
  assert.throws(() => validateI4NonAudioNsisReport({
    ...report,
    firstLaunch: {
      ...report.firstLaunch,
      manifestAllowedDownloadHosts: report.firstLaunch.manifestAllowedDownloadHosts.slice(0, 2)
    }
  }, layoutEvidence), /core-resource evidence/)
  assert.throws(() => validateI4NonAudioNsisReport({
    ...report,
    offlineRestart: { ...report.offlineRestart, networkAttemptCountAssessed: true }
  }, layoutEvidence), /networkAttemptCountAssessed/)
  assert.throws(() => validateI4NonAudioNsisReport({
    ...report,
    dataLifecycle: {
      ...report.dataLifecycle,
      preservationManifestSha256AfterReinstall: '7'.repeat(64)
    }
  }, layoutEvidence), /changed during uninstall or offline reinstall/)
  assert.throws(() => validateI4NonAudioNsisReport({
    ...report,
    dataLifecycle: {
      ...report.dataLifecycle,
      reinstallExports: {
        ...report.dataLifecycle.reinstallExports,
        text: { ...report.dataLifecycle.reinstallExports.text, sha256: '8'.repeat(64) }
      }
    }
  }, layoutEvidence), /reinstall text export differs/)
  assert.throws(() => validateI4NonAudioNsisReport({
    ...report,
    privacy: { ...report.privacy, harnessAudioFileCount: 1 }
  }, layoutEvidence), /audio artifact/)
})

test('I4 non-audio report reader rejects duplicate JSON keys', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'i4-nonaudio-report-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const reportPath = path.join(directory, 'duplicate.json')
  fs.writeFileSync(reportPath, '{"schemaVersion":3,"schemaVersion":3}', 'utf8')
  assert.throws(() => readAndValidateI4NonAudioNsisReport(reportPath), /duplicate object key/)
})

test('dedicated-machine harness distinguishes observed checks from operator attestations', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'qualify-i4-nonaudio-nsis.ps1'), 'utf8')
  assert.match(source, /GetFolderPath\('ApplicationData'\)/)
  assert.match(source, /Get-Command -Name node/)
  assert.match(source, /B5LayoutEvidence/)
  assert.match(source, /Assert-InstalledFilesMatchB5/)
  assert.match(source, /appExecutableSha256/)
  assert.match(source, /appAsarSha256/)
  assert.match(source, /Assert-AllDownloadHostsUnreachable/)
  for (const host of EXPECTED_ALLOWED_HOSTS) assert.match(source, new RegExp(host.replaceAll('.', '\\.')))
  assert.match(source, /operatorAttestedPublicHttpsCoreDownloadFromSettings/)
  assert.match(source, /REFINEMENT-DOWNLOAD-READY-NO-CAPTURE/)
  assert.match(source, /REFINEMENT-PREFERENCE-ENABLED-NO-CAPTURE/)
  assert.match(source, /Get-RefinementPreference/)
  assert.match(source, /ExpectedCoreDownloadedBytes/)
  assert.match(source, /ExpectedRefinementDownloadedBytes/)
  assert.match(source, /operatorAttestedLegacySessionCountAfterReinstall/)
  assert.match(source, /harnessVerifiedReinstallExportsMatch/)
  assert.match(source, /FIRST-LAUNCH-NO-CAPTURE/)
  assert.match(source, /OFFLINE-EXPORTS-NO-CAPTURE/)
  assert.match(source, /REINSTALL-READY-NO-CAPTURE/)
  assert.match(source, /Get-AuthenticodeSignature/)
  assert.doesNotMatch(source, /applicationDataPreservedAfterUninstall|publicModelDownloadFromSettings/)
  assert.doesNotMatch(source, /all three resources/)
  assert.doesNotMatch(source, /Stop-Process|taskkill|SendKeys|UIAutomation/)
  assert.doesNotMatch(source, /Start-Process[^\r\n]*(?:node|npm)|(?:^|\s)&\s*(?:node|npm)(?:\.exe)?(?:\s|$)/im)
})
