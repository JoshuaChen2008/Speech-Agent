'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  FORMAL_AGENT_MIGRATIONS,
  FORMAL_AGENT_SCHEMA_VERSION,
  PERSONAL_CONTEXT_SCHEMA_SQL
} = require('../../src/runtime/storage-worker/schema')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')

function databasePath (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-context-schema-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return path.join(root, 'context.sqlite3')
}

function tableNames (database) {
  return database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map((row) => row.name)
}

test('SEM-F30/DB7/J21: formal v4 upgrades by appending byte-stable migration v5', (t) => {
  const file = databasePath(t)
  const v4Checksums = FORMAL_AGENT_MIGRATIONS.slice(0, 4).map(({ checksum }) => checksum)
  const v4 = new SqliteSubtitleStore({ databasePath: file, migrations: FORMAL_AGENT_MIGRATIONS.slice(0, 4) })
  v4.openSession({ sessionId: 'upgrade-v5', sourceId: 'mic', startedAt: 1, refinementEnabled: false })
  v4.closeSession({ sessionId: 'upgrade-v5', sourceId: 'mic', endedAt: 2, state: 'closed' })
  v4.close()

  const v5 = new SqliteSubtitleStore({ databasePath: file, migrations: FORMAL_AGENT_MIGRATIONS })
  try {
    assert.equal(FORMAL_AGENT_SCHEMA_VERSION, 5)
    assert.equal(Number(v5.database.prepare('PRAGMA user_version').get().user_version), 5)
    assert.deepEqual(
      v5.database.prepare('SELECT checksum FROM schema_migrations WHERE version <= 4 ORDER BY version')
        .all().map(({ checksum }) => checksum),
      v4Checksums
    )
    assert.equal(v5.database.prepare("SELECT state FROM sessions WHERE session_id = 'upgrade-v5'").get().state, 'closed')
    for (const name of [
      'formal_agent_runs',
      'formal_agent_run_claim_receipts',
      'personal_context_projection_state',
      'personal_context_scopes',
      'personal_context_items',
      'personal_context_revisions',
      'personal_context_evidence',
      'personal_context_suppressions',
      'personal_context_deletion_receipts',
      'personal_context_episodes'
    ]) assert.equal(tableNames(v5.database).includes(name), true, name)
    assert.deepEqual(
      v5.database.prepare('PRAGMA table_info(session_deletion_tombstones)').all()
        .map((row) => row.name).filter((name) => name.startsWith('deleted_') && name !== 'deleted_at'),
      [
        'deleted_job_count',
        'deleted_artifact_count',
        'deleted_debug_thread_count',
        'deleted_memory_evidence_count',
        'deleted_orphan_memory_count',
        'deleted_interaction_count',
        'deleted_tool_call_count',
        'deleted_episode_count',
        'deleted_context_evidence_count',
        'deleted_orphan_context_item_count'
      ]
    )
  } finally {
    v5.close()
  }
})

test('SEM-F28/SEM-F30/DB7/J21: v5 enforces independent error and exact-one source constraints', (t) => {
  const store = new SqliteSubtitleStore({ databasePath: databasePath(t), migrations: FORMAL_AGENT_MIGRATIONS })
  const database = store.database
  try {
    database.prepare(`
      INSERT INTO formal_agent_runs(
        run_id, dedupe_key, request_digest, recipe_id, recipe_version,
        scope_json, scope_digest, transcript_version, input_watermark_json,
        input_digest, requested_by, state, attempt_count, max_attempts,
        next_attempt_at, error_code, created_at, updated_at
      ) VALUES ('run-budget', ?, ?, 'context.ingest.session', '1', '{}', ?,
        'raw', '{}', ?, 'automatic', 'failed', 1, 3, 0,
        'AGENT_BUDGET_EXCEEDED', 1, 1)
    `).run('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64))
    assert.throws(() => database.prepare(`
      INSERT INTO formal_agent_runs(
        run_id, dedupe_key, request_digest, recipe_id, recipe_version,
        scope_json, scope_digest, transcript_version, input_watermark_json,
        input_digest, requested_by, state, attempt_count, max_attempts,
        next_attempt_at, error_code, created_at, updated_at
      ) VALUES ('run-invalid', ?, ?, 'context.ingest.session', '1', '{}', ?,
        'raw', '{}', ?, 'automatic', 'failed', 1, 3, 0,
        'TOOL_TIMEOUT', 1, 1)
    `).run('e'.repeat(64), 'f'.repeat(64), '0'.repeat(64), '1'.repeat(64)), /constraint/i)

    database.prepare(`
      INSERT INTO personal_context_scopes(
        scope_id, kind, canonical_key, label, session_id, origin, lifecycle, created_at, updated_at
      ) VALUES ('scope', 'global', 'global', 'Global', NULL, 'user', 'active', 1, 1)
    `).run()
    for (const table of ['personal_context_episodes', 'personal_context_evidence']) {
      const isEpisode = table === 'personal_context_episodes'
      const columns = isEpisode
        ? 'episode_id, source_kind, session_id, interaction_id, scope_id, transcript_version, input_watermark, from_event_order, through_event_order, input_digest, summary_json, occurred_from_offset_ms, occurred_through_offset_ms, ingest_run_id, lifecycle, created_at, updated_at'
        : 'evidence_id, ingest_run_id, memory_id, source_kind, session_id, interaction_id, transcript_version, input_watermark, from_event_order, through_event_order, input_digest, recipe_id, recipe_version, created_at'
      const values = isEpisode
        ? "'episode', 'session', NULL, NULL, 'scope', 'raw', 1, 1, 1, '2b', '{}', 0, 0, 'run-budget', 'active', 1, 1"
        : "'evidence', 'run-budget', 'missing', 'session', NULL, NULL, 'raw', 1, 1, 1, '2b', 'context.ingest.session', '1', 1"
      assert.throws(() => database.prepare(`INSERT INTO ${table}(${columns}) VALUES (${values})`).run(), /constraint/i)
    }
    assert.match(PERSONAL_CONTEXT_SCHEMA_SQL, /AGENT_BUDGET_EXCEEDED/)
  } finally {
    store.close()
  }
})

test('SEM-F14/SEM-F30/DB7/J21: v5 schema contains no sensitive persistence columns', () => {
  assert.doesNotMatch(PERSONAL_CONTEXT_SCHEMA_SQL, /\b(api_key|credential|audio|pcm|wav|recording_path|device_name|error_message|stack|transcript_text)\b/i)
})

test('SEM-F30/DB7/J21: a failed v5 migration leaves the v4 database recoverable and fails closed', (t) => {
  const file = databasePath(t)
  const v4 = new SqliteSubtitleStore({ databasePath: file, migrations: FORMAL_AGENT_MIGRATIONS.slice(0, 4) })
  v4.close()
  const broken = [
    ...FORMAL_AGENT_MIGRATIONS.slice(0, 4),
    Object.freeze({
      ...FORMAL_AGENT_MIGRATIONS[4],
      sql: `${PERSONAL_CONTEXT_SCHEMA_SQL}\nCREATE TABLE invalid migration syntax;`
    })
  ]
  assert.throws(() => new SqliteSubtitleStore({ databasePath: file, migrations: broken }), /syntax|migration/i)

  const recovered = new SqliteSubtitleStore({ databasePath: file, migrations: FORMAL_AGENT_MIGRATIONS })
  try {
    assert.equal(Number(recovered.database.prepare('PRAGMA user_version').get().user_version), 5)
    assert.equal(recovered.database.prepare(
      'SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 5'
    ).get().count, 1)
  } finally {
    recovered.close()
  }
})
