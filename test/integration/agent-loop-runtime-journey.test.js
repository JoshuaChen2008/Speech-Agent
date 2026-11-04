'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { ModelAccessRuntime } = require('../../src/agent/model-access/runtime')
const { CredentialVault } = require('../../src/agent/model-access/credential-vault')
const { createPersonalContextExecutionAdapter } = require('../../src/agent/personal-context')
const { FormalAgentRunRunner, FormalAgentJobScheduler } = require('../../src/agent/execution-host')
const { sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')
const { transport } = require('./helpers/context-storage-transport')
const { createNetworkAdapter, providerResponse } = require('./provider-network-fixture')

async function fixture (t, respond, { cancelAfterTool = false, loseReservationReply = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-pi-journey-'))
  const databasePath = path.join(root, 'state.sqlite3')
  const service = new StorageWorkerService()
  const gateway = new StorageGateway({ databasePath, maxRestarts: 0, hostFactory: () => {
    const host = transport(service, databasePath)
    const reserve = host.reserveFormalAgentModelRequest
    host.reserveFormalAgentModelRequest = async request => {
      const receipt = await reserve(request)
      if (loseReservationReply) throw new Error('controlled IPC receipt loss')
      return receipt
    }
    return host
  } })
  await gateway.start()
  const vault = new CredentialVault({ directory: path.join(root, 'vault'), safeStorage: { isEncryptionAvailable: () => false } })
  let requests = 0
  const adapter = createNetworkAdapter({ fetch: async (_url, options) => {
    requests++
    const reserved = service.requireStore().database.prepare('SELECT COUNT(*) AS count FROM formal_agent_model_operation_attempts').get()
    assert.equal(Number(reserved.count), requests, 'each HTTP attempt has a confirmed persistent reservation')
    return respond(JSON.parse(options.body), requests)
  } })
  const modelAccess = new ModelAccessRuntime({ gateway, vault, adapter })
  await modelAccess.initialize()
  const capabilities = { maxInputTokens: 64000, maxOutputTokens: 4096, supportsToolCalling: true,
    supportsStructuredOutput: true, supportsStreaming: false, usageReporting: true }
  for (const command of [
    { type: 'addModel', profileId: 'deepseek', modelId: 'pi-journey-model', capabilities },
    { type: 'setCredential', profileId: 'deepseek', credential: 'synthetic-secret' },
    { type: 'assignPurpose', purpose: 'default', target: { profileId: 'deepseek', modelId: 'pi-journey-model' } }
  ]) {
    const catalog = await modelAccess.catalog()
    assert.equal((await modelAccess.configure({ ...command, expectedRevision: catalog.snapshot.revision })).ok, true)
  }
  const recorder = new SqliteSessionRecorder({ gateway })
  const sessionId = 'session.pi.journey'
  await recorder.openSession({ sessionId, sourceId: 'mic', refinementEnabled: false })
  await recorder.acceptCaption({ schemaVersion: 1, sessionId, sourceId: 'mic', segmentId: 'segment.pi', sequence: 1,
    revision: 1, kind: 'final', t0: 0, t1: 10, text: '合成会话事实', translation: null })
  await recorder.closeSession({ sessionId, sourceId: 'mic', state: 'closed' })
  const source = await gateway.derivePersonalContextSessionSource({ sessionId, transcriptVersion: 'raw' })
  const runId = 'run.pi.journey'; const interactionId = 'interaction.pi.journey'
  await gateway.createAgentRun({ runId, recipeId: 'qa.answer', recipeVersion: '1', scope: { kind: 'session', reference: sessionId },
    transcriptVersion: 'raw', inputWatermark: { throughEventOrder: source.inputWatermark }, inputDigest: source.inputDigest,
    requestedBy: 'user', clientIdempotencyKey: 'pi.journey.request' })
  await modelAccess.bind({ runId, recipeId: 'qa.answer', recipeVersion: '1', executionForm: 'agent_loop' })
  await gateway.createAgentInteraction({ runId, interactionId, routingMode: 'preset', promptDigest: sha256Canonical('会话重点') })
  let scheduler
  const runner = new FormalAgentRunRunner({ storage: gateway, personalContext: createPersonalContextExecutionAdapter({ storage: gateway }),
    modelAccess, promptProvider: () => '会话重点', interactions: {
      terminalize: request => gateway.terminalizeAgentInteraction(request),
      startToolCall: request => gateway.startAgentToolCall(request),
      finishToolCall: async request => {
        const receipt = await gateway.finishAgentToolCall(request)
        if (cancelAfterTool) scheduler.cancel(runId)
        return receipt
      }
    } })
  scheduler = new FormalAgentJobScheduler({ storage: gateway, runner, requestedBy: 'user', owner: 'pi.journey.scheduler' })
  t.after(async () => { await scheduler.stop(); vault.close(); await gateway.shutdown(); fs.rmSync(root, { recursive: true, force: true }) })
  scheduler.start()
  const database = service.requireStore().database
  const deadline = Date.now() + 8000
  let run
  while (Date.now() < deadline) {
    run = database.prepare('SELECT state,attempt_count,error_code,retry_policy_version FROM formal_agent_runs WHERE run_id=?').get(runId)
    if (['succeeded', 'failed', 'cancelled'].includes(run.state)) break
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  assert.ok(['succeeded', 'failed', 'cancelled'].includes(run.state), JSON.stringify(run))
  return { run, requests, database, interactionId }
}

function twoTools () {
  return providerResponse(null, [1, 2].map(order => ({ id: `call.${order}`, type: 'function',
    function: { name: 'search_context', arguments: JSON.stringify({ schemaVersion: 1, aliasKeys: ['none'] }) } })))
}

test('SEM-F28/F31/F33/F40/J22/J24/J30-RECOVERY: real scheduler and Pi reserve retries and audit tools in order', async t => {
  const f = await fixture(t, (_body, count) => count === 1
    ? { status: 503, ok: false, headers: { get: name => name === 'retry-after' ? '0' : null } }
    : count === 2 ? twoTools() : providerResponse({ schemaVersion: 1, answer: '已核对合成会话。', sourceRefs: [], memoryRefs: [], unresolved: [] }, [],
      { prompt_tokens: 3, completion_tokens: 2 }))
  assert.equal(f.run.state, 'succeeded', JSON.stringify(f.run)); assert.equal(f.run.retry_policy_version, 'agent-retry@2')
  assert.equal(f.run.attempt_count, 1); assert.equal(f.requests, 3)
  const tools = f.database.prepare('SELECT attempt,call_order,status FROM formal_agent_tool_calls ORDER BY call_order').all()
  assert.deepEqual(tools.map(row => ({ ...row })), [{ attempt: 1, call_order: 1, status: 'succeeded' }, { attempt: 1, call_order: 2, status: 'succeeded' }])
  const usage = f.database.prepare('SELECT usage_json FROM formal_agent_interactions WHERE interaction_id=?').get(f.interactionId)
  assert.equal(usage.usage_json, null)
})

test('SEM-F28/F31/F40/J22/J24/J30-CANCEL: cancellation after the first audited tool prevents the second tool and next request', async t => {
  const f = await fixture(t, () => twoTools(), { cancelAfterTool: true })
  assert.equal(f.run.state, 'cancelled', JSON.stringify(f.run)); assert.equal(f.requests, 1)
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_tool_calls').get().count, 1)
  assert.equal(f.database.prepare('SELECT result_json FROM formal_agent_interactions').get().result_json, null)
})

test('SEM-F28/F40/J30-RECOVERY: a committed reservation with a lost receipt causes zero provider requests', async t => {
  const f = await fixture(t, () => { throw new Error('provider egress forbidden') }, { loseReservationReply: true })
  assert.equal(f.requests, 0); assert.equal(f.run.state, 'failed')
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_model_operation_attempts').get().count, 1)
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_tool_calls').get().count, 0)
})

test('SEM-F28/F40/J30-RECOVERY: five confirmed transient attempts terminalize without an outer replay', async t => {
  const f = await fixture(t, () => ({ status: 503, ok: false, headers: { get: name => name === 'retry-after' ? '0' : null } }))
  assert.equal(f.requests, 5); assert.equal(f.run.state, 'failed')
  assert.equal(f.run.attempt_count, 1); assert.equal(f.run.error_code, 'AGENT_PROVIDER_UNAVAILABLE')
  assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_model_operation_attempts').get().count, 5)
})

for (const [label, name, args, auditCount] of [
  ['malformed argument JSON', 'search_context', '{', 0],
  ['tool outside recipe grants', 'ungranted_tool', '{}', 0],
  ['controlled tool Schema rejection', 'search_context', JSON.stringify({ schemaVersion: 1, aliasKeys: [] }), 1]
]) {
  test(`SEM-F31/F40/SEM-T04/J22/J24: ${label} stops the tool batch without another attempt`, async t => {
    const f = await fixture(t, () => {
      const response = twoTools()
      return { ...response, text: async () => {
        const body = JSON.parse(await response.text())
        body.choices[0].message.tool_calls[0].function = { name, arguments: args }
        return JSON.stringify(body)
      } }
    })
    assert.equal(f.requests, 1); assert.equal(f.run.state, 'failed')
    assert.equal(f.run.attempt_count, 1); assert.equal(f.run.error_code, 'AGENT_OUTPUT_INVALID')
    const audits = f.database.prepare('SELECT call_order,status,error_code FROM formal_agent_tool_calls').all()
    assert.equal(audits.length, auditCount)
    if (auditCount) assert.deepEqual({ ...audits[0] }, { call_order: 1, status: 'failed', error_code: 'TOOL_ARGS_INVALID' })
    assert.equal(f.database.prepare('SELECT result_json FROM formal_agent_interactions').get().result_json, null)
  })
}
