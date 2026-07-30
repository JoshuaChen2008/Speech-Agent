'use strict'

/* DB1 真实组合 smoke：Electron main → production StorageWorkerHost →
   utilityProcess → WorkerService → SqliteSubtitleStore → 文件 SQLite。
   无 BrowserWindow、无现场音频、报告不含正文或绝对路径。 */

const fs = require('node:fs')
const path = require('node:path')
const { app } = require('electron')
const { StorageWorkerHost } = require('../src/runtime/storage-worker/worker-host')

function parseArguments (argv) {
  const options = {
    report: 'docs/validation/db1-storage-results.json',
    workDir: '.artifacts/db1-live'
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

function event (overrides = {}) {
  return {
    schemaVersion: 1,
    sessionId: 'db1-loopback',
    sourceId: 'loopback',
    segmentId: 'loopback-segment',
    sequence: 3,
    revision: 3,
    kind: 'final',
    t0: 0.1,
    t1: 1.6,
    text: 'DB1 synthetic final',
    translation: null,
    ...overrides
  }
}

async function expectCode (promise, expectedCode) {
  try {
    await promise
    return false
  } catch (error) {
    return error?.code === expectedCode
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

  const host = new StorageWorkerHost({
    databasePath: path.join(userData, 'data', 'speech-agent.sqlite3'),
    requestTimeoutMs: 10000
  })
  const checks = {}
  try {
    await host.start()
    checks.initialized = true

    const loopbackOpen = { sessionId: 'db1-loopback', sourceId: 'loopback', startedAt: 1770000100000 }
    const opened = await host.openSession(loopbackOpen)
    const alreadyOpened = await host.openSession(loopbackOpen)
    checks.openIdempotent = opened.status === 'committed' && alreadyOpened.status === 'already_processed'

    const final = event()
    const refined = event({ sequence: 4, revision: 4, kind: 'refined', text: 'DB1 synthetic refined' })
    const late = event({ sequence: 5, revision: 2, text: 'DB1 synthetic late' })
    const [finalResult, refinedResult, lateResult] = await Promise.all([
      host.appendCaption(final),
      host.appendCaption(refined),
      host.appendCaption(late)
    ])
    checks.fifoProjection = finalResult.projectionUpdated === true &&
      refinedResult.projectionUpdated === true && lateResult.projectionUpdated === false
    checks.eventIdempotent = (await host.appendCaption(final)).status === 'already_processed'
    checks.divergentPayloadRejected = await expectCode(
      host.appendCaption({ ...final, text: 'DB1 divergent payload' }),
      'EVENT_IDENTITY_CONFLICT'
    )
    checks.partialRejected = await expectCode(
      host.appendCaption(event({ sequence: 6, revision: 5, kind: 'partial', text: 'temporary' })),
      'UNSUPPORTED_CAPTION_KIND'
    )
    checks.unsafeCaptionFieldsRejected = await expectCode(
      host.appendCaption(event({
        sequence: 6,
        revision: 5,
        audioPath: 'C:\\forbidden\\capture.wav',
        samples: [1, 2, 3],
        sql: 'DROP TABLE caption_events'
      })),
      'INVALID_CAPTION'
    )
    const closedLoopback = await host.closeSession({
      sessionId: 'db1-loopback', sourceId: 'loopback', endedAt: 1770000110000, state: 'closed'
    })
    checks.closeCommitted = closedLoopback.status === 'committed'
    checks.retryAfterClose = (await host.appendCaption(final)).status === 'already_processed'
    checks.newAfterCloseRejected = await expectCode(
      host.appendCaption(event({ sequence: 7, revision: 5, kind: 'refined', text: 'after close' })),
      'SESSION_NOT_ACTIVE'
    )

    await host.openSession({ sessionId: 'db1-mic', sourceId: 'mic', startedAt: 1770000120000 })
    const micFinal = event({
      sessionId: 'db1-mic', sourceId: 'mic', segmentId: 'mic-segment',
      sequence: 1, revision: 1, t0: 2, t1: 3, text: 'DB1 synthetic mic'
    })
    await host.appendCaption(micFinal)
    await host.closeSession({ sessionId: 'db1-mic', sourceId: 'mic', endedAt: 1770000130000, state: 'closed' })

    const loopbackHistory = await host.getSessionTranscript('db1-loopback')
    const micHistory = await host.getSessionTranscript('db1-mic')
    checks.xorSessionsIsolated = loopbackHistory.session.mode === 'meeting' &&
      loopbackHistory.session.sourceId === 'loopback' && loopbackHistory.segments.length === 1 &&
      loopbackHistory.segments[0].textRevision === 4 &&
      loopbackHistory.segments[0].text === 'DB1 synthetic refined' &&
      micHistory.session.mode === 'dictation' && micHistory.session.sourceId === 'mic' &&
      micHistory.segments.length === 1 && micHistory.segments[0].text === 'DB1 synthetic mic'

    const stats = await host.getStats()
    checks.realDatabaseCounts = stats.sessions === 2 && stats.activeSessions === 0 &&
      stats.captionEvents === 4 && stats.segments === 2 && stats.legacyImports === 0
    checks.databaseHealthy = stats.journalMode === 'wal' && stats.integrity === 'ok'
    await host.shutdown()
    checks.workerNaturalExit = host.child === null

    const failedChecks = Object.entries(checks).filter(([, value]) => value !== true).map(([name]) => name)
    const report = {
      schemaVersion: 1,
      kind: 'db1-storage-worker-composition',
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
        sessions: stats.sessions,
        activeSessions: stats.activeSessions,
        captionEvents: stats.captionEvents,
        segments: stats.segments
      },
      scope: {
        productAuthorityCutover: false,
        jsonlMigration: false,
        historyUi: false,
        workerAutoRecovery: false,
        packagedRuntime: false,
        db6FullGate: false
      },
      privacy: {
        noBrowserWindowCreated: true,
        isolatedUserData: true,
        unsafeCaptionFieldsRejected: checks.unsafeCaptionFieldsRejected === true,
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
    host.terminate()
    const report = {
      schemaVersion: 1,
      kind: 'db1-storage-worker-composition',
      executedAt: new Date().toISOString(),
      result: 'error',
      gateStatus: 'fail',
      error: { code: error?.code || 'STORAGE_COMMAND_FAILED', message: 'DB1 storage smoke failed.' },
      failedChecks: Object.entries(checks).filter(([, value]) => value !== true).map(([name]) => name),
      scope: { productAuthorityCutover: false, packagedRuntime: false },
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
