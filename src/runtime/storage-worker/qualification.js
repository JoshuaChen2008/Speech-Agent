'use strict'

// @ts-check

/* DB0 开发态资格检查。它使用真实 schema、真实文件、两个连接和真实事务，
   但只写隔离的 smoke userData；不读取用户历史，不接受 renderer 输入。 */

const { DatabaseSync } = require('node:sqlite')
const { MIGRATIONS, SCHEMA_VERSION } = require('./schema')
const { openSubtitleDatabase, rollbackQuietly, scalar } = require('./sqlite-store')

function count (database, table, sessionId) {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE session_id = ?`).get(sessionId).count)
}

function tableNames (database) {
  return database.prepare(`
    SELECT name FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => String(row.name))
}

function schemaPrivacyAudit (database, tables) {
  const forbiddenColumnPattern = /(^|_)(audio|pcm|wav|recording|recording_path|audio_path)($|_)/i
  const forbiddenColumns = []
  let blobColumnCount = 0
  for (const table of tables) {
    for (const column of database.prepare(`PRAGMA table_info("${table}")`).all()) {
      if (forbiddenColumnPattern.test(String(column.name))) forbiddenColumns.push(`${table}.${column.name}`)
      if (String(column.type).toUpperCase() === 'BLOB') blobColumnCount += 1
    }
  }
  return {
    containsAudioPersistenceSchema: forbiddenColumns.length > 0 || blobColumnCount > 0,
    forbiddenColumns,
    blobColumnCount
  }
}

function insertSession (database, sessionId, startedAt) {
  database.prepare(`
    INSERT INTO sessions(session_id, mode, source_id, started_at, ended_at, state)
    VALUES (?, 'meeting', 'loopback', ?, NULL, 'active')
  `).run(sessionId, startedAt)
}

function insertEventAndProjection (database, sessionId, marker) {
  const event = database.prepare(`
    INSERT INTO caption_events(
      event_id, session_id, source_id, segment_id, sequence, revision,
      kind, t0_ms, t1_ms, text, created_at
    ) VALUES (?, ?, 'loopback', ?, 1, 1, 'final', 0, 1200, ?, ?)
  `).run(`${sessionId}:loopback:1`, sessionId, `segment-${marker}`, `DB0 ${marker}`, 1770000000000)
  const eventOrder = Number(event.lastInsertRowid)
  database.prepare(`
    INSERT INTO segments(
      session_id, source_id, segment_id, text, text_revision,
      t0_ms, t1_ms, first_event_order, updated_event_order
    ) VALUES (?, 'loopback', ?, ?, 1, 0, 1200, ?, ?)
  `).run(sessionId, `segment-${marker}`, `DB0 ${marker}`, eventOrder, eventOrder)
}

function runDatabaseQualification (databasePath) {
  const checks = {}
  const writer = openSubtitleDatabase(databasePath, { now: () => 1770000000000 })
  let reader = null
  try {
    checks.driverLoaded = true
    checks.schemaVersion = Number(scalar(writer, 'PRAGMA user_version')) === SCHEMA_VERSION
    checks.migrationCount = Number(writer.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count) === MIGRATIONS.length
    checks.journalModeWal = String(scalar(writer, 'PRAGMA journal_mode')).toLowerCase() === 'wal'
    checks.busyTimeout = Number(scalar(writer, 'PRAGMA busy_timeout')) === 5000

    reader = new DatabaseSync(databasePath)
    reader.exec('PRAGMA foreign_keys = ON')
    reader.exec('PRAGMA busy_timeout = 5000')

    writer.exec('BEGIN IMMEDIATE')
    insertSession(writer, 'db0-isolation', 1770000000000)
    checks.uncommittedInvisibleToReader = count(reader, 'sessions', 'db0-isolation') === 0
    writer.exec('COMMIT')
    checks.committedVisibleToReader = count(reader, 'sessions', 'db0-isolation') === 1
    let sessionIdentityRejected = false
    try {
      writer.prepare(`
        UPDATE sessions SET mode = 'dictation', source_id = 'mic'
        WHERE session_id = 'db0-isolation'
      `).run()
    } catch (error) {
      sessionIdentityRejected = /immutable/.test(String(error?.message || error))
    }
    const unchangedSession = writer.prepare(`
      SELECT mode, source_id FROM sessions WHERE session_id = 'db0-isolation'
    `).get()
    checks.sessionIdentityImmutable = sessionIdentityRejected &&
      unchangedSession?.mode === 'meeting' && unchangedSession?.source_id === 'loopback'

    writer.exec('BEGIN IMMEDIATE')
    try {
      insertSession(writer, 'db0-rollback', 1770000001000)
      insertEventAndProjection(writer, 'db0-rollback', 'rollback')
      throw new Error('intentional DB0 rollback')
    } catch (error) {
      rollbackQuietly(writer)
      if (error.message !== 'intentional DB0 rollback') throw error
    }
    checks.transactionRollback =
      count(writer, 'sessions', 'db0-rollback') === 0 &&
      count(writer, 'caption_events', 'db0-rollback') === 0 &&
      count(writer, 'segments', 'db0-rollback') === 0

    writer.exec('BEGIN IMMEDIATE')
    insertSession(writer, 'db0-commit', 1770000002000)
    insertEventAndProjection(writer, 'db0-commit', 'commit')
    writer.exec('COMMIT')
    checks.eventProjectionAtomicCommit =
      count(writer, 'caption_events', 'db0-commit') === 1 &&
      count(writer, 'segments', 'db0-commit') === 1
    let updateRejected = false
    let deleteRejected = false
    try {
      writer.prepare("UPDATE caption_events SET text = 'mutated' WHERE session_id = 'db0-commit'").run()
    } catch (error) {
      updateRejected = /immutable/.test(String(error?.message || error))
    }
    try {
      writer.prepare("DELETE FROM caption_events WHERE session_id = 'db0-commit'").run()
    } catch (error) {
      deleteRejected = /immutable/.test(String(error?.message || error))
    }
    checks.captionEventsImmutable = updateRejected && deleteRejected &&
      count(writer, 'caption_events', 'db0-commit') === 1

    const tables = tableNames(writer)
    const privacy = schemaPrivacyAudit(writer, tables)
    checks.subtitleOnlyTables = JSON.stringify(tables) === JSON.stringify([
      'caption_events', 'legacy_imports', 'schema_migrations', 'segments', 'sessions'
    ])
    checks.noAudioPersistenceSchema = !privacy.containsAudioPersistenceSchema
    checks.integrity = String(scalar(writer, 'PRAGMA integrity_check')) === 'ok'
    writer.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all()

    reader.close()
    reader = null
    writer.close()

    const reopened = openSubtitleDatabase(databasePath, { now: () => 1770000003000 })
    try {
      checks.reopenPreservesData =
        Number(scalar(reopened, 'PRAGMA user_version')) === SCHEMA_VERSION &&
        String(scalar(reopened, 'PRAGMA journal_mode')).toLowerCase() === 'wal' &&
        count(reopened, 'caption_events', 'db0-commit') === 1 &&
        count(reopened, 'segments', 'db0-commit') === 1
      checks.migrationIdempotent =
        Number(reopened.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count) === MIGRATIONS.length
      checks.integrityAfterReopen = String(scalar(reopened, 'PRAGMA integrity_check')) === 'ok'
    } finally {
      reopened.close()
    }

    const failedChecks = Object.entries(checks)
      .filter(([, value]) => value !== true)
      .map(([name]) => name)

    return {
      status: failedChecks.length === 0 ? 'pass' : 'fail',
      failedChecks,
      checks,
      runtime: {
        electron: process.versions.electron || null,
        node: process.versions.node,
        sqlite: process.versions.sqlite || null
      },
      schema: {
        version: SCHEMA_VERSION,
        migrationChecksums: MIGRATIONS.map((migration) => migration.checksum),
        tables,
        privacy
      }
    }
  } catch (error) {
    rollbackQuietly(writer)
    throw error
  } finally {
    if (reader) {
      try { reader.close() } catch { /* best effort */ }
    }
    try { writer.close() } catch { /* it may already be closed before reopen */ }
  }
}

module.exports = {
  runDatabaseQualification,
  schemaPrivacyAudit,
  tableNames
}
