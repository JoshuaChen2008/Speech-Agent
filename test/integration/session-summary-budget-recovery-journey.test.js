'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const { AgentRunService } = require('../../src/agent/formal-run/agent-run-service')
const { SessionSummaryRunService } = require('../../src/agent/formal-run/session-summary-run-service')
const { CredentialVault } = require('../../src/agent/model-access/credential-vault')
const { ModelAccessRuntime } = require('../../src/agent/model-access/runtime')
const { OpenAiCompatibleAdapter } = require('../../src/agent/model-access/openai-compatible-adapter')
const { createPersonalContextExecutionAdapter } = require('../../src/agent/personal-context')
const {
  AgentLoopExecutor,
  FormalAgentJobScheduler,
  FormalAgentRunRunner,
  IntentRouteOrchestrator
} = require('../../src/agent/execution-host')
const { ConfigStore } = require('../../src/main/services/config-store')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { AgentRunDiagnostics } = require('../../src/main/services/agent-run-diagnostics')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')
const { CONTROL_MESSAGES, OPERATIONS, PROTOCOL_VERSION, StorageError, makeCaptionEventId, makeCloseSessionKey, makeOpenSessionKey } = require('../../src/runtime/storage-worker/protocol')
const summaryContract = require('../../src/agent/contracts/session-summary-run-ui')
const { assertDiagnosticRecord, assertDiagnosticExportSnapshot } = require('../../src/agent/contracts/agent-run-diagnostics')

const CAPABILITIES = Object.freeze({
  maxInputTokens: 64000,
  maxOutputTokens: 4096,
  supportsToolCalling: true,
  supportsStructuredOutput: true,
  supportsStreaming: true,
  usageReporting: false
})
const DIAGNOSTIC_PRIVACY_MARKERS = Object.freeze({
  exceptionMessage: 'J30_PRIVACY_PROVIDER_EXCEPTION_MESSAGE_4_4',
  exceptionStack: 'J30_PRIVACY_PROVIDER_EXCEPTION_STACK_4_4',
  providerResponse: 'J30_PRIVACY_PROVIDER_EXCEPTION_RESPONSE_4_4',
  toolArguments: 'J30_PRIVACY_PROVIDER_EXCEPTION_TOOL_ARGUMENTS_4_4',
  toolResult: 'J30_PRIVACY_PROVIDER_EXCEPTION_TOOL_RESULT_4_4'
})

function serviceBackedHost (service, databasePath, onRenew) {
  let sequence = 0
  const call = async (operation, payload, idempotencyKey) => {
    const response = await service.handle({
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId: `j30-budget.${++sequence}`,
      operation,
      payload,
      ...(idempotencyKey ? { idempotencyKey } : {})
    })
    if (!response.ok) throw new StorageError(response.error.code)
    return response.result
  }
  return {
    state: 'stopped',
    async start () { await call(OPERATIONS.INITIALIZE, { databasePath }); this.state = 'ready' },
    async openSession (value) { return call(OPERATIONS.OPEN_SESSION, value, makeOpenSessionKey(value.sessionId)) },
    async appendCaption (event) { return call(OPERATIONS.APPEND_CAPTION, { event }, makeCaptionEventId(event)) },
    async closeSession (value) { return call(OPERATIONS.CLOSE_SESSION, value, makeCloseSessionKey(value.sessionId)) },
    async getSessionTranscript (sessionId) { return call(OPERATIONS.GET_SESSION, { sessionId }) },
    async listSessions (request) { return call(OPERATIONS.LIST_SESSIONS, request) },
    async derivePersonalContextSessionSource (request) { return call(OPERATIONS.PERSONAL_CONTEXT_DERIVE_SESSION_SOURCE, { request }) },
    async readPersonalContextSessionInput (source) { return call(OPERATIONS.PERSONAL_CONTEXT_READ_SESSION_INPUT, { source }) },
    async readPersonalContextToolContext (request) { return call(OPERATIONS.PERSONAL_CONTEXT_READ_TOOL_CONTEXT, { request }) },
    async claimNextFormalAgentRun (request) { return call(OPERATIONS.FORMAL_AGENT_CLAIM_RUN, { request }) },
    async renewFormalAgentRun (request) {
      const response = await service.handleLeaseRenewalControl({
        version: PROTOCOL_VERSION,
        type: CONTROL_MESSAGES.RENEW_FORMAL_AGENT_RUN_LEASE,
        requestId: `j30-budget.${++sequence}`,
        request
      })
      if (!response.ok) throw new StorageError(response.error.code)
      onRenew?.(response.result)
      return response.result
    },
    async reserveFormalAgentModelRequest (request) { return call(OPERATIONS.FORMAL_AGENT_RESERVE_MODEL_REQUEST, { request }) },
    async nextFormalAgentRunAt (request) { return call(OPERATIONS.FORMAL_AGENT_NEXT_RUN_AT, request) },
    async failFormalAgentRun (request) { return call(OPERATIONS.FORMAL_AGENT_FAIL_RUN, { request }) },
    async createAgentRun (request) { return call(OPERATIONS.AGENT_CREATE_RUN, { request }) },
    async cancelAgentRun (request) { return call(OPERATIONS.AGENT_CANCEL_RUN, { request }) },
    async createAgentInteraction (request) { return call(OPERATIONS.AGENT_CREATE_INTERACTION, { request }) },
    async terminalizeAgentInteraction (request) { return call(OPERATIONS.AGENT_TERMINALIZE_INTERACTION, { request }) },
    async startAgentToolCall (request) { return call(OPERATIONS.AGENT_START_TOOL_CALL, { request }) },
    async finishAgentToolCall (request) { return call(OPERATIONS.AGENT_FINISH_TOOL_CALL, { request }) },
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
    async shutdown () { if (!service.shuttingDown) await call(OPERATIONS.SHUTDOWN, {}); this.state = 'closed' },
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return
    await tick()
  }
  throw new Error(`timed out waiting for ${description}`)
}

async function readDiagnosticRecords (directory) {
  const names = (await fs.promises.readdir(directory)).filter((name) => /^agent-run-diagnostics-\d{12}\.jsonl$/.test(name)).sort()
  const records = []
  for (const name of names) {
    const contents = await fs.promises.readFile(path.join(directory, name), 'utf8')
    for (const line of contents.split('\n')) {
      if (!line) continue
      const record = assertDiagnosticRecord(JSON.parse(line))
      records.push(record)
    }
  }
  return records
}

function createExecutionSystem ({ gateway, modelAccess, config, promptStore, owner, onJob, leaseRenewEveryMs, diagnosticStore }) {
  let summaryRuns = null
  const trace = []
  let firstJob = null
  let firstJobSettled = null
  let secondJobSettled = null
  const diagnostics = []
  const runner = new FormalAgentRunRunner({
    storage: gateway,
    personalContext: createPersonalContextExecutionAdapter({ storage: gateway }),
    modelAccess,
    promptProvider: (runId) => promptStore.get(runId) || null,
    onProgress: (event, signal) => { trace.push(`progress:${event.phase}`); return summaryRuns?.recordProgress(event, signal) },
    onChanged: (event) => { void summaryRuns?.notifyRunChanged(event) },
    interactions: {
      terminalize: (request, signal) => gateway.terminalizeAgentInteraction(request, signal),
      startToolCall: (request, signal) => gateway.startAgentToolCall(request, signal),
      finishToolCall: (request, signal) => gateway.finishAgentToolCall(request, signal)
    },
    loopFactory: (binding) => new AgentLoopExecutor({ adapter: modelAccess.createLoopAdapter(binding) })
  })
  const scheduler = new FormalAgentJobScheduler({
    owner,
    requestedBy: 'user',
    leaseMs: 30000,
    ...(leaseRenewEveryMs === undefined ? {} : { leaseRenewEveryMs }),
    storage: gateway,
    onDiagnostic: (value) => diagnostics.push(value),
    runner: {
      run: async (job) => {
        onJob?.(job)
        const pending = runner.run(job)
        if (job.attemptIdentity.attempt === 1) {
          firstJob = job
          firstJobSettled = pending
        } else if (job.attemptIdentity.attempt === 2) {
          secondJobSettled = pending
        }
        return pending
      }
    }
  })
  const runs = new AgentRunService({
    storage: gateway,
    modelAccess,
    scheduler,
    getConfig: () => config.get()
  })
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
    allowedTargetRecipes: ['summary.minutes']
  })
  summaryRuns = new SessionSummaryRunService({
    storage: gateway,
    runService: runs,
    routeOrchestrator,
    scheduler,
    getConfig: () => config.get(),
    promptStore,
    diagnostics: diagnosticStore
  })
  return {
    scheduler,
    summaryRuns,
    getFirstJob: () => firstJob,
    getFirstJobSettled: () => firstJobSettled,
    getSecondJobSettled: () => secondJobSettled,
    getDiagnostics: () => diagnostics,
    getTrace: () => trace
  }
}

test('SEM-F38/SEM-T04/J30-RECOVERY: scheduler, reservation, SQLite restart, and explicit continuation share one budget', { timeout: 90000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-summary-budget-j30-'))
  const databasePath = path.join(root, 'speech-agent.sqlite3')
  const configPath = path.join(root, 'config.json')
  const vaultPath = path.join(root, 'vault')
  const diagnosticDirectory = path.join(root, 'logs', 'agent-run-diagnostics')
  let diagnosticStore = new AgentRunDiagnostics({ directory: diagnosticDirectory, appVersion: '0.1.0' })
  await diagnosticStore.initialization
  const config = new ConfigStore(configPath, { now: () => 1770000000000 })
  config.load()
  config.updateAgentSettings({
    expectedRevision: config.get().agentSettingsRevision,
    agentEnabled: true,
    memoryEnabled: false,
    cloudDisclosureAccepted: false
  })

  let service = new StorageWorkerService()
  const renewalResults = []
  let gateway = new StorageGateway({ databasePath, hostFactory: () => serviceBackedHost(service, databasePath, (result) => renewalResults.push(result)), maxRestarts: 0 })
  let activeVault = createVault(vaultPath)
  t.after(async () => {
    if (activeVault) activeVault.close()
    if (gateway) await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(root, { recursive: true, force: true })
  })
  const egress = []
  let runBeingExecuted = null
  let providerAttempt = 0
  let rejectWithPrivacyMarkers = false
  let resolvePrivacyFailureEgress
  const privacyFailureEgress = new Promise((resolve) => { resolvePrivacyFailureEgress = resolve })
  let resolveFirstEgress
  const firstEgress = new Promise((resolve) => { resolveFirstEgress = resolve })
  let resolveSecondEgress
  const secondEgress = new Promise((resolve) => { resolveSecondEgress = resolve })
  const output = { schemaVersion: 1, overview: '合成会话总结', conclusions: [], todos: [], risks: [] }
  const adapter = new OpenAiCompatibleAdapter({
    fetch: async (_url, options) => {
      const database = service.requireStore().database
      const reservation = database.prepare(`
        SELECT reservation_id FROM formal_agent_model_request_reservations
        WHERE run_id=? AND attempt=? AND request_sequence=1
      `).get(runBeingExecuted.runId, providerAttempt)
      assert.ok(reservation, 'model request reservation is durable before provider egress')
      egress.push({ attempt: providerAttempt, reservationPresent: true })
      if (rejectWithPrivacyMarkers) {
        resolvePrivacyFailureEgress({ runId: runBeingExecuted.runId, attempt: providerAttempt, reservationPresent: true })
        const error = Object.assign(new Error(DIAGNOSTIC_PRIVACY_MARKERS.exceptionMessage), {
          code: 'AGENT_PERMISSION_DENIED',
          providerResponse: DIAGNOSTIC_PRIVACY_MARKERS.providerResponse,
          toolArguments: DIAGNOSTIC_PRIVACY_MARKERS.toolArguments,
          toolResult: DIAGNOSTIC_PRIVACY_MARKERS.toolResult
        })
        error.stack = `Error: ${DIAGNOSTIC_PRIVACY_MARKERS.exceptionMessage}\n  ${DIAGNOSTIC_PRIVACY_MARKERS.exceptionStack}`
        throw error
      }
      if (providerAttempt === 1) {
        resolveFirstEgress()
        return new Promise(() => {})
      }
      resolveSecondEgress()
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] })
      }
    }
  })
  const configureModel = async (modelAccess) => {
    const commands = [
      { type: 'createProfile', profileId: 'summary-provider', label: 'Summary Test Provider', httpsOrigin: 'https://provider.test', basePath: '/v1' },
      { type: 'addModel', profileId: 'summary-provider', modelId: 'summary-test-model', capabilities: CAPABILITIES },
      { type: 'setCredential', profileId: 'summary-provider', credential: 'synthetic-provider-credential' },
      { type: 'assignPurpose', purpose: 'summary', target: { profileId: 'summary-provider', modelId: 'summary-test-model' } }
    ]
    for (const command of commands) {
      const catalog = await modelAccess.catalog()
      const result = await modelAccess.configure({ ...command, expectedRevision: catalog.snapshot.revision })
      assert.equal(result.ok, true)
    }
  }

  await gateway.start()
  let modelAccess = new ModelAccessRuntime({ gateway, vault: activeVault, adapter })
  await modelAccess.initialize()
  await configureModel(modelAccess)
  const recorder = new SqliteSessionRecorder({ gateway, now: () => 1770000000000 })
  await recorder.openSession({ sessionId: 'session.summary.budget', sourceId: 'mic', refinementEnabled: false })
  await recorder.acceptCaption({
    schemaVersion: 1,
    sessionId: 'session.summary.budget',
    sourceId: 'mic',
    segmentId: 'segment.summary.budget',
    sequence: 1,
    revision: 1,
    kind: 'final',
    t0: 0,
    t1: 10,
    text: 'synthetic committed caption',
    translation: null
  })
  await recorder.closeSession({ sessionId: 'session.summary.budget', sourceId: 'mic', state: 'closed' })

  let system = createExecutionSystem({
    gateway, modelAccess, config, promptStore: new Map(), owner: 'owner.j30.budget.first',
    diagnosticStore,
    leaseRenewEveryMs: 10,
    onJob: (job) => { runBeingExecuted = job.attemptIdentity; providerAttempt = job.attemptIdentity.attempt }
  })
  const accepted = await system.summaryRuns.accept({
    contract_id: summaryContract.CONTRACT_ID,
    contract_version: summaryContract.CONTRACT_VERSION,
    action: 'summary',
    scope: { kind: 'session', reference: 'session.summary.budget' },
    client_request_key: 'j30-budget-summary'
  })
  assert.equal(accepted.ok, true)
  const requestId = accepted.result.snapshot.request_id
  await waitFor(async () => (await gateway.getSessionSummaryRequest({ requestId })).targetRunId !== null, 'target run creation')
  const requestBeforeRun = await gateway.getSessionSummaryRequest({ requestId })
  const runId = requestBeforeRun.targetRunId
  system.scheduler.start()
  try {
    await waitFor(() => {
    if (egress.length > 0) return true
    if (!runBeingExecuted) return false
    const run = service.requireStore().database.prepare('SELECT state FROM formal_agent_runs WHERE run_id=?').get(runBeingExecuted.runId)
    return run && ['retry_wait', 'failed', 'succeeded'].includes(run.state)
    }, 'first provider egress or attempt settlement')
  } catch {
    const database = service.requireStore().database
    const run = database.prepare(`SELECT run_id,state,attempt_count,requested_by,recipe_id,resume_required FROM formal_agent_runs WHERE run_id=?`).get(runId)
    const requestState = database.prepare('SELECT state,phase,resume_required FROM formal_agent_requests WHERE request_id=?').get(requestId)
    throw new Error(`first attempt did not reach provider egress; run=${JSON.stringify(run)} request=${JSON.stringify(requestState)} jobKeys=${JSON.stringify(Object.keys(system.getFirstJob() || {}))} diagnostics=${JSON.stringify(system.getDiagnostics())} trace=${JSON.stringify(system.getTrace())}`)
  }
  assert.equal(egress.length, 1, `first attempt ended before provider egress: ${runBeingExecuted?.runId || 'unclaimed'}`)
  await waitFor(() => renewalResults.length > 0, 'first lease renewal')
  const firstJob = system.getFirstJob()
  assert.equal(firstJob.attemptIdentity.runId, runId)
  assert.ok(firstJob.remainingWallClockMs > 30000)
  assert.ok(renewalResults[0].remainingWallClockMs < firstJob.remainingWallClockMs)
  const renewedAttemptBudget = service.requireStore().database.prepare(`
    SELECT state,settled_elapsed_ms,reserved_elapsed_ms FROM formal_agent_run_attempt_budgets WHERE run_id=? AND attempt=1
  `).get(runId)
  assert.equal(renewedAttemptBudget.state, 'active')
  assert.ok(Number(renewedAttemptBudget.settled_elapsed_ms) > 0)
  assert.equal(Number(renewedAttemptBudget.reserved_elapsed_ms), 30000)
  assert.deepEqual(egress, [{ attempt: 1, reservationPresent: true }])
  const databaseBeforeRestart = service.requireStore().database
  const firstReservation = databaseBeforeRestart.prepare(`
    SELECT request_sequence FROM formal_agent_model_request_reservations WHERE run_id=? AND attempt=1
  `).all(runId)
  assert.deepEqual(firstReservation.map((row) => row.request_sequence), [1])
  const firstBinding = databaseBeforeRestart.prepare(`
    SELECT profile_id,profile_revision,model_id,capability_json,budget_json FROM agent_model_run_bindings WHERE run_id=?
  `).get(runId)
  assert.ok(firstBinding)

  await system.scheduler.stop()
  await system.getFirstJobSettled()
  await diagnosticStore.drain()
  const beforeRestartDiagnostics = await readDiagnosticRecords(diagnosticDirectory)
  assert.equal(beforeRestartDiagnostics.some((record) => record.event === 'accepted'), true)
  assert.equal(beforeRestartDiagnostics.some((record) => record.event === 'model_request_started' && record.attempt === 1), true)
  await gateway.shutdown()
  activeVault.close()
  activeVault = null

  diagnosticStore = new AgentRunDiagnostics({ directory: diagnosticDirectory, appVersion: '0.1.0' })
  await diagnosticStore.initialization
  service = new StorageWorkerService()
  gateway = new StorageGateway({ databasePath, hostFactory: () => serviceBackedHost(service, databasePath, (result) => renewalResults.push(result)), maxRestarts: 0 })
  await gateway.start()
  activeVault = createVault(vaultPath)
  modelAccess = new ModelAccessRuntime({ gateway, vault: activeVault, adapter })
  await modelAccess.initialize()
  system = createExecutionSystem({
    gateway, modelAccess, config, promptStore: new Map(), owner: 'owner.j30.budget.restarted',
    diagnosticStore,
    onJob: (job) => { runBeingExecuted = job.attemptIdentity; providerAttempt = job.attemptIdentity.attempt }
  })
  assert.equal(await system.summaryRuns.recoverAfterRestart(), 1)
  const recoveredRequest = await gateway.getSessionSummaryRequest({ requestId })
  assert.equal(recoveredRequest.state, 'retry_wait')
  assert.equal(recoveredRequest.resumeRequired, true)
  const recoveredBudget = service.requireStore().database.prepare(`
    SELECT max_wall_clock_ms,settled_elapsed_ms,conservative_elapsed_ms,accounting_known
    FROM formal_agent_run_budget_state WHERE run_id=?
  `).get(runId)
  assert.equal(recoveredBudget.accounting_known, 1)
  assert.ok(Number(recoveredBudget.settled_elapsed_ms) > 0)
  assert.equal(Number(recoveredBudget.conservative_elapsed_ms), 30000)
  await assert.rejects(gateway.terminalizeAgentInteraction({
    interactionId: firstJob.interactionId,
    attemptIdentity: { ...firstJob.attemptIdentity },
    terminalReason: 'succeeded',
    errorCode: null,
    result: output,
    usage: null,
    durationMs: 0
  }), (error) => error.code === 'AGENT_CONTEXT_OPERATION_FAILED')

  const continued = await system.summaryRuns.resume({
    contract_id: summaryContract.CONTRACT_ID,
    contract_version: summaryContract.CONTRACT_VERSION,
    request_id: requestId,
    generation: recoveredRequest.generation,
    expected_revision: recoveredRequest.revision
  })
  assert.equal(continued.ok, true)
  system.scheduler.start()
  await secondEgress
  await waitFor(() => Boolean(system.getSecondJobSettled()), 'second attempt runner start')
  await system.getSecondJobSettled()
  const finalDatabase = service.requireStore().database
  const finalRun = finalDatabase.prepare('SELECT state,attempt_count FROM formal_agent_runs WHERE run_id=?').get(runId)
  assert.deepEqual({ ...finalRun }, { state: 'succeeded', attempt_count: 2 })
  const attempts = finalDatabase.prepare(`
    SELECT attempt,state,request_count FROM formal_agent_run_attempt_budgets WHERE run_id=? ORDER BY attempt
  `).all(runId)
  assert.deepEqual(attempts.map((row) => ({ attempt: row.attempt, state: row.state, requestCount: row.request_count })), [
    { attempt: 1, state: 'interrupted', requestCount: 1 },
    { attempt: 2, state: 'settled', requestCount: 1 }
  ])
  const resumedBinding = finalDatabase.prepare(`
    SELECT profile_id,profile_revision,model_id,capability_json,budget_json FROM agent_model_run_bindings WHERE run_id=?
  `).get(runId)
  assert.deepEqual({ ...resumedBinding }, { ...firstBinding })
  assert.deepEqual(egress, [
    { attempt: 1, reservationPresent: true },
    { attempt: 2, reservationPresent: true }
  ])
  const currentBudget = finalDatabase.prepare(`
    SELECT max_wall_clock_ms,settled_elapsed_ms,conservative_elapsed_ms
    FROM formal_agent_run_budget_state WHERE run_id=?
  `).get(runId)
  assert.equal(Number(currentBudget.max_wall_clock_ms) - Number(currentBudget.settled_elapsed_ms) - Number(currentBudget.conservative_elapsed_ms) <= 30000, true)

  rejectWithPrivacyMarkers = true
  const providerFailureAccepted = await system.summaryRuns.accept({
    contract_id: summaryContract.CONTRACT_ID,
    contract_version: summaryContract.CONTRACT_VERSION,
    action: 'summary',
    scope: { kind: 'session', reference: 'session.summary.budget' },
    client_request_key: 'j30-budget-provider-error-privacy'
  })
  assert.equal(providerFailureAccepted.ok, true)
  const providerFailureRequestId = providerFailureAccepted.result.snapshot.request_id
  await waitFor(async () => (await gateway.getSessionSummaryRequest({ requestId: providerFailureRequestId })).targetRunId !== null, 'privacy error target run')
  const providerFailureRequestBeforeRun = await gateway.getSessionSummaryRequest({ requestId: providerFailureRequestId })
  const providerFailureRunId = providerFailureRequestBeforeRun.targetRunId
  const providerFailureEgress = await privacyFailureEgress
  assert.deepEqual(providerFailureEgress, { runId: providerFailureRunId, attempt: 1, reservationPresent: true })
  await waitFor(async () => (await gateway.getSessionSummaryRequest({ requestId: providerFailureRequestId })).state === 'failed', 'provider exception request failure')
  const providerFailureRequest = await gateway.getSessionSummaryRequest({ requestId: providerFailureRequestId })
  assert.equal(providerFailureRequest.errorCode, 'AGENT_PERMISSION_DENIED')
  assert.equal(diagnosticStore.getStatus().available, true)
  assert.equal(await diagnosticStore.drain(), true)
  const providerFailureDiagnostics = await diagnosticStore.recordsForRequestDigest(providerFailureRequest.requestDigest)
  assert.equal(providerFailureDiagnostics.available, true)
  assert.equal(providerFailureDiagnostics.records.some((record) => record.errorCode === 'AGENT_PERMISSION_DENIED'), true)
  const providerFailureExportPath = path.join(root, 'selected-provider-error-diagnostics.json')
  const providerFailureExport = await diagnosticStore.exportRequest({
    requestDigest: providerFailureRequest.requestDigest,
    showSaveDialog: async (_owner, options) => {
      assert.equal(options.title, '导出 Agent 运行诊断')
      return { canceled: false, filePath: providerFailureExportPath }
    }
  })
  assert.deepEqual(providerFailureExport, {
    status: 'saved',
    recordCount: providerFailureDiagnostics.records.length,
    available: true
  })
  const providerFailureExportBytes = fs.readFileSync(providerFailureExportPath, 'utf8')
  const providerFailureExportSnapshot = assertDiagnosticExportSnapshot(JSON.parse(providerFailureExportBytes))
  assert.equal(providerFailureExportSnapshot.available, true)
  for (const marker of Object.values(DIAGNOSTIC_PRIVACY_MARKERS)) {
    assert.equal(providerFailureExportBytes.includes(marker), false)
  }

  const afterAgentRecorder = new SqliteSessionRecorder({ gateway, now: () => 1770000000000 })
  await afterAgentRecorder.openSession({ sessionId: 'session.subtitle.after-agent', sourceId: 'mic', refinementEnabled: false })
  await afterAgentRecorder.closeSession({ sessionId: 'session.subtitle.after-agent', sourceId: 'mic', state: 'closed' })
  assert.equal((await gateway.getSessionTranscript('session.subtitle.after-agent')).session.state, 'closed')
  await system.scheduler.stop()
  activeVault.close()
  activeVault = null
  await gateway.shutdown()
  await diagnosticStore.drain()
  const diagnosticRecords = await readDiagnosticRecords(diagnosticDirectory)
  const diagnosticBytes = JSON.stringify(diagnosticRecords)
  for (const event of ['accepted', 'planning', 'model_request_started', 'model_request_ended', 'recovery', 'terminal']) {
    assert.equal(diagnosticRecords.some((record) => record.event === event), true, `diagnostic event ${event}`)
  }
  assert.equal(diagnosticRecords.some((record) => record.event === 'model_request_started' && record.attempt === 2 && record.modelBindingDigest), true)
  assert.equal(diagnosticBytes.includes('synthetic committed caption'), false)
  assert.equal(diagnosticBytes.includes('synthetic-provider-credential'), false)
  assert.equal(diagnosticBytes.includes('合成会话总结'), false)
  for (const marker of Object.values(DIAGNOSTIC_PRIVACY_MARKERS)) assert.equal(diagnosticBytes.includes(marker), false)
  assert.equal(diagnosticBytes.includes(requestId), false)
  assert.equal(diagnosticBytes.includes(runId), false)
  assert.equal(diagnosticBytes.includes(root), false)
  const sequences = diagnosticRecords.map((record) => record.sequence)
  assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right))
  assert.equal(new Set(sequences).size, sequences.length)
  gateway = null
})
