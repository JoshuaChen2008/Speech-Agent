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

const CONTRACT = { contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0' }
const CAPABILITIES = Object.freeze({
  maxInputTokens: 64000,
  maxOutputTokens: 4096,
  supportsToolCalling: true,
  supportsStructuredOutput: true,
  supportsStreaming: true,
  usageReporting: true
})

function hostFactory (service, databasePath) {
  let sequence = 0
  const call = (operation, payload, idempotencyKey) => {
    const response = service.handle({
      version: PROTOCOL_VERSION, type: 'storage:request',
      requestId: `j25-comparison.${++sequence}`, operation, payload,
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
    async getSessionTranscript (sessionId) { return call(OPERATIONS.GET_SESSION, { sessionId }) },
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

async function configure (modelAccess, command) {
  const catalog = await modelAccess.catalog()
  const response = await modelAccess.configure({ ...command, expectedRevision: catalog.snapshot.revision })
  assert.equal(response.ok, true, JSON.stringify(response))
  return response
}

async function waitForTerminal (agent, interactionId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await agent.getInteraction({ ...CONTRACT, interaction_id: interactionId })
    if (response.ok && ['succeeded', 'failed', 'cancelled'].includes(response.result.state)) return response.result
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`interaction did not settle: ${interactionId}`)
}

test('SEM-F31/SEM-F33/J25: Agent Bar model switch creates immutable sibling bindings and comparable history', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'j25-model-comparison-'))
  const databasePath = path.join(root, 'speech-agent.sqlite3')
  const service = new StorageWorkerService()
  const gateway = new StorageGateway({ databasePath, hostFactory: () => hostFactory(service, databasePath), maxRestarts: 0 })
  await gateway.start()
  const vault = createVault(path.join(root, 'vault'))
  let providerClock = 1000
  const providerCalls = []
  const sourceRef = { sessionId: 'session.j25.compare', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 1 }
  const modelAccess = new ModelAccessRuntime({
    gateway,
    vault,
    adapter: {
      async run ({ resolvedModel }) {
        providerCalls.push({ profileId: resolvedModel.profileId, modelId: resolvedModel.modelId })
        const isFirst = resolvedModel.modelId === 'model-a'
        providerClock += isFirst ? 40 : 20
        return {
          text: JSON.stringify({
            schemaVersion: 1,
            answer: `受控模型 ${resolvedModel.modelId} 的回答`,
            sourceRefs: [sourceRef],
            memoryRefs: [],
            unresolved: []
          }),
          usage: {
            inputTokens: isFirst ? 100 : 80,
            outputTokens: isFirst ? 20 : 10,
            usageSource: 'provider',
            cacheHitInputTokens: isFirst ? 40 : null,
            cacheMissInputTokens: isFirst ? 60 : null
          }
        }
      }
    }
  })
  await modelAccess.initialize()
  await configure(modelAccess, { type: 'addModel', profileId: 'deepseek', modelId: 'model-a', capabilities: CAPABILITIES })
  await configure(modelAccess, { type: 'setCredential', profileId: 'deepseek', credential: 'synthetic-a' })
  await configure(modelAccess, { type: 'createProfile', profileId: 'alternate', label: 'Alternate', httpsOrigin: 'https://alternate.example.com', basePath: '/v1' })
  await configure(modelAccess, { type: 'addModel', profileId: 'alternate', modelId: 'model-b', capabilities: CAPABILITIES })
  await configure(modelAccess, { type: 'setCredential', profileId: 'alternate', credential: 'synthetic-b' })
  await configure(modelAccess, { type: 'assignPurpose', purpose: 'default', target: { profileId: 'deepseek', modelId: 'model-a' } })
  const configuredCatalog = await modelAccess.catalog()
  const profileRevisionA = configuredCatalog.snapshot.profiles.find((profile) => profile.profileId === 'deepseek').profileRevision
  const profileRevisionB = configuredCatalog.snapshot.profiles.find((profile) => profile.profileId === 'alternate').profileRevision

  const prompts = new Map()
  const runner = new FormalAgentRunRunner({
    storage: gateway,
    personalContext: {
      resolve: (request) => gateway.personalContextResolve(request),
      readSessionInput: (source) => gateway.readPersonalContextSessionInput(source),
      readToolContext: (request) => gateway.readPersonalContextToolContext(request)
    },
    modelAccess,
    promptProvider: (runId) => prompts.get(runId) || null,
    onSettled: (runId) => prompts.delete(runId),
    now: () => providerClock,
    interactions: {
      terminalize: (request) => gateway.terminalizeAgentInteraction(request),
      startToolCall: (request) => gateway.startAgentToolCall(request),
      finishToolCall: (request) => gateway.finishAgentToolCall(request)
    }
  })
  const scheduler = new FormalAgentJobScheduler({ storage: gateway, runner, requestedBy: 'user', owner: 'scheduler.j25.compare' })
  const agent = new AgentRunService({ storage: gateway, modelAccess, scheduler, promptStore: prompts })
  const recorder = new SqliteSessionRecorder({ gateway, now: () => 1000 })
  t.after(async () => {
    await scheduler.stop().catch(() => {})
    vault.close()
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(root, { recursive: true, force: true })
  })

  await recorder.openSession({ sessionId: sourceRef.sessionId, sourceId: 'mic', refinementEnabled: false })
  await recorder.acceptCaption({
    schemaVersion: 1, sessionId: sourceRef.sessionId, sourceId: 'mic', segmentId: 'segment.j25',
    sequence: 1, revision: 1, kind: 'final', t0: 0, t1: 10, text: '同一冻结输入', translation: null
  })
  await recorder.closeSession({ sessionId: sourceRef.sessionId, sourceId: 'mic', state: 'closed' })
  scheduler.start()

  const request = {
    ...CONTRACT,
    scope: { kind: 'session', reference: sourceRef.sessionId },
    prompt: '请比较这场会的重点',
  }
  const firstSubmitted = await agent.submit({ ...request, client_idempotency_key: 'client.j25.model-a' })
  assert.equal(firstSubmitted.ok, true, JSON.stringify(firstSubmitted))
  const first = await waitForTerminal(agent, firstSubmitted.result.interaction_id)
  assert.equal(first.state, 'succeeded')
  assert.deepEqual(first.model, {
    adapter_id: 'openai-compatible', model_id: 'model-a', profile_id: 'deepseek', profile_revision: profileRevisionA, provider_kind: 'cloud'
  })
  assert.deepEqual(first.usage, {
    input_tokens: 100, output_tokens: 20, usage_source: 'provider', cache_hit_input_tokens: 40, cache_miss_input_tokens: 60
  })
  assert.equal(first.duration_ms, 40)

  await configure(modelAccess, { type: 'assignPurpose', purpose: 'default', target: { profileId: 'alternate', modelId: 'model-b' } })
  const catalog = await modelAccess.catalog()
  assert.deepEqual(catalog.snapshot.readinessByPurpose.default.target, { profileId: 'alternate', modelId: 'model-b' })

  const secondSubmitted = await agent.submit({ ...request, client_idempotency_key: 'client.j25.model-b' })
  assert.equal(secondSubmitted.ok, true, JSON.stringify(secondSubmitted))
  assert.notEqual(secondSubmitted.result.run_id, firstSubmitted.result.run_id)
  const second = await waitForTerminal(agent, secondSubmitted.result.interaction_id)
  assert.equal(second.state, 'succeeded')
  assert.deepEqual(second.model, {
    adapter_id: 'openai-compatible', model_id: 'model-b', profile_id: 'alternate', profile_revision: profileRevisionB, provider_kind: 'cloud'
  })
  assert.deepEqual(second.usage, {
    input_tokens: 80, output_tokens: 10, usage_source: 'provider', cache_hit_input_tokens: null, cache_miss_input_tokens: null
  })
  assert.equal(second.duration_ms, 20)
  assert.equal(providerCalls.length, 2)
  assert.deepEqual(providerCalls.map((call) => call.modelId), ['model-a', 'model-b'])

  const history = await agent.getHistory({ ...CONTRACT, limit: 10, cursor: null })
  assert.equal(history.ok, true)
  assert.equal(history.result.items.length, 2)
  assert.equal(new Set(history.result.items.map((item) => item.comparison_group_id)).size, 1)
  assert.deepEqual(new Set(history.result.items.map((item) => item.model.model_id)), new Set(['model-a', 'model-b']))
  assert.deepEqual(history.result.items.map((item) => item.usage_state).sort(), ['known', 'known'])
  assert.deepEqual(history.result.items.map((item) => item.usage.input_tokens).sort((a, b) => a - b), [80, 100])
  assert.deepEqual(history.result.items.map((item) => item.duration_ms).sort((a, b) => a - b), [20, 40])

  const database = service.requireStore().database
  const bindings = database.prepare('SELECT run_id, profile_id, model_id FROM agent_model_run_bindings WHERE run_id IN (?, ?) ORDER BY run_id').all(first.run_id, second.run_id)
  assert.deepEqual(bindings.map(({ profile_id, model_id }) => ({ profile_id, model_id })).sort((a, b) => a.model_id.localeCompare(b.model_id)), [
    { profile_id: 'deepseek', model_id: 'model-a' },
    { profile_id: 'alternate', model_id: 'model-b' }
  ])
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM formal_agent_interactions WHERE comparison_group_id=?').get(history.result.items[0].comparison_group_id).count, 2)
  assert.equal(JSON.stringify(history).includes('synthetic-'), false)
  assert.equal(JSON.stringify(history).match(/prompt|credential|https:\/\//i), null)
})
