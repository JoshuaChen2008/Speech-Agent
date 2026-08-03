'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { PRODUCTION_MODEL_MANIFEST } = require('../../src/main/services/model-manifest')
const I3_STIMULUS_DEFINITION = require('../../scripts/i3-live-stimulus.json')
const ROOT = path.resolve(__dirname, '../..')

const {
  DEFAULT_DURATION_SECONDS,
  MIN_ACCEPTANCE_WALL_DURATION_MS,
  MIN_FINAL_SEGMENTS,
  MIN_QUALIFICATION_FINAL_SEGMENTS,
  MIN_QUALIFICATION_POST_RECOVERY_FINAL_SEGMENTS,
  MIN_QUALIFICATION_PRE_RECOVERY_FINAL_SEGMENTS,
  PLAYBACK_SCHEDULE_LEAD_MS,
  PROVENANCE_FILES,
  QUALIFICATION_CRASH_TARGET_MS,
  QUALIFICATION_DURATION_SECONDS,
  SOAK_LIMITS,
  buildI3CoordinatorSessionOptions,
  buildSyntheticFixtureReport,
  currentProvenance,
  forceRealtimeWorkerCrashAndRetry,
  internalSeedArguments,
  parseArguments,
  resolveAuditedModels
} = require('../../scripts/i3-live-audio-soak')

test('I3 public arguments bypass the closed internal recovery-seed parser', () => {
  assert.equal(internalSeedArguments([
    '--mode', 'qualification', '--source', 'loopback', '--report', '.artifacts/i3.json'
  ]), null)
  assert.deepEqual(internalSeedArguments([
    '--internal-recovery-seed', '--database-path', '.artifacts/data.sqlite3',
    '--seed-path', '.artifacts/seed.json', '--session-id', 'session-1'
  ]), {
    internal: true,
    databasePath: '.artifacts/data.sqlite3',
    seedPath: '.artifacts/seed.json',
    sessionId: 'session-1'
  })
  assert.throws(() => internalSeedArguments([
    '--internal-recovery-seed', '--source', 'loopback'
  ]), /unknown internal argument/)
})

test('I3 wrapper keeps its required status BrowserWindow interactive', () => {
  const wrapper = fs.readFileSync(path.resolve(__dirname, '../../scripts/run-i3-live-audio-soak.ps1'), 'utf8')
  assert.doesNotMatch(wrapper, /-WindowStyle\s+Hidden/)
})

test('I3 实机来源资格的每个文本 provenance 输入固定 LF', () => {
  const attributes = new Set(fs.readFileSync(path.resolve(ROOT, '.gitattributes'), 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean))
  for (const relativePath of Object.values(PROVENANCE_FILES)) {
    const exactRule = `${relativePath} text eol=lf`
    const coveredByProductRule = relativePath.startsWith('src/') && relativePath.endsWith('.js') &&
      attributes.has('src/**/*.js text eol=lf')
    assert.equal(
      attributes.has(exactRule) || coveredByProductRule,
      true,
      `${relativePath} must be pinned to LF before its exact SHA is compared across checkouts`
    )
  }
})

test('I3 real-audio runner freezes the approved refinement model in both session inputs', () => {
  const model = { id: 'x-asr-160ms', profile: 'balanced' }
  for (const source of ['loopback', 'mic']) {
    const enabled = buildI3CoordinatorSessionOptions({
      source,
      model,
      refinementModel: { id: 'x-asr-offline' }
    })
    assert.equal(enabled.configuration.refinementEnabled, true)
    assert.equal(enabled.runtimeOptions.refinementAvailable, true)
    assert.deepEqual(enabled.runtimeOptions.modelOverride, {
      developmentOnly: false,
      id: model.id,
      profile: model.profile
    })

    const unavailable = buildI3CoordinatorSessionOptions({ source, model, refinementModel: null })
    assert.equal(unavailable.configuration.refinementEnabled, false)
    assert.equal(unavailable.runtimeOptions.refinementAvailable, false)
  }
})

test('I3 switches post-recovery caption generation before retry completion is reported', async () => {
  const order = []
  let snapshot = {
    phase: 'error',
    lastError: { code: 'REALTIME_WORKER_EXITED', scope: 'worker' }
  }
  const result = await forceRealtimeWorkerCrashAndRetry({
    coordinator: {
      command: async (command) => {
        assert.equal(command, 'retry')
        order.push('retry-command')
        snapshot = { phase: 'listening', lastError: null }
        return { ok: true }
      },
      getSnapshot: () => snapshot
    },
    elapsedWallMs: 30000,
    onProgress: (_phase, _elapsed, status) => order.push(status),
    onRecovered: () => order.push('generation-switched'),
    runtimeAdapter: {
      session: { worker: { terminateAndWait: async () => order.push('worker-terminated') } }
    }
  })
  assert.deepEqual(result, { errorObserved: true, retrySucceeded: true, workerExitForced: true })
  assert.deepEqual(order, [
    'requested', 'worker-terminated', 'observed', 'retry-command', 'generation-switched', 'recovered'
  ])
})
const {
  readAndValidateI3LiveAudioReport,
  readAndValidateI3LiveAudioQualificationReport,
  validateI3LiveAudioQualificationReport,
  validateI3LiveAudioReport
} = require('../../scripts/verify-i3-live-audio-report')

test('revision 82d56f6 的 loopback 资格报告严格闭合且保持 partial', () => {
  const attributes = fs.readFileSync(path.resolve(ROOT, '.gitattributes'), 'utf8')
  assert.match(
    attributes,
    /^docs\/validation\/i3-live-82d56f6-loopback-qualification\/report\.json text eol=lf$/m
  )
  const reportPath = path.resolve(
    ROOT,
    'docs/validation/i3-live-82d56f6-loopback-qualification/report.json'
  )
  const bytes = fs.readFileSync(reportPath)
  assert.equal(
    crypto.createHash('sha256').update(bytes).digest('hex'),
    '0c219b9627618cdda12ad41ae77093fd5f7bcccbe30b042c1c9cad2958d702f4'
  )

  const report = readAndValidateI3LiveAudioQualificationReport(reportPath)
  assert.equal(report.gateStatus, 'partial')
  assert.equal(report.metrics.measuredListeningWallDurationMs, 75540.785)
  assert.deepEqual({
    preRecoveryFinalSegments: report.metrics.preRecoveryFinalSegments,
    postRecoveryFinalSegments: report.metrics.postRecoveryFinalSegments,
    finalSegments: report.metrics.finalSegments,
    refinedSegments: report.metrics.refinedSegments
  }, {
    preRecoveryFinalSegments: 14,
    postRecoveryFinalSegments: 17,
    finalSegments: 31,
    refinedSegments: 29
  })
  assert.equal(Object.values(report.checks).every(Boolean), true)
  assert.deepEqual(report.privacy, {
    capturedAudioPersisted: false,
    reportContainsAbsolutePath: false,
    reportContainsTranscriptText: false
  })
})

function passingReport () {
  const manifestSha = Object.fromEntries(PRODUCTION_MODEL_MANIFEST.artifacts.map((artifact) => [artifact.id, artifact.sha256]))
  return {
    boundaries: {
      actualElectronBrowserWindow: true,
      actualRealtimeAudioPipeline: true,
      actualSqliteStorage: true,
      controlledSpeakerPlayback: true,
      syntheticFixture: false,
      wallClockTwoHourRun: true
    },
    checks: {
      actualWallClockTwoHours: true,
      audioArtifactsAbsent: true,
      captionsPersisted: true,
      exportsComplete: true,
      historyPaginationComplete: true,
      nativeWindowDragObserved: true,
      noCapturePersisted: true,
      realBrowserWindowLongLived: true,
      refinedObservedWhenEnabled: true,
      resourceBounds: true,
      sqliteIntegrity: true,
      storageRecoveryAfterForcedMainExit: true,
      transportHealthy: true,
      workerCrashRecovered: true
    },
    crashRecovery: {
      recoveredSessionCount: 1,
      recoveredSessionTerminal: true,
      recoveryStatus: 'committed',
      separateMainProcessForcedExit: true
    },
    environment: { electron: '43.2.0', node: '22.16.0' },
    exports: {
      markdown: { bytes: 20, recordCount: MIN_FINAL_SEGMENTS, sha256: '1'.repeat(64) },
      srt: { bytes: 20, recordCount: MIN_FINAL_SEGMENTS, sha256: '2'.repeat(64) },
      text: { bytes: 20, recordCount: MIN_FINAL_SEGMENTS, sha256: '3'.repeat(64) }
    },
    generatedAt: '2026-08-01T00:00:00.000Z',
    kind: 'i3-live-audio-soak',
    limits: SOAK_LIMITS,
    model: {
      realtime: { artifactId: 'x-asr-160ms', manifestSha256: manifestSha['x-asr-160ms'], markerSha256: '7'.repeat(64) },
      refinement: { artifactId: 'x-asr-offline', manifestSha256: manifestSha['x-asr-offline'], markerSha256: '9'.repeat(64) },
      vad: { artifactId: 'silero-vad', manifestSha256: manifestSha['silero-vad'], markerSha256: 'b'.repeat(64) }
    },
    metrics: {
      captionEvents: MIN_FINAL_SEGMENTS * 2,
      finalSegments: MIN_FINAL_SEGMENTS,
      historyPageCount: 60,
      historyPageP95Ms: 12,
      historySegmentCount: MIN_FINAL_SEGMENTS,
      measuredListeningWallDurationMs: MIN_ACCEPTANCE_WALL_DURATION_MS,
      playbackCycles: 700,
      postRecoveryFinalSegments: 1,
      postRecoveryPlaybackCycles: 1,
      preRecoveryFinalSegments: MIN_FINAL_SEGMENTS - 1,
      refinedSegments: 1,
      resource: {
        appCpuP95Percent: 1,
        appWorkingSetMiBMax: 100,
        maxGatewayQueueDepth: 3,
        maxProcessCount: 6,
        sampleCount: SOAK_LIMITS.minResourceSamples
      },
      sqliteCaptionEvents: MIN_FINAL_SEGMENTS * 2,
      sqliteSegments: MIN_FINAL_SEGMENTS
    },
    mode: 'acceptance',
    privacy: {
      capturedAudioPersisted: false,
      reportContainsAbsolutePath: false,
      reportContainsTranscriptText: false
    },
    progress: {
      soakId: 'a'.repeat(24),
      statusWindowDragRequired: true,
      workerCrashInjectionRequired: true
    },
    provenance: currentProvenance(),
    result: 'pass',
    schemaVersion: 1,
    stimulus: {
      cycleDurationMs: I3_STIMULUS_DEFINITION.sliceLengthMs + I3_STIMULUS_DEFINITION.silenceDurationMs,
      derivedWavSha256: I3_STIMULUS_DEFINITION.expectedDerivedWavSha256,
      referenceSha256: I3_STIMULUS_DEFINITION.referenceSha256,
      scheduleLeadMs: PLAYBACK_SCHEDULE_LEAD_MS,
      silenceDurationMs: I3_STIMULUS_DEFINITION.silenceDurationMs,
      sliceLeadingSilenceMs: I3_STIMULUS_DEFINITION.sliceLeadingSilenceMs,
      sliceLengthMs: I3_STIMULUS_DEFINITION.sliceLengthMs,
      sliceSampleCount: (I3_STIMULUS_DEFINITION.sliceLengthMs * I3_STIMULUS_DEFINITION.sampleRate) / 1000,
      sourceCorpusSha256: I3_STIMULUS_DEFINITION.sourceCorpus.sha256,
      sourceId: 'loopback',
      sourceReferenceSha256: I3_STIMULUS_DEFINITION.sourceCorpus.referenceSha256
    },
    transport: {
      forcedCrashGeneration: {
        acknowledgedFrames: 10,
        badSampleTypeFrames: 0,
        capturedFrames: 10,
        creditStalls: 0,
        droppedCaptionCount: 0,
        droppedFrames: 0,
        ingestedFrames: 10,
        lostInFlightFrames: 0,
        missedFrames: 0,
        portReplacements: 0,
        sentFrames: 10,
        sequenceGapCount: 0
      },
      postRecoveryGeneration: {
        acknowledgedFrames: 10,
        badSampleTypeFrames: 0,
        capturedFrames: 10,
        creditStalls: 0,
        droppedCaptionCount: 0,
        droppedFrames: 0,
        ingestedFrames: 10,
        lostInFlightFrames: 0,
        missedFrames: 0,
        portReplacements: 0,
        sentFrames: 10,
        sequenceGapCount: 0
      }
    },
    window: {
      heartbeatCount: 1440,
      nativeDragObserved: true,
      rendered: true,
      visibleAtCompletion: true
    }
  }
}

test('I3 live parser freezes acceptance at a true two-hour wall-clock duration', () => {
  assert.deepEqual(parseArguments([
    '--source', 'loopback', '--duration-seconds', String(DEFAULT_DURATION_SECONDS), '--report', 'report.json'
  ]), {
    artifactDirectory: null,
    keepArtifacts: false,
    modelUserData: null,
    mode: 'acceptance',
    physicalMicPreflight: null,
    progress: null,
    report: 'report.json',
    source: 'loopback',
    syntheticSegments: 12,
    durationSeconds: DEFAULT_DURATION_SECONDS
  })
  assert.throws(() => parseArguments([
    '--source', 'loopback', '--duration-seconds', '60', '--report', 'report.json'
  ]), /frozen at 7200/)
  assert.throws(() => parseArguments(['--source', 'mic', '--report', 'report.json']), /physical-mic-preflight is required/)
})

test('I3 scheduled playback retains explicit two-hour and qualification segment capacity', () => {
  const scheduledCycleMs = I3_STIMULUS_DEFINITION.sliceLengthMs +
    I3_STIMULUS_DEFINITION.silenceDurationMs + PLAYBACK_SCHEDULE_LEAD_MS
  assert.equal(PLAYBACK_SCHEDULE_LEAD_MS, 80)
  assert.ok(Math.floor(MIN_ACCEPTANCE_WALL_DURATION_MS / scheduledCycleMs) >= MIN_FINAL_SEGMENTS + 100)
  assert.equal(QUALIFICATION_DURATION_SECONDS, 75)
  assert.equal(QUALIFICATION_CRASH_TARGET_MS, 30000)
  assert.equal(MIN_QUALIFICATION_FINAL_SEGMENTS, 25)
  assert.equal(MIN_QUALIFICATION_PRE_RECOVERY_FINAL_SEGMENTS, 12)
  assert.equal(MIN_QUALIFICATION_POST_RECOVERY_FINAL_SEGMENTS, 8)
  assert.ok(Math.floor(QUALIFICATION_DURATION_SECONDS * 1000 / scheduledCycleMs) >= MIN_QUALIFICATION_FINAL_SEGMENTS + 9)
  assert.ok(QUALIFICATION_DURATION_SECONDS * 1000 - MIN_QUALIFICATION_FINAL_SEGMENTS * scheduledCycleMs >= 20500)
  assert.ok(Math.floor(QUALIFICATION_CRASH_TARGET_MS / scheduledCycleMs) >= MIN_QUALIFICATION_PRE_RECOVERY_FINAL_SEGMENTS)
  assert.ok(Math.floor((QUALIFICATION_DURATION_SECONDS * 1000 - QUALIFICATION_CRASH_TARGET_MS) / scheduledCycleMs) >=
    MIN_QUALIFICATION_POST_RECOVERY_FINAL_SEGMENTS)
})

function createModelReadinessFixture (userDataDir) {
  for (const artifact of PRODUCTION_MODEL_MANIFEST.artifacts) {
    const directory = artifact.directoryName
      ? path.join(userDataDir, 'models', artifact.id, artifact.directoryName)
      : path.join(userDataDir, 'models', artifact.id)
    fs.mkdirSync(directory, { recursive: true })
    for (const name of artifact.requiredFiles) fs.writeFileSync(path.join(directory, name), '')
    fs.writeFileSync(path.join(directory, '.ready.json'), JSON.stringify({
      artifactId: artifact.id,
      bytes: artifact.bytes,
      manifestVersion: PRODUCTION_MODEL_MANIFEST.version,
      sha256: artifact.sha256
    }))
  }
}

test('I3 只从工作区内受控模型就绪证明解析已批准资源，不依赖开发机模型目录', (t) => {
  const artifactRoot = path.join(ROOT, '.artifacts')
  fs.mkdirSync(artifactRoot, { recursive: true })
  const fixtureRoot = fs.mkdtempSync(path.join(artifactRoot, 'i3-model-readiness-fixture-'))
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }))
  createModelReadinessFixture(fixtureRoot)

  const models = resolveAuditedModels(fixtureRoot)
  assert.deepEqual(Object.fromEntries(Object.entries(models.evidence).map(([key, value]) => [key, value.artifactId])), {
    realtime: 'x-asr-160ms',
    refinement: 'x-asr-offline',
    vad: 'silero-vad'
  })
  assert.ok(models.model.modelDir.startsWith(fixtureRoot))
  assert.ok(models.refinement.modelDir.startsWith(fixtureRoot))
  assert.ok(models.vad.modelPath.startsWith(fixtureRoot))
  assert.throws(() => resolveAuditedModels(path.join(fixtureRoot, 'missing')), /APPROVED_REALTIME_MODEL_MISSING/)
  assert.throws(() => resolveAuditedModels('C:\\outside-model-root'), /project workspace/)
})

test('I3 qualification parser freezes a real-audio seventy-five-second probe and it remains partial', () => {
  const options = parseArguments([
    '--mode', 'qualification', '--source', 'loopback', '--duration-seconds', String(QUALIFICATION_DURATION_SECONDS), '--report', 'qualification.json'
  ])
  assert.equal(options.durationSeconds, QUALIFICATION_DURATION_SECONDS)
  assert.throws(() => parseArguments([
    '--mode', 'qualification', '--source', 'loopback', '--duration-seconds', '74', '--report', 'qualification.json'
  ]), /frozen at 75/)

  const report = passingReport()
  report.kind = 'i3-live-audio-qualification'
  report.mode = 'qualification'
  report.gateStatus = 'partial'
  report.boundaries.wallClockTwoHourRun = false
  report.checks = {
    audioArtifactsAbsent: true,
    captionsPersisted: true,
    controlledCycleBounded: true,
    exportsComplete: true,
    historyPaginationComplete: true,
    noCapturePersisted: true,
    postRecoveryFinalsPersisted: true,
    preRecoveryFinalsPersisted: true,
    realAudioDurationSeventyFiveSeconds: true,
    refinedObservedWhenEnabled: true,
    resourceBounds: true,
    sqliteIntegrity: true,
    storageRecoveryAfterForcedMainExit: true,
    transportHealthy: true,
    workerCrashRecovered: true
  }
  report.limits = {
    crashTargetSeconds: QUALIFICATION_CRASH_TARGET_MS / 1000,
    durationSeconds: QUALIFICATION_DURATION_SECONDS,
    maxHistoryPageP95Ms: SOAK_LIMITS.maxHistoryPageP95Ms,
    maxStimulusCycleDurationMs: SOAK_LIMITS.maxStimulusCycleDurationMs,
    minFinalSegments: MIN_QUALIFICATION_FINAL_SEGMENTS,
    minPostRecoveryFinalSegments: MIN_QUALIFICATION_POST_RECOVERY_FINAL_SEGMENTS,
    minPreRecoveryFinalSegments: MIN_QUALIFICATION_PRE_RECOVERY_FINAL_SEGMENTS,
    minResourceSamples: 30
  }
  report.metrics.finalSegments = MIN_QUALIFICATION_FINAL_SEGMENTS
  report.metrics.historySegmentCount = MIN_QUALIFICATION_FINAL_SEGMENTS
  report.metrics.sqliteSegments = MIN_QUALIFICATION_FINAL_SEGMENTS
  report.metrics.measuredListeningWallDurationMs = QUALIFICATION_DURATION_SECONDS * 1000
  report.metrics.preRecoveryFinalSegments = MIN_QUALIFICATION_FINAL_SEGMENTS - MIN_QUALIFICATION_POST_RECOVERY_FINAL_SEGMENTS
  report.metrics.postRecoveryFinalSegments = MIN_QUALIFICATION_POST_RECOVERY_FINAL_SEGMENTS
  report.metrics.resource.sampleCount = 30
  report.exports.markdown.recordCount = MIN_QUALIFICATION_FINAL_SEGMENTS
  report.exports.srt.recordCount = MIN_QUALIFICATION_FINAL_SEGMENTS
  report.exports.text.recordCount = MIN_QUALIFICATION_FINAL_SEGMENTS
  report.progress.statusWindowDragRequired = false
  report.window.heartbeatCount = 1
  report.window.nativeDragObserved = false
  assert.deepEqual(validateI3LiveAudioQualificationReport(report), report)
  assert.throws(() => validateI3LiveAudioReport(report), /only a passing I3 live audio acceptance report/)

  const insufficientPreRecovery = structuredClone(report)
  insufficientPreRecovery.metrics.preRecoveryFinalSegments = MIN_QUALIFICATION_PRE_RECOVERY_FINAL_SEGMENTS - 1
  insufficientPreRecovery.metrics.postRecoveryFinalSegments = MIN_QUALIFICATION_FINAL_SEGMENTS -
    insufficientPreRecovery.metrics.preRecoveryFinalSegments
  assert.throws(() => validateI3LiveAudioQualificationReport(insufficientPreRecovery), /metrics are incomplete/)

  const insufficientPostRecovery = structuredClone(report)
  insufficientPostRecovery.metrics.postRecoveryFinalSegments = MIN_QUALIFICATION_POST_RECOVERY_FINAL_SEGMENTS - 1
  insufficientPostRecovery.metrics.preRecoveryFinalSegments = MIN_QUALIFICATION_FINAL_SEGMENTS -
    insufficientPostRecovery.metrics.postRecoveryFinalSegments
  assert.throws(() => validateI3LiveAudioQualificationReport(insufficientPostRecovery), /metrics are incomplete/)

  const mismatchedPhaseTotals = structuredClone(report)
  mismatchedPhaseTotals.metrics.postRecoveryFinalSegments += 1
  assert.throws(() => validateI3LiveAudioQualificationReport(mismatchedPhaseTotals), /metrics are incomplete/)
})

test('I3 synthetic fixture is explicitly partial and cannot validate as real audio acceptance', () => {
  const fixture = buildSyntheticFixtureReport(parseArguments([
    '--mode', 'synthetic-fixture', '--synthetic-segments', '3', '--report', 'fixture.json'
  ]))
  assert.equal(fixture.kind, 'i3-live-audio-soak-synthetic-fixture')
  assert.equal(fixture.boundaries.actualRealtimeAudioPipeline, false)
  assert.equal(fixture.boundaries.wallClockTwoHourRun, false)
  assert.throws(() => validateI3LiveAudioReport(fixture), /only a passing I3 live audio acceptance report/)
  assert.throws(() => parseArguments([
    '--mode', 'synthetic-fixture', '--source', 'loopback', '--report', 'fixture.json'
  ]), /never selects or accesses an audio source/)
})

test('I3 live verifier requires real-duration, drag, transport, SQLite recovery, and current provenance evidence', () => {
  const report = passingReport()
  assert.deepEqual(validateI3LiveAudioReport(report), report)

  const shortRun = structuredClone(report)
  shortRun.metrics.measuredListeningWallDurationMs -= 1
  assert.throws(() => validateI3LiveAudioReport(shortRun), /duration, history, playback, or segment evidence/)

  const noDrag = structuredClone(report)
  noDrag.window.nativeDragObserved = false
  assert.throws(() => validateI3LiveAudioReport(noDrag), /BrowserWindow\/drag evidence/)

  const droppedFrame = structuredClone(report)
  droppedFrame.transport.postRecoveryGeneration.droppedFrames = 1
  assert.throws(() => validateI3LiveAudioReport(droppedFrame), /transport is not loss-free/)

  const badRecovery = structuredClone(report)
  badRecovery.crashRecovery.separateMainProcessForcedExit = false
  assert.throws(() => validateI3LiveAudioReport(badRecovery), /stale-session recovery evidence/)

  const substitutedStimulus = structuredClone(report)
  substitutedStimulus.stimulus.derivedWavSha256 = '0'.repeat(64)
  assert.throws(() => validateI3LiveAudioReport(substitutedStimulus), /controlled stimulus evidence/)

  const staleProvenance = structuredClone(report)
  staleProvenance.provenance.runnerSha256 = '0'.repeat(64)
  assert.throws(() => validateI3LiveAudioReport(staleProvenance), /provenance drifted for runnerSha256/)
})

test('I3 live report reader rejects duplicate JSON keys before it can accept evidence', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'i3-live-report-test-'))
  const reportPath = path.join(directory, 'duplicate.json')
  fs.writeFileSync(reportPath, '{"schemaVersion":1,"schemaVersion":1}', 'utf8')
  assert.throws(() => readAndValidateI3LiveAudioReport(reportPath), /duplicate object key/)
  fs.rmSync(directory, { recursive: true, force: true })
})
