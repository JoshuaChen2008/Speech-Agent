'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { DatabaseSync } = require('node:sqlite')
const { FORMAL_AGENT_MIGRATIONS, FORMAL_AGENT_SCHEMA_VERSION } = require('../../src/runtime/storage-worker/schema')
const { openSubtitleDatabase } = require('../../src/runtime/storage-worker/sqlite-store')
const { createVerifiedBackup } = require('../../src/runtime/storage-worker/migration-backup')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')
const { RETIRED_TABLES } = require('../../src/runtime/storage-worker/retirement-migration')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')
const {
  OPERATIONS,
  PROTOCOL_VERSION,
  makeCaptionEventId,
  makeCloseSessionKey,
  makeOpenSessionKey,
  makeRefinementFaultKey
} = require('../../src/runtime/storage-worker/protocol')
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-test-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, file: path.join(dir, 'history.sqlite3') }
}
function old(file, version = 9) { return openSubtitleDatabase(file, { migrations: FORMAL_AGENT_MIGRATIONS.slice(0, version) }) }
function current(file, options = {}) { return openSubtitleDatabase(file, { migrations: FORMAL_AGENT_MIGRATIONS, ...options }) }
function names(db) { return db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(x => x.name) }
function request (operation, payload = {}, idempotencyKey) {
  return {
    version: PROTOCOL_VERSION, type: 'storage:request', requestId: `retire-${operation}`,
    operation, payload, ...(idempotencyKey ? { idempotencyKey } : {})
  }
}
test('J27 fresh database retires exact objects without a backup', t => {
  const {dir,file} = fixture(t), db = current(file)
  try { for (const table of RETIRED_TABLES) assert.ok(!names(db).includes(table)); assert.ok(names(db).includes('sessions')); assert.ok(names(db).includes('personal_context_items')); assert.ok(!fs.existsSync(path.join(dir,'migration-backups'))) } finally { db.close() }
})
test('J27 WAL snapshot retains committed content and successful restart does not back up twice', t => {
  const {dir,file} = fixture(t), writer = old(file)
  writer.exec('PRAGMA wal_autocheckpoint=0')
  writer.prepare("INSERT INTO memory_scopes VALUES ('scope','global','key','private fixture',NULL,'user','active',1,1)").run()
  const db = current(file)
  assert.ok(!names(db).includes('memory_scopes')); db.close(); writer.close()
  const backups = fs.readdirSync(path.join(dir,'migration-backups'))
  assert.equal(backups.length,1)
  const snapshot = new DatabaseSync(path.join(dir,'migration-backups',backups[0]),{readOnly:true})
  assert.equal(snapshot.prepare('SELECT label FROM memory_scopes').get().label,'private fixture'); snapshot.close()
  current(file).close(); assert.deepEqual(fs.readdirSync(path.join(dir,'migration-backups')),backups)
})
test('J27 retirement clears cyclic memory, artifact self-reference, and keyword relations', t => {
  const { dir, file } = fixture(t)
  const legacy = old(file)
  legacy.prepare(`
    INSERT INTO sessions(session_id, mode, source_id, started_at, ended_at, state)
    VALUES ('retire-session', 'meeting', 'loopback', 1, 2, 'closed')
  `).run()
  legacy.prepare(`
    INSERT INTO agent_jobs(
      job_id, run_id, dedupe_key, request_digest, session_id, plugin_id,
      artifact_kind, transcript_version, input_watermark, input_digest,
      recipe_version, provider, provider_kind, model, state, requested_by,
      next_attempt_at, created_at, updated_at
    ) VALUES ('job-retire', 'run-retire', ?, ?, 'retire-session',
      'meeting-minutes', 'meeting-minutes', 'original', 1, ?,
      'meeting-minutes@1', 'fixture-provider', 'local', 'fixture-model',
      'queued', 'automatic', 0, 1, 1)
  `).run('d'.repeat(64), 'e'.repeat(64), 'a'.repeat(64))
  legacy.prepare(`
    INSERT INTO agent_artifacts(
      artifact_id, run_id, session_id, plugin_id, type, content_json,
      content_digest, transcript_version, input_through_event_order,
      input_digest, recipe_version, provider, model, supersedes_artifact_id,
      created_at
    ) VALUES ('artifact-retire', 'run-retire', 'retire-session',
      'meeting-minutes', 'meeting-minutes', '{}', ?, 'original', 1, ?,
      'meeting-minutes@1', 'fixture-provider', 'fixture-model', NULL, 1)
  `).run('f'.repeat(64), 'a'.repeat(64))
  legacy.prepare(`UPDATE agent_artifacts SET supersedes_artifact_id = artifact_id WHERE artifact_id = 'artifact-retire'`).run()
  legacy.prepare(`
    INSERT INTO memory_scopes(
      scope_id, kind, canonical_key, label, session_id, origin, lifecycle,
      created_at, updated_at
    ) VALUES ('scope-retire', 'global', 'global:retire', 'retirement fixture',
      NULL, 'user', 'active', 1, 1)
  `).run()
  legacy.prepare(`
    INSERT INTO memory_items(
      memory_id, scope_id, kind, semantic_key, content_json, origin,
      confidence_band, salience_band, lifecycle, current_revision_id,
      created_at, updated_at
    ) VALUES ('memory-retire', 'scope-retire', 'decision', 'retirement cycle',
      '{}', 'explicit', 'high', 'high', 'active', NULL, 1, 1)
  `).run()
  legacy.prepare(`
    INSERT INTO memory_revisions(
      revision_id, memory_id, operation, content_json, previous_revision_id,
      run_id, created_at
    ) VALUES ('revision-retire', 'memory-retire', 'create', '{}', NULL, NULL, 1)
  `).run()
  legacy.prepare(`UPDATE memory_items SET current_revision_id = 'revision-retire' WHERE memory_id = 'memory-retire'`).run()
  legacy.prepare(`UPDATE memory_revisions SET previous_revision_id = 'revision-retire' WHERE revision_id = 'revision-retire'`).run()
  legacy.prepare(`
    INSERT INTO recognition_terms(
      term_id, scope_id, canonical_text, aliases_json, proposal_origin,
      source_memory_identity_hash, revision, active, created_at, updated_at
    ) VALUES ('term-retire', 'scope-retire', 'retirement term', '["retire"]',
      'manual', NULL, 1, 1, 1, 1)
  `).run()
  legacy.prepare(`
    INSERT INTO recognition_term_sets(term_set_version, digest, created_at)
    VALUES (1, ?, 1)
  `).run('c'.repeat(64))
  legacy.prepare(`
    INSERT INTO recognition_term_set_members(
      term_set_version, term_id, term_revision, canonical_text,
      aliases_json, matched_aliases_json
    ) VALUES (1, 'term-retire', 1, 'retirement term', '["retire"]', '[]')
  `).run()
  legacy.prepare(`
    INSERT INTO recognition_session_configs(
      session_id, strategy, primary_provider, fallback_provider,
      term_set_version, term_set_digest, fallback_code, fallback_at_ms
    ) VALUES ('retire-session', 'local-only', 'fixture-provider', NULL, 1, ?, NULL, NULL)
  `).run('c'.repeat(64))
  legacy.close()

  const db = current(file)
  try {
    const retiredObjects = db.prepare(`
      SELECT type, name, tbl_name
      FROM sqlite_schema
      WHERE tbl_name IN (${RETIRED_TABLES.map(() => '?').join(',')})
         OR name IN (${RETIRED_TABLES.map(() => '?').join(',')})
      ORDER BY type, name
    `).all(...RETIRED_TABLES, ...RETIRED_TABLES)
    assert.deepEqual(retiredObjects, [])
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions').get().count, 1)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM formal_agent_runs').get().count, 0)
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0)
  } finally { db.close() }
  assert.equal(fs.readdirSync(path.join(dir, 'migration-backups')).length, 1)
})
for (const version of [1,2,3,4,5,6,7,8,9]) test('J27 existing version '+version+' upgrades with one pre-migration snapshot', t => {
  const {dir,file}=fixture(t); old(file,version).close(); const db=current(file)
  assert.equal(db.prepare('PRAGMA user_version').get().user_version,FORMAL_AGENT_SCHEMA_VERSION); db.close()
  const backup=new DatabaseSync(path.join(dir,'migration-backups',fs.readdirSync(path.join(dir,'migration-backups'))[0]),{readOnly:true})
  assert.equal(backup.prepare('PRAGMA user_version').get().user_version,version); backup.close()
})
for (const stage of ['create','verify','migrate']) test('J27 '+stage+' failure preserves old data and retry takes a new snapshot', t => {
 const {dir,file}=fixture(t); old(file).close()
 const db=current(file,{ retirementHooks:{ [stage](){throw new Error('private failure')} } })
 assert.ok(db.retirementFailure); assert.ok(names(db).includes('agent_jobs')); assert.equal(db.prepare('PRAGMA user_version').get().user_version,9); db.close()
 current(file).close()
 assert.ok(fs.readdirSync(path.join(dir,'migration-backups')).length >= 1)
})
test('J27 invalid or interrupted backup candidates are removed before the next attempt', t => {
 const {dir,file}=fixture(t); old(file).close()
 const failedVacuum=current(file,{ retirementHooks:{ vacuum(){throw new Error('vacuum interrupted')} } })
 assert.equal(failedVacuum.retirementFailure,'RETIREMENT_BACKUP_CREATE_FAILED'); failedVacuum.close()
 const backupDir=path.join(dir,'migration-backups')
 assert.equal(fs.readdirSync(backupDir).length,0)
 const failedVerify=current(file,{ retirementHooks:{ verify(){throw new Error('verify interrupted')} } })
 assert.equal(failedVerify.retirementFailure,'RETIREMENT_BACKUP_VERIFY_FAILED'); failedVerify.close()
 assert.equal(fs.readdirSync(backupDir).length,0)
 const succeeded=current(file); succeeded.close()
 assert.equal(fs.readdirSync(backupDir).length,1)
})
test('J27 existing backup directory is normalized to private mode', t => {
 const {dir,file}=fixture(t); old(file).close()
 const backupDir=path.join(dir,'migration-backups')
 fs.mkdirSync(backupDir,{recursive:true})
 if (process.platform !== 'win32') fs.chmodSync(backupDir,0o755)
 const db=current(file); db.close()
 if (process.platform !== 'win32') assert.equal(fs.statSync(backupDir).mode & 0o077,0)
})
for (const stage of ['create', 'verify', 'migrate']) test('J27 service gates Agent operations while preserving subtitle writes after ' + stage + ' failure', t => {
  const { file } = fixture(t)
  const legacy = old(file)
  legacy.prepare(`
    INSERT INTO sessions(session_id, mode, source_id, started_at, ended_at, state)
    VALUES ('legacy-readable', 'meeting', 'loopback', 1, 2, 'closed')
  `).run()
  legacy.close()
  const service = new StorageWorkerService({
    storeFactory: ({ databasePath }) => new SqliteSubtitleStore({
      databasePath,
      migrations: FORMAL_AGENT_MIGRATIONS,
      retirementHooks: { [stage] () { throw new Error('retirement ' + stage + ' failure') } }
    })
  })
  const initialized = service.handle(request(OPERATIONS.INITIALIZE, { databasePath: file }))
  assert.equal(initialized.ok, true)
  assert.equal(initialized.result.retirementFailure, stage === 'create'
    ? 'RETIREMENT_BACKUP_CREATE_FAILED'
    : stage === 'verify' ? 'RETIREMENT_BACKUP_VERIFY_FAILED' : 'RETIREMENT_MIGRATION_FAILED')
  const sessionId = `subtitle-${stage}`
  const opened = { sessionId, sourceId: 'loopback', startedAt: 10, refinementEnabled: true }
  assert.equal(service.handle(request(OPERATIONS.OPEN_SESSION, opened, makeOpenSessionKey(sessionId))).ok, true)
  const event = {
    schemaVersion: 1, sessionId, sourceId: 'loopback', segmentId: `segment-${stage}`,
    sequence: 1, revision: 1, kind: 'final', t0: 0, t1: 1, text: 'retirement subtitle', translation: null
  }
  assert.equal(service.handle(request(OPERATIONS.APPEND_CAPTION, { event }, makeCaptionEventId(event))).ok, true)
  const refinementFault = { sessionId, faultCode: 'REFINE_WORKER_EXITED', faultAtMs: 15 }
  assert.equal(service.handle(request(OPERATIONS.RECORD_REFINEMENT_FAULT, refinementFault,
    makeRefinementFaultKey(sessionId, refinementFault.faultCode))).ok, true)
  assert.equal(service.handle(request(OPERATIONS.CLOSE_SESSION,
    { sessionId, sourceId: 'loopback', endedAt: 20, state: 'closed' }, makeCloseSessionKey(sessionId))).ok, true)
  assert.equal(service.handle(request(OPERATIONS.GET_SESSION, { sessionId })).result.segments.length, 1)
  const agentOperations = [
    [OPERATIONS.PERSONAL_CONTEXT_MANAGE, { command: {} }],
    [OPERATIONS.MODEL_ACCESS_CATALOG, {}],
    [OPERATIONS.AGENT_CREATE_RUN, { request: {} }],
    [OPERATIONS.PERSONAL_CONTEXT_DELETE_SESSION_DATA, { sessionId, deletionIdempotencyKey: `delete-${stage}` }]
  ]
  for (const [operation, payload] of agentOperations) {
    const response = service.handle(request(operation, payload))
    assert.equal(response.ok, false)
    assert.equal(response.error.code, initialized.result.retirementFailure)
  }
  service.handle(request(OPERATIONS.SHUTDOWN))
})
test('J27 checksum corruption and higher schema versions fail closed before backup', t => {
 const {dir,file}=fixture(t); const db=old(file); db.exec("UPDATE schema_migrations SET checksum='"+'0'.repeat(64)+"' WHERE version=9"); db.close()
 assert.throws(()=>current(file)); assert.ok(!fs.existsSync(path.join(dir,'migration-backups')))
})

test('J27 unknown higher schema versions fail closed before backup', t => {
 const {dir,file}=fixture(t); const db=old(file)
 db.prepare('INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, 10)').run(FORMAL_AGENT_SCHEMA_VERSION, '0'.repeat(64))
 db.exec(`PRAGMA user_version = ${FORMAL_AGENT_SCHEMA_VERSION + 1}`); db.close()
 assert.throws(() => current(file), (error) => error?.code === 'SCHEMA_IDENTITY_INVALID')
 assert.ok(!fs.existsSync(path.join(dir,'migration-backups')))
})

test('J27 failed retirement preserves a previously valid backup byte-for-byte', t => {
 const {dir,file}=fixture(t); const legacy = old(file)
 const priorPath = createVerifiedBackup(legacy.database || legacy, file, FORMAL_AGENT_MIGRATIONS)
 legacy.close()
 const priorBytes = fs.readFileSync(priorPath)
 const failed = current(file, { retirementHooks: { create () { throw new Error('backup unavailable') } } })
 assert.equal(failed.retirementFailure, 'RETIREMENT_BACKUP_CREATE_FAILED'); failed.close()
 assert.deepEqual(fs.readFileSync(priorPath), priorBytes)
 assert.equal(fs.readdirSync(path.join(dir, 'migration-backups')).length, 1)
})

test('J27 v1 backup failure keeps subtitle capture/history available while refinement metadata is unavailable', t => {
  const { file } = fixture(t)
  const legacy = old(file, 1)
  legacy.prepare(`
    INSERT INTO sessions(session_id, mode, source_id, started_at, ended_at, state)
    VALUES ('legacy-v1', 'meeting', 'loopback', 1, 2, 'closed')
  `).run()
  const event = legacy.prepare(`
    INSERT INTO caption_events(
      event_id, session_id, source_id, segment_id, sequence, revision,
      kind, t0_ms, t1_ms, text, created_at
    ) VALUES ('legacy-event', 'legacy-v1', 'loopback', 'seg-1', 1, 1,
      'final', 10, 20, 'legacy text', 2)
  `).run()
  legacy.prepare(`
    INSERT INTO segments(
      session_id, source_id, segment_id, text, text_revision,
      t0_ms, t1_ms, first_event_order, updated_event_order
    ) VALUES ('legacy-v1', 'loopback', 'seg-1', 'legacy text', 1,
      10, 20, ?, ?)
  `).run(Number(event.lastInsertRowid), Number(event.lastInsertRowid))
  legacy.close()

  const store = new SqliteSubtitleStore({
    databasePath: file,
    migrations: FORMAL_AGENT_MIGRATIONS,
    retirementHooks: { create () { throw new Error('backup unavailable') } }
  })
  const transcript = store.getSessionTranscript({ sessionId: 'legacy-v1' })
  assert.equal(transcript.refinement.refinementResultStatus, 'not_recorded')
  assert.equal(transcript.segments[0].text, 'legacy text')
  store.openSession({ sessionId: 'new-v1', sourceId: 'loopback', startedAt: 3, refinementEnabled: false })
  store.appendCaption({
    schemaVersion: 1, sessionId: 'new-v1', sourceId: 'loopback', segmentId: 'seg-new',
    sequence: 1, revision: 1, kind: 'final', t0: 0, t1: 1, text: 'new subtitle', translation: null
  })
  store.closeSession({ sessionId: 'new-v1', sourceId: 'loopback', endedAt: 4, state: 'closed' })
  assert.equal(store.getSessionTranscript({ sessionId: 'new-v1' }).segments[0].text, 'new subtitle')
  assert.deepEqual(store.recordRefinementFault({
    sessionId: 'new-v1', faultCode: 'REFINE_WORKER_EXITED', faultAtMs: 4
  }), {
    status: 'not_recorded', sessionId: 'new-v1', faultCode: 'REFINE_WORKER_EXITED'
  })
  store.close()
})
