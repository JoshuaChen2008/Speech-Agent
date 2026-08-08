'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  DWM_OBSERVATION_IDS,
  RECOVERY_FAULT_CODES,
  RECOVERY_SCENARIOS,
  TRANSPORT_FIELDS,
  buildDwmProgress,
  buildInteractionReport,
  buildRecoveryProgress,
  completeDwmChecks,
  dwmOperatorCompletion,
  parseArguments,
  parseOperatorCompletion,
  parseRecoveryOperatorCompletion,
  recoveryOperatorCompletion,
  transportDelta,
  transportSnapshot,
  validateDwmProgress,
  validateInteractionReport,
  validateRecoveryProgress
} = require('../../scripts/i2-interaction-protocol')
const { computeProductPayloadIdentity } = require('../../src/main/services/product-payload-identity')
const crypto = require('node:crypto')
const {
  validateDwmCompanion,
  validateInteractionEvidence
} = require('../../scripts/verify-i2-interaction-report')
const {
  completionPath,
  parseArguments: parseDwmCompletionArguments,
  writeCompletion: writeDwmCompletion
} = require('../../scripts/complete-i2-dwm-drag')
const {
  parseArguments: parseRecoveryCompletionArguments,
  writeCompletion: writeRecoveryCompletion
} = require('../../scripts/complete-i2-recovery-action')
const { assertDistinctOutputPaths, stimulusPathForScenario } = require('../../scripts/i2-live-interaction')

const PRODUCT_IDENTITY = computeProductPayloadIdentity()

function completeDwmScenarioEvidence () {
  return {
    mode: 'production-dwm-harness',
    rendererAssets: 'caption-toolbar-settings-history',
    manualSetBounds: true,
    runBindingSha256: 'b'.repeat(64),
    operatorCompletionObserved: true,
    operatorCompletionSha256: 'c'.repeat(64),
    combination: { scalePercent: 100, theme: 'dark' },
    checks: completeDwmChecks(),
    crossScale: { observed: false, criticalHitMatrixRepeated: false },
    productPayloadVersion: PRODUCT_IDENTITY.version,
    productPayloadFileCount: PRODUCT_IDENTITY.fileCount,
    productPayloadSha256: PRODUCT_IDENTITY.sha256,
    productionReuse: {
      interactionController: true,
      windowLayerController: true,
      ipcAccessPolicy: true,
      windowRoles: ['caption', 'toolbar', 'settings', 'history'],
      preloadRoles: ['caption', 'toolbar', 'settings', 'history'],
      pageRoles: ['caption', 'toolbar', 'settings', 'history'],
      mainProcessManualBoundsUpdates: true
    },
    automaticObservation: {
      actualScaleMatched: true,
      systemThemeMatched: true,
      rendererScaleMatched: true,
      displayCount: 1,
      distinctScaleFactorCount: 1,
      crossScaleMoveObserved: false,
      fromScalePercent: 100,
      toScalePercent: 100
    },
    controllerCounts: {
      windowLoadCount: 4,
      toolbarLayoutReportCount: 3,
      captionDragStartCount: 5,
      captionMovedDragCount: 4,
      captionStationaryPressReleaseCount: 1,
      toolbarGripDragStartCount: 2,
      resizeStartCount: 8,
      settingsTitlebarDragStartCount: 1,
      historyTitlebarDragStartCount: 1,
      lockTransitionCount: 2,
      focusPromotionCount: 2,
      focusDemotionCount: 2
    }
  }
}

function transport (capturedFrames = 10) {
  const value = Object.fromEntries(TRANSPORT_FIELDS.map((field) => [field, 0]))
  value.capturedFrames = capturedFrames
  value.sentFrames = capturedFrames
  value.ingestedFrames = capturedFrames
  value.acknowledgedFrames = capturedFrames
  return value
}

function reportFor (scenario, result = 'pass') {
  const before = transport(4)
  const after = transport(10)
  const recovery = RECOVERY_SCENARIOS.includes(scenario)
  const scenarioEvidence = scenario === 'pause-refine'
    ? {
        pauseAcknowledged: true, resumeAcknowledged: true, finalBeforePause: 1,
        refinementPendingAtPause: 1, refinedWhilePaused: 0, refinedAfterResume: 1
      }
    : scenario === 'worker-crash-retry'
      ? {
          crashMethod: 'forced-exact-realtime-worker-termination', workerExitObserved: true, retrySucceeded: true,
          sameSession: true, runtimeAdapterReusedAfterRetry: true, freshWorkerGenerationAfterRetry: true,
          workerGenerationCount: 2, finalBeforeCrash: 1, finalAfterRetry: 1
        }
      : recovery
        ? {
            faultCodeObserved: RECOVERY_FAULT_CODES[scenario], faultPhaseObserved: true,
            captureReleased: true, operatorCompletionObserved: true,
            systemResumeEventObserved: scenario === 'sleep-wake-retry',
            workerGenerationCountAtFault: 1, workerGenerationCountBeforeRetry: 1,
            workerGenerationCountAfterRetry: 2, noAutomaticReacquire: true,
            explicitRetryIssued: true, retrySucceeded: true, sameSession: true,
            runtimeAdapterReusedAfterRetry: true, freshWorkerGenerationAfterRetry: true,
            captionsBeforeFault: 3, captionsAfterRetry: 3, finalBeforeFault: 1, finalAfterRetry: 1,
            maxSequenceBeforeFault: 3, firstSequenceAfterRetry: 4, sequenceStrictlyIncreased: true,
            sqliteSessionClosed: true, sqliteSourceMatched: true, sqlitePersistedSegmentCount: 2,
            sqlitePersistedAtLeastObservedFinals: true
          }
        : completeDwmScenarioEvidence()
  return buildInteractionReport({
    executedAt: '2026-08-01T12:00:00.000Z',
    scenario,
    sourceId: 'loopback',
    result: scenario === 'dwm-drag' ? 'pass-manual-observed' : result,
    runtime: { modelId: 'x-asr-160ms', profile: 'fast', vad: 'silero', refinement: 'x-asr-offline', sqliteSessionRecorder: true },
    counts: { captions: 3, partials: 1, finals: 1, refined: 1 },
    scenarioEvidence,
    transport: {
      comparison: scenario === 'worker-crash-retry' || recovery ? 'cross-recovery-generation' : 'same-capture-generation',
      before,
      after,
      delta: scenario === 'worker-crash-retry' || recovery ? null : transportDelta(before, after, true)
    },
    deviceRecovery: {
      simulatedTrackEnded: false,
      actualOsDeviceRemoval: scenario === 'device-removal-retry',
      actualSystemSleepWake: scenario === 'sleep-wake-retry',
      networkRecoveryNotApplicable: true
    }
  })
}

test('interaction argument parser requires explicit source, scenario, mic preflight and operator hand-off files', () => {
  assert.deepEqual(parseArguments([
    '--scenario', 'pause-refine', '--source', 'loopback', '--report', '.artifacts/i2/report.json'
  ]), {
    scenario: 'pause-refine', source: 'loopback', report: '.artifacts/i2/report.json', progress: null,
    completion: null, physicalMicPreflight: null, scalePercent: null, theme: null,
    crossScaleFromPercent: null, timeoutSeconds: 90
  })
  assert.throws(() => parseArguments([
    '--scenario', 'dwm-drag', '--source', 'loopback', '--report', '.artifacts/i2/report.json'
  ]), /progress and --completion/)
  assert.deepEqual(parseArguments([
    '--scenario', 'device-removal-retry', '--source', 'loopback',
    '--report', '.artifacts/i2/report.json', '--progress', '.artifacts/i2/progress.json',
    '--completion', '.artifacts/i2/completion.json'
  ]), {
    scenario: 'device-removal-retry', source: 'loopback', report: '.artifacts/i2/report.json',
    progress: '.artifacts/i2/progress.json', completion: '.artifacts/i2/completion.json',
    physicalMicPreflight: null, scalePercent: null, theme: null, crossScaleFromPercent: null,
    timeoutSeconds: 90
  })
  assert.throws(() => parseArguments([
    '--scenario', 'sleep-wake-retry', '--source', 'loopback', '--report', '.artifacts/i2/report.json',
    '--progress', '.artifacts/i2/progress.json'
  ]), /progress and --completion/)
  assert.throws(() => parseArguments([
    '--scenario', 'pause-refine', '--source', 'mic', '--report', '.artifacts/i2/report.json'
  ]), /physical-mic-preflight/)
  assert.throws(() => parseArguments([
    '--scenario', 'worker-crash-retry', '--source', 'loopback', '--report', '.artifacts/i2/report.json', '--bogus', 'x'
  ]), /Unknown argument/)
})

test('interaction runner rejects colliding output hand-off paths before Electron is started', () => {
  assert.doesNotThrow(() => assertDistinctOutputPaths([
    'D:/A1Project/Speech-Agent2.0/.artifacts/i2/report.json',
    'D:/A1Project/Speech-Agent2.0/.artifacts/i2/progress.json',
    'D:/A1Project/Speech-Agent2.0/.artifacts/i2/completion.json'
  ]))
  assert.throws(() => assertDistinctOutputPaths([
    'D:/A1Project/Speech-Agent2.0/.artifacts/i2/report.json',
    'd:/a1project/speech-agent2.0/.artifacts/i2/REPORT.json'
  ]), /must be distinct/)
})

test('pause/refine runner chooses the short controlled audio smoke without timing a final by wall clock', () => {
  assert.match(stimulusPathForScenario('pause-refine'), /zh-roadmap\.wav$/)
  assert.match(stimulusPathForScenario('worker-crash-retry'), /zh-en-code-switch\.wav$/)
})

test('transport snapshots expose only counters and same-generation deltas retain queue decreases', () => {
  const snapshot = transportSnapshot({
    capture: {
      loopback: {
        capturedFrames: 11, sentFrames: 11, droppedFrames: 0, creditStalls: 2,
        maxQueuedMsObserved: 100, acknowledgedFrames: 10, lostInFlightFrames: 0,
        portReplacements: 0, queuedFrames: 1, queuedMs: 100, discardedAtStop: 0,
        deviceName: 'must not survive'
      }
    },
    worker: {
      sources: { loopback: { framesIngested: 11, sequenceGapCount: 0, missedFrames: 0 } },
      badSampleTypeFrames: 0
    },
    droppedCaptionCount: 0
  }, 'loopback')
  assert.equal(snapshot.capturedFrames, 11)
  assert.equal(snapshot.ingestedFrames, 11)
  assert.equal(Object.hasOwn(snapshot, 'deviceName'), false)
  const after = { ...snapshot, queuedFramesAtStop: 0, queuedMsAtStop: 0, capturedFrames: 12, sentFrames: 12, ingestedFrames: 12 }
  const delta = transportDelta(snapshot, after, true)
  assert.equal(delta.queuedFramesAtStop, -1)
  assert.equal(delta.capturedFrames, 1)
  assert.equal(transportDelta(snapshot, after, false), null)
})

test('strict verifier accepts automated and manual interaction reports but rejects evidence that overclaims device actions', () => {
  for (const scenario of ['pause-refine', 'worker-crash-retry', 'dwm-drag']) {
    const report = reportFor(scenario)
    assert.equal(report.schemaVersion, scenario === 'dwm-drag' ? 3 : 1)
    assert.equal(validateInteractionReport(report, scenario), report)
    assert.equal(validateInteractionEvidence(Buffer.from(JSON.stringify(report)), scenario).scenario, scenario)
  }

  for (const scenario of RECOVERY_SCENARIOS) {
    const report = reportFor(scenario)
    assert.equal(report.schemaVersion, 2)
    assert.equal(validateInteractionReport(report, scenario), report)
    assert.equal(validateInteractionEvidence(Buffer.from(JSON.stringify(report)), scenario).scenario, scenario)
  }

  const claimedDeviceRemoval = reportFor('pause-refine')
  claimedDeviceRemoval.deviceRecovery.actualOsDeviceRemoval = true
  assert.throws(() => validateInteractionReport(claimedDeviceRemoval), /true !== false/)

  const fakeText = reportFor('pause-refine')
  fakeText.scenarioEvidence.captionText = '不得出现在报告中'
  assert.throws(() => validateInteractionReport(fakeText), /captionText|unknown fields/)

  const crossGenerationDelta = reportFor('worker-crash-retry')
  crossGenerationDelta.transport.delta = transport(1)
  assert.throws(() => validateInteractionReport(crossGenerationDelta), /cross-generation/)
})

test('SEM-F22/J17/I2: schema-v3 DWM evidence requires the complete unique observation matrix and current product hash', () => {
  const report = reportFor('dwm-drag')
  assert.equal(report.schemaVersion, 3)
  assert.deepEqual(validateInteractionEvidence(Buffer.from(JSON.stringify(report)), 'dwm-drag'), report)

  const completionOnly = structuredClone(report)
  completionOnly.scenarioEvidence.productionReuse.interactionController = false
  assert.throws(() => validateInteractionReport(completionOnly), /interactionController|true/)

  const missing = structuredClone(report)
  delete missing.scenarioEvidence.checks.caption.leftImmediateContinuousDrag
  assert.throws(() => validateInteractionReport(missing), /missing|unknown fields/)

  const duplicate = structuredClone(report)
  duplicate.scenarioEvidence.checks.toolbarStates[1].state = 'quiet'
  assert.throws(() => validateInteractionReport(duplicate), /attention/)

  const unknown = structuredClone(report)
  unknown.scenarioEvidence.checks.resizeTargets[0].target = 'unknown-target'
  assert.throws(() => validateInteractionReport(unknown), /north-edge/)

  const overCount = structuredClone(report)
  overCount.scenarioEvidence.controllerCounts.windowLoadCount = 1000001
  assert.throws(() => validateInteractionReport(overCount), /windowLoadCount/)

  const staleCandidate = structuredClone(report)
  staleCandidate.scenarioEvidence.productPayloadSha256 = '0'.repeat(64)
  assert.throws(() => validateInteractionEvidence(Buffer.from(JSON.stringify(staleCandidate)), 'dwm-drag'), /product payload identity/)
})

test('recovery pass requires product-observed fault, release, no auto reacquire, Retry and persisted caption continuity', () => {
  const completionOnly = reportFor('device-removal-retry')
  completionOnly.scenarioEvidence.faultCodeObserved = null
  completionOnly.scenarioEvidence.faultPhaseObserved = false
  completionOnly.scenarioEvidence.captureReleased = false
  assert.throws(() => validateInteractionReport(completionOnly), /AUDIO_TRACK_ENDED|true/)

  const autoReacquire = reportFor('device-removal-retry')
  autoReacquire.scenarioEvidence.workerGenerationCountBeforeRetry = 2
  autoReacquire.scenarioEvidence.noAutomaticReacquire = false
  assert.throws(() => validateInteractionReport(autoReacquire), /auto-create|true/)

  const sequenceReset = reportFor('device-removal-retry')
  sequenceReset.scenarioEvidence.firstSequenceAfterRetry = 3
  assert.throws(() => validateInteractionReport(sequenceReset), /firstSequenceAfterRetry/)

  const missingResume = reportFor('sleep-wake-retry')
  missingResume.scenarioEvidence.systemResumeEventObserved = false
  assert.throws(() => validateInteractionReport(missingResume), /false !== true/)

  const sqliteGap = reportFor('device-removal-retry')
  sqliteGap.scenarioEvidence.sqlitePersistedSegmentCount = 1
  assert.throws(() => validateInteractionReport(sqliteGap), /sqlitePersistedSegmentCount/)

  const v1Recovery = reportFor('device-removal-retry')
  v1Recovery.schemaVersion = 1
  assert.throws(() => validateInteractionReport(v1Recovery), /schema v1 scenario/)

  const v2Legacy = reportFor('pause-refine')
  v2Legacy.schemaVersion = 2
  assert.throws(() => validateInteractionReport(v2Legacy), /schema v2 scenario/)
})

test('DWM progress and completion files are bounded, text-free hand-off evidence', () => {
  const before = transport(2)
  const after = transport(5)
  const progress = buildDwmProgress({
    sourceId: 'loopback',
    state: 'completed',
    operatorCompletionObserved: true,
    runBindingSha256: 'b'.repeat(64),
    productPayloadVersion: PRODUCT_IDENTITY.version,
    productPayloadFileCount: PRODUCT_IDENTITY.fileCount,
    productPayloadSha256: PRODUCT_IDENTITY.sha256,
    combination: { scalePercent: 100, theme: 'dark' },
    transport: {
      comparison: 'same-capture-generation', before, after, delta: transportDelta(before, after, true)
    }
  })
  assert.equal(validateDwmProgress(progress), progress)
  const completion = dwmOperatorCompletion({
    confirmations: DWM_OBSERVATION_IDS,
    runBindingSha256: 'b'.repeat(64),
    productPayloadVersion: PRODUCT_IDENTITY.version,
    productPayloadFileCount: PRODUCT_IDENTITY.fileCount,
    productPayloadSha256: PRODUCT_IDENTITY.sha256,
    combination: { scalePercent: 100, theme: 'dark' }
  })
  assert.deepEqual(parseOperatorCompletion(Buffer.from(JSON.stringify(completion))), completion)
  assert.equal(completion.schemaVersion, 3)
  assert.equal(completion.checks.resizeTargets.length, 8)

  assert.deepEqual(parseOperatorCompletion(Buffer.from(JSON.stringify({
    schemaVersion: 1,
    kind: 'i2-dwm-drag-operator-completion',
    scenario: 'dwm-drag',
    observed: true
  }))), {
    schemaVersion: 1,
    kind: 'i2-dwm-drag-operator-completion',
    scenario: 'dwm-drag',
    observed: true
  })
  assert.throws(() => dwmOperatorCompletion({
    confirmations: [...DWM_OBSERVATION_IDS.slice(1), DWM_OBSERVATION_IDS[1]]
  }), /missing|duplicate|observation/)
  assert.throws(() => parseOperatorCompletion(Buffer.from(JSON.stringify({
    schemaVersion: 1,
    kind: 'i2-dwm-drag-operator-completion',
    scenario: 'dwm-drag',
    observed: false
  }))), /observed=true/)
  assert.match(completionPath('.artifacts/i2-interaction/dwm.completion.json'), /\.artifacts[\\/]i2-interaction/)
  assert.throws(() => completionPath('../outside.json'), /under \.artifacts/)

  const bytes = Buffer.from(`${JSON.stringify(completion, null, 2)}\n`)
  const report = reportFor('dwm-drag')
  report.scenarioEvidence.operatorCompletionSha256 = crypto.createHash('sha256').update(bytes).digest('hex')
  assert.deepEqual(validateDwmCompanion(report, bytes), completion)

  const wrongBinding = structuredClone(completion)
  wrongBinding.runBindingSha256 = 'd'.repeat(64)
  assert.throws(() => validateDwmCompanion(report, Buffer.from(JSON.stringify(wrongBinding))), /strictEqual|Expected/)
})

test('DWM completion helper binds one explicit checklist to awaiting progress and writes once', () => {
  const root = `.artifacts/i2-dwm-completion-contract-${process.pid}-${Date.now()}`
  const options = parseDwmCompletionArguments([
    '--progress', `${root}/progress.json`, '--completion', `${root}/completion.json`
  ])
  const before = transport(2)
  const progress = buildDwmProgress({
    sourceId: 'loopback',
    state: 'awaiting-operator-completion',
    operatorCompletionObserved: false,
    runBindingSha256: 'b'.repeat(64),
    productPayloadVersion: PRODUCT_IDENTITY.version,
    productPayloadFileCount: PRODUCT_IDENTITY.fileCount,
    productPayloadSha256: PRODUCT_IDENTITY.sha256,
    combination: { scalePercent: 100, theme: 'dark' },
    transport: {
      comparison: 'same-capture-generation',
      before,
      after: before,
      delta: transportDelta(before, before, true)
    }
  })
  try {
    const completion = writeDwmCompletion({
      completion: options.completion,
      progress,
      confirmations: DWM_OBSERVATION_IDS,
      crossScaleObserved: false
    })
    assert.deepEqual(parseOperatorCompletion(fs.readFileSync(options.completion)), completion)
    assert.throws(() => writeDwmCompletion({
      completion: options.completion,
      progress,
      confirmations: DWM_OBSERVATION_IDS
    }), /refusing to overwrite/)
  } finally {
    fs.rmSync(path.dirname(options.completion), { recursive: true, force: true })
  }
})

test('recovery progress and completion are bounded attestations that cannot name devices or carry caption text', () => {
  for (const scenario of RECOVERY_SCENARIOS) {
    const progress = buildRecoveryProgress({
      scenario,
      sourceId: 'loopback',
      state: 'completed',
      faultCodeObserved: RECOVERY_FAULT_CODES[scenario],
      captureReleased: true,
      automaticReacquireObserved: false,
      operatorCompletionObserved: true,
      retryIssued: true,
      captionsAfterRetry: 2
    })
    assert.equal(validateRecoveryProgress(progress), progress)

    const completion = recoveryOperatorCompletion({ scenario })
    assert.deepEqual(parseRecoveryOperatorCompletion(
      Buffer.from(JSON.stringify(completion)), scenario
    ), completion)
  }

  const wrongAction = recoveryOperatorCompletion({ scenario: 'device-removal-retry' })
  wrongAction.action = 'system-resumed-after-sleep'
  assert.throws(() => parseRecoveryOperatorCompletion(Buffer.from(JSON.stringify(wrongAction))), /system-resumed-after-sleep/)

  const namedDevice = recoveryOperatorCompletion({ scenario: 'device-removal-retry' })
  namedDevice.deviceName = 'forbidden'
  assert.throws(() => parseRecoveryOperatorCompletion(Buffer.from(JSON.stringify(namedDevice))), /deviceName|forbidden sensitive field/)

  const captionText = buildRecoveryProgress({
    scenario: 'device-removal-retry', sourceId: 'loopback', state: 'starting'
  })
  captionText.captionText = '不得出现在报告中'
  assert.throws(() => validateRecoveryProgress(captionText), /captionText|forbidden sensitive field/)
})

test('recovery completion helper writes once under .artifacts and rejects paths outside the evidence root', () => {
  const relativeRoot = `.artifacts/i2-recovery-completion-contract-${process.pid}-${Date.now()}`
  const relativeCompletion = `${relativeRoot}/completion.json`
  const options = parseRecoveryCompletionArguments([
    '--scenario', 'device-removal-retry', '--completion', relativeCompletion
  ])
  assert.match(options.completion, /[\\/]\.artifacts[\\/]i2-recovery-completion-contract-/)
  try {
    const written = writeRecoveryCompletion(options)
    assert.deepEqual(parseRecoveryOperatorCompletion(fs.readFileSync(options.completion), options.scenario), written)
    assert.throws(() => writeRecoveryCompletion(options), /refusing to overwrite/)
  } finally {
    fs.rmSync(path.dirname(options.completion), { recursive: true, force: true })
  }
  assert.throws(() => parseRecoveryCompletionArguments([
    '--scenario', 'sleep-wake-retry', '--completion', '../outside.json'
  ]), /under \.artifacts/)
})

test('recovery runner listens to real fault and resume boundaries and issues explicit Retry without event simulation', () => {
  const runner = fs.readFileSync(path.resolve(__dirname, '../../scripts/i2-live-interaction.js'), 'utf8')
  const powershell = fs.readFileSync(path.resolve(__dirname, '../../scripts/run-i2-interaction.ps1'), 'utf8')
  assert.match(runner, /new PowerSessionGuard/)
  assert.match(runner, /powerMonitor\.on\('resume'/)
  assert.match(runner, /coordinator\.command\('retry'\)/)
  assert.match(runner, /getSessionTranscript\(sessionId\)/)
  assert.match(runner, /getLiveDiagnostics\(\) === null/)
  assert.doesNotMatch(runner, /powerMonitor\.emit\(|simulatedTrackEnded\s*:\s*true/)
  assert.match(powershell, /complete-i2-recovery-action\.js/)
})
