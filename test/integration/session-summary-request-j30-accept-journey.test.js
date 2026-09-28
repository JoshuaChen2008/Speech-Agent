'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const { AgentRunService } = require('../../src/agent/formal-run/agent-run-service')
const { SessionSummaryRunService, SUMMARY_PROMPT } = require('../../src/agent/formal-run/session-summary-run-service')
const { AgentRunDiagnostics } = require('../../src/main/services/agent-run-diagnostics')
const { assertDiagnosticRecord } = require('../../src/agent/contracts/agent-run-diagnostics')
const { AgentLoopExecutor, IntentRouteOrchestrator } = require('../../src/agent/execution-host')
const { CredentialVault } = require('../../src/agent/model-access/credential-vault')
const { ModelAccessRuntime } = require('../../src/agent/model-access/runtime')
const { ConfigStore } = require('../../src/main/services/config-store')
const { HistoryService } = require('../../src/main/services/history-service')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')
const { FakeRuntimeAdapter } = require('../../src/main/session/fake-runtime-adapter')
const { SessionCoordinator } = require('../../src/main/session/session-coordinator')
const { resolveRuntimeOptions, DEV_MODEL_VALUE } = require('../../src/main/runtime-options')
const { OPERATIONS, PROTOCOL_VERSION, StorageError, makeCaptionEventId, makeCloseSessionKey, makeOpenSessionKey } = require('../../src/runtime/storage-worker/protocol')
const contract = require('../../src/agent/contracts/session-summary-run-ui')
const diagnosticsUI = require('../../src/agent/contracts/agent-run-diagnostics-ui')
const { assertDiagnosticExportSnapshot } = require('../../src/agent/contracts/agent-run-diagnostics')
const CHANNELS = require('../../src/main/ipc/channels')
const { registerSessionSummaryRunIpc } = require('../../src/main/ipc/session-summary-run-ipc')

function createAgentPreloadApi (handlers, event) {
  const exposed = {}
  const listeners = new Map()
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'preload', 'agent.js'), 'utf8')
  const localRequire = (specifier) => {
    if (specifier === 'electron') return { contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value } } }
    if (specifier === './shared') {
      return {
        createWindowInteractionBridge: () => ({ dragStart: () => {}, dragEnd: () => {}, onInteractionSync: () => () => {} }),
        ipcRenderer: {
          invoke: (channel, request) => {
            const handler = handlers.get(channel)
            if (!handler) throw new Error(`no main handler for ${channel}`)
            return handler(event, request)
          },
          on: (channel, callback) => listeners.set(channel, callback),
          removeListener: (channel, callback) => { if (listeners.get(channel) === callback) listeners.delete(channel) },
          send: () => {}
        },
        subscribe: () => () => {}
      }
    }
    if (specifier === '../main/ipc/channels') return CHANNELS
    if (specifier === '../agent/contracts/agent-run-ui') return require('../../src/agent/contracts/agent-run-ui')
    if (specifier === '../agent/contracts/session-summary-run-ui') return contract
    if (specifier === '../agent/contracts/agent-run-diagnostics-ui') return diagnosticsUI
    if (specifier === '../agent/contracts/agent-context-ui') return require('../../src/agent/contracts/agent-context-ui')
    throw new Error(`unexpected preload dependency: ${specifier}`)
  }
  const wrapper = ['(function (require, module, exports) {', source, '})'].join('\n')
  vm.runInNewContext(wrapper, {})(localRequire, { exports: {} }, {})
  return {
    api: exposed.agentApi,
    emit: (channel, value) => listeners.get(channel)?.({}, value)
  }
}

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
const PRIVACY_MARKERS = Object.freeze({
  transcript: 'J30_PRIVACY_TRANSCRIPT_4_4',
  prompt: 'J30_PRIVACY_PROMPT_4_4',
  toolArguments: 'J30_PRIVACY_TOOL_ARGUMENTS_4_4',
  toolResult: 'J30_PRIVACY_TOOL_RESULT_4_4',
  providerEvent: 'J30_PRIVACY_PROVIDER_EVENT_4_4',
  providerResponse: 'J30_PRIVACY_PROVIDER_RESPONSE_4_4',
  exceptionMessage: 'J30_PRIVACY_EXCEPTION_MESSAGE_4_4',
  exceptionStack: 'J30_PRIVACY_EXCEPTION_STACK_4_4'
})

function audioFilesUnder (directory) {
  const found = []
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (/\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)$/i.test(entry.name)) found.push(target)
    }
  }
  visit(directory)
  return found
}

function validationJsonFiles () {
  const root = path.resolve(process.cwd(), 'docs', 'validation')
  const found = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (entry.isFile() && entry.name.endsWith('.json')) found.push(target)
    }
  }
  visit(root)
  return found
}

function diagnosticFileSnapshot (directory) {
  return fs.readdirSync(directory).filter((name) => name.endsWith('.jsonl')).sort()
    .map((name) => [name, fs.readFileSync(path.join(directory, name))])
}

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
    async getSessionPage (value) { return call(OPERATIONS.GET_SESSION_PAGE, value) },
    async listSessions (value) { return call(OPERATIONS.LIST_SESSIONS, value) },
    async derivePersonalContextSessionSource (request) { return call(OPERATIONS.PERSONAL_CONTEXT_DERIVE_SESSION_SOURCE, { request }) },
    async claimNextFormalAgentRun (request) { return call(OPERATIONS.FORMAL_AGENT_CLAIM_RUN, { request }) },
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
    async resumeSessionSummaryRequest (request) { return call(OPERATIONS.SUMMARY_REQUEST_RESUME, { request }) },
    async failUnrecoverableSessionSummaryRequest (request) { return call(OPERATIONS.SUMMARY_REQUEST_FAIL_UNRECOVERABLE, { request }) },
    async recoverSessionSummaryRequests () { return call(OPERATIONS.SUMMARY_REQUEST_RECOVER, {}) },
    async listRecoverableSessionSummaryRequests () { return call(OPERATIONS.SUMMARY_REQUEST_LIST_RECOVERABLE, {}) },
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
  const diagnosticDirectory = path.join(root, 'logs', 'agent-run-diagnostics')
  const diagnosticExportPath = path.join(root, 'selected-diagnostics.json')
  let failDiagnosticWrites = false
  let cancelDiagnosticSave = false
  let diagnosticSaveDialogCalls = 0
  let summaryRun = null
  let independentCoordinator = null
  let releaseLateRouteProvider = null
  let lateRouteProviderSettled = false
  const diagnosticFsApi = new Proxy(fs.promises, {
    get (target, property) {
      if (property === 'appendFile') return async (...args) => {
        if (failDiagnosticWrites) throw new Error('synthetic diagnostic write failure marker')
        return target.appendFile(...args)
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  const diagnosticStore = new AgentRunDiagnostics({
    directory: diagnosticDirectory,
    appVersion: '0.1.0',
    fsApi: diagnosticFsApi,
    onAvailabilityChanged: (status) => { if (summaryRun) void summaryRun.setDiagnosticsAvailability(status.available) }
  })
  await diagnosticStore.initialization
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
      async run ({ recipe, signal, onProgress }) {
        if (recipe.recipeId !== 'intent.route') throw new Error('unexpected target execution in acceptance journey')
        routeCalls += 1
        await onProgress?.({
          type: 'request_started',
          turn: 1,
          providerEvent: PRIVACY_MARKERS.providerEvent,
          toolArguments: PRIVACY_MARKERS.toolArguments,
          toolResult: PRIVACY_MARKERS.toolResult,
          exceptionMessage: PRIVACY_MARKERS.exceptionMessage
        })
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
        if (routeBehavior === 'ignore-abort') {
          return new Promise((resolve, reject) => {
            releaseLateRouteProvider = {
              resolve: (value) => { lateRouteProviderSettled = true; resolve(value) },
              reject: (error) => { lateRouteProviderSettled = true; reject(error) }
            }
          })
        }
        await onProgress?.({ type: 'response_received', turn: 1, providerResponse: PRIVACY_MARKERS.providerResponse })
        return {
          text: JSON.stringify({ recipeId: 'qa.answer', confidence: 0.95 }),
          usage: null,
          providerResponse: PRIVACY_MARKERS.providerResponse
        }
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
    text: PRIVACY_MARKERS.transcript,
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
  let preloadBridge = null
  summaryRun = new SessionSummaryRunService({
    storage: requestStorage,
    runService: requestRunService,
    routeOrchestrator,
    getConfig: () => config.get(),
    defer: (callback) => dispatchQueue.push(callback),
    diagnostics: diagnosticStore,
    showDiagnosticSaveDialog: async (_ownerWindow, options) => {
      diagnosticSaveDialogCalls += 1
      assert.equal(options.title, '导出 Agent 运行诊断')
      if (cancelDiagnosticSave) return { canceled: true }
      return { canceled: false, filePath: diagnosticExportPath }
    },
    getOwnerWindow: (sender) => sender,
    onChanged: (event) => preloadBridge?.emit(CHANNELS.SESSION_SUMMARY_RUN_CHANGED, event)
  })
  const handlers = new Map()
  registerSessionSummaryRunIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    authorize: (_event, channel) => {
      if (![CHANNELS.SESSION_SUMMARY_RUN_ACCEPT, CHANNELS.SESSION_SUMMARY_RUN_GET, CHANNELS.SESSION_SUMMARY_RUN_CANCEL,
        CHANNELS.SESSION_SUMMARY_RUN_RESUME, CHANNELS.SESSION_SUMMARY_RUN_LIST_RECOVERABLE,
        CHANNELS.SESSION_SUMMARY_RUN_DIAGNOSTICS_QUERY, CHANNELS.SESSION_SUMMARY_RUN_DIAGNOSTICS_EXPORT].includes(channel)) {
        throw new Error('unexpected summary IPC channel')
      }
    },
    service: {
      accept: (...args) => summaryRun.accept(...args),
      get: (...args) => summaryRun.get(...args),
      cancel: (...args) => summaryRun.cancel(...args),
      resume: (...args) => summaryRun.resume(...args),
      listRecoverable: (...args) => summaryRun.listRecoverable(...args),
      getDiagnostics: (...args) => summaryRun.getDiagnostics(...args),
      exportDiagnostics: (...args) => summaryRun.exportDiagnostics(...args)
    }
  })
  const ipcEvent = { sender: { id: 101 }, role: 'agent' }
  preloadBridge = createAgentPreloadApi(handlers, ipcEvent)
  const summaryApi = {
    accept: (request) => preloadBridge.api.acceptSessionSummaryRun(request),
    get: (request) => preloadBridge.api.getSessionSummaryRun(request),
    cancel: (request) => preloadBridge.api.cancelSessionSummaryRun(request),
    resume: (request) => preloadBridge.api.resumeSessionSummaryRun(request),
    listRecoverable: (request) => preloadBridge.api.listRecoverableSessionSummaryRuns(request),
    getDiagnostics: (request) => preloadBridge.api.getSessionSummaryRunDiagnostics(request),
    exportDiagnostics: (request) => preloadBridge.api.exportSessionSummaryRunDiagnostics(request)
  }
  t.after(async () => {
    await independentCoordinator?.dispose().catch(() => {})
    vault.close()
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(root, { recursive: true, force: true })
  })

  const summaryRequest = request('summary', 'j30.summary.key')
  const changedEvents = []
  const unsubscribeSummaryChanges = preloadBridge.api.onSessionSummaryRunChanged((event) => changedEvents.push(event))
  loseNextAcceptanceReply = true
  const unknownReceipt = await summaryApi.accept(summaryRequest)
  assert.equal(unknownReceipt.ok, false)
  assert.equal(routeCalls, 0)
  assert.equal(dispatchQueue.length, 0)
  const checksBeforeReplay = eligibilityCheckCount
  const sourceReadsBeforeReplay = frozenSourceReadCount
  failEligibility = true
  failFrozenSourceRead = true
  const summaryAccepted = await summaryApi.accept(summaryRequest)
  assert.ok(changedEvents.some((event) => event.request_id === summaryAccepted.result.snapshot.request_id))
  assert.equal(summaryAccepted.ok, true)
  assert.equal(summaryAccepted.result.snapshot.action, 'summary')
  assert.equal(summaryAccepted.result.snapshot.state, 'accepted')
  assert.equal(summaryAccepted.result.snapshot.freshness, 'fresh')
  assert.equal(routeCalls, 0)
  assert.equal(eligibilityCheckCount, checksBeforeReplay)
  assert.equal(frozenSourceReadCount, sourceReadsBeforeReplay)
  failEligibility = false
  failFrozenSourceRead = false
  const summaryReplay = await summaryApi.accept(summaryRequest)
  assert.equal(summaryReplay.ok, true)
  assert.equal(summaryReplay.result.replayed, true)
  assert.equal(summaryReplay.result.snapshot.request_id, summaryAccepted.result.snapshot.request_id)
  assert.equal(routeCalls, 0)
  assert.equal(dispatchQueue.length, 1)
  dispatchQueue.shift()()
  await waitFor(() => summaryRun.dispatches.size === 0, 'preset summary target persistence')
  const summarySnapshot = await summaryApi.get({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: summaryAccepted.result.snapshot.request_id
  })
  assert.equal(summarySnapshot.ok, true)
  assert.equal(summarySnapshot.result.snapshot.recipe_id, 'summary.minutes')
  assert.equal(summarySnapshot.result.snapshot.routing_mode, 'preset')
  assert.equal(summarySnapshot.result.snapshot.route_run_id, null)
  assert.equal(routeCalls, 0)

  const questionRequest = request('question', 'j30.question.key', `这场会决定了什么？ ${PRIVACY_MARKERS.prompt}`)
  const questionAccepted = await summaryApi.accept(questionRequest)
  assert.equal(questionAccepted.ok, true)
  assert.equal(routeCalls, 0)
  dispatchQueue.shift()()
  await waitFor(async () => {
    const current = await summaryApi.get({
      contract_id: contract.CONTRACT_ID,
      contract_version: contract.CONTRACT_VERSION,
      request_id: questionAccepted.result.snapshot.request_id
    })
    return current.ok && current.result.snapshot.target_run_id !== null
  }, 'question route target')
  const questionSnapshot = await summaryApi.get({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: questionAccepted.result.snapshot.request_id
  })
  assert.equal(questionSnapshot.result.snapshot.recipe_id, 'qa.answer')
  assert.equal(questionSnapshot.result.snapshot.routing_mode, 'model')
  assert.equal(routeCalls, 1)
  const questionReplay = await summaryApi.accept(questionRequest)
  assert.equal(questionReplay.ok, true)
  assert.equal(questionReplay.result.replayed, true)
  assert.equal(questionReplay.result.snapshot.target_run_id, questionSnapshot.result.snapshot.target_run_id)
  assert.equal(dispatchQueue.length, 1)
  dispatchQueue.shift()()
  await waitFor(() => summaryRun.dispatches.size === 0, 'idempotent question route replay')
  assert.equal(routeCalls, 1)

  routeBehavior = 'wait'
  const uncertainCancelRequest = request('question', 'j30.question.cancel.storage-failure', '取消状态存储失败后可重试')
  const uncertainCancelAccepted = await summaryApi.accept(uncertainCancelRequest)
  assert.equal(uncertainCancelAccepted.ok, true)
  dispatchQueue.shift()()
  await waitFor(() => routeCalls === 2, 'question route before cancellation persistence failure')
  const waitingRoute = await summaryApi.get({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: uncertainCancelAccepted.result.snapshot.request_id
  })
  assert.equal(waitingRoute.result.snapshot.state, 'routing')
  assert.equal(waitingRoute.result.snapshot.phase, 'waiting_model')
  assert.equal(waitingRoute.result.snapshot.memory_state, 'not_read')
  assert.equal(waitingRoute.result.snapshot.last_activity_age_ms !== null, true)
  failNextCancelWrite = true
  const cancelNotConfirmed = await summaryApi.cancel({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: uncertainCancelAccepted.result.snapshot.request_id,
    generation: uncertainCancelAccepted.result.snapshot.generation
  })
  assert.equal(cancelNotConfirmed.ok, false)
  assert.equal(cancelNotConfirmed.error.next_action, 'verify_state')
  await waitFor(() => summaryRun.dispatches.size === 0, 'route local abort after cancellation persistence failure')
  const cancelUncertainSnapshot = await summaryApi.get({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: uncertainCancelAccepted.result.snapshot.request_id
  })
  assert.equal(cancelUncertainSnapshot.ok, true)
  assert.notEqual(cancelUncertainSnapshot.result.snapshot.state, 'failed')
  assert.notEqual(cancelUncertainSnapshot.result.snapshot.state, 'cancelled')
  const retriedCancellation = await summaryApi.cancel({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: uncertainCancelAccepted.result.snapshot.request_id,
    generation: uncertainCancelAccepted.result.snapshot.generation
  })
  assert.equal(retriedCancellation.ok, true)
  assert.equal(retriedCancellation.result.snapshot.state, 'cancelled')

  const cancelledRequest = request('question', 'j30.question.cancel', '这个请求应在路由时取消')
  const cancelledAccepted = await summaryApi.accept(cancelledRequest)
  assert.equal(cancelledAccepted.ok, true)
  dispatchQueue.shift()()
  await waitFor(() => routeCalls === 3, 'in-flight question route')
  const cancelled = await summaryApi.cancel({
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

  const restartTarget = await summaryApi.accept(request('summary', 'j30.summary.restart-target'))
  assert.equal(restartTarget.ok, true)
  assert.equal(dispatchQueue.length, 1)
  dispatchQueue.shift()()
  await waitFor(() => summaryRun.dispatches.size === 0, 'summary target before process restart')
  const targetBeforeRestart = await summaryApi.get({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: restartTarget.result.snapshot.request_id
  })
  const targetRunId = targetBeforeRestart.result.snapshot.target_run_id
  assert.equal(typeof targetRunId, 'string')

  const restartPending = await summaryApi.accept(request('summary', 'j30.summary.restart-pending'))
  assert.equal(restartPending.ok, true)
  assert.equal(dispatchQueue.length, 1)
  const wakeReasons = []
  const restartedPromptStore = new Map()
  summaryRun = new SessionSummaryRunService({
    storage: requestStorage,
    runService: requestRunService,
    routeOrchestrator,
    scheduler: { wake: (reason) => wakeReasons.push(reason) },
    getConfig: () => config.get(),
    promptStore: restartedPromptStore,
    diagnostics: diagnosticStore,
    showDiagnosticSaveDialog: async (_ownerWindow, options) => {
      diagnosticSaveDialogCalls += 1
      assert.equal(options.title, '导出 Agent 运行诊断')
      if (cancelDiagnosticSave) return { canceled: true }
      return { canceled: false, filePath: diagnosticExportPath }
    },
    getOwnerWindow: (sender) => sender,
    defer: (callback) => dispatchQueue.push(callback),
    onChanged: (event) => preloadBridge?.emit(CHANNELS.SESSION_SUMMARY_RUN_CHANGED, event)
  })
  const reconciled = await summaryRun.recoverAfterRestart()
  assert.equal(reconciled > 0, true)
  const restartSnapshot = await summaryApi.get({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: restartTarget.result.snapshot.request_id
  })
  assert.equal(restartSnapshot.result.snapshot.state, 'retry_wait')
  assert.equal(restartSnapshot.result.snapshot.resume_required, true)
  assert.equal(restartSnapshot.result.snapshot.target_run_id, targetRunId)
  assert.equal(restartedPromptStore.get(targetRunId), SUMMARY_PROMPT)
  dispatchQueue.shift()()
  await waitFor(() => summaryRun.dispatches.size === 0, 'stale deferred dispatch blocked by restart recovery')
  assert.equal(routeCalls, 3)

  const recoverable = await summaryApi.listRecoverable({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION
  })
  assert.equal(recoverable.ok, true)
  const recoverableTarget = recoverable.result.requests.find((item) => item.snapshot.request_id === restartTarget.result.snapshot.request_id)
  assert.equal(recoverableTarget.scope.reference, SCOPE.reference)
  assert.equal(recoverableTarget.snapshot.resume_required, true)
  const resumed = await summaryApi.resume({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: recoverableTarget.snapshot.request_id,
    generation: recoverableTarget.snapshot.generation,
    expected_revision: recoverableTarget.snapshot.revision
  })
  assert.equal(resumed.ok, true)
  assert.equal(resumed.result.snapshot.generation, recoverableTarget.snapshot.generation + 1)
  assert.equal(resumed.result.snapshot.target_run_id, targetRunId)
  assert.deepEqual(wakeReasons, ['resume'])
  const preparedRun = database.prepare('SELECT run_id,state,attempt_count,resume_required FROM formal_agent_runs WHERE run_id=?').get(targetRunId)
  assert.deepEqual({ ...preparedRun }, {
    run_id: targetRunId, state: 'retry_wait', attempt_count: 0, resume_required: 0
  })
  const claimed = await gateway.claimNextFormalAgentRun({
    claimIdempotencyKey: 'j30.recovery.claim',
    leaseMs: 60000,
    owner: 'worker.j30.recovery',
    requestedBy: 'user'
  })
  assert.equal(claimed.runId, targetRunId)
  assert.equal(claimed.attemptIdentity.attempt, 1)
  assert.deepEqual({ ...database.prepare('SELECT state,attempt_count FROM formal_agent_runs WHERE run_id=?').get(targetRunId) }, {
    state: 'running', attempt_count: 1
  })

  const lostQuestionAccepted = await summaryApi.accept(request('question', 'j30.question.lost-before-resubmit', '原问题正文不应持久化'))
  assert.equal(lostQuestionAccepted.ok, true)
  const lostQuestionId = lostQuestionAccepted.result.snapshot.request_id
  summaryRun = new SessionSummaryRunService({
    storage: requestStorage,
    runService: requestRunService,
    routeOrchestrator,
    scheduler: { wake: () => {} },
    getConfig: () => config.get(),
    promptStore: new Map(),
    diagnostics: diagnosticStore,
    showDiagnosticSaveDialog: async (_ownerWindow, options) => {
      diagnosticSaveDialogCalls += 1
      assert.equal(options.title, '导出 Agent 运行诊断')
      if (cancelDiagnosticSave) return { canceled: true }
      return { canceled: false, filePath: diagnosticExportPath }
    },
    getOwnerWindow: (sender) => sender,
    defer: (callback) => dispatchQueue.push(callback),
    onChanged: (event) => preloadBridge?.emit(CHANNELS.SESSION_SUMMARY_RUN_CHANGED, event)
  })
  await summaryRun.recoverAfterRestart()
  const lostQuestion = await summaryApi.get({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: lostQuestionId
  })
  assert.equal(lostQuestion.result.snapshot.state, 'failed')
  assert.equal(lostQuestion.result.snapshot.resume_required, true)
  const lostQuestionList = await summaryApi.listRecoverable({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION
  })
  assert.equal(lostQuestionList.result.requests.some((item) => item.snapshot.request_id === lostQuestionId), true)

  const resubmissionRequest = {
    ...request('question', 'j30.question.resubmitted', '重新提交后的问题'),
    resubmits_request_id: lostQuestionId
  }
  loseNextAcceptanceReply = true
  const uncertainResubmission = await summaryApi.accept(resubmissionRequest)
  assert.equal(uncertainResubmission.ok, false)
  const resubmittedQuestion = await summaryApi.accept(resubmissionRequest)
  assert.equal(resubmittedQuestion.ok, true)
  assert.equal(resubmittedQuestion.result.replayed, true)
  assert.notEqual(resubmittedQuestion.result.snapshot.request_id, lostQuestionId)
  const acknowledgedQuestion = await gateway.getSessionSummaryRequest({ requestId: lostQuestionId })
  assert.equal(acknowledgedQuestion.state, 'failed')
  assert.equal(acknowledgedQuestion.errorCode, 'AGENT_REQUEST_INVALID')
  assert.equal(acknowledgedQuestion.resumeRequired, false)
  const afterResubmissionList = await summaryApi.listRecoverable({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION
  })
  assert.equal(afterResubmissionList.result.requests.some((item) => item.snapshot.request_id === lostQuestionId), false)

  /* Drain the durable resubmission route before enabling diagnostic failure so
     the next non-cooperative request is the only live provider call. */
  routeBehavior = 'qa'
  while (dispatchQueue.length > 0) dispatchQueue.shift()()
  await waitFor(() => summaryRun.dispatches.size === 0, 'resubmitted question route before diagnostic failure')

  const requestRows = database.prepare('SELECT action,prompt_digest,summary_use_memory FROM formal_agent_requests ORDER BY request_id').all()
  assert.equal(requestRows.length, 8)
  assert.equal(JSON.stringify(requestRows).includes(PRIVACY_MARKERS.transcript), false)
  assert.equal(JSON.stringify(requestRows).includes(PRIVACY_MARKERS.prompt), false)
  assert.equal(JSON.stringify(requestRows).includes('这个请求应在路由时取消'), false)
  assert.equal(JSON.stringify(requestRows).includes('原问题正文不应持久化'), false)
  assert.equal(JSON.stringify(requestRows).includes('重新提交后的问题'), false)
  assert.equal(await diagnosticStore.drain(), true)
  const diagnosticFiles = fs.readdirSync(diagnosticDirectory).filter((name) => name.endsWith('.jsonl')).sort()
  const diagnosticRecords = diagnosticFiles.flatMap((name) => fs.readFileSync(path.join(diagnosticDirectory, name), 'utf8')
    .split('\n').filter(Boolean).map((line) => assertDiagnosticRecord(JSON.parse(line))))
  const diagnosticBytes = JSON.stringify(diagnosticRecords)
  for (const event of ['accepted', 'planning', 'cancel_requested', 'cancelled', 'recovery']) {
    assert.equal(diagnosticRecords.some((record) => record.event === event), true, `diagnostic event ${event}`)
  }
  for (const marker of [
    'J30 合成会话正文 marker', '这个请求应在路由时取消', '原问题正文不应持久化',
    '重新提交后的问题', 'j30-provider-secret', root,
    ...Object.values(PRIVACY_MARKERS)
  ]) assert.equal(diagnosticBytes.includes(marker), false)
  const evidenceBytes = Buffer.concat(validationJsonFiles().map((file) => fs.readFileSync(file))).toString('utf8')
  for (const marker of Object.values(PRIVACY_MARKERS)) assert.equal(evidenceBytes.includes(marker), false)
  const diagnosticsRequest = {
    contract_id: diagnosticsUI.CONTRACT_ID,
    contract_version: diagnosticsUI.CONTRACT_VERSION,
    request_id: questionAccepted.result.snapshot.request_id,
    before_sequence: null,
    limit: 50
  }
  const diagnosticsPage = await summaryApi.getDiagnostics(diagnosticsRequest)
  assert.equal(diagnosticsUI.assertQueryResponse(diagnosticsPage).ok, true)
  assert.equal(diagnosticsPage.result.records.some((record) => record.event === 'accepted'), true)
  const diagnosticsRow = await gateway.getSessionSummaryRequest({ requestId: questionAccepted.result.snapshot.request_id })
  assert.match(diagnosticsRow.requestDigest, /^[a-f0-9]{64}$/)
  assert.equal((await diagnosticStore.recordsForRequestDigest(diagnosticsRow.requestDigest)).records.length > 0, true)
  assert.equal(typeof summaryRun.diagnostics.exportRequest, 'function')
  assert.equal(typeof summaryRun.showDiagnosticSaveDialog, 'function')
  const exportedDiagnostics = await summaryApi.exportDiagnostics({
    contract_id: diagnosticsUI.CONTRACT_ID,
    contract_version: diagnosticsUI.CONTRACT_VERSION,
    request_id: questionAccepted.result.snapshot.request_id
  })
  assert.equal(exportedDiagnostics.ok, true, JSON.stringify({ response: exportedDiagnostics, diagnosticSaveDialogCalls, status: diagnosticStore.getStatus() }))
  assert.equal(diagnosticsUI.assertExportResponse(exportedDiagnostics).result.status, 'saved')
  assert.ok(exportedDiagnostics.result.record_count > 0)
  assert.equal(exportedDiagnostics.result.available, true)
  assert.equal(JSON.stringify(exportedDiagnostics).includes(root), false)
  const exportBytes = fs.readFileSync(diagnosticExportPath, 'utf8')
  const exportSnapshot = assertDiagnosticExportSnapshot(JSON.parse(exportBytes))
  assert.ok(exportSnapshot.records.length > 0)
  for (const marker of [
    'J30 合成会话正文 marker', '这个请求应在路由时取消', '原问题正文不应持久化',
    '重新提交后的问题', 'j30-provider-secret', root, ...Object.values(PRIVACY_MARKERS)
  ]) {
    assert.equal(exportBytes.includes(marker), false)
  }
  const priorExportBytes = fs.readFileSync(diagnosticExportPath)
  cancelDiagnosticSave = true
  const cancelledDiagnosticsExport = await summaryApi.exportDiagnostics({
    contract_id: diagnosticsUI.CONTRACT_ID,
    contract_version: diagnosticsUI.CONTRACT_VERSION,
    request_id: summaryAccepted.result.snapshot.request_id
  })
  assert.deepEqual(cancelledDiagnosticsExport.result, { status: 'cancelled', record_count: 0, available: true })
  assert.deepEqual(fs.readFileSync(diagnosticExportPath), priorExportBytes, 'cancelled dialog must not write or replace the export')
  cancelDiagnosticSave = false

  const diagnosticFilesBeforeFailure = diagnosticFileSnapshot(diagnosticDirectory)
  const diagnosticsExportBeforeFailure = fs.readFileSync(diagnosticExportPath)
  const diagnosticsFailureRequest = request('summary', 'j30.summary.diagnostics-write-failure')
  failDiagnosticWrites = true
  const diagnosticsFailureAccepted = await summaryApi.accept(diagnosticsFailureRequest)
  assert.equal(diagnosticsFailureAccepted.ok, true)
  const eventCountBeforeDiagnosticFailure = changedEvents.length
  await waitFor(() => diagnosticStore.getStatus().available === false, 'diagnostic write failure status')
  await waitFor(async () => {
    const current = await summaryApi.get({
      contract_id: contract.CONTRACT_ID,
      contract_version: contract.CONTRACT_VERSION,
      request_id: diagnosticsFailureAccepted.result.snapshot.request_id
    })
    return current.ok && current.result.snapshot.diagnostics_available === false &&
      changedEvents.slice(eventCountBeforeDiagnosticFailure).some((event) =>
        event.request_id === diagnosticsFailureAccepted.result.snapshot.request_id &&
        event.revision > diagnosticsFailureAccepted.result.snapshot.revision
      )
  }, 'diagnostic failure snapshot and change event')
  const diagnosticsFailureSnapshot = await summaryApi.get({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: diagnosticsFailureAccepted.result.snapshot.request_id
  })
  assert.equal(diagnosticsFailureSnapshot.result.snapshot.diagnostics_available, false)
  assert.equal(diagnosticsFailureSnapshot.result.snapshot.state, 'accepted')
  assert.ok(changedEvents.slice(eventCountBeforeDiagnosticFailure).some((event) =>
    event.request_id === diagnosticsFailureAccepted.result.snapshot.request_id &&
    event.revision > diagnosticsFailureAccepted.result.snapshot.revision
  ))
  const diagnosticsFailureCancelled = await summaryApi.cancel({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: diagnosticsFailureAccepted.result.snapshot.request_id,
    generation: diagnosticsFailureAccepted.result.snapshot.generation
  })
  assert.equal(diagnosticsFailureCancelled.ok, true)
  assert.equal(diagnosticsFailureCancelled.result.snapshot.state, 'cancelled')

  /* Cancellation leaves the already-deferred acceptance callback in the test
     queue. Run it while the provider is cooperative so it observes the
     cancelled request before the non-cooperative scenario is queued. */
  routeBehavior = 'qa'
  while (dispatchQueue.length > 0) dispatchQueue.shift()()
  await waitFor(() => summaryRun.dispatches.size === 0, 'cancelled diagnostic-failure route')

  routeBehavior = 'ignore-abort'
  const routeCallsBeforeNonCooperativeProvider = routeCalls
  const nonCooperativeAccepted = await summaryApi.accept(request(
    'question', 'j30.question.non-cooperative-cancel', `取消期间 provider 保持未结算。${PRIVACY_MARKERS.prompt}`
  ))
  assert.equal(nonCooperativeAccepted.ok, true)
  dispatchQueue.shift()()
  await waitFor(() => routeCalls === routeCallsBeforeNonCooperativeProvider + 1, 'non-cooperative provider request')
  assert.equal(typeof releaseLateRouteProvider?.reject, 'function')
  const nonCooperativeCancelled = await summaryApi.cancel({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: nonCooperativeAccepted.result.snapshot.request_id,
    generation: nonCooperativeAccepted.result.snapshot.generation
  })
  assert.equal(nonCooperativeCancelled.ok, true)
  assert.equal(nonCooperativeCancelled.result.snapshot.state, 'cancelled')
  await waitFor(() => summaryRun.dispatches.size === 0, 'cancelled non-cooperative provider request')
  assert.equal(lateRouteProviderSettled, false, 'cancellation must return before the provider settles')
  const nonCooperativeRow = await gateway.getSessionSummaryRequest({ requestId: nonCooperativeAccepted.result.snapshot.request_id })
  assert.equal(nonCooperativeRow.state, 'cancelled')
  assert.equal(nonCooperativeRow.targetRunId, null)
  const unavailableDiagnostics = await summaryApi.getDiagnostics({
    contract_id: diagnosticsUI.CONTRACT_ID,
    contract_version: diagnosticsUI.CONTRACT_VERSION,
    request_id: nonCooperativeAccepted.result.snapshot.request_id,
    before_sequence: null,
    limit: 50
  })
  assert.equal(diagnosticsUI.assertQueryResponse(unavailableDiagnostics).result.available, false)
  assert.deepEqual(unavailableDiagnostics.result.records, [])

  const independentSessionId = 'session.summary.diagnostics.failure.independent'
  const subtitleAdapter = new FakeRuntimeAdapter({ autoEmit: false })
  independentCoordinator = new SessionCoordinator({
    adapter: subtitleAdapter,
    persistenceSink: recorder,
    runtimeOptions: resolveRuntimeOptions({ LIVE_SUBTITLE_DEV_MODEL: DEV_MODEL_VALUE }),
    configuration: {
      onboardingCompleted: true,
      onboardingPreset: 'dictation',
      mic: true,
      loopback: false,
      refinementEnabled: false
    },
    idFactory: () => independentSessionId
  })
  assert.equal((await independentCoordinator.command('start')).ok, true)
  assert.equal(independentCoordinator.getSnapshot().sessionId, independentSessionId)
  subtitleAdapter.emitCaption({
    schemaVersion: 1,
    sessionId: independentSessionId,
    sourceId: 'mic',
    segmentId: 'segment.summary.diagnostics.failure.independent',
    sequence: 1,
    revision: 1,
    kind: 'final',
    t0: 0,
    t1: 10,
    text: PRIVACY_MARKERS.transcript,
    translation: null
  })
  assert.equal((await independentCoordinator.command('stop')).ok, true)
  const historyExportPath = path.join(root, 'selected-transcript.txt')
  const historyDialogOwners = []
  const history = new HistoryService({
    gateway,
    showSaveDialog: async (owner, options) => {
      historyDialogOwners.push(owner)
      assert.equal(options.title, '导出字幕原文')
      return { canceled: false, filePath: historyExportPath }
    }
  })
  const historyWindow = { role: 'history-window' }
  const historySessions = await history.listSessions({ limit: 100, cursor: null })
  assert.equal(historySessions.items.some((item) => item.sessionId === independentSessionId), true)
  const independentPage = await history.getSessionPage({ sessionId: independentSessionId, limit: 50, cursor: null })
  assert.equal(independentPage.items.length, 1)
  assert.equal(independentPage.items[0].text, PRIVACY_MARKERS.transcript)
  const historyExport = await history.exportSession({ sessionId: independentSessionId, format: 'txt' }, historyWindow)
  assert.deepEqual(historyExport, { status: 'saved', format: 'txt', version: 'original' })
  assert.deepEqual(historyDialogOwners, [historyWindow])
  assert.equal(JSON.stringify(historyExport).includes(historyExportPath), false)
  assert.equal(fs.readFileSync(historyExportPath, 'utf8').includes(PRIVACY_MARKERS.transcript), true)
  assert.deepEqual(audioFilesUnder(root), [])

  const lateException = Object.assign(new Error(PRIVACY_MARKERS.exceptionMessage), {
    code: 'AGENT_PROVIDER_UNAVAILABLE',
    providerResponse: PRIVACY_MARKERS.providerResponse,
    toolArguments: PRIVACY_MARKERS.toolArguments,
    toolResult: PRIVACY_MARKERS.toolResult
  })
  lateException.stack = `Error: ${PRIVACY_MARKERS.exceptionMessage}\n  ${PRIVACY_MARKERS.exceptionStack}\n  at synthetic provider boundary`
  releaseLateRouteProvider.reject(lateException)
  await tick()
  assert.equal(lateRouteProviderSettled, true)
  const stillCancelled = await gateway.getSessionSummaryRequest({ requestId: nonCooperativeAccepted.result.snapshot.request_id })
  assert.equal(stillCancelled.state, 'cancelled')
  assert.equal(stillCancelled.targetRunId, null)
  assert.deepEqual(diagnosticFileSnapshot(diagnosticDirectory), diagnosticFilesBeforeFailure)
  assert.deepEqual(fs.readFileSync(diagnosticExportPath), diagnosticsExportBeforeFailure)
  const persistedDiagnosticText = diagnosticFileSnapshot(diagnosticDirectory)
    .map(([, bytes]) => bytes.toString('utf8')).join('\n')
  for (const marker of [...Object.values(PRIVACY_MARKERS), root]) assert.equal(persistedDiagnosticText.includes(marker), false)
  for (const marker of Object.values(PRIVACY_MARKERS)) {
    assert.equal(fs.readFileSync(diagnosticExportPath, 'utf8').includes(marker), false)
  }
  const failedDiagnosticFiles = fs.readdirSync(diagnosticDirectory).filter((name) => name.endsWith('.jsonl'))
  assert.equal(failedDiagnosticFiles.some((name) => fs.readFileSync(path.join(diagnosticDirectory, name), 'utf8')
    .includes('synthetic diagnostic write failure marker')), false)
  assert.equal(summaryRun.dispatches.size, 0)
  unsubscribeSummaryChanges()
})
