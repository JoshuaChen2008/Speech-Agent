'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')
const { FORMAL_AGENT_MIGRATIONS } = require('../../src/runtime/storage-worker/schema')
const { SessionDeletionStore } = require('../../src/runtime/storage-worker/session-deletion-store')
const { NLS_PARAMETERS } = require('../../src/contracts/recognition')
const { checksum } = require('../../src/runtime/storage-worker/schema')

test('J20 recognition facts preserve a frozen strategy and first failure across retry and restart', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recognition-session-'))
  const databasePath = path.join(directory, 'subtitle.sqlite3')
  let store = new SqliteSubtitleStore({ databasePath, migrations: FORMAL_AGENT_MIGRATIONS })
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const recognition = { strategy: 'local-only', provider: 'local', region: null, configRevision: 0,
    projectRef: null, modelLabel: '', parameters: null }
  const opened = { sessionId: 'local', sourceId: 'mic', startedAt: 1, recognition }
  assert.equal(store.openSession(opened).status, 'committed')
  assert.deepEqual(store.getSessionTranscript({ sessionId: 'local' }).recognition.binding, recognition)
  assert.equal(store.openSession(opened).status, 'already_processed')
  assert.throws(() => store.openSession({ ...opened, recognition: { ...recognition, configRevision: 1 } }))
  const status = { sessionId: 'local', actualProvider: 'local', fallbackCode: null, fallbackAtMs: null,
    faultCode: 'RECOGNITION_BUFFER_LIMIT', faultAtMs: 20 }
  assert.equal(store.recordRecognitionStatus(status).status, 'committed')
  assert.equal(store.recordRecognitionStatus(status).status, 'already_processed')
  store.recordRecognitionStatus({ ...status, faultCode: null, faultAtMs: null })
  store.closeSession({ sessionId: 'local', sourceId: 'mic', endedAt: 50, state: 'closed' })
  store.close()
  store = new SqliteSubtitleStore({ databasePath, migrations: FORMAL_AGENT_MIGRATIONS })
  const page = store.getSessionPage({ sessionId: 'local', limit: 10, cursor: null })
  assert.equal(page.recognition.faultCode, 'RECOGNITION_BUFFER_LIMIT')
  assert.equal(page.recognition.faultAtMs, 20)
  store.openSession({ sessionId: 'legacy', sourceId: 'mic', startedAt: 60 })
  assert.equal(store.getSessionTranscript({ sessionId: 'legacy' }).recognition.resultStatus, 'not_recorded')
  assert.throws(() => store.recordRecognitionStatus({ ...status, sessionId: 'legacy' }))
  new SessionDeletionStore({ subtitleStore: store }).deleteSessionData({ sessionId: 'local', deletionIdempotencyKey: 'delete-local' })
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM subtitle_recognition_sessions WHERE session_id = ?').get('local').n, 0)
})

test('DB1/J20 v13 rollback preserves v12 and old sessions remain explicitly unrecorded', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recognition-migration-'))
  const databasePath = path.join(directory, 'subtitle.sqlite3')
  let store = new SqliteSubtitleStore({ databasePath, migrations: FORMAL_AGENT_MIGRATIONS.slice(0, 12) })
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  store.openSession({ sessionId: 'pre-v13', sourceId: 'mic', startedAt: 1 })
  store.closeSession({ sessionId: 'pre-v13', sourceId: 'mic', endedAt: 2, state: 'closed' })
  store.close()
  const badSql = FORMAL_AGENT_MIGRATIONS[12].sql + '\nINVALID SQL;'
  assert.throws(() => new SqliteSubtitleStore({ databasePath, migrations: [
    ...FORMAL_AGENT_MIGRATIONS.slice(0, 12), { version: 13, sql: badSql, checksum: checksum(badSql) }
  ] }))
  store = new SqliteSubtitleStore({ databasePath, migrations: FORMAL_AGENT_MIGRATIONS.slice(0, 12) })
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='subtitle_recognition_sessions'").get().n, 0)
  assert.equal(store.database.prepare('SELECT max(version) AS v FROM schema_migrations').get().v, 12)
  store.close()
  store = new SqliteSubtitleStore({ databasePath, migrations: FORMAL_AGENT_MIGRATIONS })
  assert.equal(store.getSessionTranscript({ sessionId: 'pre-v13' }).recognition.resultStatus, 'not_recorded')
  assert.equal(store.database.prepare('SELECT count(*) AS n FROM subtitle_recognition_sessions').get().n, 0)
})

test('DB1/J30 v14 input-limit projection migration rolls back cleanly and preserves prior schema', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-input-migration-'))
  const databasePath = path.join(directory, 'subtitle.sqlite3')
  let store = new SqliteSubtitleStore({ databasePath, migrations: FORMAL_AGENT_MIGRATIONS.slice(0, 13) })
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  store.openSession({ sessionId: 'pre-v14', sourceId: 'mic', startedAt: 1 })
  store.closeSession({ sessionId: 'pre-v14', sourceId: 'mic', endedAt: 2, state: 'closed' })
  store.close()

  const badSql = FORMAL_AGENT_MIGRATIONS[13].sql + '\nINVALID SQL;'
  assert.throws(() => new SqliteSubtitleStore({ databasePath, migrations: [
    ...FORMAL_AGENT_MIGRATIONS.slice(0, 13), { version: 14, sql: badSql, checksum: checksum(badSql) }
  ] }))
  store = new SqliteSubtitleStore({ databasePath, migrations: FORMAL_AGENT_MIGRATIONS.slice(0, 13) })
  assert.equal(store.database.prepare('PRAGMA user_version').get().user_version, 13)
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM pragma_table_info('formal_agent_runs') WHERE name='summary_input_limit_error'").get().n, 0)
  assert.equal(store.getSessionTranscript({ sessionId: 'pre-v14' }).session.state, 'closed')
  store.close()

  store = new SqliteSubtitleStore({ databasePath, migrations: FORMAL_AGENT_MIGRATIONS })
  assert.equal(store.database.prepare('PRAGMA user_version').get().user_version, 14)
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM pragma_table_info('formal_agent_runs') WHERE name='summary_input_limit_error'").get().n, 1)
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM pragma_table_info('formal_agent_interactions') WHERE name='summary_input_limit_error'").get().n, 1)
  assert.equal(store.getSessionTranscript({ sessionId: 'pre-v14' }).session.state, 'closed')
})

test('SEM-F14/J20 rejects secret fields, malformed bindings and reverse fallback without partial writes', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'recognition-validation-'))
  const store = new SqliteSubtitleStore({ databasePath: path.join(directory, 'subtitle.sqlite3'), migrations: FORMAL_AGENT_MIGRATIONS })
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const recognition = { strategy: 'cloud-primary', provider: 'nls', region: 'cn-shanghai', configRevision: 1,
    projectRef: 'a'.repeat(64), modelLabel: '项目说明', parameters: NLS_PARAMETERS }
  const opened = { sessionId: 'cloud', sourceId: 'mic', startedAt: 1, recognition }
  for (const binding of [
    { ...recognition, appKey: 'forbidden' }, { ...recognition, projectRef: 'unhashed-project' },
    { ...recognition, parameters: { ...NLS_PARAMETERS, model: 'forbidden' } },
    { ...recognition, parameters: { ...NLS_PARAMETERS, sample_rate: 8000 } }
  ]) {
    assert.throws(() => store.openSession({ ...opened, recognition: binding }))
    assert.equal(store.getStats().sessions, 0)
  }
  assert.throws(() => store.openSession({ ...opened, refinementEnabled: true }))
  store.openSession(opened)
  const status = { sessionId: 'cloud', actualProvider: 'local', fallbackCode: 'NLS_CONNECTION_CLOSED',
    fallbackAtMs: 5, faultCode: null, faultAtMs: null }
  assert.throws(() => store.recordRecognitionStatus({ ...status, samples: [] }))
  assert.throws(() => store.recordRecognitionStatus({ ...status, fallbackAtMs: null }))
  store.recordRecognitionStatus(status)
  assert.throws(() => store.recordRecognitionStatus({ ...status, actualProvider: 'nls', fallbackCode: null, fallbackAtMs: null }))
  const persisted = store.getSessionTranscript({ sessionId: 'cloud' }).recognition
  assert.equal(persisted.actualProvider, 'local')
  assert.equal(persisted.fallbackAtMs, 5)
})
