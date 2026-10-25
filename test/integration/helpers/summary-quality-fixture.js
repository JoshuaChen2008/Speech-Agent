'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { StorageGateway } = require('../../../src/main/services/storage-gateway')
const { StorageWorkerService } = require('../../../src/runtime/storage-worker/worker-service')
const { SqliteSessionRecorder } = require('../../../src/main/services/sqlite-session-recorder')
const { ConfigStore } = require('../../../src/main/services/config-store')
const { CredentialVault } = require('../../../src/agent/model-access/credential-vault')
const { ModelAccessRuntime } = require('../../../src/agent/model-access/runtime')
const { createPersonalContextExecutionAdapter } = require('../../../src/agent/personal-context')
const { FormalAgentRunRunner, FormalAgentJobScheduler, IntentRouteOrchestrator, AgentLoopExecutor } = require('../../../src/agent/execution-host')
const { AgentOperationService } = require('../../../src/agent/formal-run/agent-operation-service')
const c = require('../../../src/agent/contracts/session-summary-run-ui')
const { transport } = require('./context-storage-transport')
const { createNetworkAdapter, providerResponse } = require('../provider-network-fixture')

async function waitFor (predicate) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('summary quality journey deadline')
}

function refFor (payload, sessionId) {
  const source = payload.summaryPlan.source
  if (source.kind === 'verified_chunks') return [...new Map(source.parts.flatMap(part => part.output.topics.flatMap(topic => topic.sourceRefs)).map(ref => [JSON.stringify(ref), ref])).values()].slice(0, 8)
  return [{ sessionId, transcriptVersion: 'raw', fromEventOrder: source.parts[0].eventOrder, throughEventOrder: source.parts.at(-1).eventOrder }]
}
function minutes (refs = []) {
  return { schemaVersion: 2, overview: '讨论预算后返回发布议题，并修订早先建议。',
    topics: [{ topicId: 'release', title: '发布安排', text: '金额改为80。周五发布已撤销，仍需评估条件；负责人未指定。', sourceRefs: refs }],
    conclusions: [], todos: [{ topicId: 'release', text: '评估发布条件', ownerHint: null, dueHint: null, sourceRefs: refs }], risks: [] }
}
function stageResponse (payload, sessionId, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  const refs = refFor(payload, sessionId)
  return providerResponse(payload.summaryPlan.stage === 'organizing_topics'
    ? { schemaVersion: 1, topics: [{ topicId: 'release', title: '发布安排', sourceRefs: refs }] } : minutes(refs), [], usage)
}

async function fixture (t, { respond, texts, capabilities, thinking = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'summary-quality-journey-'))
  const databasePath = path.join(root, 'state.sqlite3')
  const service = new StorageWorkerService()
  const gateway = new StorageGateway({ databasePath, maxRestarts: 0, hostFactory: () => transport(service, databasePath) })
  await gateway.start()
  const database = service.requireStore().database
  const config = new ConfigStore(path.join(root, 'config.json'))
  config.load()
  config.updateAgentSettings({ expectedRevision: config.get().agentSettingsRevision, agentEnabled: true, memoryEnabled: false, cloudDisclosureAccepted: false })
  const vault = new CredentialVault({ directory: path.join(root, 'vault'), safeStorage: { isEncryptionAvailable: () => false } })
  const requests = []; const snapshots = []; const progress = []; const networkErrors = []; let operations; let scheduler
  t.after(async () => { await scheduler?.stop(); vault.close(); await gateway.shutdown(); fs.rmSync(root, { recursive: true, force: true }) })
  const sessionId = 'session.quality'
  const adapter = createNetworkAdapter({ fetch: async (_url, options) => {
    try {
    const body = JSON.parse(options.body)
    const payload = JSON.parse(body.messages.find(message => message.role === 'user').content)
    requests.push(body)
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM formal_agent_model_request_reservations').get().count, requests.length)
    return await (respond ? respond({ body, payload, count: requests.length, signal: options.signal, database, gateway, operations, scheduler, sessionId }) : stageResponse(payload, sessionId))
    } catch (error) { networkErrors.push(error.message); throw error }
  } })
  const exchange = adapter.exchange.bind(adapter)
  adapter.exchange = async input => {
    try { return await exchange(input) } catch (error) { networkErrors.push(`exchange:${error.code}:${error.outputValidation?.reason || ''}`); throw error }
  }
  const modelAccess = new ModelAccessRuntime({ gateway, vault, adapter })
  await modelAccess.initialize()
  const cap = capabilities || { maxInputTokens: 1280000, maxOutputTokens: 81920, supportsToolCalling: true,
    supportsStructuredOutput: true, supportsStreaming: true, usageReporting: true }
  const profileId = thinking ? 'preset.deepseek-openai' : 'deepseek'
  const modelId = thinking ? 'deepseek-flash' : 'deepseek-v4-flash'
  const commands = [
    ...(thinking ? [{ type: 'createProfile', profileId, label: 'DeepSeek', httpsOrigin: 'https://api.deepseek.com', basePath: '/' }] : []),
    { type: 'addModel', profileId, modelId, capabilities: cap },
    { type: 'setCredential', profileId, credential: 'synthetic-secret' },
    { type: 'assignPurpose', purpose: 'summary', target: { profileId, modelId } }
  ]
  for (const command of commands) {
    const catalog = await modelAccess.catalog()
    const response = await modelAccess.configure({ ...command, expectedRevision: catalog.snapshot.revision })
    assert.equal(response.ok, true, JSON.stringify(response.error))
  }
  const recorder = new SqliteSessionRecorder({ gateway })
  await recorder.openSession({ sessionId, sourceId: 'mic', refinementEnabled: false })
  for (const [index, text] of (texts || ['建议周五发布，预算100。', '先讨论预算，金额改为80；再回到发布：撤销周五安排，仅评估条件，负责人未指定。']).entries()) {
    await recorder.acceptCaption({ schemaVersion: 1, sessionId, sourceId: 'mic', segmentId: `segment.${index}`, sequence: index + 1,
      revision: 1, kind: 'final', t0: index, t1: index + 1, text, translation: null })
  }
  await recorder.closeSession({ sessionId, sourceId: 'mic', state: 'closed' })
  const promptStore = new Map()
  const runner = new FormalAgentRunRunner({ storage: gateway, personalContext: createPersonalContextExecutionAdapter({ storage: gateway }),
    modelAccess, promptProvider: runId => promptStore.get(runId), onProgress: async (event, signal) => {
      progress.push(event)
      const updated = await operations.recordProgress(event, signal)
      if (updated) snapshots.push(require('../../../src/agent/formal-run/agent-operation-service').publicSnapshot(updated))
      return updated
    }, onChanged: event => { void operations.notifyRunChanged(event) }, interactions: {
      terminalize: (request, signal) => gateway.terminalizeAgentInteraction(request, signal),
      startToolCall: (request, signal) => gateway.startAgentToolCall(request, signal),
      finishToolCall: (request, signal) => gateway.finishAgentToolCall(request, signal)
    } })
  scheduler = new FormalAgentJobScheduler({ storage: gateway, runner, requestedBy: 'user', owner: 'scheduler.quality' })
  const routeOrchestrator = new IntentRouteOrchestrator({ runs: { create: request => gateway.createAgentRun(request), cancel: request => gateway.cancelAgentRun(request) },
    modelAccess, interactions: { create: request => gateway.createAgentInteraction(request), terminalize: request => gateway.terminalizeAgentInteraction(request) },
    loopFactory: binding => new AgentLoopExecutor({ adapter: modelAccess.createLoopAdapter(binding) }),
    allowedTargetRecipes: ['summary.minutes'] })
  operations = new AgentOperationService({ storage: gateway, modelAccess, routeOrchestrator, scheduler, promptStore, getConfig: () => config.get(),
    onRequestChanged: () => {} })
  const accepted = await operations.accept({ contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION,
    action: 'summary', scope: { kind: 'session', reference: sessionId }, client_request_key: 'summary.quality.request' })
  assert.equal(accepted.ok, true, JSON.stringify(accepted.error))
  const requestId = accepted.result.snapshot.request_id
  await waitFor(async () => (await gateway.getSessionSummaryRequest({ requestId })).targetRunId)
  scheduler.start()
  return { root, databasePath, database, gateway, service, modelAccess, operations, scheduler, requests, snapshots, progress, networkErrors, sessionId, requestId,
    async settled () {
      const row = await waitFor(async () => {
        const value = await gateway.getSessionSummaryRequest({ requestId })
        return ['succeeded', 'failed', 'cancelled'].includes(value.state) && value
      })
      await new Promise(resolve => setImmediate(resolve))
      return row
    } }
}
module.exports = { fixture, waitFor, minutes, stageResponse }
