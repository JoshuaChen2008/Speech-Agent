'use strict'

/* B3.3 Gateway 真实组合：Coordinator → SQLite Recorder → StorageGateway →
   production StorageWorkerHost → Electron utility process → real SQLite。
   设备/ASR 边界用契约合法事件替代；报告不含正文、路径或音频。 */

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')
const { resolveRuntimeOptions, DEV_MODEL_VALUE } = require('../src/main/runtime-options')
const { SqliteSessionRecorder } = require('../src/main/services/sqlite-session-recorder')
const { StorageGateway } = require('../src/main/services/storage-gateway')
const { FakeRuntimeAdapter } = require('../src/main/session/fake-runtime-adapter')
const { SessionCoordinator } = require('../src/main/session/session-coordinator')
const { StorageWorkerHost } = require('../src/runtime/storage-worker/worker-host')

const FAULT_WORKER_PATH = path.join(__dirname, 'fixtures', 'storage-worker-drop-once.js')
const DEV_RUNTIME = resolveRuntimeOptions({ LIVE_SUBTITLE_DEV_MODEL: DEV_MODEL_VALUE })
const DEV_RUNTIME_WITH_REFINEMENT = Object.freeze({ ...DEV_RUNTIME, refinementAvailable: true })

function parseArguments (argv) {
  const options = {
    report: 'docs/validation/storage-gateway-results.json',
    workDir: '.artifacts/storage-gateway-live'
  }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!['--report', '--work-dir'].includes(flag) || seen.has(flag) || index + 1 >= argv.length) {
      throw new Error(`invalid argument: ${flag}`)
    }
    seen.add(flag)
    if (flag === '--report') options.report = argv[index + 1]
    else options.workDir = argv[index + 1]
    index += 1
  }
  return options
}

function caption (sessionId, sourceId, overrides = {}) {
  return {
    schemaVersion: 1,
    sessionId,
    sourceId,
    segmentId: `${sourceId}-segment`,
    sequence: 1,
    revision: 1,
    kind: 'partial',
    t0: 0.1,
    t1: 1.6,
    text: 'synthetic caption',
    translation: null,
    ...overrides
  }
}

function hasAudioArtifact (directory) {
  if (!fs.existsSync(directory)) return false
  const pending = [directory]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) pending.push(target)
      else if (/\.(?:wav|pcm|raw|flac|mp3|m4a|aac|ogg|opus|webm)$/i.test(entry.name)) return true
    }
  }
  return false
}

async function runFaultReplay (userData, mode) {
  const databasePath = path.join(userData, 'faults', `${mode}.sqlite3`)
  let generations = 0
  const gateway = new StorageGateway({
    databasePath,
    maxRestarts: 2,
    hostFactory: (hostOptions) => {
      generations += 1
      return new StorageWorkerHost({
        ...hostOptions,
        workerPath: FAULT_WORKER_PATH,
        requestTimeoutMs: 10000
      })
    }
  })
  try {
    await gateway.start()
    const sessionId = `fault-${mode}`
    await gateway.openSession({ sessionId, sourceId: 'loopback', startedAt: 1770000200000 })
    const append = await gateway.appendCaption(caption(sessionId, 'loopback', {
      sequence: 1,
      revision: 1,
      kind: 'final',
      text: `synthetic ${mode}`
    }))
    await gateway.closeSession({
      sessionId,
      sourceId: 'loopback',
      endedAt: 1770000205000,
      state: 'closed'
    })
    const stats = await gateway.getStats()
    const history = await gateway.getSessionTranscript(sessionId)
    await gateway.shutdown()
    fs.rmSync(`${databasePath}.transport-drop-once`, { force: true })
    return {
      appendStatus: append.status,
      generations,
      stats,
      segmentRevision: history.segments[0]?.textRevision || 0,
      stopped: gateway.stopped && gateway.host === null
    }
  } catch (error) {
    await gateway.terminate().catch(() => {})
    throw error
  }
}

async function runCoordinatorJourney (userData) {
  const databasePath = path.join(userData, 'data', 'speech-agent.sqlite3')
  const gateway = new StorageGateway({ databasePath, requestTimeoutMs: 10000 })
  const closeAcknowledged = new Set()
  const originalClose = gateway.closeSession.bind(gateway)
  gateway.closeSession = (payload) => originalClose(payload).then((result) => {
    closeAcknowledged.add(payload.sessionId)
    return result
  })
  await gateway.start()

  const recorder = new SqliteSessionRecorder({
    gateway,
    now: (() => {
      const values = [1770000100000, 1770000110000, 1770000120000, 1770000130000]
      return () => values.shift()
    })()
  })
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  const originalStart = adapter.start.bind(adapter)
  const openBeforeCapture = []
  adapter.start = async (context) => {
    const stats = await gateway.getStats()
    openBeforeCapture.push(stats.activeSessions === 1)
    return originalStart(context)
  }
  const sessionIds = ['gateway-loopback', 'gateway-mic']
  const coordinator = new SessionCoordinator({
    adapter,
    runtimeOptions: DEV_RUNTIME_WITH_REFINEMENT,
    configuration: {
      onboardingCompleted: true,
      onboardingPreset: 'meeting',
      mic: false,
      loopback: true,
      refinementEnabled: true
    },
    idFactory: () => sessionIds.shift(),
    persistenceSink: recorder
  })
  const sinkBeforeUi = []
  const idleAfterClose = []
  const observedIdleSessions = new Set()
  let lastSessionId = null
  coordinator.onSnapshot((snapshot) => {
    if (snapshot.sessionId) lastSessionId = snapshot.sessionId
    if (snapshot.phase === 'idle' && lastSessionId && !observedIdleSessions.has(lastSessionId)) {
      observedIdleSessions.add(lastSessionId)
      idleAfterClose.push(closeAcknowledged.has(lastSessionId))
    }
  })
  coordinator.onCaption((event) => {
    if (event.kind === 'final' || event.kind === 'refined') {
      sinkBeforeUi.push(gateway.queue.some((item) =>
        item.operation === 'appendCaption' && item.payload.sequence === event.sequence))
    }
  })

  try {
    if (!(await coordinator.command('start')).ok) throw new Error('loopback start failed')
    const loopbackId = coordinator.getSnapshot().sessionId
    adapter.emitCaption(caption(loopbackId, 'loopback'))
    adapter.emitCaption(caption(loopbackId, 'loopback', {
      sequence: 2, revision: 2, kind: 'final', text: 'synthetic loopback final'
    }))
    await gateway.flush()
    const pauseResult = await coordinator.command('pause')
    const pausedSessionId = coordinator.getSnapshot().sessionId
    const resumeResult = await coordinator.command('resume')
    const pauseResumeSameSession = pauseResult.ok && resumeResult.ok &&
      pausedSessionId === loopbackId && coordinator.getSnapshot().sessionId === loopbackId

    const retiredHost = gateway.host
    const retiredChild = retiredHost.child
    const retiredExit = retiredHost.exitPromise
    retiredChild.kill()
    await retiredExit

    adapter.emitCaption(caption(loopbackId, 'loopback', {
      sequence: 3, revision: 3, kind: 'refined', text: 'synthetic loopback refined'
    }))
    await gateway.flush()
    const idleExitRecovered = gateway.host !== retiredHost
    adapter.emitCaption(caption(loopbackId, 'loopback', {
      sequence: 4,
      revision: 4,
      kind: 'translated',
      text: 'synthetic loopback refined',
      translation: { language: 'en', text: 'legacy compatibility only', basedOnRevision: 3 }
    }))
    if (!(await coordinator.command('stop')).ok) throw new Error('loopback stop failed')

    coordinator.updateConfiguration({
      onboardingCompleted: true,
      onboardingPreset: 'dictation',
      mic: true,
      loopback: false,
      refinementEnabled: false
    })
    if (!(await coordinator.command('start')).ok) throw new Error('mic start failed')
    const micId = coordinator.getSnapshot().sessionId
    adapter.emitCaption(caption(micId, 'mic'))
    adapter.emitCaption(caption(micId, 'mic', {
      sequence: 2, revision: 2, kind: 'final', text: 'synthetic mic final'
    }))
    if (!(await coordinator.command('stop')).ok) throw new Error('mic stop failed')

    const loopbackHistory = await gateway.getSessionTranscript(loopbackId)
    const micHistory = await gateway.getSessionTranscript(micId)
    const stats = await gateway.getStats()
    await coordinator.dispose()
    await gateway.shutdown()
    return {
      idleExitRecovered,
      idleAfterClose,
      openBeforeCapture,
      pauseResumeSameSession,
      sinkBeforeUi,
      stats,
      histories: {
        loopback: {
          mode: loopbackHistory.session.mode,
          sourceId: loopbackHistory.session.sourceId,
          state: loopbackHistory.session.state,
          segments: loopbackHistory.segments.length,
          revision: loopbackHistory.segments[0]?.textRevision || 0,
          refinementEnabled: loopbackHistory.refinement.refinementEnabled === true,
          originalFinalPreserved: loopbackHistory.segments[0]?.text === 'synthetic loopback final',
          hasRefinedVersion: loopbackHistory.segments[0]?.refinedText !== null
        },
        mic: {
          mode: micHistory.session.mode,
          sourceId: micHistory.session.sourceId,
          state: micHistory.session.state,
          segments: micHistory.segments.length,
          revision: micHistory.segments[0]?.textRevision || 0,
          refinementDisabled: micHistory.refinement.refinementEnabled === false,
          originalFinalPreserved: micHistory.segments[0]?.text === 'synthetic mic final',
          hasNoRefinedVersion: micHistory.segments[0]?.refinedText === null
        }
      },
      stopped: gateway.stopped && gateway.host === null
    }
  } catch (error) {
    await coordinator.dispose().catch(() => {})
    await gateway.terminate().catch(() => {})
    throw error
  }
}

async function main () {
  const options = parseArguments(process.argv.slice(2))
  const reportPath = path.resolve(options.report)
  const runDir = path.resolve(options.workDir, `run-${Date.now()}`)
  const userData = path.join(runDir, 'electron-user-data')
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.mkdirSync(userData, { recursive: true })
  app.setPath('userData', userData)
  app.on('window-all-closed', () => {})
  await app.whenReady()

  try {
    const journey = await runCoordinatorJourney(userData)
    const beforeCommit = await runFaultReplay(userData, 'drop-before-commit')
    const afterCommit = await runFaultReplay(userData, 'drop-after-commit')
    const checks = {
      openBeforeCapture: journey.openBeforeCapture.length === 2 && journey.openBeforeCapture.every(Boolean),
      persistenceEnqueuedBeforeUi: journey.sinkBeforeUi.length === 3 && journey.sinkBeforeUi.every(Boolean),
      stopBarrierBeforeIdle: journey.idleAfterClose.length === 2 && journey.idleAfterClose.every(Boolean),
      pauseResumeSameSession: journey.pauseResumeSameSession,
      idleWorkerExitRecovered: journey.idleExitRecovered,
      xorSessionsIsolated: journey.histories.loopback.mode === 'meeting' &&
        journey.histories.loopback.sourceId === 'loopback' && journey.histories.loopback.state === 'closed' &&
        journey.histories.loopback.segments === 1 && journey.histories.loopback.revision === 2 &&
        journey.histories.loopback.refinementEnabled && journey.histories.loopback.originalFinalPreserved &&
        journey.histories.loopback.hasRefinedVersion &&
        journey.histories.mic.mode === 'dictation' && journey.histories.mic.sourceId === 'mic' &&
        journey.histories.mic.state === 'closed' && journey.histories.mic.segments === 1 &&
        journey.histories.mic.revision === 2 && journey.histories.mic.refinementDisabled &&
        journey.histories.mic.originalFinalPreserved && journey.histories.mic.hasNoRefinedVersion,
      partialAndTranslatedExcluded: journey.stats.captionEvents === 3 && journey.stats.segments === 2,
      databaseHealthy: journey.stats.sessions === 2 && journey.stats.activeSessions === 0 &&
        journey.stats.journalMode === 'wal' && journey.stats.integrity === 'ok',
      beforeCommitReplay: beforeCommit.appendStatus === 'committed' && beforeCommit.generations === 2 &&
        beforeCommit.stats.captionEvents === 1 && beforeCommit.stats.segments === 1 && beforeCommit.segmentRevision === 1,
      afterCommitReplay: afterCommit.appendStatus === 'already_processed' && afterCommit.generations === 2 &&
        afterCommit.stats.captionEvents === 1 && afterCommit.stats.segments === 1 && afterCommit.segmentRevision === 1,
      allGatewayShutdownsCompleted: journey.stopped && beforeCommit.stopped && afterCommit.stopped,
      noJsonlDualWrite: !fs.existsSync(path.join(userData, 'sessions')),
      noAudioArtifacts: !hasAudioArtifact(userData)
    }
    const failedChecks = Object.entries(checks).filter(([, value]) => value !== true).map(([name]) => name)
    const report = {
      schemaVersion: 1,
      kind: 'storage-gateway-coordinator-composition',
      executedAt: new Date().toISOString(),
      result: failedChecks.length === 0 ? 'pass' : 'fail',
      gateStatus: failedChecks.length === 0 ? 'pass' : 'fail',
      runtime: {
        electron: process.versions.electron,
        node: process.versions.node,
        sqlite: process.versions.sqlite || null
      },
      failedChecks,
      checks,
      metrics: {
        sessions: journey.stats.sessions,
        captionEvents: journey.stats.captionEvents,
        segments: journey.stats.segments,
        beforeCommitGenerations: beforeCommit.generations,
        afterCommitGenerations: afterCommit.generations
      },
      scope: {
        defaultProductAuthorityCutover: false,
        jsonlMigration: false,
        historyUi: false,
        beforeQuitProductWiring: false,
        packagedRuntime: false,
        db6FullGate: false
      },
      privacy: {
        noBrowserWindowCreated: true,
        isolatedUserData: true,
        reportContainsTranscriptText: false,
        reportContainsAbsolutePath: false,
        persistedAudio: false
      }
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    process.stdout.write(JSON.stringify({
      result: report.result,
      runtime: report.runtime,
      failedChecks,
      metrics: report.metrics
    }) + '\n')
    app.exit(report.result === 'pass' ? 0 : 1)
  } catch (error) {
    const report = {
      schemaVersion: 1,
      kind: 'storage-gateway-coordinator-composition',
      executedAt: new Date().toISOString(),
      result: 'error',
      gateStatus: 'fail',
      error: { code: error?.code || 'STORAGE_COMMAND_FAILED', message: 'Storage gateway smoke failed.' },
      failedChecks: [],
      scope: { defaultProductAuthorityCutover: false, packagedRuntime: false },
      privacy: { noBrowserWindowCreated: true, isolatedUserData: true }
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    console.error(error?.stack || error)
    app.exit(1)
  }
}

main().catch((error) => {
  console.error(error?.stack || error)
  app.exit(1)
})
