'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { AgentLoopExecutor } = require('../../src/agent/execution-host/agent-loop')
const { createControlledToolRuntime } = require('../../src/agent/execution-host/controlled-tool-runtime')
const { IntentRouteOrchestrator } = require('../../src/agent/execution-host/intent-route-orchestrator')
const { createToolAuditRuntime } = require('../../src/agent/execution-host/tool-audit-runtime')
const { CredentialVault } = require('../../src/agent/model-access/credential-vault')
const { ModelAccessRuntime } = require('../../src/agent/model-access/runtime')
const { deriveRecipeBudget } = require('../../src/agent/contracts/budget-axes')
const { deriveToolResultMetadata } = require('../../src/agent/contracts/controlled-tools')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { OPERATIONS, PROTOCOL_VERSION, StorageError } = require('../../src/runtime/storage-worker/protocol')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')
const { sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')

const capabilities = Object.freeze({
  maxInputTokens: 64000,
  maxOutputTokens: 4096,
  supportsToolCalling: true,
  supportsStructuredOutput: true,
  supportsStreaming: true,
  usageReporting: true
})

function serviceBackedHost (service, databasePath) {
  let sequence = 0
  const call = (operation, payload) => {
    const response = service.handle({
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId: `s3-route.${++sequence}`,
      operation,
      payload
    })
    if (!response.ok) throw new StorageError(response.error.code)
    return response.result
  }
  return {
    state: 'stopped',
    async start () { call(OPERATIONS.INITIALIZE, { databasePath }); this.state = 'ready' },
    async createAgentRun (request) { return call(OPERATIONS.AGENT_CREATE_RUN, { request }) },
    async cancelAgentRun (request) { return call(OPERATIONS.AGENT_CANCEL_RUN, { request }) },
    async createAgentInteraction (request) { return call(OPERATIONS.AGENT_CREATE_INTERACTION, { request }) },
    async terminalizeAgentInteraction (request) { return call(OPERATIONS.AGENT_TERMINALIZE_INTERACTION, { request }) },
    async startAgentToolCall (request) { return call(OPERATIONS.AGENT_START_TOOL_CALL, { request }) },
    async finishAgentToolCall (request) { return call(OPERATIONS.AGENT_FINISH_TOOL_CALL, { request }) },
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

test('SEM-F16/SEM-F28/SEM-F33/SEM-F34/SEM-T10/J22/J24: model route persists its interaction before a target run performs audited frozen-context lookup', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 's3-route-journey-'))
  const databasePath = path.join(root, 'speech-agent.sqlite3')
  const service = new StorageWorkerService()
  const gateway = new StorageGateway({
    databasePath,
    hostFactory: () => serviceBackedHost(service, databasePath),
    maxRestarts: 0
  })
  await gateway.start()
  const vault = createVault(path.join(root, 'vault'))
  t.after(async () => {
    vault.close()
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(root, { recursive: true, force: true })
  })

  const modelAccess = new ModelAccessRuntime({ gateway, vault })
  await modelAccess.initialize()
  const configure = async (command) => {
    const revision = (await modelAccess.catalog()).snapshot.revision
    const response = await modelAccess.configure({ ...command, expectedRevision: revision })
    assert.equal(response.ok, true)
  }
  await configure({ type: 'addModel', profileId: 'deepseek', modelId: 'deepseek-v4-flash', capabilities })
  await configure({ type: 'setCredential', profileId: 'deepseek', credential: 'synthetic-secret' })
  await configure({ type: 'assignPurpose', purpose: 'default', target: { profileId: 'deepseek', modelId: 'deepseek-v4-flash' } })
  await configure({ type: 'assignPurpose', purpose: 'summary', target: { profileId: 'deepseek', modelId: 'deepseek-v4-flash' } })

  let adapterCalls = 0
  const loop = new AgentLoopExecutor({
    adapter: {
      run: async ({ recipe }) => {
        adapterCalls += 1
        assert.equal(recipe.recipeId, 'intent.route')
        return { text: JSON.stringify({ recipeId: 'summary.minutes', confidence: 0.8 }), usage: null }
      }
    }
  })
  let sequence = 0
  const orchestrator = new IntentRouteOrchestrator({
    runs: {
      create: (request) => gateway.createAgentRun(request),
      cancel: (request) => gateway.cancelAgentRun(request)
    },
    modelAccess,
    interactions: {
      create: (request) => gateway.createAgentInteraction(request),
      terminalize: (request) => gateway.terminalizeAgentInteraction(request)
    },
    loop,
    resolveModel: async () => ({ provider: 'test-only-provider' }),
    idFactory: () => `s3.route.${++sequence}`
  })

  const result = await orchestrator.submit({
    scope: { kind: 'session', reference: 'session.route' },
    prompt: '请整理这场会',
    transcriptVersion: 'raw',
    inputWatermark: { throughEventOrder: 3 },
    inputDigest: sha256Canonical({ frozenInput: 'route' }),
    clientIdempotencyKey: 'route.submit.1',
    signal: null
  })

  assert.equal(adapterCalls, 1)
  assert.equal(result.recipeId, 'summary.minutes')
  assert.equal(result.routingMode, 'model')
  const database = service.requireStore().database
  const runs = database.prepare('SELECT run_id, recipe_id, state FROM formal_agent_runs ORDER BY created_at, run_id').all()
  assert.deepEqual(runs.map((run) => run.recipe_id), ['intent.route', 'summary.minutes'])
  assert.equal(runs[0].state, 'succeeded')
  assert.equal(runs[1].state, 'queued')
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM agent_model_run_bindings').get().count, 2)
  const routeInteraction = database.prepare(`
    SELECT routing_mode, terminal_reason, prompt_digest, usage_json
    FROM formal_agent_interactions WHERE run_id = ?
  `).get(runs[0].run_id)
  assert.equal(routeInteraction.routing_mode, 'model')
  assert.equal(routeInteraction.terminal_reason, 'succeeded')
  assert.equal(routeInteraction.prompt_digest, sha256Canonical('请整理这场会'))
  assert.equal(routeInteraction.usage_json, null)
  assert.equal(database.prepare('SELECT terminal_reason FROM formal_agent_interactions WHERE run_id = ?').get(runs[1].run_id).terminal_reason, null)

  const sourceRef = { sessionId: 'session.route', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 3 }
  const memoryRef = { memoryId: 'memory.route', revisionId: 'revision.route' }
  const controlled = createControlledToolRuntime({
    context: {
      scope: { registeredAliasKeys: ['decision'], memoryRefs: [memoryRef], sourceRefs: [sourceRef] },
      entries: [{ aliasKey: 'decision', memoryRef, kind: 'decision', displayText: 'A bounded decision.', sourceRefs: [sourceRef] }],
      sources: [{ sourceRef, text: 'A bounded source excerpt.' }]
    }
  })
  const audited = createToolAuditRuntime({
    interactionId: result.interactionId,
    recipeId: result.recipeId,
    recipeVersion: '1',
    attempt: 1,
    tools: controlled.toolsForRecipe(result.recipeId, '1'),
    budget: deriveRecipeBudget({ maxInputTokens: 64000, maxOutputTokens: 4096 }, result.recipeId, '1', 'user'),
    interactions: {
      startToolCall: (request) => gateway.startAgentToolCall(request),
      finishToolCall: (request) => gateway.finishAgentToolCall(request)
    },
    now: () => 0
  })
  const lookup = await audited.tools()[0].execute({ schemaVersion: 1, aliasKeys: ['decision'] })
  assert.equal(lookup.matches[0].entries[0].displayText, 'A bounded decision.')
  const toolCall = database.prepare(`
    SELECT attempt, call_order, tool_name, status, error_code, source_refs_json, counts_json
    FROM formal_agent_tool_calls WHERE interaction_id = ?
  `).get(result.interactionId)
  assert.equal(toolCall.attempt, 1)
  assert.equal(toolCall.call_order, 1)
  assert.equal(toolCall.tool_name, 'search_context')
  assert.equal(toolCall.status, 'succeeded')
  assert.equal(toolCall.error_code, null)
  assert.deepEqual(JSON.parse(toolCall.source_refs_json), [sourceRef])
  const metadata = deriveToolResultMetadata('search_context', { schemaVersion: 1, aliasKeys: ['decision'] }, lookup)
  assert.deepEqual(JSON.parse(toolCall.counts_json), {
    resultBytes: metadata.resultBytes,
    sourceTextBytes: metadata.sourceTextBytes,
    sourceReferenceCount: metadata.sourceReferenceCount
  })
})
