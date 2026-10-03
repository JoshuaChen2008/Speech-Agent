'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { AsyncLocalStorage } = require('node:async_hooks')
const { fixture } = require('./helpers/personal-memory-file-fixture')
const { ConfigStore } = require('../../src/main/services/config-store')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { createPersonalContextExecutionAdapter } = require('../../src/agent/personal-context')
const { AgentRunService } = require('../../src/agent/formal-run/agent-run-service')
const { ModelAccessRuntime } = require('../../src/agent/model-access/runtime')
const { CredentialVault } = require('../../src/agent/model-access/credential-vault')
const { FormalAgentRunRunner, FormalAgentJobScheduler } = require('../../src/agent/execution-host')

test('SEM-F42/J22/J24-RETRIEVAL: qa.answer@5 freezes relevant MD tool references beyond the recent twenty and preserves legacy recipe identity', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t)
  const target = (await f.remember('迁移工具采用 SQLite 事务')).item
  for (let i = 0; i < 24; i++) await f.remember(`无关的合成条目 ${i}`)
  const settings = new ConfigStore(path.join(f.directory, 'config.json')); settings.load()
  settings.updateAgentSettings({ expectedRevision: 0, agentEnabled: true, memoryEnabled: true, cloudDisclosureAccepted: true }); Object.assign(f.config, settings.get())
  await f.gateway.applyPersonalContextAutomaticPolicy({ agentEnabled: true, memoryEnabled: true, automaticProcessingSince: settings.get().automaticProcessingSince, memoryProcessingSince: settings.get().memoryProcessingSince })
  const vault = new CredentialVault({ directory: path.join(f.directory, 'llm-credentials'), safeStorage: { isEncryptionAvailable: () => false } })
  let reads = 0
  const modelAccess = await new ModelAccessRuntime({ gateway: f.gateway, vault, adapter: { async run (request) {
    if (request.recipe.recipeId === 'summary.minutes') {
      const result = await request.tools[0].execute({ schemaVersion: 1, aliasKeys: [target.semanticKey] })
      assert.equal(result.matches.length, 0)
      return { text: JSON.stringify({ schemaVersion: 1, overview: '本次总结只使用会话。', conclusions: [], todos: [], risks: [] }) }
    }
    assert.equal(request.recipe.recipeVersion, '5')
    await request.beforeRequest({ turn: 1 }); await request.onRequestUsage(null)
    const result = await request.tools[0].execute({ schemaVersion: 1, aliasKeys: [target.semanticKey] })
    const ref = result.matches[0].entries[0].memoryRef
    assert.equal(ref.memoryId, target.memory_id); reads++
    return { text: JSON.stringify({ schemaVersion: 2, answer: '迁移工具采用 SQLite 事务。', claims: [{ text: '迁移工具采用 SQLite 事务。', sourceRefs: [], memoryRefs: [ref] }], sourceRefs: [], memoryRefs: [ref], unresolved: [], coverage: null }) }
  } } }).initialize()
  modelAccess.embeddingAccess = f.embeddingAccess; f.runtime.modelAccess = modelAccess
  const configure = async command => { const catalog = await modelAccess.catalog(); const response = await modelAccess.configure({ ...command, expectedRevision: catalog.snapshot.revision }); assert.equal(response.ok, true) }
  await configure({ type: 'addModel', profileId: 'deepseek', modelId: 'synthetic-qa', capabilities: { maxInputTokens: 64000, maxOutputTokens: 4096, supportsToolCalling: true, supportsStructuredOutput: true, supportsStreaming: true, usageReporting: false } })
  await configure({ type: 'setCredential', profileId: 'deepseek', credential: 'synthetic-llm-key' })
  await configure({ type: 'assignPurpose', purpose: 'default', target: { profileId: 'deepseek', modelId: 'synthetic-qa' } })
  const recorder = new SqliteSessionRecorder({ gateway: f.gateway }); const sessionId = 'session.hybrid'
  await recorder.openSession({ sessionId, sourceId: 'mic', refinementEnabled: false })
  await recorder.acceptCaption({ schemaVersion: 1, sessionId, sourceId: 'mic', segmentId: 'segment.one', sequence: 1, revision: 1, kind: 'final', t0: 0, t1: 10, text: '系统迁移的合成讨论', translation: null })
  await recorder.closeSession({ sessionId, sourceId: 'mic', state: 'closed' })
  const source = await f.gateway.derivePersonalContextSessionSource({ sessionId, transcriptVersion: 'raw' }); await f.gateway.personalContextIngest(source)
  const prompts = new Map()
  const runner = new FormalAgentRunRunner({ storage: f.gateway, personalContext: createPersonalContextExecutionAdapter({ storage: f.gateway }), modelAccess, promptProvider: id => prompts.get(id),
    interactions: { terminalize: v => f.gateway.terminalizeAgentInteraction(v), startToolCall: v => f.gateway.startAgentToolCall(v), finishToolCall: v => f.gateway.finishAgentToolCall(v) } })
  const scheduler = new FormalAgentJobScheduler({ storage: f.gateway, runner, requestedBy: 'user', owner: 'memory.qa5' })
  const agent = new AgentRunService({ storage: f.gateway, modelAccess, scheduler, promptStore: prompts, getConfig: () => settings.get(), questionRecipeVersion: '5' })
  scheduler.start()
  try {
    const header = { contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0' }
    const submitted = await agent.submit({ ...header, scope: { kind: 'session', reference: sessionId }, prompt: '查找 SQLite 事务' , client_idempotency_key: 'memory.qa5.question' })
    assert.equal(submitted.ok, true)
    let detail; const deadline = Date.now() + 10000
    while (Date.now() < deadline) { detail = await agent.getInteraction({ ...header, interaction_id: submitted.result.interaction_id }); if (detail.ok && ['succeeded', 'failed', 'cancelled'].includes(detail.result.state)) break; await new Promise(resolve => setTimeout(resolve, 10)) }
    assert.equal(detail.result.state, 'succeeded', detail.result.terminal_reason)
    assert.equal(reads, 1); assert.equal(detail.result.recipe_version, '5')
    assert.equal(detail.result.result.memoryRefs[0].memoryId, target.memory_id)
    settings.updateSummaryUseMemory({ expectedRevision: settings.get().agentSettingsRevision, summaryUseMemory: false }); Object.assign(f.config, settings.get())
    // Background filesystem hints are independent of the summary preference.
    // Observe only file work initiated by product requests, forwarding all calls.
    const requestContext = new AsyncLocalStorage()
    const dispatch = f.runtime.dispatch.bind(f.runtime)
    f.runtime.dispatch = (...args) => requestContext.run(args[0], () => dispatch(...args))
    const calls = []; const call = f.runtime.client.call.bind(f.runtime.client)
    f.runtime.client.call = input => { if (requestContext.getStore()) calls.push(input.type); return call(input) }
    const summary = await agent.submit({ ...header, scope: { kind: 'session', reference: sessionId }, prompt: '请基于这场已结束的会话生成会话总结，包含主要内容、决定、待办和需要注意。', client_idempotency_key: 'memory.summary.off' })
    assert.equal(summary.ok, true)
    const end = Date.now() + 10000
    while (Date.now() < end) { detail = await agent.getInteraction({ ...header, interaction_id: summary.result.interaction_id }); if (detail.ok && ['succeeded', 'failed', 'cancelled'].includes(detail.result.state)) break; await new Promise(resolve => setTimeout(resolve, 10)) }
    assert.equal(detail.result.state, 'succeeded', detail.result.terminal_reason)
    assert.equal(calls.includes('scan'), false); assert.equal(calls.includes('vector_rank'), false)
  } finally { await scheduler.stop(); modelAccess.close() }
})
