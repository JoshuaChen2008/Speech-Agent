'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  JsonlSqliteMigrator,
  LegacyMigrationError,
  sha256
} = require('../../src/main/services/jsonl-sqlite-migrator')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const {
  OPERATIONS,
  PROTOCOL_VERSION,
  StorageError,
  makeLegacyImportKey
} = require('../../src/runtime/storage-worker/protocol')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')

function temporaryDirectory () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-sqlite-migration-'))
}

function serviceBackedHost (service, databasePath) {
  let requestId = 0
  let started = false
  function call (operation, payload, idempotencyKey) {
    const response = service.handle({
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId: `migration-${++requestId}`,
      operation,
      payload,
      ...(idempotencyKey ? { idempotencyKey } : {})
    })
    if (!response.ok) throw new StorageError(response.error.code)
    return response.result
  }
  return {
    async start () {
      if (started) return
      call(OPERATIONS.INITIALIZE, { databasePath })
      started = true
    },
    async importLegacyJsonl (input) {
      return call(OPERATIONS.IMPORT_LEGACY_JSONL, input, makeLegacyImportKey(input.sourceSha256))
    },
    async getSessionTranscript (sessionId) {
      return call(OPERATIONS.GET_SESSION, { sessionId })
    },
    async getStats () {
      return call(OPERATIONS.GET_STATS, {})
    },
    async openSession () { throw new Error('not used by migration journey') },
    async appendCaption () { throw new Error('not used by migration journey') },
    async closeSession () { throw new Error('not used by migration journey') },
    async shutdown () {
      if (!service.shuttingDown) call(OPERATIONS.SHUTDOWN, {})
    },
    async terminateAndWait () {
      if (!service.shuttingDown) call(OPERATIONS.SHUTDOWN, {})
    }
  }
}

function migrationRuntime (databasePath, options = {}) {
  const service = new StorageWorkerService({
    storeFactory: options.storeFactory
  })
  const gateway = new StorageGateway({
    databasePath,
    hostFactory: () => serviceBackedHost(service, databasePath),
    maxRestarts: 0
  })
  const migrator = new JsonlSqliteMigrator({
    gateway,
    now: options.now || (() => 1775000100000),
    ...(options.readFile ? { readFile: options.readFile } : {})
  })
  return { service, gateway, migrator }
}

function getStats (service) {
  const response = service.handle({
    version: PROTOCOL_VERSION,
    type: 'storage:request',
    requestId: 'inspect-stats',
    operation: OPERATIONS.GET_STATS,
    payload: {}
  })
  assert.equal(response.ok, true)
  return response.result
}

function event (name, values = {}) {
  return JSON.stringify({ v: 1, event: name, ...values })
}

function writeLegacyFile (directory, name, records, tail = '') {
  const filePath = path.join(directory, name)
  fs.writeFileSync(filePath, records.join('\n') + tail, 'utf8')
  return filePath
}

test('J10 DB2: JSONL migration preserves original projections and raw export digests, without importing translations', async (t) => {
  const directory = temporaryDirectory()
  const legacyDirectory = path.join(directory, 'legacy')
  fs.mkdirSync(legacyDirectory)
  const startedAt = 1775000000000
  const closedFile = writeLegacyFile(legacyDirectory, 'meeting.jsonl', [
    event('session.open', { sessionId: 'legacy-meeting', at: new Date(startedAt).toISOString() }),
    event('segment.final', {
      sessionId: 'legacy-meeting', sourceId: 'loopback', segmentId: 'segment-a',
      sequence: 1, revision: 1, t0: 0, t1: 1.25, text: '第一版正文'
    }),
    'this-is-a-complete-corrupt-middle-line',
    event('segment.translated', {
      sessionId: 'legacy-meeting', sourceId: 'loopback', segmentId: 'segment-a',
      sequence: 2, revision: 2, t0: 0, t1: 1.25, text: '第一版正文',
      lang: 'en', translation: 'First version.', basedOnRevision: 1
    }),
    event('segment.refined', {
      sessionId: 'legacy-meeting', sourceId: 'loopback', segmentId: 'segment-a',
      sequence: 3, revision: 3, t0: 0, t1: 1.5, text: '精修后的原文。'
    }),
    event('segment.final', {
      sessionId: 'legacy-meeting', sourceId: 'loopback', segmentId: 'segment-b',
      sequence: 4, revision: 1, t0: 2, t1: 3, text: '第二段原文。'
    }),
    event('session.close', { sessionId: 'legacy-meeting', at: new Date(startedAt + 4000).toISOString() }),
    ''
  ])
  const interruptedFile = writeLegacyFile(legacyDirectory, 'dictation.jsonl', [
    event('session.open', { sessionId: 'legacy-dictation', at: new Date(startedAt + 10000).toISOString() }),
    event('segment.final', {
      sessionId: 'legacy-dictation', sourceId: 'mic', segmentId: 'segment-mic',
      sequence: 1, revision: 1, t0: 0, t1: 2, text: '未正常收尾的听写。'
    })
  ], '\n{"v":1,"event":"segment.final","sessionId":"cut-off"')
  const translatedOnlyFile = writeLegacyFile(legacyDirectory, 'translated-only.jsonl', [
    event('session.open', { sessionId: 'legacy-translated-only', at: new Date(startedAt + 20000).toISOString() }),
    event('segment.translated', {
      sessionId: 'legacy-translated-only', sourceId: 'mic', segmentId: 'translation-only',
      sequence: 1, revision: 2, t0: 0, t1: 1, text: '遗留正文',
      lang: 'en', translation: 'Legacy-only.', basedOnRevision: 1
    }),
    event('session.close', { sessionId: 'legacy-translated-only', at: new Date(startedAt + 21000).toISOString() }),
    ''
  ])
  const emptyFile = writeLegacyFile(legacyDirectory, 'empty.jsonl', [
    event('session.open', { sessionId: 'legacy-empty', at: new Date(startedAt + 30000).toISOString() }),
    event('session.close', { sessionId: 'legacy-empty', at: new Date(startedAt + 31000).toISOString() }),
    ''
  ])
  const unknownEventFile = writeLegacyFile(legacyDirectory, 'unknown-event.jsonl', [
    event('session.open', { sessionId: 'legacy-unknown', at: new Date(startedAt + 40000).toISOString() }),
    event('segment.untrusted', { sessionId: 'legacy-unknown', text: '不能静默忽略。' }),
    event('session.close', { sessionId: 'legacy-unknown', at: new Date(startedAt + 41000).toISOString() }),
    ''
  ])
  const crossSessionTranslationFile = writeLegacyFile(legacyDirectory, 'cross-session-translation.jsonl', [
    event('session.open', { sessionId: 'legacy-cross', at: new Date(startedAt + 50000).toISOString() }),
    event('segment.translated', {
      sessionId: 'other-session', segmentId: 'foreign', sequence: 1, revision: 2,
      t0: 0, t1: 1, text: '错误', lang: 'en', translation: 'Wrong.', basedOnRevision: 1
    }),
    event('session.close', { sessionId: 'legacy-cross', at: new Date(startedAt + 51000).toISOString() }),
    ''
  ])
  const afterCloseFile = writeLegacyFile(legacyDirectory, 'after-close.jsonl', [
    event('session.open', { sessionId: 'legacy-after-close', at: new Date(startedAt + 60000).toISOString() }),
    event('session.close', { sessionId: 'legacy-after-close', at: new Date(startedAt + 61000).toISOString() }),
    event('segment.final', {
      sessionId: 'legacy-after-close', sourceId: 'loopback', segmentId: 'too-late',
      sequence: 1, revision: 1, t0: 0, t1: 1, text: '关闭后的伪事实。'
    }),
    ''
  ])
  const originalClosed = fs.readFileSync(closedFile)
  const originalInterrupted = fs.readFileSync(interruptedFile)
  const databasePath = path.join(directory, 'data', 'speech-agent.sqlite3')
  const { gateway, migrator } = migrationRuntime(databasePath)
  t.after(async () => {
    await gateway.shutdown()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const [closed, interrupted, translatedOnly, empty] = await migrator.migrateFiles([
    closedFile, interruptedFile, translatedOnlyFile, emptyFile
  ])
  assert.equal(closed.status, 'imported')
  assert.equal(closed.sourceName, 'meeting.jsonl')
  assert.equal(closed.sessionState, 'closed')
  assert.equal(closed.importedCaptionEventCount, 3)
  assert.equal(closed.sourceRecordCount, 6)
  assert.equal(closed.translatedEventCount, 1)
  assert.equal(closed.corruptLineCount, 1)
  assert.equal(closed.truncatedTail, false)
  assert.equal(interrupted.status, 'imported')
  assert.equal(interrupted.sessionState, 'interrupted', 'missing session.close is an explicit interrupted import')
  assert.equal(interrupted.truncatedTail, true)
  assert.equal(interrupted.corruptLineCount, 0)
  assert.equal(interrupted.importedCaptionEventCount, 1)
  assert.equal(translatedOnly.status, 'skipped')
  assert.equal(translatedOnly.sessionState, 'skipped')
  assert.equal(translatedOnly.importedCaptionEventCount, 0)
  assert.equal(translatedOnly.translatedEventCount, 1)
  assert.equal(empty.status, 'skipped')
  assert.equal(empty.importedCaptionEventCount, 0)
  for (const digest of Object.values(closed.digests)) assert.match(digest, /^[a-f0-9]{64}$/)
  assert.ok(!JSON.stringify(closed).includes(directory), 'migration report must not reveal absolute source paths')
  assert.deepEqual(await migrator.migrateDirectory(path.join(directory, 'not-created-yet')), [])
  await assert.rejects(
    migrator.migrateFile(unknownEventFile),
    (error) => error instanceof LegacyMigrationError && error.code === 'INVALID_LEGACY_FILE'
  )
  await assert.rejects(
    migrator.migrateFile(crossSessionTranslationFile),
    (error) => error instanceof LegacyMigrationError && error.code === 'INVALID_LEGACY_FILE'
  )
  await assert.rejects(
    migrator.migrateFile(afterCloseFile),
    (error) => error instanceof LegacyMigrationError && error.code === 'INVALID_LEGACY_FILE'
  )

  const transcript = await gateway.getSessionTranscript('legacy-meeting')
  assert.deepEqual(transcript.segments.map((segment) => [segment.segmentId, segment.text]), [
    /* 迁移后默认可见的是每段最早的有效 final，精修稿只作独立版本保留（SEM-T08）。 */
    ['segment-a', '第一版正文'],
    ['segment-b', '第二段原文。']
  ])
  const interruptedTranscript = await gateway.getSessionTranscript('legacy-dictation')
  assert.equal(interruptedTranscript.session.state, 'interrupted')
  assert.equal(interruptedTranscript.session.endedAt, startedAt + 12000)
  assert.deepEqual(await gateway.getStats(), {
    sessions: 2,
    activeSessions: 0,
    captionEvents: 4,
    segments: 3,
    legacyImports: 4,
    journalMode: 'wal',
    integrity: 'ok'
  })

  const rerun = await migrator.migrateFile(closedFile)
  assert.equal(rerun.status, 'already_processed')
  assert.deepEqual(await gateway.getStats(), {
    sessions: 2,
    activeSessions: 0,
    captionEvents: 4,
    segments: 3,
    legacyImports: 4,
    journalMode: 'wal',
    integrity: 'ok'
  }, 'same source SHA must never add a second fact, segment or audit side effect')
  assert.deepEqual(fs.readFileSync(closedFile), originalClosed, 'legacy JSONL remains read-only')
  assert.deepEqual(fs.readFileSync(interruptedFile), originalInterrupted, 'migration never repairs or rewrites a truncated tail')
})

test('J10 DB2: a failure in the second file rolls back only its rows and retry can commit it', async (t) => {
  const directory = temporaryDirectory()
  const firstFile = writeLegacyFile(directory, 'first.jsonl', [
    event('session.open', { sessionId: 'legacy-first', at: new Date(1775000190000).toISOString() }),
    event('segment.final', {
      sessionId: 'legacy-first', sourceId: 'loopback', segmentId: 'segment-first',
      sequence: 1, revision: 1, t0: 0, t1: 1, text: '第一份先提交。'
    }),
    event('session.close', { sessionId: 'legacy-first', at: new Date(1775000192000).toISOString() }),
    ''
  ])
  const legacyFile = writeLegacyFile(directory, 'atomic.jsonl', [
    event('session.open', { sessionId: 'legacy-atomic', at: new Date(1775000200000).toISOString() }),
    event('segment.final', {
      sessionId: 'legacy-atomic', sourceId: 'loopback', segmentId: 'segment-atomic',
      sequence: 1, revision: 1, t0: 0, t1: 1, text: '原子导入。'
    }),
    event('session.close', { sessionId: 'legacy-atomic', at: new Date(1775000202000).toISOString() }),
    ''
  ])
  let auditsSeen = 0
  const databasePath = path.join(directory, 'data', 'speech-agent.sqlite3')
  const { service, gateway, migrator } = migrationRuntime(databasePath, {
    storeFactory: (options) => new SqliteSubtitleStore({
      ...options,
      faultInjector: (point) => {
        if (point === 'legacyBeforeAudit' && ++auditsSeen === 2) throw new Error('injected migration interruption')
      }
    })
  })
  t.after(async () => {
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await assert.rejects(
    migrator.migrateFiles([firstFile, legacyFile]),
    (error) => error instanceof StorageError && error.code === 'STORAGE_COMMAND_FAILED'
  )
  assert.deepEqual(getStats(service), {
    sessions: 1,
    activeSessions: 0,
    captionEvents: 1,
    segments: 1,
    legacyImports: 1,
    journalMode: 'wal',
    integrity: 'ok'
  }, 'the second file session, facts, projection and audit must roll back together')

  await gateway.retry()
  const rerun = await migrator.migrateFile(legacyFile)
  assert.equal(rerun.status, 'already_processed')
  assert.deepEqual(await gateway.getStats(), {
    sessions: 2,
    activeSessions: 0,
    captionEvents: 2,
    segments: 2,
    legacyImports: 2,
    journalMode: 'wal',
    integrity: 'ok'
  })
})

test('J10 DB2: SHA and parsed payload share one immutable byte snapshot', async (t) => {
  const directory = temporaryDirectory()
  const legacyFile = writeLegacyFile(directory, 'snapshot.jsonl', [
    event('session.open', { sessionId: 'snapshot-old', at: new Date(1775000300000).toISOString() }),
    event('segment.final', {
      sessionId: 'snapshot-old', sourceId: 'loopback', segmentId: 'old-segment',
      sequence: 1, revision: 1, t0: 0, t1: 1, text: '字节快照中的旧内容。'
    }),
    event('session.close', { sessionId: 'snapshot-old', at: new Date(1775000302000).toISOString() }),
    ''
  ])
  const oldBytes = fs.readFileSync(legacyFile)
  const replacement = [
    event('session.open', { sessionId: 'snapshot-new', at: new Date(1775000400000).toISOString() }),
    event('segment.final', {
      sessionId: 'snapshot-new', sourceId: 'mic', segmentId: 'new-segment',
      sequence: 1, revision: 1, t0: 0, t1: 1, text: '第二次读取才会看到的新内容。'
    }),
    event('session.close', { sessionId: 'snapshot-new', at: new Date(1775000402000).toISOString() }),
    ''
  ].join('\n')
  let reads = 0
  const databasePath = path.join(directory, 'data', 'speech-agent.sqlite3')
  const { gateway, migrator } = migrationRuntime(databasePath, {
    readFile: (filePath) => {
      reads += 1
      const bytes = fs.readFileSync(filePath)
      fs.writeFileSync(filePath, replacement, 'utf8')
      return bytes
    }
  })
  t.after(async () => {
    await gateway.shutdown()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  const report = await migrator.migrateFile(legacyFile)
  assert.equal(reads, 1)
  assert.equal(report.sourceSha256, sha256(oldBytes))
  assert.equal(report.sessionId, 'snapshot-old')
  const transcript = await gateway.getSessionTranscript('snapshot-old')
  assert.equal(transcript.segments[0].text, '字节快照中的旧内容。')
})

test('J10 DB2: non-millisecond legacy times fail closed instead of passing a rounded digest', async (t) => {
  const directory = temporaryDirectory()
  const legacyFile = writeLegacyFile(directory, 'sub-millisecond.jsonl', [
    event('session.open', { sessionId: 'sub-millisecond', at: new Date(1775000500000).toISOString() }),
    event('segment.final', {
      sessionId: 'sub-millisecond', sourceId: 'loopback', segmentId: 'precise-segment',
      sequence: 1, revision: 1, t0: 0.0004, t1: 1, text: '不得静默取整。'
    }),
    event('session.close', { sessionId: 'sub-millisecond', at: new Date(1775000502000).toISOString() }),
    ''
  ])
  const databasePath = path.join(directory, 'data', 'speech-agent.sqlite3')
  const { gateway, migrator } = migrationRuntime(databasePath)
  t.after(async () => {
    await gateway.shutdown()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  await assert.rejects(
    migrator.migrateFile(legacyFile),
    (error) => error instanceof LegacyMigrationError && error.code === 'INVALID_LEGACY_FILE'
  )
  assert.deepEqual(await gateway.getStats(), {
    sessions: 0,
    activeSessions: 0,
    captionEvents: 0,
    segments: 0,
    legacyImports: 0,
    journalMode: 'wal',
    integrity: 'ok'
  })
})
