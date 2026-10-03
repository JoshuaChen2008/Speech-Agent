'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')
const { CredentialVault } = require('../../src/agent/model-access/credential-vault')
const { ModelAccessRuntime } = require('../../src/agent/model-access/runtime')
const { createPersonalContextExecutionAdapter } = require('../../src/agent/personal-context')
const { AgentLoopExecutor, ContextIngestSessionRunner, FormalAgentRunRunner } = require('../../src/agent/execution-host')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')
const { FORMAL_AGENT_MIGRATIONS } = require('../../src/runtime/storage-worker/schema')
const { canonicalize, sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')
const { PersonalContextRuntime } = require('../../src/agent/personal-context/runtime')
const { evaluateAutomaticEligibility } = require('../../src/agent/personal-context/automatic-eligibility')
const { ConfigStore } = require('../../src/main/services/config-store')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { buildExportSnapshot } = require('../../src/agent/formal-run/agent-interaction-exporter')
const { PersonalContextStore } = require('../../src/runtime/storage-worker/personal-context-store')
const { AgentExecutionStore } = require('../../src/runtime/storage-worker/agent-execution-store')
const { ModelAccessStore } = require('../../src/runtime/storage-worker/model-access-store')
const { transport } = require('./helpers/context-storage-transport')
const { AgentRunService } = require('../../src/agent/formal-run/agent-run-service')
const runContract = require('../../src/agent/contracts/agent-run-ui')

async function fixture (t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-journey-'))
  const databasePath = path.join(root, 'context.sqlite3')
  const service = new StorageWorkerService(options.now ? {
    storeFactory: settings => new SqliteSubtitleStore({ ...settings, migrations: FORMAL_AGENT_MIGRATIONS, now: options.now }),
    personalContextStoreFactory: subtitleStore => new PersonalContextStore({ subtitleStore, now: options.now }),
    agentExecutionStoreFactory: (subtitleStore, personalContextStore) => new AgentExecutionStore({ subtitleStore, personalContextStore, now: options.now }),
    modelAccessStoreFactory: subtitleStore => new ModelAccessStore({ subtitleStore, now: options.now })
  } : {})
  const gateway = new StorageGateway({ databasePath, hostFactory: () => transport(service, databasePath), maxRestarts: 0 })
  await gateway.start()
  const vault = new CredentialVault({ directory: path.join(root, 'vault'), safeStorage: {
    isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).reverse(), decryptString: value => Buffer.from(value).reverse().toString()
  } })
  t.after(async () => { vault.close(); await gateway.shutdown(); fs.rmSync(root, { recursive: true, force: true }) })
  const calls = []
  const questionCalls = []
  const modelAccess = new ModelAccessRuntime({ gateway, vault, adapter: { async run (request) {
    const { recipe, prompt } = request
    await request.beforeRequest({ turn: 1 })
    if (recipe.recipeId === 'qa.answer') {
      const payload = JSON.parse(prompt)
      questionCalls.push(payload)
      if (options.questionProvider) await options.questionProvider(payload, questionCalls.length)
      if (recipe.recipeVersion === '3') {
        const plan = payload.questionPlan
        const sourceRefs = [{ sessionId: plan.source.sessionId, transcriptVersion: 'raw',
          fromEventOrder: plan.parts[0].eventOrder || plan.parts[0].fromEventOrder,
          throughEventOrder: plan.parts.at(-1).eventOrder || plan.parts.at(-1).throughEventOrder }]
        await request.onRequestUsage(null)
        return { text: JSON.stringify({ schemaVersion: 1, answer: '受控来源片段分析。', sourceRefs, memoryRefs: [], unresolved: [] }) }
      }
      const input = payload.questionEvidence || { sources: payload.questionMerge.parts.flatMap(part => part.sourceRefs.map(sourceRef => ({ sourceRef, text: part.answer }))) }
      const source = input.sources.find(source => source.text.includes('32768')) || input.sources.at(-1)
      if (JSON.parse(prompt).userPrompt === '令牌预算配置值') {
        assert.ok(source?.text.includes('32768'))
        assert.ok(source?.text.includes('65536已撤销'))
      }
      const output = { schemaVersion: 2, answer: source ? '当前证据包含讨论片段，需要保留较晚修订。' : '当前检索证据不足。',
        claims: source ? [{ text: '当前证据包含讨论片段', sourceRefs: [source.sourceRef], memoryRefs: [] }] : [],
        sourceRefs: source ? [source.sourceRef] : [], memoryRefs: [], unresolved: source ? [] : ['没有足够原文证据。'], coverage: null }
      if (options.qaOutput) options.qaOutput(output, input)
      await request.onRequestUsage(null)
      return { text: JSON.stringify(output) }
    }
    assert.equal(recipe.recipeVersion, '3')
    const range = JSON.parse(prompt).experienceRange
    calls.push(range.parts.map(({ text, ...part }) => part))
    if (options.provider) await options.provider(range, calls.length)
    const evidence = { sessionId: range.source.sessionId, transcriptVersion: 'raw',
      fromEventOrder: range.parts[0].eventOrder, throughEventOrder: range.parts.at(-1).eventOrder }
    await request.onRequestUsage(null)
    const output = { schemaVersion: 3, stage: 'range', content: { schemaVersion: 2, questionSummary: null,
      experiences: [{ kind: 'decision', text: '项目范围讨论保留决定与修订', evidence, confidence: 'high' }],
      memoryCandidates: [], associations: [] } }
    if (options.rangeOutput) options.rangeOutput(output, range, calls.length)
    return { text: JSON.stringify(output) }
  } } })
  await modelAccess.initialize()
  const configure = async command => {
    const catalog = await modelAccess.catalog()
    const result = await modelAccess.configure({ ...command, expectedRevision: catalog.snapshot.revision })
    assert.equal(result.ok, true)
  }
  await configure({ type: 'addModel', profileId: 'deepseek', modelId: 'experience-synthetic', capabilities: {
    maxInputTokens: 60000, maxOutputTokens: 4096, supportsToolCalling: true, supportsStructuredOutput: true, supportsStreaming: true, usageReporting: false
  } })
  await configure({ type: 'setCredential', profileId: 'deepseek', credential: 'synthetic-secret' })
  await configure({ type: 'assignPurpose', purpose: 'default', target: { profileId: 'deepseek', modelId: 'experience-synthetic' } })
  await gateway.applyPersonalContextAutomaticPolicy({ agentEnabled: true, automaticProcessingSince: 0, memoryEnabled: true, memoryProcessingSince: 0 })
  const context = createPersonalContextExecutionAdapter({ storage: gateway })
  const runner = new ContextIngestSessionRunner({ personalContext: context, storage: gateway, modelAccess, ingestRecipeVersion: '3',
    interactions: { create: value => gateway.createAgentInteraction(value), terminalize: value => gateway.terminalizeAgentInteraction(value) },
    loopFactory: binding => new AgentLoopExecutor({ adapter: modelAccess.createLoopAdapter(binding) }) })
  const sessionId = 'session.experience'
  await gateway.openSession({ sessionId, sourceId: 'mic', startedAt: 10, refinementEnabled: options.refineIndex !== undefined })
  const texts = options.segments || [options.text || '项目X讨论 😀 e\u0301 与否定修订。'.repeat(4500), '较晚决定：取消旧日期，改为10月8日。']
  for (const [index, text] of texts.entries()) {
    await gateway.appendCaption({ schemaVersion: 1, sessionId, sourceId: 'mic', segmentId: `segment.${index}`, sequence: index + 1,
      revision: 1, kind: 'final', t0: index * 10, t1: (index + 1) * 10, text, translation: null })
  }
  if (options.refineIndex !== undefined) await gateway.appendCaption({ schemaVersion: 1, sessionId, sourceId: 'mic', segmentId: `segment.${options.refineIndex}`,
    sequence: texts.length + 1, revision: 2, kind: 'refined', t0: 777, t1: 780, text: '精修稿保留预算32768', translation: null })
  await gateway.closeSession({ sessionId, sourceId: 'mic', state: 'closed', endedAt: Math.max(30010, 10 + texts.length * 10000) })
  if (options.beforePrepare) await options.beforePrepare({ gateway, service, sessionId })
  const prepared = await runner.prepare({ sessionId, transcriptVersion: 'raw' })
  let claimNumber = 0
  const claim = () => gateway.claimNextFormalAgentRun({ owner: 'experience.owner', leaseMs: 60000, claimIdempotencyKey: `claim.experience.${++claimNumber}` })
  let questionNumber = 0
  const ask = async (query, native = false, scope = { kind: 'session', reference: sessionId }, recipeVersion = '4') => {
    let runId = `run.question.${++questionNumber}`
    let interactionId = `interaction.question.${questionNumber}`
    if (native) {
      const service = new AgentRunService({ storage: gateway, modelAccess })
      const response = await service.submit({ contract_id: runContract.CONTRACT_ID, contract_version: runContract.CONTRACT_VERSION,
        scope, prompt: query, client_idempotency_key: `question.native.${questionNumber}` })
      assert.equal(response.ok, true)
      runId = response.result.run_id; interactionId = response.result.interaction_id
    } else {
      await gateway.createAgentRun({ runId, recipeId: 'qa.answer', recipeVersion, scope: { kind: 'session', reference: sessionId },
      transcriptVersion: 'raw', inputWatermark: { throughEventOrder: prepared.source.inputWatermark }, inputDigest: prepared.source.inputDigest,
      requestedBy: 'user', clientIdempotencyKey: `question.key.${questionNumber}` })
    await modelAccess.bind({ runId, recipeId: 'qa.answer', recipeVersion, executionForm: 'agent_loop' })
    await gateway.createAgentInteraction({ runId, interactionId, routingMode: 'preset', promptDigest: sha256Canonical(query) })
    }
    const job = await gateway.claimNextFormalAgentRun({ owner: 'question.owner', requestedBy: 'user', leaseMs: 60000,
      claimIdempotencyKey: `claim.question.${questionNumber}` })
    const started = performance.now()
    const questionRunner = new FormalAgentRunRunner({ storage: gateway, personalContext: context, modelAccess, promptProvider: () => query,
      interactions: { terminalize: value => gateway.terminalizeAgentInteraction(value),
        startToolCall: value => gateway.startAgentToolCall(value), finishToolCall: value => gateway.finishAgentToolCall(value) },
      loopFactory: binding => new AgentLoopExecutor({ adapter: modelAccess.createLoopAdapter(binding) }) })
    const result = await questionRunner.run({ ...job, getWallClockElapsedMs: () => Math.floor(performance.now() - started) })
    return { result, runId, interactionId }
  }
  return { runner, gateway, service, calls, questionCalls, claim, prepared, sessionId, databasePath, ask, modelAccess }
}

test('SEM-F28/F39/J21-EXPERIENCE: long terminal source publishes reusable ranges and source boundaries through real internal modules', async t => {
  const f = await fixture(t)
  const job = await f.claim()
  assert.equal(job.recipeVersion, '3')
  assert.equal(job.requestLimit, 512)
  const result = await f.runner.run(job)
  assert.equal(result?.state, 'succeeded', JSON.stringify({ calls: f.calls.length,
    run: f.service.requireStore().database.prepare('SELECT state,error_code FROM formal_agent_runs WHERE run_id=?').get(f.prepared.runId),
    ranges: f.service.requireStore().database.prepare('SELECT COUNT(*) AS n FROM personal_context_experience_ranges').get().n }))
  assert.ok(result.output.rangeCount > 1)
  assert.equal(result.output.completedRanges, result.output.rangeCount)
  const db = f.service.requireStore().database
  const ranges = db.prepare('SELECT * FROM personal_context_experience_ranges ORDER BY ordinal').all()
  assert.equal(ranges.length, f.calls.length)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personal_context_experiences').get().n, ranges.length)
  assert.equal(ranges.some(row => JSON.parse(row.parts_json).some(part => Object.hasOwn(part, 'text'))), false)
  assert.equal(db.prepare('SELECT MAX(occurred_through_offset_ms) AS n FROM personal_context_experiences').get().n, 20000)
  const replay = await f.runner.prepare({ sessionId: f.sessionId, transcriptVersion: 'raw' })
  assert.equal(replay.runId, f.prepared.runId)
  assert.equal(replay.state, 'succeeded')
  assert.equal(await f.claim(), null)
  assert.equal(f.calls.length, ranges.length)
  assert.equal(db.prepare('SELECT usage_known FROM formal_agent_run_input_plans').get().usage_known, 0)
  await f.gateway.shutdown()
  const reopened = new SqliteSubtitleStore({ databasePath: f.databasePath, migrations: FORMAL_AGENT_MIGRATIONS })
  try { assert.equal(reopened.database.prepare('SELECT COUNT(*) AS n FROM personal_context_experiences').get().n, ranges.length) } finally { reopened.close() }
})

test('SEM-F07/F39/J21-EXPERIENCE: session deletion cascades through reusable ranges and repeated deletion keeps its receipt', async t => {
  const f = await fixture(t, { text: '删除范围与引用' })
  await f.runner.run(await f.claim())
  const store = f.service.requireDeletionStore()
  const request = { sessionId: f.sessionId, deletionIdempotencyKey: 'delete.experience' }
  const receipt = store.deleteSessionData(request)
  assert.deepEqual(store.deleteSessionData(request), receipt)
  const db = f.service.requireStore().database
  for (const table of ['personal_context_experience_ranges', 'personal_context_experiences']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0)
  }
  await assert.rejects(f.runner.prepare({ sessionId: f.sessionId, transcriptVersion: 'raw' }))
})

test('SEM-F31/F39/J22-QA-RETRIEVAL: memory dormancy excludes personal products while raw subtitle evidence remains readable', async t => {
  const f = await fixture(t, { text: '项目预算32768' })
  await f.runner.run(await f.claim())
  await f.gateway.applyPersonalContextAutomaticPolicy({ agentEnabled: true, automaticProcessingSince: 0, memoryEnabled: false, memoryProcessingSince: null })
  const { result, runId } = await f.ask('预算')
  assert.equal(result.terminalReason, 'succeeded')
  const row = f.service.requireStore().database.prepare('SELECT descriptor_json FROM formal_agent_question_evidence WHERE run_id=?').get(runId)
  const descriptor = JSON.parse(row.descriptor_json)
  assert.equal(descriptor.memoryAllowed, false)
  assert.equal(descriptor.experiences.length, 0)
  assert.ok(descriptor.parts.length > 0)
})

test('SEM-F31/J22-QA-RETRIEVAL: the formal submit entry creates and executes the retrieval recipe', async t => {
  const f = await fixture(t, { text: '项目预算32768' })
  await f.runner.run(await f.claim())
  const { result, runId } = await f.ask('预算是多少', true)
  assert.equal(result.terminalReason, 'succeeded')
  assert.equal(f.service.requireStore().database.prepare('SELECT recipe_version FROM formal_agent_runs WHERE run_id=?').get(runId).recipe_version, '4')
  const service = new AgentRunService({ storage: f.gateway, modelAccess: f.modelAccess })
  const detail = await service.getInteraction({ contract_id: runContract.CONTRACT_ID, contract_version: runContract.CONTRACT_VERSION, interaction_id: result.interactionId })
  assert.equal(detail.result.source_positions[0].fromOffsetMs, 0)
  assert.equal(detail.result.source_positions[0].throughOffsetMs, 10000)
})

test('SEM-F31/F39/J22-QA-SCOPE: date scope freezes more than fifty sessions and processes every global evidence page', async t => {
  const f = await fixture(t, { text: '项目预算32768' })
  await f.runner.run(await f.claim())
  for (let index = 0; index < 51; index += 1) {
    const sessionId = `session.scope.${String(index).padStart(3, '0')}`
    await f.gateway.openSession({ sessionId, sourceId: 'mic', startedAt: 100 + index, refinementEnabled: false })
    await f.gateway.appendCaption({ schemaVersion: 1, sessionId, sourceId: 'mic', segmentId: `scope.segment.${index}`, sequence: 1,
      revision: 1, kind: 'final', t0: 0, t1: 1, text: `第${index}场项目记录`, translation: null })
    await f.gateway.closeSession({ sessionId, sourceId: 'mic', state: 'closed', endedAt: 200 + index })
  }
  const { result, runId } = await f.ask('所有会话的共同主题', true, { kind: 'date_range', reference: 'date.0.1000' })
  assert.equal(result?.terminalReason, 'succeeded', JSON.stringify(f.service.requireStore().database.prepare('SELECT state,error_code FROM formal_agent_runs WHERE run_id=?').get(runId)))
  assert.equal(result.result.coverage.scopeSessionCount, 52)
  assert.equal(result.result.coverage.visitedSessionCount, 52)
  assert.equal(result.result.coverage.summaryComplete, false)
  const visited = new Set(f.questionCalls.flatMap(call => (call.questionEvidence?.sources || []).map(source => source.sourceRef.sessionId)))
  assert.equal(visited.size, 52)
  assert.ok(f.questionCalls.length > 2)
  assert.equal(f.service.requireStore().database.prepare('SELECT COUNT(*) AS n FROM formal_agent_question_scope_sources').get().n, 52)
  assert.ok(f.questionCalls.flatMap(call => call.questionEvidence?.sources || []).every(source => /^\d{4}-\d{2}-\d{2}T/u.test(source.sessionStartedAt)))
  const exported = buildExportSnapshot(await f.gateway.getAgentInteraction({ interactionId: result.interactionId }))
  assert.equal(exported.schema_version, 6)
  assert.ok(exported.question_evidence.pages.length > 1)
})

test('SEM-F31/F39/J22-QA-SCOPE: negative existence questions scan every source slice before host marks full coverage', async t => {
  const f = await fixture(t, { text: `${'其它事项。'.repeat(3500)}预算32768` })
  await f.runner.run(await f.claim())
  const { result } = await f.ask('是否提到预算32768', true)
  assert.equal(result?.terminalReason, 'succeeded')
  assert.equal(result.result.coverage.mode, 'full_scan')
  assert.equal(result.result.coverage.sourceTextComplete, true)
  const evidence = f.questionCalls.flatMap(call => call.questionEvidence?.sources || [])
  assert.ok(evidence.some(source => source.text.includes('32768')))
  const covered = evidence.filter(source => source.segmentId === 'segment.0').sort((a, b) => a.codePointStart - b.codePointStart)
  assert.equal(covered[0].codePointStart, 0)
  for (let index = 1; index < covered.length; index += 1) assert.equal(covered[index].codePointStart, covered[index - 1].codePointEnd)
  assert.equal(covered.at(-1).codePointEnd, Array.from(`${'其它事项。'.repeat(3500)}预算32768`).length)
})

test('SEM-F31/SEM-T04/J22-QA-SCOPE: deleting a frozen source during analysis rejects the entire late result', async t => {
  let f
  f = await fixture(t, { text: '项目预算32768', questionProvider: async () => {
    f.service.requireDeletionStore().deleteSessionData({ sessionId: f.sessionId, deletionIdempotencyKey: 'delete.frozen.scope' })
  } })
  await f.runner.run(await f.claim())
  const { result, runId } = await f.ask('总体主题', true, { kind: 'date_range', reference: 'date.0.1000' })
  assert.equal(result, null)
  const row = f.service.requireStore().database.prepare('SELECT state FROM formal_agent_runs WHERE run_id=?').get(runId)
  assert.equal(row.state, 'failed')
  assert.equal(f.service.requireStore().database.prepare('SELECT result_json FROM formal_agent_interactions WHERE run_id=?').get(runId).result_json, null)
})

test('SEM-F31/F39/J22-QA-RETRIEVAL: short Chinese terms, dates, numbers and repeated questions rebuild the same authorized raw evidence', async t => {
  const f = await fixture(t, { text: '预算32768。原方案已撤销。日期改为10月8日。😀 e\u0301' })
  await f.runner.run(await f.claim())
  for (const query of ['预算', '32768', '10月8日', '撤销', 'é', '预算']) {
    const { result } = await f.ask(query, true)
    assert.equal(result?.terminalReason, 'succeeded')
    assert.ok(f.questionCalls.at(-1).questionEvidence.sources.some(source => source.text.includes('32768')))
  }
  const raw = f.questionCalls.map(call => call.questionEvidence.sources)
  assert.deepEqual(raw[0], raw.at(-1))
})

test('SEM-F31/SEM-T04/J22-QA-RETRIEVAL: cancellation before a late provider answer leaves no final result', async t => {
  let f
  f = await fixture(t, { text: '预算32768', questionProvider: async () => {
    const run = f.service.requireStore().database.prepare("SELECT run_id FROM formal_agent_runs WHERE recipe_id='qa.answer' AND state='running'").get()
    await f.gateway.cancelAgentRun({ runId: run.run_id })
  } })
  await f.runner.run(await f.claim())
  const { runId } = await f.ask('预算', true)
  const row = f.service.requireStore().database.prepare('SELECT state FROM formal_agent_runs WHERE run_id=?').get(runId)
  assert.equal(row.state, 'cancelled')
  assert.equal(f.service.requireStore().database.prepare('SELECT result_json FROM formal_agent_interactions WHERE run_id=?').get(runId).result_json, null)
})

test('SEM-F28/F30/F39/J21-EXPERIENCE: v3 freezes confirmed information without guessing an entity association', async t => {
  let memory
  const f = await fixture(t, { text: '项目X接口变更预算32768', beforePrepare: async ({ gateway, service }) => {
    const store = service.requirePersonalContextStore()
    memory = (await gateway.personalContextManage({ type: 'remember', expected_revision: store.contentRevision(),
      entry: { display_text: '我负责项目X的客户端', kind: 'project_fact', scope: { kind: 'global', reference: null } } })).item
  }, rangeOutput: (output, range) => {
    const confirmed = range.confirmedMemories[0]
    assert.ok(confirmed)
    assert.deepEqual(confirmed.entityKeys, [])
  } })
  const ingest = await f.runner.run(await f.claim())
  assert.equal(ingest?.state, 'succeeded')
  const { result } = await f.ask('预算', true)
  assert.equal(result?.terminalReason, 'succeeded')
  const store = f.service.requirePersonalContextStore()
  assert.equal(store.sessionAssociations(f.sessionId).length, 0)
  await f.gateway.personalContextManage({ type: 'update', expected_revision: store.contentRevision(), item_id: memory.memory_id,
    item_revision: memory.item_revision, entry: { display_text: '负责项目Y', kind: 'project_fact', scope: { kind: 'global', reference: null } } })
  assert.equal(store.sessionAssociations(f.sessionId).length, 0)
})

test('SEM-F31/F39/J29-QA-SOURCE: Agent renderer, production preload and source IPC open a later history page and return without a model call', async t => {
  const f = await fixture(t, { refineIndex: 61, segments: [...Array.from({ length: 61 }, (_value, index) => `其它事项${index}`), '预算32768，历史值已撤销。'] })
  await f.runner.run(await f.claim())
  const { result } = await f.ask('预算', true)
  assert.equal(result?.terminalReason, 'succeeded')
  const vm = require('node:vm')
  const React = require('react'); const { act } = React
  const { JSDOM } = require('jsdom')
  const { loadRendererModule } = require('../ui/load-renderer-module')
  const { registerAgentRunIpc } = require('../../src/main/ipc/agent-run-ipc')
  const { registerContextSourceIpc } = require('../../src/main/ipc/context-source-ipc')
  const { isRoleAllowed } = require('../../src/main/ipc/access-policy')
  const { HistoryService } = require('../../src/main/services/history-service')
  const CHANNELS = require('../../src/main/ipc/channels')
  const handlers = new Map(); const listeners = new Map(); const apis = {}
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) }
  const roles = { 1: 'agent', 2: 'history' }
  const authorize = (event, channel) => { if (!isRoleAllowed(channel, roles[event.sender.id])) throw new Error('permission denied') }
  const service = new AgentRunService({ storage: f.gateway, modelAccess: f.modelAccess })
  registerAgentRunIpc({ ipcMain, authorize, service })
  let opened; let returned = false
  registerContextSourceIpc({ ipcMain, authorize, getStorage: () => f.gateway, openSource: location => {
    opened = location
    for (const callback of listeners.get(`2:${CHANNELS.AGENT_CONTEXT_SOURCE_REQUESTED}`) || []) callback({}, location)
    return true
  }, returnSource: () => { returned = true; return true } })
  const history = new HistoryService({ gateway: f.gateway, showSaveDialog: async () => ({ canceled: true }) })
  let holdNextPage = null
  // Electron transports forward to the real HistoryService; source resolution,
  // paging, version selection, highlighting and renderer state stay production.
  for (const [channel, method] of [[CHANNELS.HISTORY_LIST, 'listSessions'], [CHANNELS.HISTORY_PAGE, 'getSessionPage']]) {
    handlers.set(channel, async (event, request) => {
      authorize(event, channel)
      const delay = method === 'getSessionPage' ? holdNextPage : null
      if (delay) holdNextPage = null
      const value = await history[method](request)
      if (delay) await delay
      return { ok: true, value }
    })
  }
  const config = new ConfigStore(path.join(path.dirname(f.databasePath), 'source-config.json')); config.load()
  config.updateAgentSettings({ expectedRevision: 0, agentEnabled: true, memoryEnabled: true, cloudDisclosureAccepted: true })
  handlers.set(CHANNELS.CONFIG_GET, () => config.get())
  function preload (name, senderId) {
    const ipcRenderer = {
      invoke: (channel, request) => Promise.resolve().then(() => handlers.get(channel)({ sender: { id: senderId } }, request)),
      on: (channel, callback) => { const key = `${senderId}:${channel}`; const set = listeners.get(key) || new Set(); set.add(callback); listeners.set(key, set) },
      removeListener: (channel, callback) => listeners.get(`${senderId}:${channel}`)?.delete(callback), send: () => {}
    }
    const electron = { ipcRenderer, contextBridge: { exposeInMainWorld: (key, value) => { apis[key] = value } } }
    const cache = new Map()
    const read = file => {
      if (cache.has(file)) return cache.get(file).exports
      const module = { exports: {} }; cache.set(file, module)
      const localRequire = specifier => {
        if (specifier === 'electron') return electron
        const target = path.resolve(path.dirname(file), specifier) + '.js'
        return target.startsWith(path.resolve('src/preload') + path.sep) ? read(target) : require(target)
      }
      vm.runInThisContext(`(function(require,module,exports){${fs.readFileSync(file, 'utf8')}\n})`)(localRequire, module, module.exports)
      return module.exports
    }
    read(path.resolve(`src/preload/${name}.js`))
  }
  preload('agent', 1); preload('history', 2)
  const dom = new JSDOM('<div id="agent"></div><div id="history"></div>', { url: 'http://source.test/' })
  const keys = ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT']
  const previous = Object.fromEntries(keys.map(key => [key, global[key]]))
  Object.assign(global, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true })
  Object.assign(window, apis)
  const { createRoot } = require('react-dom/client')
  const { AgentView } = await loadRendererModule(path.resolve('src/agent/agent-view.tsx'))
  const { HistoryView } = await loadRendererModule(path.resolve('src/history/history-view.tsx'))
  const agentRoot = createRoot(document.getElementById('agent')); const historyRoot = createRoot(document.getElementById('history'))
  t.after(async () => {
    await act(async () => { agentRoot.unmount(); historyRoot.unmount() }); dom.window.close()
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete global[key] : (global[key] = value)
  })
  const flush = () => act(async () => { for (let index = 0; index < 25; index += 1) await new Promise(resolve => setImmediate(resolve)) })
  const click = async element => { assert.ok(element); await act(async () => element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))); await flush() }
  await act(async () => { agentRoot.render(React.createElement(AgentView)); historyRoot.render(React.createElement(HistoryView)) }); await flush()
  const agent = document.getElementById('agent')
  await click([...agent.querySelectorAll('nav.session-functions button')].find(button => button.textContent === '会话问答'))
  await click(agent.querySelector('.history-card'))
  const before = f.questionCalls.length
  await click(agent.querySelector('.result-sources summary'))
  const button = [...agent.querySelectorAll('.result-sources button')].find(button => button.textContent.includes('查看引用原文'))
  assert.match(button.textContent, /610–620 秒/)
  await click(button)
  assert.equal(opened.offset, 61)
  assert.equal(opened.target.transcript_version, 'raw')
  assert.match(document.getElementById('history').textContent, /第 62–62 条/)
  assert.ok(document.querySelector('#history .source-highlight'))
  await click([...document.querySelectorAll('#history button')].find(button => button.textContent === '返回上一页面'))
  assert.equal(returned, true)
  assert.match(agent.textContent, /当前证据包含讨论片段/)
  assert.equal(f.questionCalls.length, before)
  let releasePage
  holdNextPage = new Promise(resolve => { releasePage = resolve })
  const raw = opened.target
  const refinedOrder = f.service.requireStore().database.prepare("SELECT event_order FROM caption_events WHERE session_id=? AND kind='refined'").get(f.sessionId).event_order
  await act(async () => apis.agentApi.openAgentContextSource(raw)); await flush()
  await act(async () => apis.agentApi.openAgentContextSource({ ...raw, transcript_version: 'refined', from_event_order: Number(refinedOrder), through_event_order: Number(refinedOrder) })); await flush()
  assert.equal(opened.offset, 61)
  releasePage(); await flush()
  assert.equal(document.querySelector('#history [data-version="refined"]').getAttribute('aria-checked'), 'true')
  assert.match(document.querySelector('#history .source-highlight').textContent, /精修稿保留预算32768/)
  assert.equal(f.questionCalls.length, before)
  f.service.requireDeletionStore().deleteSessionData({ sessionId: f.sessionId, deletionIdempotencyKey: 'delete.source.ui' })
  await click(button)
  assert.match(agent.textContent, /来源已失效|来源暂时|来源记录|无法打开/)
})

test('SEM-F28/F39/SEM-T04/J21-EXPERIENCE: cancellation preserves published prefix and rejects late writes', async t => {
  let fixtureValue
  const f = await fixture(t, { provider: async (_range, count) => {
    if (count === 2) await fixtureValue.gateway.cancelPersonalContextSessionIngest({ runId: fixtureValue.prepared.runId })
  } })
  fixtureValue = f
  const job = await f.claim()
  await f.runner.run(job)
  const db = f.service.requireStore().database
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personal_context_experience_ranges').get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personal_context_experiences').get().n, 1)
  const run = db.prepare('SELECT state FROM formal_agent_runs WHERE run_id=?').get(f.prepared.runId)
  assert.ok(['cancelled', 'running'].includes(run.state))
  await assert.rejects(f.gateway.personalContextSessionExperiences({ action: 'status', attemptIdentity: job.attemptIdentity }), /AGENT_CONTEXT_OPERATION_FAILED|AGENT_CANCELLED/)
})

test('SEM-F28/F39/SEM-T04/J21-EXPERIENCE: transient failure resumes after the committed prefix with the frozen plan and run usage', async t => {
  let failProvider = true
  const f = await fixture(t, { provider: async (_range, count) => {
    if (count > 1 && failProvider) {
      const error = new Error('AGENT_PROVIDER_UNAVAILABLE'); error.code = 'AGENT_PROVIDER_UNAVAILABLE'; throw error
    }
  } })
  await f.runner.run(await f.claim())
  const db = f.service.requireStore().database
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personal_context_experience_ranges').get().n, 1)
  const prior = db.prepare('SELECT plan_digest FROM formal_agent_run_input_plans').get().plan_digest
  const priorRequests = db.prepare('SELECT request_count FROM formal_agent_run_budget_state').get().request_count
  failProvider = false
  db.prepare('UPDATE formal_agent_runs SET next_attempt_at=0 WHERE run_id=?').run(f.prepared.runId)
  const second = await f.claim()
  assert.equal(second.attemptIdentity.attempt, 2)
  const result = await f.runner.run(second)
  assert.equal(result?.state, 'succeeded')
  assert.equal(db.prepare('SELECT plan_digest FROM formal_agent_run_input_plans').get().plan_digest, prior)
  assert.ok(db.prepare('SELECT request_count FROM formal_agent_run_budget_state').get().request_count > priorRequests)
  assert.notDeepEqual(f.calls[0], f.calls[2])
  assert.equal(db.prepare('SELECT usage_known FROM formal_agent_run_input_plans').get().usage_known, 0)
})

test('SEM-F28/F39/SEM-T04/J21-EXPERIENCE: settled ownership cannot publish a product and disabling memory keeps the existing prefix dormant', async t => {
  const f = await fixture(t)
  const job = await f.claim()
  await f.runner.run(job)
  const db = f.service.requireStore().database
  const ranges = db.prepare('SELECT COUNT(*) AS n FROM personal_context_experience_ranges').get().n
  await assert.rejects(f.gateway.personalContextSessionExperiences({ action: 'status', attemptIdentity: job.attemptIdentity }), /AGENT_CONTEXT_OPERATION_FAILED/)
  await f.gateway.applyPersonalContextAutomaticPolicy({ agentEnabled: true, automaticProcessingSince: 0, memoryEnabled: false, memoryProcessingSince: null })
  assert.equal(await f.claim(), null)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personal_context_experience_ranges').get().n, ranges)
})

test('SEM-F07/T08/DB1/DB7: v25 appends to the frozen catalog and upgrades an existing v24 database', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'experience-migration-'))
  const databasePath = path.join(root, 'context.sqlite3')
  let current
  t.after(() => { current?.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const legacy = new SqliteSubtitleStore({ databasePath, migrations: FORMAL_AGENT_MIGRATIONS.filter(item => item.version <= 24) })
  legacy.openSession({ sessionId: 'session.migration', sourceId: 'mic', startedAt: 10, refinementEnabled: false })
  legacy.closeSession({ sessionId: 'session.migration', sourceId: 'mic', endedAt: 20, state: 'closed' })
  legacy.close()
  current = new SqliteSubtitleStore({ databasePath, migrations: FORMAL_AGENT_MIGRATIONS })
  assert.equal(current.database.prepare('SELECT COUNT(*) AS n FROM sessions').get().n, 1)
  assert.equal(current.database.prepare('SELECT COUNT(*) AS n FROM personal_context_experience_ranges').get().n, 0)
})

test('SEM-F31/F39/J22-QA-RETRIEVAL: independent raw recall finds numeric detail omitted by every experience product', async t => {
  const f = await fixture(t, { text: `${'其它项目讨论 😀 e\u0301。'.repeat(3500)}令牌预算配置值32768，历史值65536已撤销。${'继续讨论。'.repeat(3500)}` })
  await f.runner.run(await f.claim())
  const { result, runId } = await f.ask('令牌预算配置值')
  assert.equal(result?.terminalReason, 'succeeded', JSON.stringify(f.service.requireStore().database.prepare('SELECT state,error_code FROM formal_agent_runs WHERE run_id=?').get(runId)))
  assert.equal(result.result.schemaVersion, 2)
  assert.equal(result.result.coverage.summaryComplete, true)
  assert.equal(result.result.coverage.sourceTextComplete, false)
  assert.equal(result.result.claims[0].sourceRefs.length, 1)
  const evidence = f.service.requireStore().database.prepare('SELECT * FROM formal_agent_question_evidence WHERE run_id=?').get(runId)
  assert.equal(JSON.stringify(JSON.parse(evidence.descriptor_json)).includes('32768'), false)
  const detail = await f.gateway.getAgentInteraction({ interactionId: result.interactionId })
  const exported = buildExportSnapshot(detail)
  assert.equal(exported.schema_version, 5)
  assert.equal(exported.question_input_policy, 'question-retrieval@1')
  assert.deepEqual(exported.question_evidence.coverage, result.result.coverage)
})

test('SEM-F31/SEM-T04/J22-QA-RETRIEVAL: a claim citing a summary locator outside the supplied snippets is rejected', async t => {
  const f = await fixture(t, { qaOutput: output => {
    const ref = { ...output.sourceRefs[0], fromEventOrder: 999, throughEventOrder: 999 }
    output.sourceRefs = [ref]; output.claims[0].sourceRefs = [ref]
  } })
  await f.runner.run(await f.claim())
  const { runId } = await f.ask('项目决定')
  assert.deepEqual({ ...f.service.requireStore().database.prepare('SELECT state,error_code FROM formal_agent_runs WHERE run_id=?').get(runId) },
    { state: 'failed', error_code: 'AGENT_OUTPUT_INVALID' })
})

test('SEM-F31/F39/SEM-T04/J22-QA-RETRIEVAL: insufficient frozen model capacity rejects before a provider request', async t => {
  const f = await fixture(t, { text: '项目预算32768' })
  await f.runner.run(await f.claim())
  const catalog = await f.modelAccess.catalog()
  assert.equal((await f.modelAccess.configure({ type: 'updateModel', expectedRevision: catalog.snapshot.revision,
    profileId: 'deepseek', modelId: 'experience-synthetic', capabilities: {
      maxInputTokens: 8192, maxOutputTokens: 4096, supportsToolCalling: true, supportsStructuredOutput: true, supportsStreaming: true, usageReporting: false
    } })).ok, true)
  const { runId } = await f.ask('预算')
  assert.deepEqual({ ...f.service.requireStore().database.prepare('SELECT state,error_code FROM formal_agent_runs WHERE run_id=?').get(runId) },
    { state: 'failed', error_code: 'AGENT_BUDGET_EXCEEDED' })
  assert.equal(f.questionCalls.length, 0)
  const recorder = new SqliteSessionRecorder({ gateway: f.gateway })
  await recorder.openSession({ sessionId: 'session.after.budget', sourceId: 'loopback', refinementEnabled: false })
  await recorder.acceptCaption({ schemaVersion: 1, sessionId: 'session.after.budget', sourceId: 'loopback', segmentId: 'segment.after.budget', sequence: 1,
    revision: 1, kind: 'final', t0: 0, t1: 1, text: '新的字幕会话', translation: null })
  await recorder.closeSession({ sessionId: 'session.after.budget', sourceId: 'loopback', state: 'closed' })
  assert.equal((await f.gateway.getSessionTranscript('session.after.budget')).segments.length, 1)
})

test('SEM-F31/F39/J22-QA-SCOPE: project directory pages preserve IDs for equal labels and never infer absent source associations', async t => {
  const f = await fixture(t, { text: '项目预算32768', beforePrepare: async ({ service }) => {
    const store = service.requirePersonalContextStore()
    const insert = store.database.prepare(`INSERT INTO personal_context_scopes(scope_id,kind,canonical_key,label,session_id,origin,lifecycle,created_at,updated_at)
      VALUES(?,'project',?,?,NULL,'automatic','active',0,0)`)
    // Seed a valid persisted catalog with duplicate presentation labels; every
    // query, cursor and source-qualification decision below is production code.
    for (let index = 0; index < 53; index += 1) insert.run(`scope.project.${String(index).padStart(3, '0')}`, `project:${index}`, '同名项目')
  } })
  const service = new AgentRunService({ storage: f.gateway, modelAccess: f.modelAccess })
  const headers = { contract_id: runContract.CONTRACT_ID, contract_version: runContract.CONTRACT_VERSION }
  let cursor = null; const scopes = []
  do {
    const response = await service.getScopes({ ...headers, kind: 'project', limit: 20, cursor })
    assert.equal(response.ok, true)
    scopes.push(...response.scopes); cursor = response.next_cursor
  } while (cursor)
  assert.equal(scopes.length, 53)
  assert.equal(new Set(scopes.map(item => item.scope.reference)).size, 53)
  assert.equal(new Set(scopes.map(item => item.display_name)).size, 53)
  for (const item of scopes.slice(0, 2)) await assert.rejects(f.gateway.personalContextQuestionEvidence({ action: 'freeze', scope: item.scope }), { code: 'AGENT_INPUT_EMPTY' })
  assert.equal((await service.getEligibility({ ...headers, scope: scopes[0].scope })).snapshot.eligibility, 'no_committed_transcript')
  await f.gateway.applyPersonalContextAutomaticPolicy({ agentEnabled: true, automaticProcessingSince: 0, memoryEnabled: false, memoryProcessingSince: null })
  assert.equal((await service.getScopes({ ...headers, kind: 'project', limit: 20, cursor: null })).scopes.length, 0)
})

test('SEM-F31/F39/SEM-T04/J22-QA-SCOPE: altered evidence page boundaries reject a late answer', async t => {
  let db
  const f = await fixture(t, { text: '项目预算32768', questionProvider: async (_payload, number) => {
    if (number !== 1) return
    const row = db.prepare('SELECT run_id,ordinal,descriptor_json FROM formal_agent_question_evidence_pages LIMIT 1').get()
    const descriptor = JSON.parse(row.descriptor_json); descriptor.parts[0].codePointStart += 1
    db.prepare('UPDATE formal_agent_question_evidence_pages SET descriptor_json=? WHERE run_id=? AND ordinal=?')
      .run(JSON.stringify(descriptor), row.run_id, row.ordinal)
  } })
  await f.runner.run(await f.claim()); db = f.service.requireStore().database
  const { runId, interactionId } = await f.ask('所有会话的总体主题', true, { kind: 'date_range', reference: 'date.0.1000' })
  assert.deepEqual({ ...db.prepare('SELECT state,error_code FROM formal_agent_runs WHERE run_id=?').get(runId) },
    { state: 'failed', error_code: 'AGENT_REQUEST_INVALID' })
  assert.equal((await f.gateway.getAgentInteraction({ interactionId })).interaction.result, null)
})

test('SEM-F31/F39/J22-QA-RETRIEVAL/J24-QA-COMPAT: controlled strategy comparison measures source recall and request bytes without body evidence', async t => {
  const f = await fixture(t, { text: `${'其它议题讨论。'.repeat(12000)}预算32768，65536已撤销；日期2026-10-08；café。${'继续讨论。'.repeat(4000)}` })
  await f.runner.run(await f.claim())
  const db = f.service.requireStore().database
  const summaries = db.prepare('SELECT text FROM personal_context_experiences').all().map(row => row.text)
  const normalize = text => text.normalize('NFKC').toLocaleLowerCase('und')
  const queries = ['预算', '32768', '2026-10-08', 'café', '撤销', '预算']
  const cases = []
  for (const [index, query] of queries.entries()) {
    const beforeWhole = f.questionCalls.length
    const whole = await f.ask(query, false, undefined, '3')
    assert.equal(whole.result?.terminalReason, 'succeeded')
    const wholeCalls = f.questionCalls.slice(beforeWhole)
    const wholeText = wholeCalls.flatMap(call => call.questionPlan.stage === 'leaf' ? call.questionPlan.parts.map(part => part.text) : []).join('')
    const beforeCombined = f.questionCalls.length
    const combined = await f.ask(query)
    assert.equal(combined.result?.terminalReason, 'succeeded')
    const combinedCalls = f.questionCalls.slice(beforeCombined)
    const combinedText = combinedCalls.flatMap(call => call.questionEvidence?.sources.map(part => part.text) || []).join('')
    assert.ok(normalize(wholeText).includes(normalize(query)))
    assert.ok(normalize(combinedText).includes(normalize(query)))
    assert.equal(summaries.some(text => normalize(text).includes(normalize(query))), false)
    const measurement = calls => ({ requests: calls.length, serializedPromptBytes: calls.reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(canonicalize(value))), 0),
      maxSerializedPromptBytes: Math.max(...calls.map(value => Buffer.byteLength(JSON.stringify(canonicalize(value))))), sourceRecall: true })
    const full = measurement(wholeCalls); const selected = measurement(combinedCalls)
    assert.ok(selected.serializedPromptBytes < full.serializedPromptBytes)
    assert.ok(selected.requests < full.requests)
    const wholeExport = buildExportSnapshot(await f.gateway.getAgentInteraction({ interactionId: whole.interactionId }))
    const combinedExport = buildExportSnapshot(await f.gateway.getAgentInteraction({ interactionId: combined.interactionId }))
    assert.equal(wholeExport.schema_version, 4); assert.equal(combinedExport.schema_version, 5)
    cases.push({ caseIndex: index, questionDigest: sha256Canonical(query), whole: full,
      summaryOnly: { hintCount: summaries.length, hintBytes: summaries.reduce((sum, text) => sum + Buffer.byteLength(text), 0), sourceRecall: false, requests: null },
      combined: { ...selected, summaryComplete: combined.result.result.coverage.summaryComplete, sourceTextComplete: combined.result.result.coverage.sourceTextComplete } })
  }
  const evidence = { schemaVersion: 1, provider: 'controlled', contentQualityEvaluated: false, knownTokenUsage: null,
    summaryOnlyEvaluation: 'source_availability_ablation', cases }
  fs.mkdirSync(path.resolve('.artifacts'), { recursive: true })
  fs.writeFileSync(path.resolve('.artifacts/session-question-strategy-evaluation.json'), `${JSON.stringify(evidence, null, 2)}\n`)
})

test('SEM-F28/F39/J21-EXPERIENCE: formal runtime defaults to v3 and schedules a newly committed terminal session through real modules', async t => {
  const f = await fixture(t, { text: '既有会话' })
  await f.runner.run(await f.claim())
  const config = new ConfigStore(path.join(path.dirname(f.databasePath), 'agent-config.json'), { now: () => 10 })
  config.load()
  config.updateAgentSettings({ expectedRevision: 0, agentEnabled: true, memoryEnabled: true, cloudDisclosureAccepted: true })
  const recorder = new SqliteSessionRecorder({ gateway: f.gateway, now: () => 1000 })
  const runtime = new PersonalContextRuntime({ gateway: f.gateway, config, modelAccess: f.modelAccess,
    loopFactory: binding => new AgentLoopExecutor({ adapter: f.modelAccess.createLoopAdapter(binding) }),
    getAutomaticEligibility: async ({ sessionId }) => {
      const detail = await f.gateway.getSessionTranscript(sessionId)
      return evaluateAutomaticEligibility({ session: detail.session, segmentCount: detail.segments.length, settings: config.get(), catalog: await f.modelAccess.catalog() })
    } })
  runtime.start(recorder)
  try {
    await recorder.openSession({ sessionId: 'session.runtime.experience', sourceId: 'mic', refinementEnabled: false })
    await recorder.acceptCaption({ schemaVersion: 1, sessionId: 'session.runtime.experience', sourceId: 'mic', segmentId: 'segment.runtime', sequence: 1,
      revision: 1, kind: 'final', t0: 0, t1: 1, text: '项目讨论决定及修订。'.repeat(3000), translation: null })
    await recorder.closeSession({ sessionId: 'session.runtime.experience', sourceId: 'mic', state: 'closed' })
    let run
    for (let tries = 0; tries < 2000; tries += 1) {
      await new Promise(resolve => setImmediate(resolve))
      run = f.service.requireStore().database.prepare("SELECT recipe_version,state FROM formal_agent_runs WHERE json_extract(scope_json,'$.reference')='session.runtime.experience'").get()
      if (run && ['succeeded', 'failed', 'cancelled'].includes(run.state)) break
    }
    assert.deepEqual({ ...run }, { recipe_version: '3', state: 'succeeded' })
  } finally { await runtime.stop() }
})

test('SEM-F28/F39/DB7/J21-EXPERIENCE: range replay is idempotent and conflicting output cannot replace its product', async t => {
  let f
  let identity
  f = await fixture(t, { provider: async (_range, count) => {
    if (count !== 2) return
    const row = f.service.requireStore().database.prepare('SELECT * FROM personal_context_experience_ranges WHERE ordinal=0').get()
    const parts = JSON.parse(row.parts_json)
    const evidence = { sessionId: f.sessionId, transcriptVersion: 'raw', fromEventOrder: parts[0].eventOrder, throughEventOrder: parts.at(-1).eventOrder }
    const output = { schemaVersion: 3, stage: 'range', content: { schemaVersion: 2, questionSummary: null,
      experiences: [{ kind: 'decision', text: '项目范围讨论保留决定与修订', evidence, confidence: 'high' }], memoryCandidates: [], associations: [] } }
    const request = { action: 'commit', attemptIdentity: identity, ordinal: 0, planDigest: row.plan_digest, parts, output }
    const replay = await f.gateway.personalContextSessionExperiences(request)
    assert.equal(replay.replayed, true)
    output.content.experiences[0].text = '不同结果'
    await assert.rejects(f.gateway.personalContextSessionExperiences(request), /AGENT_REQUEST_IDENTITY_CONFLICT/)
    assert.equal(f.service.requireStore().database.prepare('SELECT COUNT(*) AS n FROM personal_context_experience_ranges').get().n, 1)
  } })
  const job = await f.claim()
  identity = job.attemptIdentity
  assert.equal((await f.runner.run(job))?.state, 'succeeded')
})

test('SEM-F28/F39/SEM-T04/DB7/J21-EXPERIENCE: a later invalid candidate rolls back every write from that range', async t => {
  const f = await fixture(t, { rangeOutput: (output, _range, count) => {
    if (count !== 2) return
    const candidate = { scopeKind: 'session', scopeKeyProposal: null, kind: 'decision', content: '候选甲', confidence: 'high', salience: 'high',
      evidence: output.content.experiences[0].evidence, attribution: 'session_context', entityKeys: [], userEvidence: null }
    output.content.memoryCandidates = [candidate, { ...candidate, scopeKind: 'project', scopeKeyProposal: null, content: '候选乙' }]
  } })
  await f.runner.run(await f.claim())
  const db = f.service.requireStore().database
  assert.deepEqual({ ...db.prepare('SELECT state,error_code FROM formal_agent_runs WHERE run_id=?').get(f.prepared.runId) },
    { state: 'failed', error_code: 'AGENT_OUTPUT_INVALID' })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personal_context_experience_ranges').get().n, 1)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personal_context_items').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personal_context_evidence').get().n, 0)
})

test('SEM-F28/F39/SEM-T04/J21-EXPERIENCE: an expired lease rejects the old writer and reclaim retains its conservative budget charge', async t => {
  let now = 100000
  const f = await fixture(t, { now: () => now, provider: async (_range, count) => { if (count === 1) now += 61000 } })
  const old = await f.claim()
  await assert.rejects(f.runner.run(old), /AGENT_CONTEXT_OPERATION_FAILED/)
  const db = f.service.requireStore().database
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personal_context_experience_ranges').get().n, 0)
  const next = await f.claim()
  assert.equal(next.attemptIdentity.attempt, 2)
  assert.equal((await f.runner.run(next))?.state, 'succeeded')
  assert.ok(db.prepare('SELECT conservative_elapsed_ms AS n FROM formal_agent_run_budget_state').get().n >= 60000)
})
