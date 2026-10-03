'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { FORMAL_AGENT_MIGRATIONS, FORMAL_AGENT_SCHEMA_VERSION } = require('../../src/runtime/storage-worker/schema')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')
const { PersonalContextStore } = require('../../src/runtime/storage-worker/personal-context-store')

test('SEM-F41/SEM-F42/DB1/DB7: v28 upgrades append-only without silently migrating legacy bodies; reopened governance retains checksum identity', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-memory-migration-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const databasePath = path.join(directory, 'memory.sqlite3')
  const old = new SqliteSubtitleStore({ databasePath, migrations: FORMAL_AGENT_MIGRATIONS.filter(m => m.version <= 28) })
  const context = new PersonalContextStore({ subtitleStore: old })
  const item = context.manage({ type: 'remember', expected_revision: context.contentRevision(), entry: { display_text: '升级前明确提供的合成正文', kind: 'project_fact', scope: { kind: 'global', reference: null } } }).item
  const checksums = old.database.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all(); old.close()
  for (let i = 0; i < 2; i++) {
    const current = new SqliteSubtitleStore({ databasePath, migrations: FORMAL_AGENT_MIGRATIONS })
    assert.equal(current.database.prepare('PRAGMA user_version').get().user_version, FORMAL_AGENT_SCHEMA_VERSION)
    assert.deepEqual(current.database.prepare('SELECT version,checksum FROM schema_migrations WHERE version<=28 ORDER BY version').all(), checksums)
    assert.equal(JSON.parse(current.database.prepare('SELECT content_json FROM personal_context_items WHERE memory_id=?').get(item.memory_id).content_json).displayText, '升级前明确提供的合成正文')
    assert.equal(current.database.prepare('SELECT count(*) n FROM personal_memory_files').get().n, 0)
    const blobs = current.database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().flatMap(({ name }) => current.database.prepare(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).all().filter(row => row.type === 'BLOB').map(row => `${name}.${row.name}`))
    assert.deepEqual(blobs, ['personal_memory_vectors.vector']); current.close()
  }
})
