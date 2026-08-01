'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  TRANSPORT_FIELDS,
  buildDwmProgress,
  buildInteractionReport,
  parseArguments,
  parseOperatorCompletion,
  transportDelta,
  transportSnapshot,
  validateDwmProgress,
  validateInteractionReport
} = require('../../scripts/i2-interaction-protocol')
const { validateInteractionEvidence } = require('../../scripts/verify-i2-interaction-report')
const { completionPath } = require('../../scripts/complete-i2-dwm-drag')
const { assertDistinctOutputPaths, stimulusPathForScenario } = require('../../scripts/i2-live-interaction')

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
      : { mode: 'manual-dwm-harness', rendererAssets: 'caption-toolbar', manualSetBounds: true, operatorCompletionObserved: true }
  return buildInteractionReport({
    executedAt: '2026-08-01T12:00:00.000Z',
    scenario,
    sourceId: 'loopback',
    result: scenario === 'dwm-drag' ? 'pass-manual-observed' : result,
    runtime: { modelId: 'x-asr-160ms', profile: 'fast', vad: 'silero', refinement: 'x-asr-offline', sqliteSessionRecorder: true },
    counts: { captions: 3, partials: 1, finals: 1, refined: 1 },
    scenarioEvidence,
    transport: {
      comparison: scenario === 'worker-crash-retry' ? 'cross-recovery-generation' : 'same-capture-generation',
      before,
      after,
      delta: scenario === 'worker-crash-retry' ? null : transportDelta(before, after, true)
    },
    deviceRecovery: {
      simulatedTrackEnded: false,
      actualOsDeviceRemoval: false,
      actualSystemSleepWake: false,
      networkRecoveryNotApplicable: true
    }
  })
}

test('interaction argument parser requires explicit source, scenario, mic preflight and DWM hand-off files', () => {
  assert.deepEqual(parseArguments([
    '--scenario', 'pause-refine', '--source', 'loopback', '--report', '.artifacts/i2/report.json'
  ]), {
    scenario: 'pause-refine', source: 'loopback', report: '.artifacts/i2/report.json', progress: null,
    completion: null, physicalMicPreflight: null, timeoutSeconds: 90
  })
  assert.throws(() => parseArguments([
    '--scenario', 'dwm-drag', '--source', 'loopback', '--report', '.artifacts/i2/report.json'
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
    assert.equal(validateInteractionReport(report, scenario), report)
    assert.equal(validateInteractionEvidence(Buffer.from(JSON.stringify(report)), scenario).scenario, scenario)
  }

  const claimedDeviceRemoval = reportFor('pause-refine')
  claimedDeviceRemoval.deviceRecovery.actualOsDeviceRemoval = true
  assert.throws(() => validateInteractionReport(claimedDeviceRemoval), /actualOsDeviceRemoval/)

  const fakeText = reportFor('pause-refine')
  fakeText.scenarioEvidence.captionText = '不得出现在报告中'
  assert.throws(() => validateInteractionReport(fakeText), /captionText|unknown fields/)

  const crossGenerationDelta = reportFor('worker-crash-retry')
  crossGenerationDelta.transport.delta = transport(1)
  assert.throws(() => validateInteractionReport(crossGenerationDelta), /cross-generation/)
})

test('DWM progress and completion files are bounded, text-free hand-off evidence', () => {
  const before = transport(2)
  const after = transport(5)
  const progress = buildDwmProgress({
    sourceId: 'loopback',
    state: 'completed',
    operatorCompletionObserved: true,
    transport: {
      comparison: 'same-capture-generation', before, after, delta: transportDelta(before, after, true)
    }
  })
  assert.equal(validateDwmProgress(progress), progress)
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
  assert.throws(() => parseOperatorCompletion(Buffer.from(JSON.stringify({
    schemaVersion: 1,
    kind: 'i2-dwm-drag-operator-completion',
    scenario: 'dwm-drag',
    observed: false
  }))), /observed=true/)
  assert.match(completionPath('.artifacts/i2-interaction/dwm.completion.json'), /\.artifacts[\\/]i2-interaction/)
  assert.throws(() => completionPath('../outside.json'), /under \.artifacts/)
})
