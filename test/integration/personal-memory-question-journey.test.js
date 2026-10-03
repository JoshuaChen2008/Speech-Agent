'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PersonalContextRuntime } = require('../../src/agent/personal-context/runtime')
const { AgentRunService } = require('../../src/agent/formal-run/agent-run-service')
const { AgentInteractionSignalService } = require('../../src/agent/formal-run/agent-interaction-signal-service')
const { AgentLoopExecutor, FormalAgentJobScheduler, FormalAgentRunRunner } = require('../../src/agent/execution-host')
const { CredentialVault } = require('../../src/agent/model-access/credential-vault')
const { ModelAccessRuntime } = require('../../src/agent/model-access/runtime')
const { ConfigStore } = require('../../src/main/services/config-store')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')
const { FORMAL_AGENT_MIGRATIONS } = require('../../src/runtime/storage-worker/schema')
const { OPERATIONS, PROTOCOL_VERSION, StorageError, makeCaptionEventId, makeCloseSessionKey, makeOpenSessionKey } = require('../../src/runtime/storage-worker/protocol')
const c = require('../../src/agent/contracts/agent-context-ui')
const { evaluateAutomaticEligibility } = require('../../src/agent/personal-context/automatic-eligibility')

const HEADER = { contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION }
const RUN_HEADER = { contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0' }

// Thin in-process transport; all storage/gateway/controller/Loop implementations
// remain real. The provider and OS credential boundary alone are controlled.
function transport (service, databasePath) {
  let sequence = 0
  const call = async (operation, payload, idempotencyKey) => {
    const response = await service.handle({ version: PROTOCOL_VERSION, type: 'storage:request', requestId: `question.${++sequence}`, operation, payload, ...(idempotencyKey ? { idempotencyKey } : {}) })
    if (!response.ok) throw new StorageError(response.error.code)
    return response.result
  }
  const host = {
    state: 'stopped',
    async start () { await call(OPERATIONS.INITIALIZE, { databasePath }); this.state = 'ready' },
    openSession: (v) => call(OPERATIONS.OPEN_SESSION, v, makeOpenSessionKey(v.sessionId)),
    appendCaption: (v) => call(OPERATIONS.APPEND_CAPTION, { event: v }, makeCaptionEventId(v)),
    closeSession: (v) => call(OPERATIONS.CLOSE_SESSION, v, makeCloseSessionKey(v.sessionId)),
    getSessionTranscript: (sessionId) => call(OPERATIONS.GET_SESSION, { sessionId }),
    listSessions: (input) => call(OPERATIONS.LIST_SESSIONS, input),
    nextFormalAgentRunAt: (request = {}) => call(OPERATIONS.FORMAL_AGENT_NEXT_RUN_AT, request),
    modelAccessCatalog: () => call(OPERATIONS.MODEL_ACCESS_CATALOG, {}),
    modelAccessConfigure: (input) => call(OPERATIONS.MODEL_ACCESS_CONFIGURE, { input }),
    modelAccessBind: (request, availableSlotIds) => call(OPERATIONS.MODEL_ACCESS_BIND, { request, availableSlotIds }),
    personalContextIngest: (source) => call(OPERATIONS.PERSONAL_CONTEXT_INGEST, { source }),
    personalContextManage: (command) => call(OPERATIONS.PERSONAL_CONTEXT_MANAGE, { command }),
    personalContextResolve: (request) => call(OPERATIONS.PERSONAL_CONTEXT_RESOLVE, { request }),
    readPersonalContextSessionInput: (source) => call(OPERATIONS.PERSONAL_CONTEXT_READ_SESSION_INPUT, { source }),
    readPersonalContextInteractionInput: (source, ephemeral) => call(OPERATIONS.PERSONAL_CONTEXT_READ_INTERACTION_INPUT, { source, ephemeral }),
    async shutdown () { if (!service.shuttingDown) await call(OPERATIONS.SHUTDOWN, {}); this.state = 'closed' },
    async terminateAndWait () { await this.shutdown(); return 0 }
  }
  for (const [method, operation] of Object.entries({
    derivePersonalContextSessionSource: 'PERSONAL_CONTEXT_DERIVE_SESSION_SOURCE',
    preparePersonalContextSessionIngest: 'PERSONAL_CONTEXT_PREPARE_SESSION_INGEST',
    preparePersonalContextInteractionIngest: 'PERSONAL_CONTEXT_PREPARE_INTERACTION_INGEST',
    commitPersonalContextSessionIngest: 'PERSONAL_CONTEXT_COMMIT_SESSION_INGEST',
    commitPersonalContextInteractionIngest: 'PERSONAL_CONTEXT_COMMIT_INTERACTION_INGEST',
    cancelPersonalContextSessionIngest: 'PERSONAL_CONTEXT_CANCEL_SESSION_INGEST',
    cancelPersonalContextInteractionIngest: 'PERSONAL_CONTEXT_CANCEL_INTERACTION_INGEST',
    applyPersonalContextAutomaticPolicy: 'PERSONAL_CONTEXT_APPLY_AUTOMATIC_POLICY',
    readPersonalContextSessionRangePage: 'PERSONAL_CONTEXT_READ_SESSION_RANGE_PAGE',
    readPersonalContextToolContext: 'PERSONAL_CONTEXT_READ_TOOL_CONTEXT',
    personalContextQuestionEvidence: 'PERSONAL_CONTEXT_QUESTION_EVIDENCE',
    personalContextSessionExperiences: 'PERSONAL_CONTEXT_SESSION_EXPERIENCES',
    claimNextFormalAgentRun: 'FORMAL_AGENT_CLAIM_RUN', renewFormalAgentRun: 'FORMAL_AGENT_RENEW_RUN_LEASE',
    failFormalAgentRun: 'FORMAL_AGENT_FAIL_RUN', reserveFormalAgentModelRequest: 'FORMAL_AGENT_RESERVE_MODEL_REQUEST',
    summaryInputPlan: 'SUMMARY_INPUT_PLAN', createAgentRun: 'AGENT_CREATE_RUN', cancelAgentRun: 'AGENT_CANCEL_RUN',
    createAgentInteraction: 'AGENT_CREATE_INTERACTION', terminalizeAgentInteraction: 'AGENT_TERMINALIZE_INTERACTION',
    startAgentToolCall: 'AGENT_START_TOOL_CALL', finishAgentToolCall: 'AGENT_FINISH_TOOL_CALL',
    getAgentInteraction: 'AGENT_GET_INTERACTION', listAgentInteractions: 'AGENT_LIST_INTERACTIONS'
  })) host[method] = (request = {}) => call(OPERATIONS[operation], { request })
  return host
}

async function fixture (t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'question-memory-journey-'))
  const databasePath = path.join(root, 'context.sqlite3')
  const service = new StorageWorkerService()
  const gateway = new StorageGateway({ databasePath, hostFactory: () => transport(service, databasePath), maxRestarts: 0 })
  await gateway.start()
  const config = new ConfigStore(path.join(root, 'config.json'))
  config.load()
  config.updateAgentSettings({ expectedRevision: 0, agentEnabled: true, memoryEnabled: true, cloudDisclosureAccepted: true })
  const vault = new CredentialVault({ directory: path.join(root, 'vault'), safeStorage: {
    isEncryptionAvailable: () => true, encryptString: (v) => Buffer.from(v).reverse(), decryptString: (v) => Buffer.from(v).reverse().toString()
  } })
  const providerInputs = []
  const modelAccess = new ModelAccessRuntime({ gateway, vault, adapter: { async run (request) {
    const { recipe, prompt, tools } = request
    providerInputs.push({ recipe, prompt })
    if (recipe.recipeId === 'context.synthesize') {
      const input = JSON.parse(prompt)
      const output = { schemaVersion: 1, sections: input.memories.slice(0, 8).map((item) => ({ category: item.origin === 'explicit' ? 'facts' : 'candidates', title: '个人信息', text: item.displayText, memoryRefs: [item.memoryRef], episodeRefs: [] })) }
      if (options.overviewOutput) await options.overviewOutput(output, input)
      return { text: JSON.stringify(output) }
    }
    if (recipe.recipeId === 'qa.answer') {
      if (recipe.recipeVersion === '4') {
        await request.beforeRequest({ turn: 1 })
        await request.onRequestUsage(null)
        const input = JSON.parse(prompt)
        const source = input.questionEvidence?.sources[0]?.sourceRef || input.questionMerge?.parts[0]?.sourceRefs[0]
        return { text: JSON.stringify(prompt.includes('回答失败') ? { schemaVersion: 1 } : {
          schemaVersion: 2, answer: '已回答本次问题。', claims: source ? [{ text: '本次会话包含接口讨论。', sourceRefs: [source], memoryRefs: [] }] : [],
          sourceRefs: source ? [source] : [], memoryRefs: [], unresolved: source ? [] : ['证据不足。'], coverage: null
        }) }
      }
      return { text: JSON.stringify(prompt.includes('回答失败') ? { schemaVersion: 1 } : { schemaVersion: 1, answer: '已回答本次问题。', sourceRefs: [], memoryRefs: [], unresolved: [] }) }
    }
    if (recipe.recipeId === 'summary.minutes') {
      await tools[0].execute({ schemaVersion: 1, aliasKeys: ['负责项目x的客户端'] })
      return { text: JSON.stringify({ schemaVersion: 1, overview: '本次讨论接口变更。', conclusions: [], todos: [], risks: [] }) }
    }
    if (recipe.recipeId === 'context.ingest.session') {
      const payload = JSON.parse(prompt)
      const input = recipe.recipeVersion === '3' ? { ...payload.experienceRange.source, confirmedMemories: payload.experienceRange.confirmedMemories, events: payload.experienceRange.parts } : payload
      if (recipe.recipeVersion === '3') { await request.beforeRequest({ turn: 1 }); await request.onRequestUsage(null) }
      const memory = input.confirmedMemories.find((item) => item.entityKeys.includes('项目x'))
      const output = { schemaVersion: 2, questionSummary: null, experiences: [{ kind: 'topic', text: '讨论项目接口背景', confidence: 'high',
        evidence: { sessionId: input.sessionId, transcriptVersion: input.transcriptVersion, fromEventOrder: input.events[0].eventOrder, throughEventOrder: input.events.at(-1).eventOrder } }], memoryCandidates: [], associations: [] }
      if (memory && input.events[0].text === '项目X接口变更') output.associations.push({ memoryRef: memory.memoryRef, matchKeys: ['项目X'], relation: '用户负责的项目出现接口变更的相关背景', evidence: output.experiences[0].evidence })
      if (options.sessionOutput) options.sessionOutput(output, input)
      return { text: JSON.stringify(recipe.recipeVersion === '3' ? { schemaVersion: 3, stage: 'range', content: output } : output) }
    }
    assert.equal(recipe.recipeId, 'context.ingest.interaction')
    assert.equal(recipe.recipeVersion, '2')
    const input = JSON.parse(prompt)
    assert.equal(input.acceptedContent, null)
    const text = input.userText
    const pattern = text.includes('请给一个例子') && !text.includes('以后')
    const self = text.includes('我负责')
    return { text: JSON.stringify({ schemaVersion: 2, questionSummary: '提问中包含项目或技术表达要求。', experiences: [], associations: [], memoryCandidates: [{
      scopeKind: self ? 'project' : 'global', scopeKeyProposal: self ? '项目X' : null, kind: self ? 'project_fact' : 'preference',
      content: self ? '负责项目X的客户端' : '技术解释先给例子', confidence: 'high', salience: 'high',
      evidence: { interactionId: input.interactionId, signalKind: input.signalKind },
      attribution: pattern ? 'repeated_pattern' : self ? 'self_statement' : 'long_term_requirement',
      entityKeys: self ? ['项目X'] : [], userEvidence: { fromCodePoint: 0, throughCodePoint: Array.from(text).length }
    }] }) }
  } } })
  await modelAccess.initialize()
  const command = async (value) => {
    const catalog = await modelAccess.catalog()
    const result = await modelAccess.configure({ ...value, expectedRevision: catalog.snapshot.revision })
    assert.equal(result.ok, true)
  }
  await command({ type: 'addModel', profileId: 'deepseek', modelId: 'synthetic-memory', capabilities: {
    maxInputTokens: 64000, maxOutputTokens: 4096, supportsToolCalling: true, supportsStructuredOutput: true, supportsStreaming: true, usageReporting: false
  } })
  await command({ type: 'setCredential', profileId: 'deepseek', credential: 'synthetic-secret' })
  await command({ type: 'assignPurpose', purpose: 'default', target: { profileId: 'deepseek', modelId: 'synthetic-memory' } })
  const recorder = new SqliteSessionRecorder({ gateway })
  const prompts = new Map()
  const memory = new PersonalContextRuntime({ gateway, config, modelAccess, ingestRecipeVersion: options.ingestRecipeVersion || '2',
    synthesisDelayMs: options.synthesisDelayMs ?? 30000,
    getAutomaticEligibility: async ({ sessionId }) => {
      const detail = await gateway.getSessionTranscript(sessionId)
      return evaluateAutomaticEligibility({ session: detail.session, segmentCount: detail.segments.length, settings: config.get(), catalog: await modelAccess.catalog() })
    },
    loopFactory: (binding) => new AgentLoopExecutor({ adapter: modelAccess.createLoopAdapter(binding) }) })
  memory.start(recorder)
  const signalService = new AgentInteractionSignalService({ storage: gateway, personalContext: memory, promptStore: prompts })
  const runner = new FormalAgentRunRunner({ storage: gateway, personalContext: memory.executionAdapter, modelAccess, promptProvider: (runId) => prompts.get(runId),
    interactions: { terminalize: (v) => gateway.terminalizeAgentInteraction(v), startToolCall: (v) => gateway.startAgentToolCall(v), finishToolCall: (v) => gateway.finishAgentToolCall(v) } })
  const scheduler = new FormalAgentJobScheduler({ storage: gateway, runner, requestedBy: 'user', owner: 'question.user' })
  const agent = new AgentRunService({ storage: gateway, modelAccess, scheduler, promptStore: prompts, getConfig: () => config.get() })
  scheduler.start()
  let sequence = 0
  const sessionId = 'session.question'
  const settled = async () => {
    for (let tries = 0; tries < 300; tries += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      const count = service.requireStore().database.prepare("SELECT count(*) AS n FROM formal_agent_runs WHERE requested_by='automatic' AND state IN ('queued','running','retry_wait')").get().n
      if (memory.pendingReconciles.size === 0 && !memory.scheduler.draining && count === 0 && !memory.pendingSynthesis && (memory.synthesisDelayMs !== 0 || memory.synthesisTimer === null)) return
      if (memory.synthesisDelayMs === 0) await new Promise((resolve) => setTimeout(resolve, 1))
    }
    assert.fail('automatic memory work did not settle')
  }
  await recorder.openSession({ sessionId, sourceId: 'mic', refinementEnabled: false })
  await recorder.acceptCaption({ schemaVersion: 1, sessionId, sourceId: 'mic', segmentId: 'segment.question', sequence: 1, revision: 1, kind: 'final', t0: 0, t1: 10, text: '项目X接口讨论', translation: null })
  await recorder.closeSession({ sessionId, sourceId: 'mic', state: 'closed' })
  await settled()
  t.after(async () => {
    await memory.stop(); await scheduler.stop(); vault.close()
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(root, { recursive: true, force: true })
  })
  const view = () => memory.controller.manage({ ...HEADER, request_id: `view.${++sequence}`, command: { type: 'view', resource: 'personal_memories', limit: 20, cursor: null } })
  const question = async (prompt, cancel = false, deferred = false) => {
    const submitted = await agent.submit({ ...RUN_HEADER, scope: { kind: 'session', reference: sessionId }, prompt, client_idempotency_key: `question.${++sequence}` })
    assert.equal(submitted.ok, true, JSON.stringify(submitted))
    if (cancel) await agent.cancel({ ...RUN_HEADER, interaction_id: submitted.result.interaction_id })
    let detail
    for (let tries = 0; tries < 250; tries += 1) {
      detail = await agent.getInteraction({ ...RUN_HEADER, interaction_id: submitted.result.interaction_id })
      if (detail.ok && ['succeeded', 'failed', 'cancelled'].includes(detail.result.state)) break
      await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(['succeeded', 'failed', 'cancelled'].includes(detail?.result?.state), true)
    assert.equal(await signalService.recordPromptSignal({ interactionId: submitted.result.interaction_id, prompt }), true)
    assert.equal(prompts.size, 0)
    if (!deferred) assert.equal(memory.interactionPayloads.size, 0)
    return detail.result
  }
  const session = async (text) => {
    const sessionId = `session.related.${++sequence}`
    await recorder.openSession({ sessionId, sourceId: 'loopback', refinementEnabled: false })
    await recorder.acceptCaption({ schemaVersion: 1, sessionId, sourceId: 'loopback', segmentId: 'segment.related', sequence: 1, revision: 1, kind: 'final', t0: 0, t1: 10, text, translation: null })
    await recorder.closeSession({ sessionId, sourceId: 'loopback', state: 'closed' })
    await settled()
    return sessionId
  }
  return { root, databasePath, service, gateway, memory, scheduler, providerInputs, question, view, session, settled, agent, signalService, config }
}

test('SEM-F26/F27/F30/F32/J21/J22: formal question becomes a sourced candidate, confirmation is deterministic, and SQLite reopens consistently', async (t) => {
  const f = await fixture(t)
  await f.question('以后解释技术时先给一个例子')
  const page = await f.view()
  assert.equal(page.ok, true)
  assert.equal(page.result.items.length, 1)
  const item = page.result.items[0]
  assert.equal(item.origin, 'inferred')
  assert.equal(item.source_reference_count, 1)
  const calls = f.providerInputs.length
  const confirmed = await f.memory.controller.manage({ ...HEADER, request_id: 'confirm.1', command: { type: 'update', expected_revision: page.revision, item_id: item.memory_id, item_revision: item.revision,
    entry: { display_text: item.display_text, kind: item.kind, scope: { kind: 'global', reference: null } } } })
  assert.equal(confirmed.ok, true)
  assert.equal(confirmed.result.item.origin, 'explicit')
  assert.equal(f.providerInputs.length, calls)
  assert.equal(f.service.requireStore().database.prepare('SELECT summary_json FROM personal_context_episodes WHERE source_kind=\'interaction\'').get().summary_json.includes('以后解释技术时先给一个例子'), false)
  await f.memory.stop(); await f.scheduler.stop(); await f.gateway.shutdown()
  const reopened = new SqliteSubtitleStore({ databasePath: f.databasePath, migrations: FORMAL_AGENT_MIGRATIONS })
  try { assert.equal(reopened.database.prepare('SELECT origin FROM personal_context_items WHERE memory_id=?').get(item.memory_id).origin, 'explicit') } finally { reopened.close() }
})

test('SEM-F26/F32/J21/J22: wrong provider attribution cannot turn knowledge, temporary, third-party or hypothetical text into personal memory', async (t) => {
  const f = await fixture(t)
  for (const prompt of ['缓存是什么', '这次只列三点', '同事说他喜欢简短回答', '假如我负责项目X', '“我负责项目X”']) await f.question(prompt)
  const page = await f.view()
  assert.equal(page.result.items.length, 0)
})

test('SEM-F26/F32/J21: failed answers preserve eligible user statements without retaining the original prompt', async (t) => {
  const f = await fixture(t)
  const detail = await f.question('我负责项目X的客户端，回答失败也不改变这条本人陈述')
  assert.equal(detail.state, 'failed')
  assert.equal((await f.view()).result.items[0].origin, 'inferred')
})

test('SEM-F26/F27/J21: repeated style needs two independent questions and identical question digests do not count twice', async (t) => {
  const f = await fixture(t)
  await f.question('请给一个例子解释缓存')
  assert.equal((await f.view()).result.items.length, 0)
  await f.question('请给一个例子解释缓存')
  assert.equal((await f.view()).result.items.length, 0)
  await f.question('请给一个例子解释事件循环')
  const item = (await f.view()).result.items[0]
  assert.equal(item.origin, 'inferred')
  assert.equal(item.source_reference_count, 2)
})

test('SEM-F26/F30/F32/J21/J28: confirmed question information associates a later session and correction immediately revokes both-sided input', async (t) => {
  const f = await fixture(t, { ingestRecipeVersion: '3' })
  await f.question('我负责项目X的客户端')
  const page = await f.view(); const candidate = page.result.items[0]
  assert.equal(f.service.requirePersonalContextStore().confirmedIngestMemories('session.question').length, 0)
  await f.memory.controller.manage({ ...HEADER, request_id: 'confirm.related', command: { type: 'update', expected_revision: page.revision, item_id: candidate.memory_id, item_revision: candidate.revision,
    entry: { display_text: candidate.display_text, kind: candidate.kind, scope: { kind: candidate.scope.kind, reference: candidate.scope.reference } } } })
  const sessionId = await f.session('项目X接口变更')
  const store = f.service.requirePersonalContextStore()
  assert.equal(store.sessionAssociations(sessionId).length, 1)
  const association = store.sessionAssociations(sessionId)[0]
  assert.equal(association.memoryRef.memoryId, candidate.memory_id)
  assert.equal(association.sourceRef.sessionId, sessionId)
  assert.equal(association.inputDigest.length, 64)
  const project = await f.gateway.personalContextQuestionEvidence({ action: 'freeze', scope: { kind: 'project', reference: candidate.scope.reference } })
  assert.equal(project.scopeSessionCount, 1)
  const directory = f.service.requireStore().database.prepare('SELECT session_id FROM formal_agent_question_scope_sources WHERE input_digest=?').all(project.inputDigest)
  assert.deepEqual(directory.map(row => row.session_id), [sessionId])
  assert.equal(store.sessionAssociations(await f.session('项目Y接口变更')).length, 0)
  const current = await f.view(); const item = current.result.items[0]
  await f.memory.controller.manage({ ...HEADER, request_id: 'correct.related', command: { type: 'update', expected_revision: current.revision, item_id: item.memory_id, item_revision: item.revision,
    entry: { display_text: '负责项目Y的客户端', kind: 'experience', scope: { kind: 'global', reference: null } } } })
  assert.equal(store.sessionAssociations(sessionId).length, 0)
  await assert.rejects(f.gateway.personalContextQuestionEvidence({ action: 'freeze', scope: { kind: 'project', reference: candidate.scope.reference } }))
  assert.equal(store.confirmedIngestMemories(sessionId)[0].entityKeys.length, 0)
})

test('SEM-F26/SEM-T04/J21/J28: a provider reference outside frozen information rejects all association and experience writes', async (t) => {
  const f = await fixture(t, { sessionOutput: (output, input) => {
    if (input.sessionId !== 'session.question') output.associations.push({ memoryRef: { memoryId: 'memory.outside', revisionId: 'revision.outside' }, matchKeys: ['项目X'], relation: '无效关联', evidence: output.experiences[0].evidence })
  } })
  const sessionId = await f.session('项目X接口变更')
  assert.equal(f.service.requirePersonalContextStore().sessionAssociations(sessionId).length, 0)
  const run = f.service.requireStore().database.prepare("SELECT state,error_code FROM formal_agent_runs WHERE recipe_id='context.ingest.session' AND json_extract(scope_json,'$.reference')=?").get(sessionId)
  assert.equal(run.state, 'failed'); assert.equal(run.error_code, 'AGENT_OUTPUT_INVALID')
})

test('SEM-F26/F32/J21: a cancelled answer still ingests the eligible user statement and releases its prompt', async (t) => {
  const f = await fixture(t)
  const detail = await f.question('我负责项目X的客户端', true)
  assert.equal(detail.state, 'cancelled')
  assert.equal((await f.view()).result.items[0].origin, 'inferred')
})

test('SEM-F37/F30/J28: background synthesis keeps exact sources, two bounded projections and no browsing calls, then forget revokes both', async (t) => {
  const f = await fixture(t, { synthesisDelayMs: 0 })
  await f.question('以后解释技术时先给一个例子')
  await f.settled()
  const store = f.service.requirePersonalContextStore()
  assert.equal(store.overview.view().current.sections[0].category, 'candidates')
  const page = await f.view(); const item = page.result.items[0]
  await f.memory.controller.manage({ ...HEADER, request_id: 'confirm.overview', command: { type: 'update', expected_revision: page.revision, item_id: item.memory_id, item_revision: item.revision,
    entry: { display_text: item.display_text, kind: item.kind, scope: { kind: 'global', reference: null } } } })
  await f.settled()
  const overview = store.overview.view()
  assert.equal(overview.state, 'ready'); assert.equal(overview.current.sections[0].category, 'facts')
  assert.equal(overview.previous.sections.length, 0)
  const calls = f.providerInputs.length
  for (let index = 0; index < 3; index += 1) assert.equal((await f.memory.getOverview(HEADER)).ok, true)
  assert.equal(f.providerInputs.length, calls)
  const current = await f.view(); const confirmed = current.result.items[0]
  await f.memory.controller.manage({ ...HEADER, request_id: 'forget.overview', command: { type: 'forget', expected_revision: current.revision, item_id: confirmed.memory_id, item_revision: confirmed.revision } })
  assert.equal(store.overview.view().current.sections.length, 0)
  assert.equal(store.overview.view().previous.sections.length, 0)
  assert.equal(store.database.prepare('SELECT current_json,previous_json FROM personal_context_overviews WHERE scope_key=\'global\'').get().current_json.includes('技术解释先给例子'), false)
})

test('SEM-F31/F39/J22-QA-SCOPE: date and project controls submit through real renderer, preload, main and scheduler', async t => {
  const f = await fixture(t, { ingestRecipeVersion: '3' })
  await f.question('我负责项目X的客户端')
  let page = await f.view(); const candidate = page.result.items[0]
  await f.memory.controller.manage({ ...HEADER, request_id: 'confirm.scope.ui', command: { type: 'update', expected_revision: page.revision,
    item_id: candidate.memory_id, item_revision: candidate.revision,
    entry: { display_text: candidate.display_text, kind: candidate.kind, scope: { kind: 'project', reference: candidate.scope.reference } } } })
  const relatedSession = await f.session('项目X接口变更')
  const { mountAgent } = require('./helpers/formal-agent-surface')
  const { agent, click, input, wait } = await mountAgent(t, { service: f.agent, config: f.config })
  const button = text => [...agent.querySelectorAll('button')].find(item => item.textContent === text)
  const today = new Date(); const date = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  await input(agent.querySelector('#agentDateFrom'), date); await input(agent.querySelector('#agentDateThrough'), date)
  await click(button('选择日期范围'))
  await wait(() => !agent.querySelector('#agentPrompt').disabled)
  assert.equal(button('会话总结'), undefined)
  await input(agent.querySelector('#agentPrompt'), '全部会话总体讨论什么？')
  await click(button('提交问题'))
  await wait(() => agent.querySelector('.result-card')?.textContent.includes('已回答本次问题。'))
  const db = f.service.requireStore().database
  const dateRun = db.prepare("SELECT run_id,input_digest FROM formal_agent_runs WHERE json_extract(scope_json,'$.kind')='date_range' AND state='succeeded'").get()
  assert.ok(dateRun)
  assert.ok(db.prepare('SELECT source_count FROM formal_agent_question_scopes WHERE input_digest=?').get(dateRun.input_digest).source_count >= 2)
  await click(button('显示项目'))
  let projectCard = [...agent.querySelectorAll('.scope-card')].find(item => item.textContent.includes(candidate.scope.reference))
  assert.ok(projectCard)
  await click(projectCard); await wait(() => !agent.querySelector('#agentPrompt').disabled)
  await input(agent.querySelector('#agentPrompt'), '项目X接口有什么变化？'); await click(button('提交问题'))
  await wait(() => db.prepare("SELECT 1 FROM formal_agent_runs WHERE json_extract(scope_json,'$.kind')='project' AND state='succeeded'").get())
  const run = db.prepare("SELECT input_digest FROM formal_agent_runs WHERE json_extract(scope_json,'$.kind')='project' AND state='succeeded'").get()
  assert.deepEqual(db.prepare('SELECT session_id FROM formal_agent_question_scope_sources WHERE input_digest=?').all(run.input_digest).map(row => row.session_id), [relatedSession])
  const refresh = [...agent.querySelectorAll('.scope-panel button')].find(item => item.textContent === '刷新')
  await wait(() => refresh && !refresh.disabled)
  const refreshedScopes = await f.agent.getScopes({ ...RUN_HEADER, limit: 20, cursor: null })
  assert.equal(refreshedScopes.ok, true, JSON.stringify(refreshedScopes))
  await click(refresh)
  await wait(() => button('显示项目'))
  assert.equal(button('显示项目').disabled, false)
  await click(button('显示项目'))
  assert.ok([...agent.querySelectorAll('.scope-card')].some(item => item.textContent.includes(candidate.scope.reference)))
})

test('SEM-F37/F30/J28: ongoing items use explicit dates, retain unknown deadlines and omit expired items without deleting facts', async t => {
  const f = await fixture(t, { synthesisDelayMs: 0 })
  const texts = ['2099-12-31提交项目材料', '2000-01-01核对历史事项', '准备接口变更材料', '2026-02-30核对待确认日期']
  for (const [index, display_text] of texts.entries()) {
    const page = await f.view()
    const result = await f.memory.controller.manage({ ...HEADER, request_id: `remember.todo.${index}`, command: { type: 'remember', expected_revision: page.revision,
      entry: { display_text, kind: 'todo', scope: { kind: 'global', reference: null } } } })
    assert.equal(result.ok, true); await f.settled()
  }
  const store = f.service.requirePersonalContextStore(); const calls = f.providerInputs.length
  const ongoing = store.overview.view().current.sections.filter(section => section.title === '进行中的事项')
  assert.equal(ongoing.length, 3)
  assert.ok(ongoing.some(section => section.text === texts[0]))
  assert.ok(ongoing.some(section => section.text.includes('截止时间未确认')))
  assert.ok(ongoing.every(section => section.memoryRefs.length === 1 && section.episodeRefs.length === 0))
  assert.equal(ongoing.filter(section => section.text.includes('截止时间未确认')).length, 2)
  assert.equal((await f.view()).result.items.filter(item => item.kind === 'todo').length, 4)
  assert.equal(f.providerInputs.length, calls)
})

test('SEM-F37/SEM-T04/J28: invalid synthesis retains only valid previous sections and cannot promote a candidate with an outside reference', async (t) => {
  let invalid = false
  const f = await fixture(t, { synthesisDelayMs: 0, overviewOutput: (output) => {
    if (invalid && output.sections[0]) output.sections[0].memoryRefs[0] = { memoryId: 'memory.outside', revisionId: 'revision.outside' }
  } })
  await f.question('以后解释技术时先给一个例子'); await f.settled()
  const store = f.service.requirePersonalContextStore()
  const good = store.overview.view().current.sections[0]
  invalid = true
  const page = await f.view()
  const remembered = await f.memory.controller.manage({ ...HEADER, request_id: 'remember.failure', command: { type: 'remember', expected_revision: page.revision,
    entry: { display_text: '偏好先看结论', kind: 'preference', scope: { kind: 'global', reference: null } } } })
  assert.equal(remembered.ok, true); await f.settled()
  assert.equal(store.overview.view().state, 'failed')
  assert.deepEqual(store.overview.view().current.sections[0], good)
  assert.equal(store.overview.prepare().preparedCount, 0)
})

test('SEM-F26/F30/F38/J28/J29: summary expands only actual memory inputs and this session association, then suspension and forget hide details', async (t) => {
  const f = await fixture(t)
  await f.question('我负责项目X的客户端')
  const page = await f.view(); const candidate = page.result.items[0]
  const confirmed = await f.memory.manage({ ...HEADER, request_id: 'confirm.summary', command: { type: 'update', expected_revision: page.revision, item_id: candidate.memory_id, item_revision: candidate.revision,
    entry: { display_text: candidate.display_text, kind: candidate.kind, scope: { kind: candidate.scope.kind, reference: candidate.scope.reference } } } })
  assert.equal(confirmed.ok, true)
  const sessionId = await f.session('项目X接口变更')
  await f.session('项目X接口变更') // Its background must not appear in the first summary.
  const before = f.service.requireStore().database.prepare("SELECT count(*) AS n FROM formal_agent_runs WHERE recipe_id='context.ingest.interaction'").get().n
  const submitted = await f.agent.submit({ ...RUN_HEADER, scope: { kind: 'session', reference: sessionId }, prompt: '请生成会话总结', client_idempotency_key: 'summary.actual' })
  assert.equal(submitted.ok, true)
  const request = { ...RUN_HEADER, interaction_id: submitted.result.interaction_id }
  let detail
  for (let tries = 0; tries < 300; tries += 1) {
    detail = await f.agent.getInteraction(request)
    if (detail.result?.state === 'succeeded') break
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(detail.result?.state, 'succeeded')
  assert.deepEqual(Object.keys(detail.result.result).sort(), ['conclusions', 'overview', 'risks', 'schemaVersion', 'todos'])
  assert.equal(detail.result.memory_inputs.length, 1)
  assert.equal(detail.result.memory_inputs[0].availability, 'accessible')
  assert.equal(detail.result.memory_inputs[0].associations.length, 1)
  assert.equal(detail.result.memory_inputs[0].associations[0].target.reference, sessionId)
  assert.equal(detail.result.memory_inputs[0].sources.some((source) => source.summary_kind === 'question_summary' && source.target.kind === 'interaction'), true)
  assert.equal(await f.signalService.recordPromptSignal({ interactionId: request.interaction_id, prompt: '请生成会话总结' }), false)
  assert.equal(f.service.requireStore().database.prepare("SELECT count(*) AS n FROM formal_agent_runs WHERE recipe_id='context.ingest.interaction'").get().n, before)
  f.config.updateAgentSettings({ expectedRevision: f.config.get().agentSettingsRevision, agentEnabled: true, memoryEnabled: false, cloudDisclosureAccepted: true })
  assert.equal((await f.agent.getInteraction(request)).result.memory_inputs_error, 'suspended')
  assert.deepEqual((await f.agent.getInteraction(request)).result.memory_inputs, [])
  f.config.updateAgentSettings({ expectedRevision: f.config.get().agentSettingsRevision, agentEnabled: true, memoryEnabled: true, cloudDisclosureAccepted: true })
  const current = await f.view(); const item = current.result.items[0]
  await f.memory.manage({ ...HEADER, request_id: 'forget.summary', command: { type: 'forget', expected_revision: current.revision, item_id: item.memory_id, item_revision: item.revision } })
  const removed = (await f.agent.getInteraction(request)).result.memory_inputs[0]
  assert.equal(removed.availability, 'removed')
  assert.equal(removed.display_text, null)
  assert.deepEqual(removed.sources, [])
  assert.deepEqual(removed.associations, [])
})

test('SEM-F26/F30/SEM-T04/J21/J28: a provider cannot associate an absent key or a similar longer project name', async (t) => {
  const f = await fixture(t, { sessionOutput: (output, input) => {
    const memory = input.confirmedMemories[0]
    if (memory && input.events[0].text !== '项目X接口变更') output.associations.push({ memoryRef: memory.memoryRef, matchKeys: ['项目X'], relation: '错误的实体关联', evidence: output.experiences[0].evidence })
  } })
  await f.question('我负责项目X的客户端')
  const page = await f.view(); const item = page.result.items[0]
  await f.memory.manage({ ...HEADER, request_id: 'confirm.keys', command: { type: 'update', expected_revision: page.revision, item_id: item.memory_id, item_revision: item.revision,
    entry: { display_text: item.display_text, kind: item.kind, scope: { kind: item.scope.kind, reference: item.scope.reference } } } })
  for (const text of ['同事讨论项目Y接口', '项目XYZ接口变更']) {
    const sessionId = await f.session(text)
    assert.equal(f.service.requirePersonalContextStore().sessionAssociations(sessionId).length, 0)
    assert.equal(f.service.requireStore().database.prepare("SELECT error_code FROM formal_agent_runs WHERE recipe_id='context.ingest.session' AND json_extract(scope_json,'$.reference')=?").get(sessionId).error_code, 'AGENT_OUTPUT_INVALID')
  }
})

test('SEM-F26/F30/F37/J21/J28: settings renderer, real preload and IPC confirm a sourced candidate and persist its correction without a model call', async (t) => {
  const f = await fixture(t)
  await f.question('我负责项目X的客户端')
  const React = require('react')
  const { act } = React
  const { JSDOM } = require('jsdom')
  const vm = require('node:vm')
  const { loadRendererModule } = require('../ui/load-renderer-module')
  const { registerPersonalContextIpc, broadcastPersonalContextChanged } = require('../../src/main/ipc/personal-context-ipc')
  const { registerContextSourceIpc } = require('../../src/main/ipc/context-source-ipc')
  const { isRoleAllowed } = require('../../src/main/ipc/access-policy')
  const CHANNELS = require('../../src/main/ipc/channels')
  const handlers = new Map(); const listeners = new Map(); const opened = []
  const sender = { id: 1 }
  const ipcRenderer = {
    invoke: (channel, request) => handlers.get(channel)({ sender }, request),
    on: (channel, callback) => { const set = listeners.get(channel) || new Set(); set.add(callback); listeners.set(channel, set) },
    removeListener: (channel, callback) => listeners.get(channel)?.delete(callback), send: () => {}
  }
  const ipcMain = { handle: (channel, handler) => handlers.set(channel, handler) }
  const authorize = (_event, channel) => { if (!isRoleAllowed(channel, 'settings')) throw new Error('permission denied') }
  registerPersonalContextIpc({ ipcMain, authorize, getRuntime: () => f.memory })
  registerContextSourceIpc({ ipcMain, authorize, getStorage: () => f.gateway, openSource: (location) => { opened.push(location); return true }, returnSource: () => true })
  f.memory.onChanged = (event) => broadcastPersonalContextChanged({ settings: { isDestroyed: () => false, webContents: { send: (channel, value) => {
    for (const callback of listeners.get(channel) || []) callback({}, value)
  } } } }, event)
  // Only Electron's OS transport/contextBridge is controlled. Both preload
  // modules and the renderer/main/controller/storage chain are production code.
  let shell
  const electron = { ipcRenderer, contextBridge: { exposeInMainWorld: (_name, api) => { shell = api } } }
  const moduleCache = new Map()
  const preloadModule = (file) => {
    if (moduleCache.has(file)) return moduleCache.get(file).exports
    const module = { exports: {} }; moduleCache.set(file, module)
    const localRequire = (specifier) => {
      if (specifier === 'electron') return electron
      const target = path.resolve(path.dirname(file), specifier) + '.js'
      if (specifier === './shared') return preloadModule(target)
      return require(target)
    }
    vm.runInThisContext(`(function(require,module,exports) {${fs.readFileSync(file, 'utf8')}\n})`)(localRequire, module, module.exports)
    return module.exports
  }
  preloadModule(path.resolve('src/preload/settings.js'))
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://memory.test/' })
  const previous = Object.fromEntries(['window', 'document', 'HTMLElement', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT'].map((key) => [key, global[key]]))
  Object.assign(global, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = require('react-dom/client')
  const { AgentContextPane } = await loadRendererModule(path.resolve('src/settings/agent-context-pane.tsx'))
  const root = createRoot(document.getElementById('root'))
  const flush = () => act(async () => { for (let index = 0; index < 15; index += 1) await new Promise((resolve) => setImmediate(resolve)) })
  const click = (element) => { assert.ok(element); element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) }
  t.after(async () => {
    await act(async () => root.unmount()); dom.window.close()
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete global[key] : (global[key] = value)
  })
  await act(async () => root.render(React.createElement(AgentContextPane, { shell }))); await flush()
  assert.match(document.body.textContent, /待确认记忆/)
  const calls = f.providerInputs.length
  await act(async () => click([...document.querySelectorAll('[data-memory-id] button')].find((button) => button.textContent === '确认记忆'))); await flush()
  const item = (await f.view()).result.items[0]
  assert.equal(item.origin, 'explicit')
  assert.equal(item.kind, 'project_fact')
  await act(async () => click([...document.querySelectorAll('[data-memory-id] button')].find((button) => button.textContent === '展开详情'))); await flush()
  await act(async () => click([...document.querySelectorAll('[data-memory-id] button')].find((button) => button.textContent === '查看记录'))); await flush()
  assert.equal(opened[0].target.kind, 'interaction')
  assert.equal(opened[0].scope.reference, 'session.question')
  await act(async () => click([...document.querySelectorAll('[data-memory-id] button')].find((button) => button.textContent === '修改'))); await flush()
  await act(async () => {
    const field = document.querySelector('textarea[aria-label="修改个人记忆"]')
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set.call(field, '负责项目X的桌面客户端')
    field.dispatchEvent(new window.Event('input', { bubbles: true }))
    for (const [label, value] of [['修改记忆类型', 'experience'], ['修改记忆范围', 'global:']]) {
      const select = document.querySelector(`select[aria-label="${label}"]`)
      assert.ok(select)
      select.value = value; select.dispatchEvent(new window.Event('change', { bubbles: true }))
    }
  })
  await act(async () => click([...document.querySelectorAll('[data-memory-id] button')].find((button) => button.textContent === '保存修改'))); await flush()
  assert.equal((await f.view()).result.items[0].display_text, '负责项目X的桌面客户端')
  assert.equal((await f.view()).result.items[0].kind, 'experience')
  assert.equal((await f.view()).result.items[0].scope.kind, 'global')
  assert.equal(f.providerInputs.length, calls)
  assert.equal(document.querySelectorAll('[role="radio"][aria-checked="true"]').length, 1)
  assert.equal(isRoleAllowed(CHANNELS.AGENT_CONTEXT_OPEN_SOURCE, 'caption'), false)
})

test('SEM-F37/SEM-T04/J28: an old provider response cannot restore a corrected memory and the same scheduler rebuilds from the new revision', { timeout: 10000 }, async (t) => {
  let hold = false; let started; let release
  const startedPromise = new Promise((resolve) => { started = resolve })
  const responsePromise = new Promise((resolve) => { release = resolve })
  t.after(() => { hold = false; release() })
  const f = await fixture(t, { synthesisDelayMs: 0, overviewOutput: async () => {
    if (hold) { started(); await responsePromise }
  } })
  hold = true
  const question = f.question('以后解释技术时先给一个例子', false, true)
  await startedPromise
  const page = await f.view(); const item = page.result.items[0]
  const before = await f.view()
  await f.memory.manage({ ...HEADER, request_id: 'correct.late', command: { type: 'update', expected_revision: before.revision, item_id: item.memory_id, item_revision: item.revision,
    entry: { display_text: '解释时先列假设', kind: 'preference', scope: { kind: 'global', reference: null } } } })
  hold = false; release(); await question; await f.settled()
  const store = f.service.requirePersonalContextStore()
  assert.equal(store.overview.view().state, 'ready')
  assert.equal(store.database.prepare("SELECT count(*) AS n FROM formal_agent_runs WHERE recipe_id='context.synthesize' AND error_code='AGENT_REQUEST_INVALID'").get().n, 1)
  const row = store.database.prepare("SELECT current_json,previous_json FROM personal_context_overviews WHERE scope_key='global'").get()
  assert.equal(`${row.current_json}${row.previous_json}`.includes('技术解释先给例子'), false)
  assert.equal(row.current_json.includes('解释时先列假设'), true)
})

test('SEM-F26/F37/J21/J28: candidate batch consumes only frozen revisions while a second question writes a new candidate', { timeout: 10000 }, async t => {
  let hold = false; let started; let release
  const startedPromise = new Promise(resolve => { started = resolve })
  const responsePromise = new Promise(resolve => { release = resolve })
  t.after(() => { hold = false; release() })
  const inputs = []
  const f = await fixture(t, { synthesisDelayMs: 0, overviewOutput: async (_output, input) => {
    inputs.push(input)
    if (hold) { started(); await responsePromise }
  } })
  hold = true
  const firstQuestion = f.question('以后解释技术时先给一个例子', false, true)
  await startedPromise
  const frozen = inputs[0]
  assert.ok(frozen.batchId)
  const secondQuestion = f.question('我负责项目X的客户端', false, true)
  let job
  for (let index = 0; index < 30 && !job; index += 1) {
    await new Promise(resolve => setImmediate(resolve))
    job = await f.gateway.claimNextFormalAgentRun({ owner: 'candidate.concurrent', leaseMs: 60000,
      requestedBy: 'automatic', claimIdempotencyKey: `candidate.concurrent.${index}` })
  }
  assert.equal(job?.recipeId, 'context.ingest.interaction')
  await f.memory.runner.run(job)
  const page = await f.view()
  const newer = page.result.items.find(item => item.kind === 'project_fact')
  assert.ok(newer)
  const db = f.service.requireStore().database
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM personal_context_candidate_consumptions WHERE memory_id=?').get(newer.memory_id).n, 0)
  hold = false; release(); await Promise.all([firstQuestion, secondQuestion]); await f.settled()
  const first = db.prepare('SELECT * FROM personal_context_candidate_batches WHERE batch_id=?').get(frozen.batchId)
  assert.ok(first.consumed_at !== null)
  assert.equal(JSON.parse(first.refs_json).some(ref => ref.memoryId === newer.memory_id), false)
  assert.ok(inputs.slice(1).some(input => input.memories.some(item => item.memoryRef.memoryId === newer.memory_id)))
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM formal_agent_runs WHERE recipe_id='context.synthesize' AND state='failed'").get().n, 0)
})
