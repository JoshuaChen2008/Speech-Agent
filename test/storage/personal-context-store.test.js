'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { canonicalize, sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')
const { createPersonalContextModule } = require('../../src/agent/personal-context')
const { ContextIngestSessionRunner } = require('../../src/agent/execution-host')
const { PersonalContextStore } = require('../../src/runtime/storage-worker/personal-context-store')
const { FormalAgentStore } = require('../../src/runtime/storage-worker/formal-agent-store')
const { FORMAL_AGENT_MIGRATIONS } = require('../../src/runtime/storage-worker/schema')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')

function fixture (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-context-store-'))
  const subtitleStore = new SqliteSubtitleStore({
    databasePath: path.join(root, 'context.sqlite3'),
    migrations: FORMAL_AGENT_MIGRATIONS,
    now: () => 1000
  })
  t.after(() => {
    subtitleStore.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { subtitleStore, store: new PersonalContextStore({ subtitleStore, now: () => 1000 }) }
}

function terminalSession (subtitleStore, sessionId = 'session-1') {
  subtitleStore.openSession({ sessionId, sourceId: 'mic', startedAt: 10, refinementEnabled: false })
  for (let index = 0; index < 2; index += 1) {
    subtitleStore.appendCaption({
      schemaVersion: 1,
      sessionId,
      sourceId: 'mic',
      segmentId: `segment-${index + 1}`,
      sequence: index + 1,
      revision: 1,
      kind: 'final',
      t0: index * 10,
      t1: (index + 1) * 10,
      text: `synthetic committed ${index + 1}`,
      translation: null
    })
  }
  subtitleStore.closeSession({ sessionId, sourceId: 'mic', endedAt: 40, state: 'closed' })
}

function frozenSource (database, sessionId = 'session-1', transcriptVersion = 'raw') {
  const events = database.prepare(`
    SELECT
      first_event.event_order AS first_event_order,
      updated_event.event_order AS updated_event_order,
      updated_event.kind AS updated_kind,
      segment.segment_id,
      first_event.text AS raw_text,
      segment.text AS current_text
    FROM segments AS segment
    JOIN caption_events AS first_event ON first_event.event_order = segment.first_event_order
    JOIN caption_events AS updated_event ON updated_event.event_order = segment.updated_event_order
    WHERE segment.session_id = ?
    ORDER BY first_event.event_order
  `).all(sessionId).map((row) => ({
    eventOrder: Number(transcriptVersion === 'refined' ? row.updated_event_order : row.first_event_order),
    segmentId: row.segment_id,
    text: transcriptVersion === 'refined' ? row.current_text : row.raw_text
  }))
  const inputWatermark = Number(database.prepare(
    'SELECT MAX(event_order) AS watermark FROM caption_events WHERE session_id = ?'
  ).get(sessionId).watermark)
  return {
    sourceKind: 'session',
    sessionId,
    transcriptVersion,
    inputWatermark,
    inputDigest: sha256Canonical({ sessionId, transcriptVersion, inputWatermark, events })
  }
}

function entry (semanticKey, displayText = semanticKey) {
  return {
    display_text: displayText,
    kind: 'project_fact',
    scope: { kind: 'global', reference: null },
    semantic_key: semanticKey
  }
}

test('SEM-F26/SEM-F30/J21: ingest rereads a terminal source and replays one bounded episode atomically', (t) => {
  const { subtitleStore, store } = fixture(t)
  terminalSession(subtitleStore)
  const source = frozenSource(subtitleStore.database)
  const first = store.ingest(source)
  const replay = store.ingest(source)
  assert.equal(first.replayed, false)
  assert.equal(replay.replayed, true)
  assert.equal(replay.runId, first.runId)
  assert.deepEqual({ ...subtitleStore.database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM formal_agent_runs) AS runs,
      (SELECT COUNT(*) FROM personal_context_episodes) AS episodes,
      (SELECT COUNT(*) FROM personal_context_items) AS memories
  `).get() }, { runs: 1, episodes: 1, memories: 0 })
  const summary = subtitleStore.database.prepare('SELECT summary_json FROM personal_context_episodes').get().summary_json
  assert.ok(Buffer.byteLength(summary, 'utf8') < 8192)
  assert.doesNotMatch(summary, /synthetic committed/)
  assert.throws(
    () => store.ingest({ ...source, inputDigest: 'f'.repeat(64) }),
    (error) => error?.code === 'AGENT_INPUT_CHANGED'
  )
})

test('SEM-F30/J21: manage revisions guard remember/update/forget/delete and exact replay', (t) => {
  const { store } = fixture(t)
  const remembered = store.manage({ type: 'remember', expected_revision: 0, entry: entry('alpha', 'Alpha') })
  assert.equal(remembered.revision, 1)
  assert.equal(remembered.item.lifecycle, 'active')
  assert.throws(
    () => store.manage({ type: 'remember', expected_revision: 1, entry: entry('alpha', 'Replacement') }),
    (error) => error?.code === 'AGENT_CONTEXT_OPERATION_FAILED'
  )
  assert.throws(
    () => store.manage({ type: 'update', expected_revision: 0, item_id: remembered.item.memory_id, item_revision: 1, entry: entry('alpha', 'Updated') }),
    (error) => error?.code === 'AGENT_CONTEXT_REVISION_CONFLICT'
  )
  const updated = store.manage({
    type: 'update', expected_revision: 1, item_id: remembered.item.memory_id,
    item_revision: 1, entry: entry('alpha', 'Updated')
  })
  const forgotten = store.manage({
    type: 'forget', expected_revision: 2, item_id: remembered.item.memory_id, item_revision: updated.item.item_revision
  })
  assert.equal(forgotten.item.lifecycle, 'forgotten')
  const deletion = store.manage({
    type: 'delete', expected_revision: 3, item_id: remembered.item.memory_id,
    item_revision: forgotten.item.item_revision, deletion_idempotency_key: 'delete-alpha'
  })
  const replay = store.manage({
    type: 'delete', expected_revision: deletion.revision, item_id: remembered.item.memory_id,
    item_revision: forgotten.item.item_revision, deletion_idempotency_key: 'delete-alpha'
  })
  assert.equal(deletion.replayed, false)
  assert.equal(replay.replayed, true)
  assert.deepEqual(replay.deleted, deletion.deleted)
})

test('SEM-F26/SEM-F30/J21: resolve uses normalized exact equality and whole-item budgets', (t) => {
  const { store } = fixture(t)
  let revision = 0
  for (let index = 0; index < 22; index += 1) {
    const result = store.manage({
      type: 'remember', expected_revision: revision,
      entry: entry(index === 0 ? 'alpha' : `key-${index}`, `Item ${index}`)
    })
    revision = result.revision
  }
  const exact = store.resolve({
    scope: { kind: 'project', reference: 'project-1' },
    semantic_keys: ['Ａlpha'],
    aliases: []
  })
  assert.equal(exact.personalMemories.length, 1)
  assert.equal(exact.personalMemories[0].semanticKey, 'alpha')
  const substring = store.resolve({
    scope: { kind: 'project', reference: 'project-1' },
    semantic_keys: ['Alp'],
    aliases: []
  })
  assert.equal(substring.personalMemories.length, 0)
  const bounded = store.resolve({
    scope: { kind: 'project', reference: 'project-1' },
    semantic_keys: [], aliases: []
  })
  assert.equal(bounded.personalMemories.length, 20)
  assert.equal(bounded.hasMore, true)
  assert.deepEqual(bounded.omissions, ['budget'])
})

test('SEM-F26/SEM-F30/J21: ingest rejects empty, active, mismatched and incomplete-refinement sources with zero writes', (t) => {
  const { subtitleStore, store } = fixture(t)
  subtitleStore.openSession({ sessionId: 'empty', sourceId: 'mic', startedAt: 1, refinementEnabled: false })
  subtitleStore.closeSession({ sessionId: 'empty', sourceId: 'mic', endedAt: 2, state: 'closed' })
  assert.throws(() => store.ingest({
    sourceKind: 'session', sessionId: 'empty', transcriptVersion: 'raw',
    inputWatermark: 1, inputDigest: 'a'.repeat(64)
  }), (error) => error?.code === 'AGENT_INPUT_EMPTY')

  subtitleStore.openSession({ sessionId: 'active', sourceId: 'mic', startedAt: 1, refinementEnabled: false })
  assert.throws(() => store.ingest({
    sourceKind: 'session', sessionId: 'active', transcriptVersion: 'raw',
    inputWatermark: 1, inputDigest: 'b'.repeat(64)
  }), (error) => error?.code === 'AGENT_SESSION_NOT_TERMINAL')
  subtitleStore.closeSession({ sessionId: 'active', sourceId: 'mic', endedAt: 2, state: 'closed' })

  terminalSession(subtitleStore, 'incomplete-refined')
  const incomplete = frozenSource(subtitleStore.database, 'incomplete-refined', 'refined')
  assert.throws(() => store.ingest(incomplete), (error) => error?.code === 'AGENT_INPUT_VERSION_UNAVAILABLE')
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_runs').get().count, 0)

  const source = frozenSource(subtitleStore.database, 'incomplete-refined')
  subtitleStore.database.exec(`
    CREATE TRIGGER inject_episode_failure BEFORE INSERT ON personal_context_episodes
    BEGIN SELECT RAISE(ABORT, 'injected episode failure'); END;
  `)
  assert.throws(() => store.ingest(source), /injected episode failure/)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_runs').get().count, 0)
})

test('SEM-F30/J21: explicit remember restores forgotten identity while delete key digest mismatches fail closed', (t) => {
  const { store } = fixture(t)
  const remembered = store.manage({ type: 'remember', expected_revision: 0, entry: entry('restore') })
  const forgotten = store.manage({
    type: 'forget', expected_revision: 1, item_id: remembered.item.memory_id, item_revision: 1
  })
  const restored = store.manage({ type: 'remember', expected_revision: 2, entry: entry('restore', 'Restored') })
  assert.equal(restored.item.memory_id, remembered.item.memory_id)
  assert.equal(restored.item.lifecycle, 'active')
  const deleted = store.manage({
    type: 'delete', expected_revision: 3, item_id: restored.item.memory_id,
    item_revision: restored.item.item_revision, deletion_idempotency_key: 'delete-restore'
  })
  assert.equal(deleted.replayed, false)
  assert.throws(() => store.manage({
    type: 'delete', expected_revision: 4, item_id: 'different-item',
    item_revision: forgotten.item.item_revision, deletion_idempotency_key: 'delete-restore'
  }), (error) => error?.code === 'AGENT_REQUEST_INVALID')
})

test('SEM-F26/SEM-F30/J21: a complete refinement is one selectable source version without raw mixing', (t) => {
  const { subtitleStore, store } = fixture(t)
  const sessionId = 'complete-refined'
  subtitleStore.openSession({ sessionId, sourceId: 'mic', startedAt: 1, refinementEnabled: true })
  subtitleStore.appendCaption({
    schemaVersion: 1, sessionId, sourceId: 'mic', segmentId: 'segment-1', sequence: 1,
    revision: 1, kind: 'final', t0: 0, t1: 10, text: 'synthetic raw', translation: null
  })
  subtitleStore.appendCaption({
    schemaVersion: 1, sessionId, sourceId: 'mic', segmentId: 'segment-1', sequence: 2,
    revision: 2, kind: 'refined', t0: 0, t1: 10, text: 'synthetic refined', translation: null
  })
  subtitleStore.closeSession({ sessionId, sourceId: 'mic', endedAt: 20, state: 'closed' })
  const result = store.ingest(frozenSource(subtitleStore.database, sessionId, 'refined'))
  assert.equal(result.replayed, false)
  const episode = subtitleStore.database.prepare(
    'SELECT transcript_version, input_digest FROM personal_context_episodes WHERE session_id = ?'
  ).get(sessionId)
  assert.deepEqual({ ...episode }, {
    transcript_version: 'refined',
    input_digest: frozenSource(subtitleStore.database, sessionId, 'refined').inputDigest
  })
})

test('SEM-F26/SEM-F30/J21: session deletion removes episodes and evidence while replaying all v5 tombstone counts', (t) => {
  const { subtitleStore, store } = fixture(t)
  terminalSession(subtitleStore, 'session-delete-context')
  store.ingest(frozenSource(subtitleStore.database, 'session-delete-context'))
  store.manage({
    type: 'remember', expected_revision: 1,
    entry: {
      display_text: 'Session-local explicit fact',
      kind: 'project_fact',
      scope: { kind: 'session', reference: 'session-delete-context' },
      semantic_key: 'session:local_fact'
    }
  })
  const oldAgentStore = new FormalAgentStore({ subtitleStore, now: () => 2000 })
  const input = { sessionId: 'session-delete-context', deletionIdempotencyKey: 'delete.session.context.1' }
  const deleted = oldAgentStore.deleteSessionData(input)
  const replay = oldAgentStore.deleteSessionData(input)
  assert.equal(deleted.deletedEpisodeCount, 1)
  assert.equal(deleted.deletedContextEvidenceCount, 0)
  assert.equal(deleted.deletedOrphanContextItemCount, 1)
  assert.deepEqual(replay, deleted)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM personal_context_episodes').get().count, 0)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM personal_context_items').get().count, 0)
  assert.equal(store.contentRevision(), 3)
})

test('SEM-F28/SEM-F30/J21: a controlled v5 run replays one claim attempt and settles through the real ingest seam', async (t) => {
  const { subtitleStore, store } = fixture(t)
  terminalSession(subtitleStore, 'session-scheduled')
  const source = frozenSource(subtitleStore.database, 'session-scheduled')
  const identity = {
    recipeId: 'context.ingest.session', sourceKind: 'session', sessionId: source.sessionId,
    transcriptVersion: source.transcriptVersion, inputWatermark: source.inputWatermark, inputDigest: source.inputDigest
  }
  const dedupeKey = sha256Canonical(identity)
  const requestDigest = sha256Canonical({ identity })
  subtitleStore.database.prepare(`
    INSERT INTO formal_agent_runs(
      run_id, dedupe_key, client_idempotency_key, request_digest, recipe_id, recipe_version,
      scope_json, scope_digest, transcript_version, input_watermark_json, input_digest,
      requested_by, state, attempt_count, max_attempts, next_attempt_at,
      lease_owner, lease_expires_at, lease_renewed_from_expires_at, cancel_requested_at,
      error_code, result_digest, result_summary_json, created_at, updated_at
    ) VALUES (?, ?, NULL, ?, 'context.ingest.session', '1', ?, ?, ?, ?, ?,
      'automatic', 'queued', 0, 3, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 1000, 1000)
  `).run(
    `run.${dedupeKey.slice(0, 48)}`, dedupeKey, requestDigest,
    canonicalize({ kind: 'session', reference: source.sessionId }),
    sha256Canonical({ kind: 'session', reference: source.sessionId }),
    source.transcriptVersion, canonicalize({ throughEventOrder: source.inputWatermark }), source.inputDigest
  )
  const claimRequest = { claimIdempotencyKey: 'claim.scheduled.1', owner: 'owner.scheduled', leaseMs: 5000 }
  const claim = store.claimNextFormalRun(claimRequest)
  assert.deepEqual(store.claimNextFormalRun(claimRequest), claim)

  const personalContext = createPersonalContextModule({
    storage: {
      personalContextIngest: async (value) => store.ingest(value),
      personalContextResolve: async (value) => store.resolve(value),
      personalContextManage: async (value) => store.manage(value)
    }
  })
  const runner = new ContextIngestSessionRunner({
    personalContext,
    storage: {
      completeFormalAgentRun: async (value) => store.completeFormalRun(value),
      failFormalAgentRun: async (value) => store.failFormalRun(value)
    }
  })
  await runner.run(claim)
  assert.equal(subtitleStore.database.prepare('SELECT state FROM formal_agent_runs').get().state, 'succeeded')
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM personal_context_episodes').get().count, 1)
  const replacement = new PersonalContextStore({ subtitleStore, now: () => 1000 })
  assert.equal(replacement.claimNextFormalRun({
    claimIdempotencyKey: 'claim.scheduled.2', owner: 'owner.replacement', leaseMs: 5000
  }), null)
})

test('SEM-F30/J21: resolve keeps ready terminal scope while reporting selection tails and excluded sessions', (t) => {
  const { subtitleStore, store } = fixture(t)
  terminalSession(subtitleStore, 'session-ready-range')
  store.ingest(frozenSource(subtitleStore.database, 'session-ready-range'))
  subtitleStore.openSession({ sessionId: 'session-empty-range', sourceId: 'mic', startedAt: 50, refinementEnabled: false })
  subtitleStore.closeSession({ sessionId: 'session-empty-range', sourceId: 'mic', endedAt: 60, state: 'closed' })
  subtitleStore.openSession({ sessionId: 'session-active-range', sourceId: 'mic', startedAt: 70, refinementEnabled: false })
  subtitleStore.appendCaption({
    schemaVersion: 1, sessionId: 'session-active-range', sourceId: 'mic', segmentId: 'segment-active',
    sequence: 1, revision: 1, kind: 'final', t0: 0, t1: 1, text: 'active synthetic', translation: null
  })

  const ranged = store.resolve({
    scope: { kind: 'date_range', reference: { from: 0, through: 100 } },
    semantic_keys: [], aliases: []
  })
  assert.equal(ranged.eligibility, 'ready')
  assert.equal(ranged.episodes.length, 1)
  assert.deepEqual(ranged.excludedScopes.map((item) => item.reason).sort(), [
    'no_committed_transcript', 'session_not_terminal'
  ])

  const selection = store.resolve({
    scope: { kind: 'selection', reference: { session_id: 'session-ready-range', through_event_order: 1 } },
    semantic_keys: [], aliases: []
  })
  assert.equal(selection.eligibility, 'ready')
  assert.deepEqual(selection.omissions, ['not_committed_tail'])
})
