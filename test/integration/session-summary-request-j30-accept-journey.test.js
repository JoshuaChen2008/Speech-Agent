'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { AgentRunService } = require('../../src/agent/formal-run/agent-run-service')
const { SessionSummaryRunService } = require('../../src/agent/formal-run/session-summary-run-service')
const { AgentLoopExecutor, IntentRouteOrchestrator } = require('../../src/agent/execution-host')
const { CredentialVault } = require('../../src/agent/model-access/credential-vault')
const { ModelAccessRuntime } = require('../../src/agent/model-access/runtime')
const { ConfigStore } = require('../../src/main/services/config-store')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')
const { OPERATIONS, PROTOCOL_VERSION, StorageError, makeCaptionEventId, makeCloseSessionKey, makeOpenSessionKey } = require('../../src/runtime/storage-worker/protocol')
const contract = require('../../src/agent/contracts/session-summary-run-ui')

const RUN_CONTRACT = { contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0' }
const SCOPE = { kind: 'session', reference: 'session.j30.accept' }
const CAPABILITIES = Object.freeze({
  maxInputTokens: 64000,
  maxOutputTokens: 4096,
  supportsToolCalling: true,
  supportsStructuredOutput: true,
  supportsStreaming: true,
  usageReporting: false
})

function serviceBackedHost (service, databasePath) {
  let sequence = 0
  const call = (operation, payload, idempotencyKey) => {
    const response = service.handle({
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId: `j30-accept.${++sequence}`,
      operation,
      payload,
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
    async derivePersonalContextSessionSource (request) { return call(OPERATIONS.PERSONAL_CONTEXT_DERIVE_SESSION_SOURCE, { request }) },
    async createAgentRun (request) { return call(OPERATIONS.AGENT_CREATE_RUN, { request }) },
    async cancelAgentRun (request) { return call(OPERATIONS.AGENT_CANCEL_RUN, { request }) },
    async createAgentInteraction (request) { return call(OPERATIONS.AGENT_CREATE_INTERACTION, { request }) },
    async terminalizeAgentInteraction (request) { return call(OPERATIONS.AGENT_TERMINALIZE_INTERACTION, { request }) },
    async getAgentInteraction (request) { return call(OPERATIONS.AGENT_GET_INTERACTION, { request }) },
    async modelAccessCatalog () { return call(OPERATIONS.MODEL_ACCESS_CATALOG, {}) },
    async modelAccessConfigure (input) { return call(OPERATIONS.MODEL_ACCESS_CONFIGURE, { input }) },
    async modelAccessBind (request, availableSlotIds) { return call(OPERATIONS.MODEL_ACCESS_BIND, { request, availableSlotIds }) },
    async acceptSessionSummaryRequest (request) { return call(OPERATIONS.SUMMARY_REQUEST_ACCEPT, { request }) },
    async getSessionSummaryRequest (request) { return call(OPERATIONS.SUMMARY_REQUEST_GET, { request }) },
    async updateSessionSummaryRequest (request) { return call(OPERATIONS.SUMMARY_REQUEST_UPDATE, { request }) },
    async cancelSessionSummaryRequest (request) { return call(OPERATIONS.SUMMARY_REQUEST_CANCEL, { request }) },
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

function tick () { return new Promise((resolve) => setImmediate(resolve)) }

async function waitFor (predicate, description) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await predicate()) return
    await tick()
  }
  throw new Error(`timed out waiting for ${description}`)
}

function request (action, key, prompt) {
  return {
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    action,
    scope: SCOPE,
    client_request_key: key,
    ...(action === 'question' ? { prompt } : {})
  }
}

test('SEM-F38/SEM-T04/J30-ACCEPT: request identity persists before routing, summary uses preset, and route cancellation creates no target', { timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-summary-j30-accept-'))
  const databasePath = path.join(root, 'speech-agent.sqlite3')
  const configPath = path.join(root, 'config.json')
  const storageService = new StorageWorkerService()
  const gateway = new StorageGateway({
    databasePath,
    hostFactory: () => serviceBackedHost(storageService, databasePath),
    maxRestarts: 0
  })
  await gateway.start()
  const config = new ConfigStore(configPath, { now: () => 1770000000000 })
  config.load()
  config.updateAgentSettings({
    expectedRevision: config.get().agentSettingsRevision,
    agentEnabled: true,
    memoryEnabled: true,
    cloudDisclosureAccepted: false
  })
  const vault = createVault(path.join(root, 'vault'))
  let routeCalls = 0
  let routeBehavior = 'qa'
  const modelAccess = new ModelAccessRuntime({
    gateway,
    vault,
    adapter: {
      async run ({ recipe, signal }) {
        if (recipe.recipeId !== 'intent.route') throw new Error('unexpected target execution in acceptance journey')
        routeCalls += 1
        if (routeBehavior === 'wait') {
          return new Promise((resolve, reject) => {
            const abort = () => {
              const error = new Error('AGENT_CANCELLED')
              error.code = 'AGENT_CANCELLED'
              reject(error)
            }
            if (signal?.aborted) return abort()
            signal?.addEventListener('abort', abort, { once: true })
          })
        }
        return { text: JSON.stringify({ recipeId: 'qa.answer', confidence: 0.95 }), usage: null }
      }
    }
  })
  await modelAccess.initialize()
  for (const command of [
    { type: 'addModel', profileId: 'deepseek', modelId: 'deepseek-v4-flash', capabilities: CAPABILITIES },
    { type: 'setCredential', profileId: 'deepseek', credential: 'j30-provider-secret' },
    { type: 'assignPurpose', purpose: 'default', target: { profileId: 'deepseek', modelId: 'deepseek-v4-flash' } },
    { type: 'assignPurpose', purpose: 'summary', target: { profileId: 'deepseek', modelId: 'deepseek-v4-flash' } }
  ]) {
    const catalog = await modelAccess.catalog()
    const result = await modelAccess.configure({ ...command, expectedRevision: catalog.snapshot.revision })
    assert.equal(result.ok, true)
  }

  const recorder = new SqliteSessionRecorder({ gateway, now: () => 1770000000000 })
  await recorder.openSession({ sessionId: SCOPE.reference, sourceId: 'mic', refinementEnabled: false })
  await recorder.acceptCaption({
    schemaVersion: 1,
    sessionId: SCOPE.reference,
    sourceId: 'mic',
    segmentId: 'segment.j30.accept',
    sequence: 1,
    revision: 1,
    kind: 'final',
    t0: 0,
    t1: 10,
    text: 'J30 合成会话正文 marker',
    translation: null
  })
  await recorder.closeSession({ sessionId: SCOPE.reference, sourceId: 'mic', state: 'closed' })

  const routeOrchestrator = new IntentRouteOrchestrator({
    runs: {
      create: (input) => gateway.createAgentRun(input),
      cancel: (input) => gateway.cancelAgentRun(input),
      getInteraction: (input) => gateway.getAgentInteraction(input)
    },
    modelAccess,
    interactions: {
      create: (input) => gateway.createAgentInteraction(input),
      terminalize: (input) => gateway.terminalizeAgentInteraction(input)
    },
    loopFactory: (binding) => new AgentLoopExecutor({ adapter: modelAccess.createLoopAdapter(binding) }),
    allowedTargetRecipes: ['summary.minutes', 'qa.answer']
  })
  const runService = new AgentRunService({ storage: gateway, modelAccess, getConfig: () => config.get() })
  const dispatchQueue = []
  let loseNextAcceptanceReply = false
  let failFrozenSourceRead = false
  let failEligibility = false
  let failNextCancelWrite = false
  let frozenSourceReadCount = 0
  let eligibilityCheckCount = 0
  const requestStorage = new Proxy(gateway, {
    get (target, property) {
      if (property === 'acceptSessionSummaryRequest') {
        return async (input) => {
          const accepted = await target.acceptSessionSummaryRequest(input)
          if (loseNextAcceptanceReply) {
            loseNextAcceptanceReply = false
            throw new Error('synthetic response loss after durable acceptance')
          }
          return accepted
        }
      }
      if (property === 'derivePersonalContextSessionSource') {
        return async (input) => {
          frozenSourceReadCount += 1
          if (failFrozenSourceRead) throw Object.assign(new Error('frozen source unavailable'), { code: 'AGENT_RUN_UNAVAILABLE' })
          return target.derivePersonalContextSessionSource(input)
        }
      }
      if (property === 'cancelSessionSummaryRequest') {
        return async (input) => {
          if (failNextCancelWrite) {
            failNextCancelWrite = false
            throw Object.assign(new Error('synthetic cancellation persistence failure'), { code: 'AGENT_RUN_UNAVAILABLE' })
          }
          return target.cancelSessionSummaryRequest(input)
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  const requestRunService = {
    async getEligibility (input) {
      eligibilityCheckCount += 1
      if (failEligibility) return { ok: false, error: { next_action: 'settings' } }
      return runService.getEligibility(input)
    }
  }
  const summaryRun = new SessionSummaryRunService({
    storage: requestStorage,
    runService: requestRunService,
    routeOrchestrator,
    getConfig: () => config.get(),
    defer: (callback) => dispatchQueue.push(callback)
  })
  t.after(async () => {
    vault.close()
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(root, { recursive: true, force: true })
  })

  const summaryRequest = request('summary', 'j30.summary.key')
  loseNextAcceptanceReply = true
  const unknownReceipt = await summaryRun.accept(summaryRequest)
  assert.equal(unknownReceipt.ok, false)
  assert.equal(routeCalls, 0)
  assert.equal(dispatchQueue.length, 0)
  const checksBeforeReplay = eligibilityCheckCount
  const sourceReadsBeforeReplay = frozenSourceReadCount
  failEligibility = true
  failFrozenSourceRead = true
  const summaryAccepted = await summaryRun.accept(summaryRequest)
  assert.equal(summaryAccepted.ok, true)
  assert.equal(summaryAccepted.result.snapshot.action, 'summary')
  assert.equal(summaryAccepted.result.snapshot.state, 'accepted')
  assert.equal(routeCalls, 0)
  assert.equal(eligibilityCheckCount, checksBeforeReplay)
  assert.equal(frozenSourceReadCount, sourceReadsBeforeReplay)
  failEligibility = false
  failFrozenSourceRead = false
  const summaryReplay = await summaryRun.accept(summaryRequest)
  assert.equal(summaryReplay.ok, true)
  assert.equal(summaryReplay.result.replayed, true)
  assert.equal(summaryReplay.result.snapshot.request_id, summaryAccepted.result.snapshot.request_id)
  assert.equal(routeCalls, 0)
  assert.equal(dispatchQueue.length, 1)
  dispatchQueue.shift()()
  await waitFor(() => summaryRun.dispatches.size === 0, 'preset summary target persistence')
  const summarySnapshot = await summaryRun.get({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: summaryAccepted.result.snapshot.request_id
  })
  assert.equal(summarySnapshot.ok, true)
  assert.equal(summarySnapshot.result.snapshot.recipe_id, 'summary.minutes')
  assert.equal(summarySnapshot.result.snapshot.routing_mode, 'preset')
  assert.equal(summarySnapshot.result.snapshot.route_run_id, null)
  assert.equal(routeCalls, 0)

  const questionRequest = request('question', 'j30.question.key', '这场会决定了什么？')
  const questionAccepted = await summaryRun.accept(questionRequest)
  assert.equal(questionAccepted.ok, true)
  assert.equal(routeCalls, 0)
  dispatchQueue.shift()()
  await waitFor(async () => {
    const current = await summaryRun.get({
      contract_id: contract.CONTRACT_ID,
      contract_version: contract.CONTRACT_VERSION,
      request_id: questionAccepted.result.snapshot.request_id
    })
    return current.ok && current.result.snapshot.target_run_id !== null
  }, 'question route target')
  const questionSnapshot = await summaryRun.get({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: questionAccepted.result.snapshot.request_id
  })
  assert.equal(questionSnapshot.result.snapshot.recipe_id, 'qa.answer')
  assert.equal(questionSnapshot.result.snapshot.routing_mode, 'model')
  assert.equal(routeCalls, 1)
  const questionReplay = await summaryRun.accept(questionRequest)
  assert.equal(questionReplay.ok, true)
  assert.equal(questionReplay.result.replayed, true)
  assert.equal(questionReplay.result.snapshot.target_run_id, questionSnapshot.result.snapshot.target_run_id)
  assert.equal(dispatchQueue.length, 1)
  dispatchQueue.shift()()
  await waitFor(() => summaryRun.dispatches.size === 0, 'idempotent question route replay')
  assert.equal(routeCalls, 1)

  routeBehavior = 'wait'
  const uncertainCancelRequest = request('question', 'j30.question.cancel.storage-failure', '取消状态存储失败后可重试')
  const uncertainCancelAccepted = await summaryRun.accept(uncertainCancelRequest)
  assert.equal(uncertainCancelAccepted.ok, true)
  dispatchQueue.shift()()
  await waitFor(() => routeCalls === 2, 'question route before cancellation persistence failure')
  failNextCancelWrite = true
  const cancelNotConfirmed = await summaryRun.cancel({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: uncertainCancelAccepted.result.snapshot.request_id,
    generation: uncertainCancelAccepted.result.snapshot.generation
  })
  assert.equal(cancelNotConfirmed.ok, false)
  assert.equal(cancelNotConfirmed.error.next_action, 'verify_state')
  await waitFor(() => summaryRun.dispatches.size === 0, 'route local abort after cancellation persistence failure')
  const cancelUncertainSnapshot = await summaryRun.get({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: uncertainCancelAccepted.result.snapshot.request_id
  })
  assert.equal(cancelUncertainSnapshot.ok, true)
  assert.notEqual(cancelUncertainSnapshot.result.snapshot.state, 'failed')
  assert.notEqual(cancelUncertainSnapshot.result.snapshot.state, 'cancelled')
  const retriedCancellation = await summaryRun.cancel({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: uncertainCancelAccepted.result.snapshot.request_id,
    generation: uncertainCancelAccepted.result.snapshot.generation
  })
  assert.equal(retriedCancellation.ok, true)
  assert.equal(retriedCancellation.result.snapshot.state, 'cancelled')

  const cancelledRequest = request('question', 'j30.question.cancel', '这个请求应在路由时取消')
  const cancelledAccepted = await summaryRun.accept(cancelledRequest)
  assert.equal(cancelledAccepted.ok, true)
  dispatchQueue.shift()()
  await waitFor(() => routeCalls === 3, 'in-flight question route')
  const cancelled = await summaryRun.cancel({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: cancelledAccepted.result.snapshot.request_id,
    generation: cancelledAccepted.result.snapshot.generation
  })
  assert.equal(cancelled.ok, true)
  assert.equal(cancelled.result.snapshot.state, 'cancelled')
  await waitFor(() => summaryRun.dispatches.size === 0, 'cancelled route shutdown')
  const cancelledRow = await gateway.getSessionSummaryRequest({ requestId: cancelledAccepted.result.snapshot.request_id })
  assert.equal(cancelledRow.targetRunId, null)
  const database = storageService.requireStore().database
  const cancelledRuns = database.prepare('SELECT recipe_id,state FROM formal_agent_runs WHERE session_summary_request_id=?').all(cancelledAccepted.result.snapshot.request_id)
  assert.deepEqual(cancelledRuns.map((run) => run.recipe_id), ['intent.route'])
  assert.equal(cancelledRuns[0].state, 'cancelled')
  const requestRows = database.prepare('SELECT action,prompt_digest,summary_use_memory FROM formal_agent_requests ORDER BY request_id').all()
  assert.equal(requestRows.length, 4)
  assert.equal(JSON.stringify(requestRows).includes('J30 合成会话正文 marker'), false)
  assert.equal(JSON.stringify(requestRows).includes('这个请求应在路由时取消'), false)
})
