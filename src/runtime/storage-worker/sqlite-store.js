'use strict'

// @ts-check

/* storage worker 内部的同步 SQLite 适配器。
   本模块可以在 Node 测试中直接验证，但产品组合根只能从 utility process
   间接使用它；Electron main/renderer 不得持有 DatabaseSync。 */

const fs = require('node:fs')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { MIGRATIONS, SCHEMA_VERSION } = require('./schema')

const DEFAULT_BUSY_TIMEOUT_MS = 5000

function scalar (database, sql) {
  const row = database.prepare(sql).get()
  return row ? Object.values(row)[0] : undefined
}

function rollbackQuietly (database) {
  try { database.exec('ROLLBACK') } catch { /* no active transaction */ }
}

function applyMigrations (database, now = () => Date.now()) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL CHECK (version >= 1),
      checksum TEXT NOT NULL CHECK (length(checksum) = 64),
      applied_at INTEGER NOT NULL CHECK (applied_at >= 0)
    ) STRICT;
  `)

  const existing = database.prepare(
    'SELECT version, checksum FROM schema_migrations ORDER BY version'
  ).all()
  const knownVersions = new Set(MIGRATIONS.map((migration) => migration.version))
  for (const applied of existing) {
    const migration = MIGRATIONS.find((candidate) => candidate.version === applied.version)
    if (!migration || migration.checksum !== applied.checksum) {
      throw new Error(`schema migration checksum mismatch at version ${applied.version}`)
    }
  }

  for (const migration of MIGRATIONS) {
    if (existing.some((applied) => applied.version === migration.version)) continue
    database.exec('BEGIN IMMEDIATE')
    try {
      database.exec(migration.sql)
      database.prepare(
        'INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)'
      ).run(migration.version, migration.checksum, now())
      database.exec(`PRAGMA user_version = ${migration.version}`)
      database.exec('COMMIT')
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }

  const userVersion = Number(scalar(database, 'PRAGMA user_version'))
  if (userVersion !== SCHEMA_VERSION) {
    throw new Error(`unexpected schema version ${userVersion}; expected ${SCHEMA_VERSION}`)
  }
  const unexpected = existing.filter((applied) => !knownVersions.has(applied.version))
  if (unexpected.length > 0) throw new Error('database schema is newer than this application')
}

function openSubtitleDatabase (databasePath, options = {}) {
  if (typeof databasePath !== 'string' || !path.isAbsolute(databasePath)) {
    throw new TypeError('databasePath must be absolute')
  }
  const busyTimeoutMs = Number.isInteger(options.busyTimeoutMs)
    ? options.busyTimeoutMs
    : DEFAULT_BUSY_TIMEOUT_MS
  if (busyTimeoutMs < 1 || busyTimeoutMs > 60000) {
    throw new RangeError('busyTimeoutMs must be between 1 and 60000')
  }

  fs.mkdirSync(path.dirname(databasePath), { recursive: true })
  const database = new DatabaseSync(databasePath)
  try {
    database.exec('PRAGMA foreign_keys = ON')
    database.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`)
    const journalMode = String(scalar(database, 'PRAGMA journal_mode = WAL')).toLowerCase()
    if (journalMode !== 'wal') throw new Error(`WAL unavailable (journal_mode=${journalMode})`)
    applyMigrations(database, options.now)
    if (Number(scalar(database, 'PRAGMA foreign_keys')) !== 1) {
      throw new Error('foreign_keys pragma is not enabled')
    }
    return database
  } catch (error) {
    try { database.close() } catch { /* best effort */ }
    throw error
  }
}

module.exports = {
  DEFAULT_BUSY_TIMEOUT_MS,
  applyMigrations,
  openSubtitleDatabase,
  rollbackQuietly,
  scalar
}
