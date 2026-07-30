'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { DatabaseSync } = require('node:sqlite')

const { MIGRATIONS, SCHEMA_VERSION } = require('../../src/runtime/storage-worker/schema')
const { runDatabaseQualification } = require('../../src/runtime/storage-worker/qualification')
const { openSubtitleDatabase } = require('../../src/runtime/storage-worker/sqlite-store')

function tempDatabase (t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-agent-sqlite-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'data', 'speech-agent.sqlite3')
}

test('DB0 uses a real file, WAL, migrations, isolation, rollback and reopen', (t) => {
  const databasePath = tempDatabase(t)
  const result = runDatabaseQualification(databasePath)

  assert.equal(result.status, 'pass')
  assert.deepEqual(result.failedChecks, [])
  assert.ok(Object.values(result.checks).every((value) => value === true))
  assert.equal(result.schema.version, SCHEMA_VERSION)
  assert.deepEqual(result.schema.tables, [
    'caption_events', 'legacy_imports', 'schema_migrations', 'segments', 'sessions'
  ])
  assert.equal(result.schema.privacy.containsAudioPersistenceSchema, false)
  assert.equal(result.schema.privacy.blobColumnCount, 0)
  assert.ok(fs.statSync(databasePath).size > 0)
})

test('migration checksum drift fails closed without applying another schema', (t) => {
  const databasePath = tempDatabase(t)
  const database = openSubtitleDatabase(databasePath, { now: () => 1770000000000 })
  database.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = ?')
    .run('0'.repeat(64), MIGRATIONS[0].version)
  database.close()

  assert.throws(
    () => openSubtitleDatabase(databasePath),
    /checksum mismatch/
  )
  const inspect = new DatabaseSync(databasePath)
  try {
    assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count, 1)
    assert.equal(Number(inspect.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION)
  } finally {
    inspect.close()
  }
})

test('schema rejects mixed source modes and non-subtitle event kinds', (t) => {
  const database = openSubtitleDatabase(tempDatabase(t), { now: () => 1770000000000 })
  try {
    assert.throws(() => database.prepare(`
      INSERT INTO sessions(session_id, mode, source_id, started_at, state)
      VALUES ('mixed', 'meeting', 'mic', 1, 'active')
    `).run(), /constraint/i)
    database.prepare(`
      INSERT INTO sessions(session_id, mode, source_id, started_at, state)
      VALUES ('s', 'dictation', 'mic', 1, 'active')
    `).run()
    assert.throws(() => database.prepare(`
      UPDATE sessions SET mode = 'meeting', source_id = 'loopback'
      WHERE session_id = 's'
    `).run(), /immutable/i)
    assert.throws(() => database.prepare(`
      INSERT INTO caption_events(
        event_id, session_id, source_id, segment_id, sequence, revision,
        kind, t0_ms, t1_ms, text, created_at
      ) VALUES ('s:loopback:1', 's', 'loopback', 'seg', 1, 1, 'final', 0, 1, 'x', 1)
    `).run(), /foreign key/i)
    assert.throws(() => database.prepare(`
      INSERT INTO caption_events(
        event_id, session_id, source_id, segment_id, sequence, revision,
        kind, t0_ms, t1_ms, text, created_at
      ) VALUES ('s:mic:1', 's', 'mic', 'seg', 1, 1, 'translated', 0, 1, 'x', 1)
    `).run(), /constraint/i)
  } finally {
    database.close()
  }
})
