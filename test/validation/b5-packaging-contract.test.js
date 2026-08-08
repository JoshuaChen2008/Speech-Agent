'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const releaseConfig = require('../../electron-builder.config.cjs')
const smokeConfig = require('../../electron-builder.smoke.config.cjs')
const {
  REQUIRED_ASAR_ENTRIES,
  REQUIRED_NATIVE_FILES,
  parseArguments: parseLayoutArguments,
  validatePackageLayoutReport
} = require('../../scripts/verify-package-layout')
const {
  validatePackagedProductShellReport
} = require('../../scripts/verify-packaged-product-shell-report')
const {
  validateProductShellRestartReport
} = require('../../scripts/verify-product-shell-restart-report')
const {
  validateElectronExitEvidence
} = require('../../scripts/verify-electron-exit-evidence')
const {
  parseArguments: parsePackagedArguments,
  sanitizedEnvironment
} = require('../../scripts/run-packaged-product-shell')
const {
  parseArguments: parseNsisArguments,
  validateNsisLifecycleReport
} = require('../../scripts/qualify-nsis-lifecycle')
const {
  IDENTITY_VERSION,
  collectProductPayloadEntries,
  computeProductPayloadIdentity
} = require('../../src/main/services/product-payload-identity')
const {
  PRODUCT_SHELL_V5_WINDOW_INTERACTION_KEYS,
  PRODUCT_SHELL_V6_APPLICATION_LIFECYCLE_KEYS
} = require('../../scripts/verify-product-shell-report')
const {
  readAndValidatePackagedRunBindingReport,
  sha256File
} = require('../../scripts/verify-packaged-run-binding')

const ROOT = path.resolve(__dirname, '../..')
const VALIDATION_DIR = path.join(ROOT, 'docs', 'validation')
const SAMPLE_RUN_ID = 'b5-00000000-0000-4000-8000-000000000000'
const SAMPLE_PAYLOAD_SHA256 = 'b'.repeat(64)

function readValidationReport (name) {
  return JSON.parse(fs.readFileSync(path.join(VALIDATION_DIR, name), 'utf8'))
}

function validationReportPath (name) {
  return path.join(VALIDATION_DIR, name)
}

function productShellV2Fixture () {
  const report = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'docs', 'validation', 'b5-packaged-product-results.json'),
    'utf8'
  ))
  return {
    ...report,
    schemaVersion: 2,
    journey: {
      onboardingPreset: 'dictation',
      coreInstallClicked: true,
      coreInitialState: 'missing',
      refinementInitialState: 'missing',
      refinementPreferenceInitiallyDisabled: true,
      refinementPreferenceRejectedWhileMissing: true,
      refinementFetchAttemptCountBeforeExplicitDownload: 0,
      coreObservedStates: ['missing', 'downloading', 'verifying', 'ready'],
      coreRangeResumeObserved: true,
      coreReadyMarkerCount: 2,
      refinementReadyMarkerCountBeforeExplicitDownload: 0,
      coreHotActivation: true,
      refinementContinueRangeObserved: true,
      refinementExplicitDownloadReady: true,
      refinementReadyMarkerCount: 1,
      refinementPreferenceStillDisabledAfterDownload: true,
      refinementPreferenceExplicitlyEnabled: true,
      rawSessionFrozenOriginal: true,
      futureSessionFrozenRefinementEnabled: true,
      refinementFaultSilentDuringSession: true,
      postSessionRefinementNoticeShown: true,
      refinementNoticeClearedByHistory: true,
      historyRefinementFaultVisible: true,
      startListeningStop: true,
      pauseResume: true,
      finalCaptionRendered: true,
      visibleCaptionMatchesFinal: true,
      captionFontApplied: true,
      downloadedModelSessionInHistory: true,
      terminalHistoryCount: 4,
      legacyJsonlMigrated: true,
      legacySessionVisible: true,
      legacySourceReadOnly: true,
      longHistorySegmentCount: 205,
      historyPageCount: 5,
      historyPageSize: 50,
      historyMaxTimelineNodes: 50,
      historyReachedEnd: true,
      historyBackForwardNavigation: true,
      historyAriaRangeAligned: true,
      historyVersionStartsOriginal: true,
      historyRefinedVersionSelected: true,
      historyRefinedVersionPersistsAcrossPaging: true,
      historyRefinedExportHonored: true,
      historySessionChangeResetsOriginal: true,
      historyOriginalExportHonored: true,
      historyExportDialogCount: 5,
      historyOriginalExportFormats: ['txt', 'md', 'srt'],
      historyOriginalExportArtifactCount: 3,
      historyOriginalExportFullSegmentCount: 205,
      historyRefinedExportArtifactCount: 1,
      historyRawOriginalExportArtifactCount: 1,
      resourcesPaneOpenedFromToolbar: true,
      coreState: 'ready',
      refinementState: 'ready',
      resourceCount: 3,
      coreReadinessSource: 'settings-click-controlled-install',
      translationAdvertised: false
    }
  }
}

function productShellV3Fixture () {
  const report = productShellV2Fixture()
  const {
    refinementContinueRangeObserved,
    refinementExplicitDownloadReady,
    refinementPreferenceStillDisabledAfterDownload,
    refinementPreferenceExplicitlyEnabled,
    futureSessionFrozenRefinementEnabled,
    refinementFaultSilentDuringSession,
    postSessionRefinementNoticeShown,
    refinementNoticeClearedByHistory,
    historyRefinementFaultVisible,
    ...baseJourney
  } = report.journey
  return {
    ...report,
    schemaVersion: 3,
    journey: {
      ...baseJourney,
      refinementDownloadStartedBeforeCancellation: true,
      refinementCancellationClosedFetchStream: true,
      refinementCancellationRetainedPart: true,
      refinementReadyMarkerCount: 0,
      terminalHistoryCount: 3,
      refinementState: 'missing'
    }
  }
}

function productShellV4Fixture () {
  const report = productShellV3Fixture()
  return {
    ...report,
    schemaVersion: 4,
    journey: {
      ...report.journey,
      coreReadyMarkerCount: 3,
      resourceCount: 4
    }
  }
}

function productShellV5Fixture () {
  const report = productShellV4Fixture()
  const identity = computeProductPayloadIdentity()
  const windowInteraction = Object.fromEntries(
    PRODUCT_SHELL_V5_WINDOW_INTERACTION_KEYS.map((key) => [key, true])
  )
  Object.assign(windowInteraction, {
    layoutFallbackObservationCount: 4,
    layoutRecoveryObservationCount: 4,
    visibleCardDragPointCount: 2,
    gestureCancellationObservationCount: 6,
    normalTitlebarDragCount: 2,
    normalInteractiveExclusionCount: 2,
    normalBodyExclusionCount: 2,
    normalForegroundPromotionCount: 2
  })
  const sourceIdentity = {
    productPayloadVersion: identity.version,
    productPayloadFileCount: identity.fileCount,
    productPayloadSha256: identity.sha256
  }
  return {
    ...report,
    schemaVersion: 5,
    qualification: {
      ...report.qualification,
      ...sourceIdentity
    },
    windowInteraction,
    sourceIdentity,
    limitations: [
      'fake-asr-no-physical-audio',
      'controlled-model-fixtures-no-real-tensors',
      'deterministic-205-segment-fixture-not-two-hour-i3',
      'controlled-pointer-and-focus-no-human-dwm',
      'no-system-dpi-or-mixed-scale-qualification',
      'not-clean-machine-i4',
      'packaged-test-variant-not-release-installer'
    ]
  }
}

function productShellV6Fixture () {
  const report = productShellV5Fixture()
  const applicationLifecycle = Object.fromEntries(
    PRODUCT_SHELL_V6_APPLICATION_LIFECYCLE_KEYS.map((key) => [key, true])
  )
  applicationLifecycle.visibleAuxiliaryWindowCountBeforeMinimize = 2
  applicationLifecycle.minimizedAuxiliaryWindowCount = 2
  return { ...report, schemaVersion: 6, applicationLifecycle }
}

test('release package uses an explicit ASAR allowlist, hardened fuses and per-user NSIS', () => {
  assert.equal(releaseConfig.asar, true)
  assert.equal(releaseConfig.npmRebuild, false)
  assert.deepEqual(releaseConfig.files, ['package.json', 'src/**/*'])
  assert.deepEqual(releaseConfig.asarUnpack, ['node_modules/sherpa-onnx-win-x64/**/*'])
  assert.deepEqual(releaseConfig.electronFuses, {
    runAsNode: false,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true
  })
  assert.equal(releaseConfig.win.requestedExecutionLevel, 'asInvoker')
  assert.equal(releaseConfig.nsis.oneClick, true)
  assert.equal(releaseConfig.nsis.perMachine, false)
  assert.equal(releaseConfig.nsis.deleteAppDataOnUninstall, false)
  assert.equal(releaseConfig.nsis.packElevateHelper, false)
  assert.equal(releaseConfig.extraResources, undefined)
  assert.equal(releaseConfig.files.some((entry) => /models|scripts|test|docs|artifacts/i.test(entry)), false)

  const textExtensions = ['.css', '.html', '.js', '.json', '.md', '.mjs', '.ts', '.tsx']
  const productExtensions = [...new Set(collectProductPayloadEntries(path.join(ROOT, 'src'))
    .map((entry) => path.extname(entry.name)))].sort()
  assert.deepEqual(productExtensions, textExtensions)
  const attributes = fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8')
  for (const extension of textExtensions) {
    const escaped = extension.replace('.', '\\.')
    assert.match(attributes, new RegExp(`^src/\\*\\*\\/\\*${escaped} text eol=lf$`, 'm'),
      `complete product ${extension} payload must be pinned to LF checkout bytes`)
  }
})

test('SEM-F18/SEM-T12: product payload identity excludes build-only type declarations omitted from ASAR', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'live-subtitle-product-payload-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'nested'))
  fs.writeFileSync(path.join(root, 'runtime.js'), 'module.exports = true\n')
  fs.writeFileSync(path.join(root, 'renderer-globals.d.ts'), 'declare const runtimeOnly: boolean\n')
  fs.writeFileSync(path.join(root, 'nested', 'view.tsx'), 'export const view = null\n')

  assert.deepEqual(
    collectProductPayloadEntries(root).map((entry) => entry.name).sort(),
    ['src/nested/view.tsx', 'src/runtime.js']
  )
})

test('test-only packaged journey preserves the production layout but cannot be mistaken for release', () => {
  assert.equal(smokeConfig.asar, releaseConfig.asar)
  assert.deepEqual(smokeConfig.asarUnpack, releaseConfig.asarUnpack)
  assert.equal(smokeConfig.extraMetadata.main, 'scripts/product-shell-smoke.js')
  assert.notEqual(smokeConfig.appId, releaseConfig.appId)
  assert.notEqual(smokeConfig.productName, releaseConfig.productName)
  assert.deepEqual(smokeConfig.win.target, [{ target: 'dir', arch: ['x64'] }])
  assert.deepEqual(smokeConfig.files.filter((entry) => entry.startsWith('scripts/')), [
    'scripts/product-shell-smoke.js',
    'scripts/model-ui-fixture-support.js',
    'scripts/packaged-native-load-probe.js'
  ])
})

test('packaged runner strips Node and every subtitle development environment seam', () => {
  const environment = sanitizedEnvironment({
    PATH: 'safe',
    NODE_OPTIONS: '--inspect',
    NODE_PATH: 'private',
    ELECTRON_RUN_AS_NODE: '1',
    LIVE_SUBTITLE_DEV_MODEL: 'x-asr-480ms',
    LIVE_SUBTITLE_DEV_RUNTIME: 'structural',
    LIVE_SUBTITLE_ALLOW_EXTERNAL_MODELS: '1',
    LIVE_SUBTITLE_MODEL_DIR: 'private'
  })
  assert.deepEqual(environment, { PATH: 'safe' })
  const executable = path.join(ROOT, '.artifacts', 'package', 'LiveSubtitle.exe')
  const artifactsRoot = path.join(ROOT, '.artifacts', 'packaged-product')
  assert.deepEqual(parsePackagedArguments([
    '--executable', executable,
    '--artifacts-root', artifactsRoot,
    '--electron-major', '43'
  ]), { executable, artifactsRoot, electronMajor: 43 })
})

test('layout report validator separates the release installer from the test package', () => {
  const base = {
    schemaVersion: 2,
    kind: 'packaged-layout-qualification',
    generatedAt: '2026-07-31T00:00:00.000Z',
    result: 'pass',
    gateStatus: 'packaged-ci-qualified',
    artifact: {
      variant: 'smoke',
      arch: 'x64',
      appVersion: '0.1.0',
      electronVersion: '43.2.0',
      builderVersion: '26.15.3',
      sherpaWrapperVersion: '1.13.4',
      sherpaPlatformVersion: '1.13.4',
      mainEntry: 'scripts/product-shell-smoke.js',
      appExecutableX64: true,
      appAsarPresent: true,
      appExecutableSha256: 'c'.repeat(64),
      appAsarSha256: 'd'.repeat(64),
      asarEntryCount: 100,
      productPayloadVersion: IDENTITY_VERSION,
      productPayloadFileCount: 80,
      productPayloadSha256: SAMPLE_PAYLOAD_SHA256,
      installerPresent: false,
      installerSha256: null,
      signingStatus: 'not-assessed'
    },
    layout: {
      requiredProductEntryCount: REQUIRED_ASAR_ENTRIES.length,
      requiredProductEntriesPresent: true,
      forbiddenDevelopmentTreesAbsent: true,
      modelTensorsBundled: false,
      audioPayloadsBundled: false
    },
    native: {
      requiredBinaryCount: REQUIRED_NATIVE_FILES.length,
      unpackedBinaryCount: REQUIRED_NATIVE_FILES.length,
      allMarkedUnpacked: true
    },
    evidenceBinding: null,
    limitations: ['test-only-main-entry', 'win-unpacked-not-nsis-installed', 'not-clean-machine-i4']
  }
  assert.equal(validatePackageLayoutReport(base, 'smoke'), base)
  assert.throws(() => validatePackageLayoutReport({
    ...base,
    artifact: { ...base.artifact, variant: 'release', mainEntry: 'src/main.js' }
  }, 'release'), /installer/)
  assert.deepEqual(parseLayoutArguments([
    '--package-dir', 'package', '--variant', 'smoke', '--report', 'report.json'
  ]), {
    packageDir: 'package',
    variant: 'smoke',
    report: 'report.json',
    installer: null,
    qualificationBinding: null
  })
  assert.throws(() => parseLayoutArguments([
    '--package-dir', 'package', '--variant', 'release', '--report', 'report.json',
    '--installer', 'candidate.exe'
  ]), /requires --qualification-binding/)
  assert.throws(() => parseLayoutArguments([
    '--package-dir', 'package', '--variant', 'smoke', '--report', 'report.json',
    '--qualification-binding', 'binding.json'
  ]), /cannot claim a release qualification binding/)
})

test('packaged product report requires ASAR, native utility and SQLite round-trip evidence', () => {
  const report = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'validation', 'product-shell-results.json'), 'utf8'))
  report.packaging = {
    appIsPackaged: true,
    defaultApp: false,
    smokeMainFromAsar: true,
    productMainFromAsar: true,
    storageUtilityRoundTrip: true,
    nativeBinaryCount: 5,
    nativeAddonLoadedInUtility: true,
    nativeApiSurfaceReady: true,
    nativeProbeExactExitCode: 0,
    nativeProbeFatalObserved: false,
    packagedDb0Status: 'pass',
    packagedDb0CheckCount: 16,
    packagedDb0Wal: true,
    packagedDb0Reopen: true,
    packagedDb0Integrity: true,
    packagedDb0ExactExitCode: 0,
    releaseCandidate: false,
    installedViaNsis: false
  }
  report.qualification = {
    runId: SAMPLE_RUN_ID,
    phase: 'fresh',
    freshProductReportSha256: null,
    productPayloadVersion: IDENTITY_VERSION,
    productPayloadFileCount: 80,
    productPayloadSha256: SAMPLE_PAYLOAD_SHA256
  }
  report.limitations = report.limitations
    .filter((limitation) => limitation !== 'not-packaged-i4')
    .concat('not-clean-machine-i4', 'packaged-test-variant-not-release-installer')
  assert.equal(validatePackagedProductShellReport(report), report)
  assert.throws(() => validatePackagedProductShellReport({
    ...report,
    packaging: { ...report.packaging, releaseCandidate: true }
  }), /overclaims/)
  assert.throws(() => validatePackagedProductShellReport({
    ...report,
    limitations: report.limitations.concat('not-packaged-i4')
  }), /limitations/)
})

test('packaged product v2 evidence closes the split core/refinement, history-version and post-session notice journey', () => {
  const report = productShellV2Fixture()
  assert.equal(validatePackagedProductShellReport(report), report)
  assert.throws(() => validatePackagedProductShellReport({
    ...report,
    journey: { ...report.journey, refinementFetchAttemptCountBeforeExplicitDownload: 1 }
  }), /v2 user journey/)
  assert.throws(() => validatePackagedProductShellReport({
    ...report,
    journey: { ...report.journey, unexpectedEvidence: true }
  }), /v2 user journey/)
})

test('packaged product v3 evidence records the streamed cancellation before restart continuation', () => {
  const report = productShellV3Fixture()
  assert.equal(validatePackagedProductShellReport(report), report)
  assert.throws(() => validatePackagedProductShellReport({
    ...report,
    journey: { ...report.journey, refinementCancellationRetainedPart: false }
  }), /v3 user journey/)
  assert.throws(() => validatePackagedProductShellReport({
    ...report,
    journey: { ...report.journey, unexpectedEvidence: true }
  }), /v3 user journey/)
})

test('packaged product v4 evidence requires the SEM-F21 three-core-marker and four-resource boundary', () => {
  const report = productShellV4Fixture()
  assert.equal(validatePackagedProductShellReport(report), report)
  assert.throws(() => validatePackagedProductShellReport({
    ...report,
    journey: { ...report.journey, coreReadyMarkerCount: 2 }
  }), /v4 user journey/)
  assert.throws(() => validatePackagedProductShellReport({
    ...report,
    journey: { ...report.journey, resourceCount: 3 }
  }), /v4 user journey/)
})

test('packaged product v5 evidence binds J17 window interaction to the qualified product payload', () => {
  const report = productShellV5Fixture()
  assert.equal(validatePackagedProductShellReport(report), report)
  assert.throws(() => validatePackagedProductShellReport({
    ...report,
    qualification: {
      ...report.qualification,
      productPayloadSha256: '0'.repeat(64)
    }
  }), /source identity|qualification-bound/)
})

test('packaged product v6 evidence adds J19 application lifecycle without weakening J17 binding', () => {
  const report = productShellV6Fixture()
  assert.equal(validatePackagedProductShellReport(report), report)
  assert.throws(() => validatePackagedProductShellReport({
    ...report,
    applicationLifecycle: {
      ...report.applicationLifecycle,
      rendererExitRequested: false
    }
  }), /application lifecycle/)
})

test('packaged smoke source starts at packaged argv and probes native code in a utility process', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'product-shell-smoke.js'), 'utf8')
  assert.match(source, /process\.argv\.slice\(app\.isPackaged \? 1 : 2\)/)
  assert.match(source, /utilityProcess\.fork\(probePath/)
  assert.match(source, /app\.asar\.unpacked/)
  assert.match(source, /releaseCandidate: false/)
  assert.match(source, /coreReadyMarkerCount/)
  assert.match(source, /schemaVersion:\s*6/)
  assert.match(source, /applicationLifecycle/)
  assert.match(source, /controlled-pointer-and-focus-no-human-dwm/)
  assert.match(source, /refinementContinueRangeObserved/)
  assert.match(source, /historyRefinedVersionPersistsAcrossPaging/)
  assert.match(source, /postSessionRefinementNoticeShown/)
})

test('NSIS lifecycle report binds install/uninstall mechanics without claiming an app journey', () => {
  const installerSha256 = 'a'.repeat(64)
  const report = {
    schemaVersion: 2,
    kind: 'nsis-lifecycle-qualification',
    generatedAt: '2026-07-31T00:00:00.000Z',
    result: 'pass',
    gateStatus: 'packaged-ci-qualified',
    artifact: { installerSha256, target: 'nsis', arch: 'x64' },
    lifecycle: {
      perUserSilentInstall: true,
      customIsolatedInstallDirectory: true,
      installedApplicationPresent: true,
      generatedUninstallerPresent: true,
      exactUninstallerExitZero: true,
      installDirectoryRemoved: true,
      applicationLaunched: false
    },
    dataPolicy: {
      configuredToPreserveUserData: true,
      isolatedAppDataEnvironment: true,
      preservationProbeKind: 'unrelated-isolated-appdata-sentinel',
      preservationProbeOwnedByApplication: false,
      preservationProbeUnchanged: true,
      applicationUserDataPathObserved: false,
      applicationUserDataWriteExercised: false
    },
    limitations: [
      'silent-installer-mechanics-only',
      'application-not-launched',
      'application-userdata-path-not-observed',
      'application-userdata-write-not-exercised',
      'not-clean-machine-i4'
    ]
  }
  assert.equal(validateNsisLifecycleReport(report, installerSha256), report)
  assert.throws(() => validateNsisLifecycleReport({
    ...report,
    lifecycle: { ...report.lifecycle, applicationLaunched: true }
  }), /invalid NSIS/)
  assert.throws(() => validateNsisLifecycleReport({
    ...report,
    dataPolicy: { ...report.dataPolicy, preservationProbeUnchanged: false }
  }), /invalid NSIS/)
  assert.throws(() => validateNsisLifecycleReport({
    ...report,
    dataPolicy: { ...report.dataPolicy, applicationUserDataPathObserved: true }
  }), /invalid NSIS/)

  const installer = path.join(ROOT, '.artifacts', 'release', 'candidate.exe')
  const artifactsRoot = path.join(ROOT, '.artifacts', 'nsis-lifecycle')
  const reportPath = path.join(artifactsRoot, 'report.json')
  assert.deepEqual(parseNsisArguments([
    '--installer', installer,
    '--artifacts-root', artifactsRoot,
    '--report', reportPath
  ], ROOT), { installer, artifactsRoot, report: reportPath })
})

test('tracked B5 evidence is mutually consistent and preserves the I4 boundary', () => {
  const productPath = validationReportPath('b5-packaged-product-results.json')
  const exitPath = validationReportPath('b5-packaged-exit-results.json')
  const restartPath = validationReportPath('b5-packaged-restart-results.json')
  const restartExitPath = validationReportPath('b5-packaged-restart-exit-results.json')
  const bindingPath = validationReportPath('b5-packaged-run-binding-results.json')
  const layout = validatePackageLayoutReport(
    readValidationReport('b5-packaged-layout-results.json'),
    'release'
  )
  const product = validatePackagedProductShellReport(
    readValidationReport('b5-packaged-product-results.json')
  )
  const restart = validateProductShellRestartReport(
    readValidationReport('b5-packaged-restart-results.json')
  )
  const exit = validateElectronExitEvidence(
    readValidationReport('b5-packaged-exit-results.json')
  )
  const restartExit = validateElectronExitEvidence(
    readValidationReport('b5-packaged-restart-exit-results.json')
  )
  const binding = readAndValidatePackagedRunBindingReport(bindingPath)
  const lifecycle = validateNsisLifecycleReport(
    readValidationReport('b5-nsis-lifecycle-results.json'),
    layout.artifact.installerSha256
  )
  const evidenceDocument = fs.readFileSync(path.join(VALIDATION_DIR, 'b5-packaging.md'), 'utf8')
  const runtimeArchitecture = fs.readFileSync(path.join(ROOT, 'docs', 'runtime-architecture.md'), 'utf8')
  const abbreviatedSha = (sha256) => `${sha256.slice(0, 8)}…${sha256.slice(-5)}`

  assert.equal(layout.artifact.installerSha256, lifecycle.artifact.installerSha256)
  assert.equal(layout.artifact.signingStatus, 'not-signed')
  assert.match(evidenceDocument, new RegExp(layout.artifact.installerSha256))
  assert.match(runtimeArchitecture, new RegExp(abbreviatedSha(layout.artifact.installerSha256)))
  assert.equal(product.qualification.runId, binding.run.runId)
  assert.equal(restart.qualification.runId, binding.run.runId)
  assert.equal(layout.evidenceBinding.runId, binding.run.runId)
  assert.equal(product.qualification.phase, 'fresh')
  assert.equal(restart.qualification.phase, 'restart')
  assert.equal(restart.qualification.freshProductReportSha256, binding.fresh.productReportSha256)
  assert.equal(sha256File(productPath), binding.fresh.productReportSha256)
  assert.equal(sha256File(exitPath), binding.fresh.exitReportSha256)
  assert.equal(sha256File(restartPath), binding.restart.productReportSha256)
  assert.equal(sha256File(restartExitPath), binding.restart.exitReportSha256)
  assert.equal(sha256File(bindingPath), layout.evidenceBinding.bindingReportSha256)
  assert.equal(layout.evidenceBinding.testExecutableSha256, binding.run.testExecutableSha256)
  assert.equal(layout.evidenceBinding.freshProductReportSha256, binding.fresh.productReportSha256)
  assert.equal(layout.evidenceBinding.freshExitReportSha256, binding.fresh.exitReportSha256)
  assert.equal(layout.evidenceBinding.restartProductReportSha256, binding.restart.productReportSha256)
  assert.equal(layout.evidenceBinding.restartExitReportSha256, binding.restart.exitReportSha256)
  for (const qualification of [product.qualification, restart.qualification]) {
    assert.equal(qualification.productPayloadVersion, binding.run.productPayloadVersion)
    assert.equal(qualification.productPayloadFileCount, binding.run.productPayloadFileCount)
    assert.equal(qualification.productPayloadSha256, binding.run.productPayloadSha256)
  }
  assert.equal(layout.artifact.productPayloadVersion, binding.run.productPayloadVersion)
  assert.equal(layout.artifact.productPayloadFileCount, binding.run.productPayloadFileCount)
  assert.equal(layout.artifact.productPayloadSha256, binding.run.productPayloadSha256)
  assert.match(runtimeArchitecture, new RegExp(abbreviatedSha(binding.run.productPayloadSha256)))
  assert.equal(product.packaging.releaseCandidate, false)
  assert.equal(product.packaging.installedViaNsis, false)
  assert.ok(product.limitations.includes('not-clean-machine-i4'))
  assert.ok(product.limitations.includes('packaged-test-variant-not-release-installer'))
  assert.equal(restart.schemaVersion === 3
    ? restart.journey.modelFetchAttemptCountBeforeExplicitContinue
    : restart.journey.modelFetchAttemptCount, 0)
  assert.equal(restart.journey.legacyMigrationIdempotent, true)
  assert.equal(restart.schemaVersion === 1
    ? restart.journey.historyExportFullSegmentCount
    : restart.journey.historyOriginalExportFullSegmentCount, 205)
  assert.equal(restart.journey.terminalHistoryCountAfterRestart,
    restart.schemaVersion === 3 ? 4 : 5)
  assert.equal(exit.outcome, 'clean-exit')
  assert.equal(exit.counters.incidentCount, 0)
  assert.equal(exit.attribution.breakpointObserved, false)
  assert.equal(exit.scope.packagedRuntime, true)
  assert.equal(exit.scope.nativeStackCaptured, false)
  assert.equal(exit.scope.rootCauseIdentified, false)
  assert.equal(restartExit.outcome, 'clean-exit')
  assert.equal(restartExit.counters.incidentCount, 0)
  assert.equal(restartExit.scope.packagedRuntime, true)
  assert.ok(lifecycle.limitations.includes('not-clean-machine-i4'))
})

test('Windows CI keeps packaged layout product and NSIS lifecycle gates in order', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  const orderedMarkers = [
    'npm run package:smoke',
    '--variant smoke',
    'node scripts/run-packaged-product-shell.js',
    'npm run package:release',
    '--variant release',
    '--installer .artifacts/release-package/Live-Subtitle-0.1.0-x64.exe',
    '--qualification-binding .artifacts/packaged-product-ci/qualification-binding.json',
    'node scripts/qualify-nsis-lifecycle.js',
    'run: npm run test:ci'
  ]
  let previous = -1
  for (const marker of orderedMarkers) {
    const position = workflow.indexOf(marker)
    assert.ok(position > previous, `CI marker is absent or out of order: ${marker}`)
    previous = position
  }
  assert.match(workflow, /timeout-minutes:\s*30/)
  assert.match(workflow, /--electron-major 43/)

  const runner = fs.readFileSync(path.join(ROOT, 'scripts', 'run-packaged-product-shell.js'), 'utf8')
  assert.match(runner, /readAndValidatePackagedProductShellReport\(reportPath\)/)
  assert.match(runner, /readAndValidateElectronExitEvidence\(evidencePath\)/)
  assert.match(runner, /scope\.packagedRuntime !== true/)
})

test('semantic table freezes package release and uninstall boundaries', () => {
  const semantic = fs.readFileSync(path.join(ROOT, 'docs', 'semantic-contract.md'), 'utf8')
  const rowFor = (id) => semantic.split(/\r?\n/).find((line) => line.includes(`**${id}**`)) || ''
  const packaged = rowFor('SEM-F18')
  const uninstall = rowFor('SEM-F19')
  const evidenceLevels = rowFor('SEM-T12')

  assert.match(packaged, /ASAR/)
  assert.match(packaged, /native/)
  assert.match(packaged, /test variant|\u6d4b试 package variant/)
  assert.match(packaged, /I4/)
  assert.match(uninstall, /userData/)
  assert.match(uninstall, /保留/)
  assert.match(uninstall, /单独、明确的用户动作/)
  assert.match(evidenceLevels, /B5/)
  assert.match(evidenceLevels, /I4/)
  assert.match(evidenceLevels, /七份结构化报告/)
})
