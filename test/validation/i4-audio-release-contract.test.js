'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  EXPECTED_LIMITATIONS: AUDIO_LIMITATIONS,
  readAudioEvidence,
  validateI4AudioChildReport
} = require('../../scripts/verify-i4-audio-child-report')
const {
  EXPECTED_LIMITATIONS: SUMMARY_LIMITATIONS,
  buildI4ReleaseSummary,
  validateI4ReleaseSummary
} = require('../../scripts/verify-i4-release-summary')
const { parseArguments: parseSummaryArguments } = require('../../scripts/write-i4-release-summary')
const {
  EXPECTED_LIMITATIONS: HANDOFF_LIMITATIONS,
  readAndValidateI4Handoff,
  sha256Bytes
} = require('../../scripts/verify-i4-clean-machine-handoff')
const { parseArguments: parseHandoffArguments } = require('../../scripts/build-i4-clean-machine-handoff')
const { readTrackedLayoutEvidence } = require('../../scripts/verify-i4-nonaudio-nsis-report')

const ROOT = path.resolve(__dirname, '../..')

function exportSet () {
  return {
    text: { bytes: 31, recordCount: 1, sha256: '4'.repeat(64) },
    markdown: { bytes: 64, recordCount: 1, sha256: '5'.repeat(64) },
    srt: { bytes: 76, recordCount: 1, sha256: '6'.repeat(64) }
  }
}

function minimalNonAudioEvidence (layoutEvidence) {
  return {
    sha256: 'a'.repeat(64),
    report: {
      result: 'pass',
      gateStatus: 'partial',
      artifact: { installerSha256: layoutEvidence.layout.artifact.installerSha256 },
      offlineRestart: { offlineControl: 'network-adapters-disabled-before-restart' }
    }
  }
}

function validAudioReport (sourceId, layoutEvidence, nonAudioEvidence, priorLoopbackSha = null) {
  const layout = layoutEvidence.layout
  return {
    schemaVersion: 1,
    kind: 'i4-audio-source-child',
    generatedAt: '2026-08-03T00:00:00.000Z',
    result: 'pass',
    gateStatus: 'partial',
    sourceId,
    environment: {
      osFamily: 'windows',
      osBuild: 22631,
      harnessVerifiedInteractiveDesktop: true,
      harnessVerifiedNodeCommandAbsent: true,
      harnessVerifiedNonElevated: true,
      harnessVerifiedRepositoryAncestorsAbsent: true,
      downloadHostsUnreachable: true,
      offlineControl: nonAudioEvidence.report.offlineRestart.offlineControl
    },
    artifact: {
      b5LayoutEvidenceSha256: layoutEvidence.sha256,
      nonAudioReportSha256: nonAudioEvidence.sha256,
      installerSha256: layout.artifact.installerSha256,
      installedExecutableSha256: layout.artifact.appExecutableSha256,
      installedAsarSha256: layout.artifact.appAsarSha256,
      productPayloadVersion: layout.artifact.productPayloadVersion,
      productPayloadFileCount: layout.artifact.productPayloadFileCount,
      productPayloadSha256: layout.artifact.productPayloadSha256,
      exactCandidateBound: true
    },
    ordering: {
      ordinal: sourceId === 'loopback' ? 1 : 2,
      priorLoopbackChildReportSha256: sourceId === 'loopback' ? null : priorLoopbackSha,
      harnessVerifiedNoExactCandidateProcessBeforeLaunch: true,
      harnessVerifiedSerializedExactLaunches: true,
      operatorAttestedOtherSourceInactive: true
    },
    permission: {
      operatorAttestedPermissionDenialVisible: true,
      operatorAttestedPermissionDenied: true,
      operatorAttestedNoCaptionDuringDenial: true,
      operatorAttestedPermissionApproved: true
    },
    sourceEvidence: {
      operatorAttestedRealSourceAudio: true,
      operatorAttestedNoFixtureOrVirtualReplay: true,
      operatorAttestedSystemAudioSource: sourceId === 'loopback',
      operatorAttestedPhysicalMicrophoneSource: sourceId === 'mic'
    },
    journey: {
      harnessObservedPermissionDenialLaunchNormalExit: true,
      harnessObservedCaptureLaunchNormalExit: true,
      harnessObservedOfflineRestartNormalExit: true,
      operatorAttestedSourceSelected: true,
      operatorAttestedStarted: true,
      operatorAttestedPartialVisible: true,
      operatorAttestedFirstPassFinalVisible: true,
      operatorAttestedRefinementVisible: true,
      operatorAttestedPaused: true,
      operatorAttestedNoNewCaptionWhilePaused: true,
      operatorAttestedResumed: true,
      operatorAttestedCaptionAfterResume: true,
      operatorAttestedStopped: true,
      operatorAttestedHistorySessionVisible: true,
      operatorAttestedNativeSaveDialogs: true,
      operatorAttestedNoCaptureDuringOfflineRestart: true
    },
    sqlite: {
      bytesBeforeCapture: 4096,
      sha256BeforeCapture: '1'.repeat(64),
      harnessSqliteHeaderValidBefore: true,
      bytesAfterStop: 8192,
      sha256AfterStop: '2'.repeat(64),
      harnessSqliteHeaderValidAfter: true,
      harnessSqliteChangedAfterJourney: true
    },
    exports: {
      beforeOfflineRestart: exportSet(),
      afterOfflineRestart: exportSet(),
      harnessVerifiedOfflineExportsMatch: true
    },
    privacy: {
      harnessAudioFileCount: 0,
      harnessPersistedAudioReferenceCount: 0,
      reportContainsTranscriptText: false,
      reportContainsDeviceName: false,
      reportContainsAbsolutePath: false
    },
    limitations: [...AUDIO_LIMITATIONS]
  }
}

function validChildren () {
  const layoutEvidence = readTrackedLayoutEvidence()
  const nonAudioEvidence = minimalNonAudioEvidence(layoutEvidence)
  const loopbackReport = validAudioReport('loopback', layoutEvidence, nonAudioEvidence)
  validateI4AudioChildReport(loopbackReport, {
    layoutEvidence,
    nonAudioEvidence,
    priorLoopbackEvidence: null
  })
  const loopbackEvidence = { report: loopbackReport, sha256: 'b'.repeat(64) }
  const micReport = validAudioReport('mic', layoutEvidence, nonAudioEvidence, loopbackEvidence.sha256)
  validateI4AudioChildReport(micReport, {
    layoutEvidence,
    nonAudioEvidence,
    priorLoopbackEvidence: loopbackEvidence
  })
  return {
    layoutEvidence,
    nonAudioEvidence,
    loopbackEvidence,
    micEvidence: { report: micReport, sha256: 'c'.repeat(64) }
  }
}

test('I4 audio children accept isolated loopback then mic journeys bound to one candidate', () => {
  const children = validChildren()
  assert.equal(children.loopbackEvidence.report.gateStatus, 'partial')
  assert.equal(children.micEvidence.report.ordering.priorLoopbackChildReportSha256,
    children.loopbackEvidence.sha256)
})

test('I4 audio child rejects a full-gate overclaim or incomplete permission evidence', () => {
  const children = validChildren()
  const overclaim = structuredClone(children.loopbackEvidence.report)
  overclaim.gateStatus = 'release-acceptance-complete'
  assert.throws(() => validateI4AudioChildReport(overclaim, {
    layoutEvidence: children.layoutEvidence,
    nonAudioEvidence: children.nonAudioEvidence,
    priorLoopbackEvidence: null
  }), /overclaim/)

  const incomplete = structuredClone(children.loopbackEvidence.report)
  incomplete.permission.operatorAttestedPermissionDenied = false
  assert.throws(() => validateI4AudioChildReport(incomplete, {
    layoutEvidence: children.layoutEvidence,
    nonAudioEvidence: children.nonAudioEvidence,
    priorLoopbackEvidence: null
  }), /permission/)
})

test('I4 mic child rejects missing, wrong, or mismatched prior loopback evidence', () => {
  const children = validChildren()
  const mic = children.micEvidence.report
  assert.throws(() => validateI4AudioChildReport(mic, {
    layoutEvidence: children.layoutEvidence,
    nonAudioEvidence: children.nonAudioEvidence,
    priorLoopbackEvidence: null
  }), /must follow/)
  assert.throws(() => validateI4AudioChildReport(mic, {
    layoutEvidence: children.layoutEvidence,
    nonAudioEvidence: children.nonAudioEvidence,
    priorLoopbackEvidence: { report: { sourceId: 'mic' }, sha256: 'b'.repeat(64) }
  }), /prior loopback/)
  const mismatched = structuredClone(mic)
  mismatched.ordering.priorLoopbackChildReportSha256 = 'd'.repeat(64)
  assert.throws(() => validateI4AudioChildReport(mismatched, {
    layoutEvidence: children.layoutEvidence,
    nonAudioEvidence: children.nonAudioEvidence,
    priorLoopbackEvidence: children.loopbackEvidence
  }), /prior loopback/)

  const otherCandidate = structuredClone(children.loopbackEvidence)
  otherCandidate.report.artifact.nonAudioReportSha256 = 'e'.repeat(64)
  assert.throws(() => validateI4AudioChildReport(mic, {
    layoutEvidence: children.layoutEvidence,
    nonAudioEvidence: children.nonAudioEvidence,
    priorLoopbackEvidence: otherCandidate
  }), /prior loopback/)
})

test('I4 audio child rejects unchanged SQLite, offline export drift, and persisted audio', () => {
  const children = validChildren()
  const options = {
    layoutEvidence: children.layoutEvidence,
    nonAudioEvidence: children.nonAudioEvidence,
    priorLoopbackEvidence: null
  }
  const unchanged = structuredClone(children.loopbackEvidence.report)
  unchanged.sqlite.sha256AfterStop = unchanged.sqlite.sha256BeforeCapture
  assert.throws(() => validateI4AudioChildReport(unchanged, options), /SQLite did not change/)

  const drift = structuredClone(children.loopbackEvidence.report)
  drift.exports.afterOfflineRestart.text.sha256 = '7'.repeat(64)
  assert.throws(() => validateI4AudioChildReport(drift, options), /offline text export differs/)

  const audio = structuredClone(children.loopbackEvidence.report)
  audio.privacy.harnessAudioFileCount = 1
  assert.throws(() => validateI4AudioChildReport(audio, options), /SEM-F14/)
})

test('I4 audio strict reader rejects duplicate JSON keys before object validation', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'i4-audio-strict-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const reportPath = path.join(directory, 'child.json')
  fs.writeFileSync(reportPath, '{"schemaVersion":1,"schemaVersion":1}\n')
  assert.throws(() => readAudioEvidence(reportPath), /duplicate object key/)
})

test('I4 strict summary forms only from all three bound child reports', () => {
  const children = validChildren()
  const summary = buildI4ReleaseSummary({ generatedAt: '2026-08-03T00:00:00.000Z', children })
  assert.equal(validateI4ReleaseSummary(summary, children), summary)
  assert.equal(summary.gateStatus, 'release-acceptance-complete')
  assert.deepEqual(summary.limitations, SUMMARY_LIMITATIONS)

  const missing = { ...children }
  delete missing.micEvidence
  assert.throws(() => validateI4ReleaseSummary(summary, missing), /unexpected keys/)

  const wrongDigest = structuredClone(summary)
  wrongDigest.children.mic.priorLoopbackChildReportSha256 = 'd'.repeat(64)
  assert.throws(() => validateI4ReleaseSummary(wrongDigest, children), /digests or source order/)

  const incompleteCoverage = structuredClone(summary)
  incompleteCoverage.coverage.permissionDeniedAndApprovedForBothSources = false
  assert.throws(() => validateI4ReleaseSummary(incompleteCoverage, children), /coverage is incomplete/)
})

test('I4 summary writer accepts only a complete argument set and .artifacts output', () => {
  const options = parseSummaryArguments([
    '--layout', 'layout.json', '--non-audio', 'non-audio.json', '--loopback', 'loopback.json',
    '--mic', 'mic.json', '--output', '.artifacts/i4/summary.json'
  ])
  assert.equal(options.output, path.join(ROOT, '.artifacts', 'i4', 'summary.json'))
  assert.throws(() => parseSummaryArguments([
    '--layout', 'layout.json', '--non-audio', 'non-audio.json', '--loopback', 'loopback.json',
    '--mic', 'mic.json', '--output', 'docs/validation/summary.json'
  ]), /under \.artifacts/)
  assert.throws(() => parseSummaryArguments([
    '--layout', 'layout.json', '--non-audio', 'non-audio.json', '--loopback', 'loopback.json'
  ]), /requires/)
})

function writeHandoffFixture (directory) {
  const payloads = {
    'installer/Live-Subtitle-0.1.0-x64.exe': Buffer.from('installer'),
    'fixtures/i4-nonaudio-legacy-session.jsonl': fs.readFileSync(
      path.join(ROOT, 'scripts', 'fixtures', 'i4-nonaudio-legacy-session.jsonl')),
    'runners/qualify-i4-audio-child.ps1': Buffer.from('Write-Output audio\n'),
    'runners/qualify-i4-nonaudio-nsis.ps1': Buffer.from('Write-Output nonaudio\n'),
    'verifiers/verify-i4-clean-machine-handoff.ps1': Buffer.from('Write-Output verifier\n')
  }
  const installerSha = sha256Bytes(payloads['installer/Live-Subtitle-0.1.0-x64.exe'])
  const layout = {
    artifact: {
      installerSha256: installerSha,
      productPayloadVersion: 'payload-v1',
      productPayloadFileCount: 3,
      productPayloadSha256: '9'.repeat(64)
    }
  }
  payloads['evidence/b5-packaged-layout-results.json'] = Buffer.from(JSON.stringify(layout) + '\n')
  const files = Object.entries(payloads).map(([relativePath, bytes]) => ({
    relativePath,
    role: {
      'evidence/b5-packaged-layout-results.json': 'b5-layout',
      'fixtures/i4-nonaudio-legacy-session.jsonl': 'legacy-fixture',
      'runners/qualify-i4-audio-child.ps1': 'audio-runner',
      'runners/qualify-i4-nonaudio-nsis.ps1': 'non-audio-runner',
      'verifiers/verify-i4-clean-machine-handoff.ps1': 'handoff-verifier'
    }[relativePath] || 'installer',
    bytes: bytes.length,
    sha256: sha256Bytes(bytes)
  })).sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  const manifest = {
    schemaVersion: 1,
    kind: 'i4-clean-machine-handoff',
    generatedAt: '2026-08-03T00:00:00.000Z',
    result: 'pass',
    artifact: {
      b5LayoutEvidenceSha256: sha256Bytes(payloads['evidence/b5-packaged-layout-results.json']),
      installerSha256: installerSha,
      productPayloadVersion: 'payload-v1',
      productPayloadFileCount: 3,
      productPayloadSha256: '9'.repeat(64),
      exactCandidateBound: true
    },
    files,
    constraints: {
      entryCount: 6,
      extraEntryCount: 0,
      repositoryTreeIncluded: false,
      nodeRuntimeIncluded: false
    },
    privacy: {
      capturedAudioFileCount: 0,
      capturedOrReportTranscriptTextIncluded: false,
      containsDeviceName: false,
      containsAbsolutePath: false,
      fixedSyntheticLegacyFixtureIncluded: true,
      fixedSyntheticLegacyFixtureSha256:
        sha256Bytes(payloads['fixtures/i4-nonaudio-legacy-session.jsonl'])
    },
    limitations: [...HANDOFF_LIMITATIONS]
  }
  for (const [relativePath, bytes] of Object.entries(payloads)) {
    const target = path.join(directory, ...relativePath.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes)
  }
  fs.writeFileSync(path.join(directory, 'handoff-manifest.json'), JSON.stringify(manifest) + '\n')
  return manifest
}

function runPowerShellHandoffVerifier (directory) {
  const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32',
    'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return childProcess.spawnSync(executable, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(ROOT, 'scripts', 'verify-i4-clean-machine-handoff.ps1'),
    '-BundleRoot', directory
  ], { encoding: 'utf8' })
}

test('I4 clean-machine handoff verifies six exact payloads plus its manifest with no repository or Node', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'i4-handoff-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  writeHandoffFixture(directory)
  const evidence = readAndValidateI4Handoff(directory)
  assert.equal(evidence.manifest.constraints.entryCount, 6)
  assert.equal(evidence.manifest.constraints.repositoryTreeIncluded, false)
  assert.equal(evidence.manifest.constraints.nodeRuntimeIncluded, false)

  fs.writeFileSync(path.join(directory, 'node.exe'), 'forbidden')
  assert.throws(() => readAndValidateI4Handoff(directory), /repository or Node runtime/)
})

test('I4 clean-machine handoff rejects modified payloads and unsafe output arguments', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'i4-handoff-drift-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  writeHandoffFixture(directory)
  fs.appendFileSync(path.join(directory, 'runners', 'qualify-i4-audio-child.ps1'), '# drift\n')
  assert.throws(() => readAndValidateI4Handoff(directory), /differs from manifest/)

  const options = parseHandoffArguments([
    '--installer', '.artifacts/release-package/Live-Subtitle-0.1.0-x64.exe',
    '--layout', 'docs/validation/b5-packaged-layout-results.json',
    '--output', '.artifacts/i4-clean-machine-handoff-test'
  ])
  assert.equal(options.output, path.join(ROOT, '.artifacts', 'i4-clean-machine-handoff-test'))
  assert.throws(() => parseHandoffArguments([
    '--installer', 'candidate.exe', '--layout', 'layout.json', '--output', '.'
  ]), /child of \.artifacts/)
})

test('I4 packaged PowerShell verifier rejects renamed runners and swapped path roles', (t) => {
  const validDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'i4-handoff-ps-valid-'))
  const renamedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'i4-handoff-ps-renamed-'))
  const swappedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'i4-handoff-ps-swapped-'))
  t.after(() => {
    for (const directory of [validDirectory, renamedDirectory, swappedDirectory]) {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  writeHandoffFixture(validDirectory)
  const valid = runPowerShellHandoffVerifier(validDirectory)
  assert.equal(valid.error, undefined)
  assert.equal(valid.status, 0, valid.stderr || valid.stdout)

  const renamed = writeHandoffFixture(renamedDirectory)
  const audioEntry = renamed.files.find((entry) => entry.role === 'audio-runner')
  fs.renameSync(
    path.join(renamedDirectory, ...audioEntry.relativePath.split('/')),
    path.join(renamedDirectory, 'runners', 'renamed-audio-runner.ps1'))
  audioEntry.relativePath = 'runners/renamed-audio-runner.ps1'
  fs.writeFileSync(path.join(renamedDirectory, 'handoff-manifest.json'), JSON.stringify(renamed) + '\n')
  const renamedResult = runPowerShellHandoffVerifier(renamedDirectory)
  assert.notEqual(renamedResult.status, 0)
  assert.match(`${renamedResult.stdout}\n${renamedResult.stderr}`, /allowlist|unexpected path/i)

  const swapped = writeHandoffFixture(swappedDirectory)
  const swappedAudio = swapped.files.find((entry) => entry.role === 'audio-runner')
  const swappedNonAudio = swapped.files.find((entry) => entry.role === 'non-audio-runner')
  swappedAudio.role = 'non-audio-runner'
  swappedNonAudio.role = 'audio-runner'
  fs.writeFileSync(path.join(swappedDirectory, 'handoff-manifest.json'), JSON.stringify(swapped) + '\n')
  const swappedResult = runPowerShellHandoffVerifier(swappedDirectory)
  assert.notEqual(swappedResult.status, 0)
  assert.match(`${swappedResult.stdout}\n${swappedResult.stderr}`, /allowlist|unexpected path/i)
})

test('I4 clean-machine runners remain operator-driven and contain no product test backdoor', () => {
  const audioRunner = fs.readFileSync(path.join(ROOT, 'scripts', 'qualify-i4-audio-child.ps1'), 'utf8')
  const nonAudioRunner = fs.readFileSync(
    path.join(ROOT, 'scripts', 'qualify-i4-nonaudio-nsis.ps1'), 'utf8')
  const handoffVerifier = fs.readFileSync(
    path.join(ROOT, 'scripts', 'verify-i4-clean-machine-handoff.ps1'), 'utf8')
  assert.match(audioRunner, /Start-Process/)
  assert.match(audioRunner, /PERMISSION-DENIED/)
  assert.match(audioRunner, /SOURCE-JOURNEY/)
  assert.match(audioRunner, /Security\.Cryptography\.SHA256/)
  assert.doesNotMatch(audioRunner, /Get-FileHash/)
  assert.match(nonAudioRunner, /Security\.Cryptography\.SHA256/)
  assert.doesNotMatch(nonAudioRunner, /Get-FileHash/)
  assert.match(handoffVerifier, /Security\.Cryptography\.SHA256/)
  assert.doesNotMatch(handoffVerifier, /Get-FileHash/)
  assert.match(audioRunner, /SQLite format 3/)
  assert.match(audioRunner, /\$Source -ceq 'loopback'/)
  assert.doesNotMatch(audioRunner, /SendKeys|UIAutomation|taskkill|Stop-Process|--test-main|node\.exe/i)
  assert.match(handoffVerifier, /repository or Node runtime/i)
  assert.doesNotMatch(handoffVerifier, /GetRelativePath/)
})
