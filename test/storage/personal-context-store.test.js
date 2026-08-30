'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { canonicalize, sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')
const { createPersonalContextModule } = require('../../src/agent/personal-context')
const { ContextIngestSessionRunner } = require('../../src/agent/execution-host')
const {
  PersonalContextStore,
  normalizeSemanticKey
} = require('../../src/runtime/storage-worker/personal-context-store')
const { FormalAgentStore } = require('../../src/runtime/storage-worker/formal-agent-store')
const { FORMAL_AGENT_MIGRATIONS } = require('../../src/runtime/storage-worker/schema')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')

function fixture (t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-context-store-'))
  const now = typeof options.now === 'function' ? options.now : () => 1000
  const subtitleStore = new SqliteSubtitleStore({
    databasePath: path.join(root, 'context.sqlite3'),
    migrations: FORMAL_AGENT_MIGRATIONS,
    now
  })
  t.after(() => {
    subtitleStore.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { subtitleStore, store: new PersonalContextStore({ subtitleStore, now }) }
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

function entry (displayText) {
  return {
    display_text: displayText,
    kind: 'project_fact',
    scope: { kind: 'global', reference: null }
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
  const remembered = store.manage({ type: 'remember', expected_revision: 0, entry: entry('Alpha') })
  assert.equal(remembered.revision, 1)
  assert.equal(remembered.item.lifecycle, 'active')
  assert.throws(
    () => store.manage({ type: 'remember', expected_revision: 1, entry: entry('Ａlpha') }),
    (error) => error?.code === 'AGENT_CONTEXT_OPERATION_FAILED'
  )
  assert.throws(
    () => store.manage({ type: 'update', expected_revision: 0, item_id: remembered.item.memory_id, item_revision: 1, entry: entry('Updated') }),
    (error) => error?.code === 'AGENT_CONTEXT_REVISION_CONFLICT'
  )
  const updated = store.manage({
    type: 'update', expected_revision: 1, item_id: remembered.item.memory_id,
    item_revision: 1, entry: entry('Updated')
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

test('SEM-F30/J21: storage derives semantic keys from display text at Unicode code-point boundaries', (t) => {
  const { store } = fixture(t)
  assert.equal(normalizeSemanticKey('  Ａ\tB  ß  ﬃ  '), 'a b ss ffi')
  const truncated = normalizeSemanticKey('😀'.repeat(100))
  assert.ok(Buffer.byteLength(truncated, 'utf8') <= 256)
  assert.doesNotMatch(truncated, /[\uD800-\uDBFF]$/)
  assert.throws(() => normalizeSemanticKey(' \t\n '), (error) => error?.code === 'AGENT_REQUEST_INVALID')

  const remembered = store.manage({
    type: 'remember', expected_revision: 0,
    entry: { display_text: '  Ａ\tB  ß  ', kind: 'term', scope: { kind: 'global', reference: null } }
  })
  assert.equal(remembered.item.semanticKey, 'a b ss')
  assert.throws(() => store.manage({
    type: 'remember', expected_revision: 1,
    entry: {
      display_text: 'Renderer key', kind: 'term', scope: { kind: 'global', reference: null },
      semantic_key: 'renderer-key'
    }
  }), (error) => error?.code === 'AGENT_REQUEST_INVALID')

  const other = store.manage({ type: 'remember', expected_revision: 1, entry: entry('Other identity') })
  assert.throws(() => store.manage({
    type: 'update', expected_revision: 2,
    item_id: remembered.item.memory_id, item_revision: remembered.item.item_revision,
    entry: entry('Other identity')
  }), (error) => error?.code === 'AGENT_CONTEXT_REVISION_CONFLICT')
  assert.equal(store.contentRevision(), other.revision)
})

test('SEM-F30/J21: memory and episode views use opaque keyset cursors without offset drift', (t) => {
  let current = 1000
  const { subtitleStore, store } = fixture(t, { now: () => ++current })
  const originalIds = []
  for (const [index, text] of ['Alpha page', 'Beta page', 'Gamma page'].entries()) {
    originalIds.push(store.manage({
      type: 'remember', expected_revision: index, entry: entry(text)
    }).item.memory_id)
  }
  const first = store.manage({ type: 'view', resource: 'personal_memories', limit: 2, cursor: null })
  assert.equal(first.rows.length, 2)
  assert.equal(first.hasMore, true)
  assert.doesNotMatch(first.nextCursor, /^offset_/)
  store.manage({ type: 'remember', expected_revision: 3, entry: entry('Inserted after first page') })
  const second = store.manage({
    type: 'view', resource: 'personal_memories', limit: 2, cursor: first.nextCursor
  })
  assert.equal(second.hasMore, false)
  assert.deepEqual(
    [...first.rows, ...second.rows].map((item) => item.memory_id).sort(),
    originalIds.sort()
  )
  assert.throws(() => store.manage({
    type: 'view', resource: 'personal_memories', limit: 2, cursor: 'offset_2'
  }), (error) => error?.code === 'AGENT_REQUEST_INVALID')

  for (const sessionId of ['page-session-a', 'page-session-b']) {
    terminalSession(subtitleStore, sessionId)
    store.ingest(frozenSource(subtitleStore.database, sessionId))
  }
  const episodeFirst = store.manage({ type: 'view', resource: 'session_episodes', limit: 1, cursor: null })
  const episodeSecond = store.manage({
    type: 'view', resource: 'session_episodes', limit: 1, cursor: episodeFirst.nextCursor
  })
  assert.notEqual(episodeFirst.rows[0].episode_id, episodeSecond.rows[0].episode_id)
  assert.equal(episodeSecond.nextCursor, null)
  assert.throws(() => store.manage({
    type: 'view', resource: 'session_episodes', limit: 1, cursor: first.nextCursor
  }), (error) => error?.code === 'AGENT_REQUEST_INVALID')

  const { store: tiedStore } = fixture(t)
  for (const [index, text] of ['Tie one', 'Tie two', 'Tie three'].entries()) {
    tiedStore.manage({ type: 'remember', expected_revision: index, entry: entry(text) })
  }
  const expectedTieOrder = tiedStore.database.prepare(`
    SELECT memory_id FROM personal_context_items ORDER BY updated_at DESC, memory_id DESC
  `).all().map((row) => row.memory_id)
  const tiedFirst = tiedStore.manage({ type: 'view', resource: 'personal_memories', limit: 2, cursor: null })
  const tiedSecond = tiedStore.manage({
    type: 'view', resource: 'personal_memories', limit: 2, cursor: tiedFirst.nextCursor
  })
  assert.deepEqual(
    [...tiedFirst.rows, ...tiedSecond.rows].map((item) => item.memory_id),
    expectedTieOrder
  )

  const { store: expiredStore } = fixture(t)
  const expiredItems = ['Expired cursor one', 'Expired cursor two'].map((text, index) =>
    expiredStore.manage({ type: 'remember', expected_revision: index, entry: entry(text) }).item)
  const expiredPage = expiredStore.manage({
    type: 'view', resource: 'personal_memories', limit: 1, cursor: null
  })
  const cursorItem = expiredItems.find((item) => item.memory_id === expiredPage.rows[0].memory_id)
  expiredStore.manage({
    type: 'delete', expected_revision: 2, item_id: cursorItem.memory_id,
    item_revision: cursorItem.item_revision, deletion_idempotency_key: 'delete-expired-cursor'
  })
  assert.throws(() => expiredStore.manage({
    type: 'view', resource: 'personal_memories', limit: 1, cursor: expiredPage.nextCursor
  }), (error) => error?.code === 'AGENT_REQUEST_INVALID')
})

test('SEM-F30/J21: scope directory exposes only bounded automatic scopes and remember cannot create one', (t) => {
  const { subtitleStore, store } = fixture(t)
  terminalSession(subtitleStore, 'scope-directory-session')
  store.ingest(frozenSource(subtitleStore.database, 'scope-directory-session'))
  subtitleStore.database.prepare(`
    INSERT INTO personal_context_scopes(
      scope_id, kind, canonical_key, label, session_id, origin, lifecycle, created_at, updated_at
    ) VALUES
      ('scope.topic.automatic', 'topic', 'topic:automatic', 'Automatic topic', NULL, 'automatic', 'active', 1000, 1000),
      ('scope.project.automatic', 'project', 'project:automatic', 'Automatic project', NULL, 'automatic', 'active', 1000, 1000),
      ('scope.project.user', 'project', 'project:user', 'User-created project', NULL, 'user', 'active', 1000, 1000)
  `).run()
  const directory = store.manage({ type: 'view', resource: 'scope_directory', limit: 50, cursor: null })
  assert.deepEqual(directory.rows.map((scope) => scope.kind).sort(), ['project', 'session', 'topic'])
  assert.equal(directory.rows.some((scope) => scope.scopeId === 'scope.project.user'), false)
  const insertScope = subtitleStore.database.prepare(`
    INSERT INTO personal_context_scopes(
      scope_id, kind, canonical_key, label, session_id, origin, lifecycle, created_at, updated_at
    ) VALUES (?, 'project', ?, ?, NULL, 'automatic', 'active', 1000, 1000)
  `)
  for (let index = 0; index < 48; index += 1) {
    insertScope.run(`scope.project.extra.${index}`, `project:extra:${index}`, `Automatic project ${index}`)
  }
  const boundedDirectory = store.manage({ type: 'view', resource: 'scope_directory', limit: 50, cursor: null })
  assert.equal(boundedDirectory.rows.length, 50)
  assert.equal(boundedDirectory.hasMore, true)
  const project = store.manage({
    type: 'remember', expected_revision: 1,
    entry: {
      display_text: 'Project-only preference', kind: 'preference',
      scope: { kind: 'project', reference: 'scope.project.automatic' }
    }
  })
  assert.equal(project.item.scope.reference, 'scope.project.automatic')
  assert.throws(() => store.manage({
    type: 'remember', expected_revision: 2,
    entry: {
      display_text: 'Unknown project', kind: 'project_fact',
      scope: { kind: 'project', reference: 'scope.project.unknown' }
    }
  }), (error) => error?.code === 'AGENT_REQUEST_INVALID')
})

test('SEM-F26/SEM-F30/J21: resolve uses normalized exact equality and whole-item budgets', (t) => {
  const { store } = fixture(t)
  let revision = 0
  for (let index = 0; index < 22; index += 1) {
    const result = store.manage({
      type: 'remember', expected_revision: revision,
      entry: entry(index === 0 ? 'Ａlpha' : `Item ${index}`)
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

test('SEM-F26/SEM-F30/J21: ingest rejects empty, active, mismatched and incomplete-refinement frozen sources', (t) => {
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

  terminalSession(subtitleStore, 'rollback-session')
  const source = frozenSource(subtitleStore.database, 'rollback-session')
  subtitleStore.database.exec(`
    CREATE TRIGGER inject_episode_failure BEFORE INSERT ON personal_context_episodes
    BEGIN SELECT RAISE(ABORT, 'injected episode failure'); END;
  `)
  assert.throws(() => store.ingest(source), /injected episode failure/)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_runs').get().count, 0)
})

test('SEM-F30/J21: resolve restricts memories to the requested scope and omits a whole item above the source budget', (t) => {
  const { subtitleStore, store } = fixture(t)
  terminalSession(subtitleStore, 'scope-session-a')
  const ingested = store.ingest(frozenSource(subtitleStore.database, 'scope-session-a'))
  terminalSession(subtitleStore, 'scope-session-b')
  store.ingest(frozenSource(subtitleStore.database, 'scope-session-b'))
  const scopeA = subtitleStore.database.prepare(
    "SELECT scope_id FROM personal_context_scopes WHERE canonical_key = 'session:scope-session-a'"
  ).get().scope_id
  const scopeB = subtitleStore.database.prepare(
    "SELECT scope_id FROM personal_context_scopes WHERE canonical_key = 'session:scope-session-b'"
  ).get().scope_id
  const global = store.manage({ type: 'remember', expected_revision: 2, entry: entry('global-key') })
  store.manage({
    type: 'remember', expected_revision: 3,
    entry: {
      display_text: 'Session A', kind: 'project_fact',
      scope: { kind: 'session', reference: scopeA }
    }
  })
  store.manage({
    type: 'remember', expected_revision: 4,
    entry: {
      display_text: 'Session B', kind: 'project_fact',
      scope: { kind: 'session', reference: scopeB }
    }
  })
  const scoped = store.resolve({
    scope: { kind: 'session', reference: 'scope-session-a' }, semantic_keys: [], aliases: []
  })
  assert.deepEqual(scoped.personalMemories.map((item) => item.semanticKey).sort(), ['global-key', 'session a'])

  const insertEvidence = subtitleStore.database.prepare(`
    INSERT INTO personal_context_evidence(
      evidence_id, ingest_run_id, memory_id, source_kind, session_id, interaction_id,
      transcript_version, input_watermark, from_event_order, through_event_order,
      input_digest, recipe_id, recipe_version, created_at
    ) VALUES (?, ?, ?, 'session', 'scope-session-a', NULL, 'raw', 2, 1, 2, ?, 'context.ingest.session', '1', 1000)
  `)
  for (let index = 0; index < 9; index += 1) {
    insertEvidence.run(`evidence.${index}`, ingested.runId, global.item.memory_id, String(index).padStart(64, '0'))
  }
  const overSourceBudget = store.resolve({
    scope: { kind: 'session', reference: 'scope-session-a' }, semantic_keys: ['global-key'], aliases: []
  })
  assert.equal(overSourceBudget.personalMemories.length, 0)
  assert.deepEqual(overSourceBudget.omissions, ['budget'])
  assert.equal(overSourceBudget.hasMore, true)
})

test('SEM-F30/J21: explicit remember restores forgotten identity while delete key digest mismatches fail closed', (t) => {
  const { store } = fixture(t)
  const remembered = store.manage({ type: 'remember', expected_revision: 0, entry: entry('Restore') })
  const forgotten = store.manage({
    type: 'forget', expected_revision: 1, item_id: remembered.item.memory_id, item_revision: 1
  })
  const restored = store.manage({ type: 'remember', expected_revision: 2, entry: entry('Restore') })
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
  const targetRun = store.ingest(frozenSource(subtitleStore.database, 'session-delete-context'))
  const targetScopeId = subtitleStore.database.prepare(
    "SELECT scope_id FROM personal_context_scopes WHERE canonical_key = 'session:session-delete-context'"
  ).get().scope_id
  store.manage({
    type: 'remember', expected_revision: 1,
    entry: {
      display_text: 'Session-local explicit fact',
      kind: 'project_fact',
      scope: { kind: 'session', reference: targetScopeId }
    }
  })
  terminalSession(subtitleStore, 'session-delete-other')
  const otherRun = store.ingest(frozenSource(subtitleStore.database, 'session-delete-other'))
  const shared = store.manage({
    type: 'remember', expected_revision: 3, entry: entry('shared-fact')
  })
  const insertEvidence = subtitleStore.database.prepare(`
    INSERT INTO personal_context_evidence(
      evidence_id, ingest_run_id, memory_id, source_kind, session_id, interaction_id,
      transcript_version, input_watermark, from_event_order, through_event_order,
      input_digest, recipe_id, recipe_version, created_at
    ) VALUES (?, ?, ?, 'session', ?, NULL, 'raw', ?, ?, ?, ?, 'context.ingest.session', '1', 1000)
  `)
  for (const [suffix, run, sessionId] of [
    ['target', targetRun, 'session-delete-context'], ['other', otherRun, 'session-delete-other']
  ]) {
    const source = frozenSource(subtitleStore.database, sessionId)
    insertEvidence.run(
      `evidence.${suffix}`, run.runId, shared.item.memory_id, sessionId,
      source.inputWatermark, source.inputWatermark - 1, source.inputWatermark, source.inputDigest
    )
  }
  const oldAgentStore = new FormalAgentStore({ subtitleStore, now: () => 2000 })
  const input = { sessionId: 'session-delete-context', deletionIdempotencyKey: 'delete.session.context.1' }
  const deleted = store.deleteSessionData(input, oldAgentStore)
  const replay = store.deleteSessionData(input, oldAgentStore)
  assert.equal(deleted.deletedEpisodeCount, 1)
  assert.equal(deleted.deletedContextEvidenceCount, 1)
  assert.equal(deleted.deletedOrphanContextItemCount, 1)
  assert.deepEqual(replay, deleted)
  assert.equal(subtitleStore.database.prepare(`
    SELECT COUNT(*) AS count FROM personal_context_episodes WHERE session_id = 'session-delete-context'
  `).get().count, 0)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM personal_context_items').get().count, 2)
  assert.deepEqual(subtitleStore.database.prepare(`
    SELECT semantic_key, lifecycle FROM personal_context_items ORDER BY semantic_key
  `).all().map((row) => ({ ...row })), [
    { semantic_key: 'session-local explicit fact', lifecycle: 'inactive' },
    { semantic_key: 'shared-fact', lifecycle: 'active' }
  ])
  assert.equal(store.contentRevision(), 5)
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
  assert.equal(selection.episodes.length, 1)
  assert.equal(selection.episodes[0].inputWatermark, 1)
  assert.equal(selection.episodes[0].transcriptVersion, 'raw')
  assert.deepEqual(selection.omissions, ['not_committed_tail'])
})
