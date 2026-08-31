'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { AgentExecutionStore } = require('../../src/runtime/storage-worker/agent-execution-store')
const { canonicalize, sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')
const { FORMAL_AGENT_MIGRATIONS } = require('../../src/runtime/storage-worker/schema')
const { PersonalContextStore } = require('../../src/runtime/storage-worker/personal-context-store')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')

function fixture (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'context-ingest-s3-'))
  const subtitleStore = new SqliteSubtitleStore({
    databasePath: path.join(root, 'speech-agent.sqlite3'),
    migrations: FORMAL_AGENT_MIGRATIONS,
    now: () => 1000
  })
  const personalContext = new PersonalContextStore({ subtitleStore, now: () => 2000 })
  const execution = new AgentExecutionStore({ subtitleStore, now: () => 2000 })
  t.after(() => {
    try { subtitleStore.close() } catch {}
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { subtitleStore, personalContext, execution }
}

function appendSession (store, sessionId = 'session.ingest') {
  store.openSession({ sessionId, sourceId: 'loopback', startedAt: 10, refinementEnabled: false })
  store.appendCaption({ schemaVersion: 1, sessionId, sourceId: 'loopback', segmentId: 'segment.1', sequence: 1, revision: 1, kind: 'final', t0: 0, t1: 1, text: 'Project decision', translation: null })
  store.closeSession({ sessionId, sourceId: 'loopback', endedAt: 20, state: 'closed' })
}

function sourceFor (personalContext, sessionId = 'session.ingest') {
  void personalContext
  const inputWatermark = 1
  return {
    sourceKind: 'session', sessionId, transcriptVersion: 'raw',
    inputWatermark,
    inputDigest: sha256Canonical({ sessionId, transcriptVersion: 'raw', inputWatermark, events: [{ eventOrder: 1, segmentId: 'segment.1', text: 'Project decision' }] })
  }
}

const output = {
  schemaVersion: 1,
  experiences: [{ kind: 'decision', text: 'Ship the project', evidence: { sessionId: 'session.ingest', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 1 }, confidence: 'high' }],
  memoryCandidates: [{ scopeKind: 'session', scopeKeyProposal: null, kind: 'decision', content: '  Ship   the project  ', confidence: 'high', salience: 'high', evidence: { sessionId: 'session.ingest', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 1 } }]
}

test('SEM-F16/SEM-F28/SEM-F35/J22/J24: session ingest preflight creates one replayable skeleton before model execution', (t) => {
  const { subtitleStore, personalContext } = fixture(t)
  appendSession(subtitleStore)
  const source = sourceFor(personalContext)
  const first = personalContext.prepareSessionIngest(source)
  assert.equal(first.recipeId, 'context.ingest.session')
  assert.equal(first.state, 'queued')
  assert.equal(first.episodeId.length > 0, true)
  const replay = personalContext.prepareSessionIngest(source)
  assert.deepEqual(replay, { ...first, replayed: true })
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_runs').get().count, 1)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM personal_context_episodes').get().count, 1)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM personal_context_items').get().count, 0)
})

test('SEM-F14/SEM-F16/SEM-F35/J22/J24: session ingest commits candidates atomically and derives semantic_key in storage', (t) => {
  const { subtitleStore, personalContext } = fixture(t)
  appendSession(subtitleStore)
  const source = sourceFor(personalContext)
  const prepared = personalContext.prepareSessionIngest(source)
  const claimed = personalContext.claimNextFormalRun({ claimIdempotencyKey: 'claim.ingest', owner: 'worker.ingest', leaseMs: 1000 })
  assert.equal(claimed.runId, prepared.runId)
  const committed = personalContext.commitSessionIngest({ runId: prepared.runId, attemptIdentity: claimed.attemptIdentity, output })
  assert.equal(committed.state, 'committed')
  const item = subtitleStore.database.prepare('SELECT semantic_key, content_json FROM personal_context_items').get()
  assert.equal(item.semantic_key, 'ship the project')
  assert.equal(JSON.parse(item.content_json).displayText, '  Ship   the project  ')
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM recognition_terms').get().count, 0)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM recognition_session_configs').get().count, 0)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM personal_context_evidence').get().count, 1)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM personal_context_episodes').get().count, 1)
  assert.equal(canonicalize(JSON.parse(subtitleStore.database.prepare('SELECT summary_json FROM personal_context_episodes').get().summary_json)).length < 8192, true)
})

test('SEM-F35/SEM-T04/J22: invalid session ingest output preserves skeleton and writes no partial memory', (t) => {
  const { subtitleStore, personalContext } = fixture(t)
  appendSession(subtitleStore)
  const source = sourceFor(personalContext)
  const prepared = personalContext.prepareSessionIngest(source)
  const claimed = personalContext.claimNextFormalRun({ claimIdempotencyKey: 'claim.invalid', owner: 'worker.invalid', leaseMs: 1000 })
  assert.throws(() => personalContext.commitSessionIngest({
    runId: prepared.runId, attemptIdentity: claimed.attemptIdentity,
    output: { ...output, memoryCandidates: [{ ...output.memoryCandidates[0], semanticKey: 'caller-owned' }] }
  }), (error) => error.code === 'AGENT_OUTPUT_INVALID')
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM personal_context_items').get().count, 0)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM personal_context_episodes').get().count, 1)
  assert.equal(subtitleStore.database.prepare('SELECT state FROM formal_agent_runs WHERE run_id=?').get(prepared.runId).state, 'running')
})

test('SEM-F28/SEM-F30/SEM-T10/J22/J24: storage derives a terminal source and replays one session skeleton', (t) => {
  const { subtitleStore, personalContext } = fixture(t)
  appendSession(subtitleStore, 'session.derived')
  const first = personalContext.prepareSessionIngestRequest({ sessionId: 'session.derived', transcriptVersion: 'raw' })
  const replay = personalContext.prepareSessionIngestRequest({ sessionId: 'session.derived', transcriptVersion: 'raw' })
  assert.equal(first.source.inputDigest.length, 64)
  assert.equal(first.recipeId, 'context.ingest.session')
  assert.equal(replay.replayed, true)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_runs').get().count, 1)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM personal_context_episodes').get().count, 1)
})

test('SEM-F15/SEM-F34/J22/J24: storage derives a frozen controlled-tool context from committed personal context and the transcript boundary', (t) => {
  const { subtitleStore, personalContext } = fixture(t)
  appendSession(subtitleStore)
  const source = sourceFor(personalContext)
  const prepared = personalContext.prepareSessionIngest(source)
  const claimed = personalContext.claimNextFormalRun({ claimIdempotencyKey: 'claim.tool-context', owner: 'worker.tool-context', leaseMs: 1000 })
  personalContext.commitSessionIngest({ runId: prepared.runId, attemptIdentity: claimed.attemptIdentity, output })

  const context = personalContext.readToolContext({ runId: prepared.runId })
  assert.deepEqual(context.scope.registeredAliasKeys, ['ship the project'])
  assert.equal(context.entries.length, 1)
  assert.equal(context.entries[0].memoryRef.memoryId.startsWith('memory.'), true)
  assert.equal(context.entries[0].memoryRef.revisionId.startsWith('revision.'), true)
  assert.deepEqual(context.entries[0].sourceRefs, [{
    sessionId: 'session.ingest', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 1
  }])
  assert.deepEqual(context.sources, [{
    sourceRef: { sessionId: 'session.ingest', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 1 },
    text: 'Project decision'
  }])
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM caption_events').get().count, 1)
})

test('SEM-F15/SEM-F34/J22: a frozen tool context keeps one alias for multiple matching memory entries', (t) => {
  const { subtitleStore, personalContext } = fixture(t)
  appendSession(subtitleStore)
  const source = sourceFor(personalContext)
  const prepared = personalContext.prepareSessionIngest(source)
  const claimed = personalContext.claimNextFormalRun({ claimIdempotencyKey: 'claim.tool-context-alias', owner: 'worker.tool-context', leaseMs: 1000 })
  personalContext.commitSessionIngest({
    runId: prepared.runId,
    attemptIdentity: claimed.attemptIdentity,
    output: {
      ...output,
      memoryCandidates: [
        output.memoryCandidates[0],
        { ...output.memoryCandidates[0], kind: 'conclusion', content: 'Ship the project' }
      ]
    }
  })
  const context = personalContext.readToolContext({ runId: prepared.runId })
  assert.deepEqual(context.scope.registeredAliasKeys, ['ship the project'])
  assert.equal(context.entries.length, 2)
})
