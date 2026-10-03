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
const { AgentLoopExecutor, FormalAgentJobScheduler, FormalAgentRunRunner, IntentRouteOrchestrator } = require('../../src/agent/execution-host')
const { ConfigStore } = require('../../src/main/services/config-store')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { AgentRunDiagnostics } = require('../../src/main/services/agent-run-diagnostics')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')
const { CONTROL_MESSAGES, OPERATIONS, PROTOCOL_VERSION, StorageError, makeCaptionEventId, makeCloseSessionKey, makeOpenSessionKey } = require('../../src/runtime/storage-worker/protocol')
const contract = require('../../src/agent/contracts/session-summary-run-ui')
const { buildExportSnapshot } = require('../../src/agent/formal-run/agent-interaction-exporter')

function serviceBackedHost (service, databasePath, onRenew) {
  let sequence = 0
  const call = async (operation, payload, idempotencyKey) => {
    const response = await service.handle({
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId: `j22-qa-window.${++sequence}`,
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
    async personalContextManage (command) { return call(OPERATIONS.PERSONAL_CONTEXT_MANAGE, { command }) },
    async claimNextFormalAgentRun (request) { return call(OPERATIONS.FORMAL_AGENT_CLAIM_RUN, { request }) },
    async renewFormalAgentRun (request) {
      const response = await service.handleLeaseRenewalControl({
        version: PROTOCOL_VERSION,
        type: CONTROL_MESSAGES.RENEW_FORMAL_AGENT_RUN_LEASE,
        requestId: `j22-qa-window.${++sequence}`,
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

async function waitFor (predicate) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('session question did not reach a terminal state')
}

async function fixture (t, { maxInputTokens = 64000, text = '问'.repeat(1000), segments = 6,
  durationMs = segments * 10, targetResponse = null, targetOutput = null, usage = null, seedMemory = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-question-window-'))
  const databasePath = path.join(root, 'speech-agent.sqlite3')
  const service = new StorageWorkerService()
  const gateway = new StorageGateway({ databasePath, hostFactory: () => serviceBackedHost(service, databasePath), maxRestarts: 0 })
  const config = new ConfigStore(path.join(root, 'config.json'), { now: () => 1770000000000 })
  config.load()
  config.updateAgentSettings({ expectedRevision: config.get().agentSettingsRevision,
    agentEnabled: true, memoryEnabled: seedMemory, cloudDisclosureAccepted: false })
  const vault = new CredentialVault({
    directory: path.join(root, 'vault'),
    safeStorage: { isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value).reverse(),
      decryptString: (value) => Buffer.from(value).reverse().toString() }
  })
  const diagnostics = new AgentRunDiagnostics({ directory: path.join(root, 'diagnostics'), appVersion: '0.1.0' })
  await diagnostics.initialization
  const calls = { route: 0, target: 0, fullInput: false, leaves: [], merges: [], prompts: [] }
  const texts = Array.from({ length: segments }, (_, index) => typeof text === 'function' ? text(index) : text)
  const answer = { schemaVersion: 1, answer: '合成会话中的结论。', sourceRefs: [], memoryRefs: [], unresolved: [] }
  const adapter = new OpenAiCompatibleAdapter({
    fetch: async (_url, options) => {
      const body = JSON.parse(options.body)
      const routing = body.messages[0].content.includes('路由字段')
      if (routing) calls.route += 1
      else {
        calls.target += 1
        const input = JSON.parse(body.messages.find((message) => message.role === 'user').content)
        assert.equal(input.userPrompt, '这场会话的结论是什么？')
        calls.prompts.push(input)
        const plan = input.questionPlan
        if (plan) {
          if (plan.stage === 'leaf') {
            calls.leaves.push(plan.parts)
            for (const part of plan.parts) {
              assert.equal(part.segmentId, `segment.qa.${part.eventOrder - 1}`)
              assert.equal(part.text, Array.from(texts[part.eventOrder - 1]).slice(part.codePointStart, part.codePointEnd).join(''))
            }
            const reconstructed = new Map()
            for (const part of calls.leaves.flat()) reconstructed.set(part.eventOrder,
              (reconstructed.get(part.eventOrder) || '') + part.text)
            calls.fullInput = reconstructed.size === segments && texts.every((value, index) => reconstructed.get(index + 1) === value)
          } else {
            calls.merges.push(plan.parts)
            assert.ok(plan.parts.length >= 2 && plan.parts.length <= 4)
          }
          answer.sourceRefs = [{ sessionId: plan.source.sessionId, transcriptVersion: 'raw',
            fromEventOrder: plan.parts[0].eventOrder || plan.parts[0].fromEventOrder,
            throughEventOrder: plan.parts.at(-1).eventOrder || plan.parts.at(-1).throughEventOrder }]
        } else {
          calls.fullInput = input.transcript.events.length === segments &&
            input.transcript.events.every((event, index) => event.text === texts[index] && event.segmentId === `segment.qa.${index}`)
          assert.equal(calls.fullInput, true)
          answer.sourceRefs = [{ sessionId: input.transcript.sessionId, transcriptVersion: 'raw',
            fromEventOrder: input.transcript.events[0].eventOrder,
            throughEventOrder: input.transcript.inputWatermark }]
        }
      }
      const output = routing ? { recipeId: 'qa.answer', confidence: 0.95 }
        : targetOutput ? targetOutput(structuredClone(answer), body, calls.prompts.at(-1)) : answer
      if (!routing && targetResponse) return targetResponse(output, body)
      return { ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
          ...(usage ? { usage: routing ? { prompt_tokens: 1, completion_tokens: 1 } : usage } : {}) }) }
    }
  })
  await gateway.start()
  const modelAccess = new ModelAccessRuntime({ gateway, vault, adapter })
  await modelAccess.initialize()
  for (const command of [
    { type: 'createProfile', profileId: 'qa-provider', label: 'QA Test Provider', httpsOrigin: 'https://provider.test', basePath: '/v1' },
    { type: 'addModel', profileId: 'qa-provider', modelId: 'qa-model', capabilities: {
      maxInputTokens, maxOutputTokens: 4096, supportsToolCalling: true,
      supportsStructuredOutput: true, supportsStreaming: true, usageReporting: usage !== null } },
    { type: 'setCredential', profileId: 'qa-provider', credential: 'synthetic-provider-credential' },
    { type: 'assignPurpose', purpose: 'default', target: { profileId: 'qa-provider', modelId: 'qa-model' } }
  ]) {
    const catalog = await modelAccess.catalog()
    assert.equal((await modelAccess.configure({ ...command, expectedRevision: catalog.snapshot.revision })).ok, true)
  }
  const recorder = new SqliteSessionRecorder({ gateway, now: () => 1770000000000 })
  await recorder.openSession({ sessionId: 'session.qa.window', sourceId: 'mic', refinementEnabled: false })
  for (let index = 0; index < segments; index += 1) {
    await recorder.acceptCaption({ schemaVersion: 1, sessionId: 'session.qa.window', sourceId: 'mic',
      segmentId: `segment.qa.${index}`, sequence: index + 1, revision: 1, kind: 'final',
      t0: Math.floor(index * durationMs / segments), t1: Math.floor((index + 1) * durationMs / segments), text: texts[index], translation: null })
  }
  await recorder.closeSession({ sessionId: 'session.qa.window', sourceId: 'mic', state: 'closed' })
  if (seedMemory) await gateway.personalContextManage({ type: 'remember', expected_revision: 0,
    entry: { display_text: '问答参考', kind: 'term', scope: { kind: 'global', reference: null } } })
  const runtimeFactory = (gateway, modelAccess) => {
    const promptStore = new Map()
    let questionRuns
    const runner = new FormalAgentRunRunner({
      storage: gateway, modelAccess, personalContext: createPersonalContextExecutionAdapter({ storage: gateway }),
      promptProvider: (runId) => promptStore.get(runId) || null,
      onProgress: (event, signal) => questionRuns.recordProgress(event, signal),
      onChanged: (event) => { void questionRuns.notifyRunChanged(event) },
      onSettled: (runId) => promptStore.delete(runId),
      interactions: {
        terminalize: (request, signal) => gateway.terminalizeAgentInteraction(request, signal),
        startToolCall: (request, signal) => gateway.startAgentToolCall(request, signal),
        finishToolCall: (request, signal) => gateway.finishAgentToolCall(request, signal)
      },
      loopFactory: (binding) => new AgentLoopExecutor({ adapter: modelAccess.createLoopAdapter(binding) })
    })
    const scheduler = new FormalAgentJobScheduler({ storage: gateway, runner, requestedBy: 'user', owner: 'owner.qa.window', leaseMs: 30000 })
    const runs = new AgentRunService({ storage: gateway, modelAccess, scheduler, questionRecipeVersion: '3', getConfig: () => config.get() })
    const routeOrchestrator = new IntentRouteOrchestrator({
      questionRecipeVersion: '3',
      runs: { create: (request) => gateway.createAgentRun(request), cancel: (request) => gateway.cancelAgentRun(request),
        getInteraction: (request) => gateway.getAgentInteraction(request) },
      modelAccess,
      interactions: { create: (request) => gateway.createAgentInteraction(request),
        terminalize: (request) => gateway.terminalizeAgentInteraction(request) },
      loopFactory: (binding) => new AgentLoopExecutor({ adapter: modelAccess.createLoopAdapter(binding) }),
      allowedTargetRecipes: ['summary.minutes', 'qa.answer']
    })
    questionRuns = new SessionSummaryRunService({ storage: gateway, runService: runs, routeOrchestrator, scheduler,
      getConfig: () => config.get(), promptStore, diagnostics })
    return { gateway, questionRuns, scheduler, promptStore, runs }
  }
  const { questionRuns, scheduler } = runtimeFactory(gateway, modelAccess)
  t.after(async () => {
    await scheduler.stop()
    await diagnostics.drain()
    vault.close()
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { service, gateway, calls, answer, root, diagnostics, questionRuns, scheduler, texts, config, modelAccess, vault, adapter, runtimeFactory }
}

async function ask (system, overrides = {}) {
  const accepted = await system.questionRuns.accept({
    contract_id: contract.CONTRACT_ID, contract_version: contract.CONTRACT_VERSION,
    action: 'question', prompt: '这场会话的结论是什么？',
    scope: { kind: 'session', reference: 'session.qa.window' }, client_request_key: 'j22-qa-window', ...overrides
  })
  assert.equal(accepted.ok, true)
  const requestId = accepted.result.snapshot.request_id
  system.scheduler.start()
  let request
  await waitFor(async () => {
    request = await system.gateway.getSessionSummaryRequest({ requestId })
    return ['succeeded', 'failed', 'cancelled'].includes(request.state)
  })
  await system.diagnostics.drain()
  return request
}

test('SEM-F16/F28/F31/J22-QA-WINDOW/J24: question consumes the full Chinese session inside the model window', async (t) => {
  const system = await fixture(t)
  const request = await ask(system)
  assert.equal(request.state, 'succeeded', `unexpected rejection: ${request.errorCode}`)
  assert.equal(request.errorCode, null)
  assert.equal(system.calls.route, 1)
  assert.equal(system.calls.target, 1)
  assert.equal(system.calls.fullInput, true)
  const run = system.service.requireStore().database.prepare('SELECT recipe_version,budget_json FROM formal_agent_runs JOIN agent_model_run_bindings USING(run_id) WHERE run_id=?').get(request.targetRunId)
  assert.equal(run.recipe_version, '3')
  const budget = JSON.parse(run.budget_json)
  assert.equal(budget.maxWallClockMs, 3600000)
  assert.equal(budget.maxCumulativeInputTokens, 16000000)
  const interaction = await system.gateway.getAgentInteraction({ interactionId: request.targetInteractionId })
  assert.deepEqual(interaction.interaction.result, system.answer)
  assert.equal(interaction.interaction.usage, null)
  const exported = buildExportSnapshot(interaction)
  assert.equal(exported.recipe_version, '3')
  assert.deepEqual(exported.result, system.answer)
  assert.equal(exported.usage, null)
  // The version change also preserves the source of an explicit interaction memory signal.
  const personal = system.service.requirePersonalContextStore()
  const prepared = personal.prepareInteractionIngestRequest({ interactionId: request.targetInteractionId,
    signalKind: 'accept', payloadDigest: null, signalIdempotencyKey: 'j24.qa.accept' })
  const { startedAt, endedAt, ...source } = prepared.source
  const inputDigest = system.service.requireStore().database.prepare('SELECT input_digest FROM formal_agent_runs WHERE run_id=?').get(prepared.runId).input_digest
  const interactionInput = personal.readInteractionInput({ ...source, inputDigest },
    { prompt: null, editText: null, result: system.answer })
  assert.equal(interactionInput.recipeVersion, '3')
  assert.deepEqual(interactionInput.signal.result, system.answer)
})

test('SEM-F31/F33/F40/J22-QA-SIZE/J30-DIAG: window overflow is precise, persistent and makes no target request', async (t) => {
  const system = await fixture(t, { maxInputTokens: 7000 })
  const request = await ask(system)
  assert.equal(request.state, 'failed')
  assert.equal(request.errorCode, 'AGENT_QA_INPUT_LIMIT_EXCEEDED')
  assert.equal(system.calls.route, 1)
  assert.equal(system.calls.target, 0)
  const interaction = await system.gateway.getAgentInteraction({ interactionId: request.targetInteractionId })
  assert.equal(interaction.interaction.result, null)
  assert.equal(interaction.interaction.errorCode, 'AGENT_QA_INPUT_LIMIT_EXCEEDED')
  assert.equal(buildExportSnapshot(interaction).error_code, 'AGENT_QA_INPUT_LIMIT_EXCEEDED')
  const run = system.service.requireStore().database.prepare('SELECT state,attempt_count FROM formal_agent_runs WHERE run_id=?').get(request.targetRunId)
  assert.equal(run.attempt_count, 1)
  assert.equal(run.state, 'failed')
  const records = fs.readdirSync(path.join(system.root, 'diagnostics'))
    .filter((name) => name.endsWith('.jsonl'))
    .flatMap((name) => fs.readFileSync(path.join(system.root, 'diagnostics', name), 'utf8').trim().split('\n').map(JSON.parse))
  const rejected = records.find((record) => record.event === 'budget_rejected' && record.errorCode === 'AGENT_QA_INPUT_LIMIT_EXCEEDED')
  assert.ok(rejected)
  assert.equal(rejected.budgetAxis, null)
  assert.equal(rejected.metrics.unit, 'bytes')
  assert.ok(rejected.metrics.actual > rejected.metrics.limit)
  assert.equal(rejected.metrics.limit, 0)
  assert.equal(records.some((record) => record.event === 'model_request_started'), false)
  // A rejected optional Agent request must leave the shared subtitle store healthy.
  const recorder = new SqliteSessionRecorder({ gateway: system.gateway, now: () => 1770000000001 })
  await recorder.openSession({ sessionId: 'session.qa.after-rejection', sourceId: 'mic', refinementEnabled: false })
  await recorder.acceptCaption({ schemaVersion: 1, sessionId: 'session.qa.after-rejection', sourceId: 'mic',
    segmentId: 'segment.qa.after-rejection', sequence: 1, revision: 1, kind: 'final',
    t0: 0, t1: 10, text: '合成后续首次稳定转写', translation: null })
  await recorder.closeSession({ sessionId: 'session.qa.after-rejection', sourceId: 'mic', state: 'closed' })
  assert.equal((await system.gateway.getSessionTranscript('session.qa.after-rejection')).segments.length, 1)
  await system.scheduler.stop()
  await system.gateway.shutdown()
  const databasePath = path.join(system.root, 'speech-agent.sqlite3')
  const reopenedService = new StorageWorkerService()
  const reopened = new StorageGateway({ databasePath, hostFactory: () => serviceBackedHost(reopenedService, databasePath), maxRestarts: 0 })
  try {
    await reopened.start()
    assert.equal((await reopened.getSessionSummaryRequest({ requestId: request.requestId })).errorCode, 'AGENT_QA_INPUT_LIMIT_EXCEEDED')
    const persisted = await reopened.getAgentInteraction({ interactionId: request.targetInteractionId })
    assert.equal(persisted.interaction.errorCode, 'AGENT_QA_INPUT_LIMIT_EXCEEDED')
    assert.equal(buildExportSnapshot(persisted).error_code, 'AGENT_QA_INPUT_LIMIT_EXCEEDED')
  } finally { await reopened.shutdown() }
})

test('SEM-F16/F31/J22-QA-WINDOW: a question keeps all events across storage pages', async (t) => {
  const system = await fixture(t, { maxInputTokens: 120000, text: '问'.repeat(100), segments: 150 })
  const request = await ask(system)
  assert.equal(request.state, 'succeeded')
  assert.equal(system.calls.target, 1)
  assert.equal(system.calls.fullInput, true)
  const detail = await system.gateway.getAgentInteraction({ interactionId: request.targetInteractionId })
  assert.equal(detail.interaction.result.sourceRefs[0].throughEventOrder, 150)
})

test('SEM-F28/F31/J24-QA-BUDGET: cancelling QA rejects a late provider answer without another request', async (t) => {
  let resolveResponse
  const response = new Promise((resolve) => { resolveResponse = resolve })
  const system = await fixture(t, { targetResponse: () => response })
  const pending = ask(system)
  await waitFor(() => system.calls.target === 1)
  const row = system.service.requireStore().database.prepare('SELECT request_id,generation FROM formal_agent_requests WHERE action=?').get('question')
  const cancelled = await system.questionRuns.cancel({ contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION, request_id: row.request_id, generation: row.generation })
  assert.equal(cancelled.ok, true)
  resolveResponse({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(system.answer) } }]
  }) })
  const request = await pending
  await system.scheduler.stop()
  assert.equal(request.state, 'cancelled')
  assert.equal(system.calls.target, 1)
  const detail = await system.gateway.getAgentInteraction({ interactionId: request.targetInteractionId })
  assert.equal(detail.interaction.terminalReason, 'cancelled')
  assert.equal(detail.interaction.result, null)
  assert.equal(buildExportSnapshot(detail).terminal_reason, 'cancelled')
})

test('SEM-F28/F31/F39/J22-QA-LONG/J31: a question beyond one model window executes all chunks before committing an answer', async (t) => {
  const system = await fixture(t, { segments: 60 })
  const request = await ask(system)
  assert.equal(request.state, 'succeeded', `long question rejected: ${request.errorCode}`)
  assert.ok(system.calls.target > 1)
  const detail = await system.gateway.getAgentInteraction({ interactionId: request.targetInteractionId })
  assert.equal(detail.interaction.recipeVersion, '3')
  const exported = buildExportSnapshot(detail)
  assert.equal(exported.schema_version, 4)
  assert.equal(exported.question_input_policy, 'qa-long-input@1')
  assert.equal(exported.question_input_plan.segment_count, 60)
  assert.ok(exported.question_input_plan.leaf_count > 1)
  assert.equal(system.calls.fullInput, true)
  assert.equal(system.calls.target, exported.question_input_plan.node_count)
  assert.equal(detail.interaction.usage, null)
})

test('SEM-F31/F39/F40/J22-QA-LONG/J31: four-hour input preserves Unicode, late corrections and ordered multi-level answers', async (t) => {
  const decisions = ['初议采用方案甲', '修订为方案乙', '撤销方案乙，保留人工审查']
  const decisionEvents = [1, 65, 128]
  const system = await fixture(t, { segments: 128, durationMs: 4 * 60 * 60 * 1000,
    text: (index) => `${decisions[decisionEvents.indexOf(index + 1)] || '合成讨论'}。${'待确认 😀 e\u0301 "\\\n'.repeat(index === 32 ? 7000 : 150)}`,
    usage: { prompt_tokens: 123, completion_tokens: 45, prompt_cache_hit_tokens: 23, prompt_cache_miss_tokens: 100 },
    targetOutput: (output, _body, input) => {
      const plan = input.questionPlan
      let latest = null
      if (plan.stage === 'leaf') {
        for (const part of plan.parts) {
          for (let index = 0; index < decisions.length; index++) {
            if (part.text.includes(decisions[index])) latest = { decision: decisions[index], event: decisionEvents[index] }
          }
        }
      } else {
        for (const part of plan.parts) {
          const index = decisions.findIndex((decision) => part.output.answer.includes(decision))
          if (index >= 0) latest = { decision: decisions[index], event: decisionEvents[index] }
        }
      }
      return { ...output,
        answer: latest ? `${plan.final ? '' : 'QA_INTERMEDIATE_ONLY:'}${latest.decision}` : '本块无决定证据',
        sourceRefs: latest ? [{ sessionId: plan.source.sessionId, transcriptVersion: 'raw', fromEventOrder: latest.event, throughEventOrder: latest.event }] : [],
        unresolved: latest ? [] : ['本块尚无问题的结论证据'] }
    }
  })
  const request = await ask(system)
  assert.equal(request.state, 'succeeded', request.errorCode)
  assert.equal(system.calls.fullInput, true)
  assert.ok(system.calls.leaves.length > 4)
  assert.ok(system.calls.merges.length > 2)
  assert.ok(system.calls.leaves.flat().filter((part) => part.eventOrder === 33).length > 1)
  for (const prompt of system.calls.prompts) assert.equal(prompt.userPrompt, '这场会话的结论是什么？')
  for (const parts of system.calls.merges) {
    for (let index = 1; index < parts.length; index++) assert.ok(parts[index - 1].throughEventOrder <= parts[index].fromEventOrder)
  }
  const detail = await system.gateway.getAgentInteraction({ interactionId: request.targetInteractionId })
  assert.equal(detail.interaction.result.answer, decisions[2])
  assert.deepEqual(detail.interaction.result.sourceRefs, [{ sessionId: 'session.qa.window', transcriptVersion: 'raw', fromEventOrder: 128, throughEventOrder: 128 }])
  assert.deepEqual(detail.interaction.usage, { inputTokens: system.calls.target * 123, outputTokens: system.calls.target * 45,
    usageSource: 'provider', cacheHitInputTokens: system.calls.target * 23, cacheMissInputTokens: system.calls.target * 100 })
  const before = JSON.stringify(buildExportSnapshot(detail))
  const db = system.service.requireStore().database
  for (const table of ['formal_agent_runs', 'formal_agent_interactions', 'formal_agent_run_input_plans', 'formal_agent_model_request_reservations']) {
    const rows = JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all())
    assert.equal(rows.includes('QA_INTERMEDIATE_ONLY:'), false)
    assert.equal(rows.includes('这场会话的结论是什么？'), false)
  }
  const diagnosticBytes = fs.readdirSync(path.join(system.root, 'diagnostics')).filter((name) => name.endsWith('.jsonl'))
    .map((name) => fs.readFileSync(path.join(system.root, 'diagnostics', name), 'utf8')).join('')
  for (const marker of ['QA_INTERMEDIATE_ONLY:', '这场会话的结论是什么？', 'synthetic-provider-credential']) assert.equal(diagnosticBytes.includes(marker), false)
  await system.scheduler.stop()
  await system.gateway.shutdown()
  const databasePath = path.join(system.root, 'speech-agent.sqlite3')
  const reopenedService = new StorageWorkerService()
  const reopened = new StorageGateway({ databasePath, hostFactory: () => serviceBackedHost(reopenedService, databasePath), maxRestarts: 0 })
  try {
    await reopened.start()
    const persisted = await reopened.getAgentInteraction({ interactionId: request.targetInteractionId })
    assert.equal(JSON.stringify(buildExportSnapshot(persisted)), before)
    assert.equal(reopenedService.requireStore().database.prepare('SELECT COUNT(*) AS count FROM formal_agent_run_input_plans').get().count, 1)
  } finally { await reopened.shutdown() }
})

test('SEM-F31/F39/SEM-T04/J24-QA-LONG: invalid or out-of-chunk intermediate answers leave no partial result', async (t) => {
  for (const kind of ['size', 'source', 'memory']) await t.test(kind, async (child) => {
    const system = await fixture(child, { segments: 60, targetOutput: (output) => {
      if (kind === 'size') return { ...output, answer: '界'.repeat(3000) }
      if (kind === 'memory') return { ...output, memoryRefs: [{ memoryId: 'memory.fabricated', revisionId: 'revision.fabricated' }] }
      if (system.calls.target === 2) return { ...output, sourceRefs: [{ sessionId: 'session.qa.window', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 1 }] }
      return output
    } })
    const request = await ask(system)
    assert.equal(request.state, 'failed')
    assert.equal(request.errorCode, 'AGENT_OUTPUT_INVALID')
    assert.equal(system.calls.target, kind === 'source' ? 2 : 1)
    const detail = await system.gateway.getAgentInteraction({ interactionId: request.targetInteractionId })
    assert.equal(detail.interaction.result, null)
    assert.equal(detail.interaction.attemptCount, 1)
    assert.equal(buildExportSnapshot(detail).result, null)
  })
})

test('SEM-F31/F39/J24-QA-LONG: whole-input and necessary merge capacity reject before QA egress', async (t) => {
  for (const options of [{ text: 'x'.repeat(4 * 1024 * 1024 + 1), segments: 1 }, { maxInputTokens: 16000, segments: 60 }]) {
    await t.test(options.segments === 1 ? 'whole input' : 'merge envelope', async (child) => {
      const system = await fixture(child, options)
      const request = await ask(system)
      assert.equal(request.errorCode, 'AGENT_QA_INPUT_LIMIT_EXCEEDED')
      assert.equal(system.calls.target, 0)
      assert.equal(system.service.requireStore().database.prepare('SELECT COUNT(*) AS count FROM formal_agent_run_input_plans').get().count, 0)
      assert.equal((await system.gateway.getAgentInteraction({ interactionId: request.targetInteractionId })).interaction.result, null)
    })
  }
})

test('SEM-F31/F39/J24-QA-LONG: known provider totals exhaust the run before another chunk', async (t) => {
  const system = await fixture(t, { segments: 60, usage: { prompt_tokens: 16000000, completion_tokens: 1 } })
  const request = await ask(system)
  assert.equal(request.errorCode, 'AGENT_BUDGET_EXCEEDED')
  assert.equal(system.calls.target, 1)
  const plan = system.service.requireStore().database.prepare('SELECT input_tokens,output_tokens FROM formal_agent_run_input_plans WHERE run_id=?').get(request.targetRunId)
  assert.deepEqual({ ...plan }, { input_tokens: 16000000, output_tokens: 1 })
  assert.equal((await system.gateway.getAgentInteraction({ interactionId: request.targetInteractionId })).interaction.result, null)
})

test('SEM-F28/F31/J24-QA-LONG/J30-CANCEL: cancelling during merge rejects the late final answer', async (t) => {
  let resolveResponse
  const response = new Promise((resolve) => { resolveResponse = resolve })
  const system = await fixture(t, { segments: 60, targetResponse: (output, body) => {
    const plan = JSON.parse(body.messages.find((message) => message.role === 'user').content).questionPlan
    if (plan.stage === 'merge') return response
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }) }
  } })
  const pending = ask(system)
  await waitFor(() => system.calls.merges.length === 1)
  const row = system.service.requireStore().database.prepare('SELECT request_id,generation,validated_chunk_count,total_chunk_count FROM formal_agent_requests WHERE action=?').get('question')
  assert.equal(row.validated_chunk_count, row.total_chunk_count)
  assert.equal((await system.questionRuns.cancel({ contract_id: contract.CONTRACT_ID, contract_version: contract.CONTRACT_VERSION,
    request_id: row.request_id, generation: row.generation })).ok, true)
  const calls = system.calls.target
  resolveResponse({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(system.answer) } }] }) })
  const request = await pending
  assert.equal(request.state, 'cancelled')
  assert.equal(system.calls.target, calls)
  assert.equal((await system.gateway.getAgentInteraction({ interactionId: request.targetInteractionId })).interaction.result, null)
})

test('SEM-F31/F39/J24-QA-LONG: a retried attempt reuses plan and binding without resetting known counters', async (t) => {
  let failed = false
  const system = await fixture(t, { segments: 60, usage: { prompt_tokens: 100, completion_tokens: 10 },
    targetResponse: (output) => {
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => {
        if (!failed && system.calls.target === 2) {
          failed = true
          throw Object.assign(new Error('synthetic response deadline'), { code: 'AGENT_PROVIDER_TIMEOUT', retryable: false })
        }
        return JSON.stringify({ usage: { prompt_tokens: 100, completion_tokens: 10 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] })
      } }
    }
  })
  const request = await ask(system)
  assert.equal(request.state, 'succeeded', request.errorCode)
  const db = system.service.requireStore().database
  const run = db.prepare('SELECT attempt_count,max_attempts FROM formal_agent_runs WHERE run_id=?').get(request.targetRunId)
  assert.deepEqual({ ...run }, { attempt_count: 2, max_attempts: 2 })
  const reservations = db.prepare('SELECT attempt,request_sequence,usage_json FROM formal_agent_model_request_reservations WHERE run_id=? ORDER BY attempt,request_sequence').all(request.targetRunId)
  assert.deepEqual(reservations.filter((row) => row.attempt === 1).map((row) => row.request_sequence), [1, 2])
  assert.equal(reservations.find((row) => row.attempt === 2).request_sequence, 1)
  const firstDigests = db.prepare('SELECT DISTINCT operation_digest FROM formal_agent_model_request_reservations WHERE run_id=? AND request_sequence=1').all(request.targetRunId)
  assert.equal(firstDigests.length, 1)
  const plan = db.prepare('SELECT usage_known,input_tokens,output_tokens FROM formal_agent_run_input_plans WHERE run_id=?').get(request.targetRunId)
  assert.equal(plan.usage_known, 0)
  assert.equal(plan.input_tokens, (system.calls.target - 1) * 100)
  assert.equal(plan.output_tokens, (system.calls.target - 1) * 10)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM agent_model_run_bindings WHERE run_id=?').get(request.targetRunId).count, 1)
  assert.equal((await system.gateway.getAgentInteraction({ interactionId: request.targetInteractionId })).interaction.usage, null)
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM formal_agent_run_input_plans WHERE run_id=?').get(request.targetRunId).count, 1)
})

test('SEM-F31/F39/J24-QA-LONG: chunk and merge loops share one attempt tool budget', async (t) => {
  const system = await fixture(t, { segments: 240, targetResponse: (output, body) => ({ ok: true, status: 200,
    headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{
      finish_reason: body.messages.some((message) => message.role === 'tool') ? 'stop' : 'tool_calls',
      message: body.messages.some((message) => message.role === 'tool') ? { content: JSON.stringify(output) }
        : { content: null, tool_calls: [{ id: `qa-tool-${system.calls.target}`, type: 'function', function: {
          name: 'search_context', arguments: JSON.stringify({ schemaVersion: 1, aliasKeys: [`qa-no-match-${system.calls.target}`] }) } }] }
    }] }) }) })
  const request = await ask(system)
  assert.equal(request.errorCode, 'AGENT_BUDGET_EXCEEDED')
  const detail = await system.gateway.getAgentInteraction({ interactionId: request.targetInteractionId })
  assert.equal(detail.interaction.result, null)
  assert.equal(detail.toolCalls.length, 12)
  assert.equal(detail.toolCalls.filter((call) => call.status === 'succeeded').length, 11)
  assert.equal(detail.toolCalls.at(-1).errorCode, 'TOOL_BUDGET_EXCEEDED')
  assert.deepEqual(detail.toolCalls.map((call) => call.callOrder), Array.from({ length: 12 }, (_, index) => index + 1))
})

test('SEM-F31/F39/J22-QA-LONG: memory references obtained through real tools survive all merge levels', async (t) => {
  const system = await fixture(t, { segments: 60, seedMemory: true, targetResponse: (output, body) => {
    const tool = body.messages.find((message) => message.role === 'tool')
    const plan = JSON.parse(body.messages.find((message) => message.role === 'user').content).questionPlan
    let message
    if (tool) {
      const memoryRef = JSON.parse(tool.content).matches[0].entries[0].memoryRef
      message = { content: JSON.stringify({ ...output, memoryRefs: [memoryRef] }) }
    } else if (plan.stage === 'leaf' && plan.parts[0].eventOrder === 1) {
      const memory = system.service.requireStore().database.prepare('SELECT semantic_key FROM personal_context_items').get()
      message = { content: null, tool_calls: [{ id: `qa-memory-${system.calls.target}`, type: 'function', function: {
        name: 'search_context', arguments: JSON.stringify({ schemaVersion: 1, aliasKeys: [memory.semantic_key] }) } }] }
    } else {
      const memoryRefs = plan.stage === 'merge' ? [...new Map(plan.parts.flatMap(part => part.output.memoryRefs)
        .map(ref => [JSON.stringify(ref), ref])).values()] : []
      message = { content: JSON.stringify({ ...output, memoryRefs }) }
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }] }) }
  } })
  const request = await ask(system)
  assert.equal(request.state, 'succeeded', request.errorCode)
  const detail = await system.gateway.getAgentInteraction({ interactionId: request.targetInteractionId })
  const memory = system.service.requireStore().database.prepare('SELECT memory_id,current_revision_id FROM personal_context_items').get()
  assert.deepEqual(detail.interaction.result.memoryRefs, [{ memoryId: memory.memory_id, revisionId: memory.current_revision_id }])
  assert.equal(detail.toolCalls.length, 1)
  assert.equal(detail.toolCalls.every((call) => call.status === 'succeeded'), true)
})

test('SEM-F28/F31/J24-QA-LONG: withdrawing memory during merge rejects the late answer', async (t) => {
  let resolveResponse
  let heldOutput
  const held = new Promise((resolve) => { resolveResponse = resolve })
  const system = await fixture(t, { segments: 60, seedMemory: true, targetResponse: (output, body) => {
    const plan = JSON.parse(body.messages.find((message) => message.role === 'user').content).questionPlan
    if (plan.stage === 'merge' && heldOutput === undefined) {
      heldOutput = output
      return held
    }
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }) }
  } })
  const pending = ask(system)
  await waitFor(() => heldOutput !== undefined)
  const memory = system.service.requireStore().database.prepare('SELECT memory_id,item_revision FROM personal_context_items').get()
  try {
    await system.gateway.personalContextManage({ type: 'forget', expected_revision: 1,
      item_id: memory.memory_id, item_revision: memory.item_revision })
  } finally {
    resolveResponse({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(heldOutput) } }] }) })
  }
  const request = await pending
  assert.equal(request.state, 'failed')
  assert.equal(request.errorCode, 'AGENT_REQUEST_INVALID')
  const detail = await system.gateway.getAgentInteraction({ interactionId: request.targetInteractionId })
  assert.equal(detail.interaction.result, null)
  assert.equal(detail.interaction.attemptCount, 1)
  assert.equal(buildExportSnapshot(detail).result, null)
})

test('SEM-F31/F39/J30-QA-RECOVERY/DB1: interrupted QA retains accounting and requires an explicit new question', async (t) => {
  let resolveResponse
  const held = new Promise((resolve) => { resolveResponse = resolve })
  const system = await fixture(t, { segments: 60, usage: { prompt_tokens: 100, completion_tokens: 10 }, targetResponse: (output) => {
    if (system.calls.target === 2) return held
    return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({
      usage: { prompt_tokens: 100, completion_tokens: 10 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }] }) }
  } })
  const accepted = await system.questionRuns.accept({ contract_id: contract.CONTRACT_ID, contract_version: contract.CONTRACT_VERSION,
    action: 'question', prompt: '这场会话的结论是什么？', scope: { kind: 'session', reference: 'session.qa.window' }, client_request_key: 'qa-interrupted' })
  assert.equal(accepted.ok, true)
  const requestId = accepted.result.snapshot.request_id
  system.scheduler.start()
  await waitFor(() => system.calls.target === 2)
  const interrupted = await system.gateway.getSessionSummaryRequest({ requestId })
  const planBefore = system.service.requireStore().database.prepare('SELECT plan_digest,input_tokens FROM formal_agent_run_input_plans WHERE run_id=?').get(interrupted.targetRunId)
  await system.scheduler.stop()
  await waitFor(() => !system.scheduler.draining)
  await system.gateway.shutdown()
  const databasePath = path.join(system.root, 'speech-agent.sqlite3')
  const service = new StorageWorkerService()
  const gateway = new StorageGateway({ databasePath, hostFactory: () => serviceBackedHost(service, databasePath), maxRestarts: 0 })
  let resumed
  try {
    await gateway.start()
    const modelAccess = new ModelAccessRuntime({ gateway, vault: system.vault, adapter: system.adapter })
    await modelAccess.initialize()
    resumed = system.runtimeFactory(gateway, modelAccess)
    resumed.diagnostics = system.diagnostics
    assert.equal(resumed.promptStore.size, 0)
    await resumed.questionRuns.recoverAfterRestart()
    const recovered = await gateway.getSessionSummaryRequest({ requestId })
    assert.equal(recovered.state, 'failed')
    assert.equal(recovered.errorCode, 'AGENT_REQUEST_INVALID')
    assert.equal(recovered.resumeRequired, true)
    assert.equal(recovered.scope.reference, 'session.qa.window')
    const listed = await resumed.questionRuns.listRecoverable({ contract_id: contract.CONTRACT_ID, contract_version: contract.CONTRACT_VERSION })
    assert.equal(listed.result.requests.length, 1)
    resumed.scheduler.start()
    await waitFor(() => !resumed.scheduler.draining)
    assert.equal(system.calls.target, 2)
    const db = service.requireStore().database
    assert.deepEqual({ ...db.prepare('SELECT plan_digest,input_tokens FROM formal_agent_run_input_plans WHERE run_id=?').get(interrupted.targetRunId) }, { ...planBefore })
    const account = db.prepare('SELECT conservative_elapsed_ms,request_count FROM formal_agent_run_budget_state WHERE run_id=?').get(interrupted.targetRunId)
    assert.ok(account.conservative_elapsed_ms >= 30000)
    assert.equal(account.request_count, 2)
    resolveResponse({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(system.answer) } }] }) })
    const newRequest = await ask(resumed, { client_request_key: 'qa-resubmitted', resubmits_request_id: requestId })
    assert.equal(newRequest.state, 'succeeded', newRequest.errorCode)
    assert.notEqual(newRequest.targetRunId, interrupted.targetRunId)
    assert.equal((await gateway.getSessionSummaryRequest({ requestId })).resumeRequired, false)
    assert.equal((await gateway.getAgentInteraction({ interactionId: interrupted.targetInteractionId })).interaction.result, null)
    assert.equal(db.prepare('SELECT request_count FROM formal_agent_run_budget_state WHERE run_id=?').get(interrupted.targetRunId).request_count, 2)
  } finally {
    if (resumed) await resumed.scheduler.stop()
    await gateway.shutdown()
  }
})
