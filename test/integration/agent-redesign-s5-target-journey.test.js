'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { AgentRunService } = require('../../src/agent/formal-run/agent-run-service')
const { FormalAgentJobScheduler, FormalAgentRunRunner } = require('../../src/agent/execution-host')
const { CredentialVault } = require('../../src/agent/model-access/credential-vault')
const { ModelAccessRuntime } = require('../../src/agent/model-access/runtime')
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

test('SEM-F15/SEM-F16/SEM-F28/SEM-F33/SEM-F34/J22/J24: terminal session request reaches one user scheduler claim, model loop, SQLite result, history and detail', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's5-target-journey-'))
  const databasePath = path.join(root, 'speech-agent.sqlite3')
  const service = new StorageWorkerService()
  const gateway = new StorageGateway({ databasePath, hostFactory: () => hostFactory(service, databasePath), maxRestarts: 0 })
  await gateway.start()
  const vault = createVault(path.join(root, 'vault'))
  const modelAccess = new ModelAccessRuntime({
    gateway,
    vault,
    adapter: {
      async run ({ recipe, tools }) {
        assert.equal(recipe.recipeId, 'qa.answer')
        const context = await tools[0].execute({ schemaVersion: 1, aliasKeys: ['missing'] })
        assert.deepEqual(context.unmatchedAliasKeys, ['missing'])
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
    promptStore: prompts
  })
  scheduler.start()
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
  const history = await agent.getHistory({ contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0', limit: 10, cursor: null })
  assert.equal(history.ok, true)
  assert.equal(history.result.items.length, 1)
  assert.equal(history.result.items[0].interaction_id, submitted.result.interaction_id)
  const database = service.requireStore().database
  assert.equal(database.prepare('SELECT state FROM formal_agent_runs WHERE run_id=?').get(submitted.result.run_id).state, 'succeeded')
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM formal_agent_interactions WHERE run_id=? AND terminal_reason=\'succeeded\'').get(submitted.result.run_id).count, 1)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM formal_agent_tool_calls WHERE interaction_id=? AND status=\'succeeded\'').get(submitted.result.interaction_id).count, 1)
})
