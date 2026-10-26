'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { CredentialVault } = require('../../src/agent/model-access/credential-vault')
const { ModelAccessRuntime } = require('../../src/agent/model-access/runtime')
const { OpenAiCompatibleAdapter } = require('../../src/agent/model-access/openai-compatible-adapter')
const { RemoteModelCatalogPullController } = require('../../src/agent/model-access/remote-catalog-controller')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')
const { OPERATIONS, PROTOCOL_VERSION, StorageError } = require('../../src/runtime/storage-worker/protocol')
const CHANNELS = require('../../src/main/ipc/channels')
const { registerModelAccessIpc } = require('../../src/main/ipc/model-access-ipc')
const { canonicalize, sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')
const { fauxProvider } = require('./faux-provider')
const { assertModelUsage, normalizeDeepSeekUsage } = require('../../src/agent/contracts/model-access-core')

const capabilities = { maxInputTokens: 64000, maxOutputTokens: 4096, supportsToolCalling: true, supportsStructuredOutput: true, supportsStreaming: true, usageReporting: true }
const contract = { contractId: 'agent-model-ui', contractVersion: '1.0.0' }

function serviceBackedHost (service, databasePath) {
  let sequence = 0
  const call = (operation, payload) => {
    const response = service.handle({
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId: `s2-core.${++sequence}`,
      operation,
      payload
    })
    if (!response.ok) throw new StorageError(response.error.code)
    return response.result
  }
  return {
    state: 'stopped',
    async start () { call(OPERATIONS.INITIALIZE, { databasePath }); this.state = 'ready' },
    async modelAccessCatalog () { return call(OPERATIONS.MODEL_ACCESS_CATALOG, {}) },
    async modelAccessConfigure (input) { return call(OPERATIONS.MODEL_ACCESS_CONFIGURE, { input }) },
    async modelAccessBind (request, availableSlotIds) { return call(OPERATIONS.MODEL_ACCESS_BIND, { request, availableSlotIds }) },
    async shutdown () { if (!service.shuttingDown) call(OPERATIONS.SHUTDOWN, {}); this.state = 'closed' },
    async terminateAndWait () { if (!service.shuttingDown) call(OPERATIONS.SHUTDOWN, {}); this.state = 'closed'; return 0 }
  }
}

test('SEM-F00/SEM-F33/J25: S2 Core configures two profiles, resolves fallback, binds immutably and keeps remote suggestions transient', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-access-s2-'))
  const databasePath = path.join(root, 'speech-agent.sqlite3')
  const service = new StorageWorkerService()
  const gateway = new StorageGateway({
    databasePath,
    hostFactory: () => serviceBackedHost(service, databasePath),
    maxRestarts: 0
  })
  await gateway.start()
  const subtitleStore = service.requireStore()
  const vault = new CredentialVault({ directory: path.join(root, 'vault'), safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value).reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString()
  } })
  t.after(async () => { vault.close(); await gateway.shutdown().catch(() => gateway.terminate()); fs.rmSync(root, { recursive: true, force: true }) })
  const changes = []
  const sent = []; const borrowed = []; const authReleaseObservations = []
  let observeAuthRelease = false
  let networkReply = () => new Response(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: {
    content: null, reasoning_content: 'private-reasoning', tool_calls: [
      { id: 'call.second', type: 'function', function: { name: 'second', arguments: '{"value":2}' } },
      { id: 'call.first', type: 'function', function: { name: 'first', arguments: '{"value":1}' } }
    ]
  } }] }))
  const adapter = new OpenAiCompatibleAdapter({ fetch: async (url, options) => {
    sent.push({ url, options }); return networkReply()
  } })
  const originalExchange = adapter.exchange.bind(adapter)
  adapter.exchange = input => { borrowed.push(input.credential); return originalExchange(input) }
  const runtime = new ModelAccessRuntime({ gateway, vault, adapter, onChanged: ({ revision }) => {
    changes.push(revision)
    if (observeAuthRelease) authReleaseObservations.push(borrowed.every(buffer => buffer.every(byte => byte === 0)))
  } })
  await runtime.initialize()
  const pullController = new RemoteModelCatalogPullController({ runtime, gateway, vault, adapter: fauxProvider() })
  const handlers = new Map()
  registerModelAccessIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    authorize: (event) => { if (event.role !== 'settings') throw new Error('denied') },
    getRuntime: () => runtime,
    getPullController: () => pullController
  })
  const settings = { role: 'settings' }
  const getCatalog = () => handlers.get(CHANNELS.AGENT_MODEL_GET_CATALOG)(settings, contract)
  let snapshot = (await getCatalog()).snapshot
  assert.equal(snapshot.profiles[0].models.length, 0)
  assert.equal(snapshot.readinessByPurpose.default.singleShot, 'provider_not_configured')

  const configure = async (command) => {
    const revision = (await getCatalog()).snapshot.revision
    const result = await handlers.get(CHANNELS.AGENT_MODEL_CONFIGURE)(settings, { ...contract, command: { ...command, expectedRevision: revision } })
    assert.equal(result.ok, true, JSON.stringify(result))
  }
  await configure({ type: 'addModel', profileId: 'deepseek', modelId: 'deepseek-v4-flash', capabilities })
  await configure({ type: 'setCredential', profileId: 'deepseek', credential: 'synthetic-secret' })
  await configure({ type: 'assignPurpose', purpose: 'default', target: { profileId: 'deepseek', modelId: 'deepseek-v4-flash' } })
  await configure({ type: 'createProfile', profileId: 'local.profile', label: 'Local Profile', httpsOrigin: 'https://localhost:8443', basePath: '/v1' })
  await configure({ type: 'addModel', profileId: 'local.profile', modelId: 'local-model', capabilities: { ...capabilities, supportsToolCalling: false } })
  snapshot = (await getCatalog()).snapshot
  assert.equal(snapshot.readinessByPurpose.summary.assignmentMode, 'fallback_default')
  assert.equal(snapshot.readinessByPurpose.default.singleShot, 'ready')
  assert.deepEqual(changes, [1, 2, 3, 4, 5])

  const runId = 'run.s2.binding'
  const bindRun = async (id) => {
    subtitleStore.database.prepare(`INSERT INTO formal_agent_runs(
    run_id,dedupe_key,request_digest,recipe_id,recipe_version,scope_json,scope_digest,
    transcript_version,input_watermark_json,input_digest,requested_by,state,attempt_count,
    max_attempts,next_attempt_at,created_at,updated_at
  ) VALUES(?,?,?,'context.ingest.session','1',?,?, 'raw',?,?, 'automatic','queued',0,3,0,1000,1000)`)
      .run(id, sha256Canonical({ runId: id }), sha256Canonical({ request: id }), canonicalize({ kind: 'session' }), sha256Canonical({ scope: id }), canonicalize({ throughEventOrder: 1 }), sha256Canonical({ input: id }))
    return runtime.bind({ runId: id, recipeId: 'context.ingest.session', recipeVersion: '1', executionForm: 'agent_loop' })
  }
  const binding = await bindRun(runId)
  await configure({ type: 'updateModel', profileId: 'deepseek', modelId: 'deepseek-v4-flash', capabilities: { ...capabilities, maxOutputTokens: 2048 } })
  assert.deepEqual(await runtime.bind({ runId, recipeId: 'context.ingest.session', recipeVersion: '1', executionForm: 'agent_loop' }), binding)

  const beforePull = (await getCatalog()).snapshot.revision
  const suggestions = await handlers.get(CHANNELS.AGENT_MODEL_PULL_REMOTE_CATALOG)(settings, {
    ...contract, profileId: 'deepseek', expectedRevision: beforePull
  })
  assert.equal(suggestions.status, 'success')
  assert.equal((await getCatalog()).snapshot.revision, beforePull)
  assert.equal(service.requireModelAccessStore().internalCatalog().profiles.find((p) => p.profile_id === 'deepseek').models.length, 1)

  await configure({ type: 'setCredential', profileId: 'local.profile', credential: 'local-synthetic-secret' })
  const beforeAuth = (await getCatalog()).snapshot
  assert.equal(beforeAuth.profiles.find((profile) => profile.profileId === 'deepseek').credential.present, true)
  assert.equal(beforeAuth.profiles.find((profile) => profile.profileId === 'local.profile').credential.present, true)
  const authController = new RemoteModelCatalogPullController({ runtime, gateway, vault, adapter: fauxProvider('auth') })
  assert.equal((await authController.pull({ profileId: 'deepseek', expectedRevision: beforeAuth.revision })).status, 'credential_unavailable')
  const afterAuth = (await getCatalog()).snapshot
  assert.equal(afterAuth.revision, beforeAuth.revision + 1)
  assert.deepEqual(afterAuth.profiles.find((profile) => profile.profileId === 'deepseek').credential, { present: false, scope: 'absent' })
  assert.deepEqual(afterAuth.profiles.find((profile) => profile.profileId === 'local.profile').credential, { present: true, scope: 'persistent' })
  assert.deepEqual(changes, [1, 2, 3, 4, 5, 6, 7, 8])

  /* v7 的 formal_agent_interactions 由共享 migration 链建立，S2 边界不拥有它：
     表存在是 schema 事实，S2 必须对它零写入。 */
  assert.equal(subtitleStore.database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='formal_agent_interactions'").get().count, 1)
  assert.equal(subtitleStore.database.prepare('SELECT COUNT(*) AS count FROM formal_agent_interactions').get().count, 0)
  assert.equal(JSON.stringify(snapshot).includes('credentialSlotId'), false)
  assert.equal(/price|cost|currency|pricing/i.test(JSON.stringify(binding)), false)

  // The settings IPC, frozen SQLite binding, real adapter and vault all take
  // part. Only the provider network and system encryption are controlled.
  const request = {
    schemaVersion: 1, messages: [{ role: 'user', content: 'Return ordered tool calls.' }],
    tools: ['first', 'second'].map(name => ({ name, parameters: { type: 'object' } })),
    outputContract: { mode: 'json' },
    limits: { maxOutputTokens: 128, maxRequestBytes: 512 * 1024, maxResponseBytes: 512 * 1024,
      timeoutMs: 1000, inputByteLimit: null, inputLimitError: 'AGENT_BUDGET_EXCEEDED' }
  }
  await assert.rejects(runtime.exchangeWithBinding(binding, { request }), { code: 'AGENT_PROVIDER_AUTH_FAILED' })
  assert.equal(sent.length, 0, 'revoked credentials reject before network egress')
  await configure({ type: 'setCredential', profileId: 'deepseek', credential: 'synthetic-secret' })
  // Reconfiguration assigns a new slot; it must not resurrect the old binding.
  await assert.rejects(runtime.exchangeWithBinding(binding, { request }), { code: 'AGENT_PROVIDER_AUTH_FAILED' })
  const exchangeBinding = await bindRun('run.s2.exchange')
  const factsBefore = subtitleStore.database.prepare('SELECT total_changes() AS count').get().count
  const result = await runtime.exchangeWithBinding(exchangeBinding, { request })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, 'https://api.deepseek.com/chat/completions')
  assert.equal(JSON.parse(sent[0].options.body).model, binding.modelId)
  assert.equal(sent[0].options.headers.authorization, '')
  assert.deepEqual(result.message.toolCalls.map(call => [call.id, call.name, call.arguments.value]), [
    ['call.second', 'second', 2], ['call.first', 'first', 1]
  ])
  assert.equal(result.usage, null)
  assert.equal(JSON.stringify(result).includes('private-reasoning'), false)
  assert.equal(borrowed.at(-1).every(byte => byte === 0), true)
  assert.equal(subtitleStore.database.prepare('SELECT total_changes() AS count').get().count, factsBefore)

  networkReply = () => new Response('private-provider-error', { status: 429 })
  await assert.rejects(runtime.exchangeWithBinding(exchangeBinding, { request }), { code: 'AGENT_PROVIDER_RATE_LIMITED' })
  assert.equal(sent.length, 2, 'exchange does not retry provider failures')
  assert.equal(borrowed.at(-1).every(byte => byte === 0), true)

  networkReply = () => { throw new Error('private-network-exception') }
  await assert.rejects(runtime.exchangeWithBinding(exchangeBinding, { request }), error =>
    error.code === 'AGENT_PROVIDER_UNAVAILABLE' && !error.message.includes('private-network-exception'))
  assert.equal(sent.length, 3)
  assert.equal(borrowed.at(-1).every(byte => byte === 0), true)

  let resolveLate; let enterFetch
  const entered = new Promise(resolve => { enterFetch = resolve })
  networkReply = () => new Promise(resolve => { resolveLate = resolve; enterFetch() })
  const controller = new AbortController(); const events = []
  const pending = runtime.exchangeWithBinding(exchangeBinding, { request, signal: controller.signal, onProgress: event => events.push(event.type) })
  await entered; controller.abort()
  await assert.rejects(pending, { code: 'AGENT_CANCELLED' })
  assert.equal(borrowed.at(-1).every(byte => byte === 0), true)
  resolveLate(new Response('{}'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, ['request_started'])

  networkReply = () => new Promise(() => {})
  await assert.rejects(runtime.exchangeWithBinding(exchangeBinding, {
    request: { ...request, limits: { ...request.limits, timeoutMs: 20 } }
  }), { code: 'AGENT_PROVIDER_TIMEOUT' })
  assert.equal(borrowed.at(-1).every(byte => byte === 0), true)
  networkReply = () => new Response('private-auth-error', { status: 401 })
  observeAuthRelease = true
  await assert.rejects(runtime.exchangeWithBinding(exchangeBinding, { request }), { code: 'AGENT_PROVIDER_AUTH_FAILED' })
  assert.deepEqual(authReleaseObservations, [true], 'borrowed credentials clear before real SQLite auth invalidation publishes')
  await assert.rejects(runtime.exchangeWithBinding(exchangeBinding, { request }), { code: 'AGENT_PROVIDER_AUTH_FAILED' })
  assert.equal(sent.length, 6, 'revocation between exchanges prevents the next outbound')
  assert.equal(borrowed.every(buffer => buffer.every(byte => byte === 0)), true)
})

test('SEM-F33/J25: faux provider freezes provider usage, unknown usage, cache and bounded credential protocol without inference', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-access-usage-'))
  const vault = new CredentialVault({ directory: path.join(root, 'vault'), safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value).reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString()
  } })
  t.after(() => { vault.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const state = vault.set(slot, 'usage-secret')
  let borrowed
  const complete = async (scenario) => vault.borrow(slot, 'persistent', state.generation, async (credential) => {
    borrowed = credential
    return fauxProvider(scenario).complete({ credential })
  })

  assert.deepEqual(normalizeDeepSeekUsage((await complete('usage-cache-hit')).usage), {
    inputTokens: 1000, outputTokens: 200, usageSource: 'provider',
    cacheHitInputTokens: 250, cacheMissInputTokens: 750
  })
  assert.equal(borrowed.every((byte) => byte === 0), true)
  assert.deepEqual(normalizeDeepSeekUsage((await complete('usage-no-cache')).usage), {
    inputTokens: 1000, outputTokens: 200, usageSource: 'provider',
    cacheHitInputTokens: null, cacheMissInputTokens: null
  })
  assert.deepEqual(normalizeDeepSeekUsage((await complete('usage-inconsistent-cache')).usage), {
    inputTokens: 1000, outputTokens: 200, usageSource: 'provider',
    cacheHitInputTokens: null, cacheMissInputTokens: null
  })
  assert.equal((await complete('usage-absent')).usage, null)
  assert.throws(() => assertModelUsage({
    inputTokens: 900, outputTokens: 180, usageSource: 'estimated',
    cacheHitInputTokens: null, cacheMissInputTokens: null
  }), /usageSource/)

  const barrierProvider = fauxProvider('barrier')
  const pending = vault.borrow(slot, 'persistent', state.generation, (credential) => barrierProvider.complete({ credential }))
  await barrierProvider.entered
  barrierProvider.release()
  assert.equal((await pending).usage.prompt_tokens, 1)
})
