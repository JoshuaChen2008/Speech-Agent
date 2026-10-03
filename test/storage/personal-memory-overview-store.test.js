'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')
const { PersonalContextStore } = require('../../src/runtime/storage-worker/personal-context-store')
const { SessionDeletionStore } = require('../../src/runtime/storage-worker/session-deletion-store')
const { FORMAL_AGENT_MIGRATIONS, checksum } = require('../../src/runtime/storage-worker/schema')

function fixture (t, migrations = FORMAL_AGENT_MIGRATIONS) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-overview-store-'))
  const databasePath = path.join(root, 'context.sqlite3')
  const subtitleStore = new SqliteSubtitleStore({ databasePath, migrations, now: () => 1000 })
  const store = new PersonalContextStore({ subtitleStore, now: () => 1000 })
  t.after(() => { subtitleStore.close(); fs.rmSync(root, { recursive: true, force: true }) })
  return { subtitleStore, store, databasePath }
}
function remember (store, text) {
  return store.manage({ type: 'remember', expected_revision: store.contentRevision(), entry: {
    display_text: text, kind: 'preference', scope: { kind: 'global', reference: null }
  } }).item
}
function claim (store, sequence) {
  return store.claimNextFormalRun({ owner: 'overview.test', leaseMs: 30000, claimIdempotencyKey: `overview.claim.${sequence}`, requestedBy: 'automatic',
    automaticPolicy: { agentEnabled: true, automaticProcessingSince: 0, memoryEnabled: true, memoryProcessingSince: 0 } })
}
function commitPage (store, job) {
  const input = store.overview.read(job.runId)
  const output = { schemaVersion: 1, sections: input.memories.slice(0, 2).map((item) => ({
    category: 'facts', title: '明确偏好', text: item.displayText.slice(0, 100), memoryRefs: [item.memoryRef], episodeRefs: []
  })) }
  const command = { type: 'synthesize', action: 'commit', runId: job.runId, attemptIdentity: job.attemptIdentity, output }
  store.overview.commit(command)
  return { input, command }
}

test('SEM-F26/F37/T08/DB7/J28: v21 upgrades append only, migration failure rolls back, and legacy inferred globals require review', (t) => {
  const { subtitleStore, store, databasePath } = fixture(t, FORMAL_AGENT_MIGRATIONS.slice(0, 21))
  const explicit = remember(store, '明确偏好保留')
  const inferred = remember(store, '旧会话推断等待复核')
  store.database.prepare("UPDATE personal_context_items SET origin='inferred' WHERE memory_id=?").run(inferred.memory_id)
  const checksums = store.database.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all()
  subtitleStore.close()
  const last = FORMAL_AGENT_MIGRATIONS.at(-1)
  const badSql = `${last.sql}\nTHIS IS INVALID SQL;`
  assert.throws(() => new SqliteSubtitleStore({ databasePath, migrations: [...FORMAL_AGENT_MIGRATIONS.slice(0, -1), { ...last, sql: badSql, checksum: checksum(badSql) }] }))
  const upgraded = new SqliteSubtitleStore({ databasePath, migrations: FORMAL_AGENT_MIGRATIONS })
  try {
    assert.deepEqual(upgraded.database.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all().slice(0, 21), checksums)
    assert.equal(upgraded.database.prepare('SELECT count(*) AS n FROM schema_migrations WHERE version=24').get().n, 1)
    assert.equal(upgraded.database.prepare('SELECT lifecycle FROM personal_context_items WHERE memory_id=?').get(explicit.memory_id).lifecycle, 'active')
    assert.equal(upgraded.database.prepare('SELECT lifecycle FROM personal_context_items WHERE memory_id=?').get(inferred.memory_id).lifecycle, 'conflicted')
    assert.equal(upgraded.database.prepare('PRAGMA foreign_key_check').get(), undefined)
  } finally { upgraded.close() }
  const changedSql = `${FORMAL_AGENT_MIGRATIONS[0].sql}\n-- changed historical schema`
  assert.throws(() => new SqliteSubtitleStore({ databasePath, migrations: [{ ...FORMAL_AGENT_MIGRATIONS[0], sql: changedSql, checksum: checksum(changedSql) }, ...FORMAL_AGENT_MIGRATIONS.slice(1)] }), { code: 'SCHEMA_IDENTITY_INVALID' })
})

test('SEM-F37/T04/J28/DB7: overview resumes whole-item pages, fences stale responses, and replays a lost commit acknowledgement once', (t) => {
  const { store } = fixture(t)
  for (let index = 0; index < 24; index += 1) remember(store, `${index}:` + '界'.repeat(600))
  let sequence = 0; let pages = 0
  while (store.overview.prepare().preparedCount > 0) {
    const job = claim(store, ++sequence)
    assert.equal(job.recipeId, 'context.synthesize')
    const { input, command } = commitPage(store, job)
    assert.ok(Buffer.byteLength(JSON.stringify(input), 'utf8') < 15000)
    assert.equal(input.memories.every((item) => item.displayText.endsWith('界'.repeat(600))), true)
    const before = store.database.prepare('SELECT current_json FROM personal_context_overviews WHERE scope_key=\'global\'').get().current_json
    assert.equal(store.overview.commit(command).replayed, true)
    assert.equal(store.database.prepare('SELECT current_json FROM personal_context_overviews WHERE scope_key=\'global\'').get().current_json, before)
    store.database.prepare("UPDATE formal_agent_runs SET state='succeeded',lease_owner=NULL,lease_expires_at=NULL,result_digest=?,result_summary_json='{}' WHERE run_id=?").run('a'.repeat(64), job.runId)
    assert.equal(store.overview.commit(command).replayed, true)
    pages += 1
    assert.ok(pages < 20)
  }
  assert.ok(pages > 1)
  assert.equal(store.overview.view().current.coverage.memories, 24)
  assert.equal(store.overview.view().current.coverage.has_more, false)
  assert.equal(store.overview.prepare().preparedCount, 0)
  assert.ok(store.overview.view().current.sections.length <= 12)
  remember(store, '新偏好')
  store.overview.prepare()
  const stale = claim(store, ++sequence)
  const input = store.overview.read(stale.runId)
  const changed = store.memoryRow(input.memories[0].memoryRef.memoryId)
  store.manage({ type: 'update', expected_revision: store.contentRevision(), item_id: changed.memory_id, item_revision: Number(changed.item_revision), entry: {
    display_text: '已纠正偏好', kind: 'preference', scope: { kind: 'global', reference: null }
  } })
  assert.throws(() => store.overview.commit({ type: 'synthesize', action: 'commit', runId: stale.runId, attemptIdentity: stale.attemptIdentity, output: { schemaVersion: 1, sections: [] } }), { code: 'AGENT_REQUEST_INVALID' })
})

test('SEM-F30/F37/T04/J28/J10: source navigation anchors a refined event beyond the first history page and rejects deleted or injected targets', (t) => {
  const { subtitleStore, store } = fixture(t)
  const sessionId = 'session.source'
  subtitleStore.openSession({ sessionId, sourceId: 'mic', startedAt: 10, refinementEnabled: true })
  for (let index = 0; index < 160; index += 1) {
    const event = { schemaVersion: 1, sessionId, sourceId: 'mic', segmentId: `segment.${index}`, sequence: index + 1, revision: 1, kind: 'final', t0: index * 10, t1: index * 10 + 10, text: `片段 ${index}`, translation: null }
    subtitleStore.appendCaption(event)
    subtitleStore.appendCaption({ ...event, sequence: index + 161, revision: 2, kind: 'refined', text: `精修片段 ${index}` })
  }
  subtitleStore.closeSession({ sessionId, sourceId: 'mic', endedAt: 2000, state: 'closed' })
  const anchor = store.database.prepare("SELECT event_order FROM caption_events WHERE session_id=? AND segment_id='segment.150' AND kind='refined'").get(sessionId).event_order
  const target = { kind: 'session', reference: sessionId, transcript_version: 'refined', from_event_order: Number(anchor), through_event_order: Number(anchor) }
  const location = store.manage({ type: 'source', target })
  assert.equal(location.offset, 150)
  const page = subtitleStore.getSessionPage({ sessionId, cursor: location.cursor, limit: 20 })
  assert.equal(page.items[0].segmentId, 'segment.150')
  assert.equal(page.items[0].refinedText, '精修片段 150')
  assert.throws(() => store.manage({ type: 'source', target: { ...target, url: 'https://example.invalid' } }), { code: 'AGENT_REQUEST_INVALID' })
  new SessionDeletionStore({ subtitleStore, personalContextStore: store }).deleteSessionData({ sessionId, deletionIdempotencyKey: 'delete.source' })
  assert.throws(() => store.manage({ type: 'source', target }), { code: 'AGENT_CONTEXT_NOT_FOUND' })
})

test('SEM-F37/T08/J28/DB7: reopening SQLite retains projection and cursor and does not prepare the same input again', (t) => {
  const { subtitleStore, store, databasePath } = fixture(t)
  remember(store, '先说明假设')
  store.overview.prepare()
  const job = claim(store, 1)
  commitPage(store, job)
  store.database.prepare("UPDATE formal_agent_runs SET state='succeeded',lease_owner=NULL,lease_expires_at=NULL,result_digest=?,result_summary_json='{}' WHERE run_id=?").run('a'.repeat(64), job.runId)
  const before = store.overview.view()
  subtitleStore.close()
  const reopened = new SqliteSubtitleStore({ databasePath, migrations: FORMAL_AGENT_MIGRATIONS, now: () => 1000 })
  try {
    const restored = new PersonalContextStore({ subtitleStore: reopened, now: () => 1000 })
    assert.deepEqual(restored.overview.view(), before)
    assert.equal(restored.overview.prepare().preparedCount, 0)
  } finally { reopened.close() }
})
