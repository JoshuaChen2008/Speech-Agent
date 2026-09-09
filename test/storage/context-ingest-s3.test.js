'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { AgentExecutionStore } = require('../../src/runtime/storage-worker/agent-execution-store')
const { canonicalize, sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')
const { FormalAgentStore } = require('../../src/runtime/storage-worker/formal-agent-store')
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

function enableAutomaticPolicy (personalContext) {
  personalContext.applyAutomaticTaskPolicy({
    agentEnabled: true,
    automaticProcessingSince: 0,
    memoryEnabled: true,
    memoryProcessingSince: 0
  })
}

function insertBinding (database, runId) {
  database.prepare(`
    INSERT INTO agent_model_run_bindings(
      run_id, execution_form, purpose, assignment_mode, profile_id, profile_revision,
      adapter_id, api_style, https_origin, base_path, model_id, capability_json,
      budget_json, provider_kind, credential_slot_id, created_at
    ) VALUES (?, 'agent_loop', 'default', 'direct', 'profile.signal', 1,
      'openai-compatible', 'chat-completions', 'https://provider.test', '/v1',
      'model.signal', ?, ?, 'cloud', 'slot.signal.00000001', 1000)
  `).run(
    runId,
    canonicalize({
      maxInputTokens: 64000,
      maxOutputTokens: 4096,
      supportsToolCalling: false,
      supportsStructuredOutput: true,
      supportsStreaming: true,
      usageReporting: false
    }),
    canonicalize({ maxTurns: 3 })
  )
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

test('SEM-F32/J21: interaction signal ingestion accepts the six explicit values, binds result identity and keeps raw prompt/result out of the episode', (t) => {
  const { subtitleStore, personalContext, execution } = fixture(t)
  appendSession(subtitleStore, 'session.signal')
  const source = sourceFor(personalContext, 'session.signal')
  const run = execution.createRun({
    runId: 'run.user.signal', recipeId: 'qa.answer', recipeVersion: '1',
    scope: { kind: 'session', reference: 'session.signal' }, transcriptVersion: 'raw',
    inputWatermark: { throughEventOrder: source.inputWatermark }, inputDigest: source.inputDigest,
    requestedBy: 'user', clientIdempotencyKey: 'client.signal'
  })
  insertBinding(subtitleStore.database, run.runId)
  execution.createInteraction({
    runId: run.runId, interactionId: 'interaction.signal', routingMode: 'model',
    promptDigest: sha256Canonical('private prompt')
  })
  execution.terminalizeInteraction({
    interactionId: 'interaction.signal', terminalReason: 'succeeded', errorCode: null,
    result: { schemaVersion: 1, answer: 'private result', sourceRefs: [], memoryRefs: [], unresolved: [] },
    usage: null, durationMs: 4
  })

  const signals = [
    ['prompt', null, 'signal.prompt.test'],
    ['edit', sha256Canonical({ text: 'edited result' }), 'signal.edit.test'],
    ['accept', null, 'signal.accept.test'],
    ['reject', null, 'signal.reject.test'],
    ['remember', null, 'signal.remember.test'],
    ['forget', null, 'signal.forget.test']
  ]
  const prepared = signals.map(([signalKind, payloadDigest]) => personalContext.prepareInteractionIngestRequest({
    interactionId: 'interaction.signal', signalKind, payloadDigest,
    signalIdempotencyKey: signals.find(([kind]) => kind === signalKind)[2]
  }))
  assert.deepEqual(prepared.map((item) => item.source.signalKind), signals.map(([signalKind]) => signalKind))
  assert.equal(new Set(prepared.map((item) => item.runId)).size, 6)
  assert.equal(subtitleStore.database.prepare("SELECT COUNT(*) AS count FROM formal_agent_runs WHERE recipe_id='context.ingest.interaction'").get().count, 6)
  const summaries = subtitleStore.database.prepare("SELECT summary_json FROM personal_context_episodes WHERE source_kind='interaction'").all()
  assert.equal(summaries.length, 6)
  for (const row of summaries) {
    assert.doesNotMatch(row.summary_json, /private prompt|private result/)
    assert.match(row.summary_json, /promptDigest|resultDigest|signalKind/)
  }
  assert.deepEqual(
    personalContext.prepareInteractionIngestRequest({ interactionId: 'interaction.signal', signalKind: 'prompt', payloadDigest: null, signalIdempotencyKey: 'signal.prompt.test' }),
    { ...prepared[0], replayed: true }
  )

  enableAutomaticPolicy(personalContext)
  const claimed = personalContext.claimNextFormalRun({
    claimIdempotencyKey: 'claim.signal', owner: 'worker.signal', leaseMs: 1000
  })
  assert.equal(claimed.recipeId, 'context.ingest.interaction')
  const input = personalContext.readInteractionInput(claimed.source, {
    prompt: 'private prompt', editText: null,
    result: { schemaVersion: 1, answer: 'private result', sourceRefs: [], memoryRefs: [], unresolved: [] }
  })
  assert.equal(input.interactionId, 'interaction.signal')
  assert.equal(input.signalKind, claimed.source.signalKind)
  assert.deepEqual(input.events, [])
  assert.equal(input.signal.prompt, 'private prompt')
  assert.equal(input.signal.editText, null)
  assert.equal(input.signal.result.answer, 'private result')
  for (const [field, value] of [
    ['inputWatermark', 2],
    ['recipeId', 'qa.other']
  ]) {
    assert.throws(
      () => personalContext.readInteractionInput({ ...claimed.source, [field]: value }, {
        prompt: 'private prompt', editText: null,
        result: { schemaVersion: 1, answer: 'private result', sourceRefs: [], memoryRefs: [], unresolved: [] }
      }),
      (error) => error.code === 'AGENT_INPUT_CHANGED',
      `frozen interaction source field ${field} must be rejected`
    )
  }
  assert.throws(
    () => personalContext.readInteractionInput({ ...claimed.source, scopeReference: 'session.other', sessionId: 'session.other' }, {
      prompt: 'private prompt', editText: null,
      result: { schemaVersion: 1, answer: 'private result', sourceRefs: [], memoryRefs: [], unresolved: [] }
    }),
    (error) => error.code === 'AGENT_INPUT_CHANGED',
    'frozen interaction scope identity must be rejected'
  )
  const output = {
    schemaVersion: 1,
    experiences: [{
      kind: 'event', text: 'explicit signal accepted',
      evidence: { interactionId: input.interactionId, signalKind: input.signalKind }, confidence: 'high'
    }],
    memoryCandidates: []
  }
  const committed = personalContext.commitInteractionIngest({
    runId: claimed.runId, attemptIdentity: claimed.attemptIdentity, output
  })
  assert.equal(committed.state, 'committed')
  const storedSummary = subtitleStore.database.prepare('SELECT summary_json FROM personal_context_episodes WHERE episode_id=?').get(committed.episodeId).summary_json
  assert.match(storedSummary, /explicit signal accepted/)
  assert.doesNotMatch(storedSummary, /private prompt|private result/)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM personal_context_evidence').get().count, 0)

  assert.throws(
    () => personalContext.prepareInteractionIngestRequest({
      interactionId: 'interaction.signal', signalKind: 'reject', payloadDigest: null,
      signalIdempotencyKey: 'signal.accept.test'
    }),
    (error) => error.code === 'AGENT_REQUEST_INVALID'
  )

  assert.throws(
    () => personalContext.prepareInteractionIngestRequest({ interactionId: 'interaction.signal', signalKind: 'scroll', payloadDigest: null }),
    (error) => error.code === 'AGENT_REQUEST_INVALID'
  )
})

test('SEM-F26/SEM-F32/J21: session deletion removes formal interactions, tool calls and signal runs with their context episodes', (t) => {
  const { subtitleStore, personalContext, execution } = fixture(t)
  appendSession(subtitleStore, 'session.signal.delete')
  const source = sourceFor(personalContext, 'session.signal.delete')
  const run = execution.createRun({
    runId: 'run.user.signal.delete', recipeId: 'qa.answer', recipeVersion: '1',
    scope: { kind: 'session', reference: 'session.signal.delete' }, transcriptVersion: 'raw',
    inputWatermark: { throughEventOrder: source.inputWatermark }, inputDigest: source.inputDigest,
    requestedBy: 'user', clientIdempotencyKey: 'client.signal.delete'
  })
  insertBinding(subtitleStore.database, run.runId)
  execution.createInteraction({
    runId: run.runId, interactionId: 'interaction.signal.delete', routingMode: 'model',
    promptDigest: sha256Canonical('private prompt')
  })
  execution.startToolCall({
    callId: 'call.signal.delete', interactionId: 'interaction.signal.delete', attempt: 1,
    callOrder: 1, toolName: 'search_context', startedOffsetMs: 0, args: { query: 'bounded' }
  })
  execution.finishToolCall({
    callId: 'call.signal.delete', status: 'succeeded', errorCode: null, result: { entries: [] },
    endedOffsetMs: 1, sourceRefs: [], counts: { resultBytes: 0, sourceTextBytes: 0, sourceReferenceCount: 0 }
  })
  const result = { schemaVersion: 1, answer: 'private result', sourceRefs: [], memoryRefs: [], unresolved: [] }
  execution.terminalizeInteraction({
    interactionId: 'interaction.signal.delete', terminalReason: 'succeeded', errorCode: null,
    result, usage: null, durationMs: 4
  })
  enableAutomaticPolicy(personalContext)
  personalContext.prepareInteractionIngestRequest({
    interactionId: 'interaction.signal.delete', signalKind: 'accept', payloadDigest: null,
    signalIdempotencyKey: 'signal.accept.delete'
  })

  const formalStore = new FormalAgentStore({ subtitleStore, now: () => 3000 })
  const deleted = formalStore.deleteSessionData({
    sessionId: 'session.signal.delete', deletionIdempotencyKey: 'delete.signal.1'
  }, personalContext)
  assert.equal(deleted.deletedInteractionCount, 1)
  assert.equal(deleted.deletedToolCallCount, 1)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_runs').get().count, 0)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_interactions').get().count, 0)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_tool_calls').get().count, 0)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM personal_context_episodes').get().count, 0)
  assert.deepEqual(formalStore.deleteSessionData({
    sessionId: 'session.signal.delete', deletionIdempotencyKey: 'delete.signal.1'
  }, personalContext), deleted)
})

test('SEM-F14/SEM-F16/SEM-F35/J22/J24: session ingest commits candidates atomically and derives semantic_key in storage', (t) => {
  const { subtitleStore, personalContext } = fixture(t)
  enableAutomaticPolicy(personalContext)
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
  enableAutomaticPolicy(personalContext)
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
  enableAutomaticPolicy(personalContext)
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
  enableAutomaticPolicy(personalContext)
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
