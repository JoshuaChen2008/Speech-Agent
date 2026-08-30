'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { AgentMvpStore } = require('../../src/agent-core/storage/agent-store')
const { AGENT_MVP_MIGRATIONS } = require('../../src/agent-core/storage/schema')
const {
  FORMAL_AGENT_MEMORY_DELETION_SCHEMA_SQL,
  FORMAL_AGENT_MIGRATIONS,
  FORMAL_AGENT_SCHEMA_SQL,
  FORMAL_AGENT_SCHEMA_VERSION,
  SUBTITLE_BASE_MIGRATIONS
} = require('../../src/runtime/storage-worker/schema')
const { schemaPrivacyAudit, tableNames } = require('../../src/runtime/storage-worker/qualification')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')

function tempRoot (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-agent-schema-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function appendFinal (store, sessionId, text) {
  store.openSession({ sessionId, sourceId: 'loopback', startedAt: 100, refinementEnabled: false })
  store.appendCaption({
    schemaVersion: 1,
    sessionId,
    sourceId: 'loopback',
    segmentId: 'segment-1',
    sequence: 1,
    revision: 1,
    kind: 'final',
    t0: 0,
    t1: 1,
    text,
    translation: null
  })
  store.closeSession({ sessionId, sourceId: 'loopback', endedAt: 200, state: 'closed' })
}

test('DB7 / ADR 0010 / J21/J25 upgrades subtitle v2 through formal Agent v6 without changing subtitle facts', (t) => {
  const databasePath = path.join(tempRoot(t), 'formal.sqlite3')
  const base = new SqliteSubtitleStore({ databasePath, now: () => 1000 })
  appendFinal(base, 'formal-upgrade', 'synthetic committed transcript')
  const baseChecksums = base.database.prepare(
    'SELECT version, checksum FROM schema_migrations ORDER BY version'
  ).all().map((row) => ({ version: Number(row.version), checksum: row.checksum }))
  base.close()

  const formal = new SqliteSubtitleStore({
    databasePath,
    now: () => 2000,
    migrations: FORMAL_AGENT_MIGRATIONS
  })
  try {
    assert.equal(Number(formal.database.prepare('PRAGMA user_version').get().user_version), FORMAL_AGENT_SCHEMA_VERSION)
    assert.deepEqual(
      formal.database.prepare('SELECT version, checksum FROM schema_migrations WHERE version <= 2 ORDER BY version')
        .all().map((row) => ({ version: Number(row.version), checksum: row.checksum })),
      baseChecksums
    )
    assert.deepEqual(
      baseChecksums.map((entry) => entry.checksum),
      SUBTITLE_BASE_MIGRATIONS.map((entry) => entry.checksum)
    )
    assert.equal(formal.getSessionTranscript({ sessionId: 'formal-upgrade' }).segments[0].text, 'synthetic committed transcript')
    assert.deepEqual(tableNames(formal.database), [
      'agent_artifacts',
      'agent_claim_receipts',
      'agent_debug_messages',
      'agent_debug_threads',
      'agent_jobs',
      'agent_model_profile_models',
      'agent_model_profiles',
      'agent_model_purpose_assignments',
      'agent_model_run_bindings',
      'caption_events',
      'formal_agent_interactions',
      'formal_agent_report_presentations',
      'formal_agent_run_claim_receipts',
      'formal_agent_runs',
      'formal_agent_tool_calls',
      'legacy_imports',
      'memory_deletion_receipts',
      'memory_evidence',
      'memory_items',
      'memory_revisions',
      'memory_scopes',
      'memory_suppressions',
      'personal_context_deletion_receipts',
      'personal_context_episodes',
      'personal_context_evidence',
      'personal_context_items',
      'personal_context_projection_state',
      'personal_context_revisions',
      'personal_context_scopes',
      'personal_context_suppressions',
      'recognition_session_configs',
      'recognition_term_set_members',
      'recognition_term_sets',
      'recognition_terms',
      'refinement_session_results',
      'schema_migrations',
      'segments',
      'session_deletion_tombstones',
      'sessions'
    ])
    assert.deepEqual(schemaPrivacyAudit(formal.database, tableNames(formal.database)), {
      containsAudioPersistenceSchema: false,
      forbiddenColumns: [],
      blobColumnCount: 0
    })
  } finally {
    formal.close()
  }
})

test('ADR 0010 keeps isolated candidate v3 byte-stable and rejects cross-catalog opens', (t) => {
  assert.equal(AGENT_MVP_MIGRATIONS[2].checksum, 'b4edadc4f78b6ff37da5cdd879a1065328d2f57ddad299f39025e596a84dc2d2')
  assert.deepEqual(AGENT_MVP_MIGRATIONS.slice(0, 2), SUBTITLE_BASE_MIGRATIONS)
  assert.deepEqual(FORMAL_AGENT_MIGRATIONS.slice(0, 2), SUBTITLE_BASE_MIGRATIONS)
  assert.equal(FORMAL_AGENT_MIGRATIONS[2].checksum, '52b7eef5a0d024b92d424cc0e911aa1aee7cc0223ad3bacba41283558a988eff')
  assert.equal(FORMAL_AGENT_MIGRATIONS[3].checksum, '3c0174d2528f1d2a586779edef95d035ccbb55266fcbabd27b4fa17313c8759c')
  assert.notEqual(AGENT_MVP_MIGRATIONS[2].checksum, FORMAL_AGENT_MIGRATIONS[2].checksum)
  assert.doesNotMatch(FORMAL_AGENT_SCHEMA_SQL, /reference-output|deterministic-test/)
  assert.doesNotMatch(FORMAL_AGENT_MEMORY_DELETION_SCHEMA_SQL, /audio|pcm|wav|recording|path|credential|api_key/i)

  const root = tempRoot(t)
  const candidatePath = path.join(root, 'candidate.sqlite3')
  const candidate = new AgentMvpStore({ databasePath: candidatePath, now: () => 1000 })
  candidate.close()
  assert.throws(
    () => new SqliteSubtitleStore({ databasePath: candidatePath, migrations: FORMAL_AGENT_MIGRATIONS }),
    /checksum mismatch at version 3/
  )

  const formalPath = path.join(root, 'formal.sqlite3')
  const formal = new SqliteSubtitleStore({ databasePath: formalPath, migrations: FORMAL_AGENT_MIGRATIONS })
  formal.close()
  assert.throws(
    () => new AgentMvpStore({ databasePath: formalPath }),
    /checksum mismatch at version 3/
  )
})

test('DB7 / J24-B22 upgrades formal v3 suppression identity to one row per old source digest', (t) => {
  const databasePath = path.join(tempRoot(t), 'formal-v3-v4.sqlite3')
  const v3 = new SqliteSubtitleStore({
    databasePath,
    migrations: FORMAL_AGENT_MIGRATIONS.slice(0, 3),
    now: () => 1000
  })
  v3.database.prepare(`
    INSERT INTO memory_scopes(
      scope_id, kind, canonical_key, label, session_id, origin, lifecycle, created_at, updated_at
    ) VALUES ('scope-v3', 'global', 'global:v3', 'Global v3', NULL, 'user', 'active', 1, 1)
  `).run()
  v3.database.prepare(`
    INSERT INTO memory_suppressions(identity_hash, scope_id, source_digest, created_at)
    VALUES (?, 'scope-v3', ?, 1)
  `).run('a'.repeat(64), 'b'.repeat(64))
  v3.close()

  const v4 = new SqliteSubtitleStore({
    databasePath,
    migrations: FORMAL_AGENT_MIGRATIONS.slice(0, 5),
    now: () => 2000
  })
  try {
    v4.database.prepare(`
      INSERT INTO memory_suppressions(identity_hash, scope_id, source_digest, created_at)
      VALUES (?, 'scope-v3', ?, 2)
    `).run('a'.repeat(64), 'c'.repeat(64))
    assert.equal(v4.database.prepare(
      "SELECT COUNT(*) AS count FROM memory_suppressions WHERE identity_hash = ?"
    ).get('a'.repeat(64)).count, 2)
    assert.deepEqual(v4.database.prepare('PRAGMA table_info(memory_suppressions)').all()
      .filter((column) => Number(column.pk) > 0)
      .sort((left, right) => Number(left.pk) - Number(right.pk))
      .map((column) => column.name), ['identity_hash', 'source_digest'])
    assert.equal(Number(v4.database.prepare('PRAGMA user_version').get().user_version), 5)
  } finally {
    v4.close()
  }
})

test('DB7 formal Agent constraints reject candidate task semantics and sensitive schema expansion', (t) => {
  const databasePath = path.join(tempRoot(t), 'constraints.sqlite3')
  const store = new SqliteSubtitleStore({ databasePath, migrations: FORMAL_AGENT_MIGRATIONS, now: () => 1000 })
  try {
    appendFinal(store, 'formal-constraints', 'synthetic constraint transcript')
    const columns = store.database.prepare('PRAGMA table_info(agent_jobs)').all().map((row) => row.name)
    assert.equal(columns.includes('provider_kind'), true)
    assert.equal(columns.some((name) => /credential|api_key|audio|pcm|wav|recording|path|stack|error_message/i.test(name)), false)
    assert.throws(() => store.database.prepare(`
      INSERT INTO agent_jobs(
        job_id, run_id, dedupe_key, request_digest, session_id, plugin_id,
        artifact_kind, transcript_version, input_watermark, input_digest,
        recipe_version, provider, provider_kind, model, state, attempt_count,
        max_attempts, next_attempt_at, requested_by, created_at, updated_at
      ) VALUES (
        'job', 'run', ?, ?, 'formal-constraints', 'reference-structured-output',
        'reference-output', 'original', 1, ?, 'reference-output@1',
        'provider', 'cloud', 'model', 'queued', 0, 3, 1, 'automatic', 1, 1
      )
    `).run('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)), /constraint/i)
  } finally {
    store.close()
  }
})

test('SEM-F28/SEM-F34/DB7/J22/J24: v7 adds exact interaction, tool-call and presentation facts with four registered indexes', (t) => {
  const databasePath = path.join(tempRoot(t), 'formal-v7.sqlite3')
  const v6 = new SqliteSubtitleStore({
    databasePath,
    now: () => 1000,
    migrations: FORMAL_AGENT_MIGRATIONS.slice(0, 6)
  })
  appendFinal(v6, 'formal-v7-session', 'v6 facts remain immutable')
  const before = v6.database.prepare('SELECT COUNT(*) AS count FROM caption_events').get().count
  const v6Checksums = v6.database.prepare('SELECT version, checksum FROM schema_migrations ORDER BY version').all()
  v6.close()

  const store = new SqliteSubtitleStore({ databasePath, now: () => 2000, migrations: FORMAL_AGENT_MIGRATIONS })
  try {
    assert.equal(FORMAL_AGENT_SCHEMA_VERSION, 7)
    assert.equal(Number(store.database.prepare('PRAGMA user_version').get().user_version), 7)
    assert.equal(store.database.prepare('SELECT COUNT(*) AS count FROM caption_events').get().count, before)
    assert.deepEqual(
      store.database.prepare('SELECT version, checksum FROM schema_migrations WHERE version <= 6 ORDER BY version').all(),
      v6Checksums
    )
    assert.deepEqual(store.database.prepare('PRAGMA table_info(formal_agent_interactions)').all().map((row) => row.name), [
      'interaction_id', 'run_id', 'recipe_id', 'recipe_version', 'max_turns', 'tool_grants_json',
      'routing_mode', 'requested_by', 'scope_json', 'scope_digest', 'input_digest', 'prompt_digest',
      'terminal_reason', 'error_code', 'usage_json', 'duration_ms', 'attempt_count',
      'comparison_group_id', 'result_json', 'result_digest', 'created_at', 'terminal_at'
    ])
    assert.deepEqual(store.database.prepare('PRAGMA table_info(formal_agent_tool_calls)').all().map((row) => row.name), [
      'call_id', 'interaction_id', 'attempt', 'call_order', 'tool_name', 'schema_version',
      'started_offset_ms', 'ended_offset_ms', 'status', 'error_code', 'args_json', 'args_digest',
      'result_json', 'result_digest', 'source_refs_json', 'counts_json'
    ])
    assert.deepEqual(store.database.prepare('PRAGMA table_info(formal_agent_report_presentations)').all().map((row) => row.name), [
      'session_id', 'run_id', 'presented_at', 'created_at'
    ])
    assert.equal(store.database.prepare('PRAGMA table_info(session_deletion_tombstones)').all().some((row) => row.name === 'deleted_report_presentation_count'), true)
    for (const table of ['formal_agent_interactions', 'formal_agent_tool_calls', 'formal_agent_report_presentations']) {
      const tableInfo = store.database.prepare('PRAGMA table_list').all().find((row) => row.name === table)
      assert.equal(Number(tableInfo.strict), 1, `${table} must be STRICT`)
    }
    const forbidden = /model_binding_id|execution_form|escalation_reason|provider|model|amount|price|cost|currency|credential|audio|pcm|wav|recording|path|reasoning/i
    for (const table of ['formal_agent_interactions', 'formal_agent_tool_calls', 'formal_agent_report_presentations']) {
      assert.equal(store.database.prepare(`PRAGMA table_info(${table})`).all().some((row) => forbidden.test(row.name)), false, table)
    }
    const indexes = store.database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IN ('formal_agent_interactions_page', 'formal_agent_tool_calls_order', 'personal_context_items_page', 'personal_context_episodes_page') ORDER BY name").all().map((row) => row.name)
    assert.deepEqual(indexes, [
      'formal_agent_interactions_page', 'formal_agent_tool_calls_order',
      'personal_context_episodes_page', 'personal_context_items_page'
    ])
  } finally {
    store.close()
  }
})

test('SEM-F28/SEM-F34/DB7/J22/J24: v7 terminal and tool byte checks enforce cancellation, nullable usage and exact tool errors', (t) => {
  const store = new SqliteSubtitleStore({ databasePath: path.join(tempRoot(t), 'v7-checks.sqlite3'), now: () => 1000, migrations: FORMAL_AGENT_MIGRATIONS })
  const database = store.database
  try {
    const insertRun = (runId, clientKey) => database.prepare(`
      INSERT INTO formal_agent_runs(
        run_id, dedupe_key, client_idempotency_key, request_digest, recipe_id, recipe_version,
        scope_json, scope_digest, transcript_version, input_watermark_json, input_digest,
        requested_by, state, attempt_count, max_attempts, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'qa.answer', '1', '{}', ?, 'raw', '{}', ?, 'user', 'queued', 0, 3, 0, 1, 1)
    `).run(runId, `dedupe-${runId}`.padEnd(64, 'x'), clientKey, `request-${runId}`.padEnd(64, 'x'), 'c'.repeat(64), 'd'.repeat(64))
    insertRun('v7-run', 'v7-client')
    insertRun('v7-run-success', 'v7-client-success')
    insertRun('v7-run-failed', 'v7-client-failed')
    insertRun('v7-run-no-prompt', 'v7-client-no-prompt')
    const insertInteraction = database.prepare(`
      INSERT INTO formal_agent_interactions(
        interaction_id, run_id, recipe_id, recipe_version, max_turns, tool_grants_json,
        routing_mode, requested_by, scope_json, scope_digest, input_digest, prompt_digest,
        terminal_reason, error_code, usage_json, duration_ms, attempt_count, comparison_group_id,
        result_json, result_digest, created_at, terminal_at
      ) VALUES (?, ?, 'qa.answer', '1', ?, ?, ?, 'user', '{}', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    const validResult = '{"schemaVersion":1,"answer":"ok","sourceRefs":[],"memoryRefs":[],"unresolved":[]}'
    insertInteraction.run('v7-cancel', 'v7-run', 3, '["search_context"]', 'model', 'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64), 'cancelled', null, null, 30, 1, 'f'.repeat(64), null, null, 1, 2)
    assert.equal(database.prepare("SELECT terminal_reason, error_code, result_json, usage_json FROM formal_agent_interactions WHERE interaction_id='v7-cancel'").get().terminal_reason, 'cancelled')
    insertInteraction.run('v7-success', 'v7-run-success', 3, '["search_context"]', 'preset', 'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64), 'succeeded', null, '{"usageSource":"provider","inputTokens":1,"outputTokens":1,"cacheHitInputTokens":null,"cacheMissInputTokens":null}', 30, 1, 'f'.repeat(64), validResult, '1'.repeat(64), 1, 2)
    assert.throws(() => insertInteraction.run('v7-failed-without-error', 'v7-run-failed', 3, '["search_context"]', 'model', 'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64), 'failed', null, null, 30, 1, 'f'.repeat(64), null, null, 1, 2), /constraint/i)
    assert.throws(() => insertInteraction.run('v7-user-without-prompt', 'v7-run-no-prompt', 3, '["search_context"]', 'model', 'c'.repeat(64), 'd'.repeat(64), null, 'cancelled', null, null, 30, 1, 'f'.repeat(64), null, null, 1, 2), /constraint/i)

    database.prepare(`
      INSERT INTO formal_agent_tool_calls(
        call_id, interaction_id, attempt, call_order, tool_name, schema_version,
        started_offset_ms, ended_offset_ms, status, error_code, args_json, args_digest,
        result_json, result_digest, source_refs_json, counts_json
      ) VALUES ('v7-call', 'v7-success', 1, 1, 'search_context', 1, 0, 10, 'succeeded', NULL, '{}', ?, '{}', ?, '[]', '{}')
    `).run('1'.repeat(64), '2'.repeat(64))
    assert.throws(() => database.prepare(`
      INSERT INTO formal_agent_tool_calls(
        call_id, interaction_id, attempt, call_order, tool_name, schema_version,
        started_offset_ms, ended_offset_ms, status, error_code, args_json, args_digest,
        result_json, result_digest, source_refs_json, counts_json
      ) VALUES ('v7-call-too-large', 'v7-success', 1, 2, 'search_context', 1, 0, 10, 'succeeded', NULL, ?, ?, '{}', ?, '[]', '{}')
    `).run('x'.repeat(8193), '3'.repeat(64), '4'.repeat(64)), /constraint/i)
    assert.throws(() => database.prepare(`
      INSERT INTO formal_agent_tool_calls(
        call_id, interaction_id, attempt, call_order, tool_name, schema_version,
        started_offset_ms, ended_offset_ms, status, error_code, args_json, args_digest,
        result_json, result_digest, source_refs_json, counts_json
      ) VALUES ('v7-result-too-large', 'v7-success', 1, 3, 'search_context', 1, 0, 10, 'succeeded', NULL, '{}', ?, ?, ?, '[]', '{}')
    `).run('5'.repeat(64), 'x'.repeat(65537), '6'.repeat(64)), /constraint/i)
    assert.throws(() => database.prepare(`
      INSERT INTO formal_agent_tool_calls(
        call_id, interaction_id, attempt, call_order, tool_name, schema_version,
        started_offset_ms, ended_offset_ms, status, error_code, args_json, args_digest,
        result_json, result_digest, source_refs_json, counts_json
      ) VALUES ('v7-bad-tool', 'v7-success', 1, 4, 'shell', 1, 0, 10, 'failed', 'AGENT_INTERNAL_FAILURE', '{}', ?, NULL, NULL, '[]', '{}')
    `).run('7'.repeat(64)), /constraint/i)
  } finally {
    store.close()
  }
})

test('DB7 / J20/J21/J24 rejects cross-job, cross-memory and recognition snapshot mismatches', (t) => {
  const databasePath = path.join(tempRoot(t), 'identity-constraints.sqlite3')
  const store = new SqliteSubtitleStore({ databasePath, migrations: FORMAL_AGENT_MIGRATIONS, now: () => 1000 })
  const database = store.database
  try {
    appendFinal(store, 'identity-session', 'synthetic identity transcript')
    database.prepare(`
      INSERT INTO agent_jobs(
        job_id, run_id, dedupe_key, request_digest, session_id, plugin_id,
        artifact_kind, transcript_version, input_watermark, input_digest,
        recipe_version, provider, provider_kind, model, state, attempt_count,
        max_attempts, next_attempt_at, requested_by, created_at, updated_at
      ) VALUES (
        'identity-job', 'identity-run', ?, ?, 'identity-session', 'meeting-minutes',
        'meeting-minutes', 'original', 1, ?, 'meeting-minutes@1',
        'provider', 'cloud', 'model', 'queued', 0, 3, 1, 'automatic', 1, 1
      )
    `).run('a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64))
    database.prepare(`
      INSERT INTO agent_jobs(
        job_id, run_id, dedupe_key, request_digest, session_id, plugin_id,
        artifact_kind, transcript_version, input_watermark, input_digest,
        recipe_version, provider, provider_kind, model, state, attempt_count,
        max_attempts, next_attempt_at, requested_by, created_at, updated_at
      ) VALUES (
        'memory-job', 'memory-run', ?, ?, 'identity-session', 'memory-extraction',
        'memory-candidates', 'original', 1, ?, 'memory-extraction@1',
        'provider', 'cloud', 'model', 'queued', 0, 3, 1, 'automatic', 1, 1
      )
    `).run('f'.repeat(64), 'g'.repeat(64), 'h'.repeat(64))
    assert.throws(() => database.prepare(`
      INSERT INTO agent_artifacts(
        artifact_id, run_id, session_id, plugin_id, type, content_json, content_digest,
        transcript_version, input_through_event_order, input_digest, recipe_version,
        provider, model, created_at
      ) VALUES (
        'artifact-mismatch', 'identity-run', 'identity-session', 'meeting-minutes',
        'meeting-minutes', '{}', ?, 'original', 1, ?, 'meeting-minutes@1',
        'provider', 'wrong-model', 2
      )
    `).run('d'.repeat(64), 'c'.repeat(64)), /foreign key/i)

    database.prepare(`
      INSERT INTO memory_scopes(
        scope_id, kind, canonical_key, label, session_id, origin, lifecycle, created_at, updated_at
      ) VALUES ('scope-global', 'global', 'global', 'Global', NULL, 'user', 'active', 1, 1)
    `).run()
    for (const id of ['memory-a', 'memory-b']) {
      database.prepare(`
        INSERT INTO memory_items(
          memory_id, scope_id, kind, semantic_key, content_json, origin,
          confidence_band, salience_band, lifecycle, current_revision_id, created_at, updated_at
        ) VALUES (?, 'scope-global', 'decision', ?, '{}', 'explicit', 'high', 'high', 'active', NULL, 1, 1)
      `).run(id, id)
      database.prepare(`
        INSERT INTO memory_revisions(
          revision_id, memory_id, operation, content_json, previous_revision_id, run_id, created_at
        ) VALUES (?, ?, 'create', '{}', NULL, NULL, 1)
      `).run(`revision-${id}`, id)
    }
    assert.throws(() => database.prepare(`
      UPDATE memory_items SET current_revision_id = 'revision-memory-b' WHERE memory_id = 'memory-a'
    `).run(), /foreign key/i)
    assert.throws(() => database.prepare(`
      INSERT INTO memory_revisions(
        revision_id, memory_id, operation, content_json, previous_revision_id, run_id, created_at
      ) VALUES ('revision-cross-previous', 'memory-a', 'merge', '{}', 'revision-memory-b', NULL, 2)
    `).run(), /foreign key/i)
    assert.throws(() => database.prepare(`
      INSERT INTO memory_evidence(
        evidence_id, run_id, memory_id, session_id, transcript_version, input_watermark,
        from_event_order, through_event_order, input_digest,
        plugin_id, recipe_version, provider, model, created_at
      ) VALUES (
        'evidence-wrong-task', 'identity-run', 'memory-a', 'identity-session', 'original', 1,
        1, 1, ?, 'memory-extraction', 'memory-extraction@1', 'provider', 'model', 2
      )
    `).run('c'.repeat(64)), /foreign key/i)
    assert.throws(() => database.prepare(`
      INSERT INTO memory_evidence(
        evidence_id, run_id, memory_id, session_id, transcript_version, input_watermark,
        from_event_order, through_event_order, input_digest,
        plugin_id, recipe_version, provider, model, created_at
      ) VALUES (
        'evidence-wrong-provider-snapshot', 'memory-run', 'memory-a', 'identity-session', 'original', 1,
        1, 1, ?, 'memory-extraction', 'memory-extraction@1', 'provider', 'wrong-model', 2
      )
    `).run('h'.repeat(64)), /foreign key/i)
    database.prepare(`
      INSERT INTO memory_evidence(
        evidence_id, run_id, memory_id, session_id, transcript_version, input_watermark,
        from_event_order, through_event_order, input_digest,
        plugin_id, recipe_version, provider, model, created_at
      ) VALUES (
        'evidence-valid', 'memory-run', 'memory-a', 'identity-session', 'original', 1,
        1, 1, ?, 'memory-extraction', 'memory-extraction@1', 'provider', 'model', 2
      )
    `).run('h'.repeat(64))
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM memory_evidence').get().count, 1)

    database.prepare(`
      INSERT INTO recognition_terms(
        term_id, scope_id, canonical_text, aliases_json, proposal_origin,
        source_memory_identity_hash, revision, active, created_at, updated_at
      ) VALUES ('term-1', 'scope-global', 'Canonical', '["Alias"]', 'manual', NULL, 1, 1, 1, 1)
    `).run()
    database.prepare(`
      INSERT INTO recognition_term_sets(term_set_version, digest, created_at)
      VALUES (1, ?, 1)
    `).run('e'.repeat(64))
    assert.throws(() => database.prepare(`
      INSERT INTO recognition_term_set_members(
        term_set_version, term_id, term_revision, canonical_text, aliases_json, matched_aliases_json
      ) VALUES (1, 'term-1', 1, 'Wrong', '["Alias"]', '[]')
    `).run(), /snapshot mismatch/i)
    assert.throws(() => database.prepare(`
      INSERT INTO recognition_term_set_members(
        term_set_version, term_id, term_revision, canonical_text, aliases_json, matched_aliases_json
      ) VALUES (2, 'term-1', 1, 'Canonical', '["Alias"]', '[]')
    `).run(), /foreign key/i)
    assert.throws(() => database.prepare(`
      INSERT INTO recognition_session_configs(
        session_id, strategy, primary_provider, fallback_provider,
        term_set_version, term_set_digest, fallback_code, fallback_at_ms
      ) VALUES ('identity-session', 'local-only', 'local', NULL, 1, ?, NULL, NULL)
    `).run('f'.repeat(64)), /foreign key/i)
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok')
  } finally {
    store.close()
  }
})
