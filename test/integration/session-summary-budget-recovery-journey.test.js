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
const { createNetworkAdapter } = require('./provider-network-fixture')
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
const { sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')

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
    async summaryInputPlan (request) { return call(OPERATIONS.SUMMARY_INPUT_PLAN, { request }) },
    async readPersonalContextSessionRangePage (request) { return call(OPERATIONS.PERSONAL_CONTEXT_READ_SESSION_RANGE_PAGE, { request }) },
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
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
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
  let system = null
  t.after(async () => {
    await system?.scheduler.stop()
    await diagnosticStore.drain()
    if (activeVault) activeVault.close()
    if (gateway) await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(root, { recursive: true, force: true })
  })
  const egress = []
  let runBeingExecuted = null
  let providerAttempt = 0
  let rejectWithPrivacyMarkers = false
  let providerFailureCode = null
  let retryResponses = null
  let releaseLongRetryResponse
  let exhaustNextRun = false
  let resolvePrivacyFailureEgress
  const privacyFailureEgress = new Promise((resolve) => { resolvePrivacyFailureEgress = resolve })
  let resolveFirstEgress
  const firstEgress = new Promise((resolve) => { resolveFirstEgress = resolve })
  let resolveSecondEgress
  const secondEgress = new Promise((resolve) => { resolveSecondEgress = resolve })
  const output = { schemaVersion: 2, overview: '合成会话总结', topics: [], conclusions: [], todos: [], risks: [] }
  const adapter = createNetworkAdapter({
    fetch: async (_url, options) => {
      const summaryStage = JSON.parse(JSON.parse(options.body).messages[1].content).summaryPlan.stage
      const database = service.requireStore().database
      const reservation = database.prepare(`
        SELECT reservation_id FROM formal_agent_model_request_reservations
        WHERE run_id=? AND attempt=? AND request_sequence=1
      `).get(runBeingExecuted.runId, providerAttempt)
      assert.ok(reservation, 'model request reservation is durable before provider egress')
      egress.push({ attempt: providerAttempt, reservationPresent: true })
      if (retryResponses) {
        assert.ok(retryResponses.length > 0, 'cancelled retry wait must prevent another provider request')
        return retryResponses.shift()()
      }
      if (providerFailureCode) {
        return { ok: false, status: providerFailureCode === 'AGENT_PROVIDER_AUTH_FAILED' ? 401 : 503 }
      }
      if (rejectWithPrivacyMarkers) {
        resolvePrivacyFailureEgress({ runId: runBeingExecuted.runId, attempt: providerAttempt, reservationPresent: true })
        return { ok: false, status: 400, text: async () => DIAGNOSTIC_PRIVACY_MARKERS.providerResponse }
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
        text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(summaryStage === 'organizing_topics' ? { schemaVersion: 1, topics: [] } : output) } }] })
      }
    }
  })
  const borrowedCredentials = []
  const originalExchange = adapter.exchange.bind(adapter)
  adapter.exchange = input => { borrowedCredentials.push(input.credential); return originalExchange(input) }
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

  system = createExecutionSystem({
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
  assert.equal(borrowedCredentials.every(buffer => buffer.every(byte => byte === 0)), true,
    'non-cooperative outbound releases borrowed credentials before restart')
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
    onJob: (job) => {
      runBeingExecuted = job.attemptIdentity
      providerAttempt = job.attemptIdentity.attempt
      if (exhaustNextRun) {
        service.requireStore().database.prepare('UPDATE formal_agent_runs SET max_attempts=1 WHERE run_id=?').run(job.runId)
        exhaustNextRun = false
      }
    }
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
  const quality = finalDatabase.prepare('SELECT loop_count,total_loop_count FROM formal_agent_summary_quality WHERE run_id=?').get(runId)
  assert.deepEqual({ ...quality }, { loop_count: 3, total_loop_count: 4 })
  const attempts = finalDatabase.prepare(`
    SELECT attempt,state,request_count FROM formal_agent_run_attempt_budgets WHERE run_id=? ORDER BY attempt
  `).all(runId)
  assert.deepEqual(attempts.map((row) => ({ attempt: row.attempt, state: row.state, requestCount: row.request_count })), [
    { attempt: 1, state: 'interrupted', requestCount: 1 },
    { attempt: 2, state: 'settled', requestCount: 3 }
  ])
  const resumedBinding = finalDatabase.prepare(`
    SELECT profile_id,profile_revision,model_id,capability_json,budget_json FROM agent_model_run_bindings WHERE run_id=?
  `).get(runId)
  assert.deepEqual({ ...resumedBinding }, { ...firstBinding })
  assert.deepEqual(egress, [
    { attempt: 1, reservationPresent: true },
    { attempt: 2, reservationPresent: true },
    { attempt: 2, reservationPresent: true },
    { attempt: 2, reservationPresent: true }
  ])
  const currentBudget = finalDatabase.prepare(`
    SELECT max_wall_clock_ms,settled_elapsed_ms,conservative_elapsed_ms
    FROM formal_agent_run_budget_state WHERE run_id=?
  `).get(runId)
  // summary.minutes@2 runs keep the registered 120-minute run limit (2026-09-29
  // light plan); restart and explicit continuation must still preserve the
  // accumulated accounting instead of resetting it.
  assert.equal(Number(currentBudget.max_wall_clock_ms), 120 * 60 * 1000)
  assert.equal(Number(currentBudget.conservative_elapsed_ms), 30000)
  assert.equal(Number(currentBudget.max_wall_clock_ms) - Number(currentBudget.settled_elapsed_ms) - Number(currentBudget.conservative_elapsed_ms) > 0, true)

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
  assert.equal(providerFailureRequest.errorCode, 'AGENT_REQUEST_INVALID')
  assert.equal(diagnosticStore.getStatus().available, true)
  assert.equal(await diagnosticStore.drain(), true)
  const providerFailureDiagnostics = await diagnosticStore.recordsForRequestDigest(providerFailureRequest.requestDigest)
  assert.equal(providerFailureDiagnostics.available, true)
  assert.equal(providerFailureDiagnostics.records.some((record) => record.errorCode === 'AGENT_REQUEST_INVALID'), true)
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

  rejectWithPrivacyMarkers = false
  providerFailureCode = 'AGENT_PROVIDER_UNAVAILABLE'
  // J30-PROGRESS gap: a long Retry-After must reach the durable snapshot,
  // rather than being dropped after the host emits retry:null.
  retryResponses = [
    () => ({ ok: false, status: 429, headers: { get: name => name === 'retry-after' ? '1' : null } }),
    () => new Promise(resolve => { releaseLongRetryResponse = () => resolve({ ok: false, status: 429,
      headers: { get: name => name === 'retry-after' ? '2' : null } }) })
  ]
  const retryableAccepted = await system.summaryRuns.accept({
    contract_id: summaryContract.CONTRACT_ID,
    contract_version: summaryContract.CONTRACT_VERSION,
    action: 'summary',
    scope: { kind: 'session', reference: 'session.summary.budget' },
    client_request_key: 'j30-retryable-provider-error'
  })
  assert.equal(retryableAccepted.ok, true)
  const retryableRequestId = retryableAccepted.result.snapshot.request_id
  await waitFor(async () => {
    const request = await gateway.getSessionSummaryRequest({ requestId: retryableRequestId })
    return request.state === 'running' && request.phase === 'retry_wait' && request.retry?.requestAttempt >= 2
  }, 'provider short retry wait')
  const shortWait = await gateway.getSessionSummaryRequest({ requestId: retryableRequestId })
  assert.equal(shortWait.retry.requestAttempt, 2)
  assert.equal(shortWait.retry.waitMs, 1000)
  await waitFor(() => typeof releaseLongRetryResponse === 'function', 'second provider response boundary')
  releaseLongRetryResponse()
  await waitFor(async () => {
    const request = await gateway.getSessionSummaryRequest({ requestId: retryableRequestId })
    return request.state === 'running' && request.phase === 'retry_wait' && request.retry === null
  }, 'long Retry-After durable wait phase with cleared short metadata')
  const reloadedWait = await system.summaryRuns.get({
    contract_id: summaryContract.CONTRACT_ID, contract_version: summaryContract.CONTRACT_VERSION,
    request_id: retryableRequestId
  })
  assert.equal(reloadedWait.ok, true)
  assert.equal(reloadedWait.result.snapshot.phase, 'retry_wait')
  assert.equal(reloadedWait.result.snapshot.retry, undefined)
  await diagnosticStore.drain()
  const waitRow = await gateway.getSessionSummaryRequest({ requestId: retryableRequestId })
  const backoffs = (await diagnosticStore.recordsForRequestDigest(waitRow.requestDigest)).records
    .filter(record => record.event === 'backoff' && record.metrics.actual !== null)
  assert.deepEqual(backoffs.map(record => record.metrics), [
    { actual: 2, limit: 5, unit: 'count' }, { actual: 3, limit: 5, unit: 'count' }
  ])
  const egressBeforeRetryCancel = egress.length
  assert.equal(borrowedCredentials.every(buffer => buffer.every(byte => byte === 0)), true,
    'credentials are released throughout the real host retry wait')
  const retryableBeforeCancel = await gateway.getSessionSummaryRequest({ requestId: retryableRequestId })
  assert.equal(retryableBeforeCancel.errorCode, null)
  const retryableRunId = retryableBeforeCancel.targetRunId
  const cancelledRetryable = await system.summaryRuns.cancel({
    contract_id: summaryContract.CONTRACT_ID,
    contract_version: summaryContract.CONTRACT_VERSION,
    request_id: retryableRequestId,
    generation: retryableBeforeCancel.generation
  })
  assert.equal(cancelledRetryable.result.snapshot.state, 'cancelled')
  const retryableRun = service.requireStore().database.prepare('SELECT state,lease_owner FROM formal_agent_runs WHERE run_id=?').get(retryableRunId)
  assert.equal(retryableRun.state, 'cancelled')
  assert.equal(retryableRun.lease_owner, null)
  await waitFor(() => system.scheduler.activeRunId === null, 'cancelled long retry shutdown')
  assert.equal(egress.length, egressBeforeRetryCancel)
  retryResponses = null

  exhaustNextRun = true
  const exhaustedAccepted = await system.summaryRuns.accept({
    contract_id: summaryContract.CONTRACT_ID,
    contract_version: summaryContract.CONTRACT_VERSION,
    action: 'summary',
    scope: { kind: 'session', reference: 'session.summary.budget' },
    client_request_key: 'j30-exhausted-provider-error'
  })
  assert.equal(exhaustedAccepted.ok, true)
  const exhaustedRequestId = exhaustedAccepted.result.snapshot.request_id
  await waitFor(async () => (await gateway.getSessionSummaryRequest({ requestId: exhaustedRequestId })).targetRunId !== null, 'exhausted target creation')
  const exhaustedRunId = (await gateway.getSessionSummaryRequest({ requestId: exhaustedRequestId })).targetRunId
  await waitFor(async () => (await gateway.getSessionSummaryRequest({ requestId: exhaustedRequestId })).state === 'failed', 'retry exhaustion settlement')
  const exhaustedRun = service.requireStore().database.prepare('SELECT state,error_code FROM formal_agent_runs WHERE run_id=?').get(exhaustedRunId)
  const exhaustedInteraction = service.requireStore().database.prepare('SELECT terminal_reason,error_code,result_json FROM formal_agent_interactions WHERE run_id=?').get(exhaustedRunId)
  // 2026-09-29 light plan: summary.minutes@2 reserves up to 512 requests per
  // attempt, so the five transport retries settle honestly as the provider
  // error instead of tripping the legacy per-attempt request cap; the run and
  // interaction still share the same failure with zero minutes.
  assert.deepEqual({ ...exhaustedRun }, { state: 'failed', error_code: 'AGENT_PROVIDER_UNAVAILABLE' })
  assert.deepEqual({ ...exhaustedInteraction }, { terminal_reason: 'failed', error_code: 'AGENT_PROVIDER_UNAVAILABLE', result_json: null })

  providerFailureCode = 'AGENT_PROVIDER_AUTH_FAILED'
  const authAccepted = await system.summaryRuns.accept({
    contract_id: summaryContract.CONTRACT_ID,
    contract_version: summaryContract.CONTRACT_VERSION,
    action: 'summary',
    scope: { kind: 'session', reference: 'session.summary.budget' },
    client_request_key: 'j30-auth-provider-error'
  })
  assert.equal(authAccepted.ok, true)
  const authRequestId = authAccepted.result.snapshot.request_id
  await waitFor(async () => (await gateway.getSessionSummaryRequest({ requestId: authRequestId })).state === 'failed', 'credential rejection terminal state')
  const authRequest = await gateway.getSessionSummaryRequest({ requestId: authRequestId })
  assert.equal(authRequest.errorCode, 'AGENT_PROVIDER_AUTH_FAILED')
  const authRun = service.requireStore().database.prepare('SELECT attempt_count,state FROM formal_agent_runs WHERE run_id=?').get(authRequest.targetRunId)
  assert.deepEqual({ ...authRun }, { attempt_count: 1, state: 'failed' })

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

test('SEM-F38/SEM-F39/J30-CANCEL/J31-SIZE: the production chain commits exactly one minutes and never on cancel or late success', { timeout: 60000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-summary-minutes-j30-'))
  const databasePath = path.join(root, 'speech-agent.sqlite3')
  const config = new ConfigStore(path.join(root, 'config.json'), { now: () => 1770000000000 })
  config.load()
  config.updateAgentSettings({
    expectedRevision: config.get().agentSettingsRevision,
    agentEnabled: true,
    memoryEnabled: false,
    cloudDisclosureAccepted: false
  })
  const service = new StorageWorkerService()
  const gateway = new StorageGateway({ databasePath, hostFactory: () => serviceBackedHost(service, databasePath), maxRestarts: 0 })
  const vault = createVault(path.join(root, 'vault'))
  t.after(async () => {
    await system?.scheduler.stop()
    vault.close()
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(root, { recursive: true, force: true })
  })

  const sourceRef = { sessionId: 'session.summary.minutes', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 1 }
  const minutes = {
    schemaVersion: 2, topics: [],
    overview: '真实链路生成的受控纪要。',
    conclusions: [{ text: '形成一个受控结论。', topicId: null, sourceRefs: [sourceRef] }],
    todos: [], risks: []
  }
  const diagnosticStore = new AgentRunDiagnostics({ directory: path.join(root, 'diagnostics'), appVersion: '0.1.0' })
  await diagnosticStore.initialization
  const captured = []
  let holdEgress = null
  let releaseEgress = null
  let respondWith = (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(JSON.parse(body.messages[1].content).summaryPlan.stage === 'organizing_topics' ? { schemaVersion: 1, topics: [] } : minutes) } }] })
  })
  const adapter = createNetworkAdapter({
    fetch: async (_url, options) => {
      captured.push(JSON.parse(options.body))
      if (holdEgress) await holdEgress
      return respondWith(JSON.parse(options.body))
    }
  })
  await gateway.start()
  const modelAccess = new ModelAccessRuntime({ gateway, vault, adapter })
  await modelAccess.initialize()
  const configureModel = async () => {
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
  await configureModel(modelAccess)
  const recorder = new SqliteSessionRecorder({ gateway, now: () => 1770000000000 })
  await recorder.openSession({ sessionId: 'session.summary.minutes', sourceId: 'mic', refinementEnabled: false })
  await recorder.acceptCaption({
    schemaVersion: 1,
    sessionId: 'session.summary.minutes',
    sourceId: 'mic',
    segmentId: 'segment.summary.minutes',
    sequence: 1,
    revision: 1,
    kind: 'final',
    t0: 0,
    t1: 10,
    text: 'synthetic committed caption',
    translation: null
  })
  await recorder.closeSession({ sessionId: 'session.summary.minutes', sourceId: 'mic', state: 'closed' })

  let system = null
  const acceptSummary = async (clientKey) => {
    const accepted = await system.summaryRuns.accept({
      contract_id: summaryContract.CONTRACT_ID,
      contract_version: summaryContract.CONTRACT_VERSION,
      action: 'summary',
      scope: { kind: 'session', reference: 'session.summary.minutes' },
      client_request_key: clientKey
    })
    assert.equal(accepted.ok, true)
    const requestId = accepted.result.snapshot.request_id
    await waitFor(async () => (await gateway.getSessionSummaryRequest({ requestId })).targetRunId !== null, 'target run creation')
    return { requestId, runId: (await gateway.getSessionSummaryRequest({ requestId })).targetRunId }
  }
  const interactionRowsFor = (runId) => service.requireStore().database.prepare(`
    SELECT terminal_reason, error_code, result_json FROM formal_agent_interactions WHERE run_id=?
  `).all(runId)

  system = createExecutionSystem({
    gateway, modelAccess, config, promptStore: new Map(), owner: 'owner.j30.minutes', diagnosticStore
  })

  // A successful v3 summary request sends the staged JSON directives as the
  // system prompt, the derived output quota, and the full frozen input, and
  // commits exactly one minutes row.
  const success = await acceptSummary('j30-minutes-success')
  system.scheduler.start()
  await waitFor(async () => (await gateway.getSessionSummaryRequest({ requestId: success.requestId })).state === 'succeeded', 'success settlement')
  assert.equal(captured.length, 3)
  assert.equal(captured[0].messages[0].role, 'system')
  assert.equal(captured[0].messages[0].content.includes('只输出一个 JSON 对象'), true)
  assert.equal(captured[0].messages[0].content.includes('schemaVersion'), true)
  assert.equal(captured[0].messages[0].content.includes('不得编造'), true)
  assert.equal(captured[0].max_tokens, 4096, 'the confirmed output capability caps each stage target')
  assert.equal(captured[0].messages[1].role, 'user')
  assert.equal(captured[0].messages[1].content.includes('session.summary.minutes'), true)
  assert.equal(captured[0].messages[1].content.includes('"inputDigest"'), true)
  const successRows = interactionRowsFor(success.runId)
  assert.equal(successRows.length, 1)
  assert.equal(successRows[0].terminal_reason, 'succeeded')
  assert.deepEqual(JSON.parse(successRows[0].result_json), minutes)

  // Cancelling an already succeeded request returns the succeeded fact and
  // keeps the committed minutes.
  const lateCancel = await system.summaryRuns.cancel({
    contract_id: summaryContract.CONTRACT_ID,
    contract_version: summaryContract.CONTRACT_VERSION,
    request_id: success.requestId,
    generation: (await gateway.getSessionSummaryRequest({ requestId: success.requestId })).generation
  })
  assert.equal(lateCancel.ok, true)
  assert.equal(lateCancel.result.snapshot.state, 'succeeded')
  assert.equal(JSON.parse(interactionRowsFor(success.runId)[0].result_json).overview, minutes.overview)

  // A cancel that wins the race keeps the late provider success from committing
  // any minutes.
  holdEgress = new Promise((resolve) => { releaseEgress = resolve })
  const cancelled = await acceptSummary('j30-minutes-cancelled')
  await waitFor(() => captured.length === 4, 'cancelled scenario egress')
  const cancelOutcome = await system.summaryRuns.cancel({
    contract_id: summaryContract.CONTRACT_ID,
    contract_version: summaryContract.CONTRACT_VERSION,
    request_id: cancelled.requestId,
    generation: (await gateway.getSessionSummaryRequest({ requestId: cancelled.requestId })).generation
  })
  assert.equal(cancelOutcome.ok, true)
  assert.equal(cancelOutcome.result.snapshot.state, 'cancelled')
  await waitFor(async () => {
    const run = service.requireStore().database.prepare('SELECT state FROM formal_agent_runs WHERE run_id=?').get(cancelled.runId)
    return run && run.state === 'cancelled'
  }, 'cancelled run settlement')
  releaseEgress()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const cancelledRows = interactionRowsFor(cancelled.runId)
  assert.equal(cancelledRows.some((row) => row.terminal_reason === 'succeeded'), false)
  assert.equal(cancelledRows.every((row) => row.result_json === null), true)
  const cancelledRun = service.requireStore().database.prepare('SELECT state FROM formal_agent_runs WHERE run_id=?').get(cancelled.runId)
  assert.equal(cancelledRun.state, 'cancelled')

  holdEgress = null
  for (const [key, content, expected, finishReason = 'stop'] of [
    ['control', JSON.stringify({ ...minutes, overview: 'PRIVATE_OUTPUT_MARKER\u0000second line' }), { reason: 'control_character', field: 'overview', actual: null, limit: null }],
    ['length', JSON.stringify({ ...minutes, overview: 'x'.repeat(4001) }), { reason: 'length', field: 'overview', actual: 4001, limit: 4000 }],
    ['json', 'PRIVATE_INVALID_JSON', { reason: 'json', field: 'output', actual: null, limit: null }],
    ['source', JSON.stringify({ ...minutes, conclusions: [{ text: 'Synthetic.', topicId: null, sourceRefs: [{ ...sourceRef, throughEventOrder: 999 }] }] }), { reason: 'source_reference', field: 'sourceRefs', actual: null, limit: null }],
    ['protocol', JSON.stringify(minutes), { reason: 'response_protocol', field: 'response', actual: null, limit: null }, 'length']
  ]) {
    respondWith = body => ({ ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ choices: [{ finish_reason: finishReason, message: { content: JSON.parse(body.messages[1].content).summaryPlan.stage === 'organizing_topics' ? JSON.stringify({ schemaVersion: 1, topics: [] }) : content } }] }) })
    const failure = await acceptSummary('j30-output-' + key)
    await waitFor(async () => (await gateway.getSessionSummaryRequest({ requestId: failure.requestId })).state === 'failed', 'output rejection')
    assert.equal(interactionRowsFor(failure.runId)[0].result_json, null)
    assert.equal(interactionRowsFor(failure.runId)[0].error_code, 'AGENT_OUTPUT_INVALID')
    await diagnosticStore.drain()
    const records = await readDiagnosticRecords(path.join(root, 'diagnostics'))
    const rejection = records.filter(record => record.event === 'output_rejected').at(-1)
    assert.deepEqual(rejection?.outputValidation, expected)
    assertDiagnosticRecord(rejection)
    const page = await diagnosticStore.queryRequest({ requestDigest: rejection.requestDigest })
    assert.equal(page.records.some(record => record.event === 'output_rejected'), true)
    const destination = path.join(root, 'diagnostic-export.json')
    await diagnosticStore.exportRequest({ requestDigest: rejection.requestDigest, showSaveDialog: async () => ({ canceled: false, filePath: destination }) })
    const exported = assertDiagnosticExportSnapshot(JSON.parse(fs.readFileSync(destination, 'utf8')))
    assert.deepEqual(exported.records.findLast(record => record.event === 'output_rejected').outputValidation, expected)
    assert.equal(JSON.stringify(exported).includes('PRIVATE_'), false)
    assert.equal(JSON.stringify(records).includes('PRIVATE_OUTPUT_MARKER'), false)
    assert.equal(JSON.stringify(records).includes('PRIVATE_INVALID_JSON'), false)
  }
  await diagnosticStore.drain()

  // The subtitle session stays independent and the model request never widens
  // beyond the frozen binding capability.
  assert.equal((await gateway.getSessionTranscript('session.summary.minutes')).session.state, 'closed')
  await system.scheduler.stop()
  system = null
})


test('SEM-F39/J31-COVERAGE/MERGE/BUDGET: long input traverses real storage, planner, Loop and atomic publication', { timeout: 20000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'j31-long-'))
  const databasePath = path.join(root, 'speech-agent.sqlite3')
  const service = new StorageWorkerService()
  const gateway = new StorageGateway({ databasePath, hostFactory: () => serviceBackedHost(service, databasePath), maxRestarts: 0 })
  const vault = createVault(path.join(root, 'vault'))
  const config = new ConfigStore(path.join(root, 'config.json'), { now: () => 1770000000000 })
  config.load()
  config.updateAgentSettings({ expectedRevision: config.get().agentSettingsRevision, agentEnabled: true, memoryEnabled: false, cloudDisclosureAccepted: false })
  let system
  t.after(async () => {
    await system?.scheduler.stop()
    vault.close()
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(root, { recursive: true, force: true })
  })
  let mode = 'success'
  const sent = []
  const minutes = { schemaVersion: 1, overview: '合成纪要第一段。\n\n较晚修订见第二段。', conclusions: [], todos: [], risks: [] }
  const adapter = createNetworkAdapter({ fetch: async (_url, options) => {
    const body = JSON.parse(options.body)
    const node = JSON.parse(body.messages[1].content).summaryPlan
    sent.push(node)
    assert.ok(Buffer.byteLength(options.body) <= 512 * 1024)
    if (mode === 'failure' && sent.length === 2) return { ok: false, status: 400 }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(minutes) } }],
      ...(mode === 'unknown' ? {} : { usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
    }) }
  } })
  await gateway.start()
  const modelAccess = new ModelAccessRuntime({ gateway, vault, adapter })
  await modelAccess.initialize()
  for (const command of [
    { type: 'createProfile', profileId: 'long-provider', label: 'Long input', httpsOrigin: 'https://provider.test', basePath: '/v1' },
    { type: 'addModel', profileId: 'long-provider', modelId: 'long-model', capabilities: { ...CAPABILITIES, maxInputTokens: 65536, usageReporting: true } },
    { type: 'setCredential', profileId: 'long-provider', credential: 'synthetic-credential' },
    { type: 'assignPurpose', purpose: 'summary', target: { profileId: 'long-provider', modelId: 'long-model' } }
  ]) {
    const catalog = await modelAccess.catalog()
    assert.equal((await modelAccess.configure({ ...command, expectedRevision: catalog.snapshot.revision })).ok, true)
  }
  const sessionId = 'session.j31.long'
  const recorder = new SqliteSessionRecorder({ gateway, now: () => 1770000000000 })
  await recorder.openSession({ sessionId, sourceId: 'mic', refinementEnabled: false })
  const original = []
  for (let index = 0; index < 128; index++) {
    const text = 'a'.repeat(index === 127 ? 173827 - 127 * 1358 : 1358)
    original.push(text)
    await recorder.acceptCaption({ schemaVersion: 1, sessionId, sourceId: 'mic', segmentId: `segment.${index}`, sequence: index + 1,
      revision: 1, kind: 'final', t0: index * 140000, t1: index * 140000 + 100, text, translation: null })
  }
  await recorder.closeSession({ sessionId, sourceId: 'mic', state: 'closed' })
  const legacyPromptStore = new Map()
  system = createExecutionSystem({ gateway, modelAccess, config, promptStore: legacyPromptStore, owner: 'owner.j31.long' })
  const run = async (key, legacy = false) => {
    // Seed historical @2 facts through real storage commands. New product
    // submissions use @3; this journey retains the old policy interpretation.
    const source = await gateway.derivePersonalContextSessionSource({ sessionId, transcriptVersion: 'raw' })
    const requestId = `request.${key}`; const runId = `run.${key}`; const interactionId = `interaction.${key}`
    const inputWatermark = { throughEventOrder: source.inputWatermark }
    await gateway.acceptSessionSummaryRequest({ requestId, sessionId, clientKeyDigest: sha256Canonical(key), requestDigest: sha256Canonical({ key }),
      scopeDigest: sha256Canonical({ kind: 'session', reference: sessionId }), promptDigest: sha256Canonical('会话总结'), action: 'summary', summaryUseMemory: false,
      transcriptVersion: 'raw', inputWatermark, inputDigest: source.inputDigest })
    await gateway.createAgentRun({ runId, recipeId: 'summary.minutes', recipeVersion: '2', scope: { kind: 'session', reference: sessionId },
      transcriptVersion: 'raw', inputWatermark, inputDigest: source.inputDigest, requestedBy: 'user', clientIdempotencyKey: key,
      requestId, requestGeneration: 1, summaryUseMemory: false })
    await modelAccess.bind({ runId, recipeId: 'summary.minutes', recipeVersion: '2', executionForm: 'agent_loop' })
    await gateway.createAgentInteraction({ runId, interactionId, routingMode: 'preset', promptDigest: sha256Canonical('会话总结') })
    legacyPromptStore.set(runId, '会话总结')
    if (legacy) {
      await waitFor(async () => (await gateway.getSessionSummaryRequest({ requestId })).targetRunId !== null, 'legacy run prepared')
      assert.equal(service.requireStore().database.prepare("UPDATE formal_agent_runs SET summary_input_policy=NULL,max_attempts=5 WHERE session_summary_request_id=?").run(requestId).changes, 1)
    }
    system.scheduler.start()
    system.scheduler.wake('legacy-fixture')
    await waitFor(async () => ['succeeded', 'failed'].includes((await gateway.getSessionSummaryRequest({ requestId })).state), 'long summary terminal')
    const request = await gateway.getSessionSummaryRequest({ requestId })
    const db = service.requireStore().database
    const interaction = db.prepare('SELECT * FROM formal_agent_interactions WHERE run_id=?').get(request.targetRunId)
    return { request, interaction, db }
  }
  const legacy = await run('j31-long-legacy', true)
  assert.equal(legacy.request.state, 'failed')
  assert.equal(legacy.interaction.summary_input_limit_error, 1)
  assert.equal(sent.length, 0)
  const success = await run('j31-long-success')
  assert.equal(success.request.state, 'succeeded', success.interaction.error_code)
  const leaves = sent.filter(node => node.stage === 'leaf')
  assert.ok(leaves.length > 1)
  assert.equal(leaves.flatMap(node => node.parts).map(part => part.text).join(''), original.join(''))
  assert.equal(sent.at(-1).stage, 'merge')
  assert.deepEqual(JSON.parse(success.interaction.result_json), minutes)
  assert.equal(JSON.parse(success.interaction.usage_json).inputTokens, sent.length * 100)
  const plan = success.db.prepare('SELECT * FROM formal_agent_run_input_plans WHERE run_id=?').get(success.request.targetRunId)
  assert.equal(plan.policy_version, 'summary-long-input@1')
  assert.equal(plan.raw_text_bytes, 173827)
  assert.equal(plan.leaf_count, leaves.length)
  assert.equal(success.request.validatedChunkCount, leaves.length)
  assert.equal(success.db.prepare('SELECT max_attempts FROM formal_agent_runs WHERE run_id=?').get(success.request.targetRunId).max_attempts, 2)
  const { buildExportSnapshot } = require('../../src/agent/formal-run/agent-interaction-exporter')
  const detail = await gateway.getAgentInteraction({ interactionId: success.interaction.interaction_id })
  const exported = buildExportSnapshot(detail, success.interaction.interaction_id)
  assert.equal(exported.schema_version, 3)
  assert.equal(exported.summary_input_plan.plan_digest, plan.plan_digest)
  assert.equal(exported.summary_input_policy, 'summary-long-input@1')
  assert.deepEqual(detail.interaction.result, minutes)
  assert.deepEqual(exported.result, minutes)
  mode = 'unknown'; sent.length = 0
  const unknown = await run('j31-long-unknown')
  assert.equal(unknown.request.state, 'succeeded')
  assert.equal(unknown.interaction.usage_json, null)
  mode = 'failure'; sent.length = 0
  const failure = await run('j31-long-failure')
  assert.equal(failure.request.state, 'failed')
  assert.equal(failure.interaction.result_json, null)
  assert.equal(sent.length, 2)
})
