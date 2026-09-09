'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { AgentRunService } = require('../../src/agent/formal-run/agent-run-service')
const { AgentInteractionExporter } = require('../../src/agent/formal-run/agent-interaction-exporter')
const { FormalAgentJobScheduler, FormalAgentRunRunner } = require('../../src/agent/execution-host')
const { CredentialVault } = require('../../src/agent/model-access/credential-vault')
const { ModelAccessRuntime } = require('../../src/agent/model-access/runtime')
const { HistoryService } = require('../../src/main/services/history-service')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')
const { OPERATIONS, PROTOCOL_VERSION, StorageError, makeCaptionEventId, makeCloseSessionKey, makeOpenSessionKey } = require('../../src/runtime/storage-worker/protocol')

const capabilities = Object.freeze({
  maxInputTokens: 64000,
  maxOutputTokens: 4096,
  supportsToolCalling: true,
  supportsStructuredOutput: true,
  supportsStreaming: true,
  usageReporting: false
})

function hostFactory (service, databasePath) {
  let sequence = 0
  const call = (operation, payload, idempotencyKey) => {
    const response = service.handle({
      version: PROTOCOL_VERSION, type: 'storage:request',
      requestId: `s5-target.${++sequence}`, operation, payload,
      ...(idempotencyKey ? { idempotencyKey } : {})
    })
    if (!response.ok) throw new StorageError(response.error.code)
    return response.result
  }
  return {
    state: 'stopped',
    async start () { call(OPERATIONS.INITIALIZE, { databasePath }); this.state = 'ready' },
    async openSession (value) { return call(OPERATIONS.OPEN_SESSION, value, makeOpenSessionKey(value.sessionId)) },
    async appendCaption (event) { return call(OPERATIONS.APPEND_CAPTION, { event }, makeCaptionEventId(event)) },
    async closeSession (value) { return call(OPERATIONS.CLOSE_SESSION, value, makeCloseSessionKey(value.sessionId)) },
    async listSessions (value) { return call(OPERATIONS.LIST_SESSIONS, value) },
    async getSessionPage (value) { return call(OPERATIONS.GET_SESSION_PAGE, value) },
    async getSessionTranscript (value) { return call(OPERATIONS.GET_SESSION, { sessionId: value }) },
    async personalContextResolve (request) { return call(OPERATIONS.PERSONAL_CONTEXT_RESOLVE, { request }) },
    async derivePersonalContextSessionSource (request) { return call(OPERATIONS.PERSONAL_CONTEXT_DERIVE_SESSION_SOURCE, { request }) },
    async readPersonalContextSessionInput (source) { return call(OPERATIONS.PERSONAL_CONTEXT_READ_SESSION_INPUT, { source }) },
    async readPersonalContextToolContext (request) { return call(OPERATIONS.PERSONAL_CONTEXT_READ_TOOL_CONTEXT, { request }) },
    async claimNextFormalAgentRun (request) { return call(OPERATIONS.FORMAL_AGENT_CLAIM_RUN, { request }) },
    async nextFormalAgentRunAt (request = {}) { return call(OPERATIONS.FORMAL_AGENT_NEXT_RUN_AT, request) },
    async failFormalAgentRun (request) { return call(OPERATIONS.FORMAL_AGENT_FAIL_RUN, { request }) },
    async createAgentRun (request) { return call(OPERATIONS.AGENT_CREATE_RUN, { request }) },
    async cancelAgentRun (request) { return call(OPERATIONS.AGENT_CANCEL_RUN, { request }) },
    async createAgentInteraction (request) { return call(OPERATIONS.AGENT_CREATE_INTERACTION, { request }) },
    async terminalizeAgentInteraction (request) { return call(OPERATIONS.AGENT_TERMINALIZE_INTERACTION, { request }) },
    async startAgentToolCall (request) { return call(OPERATIONS.AGENT_START_TOOL_CALL, { request }) },
    async finishAgentToolCall (request) { return call(OPERATIONS.AGENT_FINISH_TOOL_CALL, { request }) },
    async listAgentInteractions (request) { return call(OPERATIONS.AGENT_LIST_INTERACTIONS, { request }) },
    async getAgentInteraction (request) { return call(OPERATIONS.AGENT_GET_INTERACTION, { request }) },
    async modelAccessCatalog () { return call(OPERATIONS.MODEL_ACCESS_CATALOG, {}) },
    async modelAccessConfigure (input) { return call(OPERATIONS.MODEL_ACCESS_CONFIGURE, { input }) },
    async modelAccessBind (request, availableSlotIds) { return call(OPERATIONS.MODEL_ACCESS_BIND, { request, availableSlotIds }) },
    async shutdown () { if (!service.shuttingDown) call(OPERATIONS.SHUTDOWN, {}); this.state = 'closed' },
    async terminateAndWait () { await this.shutdown(); return 0 }
  }
}

function createVault (directory) {
  return new CredentialVault({
    directory,
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value).reverse(),
      decryptString: (value) => Buffer.from(value).reverse().toString()
    }
  })
}

async function configureModel (modelAccess) {
  const command = async (value) => {
    const catalog = await modelAccess.catalog()
    const response = await modelAccess.configure({ ...value, expectedRevision: catalog.snapshot.revision })
    assert.equal(response.ok, true)
  }
  await command({ type: 'addModel', profileId: 'deepseek', modelId: 'deepseek-v4-flash', capabilities })
  await command({ type: 'setCredential', profileId: 'deepseek', credential: 'synthetic-secret' })
  await command({ type: 'assignPurpose', purpose: 'default', target: { profileId: 'deepseek', modelId: 'deepseek-v4-flash' } })
  await command({ type: 'assignPurpose', purpose: 'summary', target: { profileId: 'deepseek', modelId: 'deepseek-v4-flash' } })
}

function tick () { return new Promise((resolve) => setImmediate(resolve)) }

test('SEM-F15/SEM-F16/SEM-F28/SEM-F33/SEM-F34: S5 local evidence reaches one user scheduler claim, model loop, SQLite result, history and detail', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's5-target-journey-'))
  const databasePath = path.join(root, 'speech-agent.sqlite3')
  const service = new StorageWorkerService()
  const gateway = new StorageGateway({ databasePath, hostFactory: () => hostFactory(service, databasePath), maxRestarts: 0 })
  await gateway.start()
  const vault = createVault(path.join(root, 'vault'))
  let lateProviderStarted = false
  let releaseLateProvider = null
  const modelAccess = new ModelAccessRuntime({
    gateway,
    vault,
    adapter: {
      async run ({ recipe, tools, prompt }) {
        const context = await tools[0].execute({ schemaVersion: 1, aliasKeys: ['missing'] })
        assert.deepEqual(context.unmatchedAliasKeys, ['missing'])
        if (typeof prompt === 'string' && prompt.includes('迟到取消')) {
          lateProviderStarted = true
          await new Promise((resolve) => { releaseLateProvider = resolve })
        }
        if (typeof prompt === 'string' && prompt.includes('失败字幕独立')) {
          return { text: JSON.stringify({ schemaVersion: 1 }) }
        }
        if (recipe.recipeId === 'summary.minutes') {
          return { text: JSON.stringify({
            schemaVersion: 1,
            overview: '这是一次受控的会后结构化纪要。',
            conclusions: [{
              text: '形成一个受控结论。',
              sourceRefs: [{ sessionId: 'session.s5.target', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 1 }]
            }],
            todos: [{
              text: '跟进一个受控事项。', ownerHint: null, dueHint: null,
              sourceRefs: [{ sessionId: 'session.s5.target', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 1 }]
            }],
            risks: []
          }) }
        }
        assert.equal(recipe.recipeId, 'qa.answer')
        return { text: JSON.stringify({
          schemaVersion: 1,
          answer: '这是一次受控的会话回答。',
          sourceRefs: [{ sessionId: 'session.s5.target', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 1 }],
          memoryRefs: [], unresolved: []
        }) }
      }
    }
  })
  await modelAccess.initialize()
  await configureModel(modelAccess)
  const recorder = new SqliteSessionRecorder({ gateway, now: () => 1000 })
  const executionAdapter = {
    resolve: (request) => gateway.personalContextResolve(request),
    readSessionInput: (source) => gateway.readPersonalContextSessionInput(source),
    readToolContext: (request) => gateway.readPersonalContextToolContext(request)
  }
  const prompts = new Map()
  const runner = new FormalAgentRunRunner({
    storage: gateway,
    personalContext: executionAdapter,
    modelAccess,
    promptProvider: (runId) => prompts.get(runId) || null,
    onSettled: (runId) => prompts.delete(runId),
    interactions: {
      terminalize: (request) => gateway.terminalizeAgentInteraction(request),
      startToolCall: (request) => gateway.startAgentToolCall(request),
      finishToolCall: (request) => gateway.finishAgentToolCall(request)
    }
  })
  const scheduler = new FormalAgentJobScheduler({ storage: gateway, runner, requestedBy: 'user', owner: 'scheduler.user.s5' })
  const agent = new AgentRunService({
    storage: gateway,
    modelAccess,
    scheduler,
    promptStore: prompts,
    exporter: new AgentInteractionExporter({
      storage: gateway,
      showSaveDialog: async () => ({ canceled: false, filePath: path.join(root, 'agent-interaction.json') })
    })
  })
  scheduler.start()
  const subtitleExportPaths = [
    path.join(root, 'subtitle-cancelled.txt'),
    path.join(root, 'subtitle-failed.txt')
  ]
  const historyService = new HistoryService({
    gateway,
    showSaveDialog: async () => ({ canceled: false, filePath: subtitleExportPaths.shift() })
  })
  async function recordSubtitleWhileAgentSettles (sessionId, text) {
    const exportPath = subtitleExportPaths[0]
    await recorder.openSession({ sessionId, sourceId: 'mic', refinementEnabled: false })
    await recorder.acceptCaption({
      schemaVersion: 1, sessionId, sourceId: 'mic', segmentId: `${sessionId}.segment`,
      sequence: 1, revision: 1, kind: 'final', t0: 0, t1: 10, text, translation: null
    })
    await recorder.closeSession({ sessionId, sourceId: 'mic', state: 'closed' })
    const page = await historyService.getSessionPage({ sessionId, limit: 10, cursor: null })
    assert.equal(page.items.length, 1)
    const exported = await historyService.exportSession({ sessionId, format: 'txt' })
    assert.equal(exported.status, 'saved')
    assert.equal(fs.readFileSync(exportPath).length > 0, true)
  }
  t.after(async () => {
    await scheduler.stop()
    vault.close()
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(root, { recursive: true, force: true })
  })

  await recorder.openSession({ sessionId: 'session.s5.target', sourceId: 'mic', refinementEnabled: false })
  await recorder.acceptCaption({
    schemaVersion: 1, sessionId: 'session.s5.target', sourceId: 'mic', segmentId: 'segment.s5.1',
    sequence: 1, revision: 1, kind: 'final', t0: 0, t1: 10, text: '受控会话输入', translation: null
  })
  await recorder.closeSession({ sessionId: 'session.s5.target', sourceId: 'mic', state: 'closed' })
  const submitted = await agent.submit({
    contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0',
    scope: { kind: 'session', reference: 'session.s5.target' },
    prompt: '请回答这场会的重点', client_idempotency_key: 'client.s5.target'
  })
  assert.equal(submitted.ok, true)
  assert.equal(submitted.result.state, 'pending')
  for (let i = 0; i < 80; i++) {
    const detail = await agent.getInteraction({ contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0', interaction_id: submitted.result.interaction_id })
    if (detail.ok && detail.result.state === 'succeeded') break
    await tick()
  }
  const detail = await agent.getInteraction({ contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0', interaction_id: submitted.result.interaction_id })
  assert.equal(detail.ok, true)
  assert.equal(detail.result.state, 'succeeded')
  assert.equal(detail.result.usage_state, 'unknown')
  assert.equal(detail.result.tool_calls.length, 1)
  assert.equal(detail.result.tool_calls[0].status, 'succeeded')
  assert.deepEqual(Object.keys(detail.result.tool_calls[0]).sort(), [
    'args', 'args_digest', 'attempt', 'call_id', 'call_order', 'counts', 'ended_offset_ms',
    'error_code', 'result', 'result_digest', 'schema_version', 'source_refs', 'started_offset_ms',
    'status', 'tool_name'
  ])
  assert.equal(detail.result.tool_calls[0].args.schemaVersion, 1)
  assert.equal(detail.result.tool_calls[0].result.schemaVersion, 1)

  const minutesSubmitted = await agent.submit({
    contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0',
    scope: { kind: 'session', reference: 'session.s5.target' },
    prompt: '请生成会后结构化纪要', client_idempotency_key: 'client.s5.minutes'
  })
  assert.equal(minutesSubmitted.ok, true)
  assert.equal(minutesSubmitted.result.recipe_id, 'summary.minutes')
  for (let i = 0; i < 80; i++) {
    const minutesDetail = await agent.getInteraction({ contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0', interaction_id: minutesSubmitted.result.interaction_id })
    if (minutesDetail.ok && minutesDetail.result.state === 'succeeded') break
    await tick()
  }
  const minutesDetail = await agent.getInteraction({
    contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0', interaction_id: minutesSubmitted.result.interaction_id
  })
  assert.equal(minutesDetail.ok, true)
  assert.equal(minutesDetail.result.state, 'succeeded')
  assert.equal(minutesDetail.result.recipe_id, 'summary.minutes')
  assert.equal(minutesDetail.result.result.overview, '这是一次受控的会后结构化纪要。')
  const history = await agent.getHistory({ contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0', limit: 10, cursor: null })
  assert.equal(history.ok, true)
  assert.equal(history.result.items.length, 2)
  assert.equal(history.result.items.some((item) => item.interaction_id === submitted.result.interaction_id), true)
  assert.equal(history.result.items.some((item) => item.interaction_id === minutesSubmitted.result.interaction_id), true)
  const database = service.requireStore().database
  assert.equal(database.prepare('SELECT state FROM formal_agent_runs WHERE run_id=?').get(submitted.result.run_id).state, 'succeeded')
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM formal_agent_interactions WHERE run_id=? AND terminal_reason=\'succeeded\'').get(submitted.result.run_id).count, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM formal_agent_interactions WHERE run_id=? AND terminal_reason=\'succeeded\'').get(minutesSubmitted.result.run_id).count, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM formal_agent_tool_calls WHERE interaction_id=? AND status=\'succeeded\'').get(submitted.result.interaction_id).count, 1)
  const exported = await agent.exportInteraction({
    contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0',
    interaction_id: submitted.result.interaction_id
  })
  const firstBytes = fs.readFileSync(path.join(root, 'agent-interaction.json'))
  assert.equal(exported.ok, true)
  assert.equal(exported.result.bytes_sha256, require('node:crypto').createHash('sha256').update(firstBytes).digest('hex'))
  assert.equal(JSON.parse(firstBytes.toString('utf8')).terminal_reason, 'succeeded')
  const replayedExport = await agent.exportInteraction({
    contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0',
    interaction_id: submitted.result.interaction_id
  })
  const secondBytes = fs.readFileSync(path.join(root, 'agent-interaction.json'))
  assert.equal(replayedExport.ok, true)
  assert.deepEqual(secondBytes, firstBytes)
  assert.equal(replayedExport.result.bytes_sha256, exported.result.bytes_sha256)

  const lateSubmitted = await agent.submit({
    contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0',
    scope: { kind: 'session', reference: 'session.s5.target' },
    prompt: '请处理迟到取消', client_idempotency_key: 'client.s5.late'
  })
  assert.equal(lateSubmitted.ok, true)
  assert.equal(lateSubmitted.result.state, 'pending')
  for (let i = 0; i < 80 && !lateProviderStarted; i++) await tick()
  assert.equal(lateProviderStarted, true)
  assert.equal(typeof releaseLateProvider, 'function')
  const cancelled = await agent.cancel({
    contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0',
    interaction_id: lateSubmitted.result.interaction_id
  })
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.result.state, 'cancelling')
  await recordSubtitleWhileAgentSettles('session.s5.cancelled.subtitle', '取消收束后字幕仍可停止并导出')
  releaseLateProvider({ text: JSON.stringify({
    schemaVersion: 1,
    answer: '迟到结果不得写入',
    sourceRefs: [{ sessionId: 'session.s5.target', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 1 }],
    memoryRefs: [], unresolved: []
  }) })
  for (let i = 0; i < 80; i++) {
    const lateDetail = await agent.getInteraction({
      contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0', interaction_id: lateSubmitted.result.interaction_id
    })
    if (lateDetail.ok && lateDetail.result.state === 'cancelled') break
    await tick()
  }
  const lateDetail = await agent.getInteraction({
    contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0', interaction_id: lateSubmitted.result.interaction_id
  })
  assert.equal(lateDetail.ok, true)
  assert.equal(lateDetail.result.state, 'cancelled')
  assert.equal(lateDetail.result.result, null)
  assert.equal(database.prepare('SELECT state FROM formal_agent_runs WHERE run_id=?').get(lateSubmitted.result.run_id).state, 'cancelled')

  const failedSubmitted = await agent.submit({
    contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0',
    scope: { kind: 'session', reference: 'session.s5.target' },
    prompt: '请验证失败字幕独立', client_idempotency_key: 'client.s5.failed.subtitle'
  })
  assert.equal(failedSubmitted.ok, true)
  for (let i = 0; i < 80; i++) {
    const failedDetail = await agent.getInteraction({
      contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0', interaction_id: failedSubmitted.result.interaction_id
    })
    if (failedDetail.ok && failedDetail.result.state === 'failed') break
    await tick()
  }
  const failedDetail = await agent.getInteraction({
    contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0', interaction_id: failedSubmitted.result.interaction_id
  })
  assert.equal(failedDetail.ok, true)
  assert.equal(failedDetail.result.state, 'failed')
  assert.equal(failedDetail.result.error_code, 'AGENT_OUTPUT_INVALID')
  await recordSubtitleWhileAgentSettles('session.s5.failed.subtitle', '失败收束后字幕仍可停止并导出')
})
