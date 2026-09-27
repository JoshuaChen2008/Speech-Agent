'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { AgentRunService } = require('../../src/agent/formal-run/agent-run-service')
const { SessionSummaryRunService } = require('../../src/agent/formal-run/session-summary-run-service')
const { AgentLoopExecutor, FormalAgentJobScheduler, FormalAgentRunRunner, IntentRouteOrchestrator } = require('../../src/agent/execution-host')
const { CredentialVault } = require('../../src/agent/model-access/credential-vault')
const { ModelAccessRuntime } = require('../../src/agent/model-access/runtime')
const { ConfigStore } = require('../../src/main/services/config-store')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')
const { OPERATIONS, PROTOCOL_VERSION, StorageError, makeCaptionEventId, makeCloseSessionKey, makeOpenSessionKey } = require('../../src/runtime/storage-worker/protocol')

const CONTRACT = { contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0' }
const SUMMARY_RUN_CONTRACT = { contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0' }
const SUMMARY_PROMPT = '请基于这场已结束的会话生成会话总结，包含主要内容、决定、待办和需要注意。'
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
      requestId: `j29-memory.${++sequence}`,
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
    async listSessions (value) { return call(OPERATIONS.LIST_SESSIONS, value) },
    async personalContextManage (command) { return call(OPERATIONS.PERSONAL_CONTEXT_MANAGE, { command }) },
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
    async acceptSessionSummaryRequest (request) { return call(OPERATIONS.SUMMARY_REQUEST_ACCEPT, { request }) },
    async getSessionSummaryRequest (request) { return call(OPERATIONS.SUMMARY_REQUEST_GET, { request }) },
    async updateSessionSummaryRequest (request) { return call(OPERATIONS.SUMMARY_REQUEST_UPDATE, { request }) },
    async cancelSessionSummaryRequest (request) { return call(OPERATIONS.SUMMARY_REQUEST_CANCEL, { request }) },
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
  const apply = async (command) => {
    const catalog = await modelAccess.catalog()
    const response = await modelAccess.configure({ ...command, expectedRevision: catalog.snapshot.revision })
    assert.equal(response.ok, true, JSON.stringify(response))
  }
  await apply({ type: 'addModel', profileId: 'deepseek', modelId: 'deepseek-v4-flash', capabilities: CAPABILITIES })
  await apply({ type: 'setCredential', profileId: 'deepseek', credential: 'j29-provider-secret' })
  await apply({ type: 'assignPurpose', purpose: 'default', target: { profileId: 'deepseek', modelId: 'deepseek-v4-flash' } })
  await apply({ type: 'assignPurpose', purpose: 'summary', target: { profileId: 'deepseek', modelId: 'deepseek-v4-flash' } })
}

function tick () { return new Promise((resolve) => setImmediate(resolve)) }

function deferred () {
  let resolve
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

async function waitForTerminal (agent, interactionId) {
  let detail = null
  for (let attempt = 0; attempt < 120; attempt += 1) {
    detail = await agent.getInteraction({ ...CONTRACT, interaction_id: interactionId })
    if (detail.ok && ['succeeded', 'failed', 'cancelled'].includes(detail.result.state)) return detail
    await tick()
  }
  throw new Error(`J29 interaction did not settle: ${interactionId}`)
}

test('SEM-F38/SEM-T04/J29: settings, SQLite, provider boundary and Agent Bar summary cover all memory policy combinations', { timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-summary-j29-'))
  const databasePath = path.join(root, 'speech-agent.sqlite3')
  const configPath = path.join(root, 'config.json')
  const service = new StorageWorkerService()
  const gateway = new StorageGateway({
    databasePath,
    hostFactory: () => serviceBackedHost(service, databasePath),
    maxRestarts: 0
  })
  await gateway.start()
  const config = new ConfigStore(configPath, { now: () => 1770000000000 })
  config.load()
  const vault = createVault(path.join(root, 'vault'))
  const memoryObservations = []
  let routeCalls = 0
  let summaryProviderBarrier = null
  const modelAccess = new ModelAccessRuntime({
    gateway,
    vault,
    adapter: {
      async run ({ recipe, tools, onProgress }) {
        if (recipe.recipeId === 'intent.route') {
          routeCalls += 1
          // An invalid provider output must fall back to the same summary intent.
          return { text: routeCalls === 1 ? '{}' : JSON.stringify({ recipeId: 'summary.minutes', confidence: 1 }) }
        }
        assert.equal(recipe.recipeId, 'summary.minutes')
        await onProgress?.({ type: 'request_started', turn: 1 })
        const barrier = summaryProviderBarrier
        if (barrier) {
          summaryProviderBarrier = null
          barrier.requestStarted.resolve()
          await barrier.releaseRequest.promise
        }
        const lookup = await tools[0].execute({ schemaVersion: 1, aliasKeys: ['j29 provider marker'] })
        memoryObservations.push(lookup)
        if (barrier) {
          barrier.toolFinished.resolve()
          await barrier.releaseResponse.promise
        }
        const sourceRef = { sessionId: 'session.j29.memory', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 1 }
        await onProgress?.({ type: 'response_received', turn: 1 })
        return {
          text: JSON.stringify({
            schemaVersion: 1,
            overview: lookup.matches.length > 0 ? '本次总结带有相关背景。' : '本次总结只依据会话。',
            conclusions: [{ text: '保留会话中的决定。', sourceRefs: [sourceRef] }],
            todos: [],
            risks: []
          })
        }
      }
    }
  })
  await modelAccess.initialize()
  await configureModel(modelAccess)
  const recorder = new SqliteSessionRecorder({ gateway, now: () => 1770000000000 })
  await recorder.openSession({ sessionId: 'session.j29.memory', sourceId: 'mic', refinementEnabled: false })
  await recorder.acceptCaption({
    schemaVersion: 1, sessionId: 'session.j29.memory', sourceId: 'mic', segmentId: 'segment.j29.memory',
    sequence: 1, revision: 1, kind: 'final', t0: 0, t1: 10, text: 'J29 会话事实', translation: null
  })
  await recorder.closeSession({ sessionId: 'session.j29.memory', sourceId: 'mic', state: 'closed' })

  const remembered = await gateway.personalContextManage({
    type: 'remember',
    expected_revision: 0,
    entry: {
      display_text: 'J29 provider marker',
      kind: 'term',
      scope: { kind: 'global', reference: null }
    }
  })
  assert.equal(remembered.revision, 1)

  const promptStore = new Map()
  let summaryRunService = null
  let discardedMemoryPreReads = 0
  const runner = new FormalAgentRunRunner({
    storage: gateway,
    personalContext: {
      resolve: (request) => {
        discardedMemoryPreReads += 1
        return gateway.personalContextResolve(request)
      },
      readSessionInput: (source) => gateway.readPersonalContextSessionInput(source),
      readToolContext: (request) => gateway.readPersonalContextToolContext(request)
    },
    modelAccess,
    promptProvider: (runId) => promptStore.get(runId),
    onProgress: (event) => summaryRunService?.recordProgress(event),
    onChanged: (event) => {
      if (event?.requestId) void summaryRunService?.notifyRunChanged(event)
    },
    interactions: {
      terminalize: (request) => gateway.terminalizeAgentInteraction(request),
      startToolCall: (request) => gateway.startAgentToolCall(request),
      finishToolCall: (request) => gateway.finishAgentToolCall(request)
    }
  })
  const scheduler = new FormalAgentJobScheduler({ storage: gateway, runner, requestedBy: 'user', owner: 'scheduler.j29' })
  const routeOrchestrator = new IntentRouteOrchestrator({
      runs: {
        create: (request) => gateway.createAgentRun(request),
        cancel: (request) => gateway.cancelAgentRun(request),
        getInteraction: (request) => gateway.getAgentInteraction(request)
      },
      modelAccess,
      interactions: {
        create: (request) => gateway.createAgentInteraction(request),
        terminalize: (request) => gateway.terminalizeAgentInteraction(request)
      },
      loopFactory: (binding) => new AgentLoopExecutor({ adapter: modelAccess.createLoopAdapter(binding) }),
      allowedTargetRecipes: ['summary.minutes', 'qa.answer']
  })
  const agent = new AgentRunService({
    storage: gateway,
    modelAccess,
    scheduler,
    getConfig: () => config.get(),
    promptStore,
    routeOrchestrator
  })
  const summaryProgressEvents = []
  summaryRunService = new SessionSummaryRunService({
    storage: gateway,
    runService: agent,
    routeOrchestrator,
    scheduler,
    getConfig: () => config.get(),
    promptStore,
    onChanged: (event) => summaryProgressEvents.push(event)
  })
  scheduler.start()
  t.after(async () => {
    await scheduler.stop().catch(() => {})
    vault.close()
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(root, { recursive: true, force: true })
  })

  const setAgent = (agentEnabled, memoryEnabled) => config.updateAgentSettings({
    expectedRevision: config.get().agentSettingsRevision,
    agentEnabled,
    memoryEnabled,
    cloudDisclosureAccepted: false
  })
  const setSummary = (summaryUseMemory) => config.updateSummaryUseMemory({
    expectedRevision: config.get().agentSettingsRevision,
    summaryUseMemory
  })
  const submit = (key) => agent.submit({
    ...CONTRACT,
    scope: { kind: 'session', reference: 'session.j29.memory' },
    prompt: SUMMARY_PROMPT,
    client_idempotency_key: key
  })

  setAgent(false, true)
  setSummary(true)
  const disabled = await submit('j29.disabled')
  assert.equal(disabled.ok, false)
  assert.equal(disabled.error.next_action, 'retry')
  assert.equal(routeCalls, 0)

  setAgent(true, false)
  setSummary(true)
  const paused = await submit('j29.paused')
  assert.equal(paused.ok, true)
  assert.equal(paused.result.recipe_id, 'summary.minutes')
  assert.equal(paused.result.routing_mode, 'rules')
  const pausedDetail = await waitForTerminal(agent, paused.result.interaction_id)
  assert.equal(pausedDetail.result.state, 'succeeded')
  assert.equal(pausedDetail.result.summary_use_memory, false)
  assert.equal(pausedDetail.result.memory_reference_count, 0)

  setAgent(true, true)
  setSummary(false)
  const optedOut = await submit('j29.opted-out')
  assert.equal(optedOut.ok, true)
  assert.equal(optedOut.result.routing_mode, 'model')
  const optedOutDetail = await waitForTerminal(agent, optedOut.result.interaction_id)
  assert.equal(optedOutDetail.result.state, 'succeeded')
  assert.equal(optedOutDetail.result.summary_use_memory, false)
  assert.equal(optedOutDetail.result.memory_reference_count, 0)

  setSummary(true)
  const optedIn = await submit('j29.opted-in')
  assert.equal(optedIn.ok, true)
  const optedInDetail = await waitForTerminal(agent, optedIn.result.interaction_id)
  assert.equal(optedInDetail.result.state, 'succeeded')
  assert.equal(optedInDetail.result.summary_use_memory, true)
  assert.equal(optedInDetail.result.memory_reference_count, 1)

  assert.equal(memoryObservations.length, 3)
  assert.equal(routeCalls, 3)
  assert.equal(memoryObservations[0].matches.length, 0)
  assert.equal(memoryObservations[1].matches.length, 0)
  assert.equal(memoryObservations[2].matches.length, 1)
  assert.match(memoryObservations[2].matches[0].entries[0].displayText, /J29 provider marker/)

  const history = await agent.getHistory({ ...CONTRACT, limit: 10, cursor: null })
  assert.equal(history.ok, true)
  const historyOptedIn = history.result.items.find((item) => item.interaction_id === optedIn.result.interaction_id)
  assert.equal(historyOptedIn.summary_use_memory, true)
  assert.equal(historyOptedIn.memory_reference_count, 1)

  const reloaded = new ConfigStore(configPath, { now: () => 1770000000001 })
  assert.equal(reloaded.load().summaryUseMemory, true)
  assert.equal(reloaded.get().memoryEnabled, true)
  assert.equal(reloaded.get().agentEnabled, true)

  const requestStarted = deferred()
  const releaseRequest = deferred()
  const toolFinished = deferred()
  const releaseResponse = deferred()
  summaryProviderBarrier = { requestStarted, releaseRequest, toolFinished, releaseResponse }
  const summaryEligibility = await agent.getEligibility({
    ...CONTRACT,
    scope: { kind: 'session', reference: 'session.j29.memory' }
  })
  assert.equal(summaryEligibility.snapshot?.eligibility, 'ready', JSON.stringify(summaryEligibility))
  const acceptedSummary = await summaryRunService.accept({
    ...SUMMARY_RUN_CONTRACT,
    action: 'summary',
    scope: { kind: 'session', reference: 'session.j29.memory' },
    client_request_key: 'j29.progress.summary'
  })
  assert.equal(acceptedSummary.ok, true)
  const requestId = acceptedSummary.result.snapshot.request_id
  await requestStarted.promise
  const waiting = await summaryRunService.get({ ...SUMMARY_RUN_CONTRACT, request_id: requestId })
  assert.equal(waiting.result.snapshot.phase, 'waiting_model')
  assert.equal(waiting.result.snapshot.attempt, 1)
  assert.equal(waiting.result.snapshot.memory_state, 'not_read')
  assert.equal(waiting.result.snapshot.last_activity_age_ms !== null, true)
  assert.equal(waiting.result.snapshot.validated_chunk_count, null)
  releaseRequest.resolve()
  await toolFinished.promise
  const reading = await summaryRunService.get({ ...SUMMARY_RUN_CONTRACT, request_id: requestId })
  assert.equal(reading.result.snapshot.phase, 'reading_context')
  assert.equal(reading.result.snapshot.memory_state, 'referenced')
  assert.equal(reading.result.snapshot.attempt, 1)
  releaseResponse.resolve()

  let terminal = null
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await summaryRunService.get({ ...SUMMARY_RUN_CONTRACT, request_id: requestId })
    if (response.ok && ['succeeded', 'failed', 'cancelled'].includes(response.result.snapshot.state)) {
      terminal = response.result.snapshot
      break
    }
    await tick()
  }
  assert.ok(terminal, 'the actual runner and SQLite interaction reached a terminal state')
  assert.equal(terminal.state, 'succeeded')
  assert.equal(terminal.phase, 'terminal')
  assert.equal(terminal.memory_state, 'referenced')
  assert.equal(terminal.validated_chunk_count, null)
  assert.equal(discardedMemoryPreReads, 0)
  assert.ok(summaryProgressEvents.some((event) => event.revision > waiting.result.snapshot.revision))
})
