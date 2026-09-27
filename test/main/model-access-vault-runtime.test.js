'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { CredentialVault } = require('../../src/agent/model-access/credential-vault')
const { ModelAccessRuntime } = require('../../src/agent/model-access/runtime')
const { RemoteModelCatalogPullController } = require('../../src/agent/model-access/remote-catalog-controller')
const { OpenAiCompatibleAdapter } = require('../../src/agent/model-access/openai-compatible-adapter')
const { sanitizedEnvironment } = require('../../src/agent/model-access/environment')

function vault (t, encryptionAvailable = true) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-vault-'))
  const safeStorage = {
    isEncryptionAvailable: () => encryptionAvailable,
    encryptString: (value) => Buffer.from(value, 'utf8').reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString('utf8')
  }
  const instance = new CredentialVault({ directory, safeStorage })
  t.after(() => { instance.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  return { instance, directory }
}

test('SEM-F14/SEM-F33/J25: persistent and session-only credentials remain main-owned and borrowed copies clear', async (t) => {
  const persistent = vault(t, true)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const state = persistent.instance.set(slot, 'secret-value')
  assert.equal(state.scope, 'persistent')
  assert.equal(fs.readFileSync(path.join(persistent.directory, fs.readdirSync(persistent.directory)[0])).includes(Buffer.from('secret-value')), false)
  let borrowed
  await persistent.instance.borrow(slot, 'persistent', state.generation, async (copy) => { borrowed = copy; assert.equal(copy.toString(), 'secret-value') })
  assert.equal(borrowed.every((byte) => byte === 0), true)

  const session = vault(t, false)
  const sessionState = session.instance.set(slot, 'temporary')
  assert.equal(sessionState.scope, 'session_only')
  assert.deepEqual(fs.readdirSync(session.directory), [])
  assert.deepEqual(session.instance.state(slot, 'absent', null), { present: true, scope: 'session_only' })
  session.instance.close()
  assert.deepEqual(session.instance.state(slot, 'absent', null), { present: false, scope: 'absent' })
})

test('SEM-F33/J25: runtime configures credentials without sending plaintext to storage and publishes changed', async (t) => {
  const { instance } = vault(t, true)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const calls = []
  const internal = { revision: 0, profiles: [{
    profile_id: 'profile.one', profile_revision: 1, catalog_revision: 0, label: 'One',
    template_id: null, https_origin: 'https://example.test', base_path: '/v1', models: [],
    credential_slot_id: slot, credential_persistence: 'absent', credential_generation: null
  }], assignments: {} }
  const runtime = new ModelAccessRuntime({
    vault: instance,
    gateway: {
      modelAccessCatalog: async () => internal,
      modelAccessConfigure: async (input) => { calls.push(input); return { revision: 1 } },
      modelAccessBind: async () => ({})
    },
    onChanged: (event) => calls.push(event)
  })
  const result = await runtime.configure({ type: 'setCredential', expectedRevision: 0, profileId: 'profile.one', credential: 'plain-secret' })
  assert.equal(result.ok, true)
  assert.equal(JSON.stringify(calls).includes('plain-secret'), false)
  assert.equal(calls[0].credentialState.scope, 'persistent')
  assert.deepEqual(calls[1], { revision: 1 })
})

test('SEM-F33/J25: remote pull is transient, rejects redirect, and invalidates only the rejected credential', async (t) => {
  const { instance } = vault(t, true)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const state = instance.set(slot, 'catalog-secret')
  const internal = { revision: 4, profiles: [{
    profile_id: 'deepseek', profile_revision: 1, template_id: 'deepseek-openai-template@1',
    https_origin: 'https://api.deepseek.com', base_path: '/', credential_slot_id: slot,
    credential_persistence: 'persistent', credential_generation: state.generation
  }] }
  let copy
  const controller = new RemoteModelCatalogPullController({
    runtime: { configure: async () => ({ ok: true, revision: 5, error: null }) },
    gateway: { modelAccessCatalog: async () => internal }, vault: instance,
    adapter: { listModels: async ({ credential }) => { copy = credential; return [{ modelId: 'deepseek-v4-flash', capabilitySuggestion: null }] } }
  })
  const result = await controller.pull({ profileId: 'deepseek', expectedRevision: 4 })
  assert.equal(result.status, 'success')
  assert.equal(result.suggestions[0].capabilitySuggestion.maxInputTokens, null)
  assert.equal(copy.every((byte) => byte === 0), true)
  const redirect = new RemoteModelCatalogPullController({
    runtime: { configure: async () => ({ ok: true, revision: 5, error: null }) },
    gateway: { modelAccessCatalog: async () => internal }, vault: instance,
    adapter: { listModels: async () => { const error = new Error(); error.code = 'REDIRECT_REJECTED'; throw error } }
  })
  assert.deepEqual(await redirect.pull({ profileId: 'deepseek', expectedRevision: 4 }), { status: 'redirect_rejected', suggestions: [] })
  let invalidated = null
  const auth = new RemoteModelCatalogPullController({
    runtime: { invalidateCredential: async (profileId, guard) => { invalidated = { profileId, guard }; return true } },
    gateway: { modelAccessCatalog: async () => internal },
    vault: instance,
    adapter: { listModels: async () => { const error = new Error(); error.code = 'AUTH_REJECTED'; throw error } }
  })
  assert.equal((await auth.pull({ profileId: 'deepseek', expectedRevision: 4 })).status, 'credential_unavailable')
  assert.deepEqual(invalidated, { profileId: 'deepseek', guard: { credentialSlotId: slot, profileRevision: 1 } })
})

test('SEM-F33/J25: OpenAI-compatible catalog uses the fixed safe-joined endpoint and rejects every redirect', async () => {
  const requests = []
  const adapter = new OpenAiCompatibleAdapter({
    fetch: async (url, options) => {
      requests.push({ url, options })
      return { ok: true, status: 200, json: async () => ({ data: [{ id: 'model.one' }] }) }
    }
  })
  assert.deepEqual(await adapter.listModels({
    connection: { httpsOrigin: 'https://example.test:8443', basePath: '/v1' },
    credential: Buffer.from('bounded-secret')
  }), [{ modelId: 'model.one', capabilitySuggestion: null }])
  assert.equal(requests[0].url, 'https://example.test:8443/v1/models')
  assert.equal(requests[0].options.redirect, 'manual')
  assert.equal(requests[0].options.headers.authorization, '')

  for (const status of [301, 302, 307, 308]) {
    const redirect = new OpenAiCompatibleAdapter({ fetch: async () => ({ ok: false, status }) })
    await assert.rejects(redirect.listModels({
      connection: { httpsOrigin: 'https://example.test', basePath: '/' }, credential: Buffer.from('secret')
    }), (error) => error.code === 'REDIRECT_REJECTED')
  }
})

test('SEM-F33/J25: remote catalog rejects declared and decoded responses above its byte budget', async () => {
  const request = {
    connection: { httpsOrigin: 'https://example.test', basePath: '/' },
    credential: Buffer.from('secret')
  }
  const declared = new OpenAiCompatibleAdapter({
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(256 * 1024 + 1) },
      text: async () => JSON.stringify({ data: [] })
    })
  })
  await assert.rejects(declared.listModels(request), /remote unavailable/)

  const decoded = new OpenAiCompatibleAdapter({
    fetch: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ data: [{ id: 'model.one', ignored: 'x'.repeat(256 * 1024) }] })
    })
  })
  await assert.rejects(decoded.listModels(request), /remote unavailable/)
})

test('SEM-F33/J25: production loop adapter uses the frozen endpoint, normalizes provider usage, and runs authorized tools sequentially', async () => {
  const requests = []
  const responses = [
    {
      choices: [{ message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_context', arguments: '{"schemaVersion":1,"aliasKeys":["decision"]}' } }]
      } }],
      usage: { prompt_tokens: 11, completion_tokens: 3, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 7 }
    },
    {
      choices: [{ message: { role: 'assistant', content: '{"schemaVersion":1,"answer":"bounded"}' } }],
      usage: { prompt_tokens: 21, completion_tokens: 5 }
    }
  ]
  const adapter = new OpenAiCompatibleAdapter({
    fetch: async (url, options) => {
      requests.push({ url, options, authorization: options.headers.authorization, body: JSON.parse(options.body) })
      const payload = responses.shift()
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) }
    }
  })
  const calls = []
  const progress = []
  const result = await adapter.run({
    connection: { httpsOrigin: 'https://example.test:8443', basePath: '/v1' },
    credential: Buffer.from('bounded-secret'),
    resolvedModel: { modelId: 'model.one', capabilities: {
      maxOutputTokens: 1024, supportsToolCalling: true, supportsStructuredOutput: true, usageReporting: true
    } },
    prompt: '{"scope":"session"}',
    tools: [{
      name: 'search_context',
      execute: async (args) => { calls.push(args); return { schemaVersion: 1, matches: [] } }
    }],
    onProgress: (event) => progress.push(event),
    maxTurns: 3,
    timeoutMs: 1000,
    shouldStopAfterTurn: ({ turn }) => turn >= 3
  })
  assert.equal(result.text, '{"schemaVersion":1,"answer":"bounded"}')
  assert.deepEqual(result.usage, {
    inputTokens: 32, outputTokens: 8, usageSource: 'provider',
    cacheHitInputTokens: null, cacheMissInputTokens: null
  })
  assert.deepEqual(calls, [{ schemaVersion: 1, aliasKeys: ['decision'] }])
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, 'https://example.test:8443/v1/chat/completions')
  assert.equal(requests[0].options.redirect, 'manual')
  assert.equal(requests[0].authorization, 'Bearer bounded-secret')
  assert.equal(requests[0].options.headers.authorization, '')
  assert.equal(requests[0].body.response_format.type, 'json_object')
  assert.equal(requests[1].body.messages.at(-1).role, 'tool')
  assert.equal(requests[1].body.messages.at(-1).tool_call_id, 'call-1')
  assert.deepEqual(progress, [
    { type: 'request_started', turn: 1 },
    { type: 'response_received', turn: 1 },
    { type: 'request_started', turn: 2 },
    { type: 'response_received', turn: 2 }
  ])
  assert.equal(JSON.stringify(progress).includes('bounded-secret'), false)
})

test('SEM-F33/J25: production loop adapter maps redirects, provider failures, malformed output, cancellation, and bounded responses', async () => {
  const request = {
    connection: { httpsOrigin: 'https://example.test', basePath: '/' },
    credential: Buffer.from('secret'),
    resolvedModel: { modelId: 'model.one', capabilities: {
      maxOutputTokens: 1024, supportsToolCalling: false, supportsStructuredOutput: false, usageReporting: true
    } },
    prompt: 'prompt'
  }
  for (const [status, code] of [[301, 'AGENT_PROVIDER_UNAVAILABLE'], [401, 'AGENT_PROVIDER_AUTH_FAILED'],
    [429, 'AGENT_PROVIDER_RATE_LIMITED'], [503, 'AGENT_PROVIDER_UNAVAILABLE'], [504, 'AGENT_PROVIDER_TIMEOUT']]) {
    const adapter = new OpenAiCompatibleAdapter({ fetch: async () => ({ ok: false, status }) })
    await assert.rejects(adapter.run(request), (error) => error.code === code)
  }
  const malformed = new OpenAiCompatibleAdapter({
    fetch: async () => ({ ok: true, status: 200, text: async () => '{"choices":[{"message":{"content":null}}]}' })
  })
  await assert.rejects(malformed.run(request), (error) => error.code === 'AGENT_OUTPUT_INVALID')
  const bounded = new OpenAiCompatibleAdapter({
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => String(512 * 1024 + 1) }, text: async () => '{}' })
  })
  await assert.rejects(bounded.run(request), (error) => error.code === 'AGENT_OUTPUT_INVALID')
  const controller = new AbortController()
  controller.abort()
  const cancelled = new OpenAiCompatibleAdapter({ fetch: async () => { throw new Error('must not fetch') } })
  await assert.rejects(cancelled.run({ ...request, signal: controller.signal }), (error) => error.code === 'AGENT_CANCELLED')

  const neverSettles = new OpenAiCompatibleAdapter({ fetch: async () => new Promise(() => {}) })
  await assert.rejects(neverSettles.run({ ...request, timeoutMs: 20 }), (error) => error.code === 'AGENT_PROVIDER_TIMEOUT')

  const lateController = new AbortController()
  let rejectLateFetch
  const lateReject = new OpenAiCompatibleAdapter({
    fetch: async () => new Promise((resolve, reject) => { rejectLateFetch = reject })
  })
  const latePending = lateReject.run({ ...request, signal: lateController.signal, timeoutMs: 1000 })
  lateController.abort()
  await assert.rejects(latePending, (error) => error.code === 'AGENT_CANCELLED')
  rejectLateFetch(new Error('late fetch rejection'))
  await new Promise((resolve) => setImmediate(resolve))

  const failedProgress = []
  const unavailable = new OpenAiCompatibleAdapter({ fetch: async () => { throw new Error('offline') } })
  await assert.rejects(unavailable.run({ ...request, onProgress: (event) => failedProgress.push(event) }),
    (error) => error.code === 'AGENT_PROVIDER_UNAVAILABLE')
  assert.deepEqual(failedProgress, [
    { type: 'request_started', turn: 1 },
    { type: 'request_failed', turn: 1 }
  ])
})

test('SEM-F33/J25: formal auth rejection invalidates only the bound profile credential', async (t) => {
  const { instance } = vault(t, true)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const state = instance.set(slot, 'formal-auth-secret')
  const internal = { revision: 6, profiles: [{
    profile_id: 'profile.one', profile_revision: 1, credential_slot_id: slot, credential_persistence: 'persistent',
    credential_generation: state.generation, https_origin: 'https://example.test', base_path: '/v1'
  }] }
  const configureCalls = []
  const runtime = new ModelAccessRuntime({
    vault: instance,
    gateway: {
      modelAccessCatalog: async () => internal,
      modelAccessConfigure: async ({ command }) => { configureCalls.push(command); return { revision: 7 } }
    },
    adapter: { run: async () => { const error = new Error('rejected'); error.code = 'AGENT_PROVIDER_AUTH_FAILED'; throw error } }
  })
  await runtime.initialize()
  await assert.rejects(runtime.runWithBinding({
    runId: 'run.one', profileId: 'profile.one', credentialSlotId: slot,
    profileRevision: 1,
    httpsOrigin: 'https://example.test', basePath: '/v1', modelId: 'model.one'
  }, { prompt: 'probe' }), (error) => error.code === 'AGENT_PROVIDER_AUTH_FAILED')
  assert.deepEqual(configureCalls, [{ type: 'clearCredential', expectedRevision: 6, profileId: 'profile.one' }])
  assert.deepEqual(instance.state(slot, 'persistent', state.generation), { present: false, scope: 'absent' })
})

test('SEM-F33/J25: delayed formal auth rejection does not clear a newer profile revision', async (t) => {
  const { instance } = vault(t, true)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const state = instance.set(slot, 'newer-secret')
  const internal = { revision: 7, profiles: [{
    profile_id: 'profile.one', profile_revision: 2, credential_slot_id: slot,
    credential_persistence: 'persistent', credential_generation: state.generation,
    https_origin: 'https://example.test', base_path: '/v1'
  }] }
  const configureCalls = []
  const runtime = new ModelAccessRuntime({
    vault: instance,
    gateway: {
      modelAccessCatalog: async () => internal,
      modelAccessConfigure: async ({ command }) => { configureCalls.push(command); return { revision: 8 } }
    },
    adapter: { run: async () => { const error = new Error('rejected'); error.code = 'AGENT_PROVIDER_AUTH_FAILED'; throw error } }
  })
  await runtime.initialize()
  await assert.rejects(runtime.runWithBinding({
    runId: 'run.one', profileId: 'profile.one', credentialSlotId: slot,
    profileRevision: 1, httpsOrigin: 'https://example.test', basePath: '/v1', modelId: 'model.one'
  }, { prompt: 'probe' }), (error) => error.code === 'AGENT_PROVIDER_AUTH_FAILED')
  assert.deepEqual(configureCalls, [])
  assert.deepEqual(instance.state(slot, 'persistent', state.generation), { present: true, scope: 'persistent' })
})

test('SEM-F36/J25: test and preset strategies add only their fixed provider fields', async () => {
  const bodies = []
  const adapter = new OpenAiCompatibleAdapter({
    fetch: async (_url, options) => {
      bodies.push(JSON.parse(options.body))
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }) }
    }
  })
  const base = {
    connection: { httpsOrigin: 'https://example.test', basePath: '/' },
    credential: Buffer.from('secret'),
    resolvedModel: { modelId: 'model.one', capabilities: { maxOutputTokens: 256, supportsToolCalling: false, supportsStructuredOutput: false, usageReporting: true } },
    prompt: 'probe'
  }
  await adapter.run({ ...base, requestStrategy: 'deepseek-openai@1', testMode: true })
  await adapter.run({ ...base, requestStrategy: 'qwen-beijing@1', testMode: true })
  await adapter.run({ ...base, requestStrategy: 'openai-compatible@1', testMode: true })
  await assert.rejects(adapter.run({ ...base, requestStrategy: 'unknown-provider@1', testMode: true }), (error) => error.code === 'AGENT_REQUEST_INVALID')
  assert.deepEqual(bodies.map((body) => ({ thinking: body.thinking, enable_thinking: body.enable_thinking })), [
    { thinking: { type: 'disabled' }, enable_thinking: undefined },
    { thinking: undefined, enable_thinking: false },
    { thinking: undefined, enable_thinking: undefined }
  ])
  const malformed = new OpenAiCompatibleAdapter({
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: '{"ok":false}' } }] }) })
  })
  await assert.rejects(malformed.run({ ...base, testMode: true }), (error) => error.code === 'AGENT_OUTPUT_INVALID')
  const extra = new OpenAiCompatibleAdapter({
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: '{"ok":true,"extra":1}' } }] }) })
  })
  await assert.rejects(extra.run({ ...base, testMode: true }), (error) => error.code === 'AGENT_OUTPUT_INVALID')
})

test('SEM-F34/J24: production loop adapter bounds tool execution and propagates cancellation without waiting for a hanging tool', async () => {
  const toolResponse = () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_context', arguments: '{}' } }]
      } }]
    })
  })
  const base = {
    connection: { httpsOrigin: 'https://example.test', basePath: '/' },
    credential: Buffer.from('secret'),
    resolvedModel: { modelId: 'model.one', capabilities: {
      maxOutputTokens: 1024, supportsToolCalling: true, supportsStructuredOutput: false, usageReporting: true
    } },
    prompt: 'prompt', tools: [{ name: 'search_context', execute: async () => new Promise(() => {}) }],
    maxTurns: 2, timeoutMs: 100
  }
  const timeoutAdapter = new OpenAiCompatibleAdapter({ fetch: async () => toolResponse() })
  const toolTimeoutProgress = []
  await assert.rejects(timeoutAdapter.run({ ...base, onProgress: (event) => toolTimeoutProgress.push(event) }),
    (error) => error.code === 'TOOL_TIMEOUT')
  assert.deepEqual(toolTimeoutProgress, [
    { type: 'request_started', turn: 1 },
    { type: 'response_received', turn: 1 }
  ])
  const controller = new AbortController()
  const cancelAdapter = new OpenAiCompatibleAdapter({ fetch: async () => toolResponse() })
  const pending = cancelAdapter.run({ ...base, signal: controller.signal })
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(pending, (error) => error.code === 'AGENT_CANCELLED')
})

test('SEM-F33/J25: model access owns loop execution and borrows only the binding credential slot', async (t) => {
  const { instance } = vault(t, true)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const state = instance.set(slot, 'loop-secret')
  const internal = { profiles: [{
    profile_id: 'profile.one', credential_slot_id: slot, credential_persistence: 'persistent',
    credential_generation: state.generation, https_origin: 'https://current.example', base_path: '/v1'
  }] }
  let observed = null
  let borrowed = null
  let credentialText = null
  const runtime = new ModelAccessRuntime({
    vault: instance,
    gateway: { modelAccessCatalog: async () => internal, modelAccessBind: async () => ({}) },
    adapter: { run: async (request) => {
      observed = request
      borrowed = request.credential
      credentialText = request.credential.toString()
      return { text: '{}', usage: null }
    } }
  })
  await runtime.initialize()
  const loop = runtime.createLoopAdapter({
    runId: 'run.one', profileId: 'profile.one', credentialSlotId: slot,
    httpsOrigin: 'https://frozen.example', basePath: '/v1', modelId: 'model.one',
    capabilities: { maxOutputTokens: 1024 }, budget: { toolTimeoutMs: 5000 }
  })
  await loop.run({ prompt: 'bounded', connection: { httpsOrigin: 'https://attacker.example', basePath: '/' } })
  assert.equal(observed.resolvedModel.modelId, 'model.one')
  assert.equal(Object.isFrozen(observed.resolvedModel), true)
  assert.equal(Object.isFrozen(observed.resolvedModel.capabilities), true)
  assert.deepEqual(observed.connection, { httpsOrigin: 'https://frozen.example', basePath: '/v1' })
  assert.equal(credentialText, 'loop-secret')
  assert.equal(borrowed.every((byte) => byte === 0), true)
  await assert.rejects(runtime.runWithBinding({
    runId: 'run.one', profileId: 'profile.one', credentialSlotId: 'slot.abcdef0123456789abcdef0123456789',
    httpsOrigin: 'https://frozen.example', basePath: '/v1', modelId: 'model.one'
  }, {}), (error) => error.code === 'AGENT_PROVIDER_AUTH_FAILED')
})

test('SEM-F33/J25: startup environment removes every legacy credential spelling', () => {
  assert.deepEqual(sanitizedEnvironment({ Path: 'ok', DEEPSEEK_API_KEY: 'one', deepseek_api_key: 'two', Other: 3 }), { Path: 'ok' })
})

test('SEM-F33/J25: credential quarantine rolls back before a failed SQLite command', async (t) => {
  const { instance } = vault(t, true)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const state = instance.set(slot, 'rollback-secret')
  const token = instance.prepareClear(slot, 'persistent', state.generation)
  assert.deepEqual(instance.state(slot, 'persistent', state.generation), { present: false, scope: 'absent' })
  instance.rollbackClear(token)
  assert.deepEqual(instance.state(slot, 'persistent', state.generation), { present: true, scope: 'persistent' })
  await instance.borrow(slot, 'persistent', state.generation, async (copy) => assert.equal(copy.toString(), 'rollback-secret'))
})

test('SEM-F33/J25: persistent credential journal recovers set from the committed SQLite generation', async (t) => {
  const created = vault(t, true)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const oldState = created.instance.set(slot, 'old-secret')
  const prepared = created.instance.prepareSet(slot, 'new-secret', {
    persistence: 'persistent',
    generation: oldState.generation
  })
  const journalText = fs.readFileSync(path.join(created.directory, 'journal.v1.json'), 'utf8')
  assert.equal(journalText.includes('old-secret'), false)
  assert.equal(journalText.includes('new-secret'), false)
  assert.equal(journalText.includes('https://'), false)

  const beforeCommitRestart = new CredentialVault({ directory: created.directory, safeStorage: created.instance.safeStorage })
  beforeCommitRestart.recover([{ credential_slot_id: slot, credential_persistence: 'persistent', credential_generation: oldState.generation }])
  assert.deepEqual(beforeCommitRestart.state(slot, 'persistent', oldState.generation), { present: true, scope: 'persistent' })
  assert.deepEqual(beforeCommitRestart.state(slot, 'persistent', prepared.state.generation), { present: false, scope: 'absent' })

  const preparedAfterRestart = beforeCommitRestart.prepareSet(slot, 'committed-secret', {
    persistence: 'persistent',
    generation: oldState.generation
  })
  const afterCommitRestart = new CredentialVault({ directory: created.directory, safeStorage: created.instance.safeStorage })
  afterCommitRestart.recover([{ credential_slot_id: slot, credential_persistence: 'persistent', credential_generation: preparedAfterRestart.state.generation }])
  assert.deepEqual(afterCommitRestart.state(slot, 'persistent', oldState.generation), { present: false, scope: 'absent' })
  await afterCommitRestart.borrow(slot, 'persistent', preparedAfterRestart.state.generation, async (copy) => assert.equal(copy.toString(), 'committed-secret'))
})

test('SEM-F33/J25: setCredential rolls back the prepared generation when SQLite rejects the command', async (t) => {
  const { instance, directory } = vault(t, true)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const oldState = instance.set(slot, 'old-secret')
  const internal = { revision: 8, profiles: [{
    profile_id: 'profile.one', credential_slot_id: slot,
    credential_persistence: 'persistent', credential_generation: oldState.generation
  }] }
  let oldGenerationRemainedAuthoritative = false
  let journalWasPrepared = false
  const runtime = new ModelAccessRuntime({
    vault: instance,
    gateway: {
      modelAccessCatalog: async () => internal,
      modelAccessConfigure: async () => {
        oldGenerationRemainedAuthoritative = instance.state(slot, 'persistent', oldState.generation).present
        journalWasPrepared = fs.existsSync(path.join(directory, 'journal.v1.json'))
        throw new Error('injected storage failure')
      },
      modelAccessBind: async () => ({})
    }
  })

  const result = await runtime.configure({ type: 'setCredential', expectedRevision: 8, profileId: 'profile.one', credential: 'new-secret' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'MODEL_CONFIG_INVALID')
  assert.equal(oldGenerationRemainedAuthoritative, true)
  assert.equal(journalWasPrepared, true)
  assert.equal(fs.readdirSync(directory).filter((name) => name.endsWith('.bin')).length, 1)
  assert.equal(fs.existsSync(path.join(directory, 'journal.v1.json')), false)
  await instance.borrow(slot, 'persistent', oldState.generation, async (copy) => assert.equal(copy.toString(), 'old-secret'))
})

test('SEM-F33/SEM-T04/J25: rejected non-credential configuration does not settle from an absent credential', async (t) => {
  const { instance } = vault(t, true)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const internal = { revision: 8, profiles: [{
    profile_id: 'profile.one', profile_revision: 1, credential_slot_id: slot,
    credential_persistence: 'absent', credential_generation: null,
    https_origin: 'https://old.example', base_path: '/v1'
  }] }
  const changes = []
  const runtime = new ModelAccessRuntime({
    vault: instance,
    gateway: {
      modelAccessCatalog: async () => internal,
      modelAccessConfigure: async () => { throw new Error('injected invalid connection') },
      modelAccessBind: async () => ({})
    },
    onChanged: (event) => changes.push(event)
  })

  const result = await runtime.configure({
    type: 'updateProfile', expectedRevision: 8, profileId: 'profile.one',
    label: 'One', httpsOrigin: 'http://invalid.example', basePath: '/v1'
  })

  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'MODEL_CONFIG_INVALID')
  assert.equal(changes.length, 0)
  assert.equal(internal.revision, 8)
  assert.equal(internal.profiles[0].https_origin, 'https://old.example')
  assert.deepEqual(instance.state(slot, 'absent', null), { present: false, scope: 'absent' })
})

test('SEM-F33/J25: committed credential write survives a lost storage reply', async (t) => {
  const { instance, directory } = vault(t, true)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const oldState = instance.set(slot, 'old-secret')
  let internal = { revision: 8, profiles: [{
    profile_id: 'profile.one', credential_slot_id: slot,
    credential_persistence: 'persistent', credential_generation: oldState.generation
  }] }
  const runtime = new ModelAccessRuntime({
    vault: instance,
    gateway: {
      modelAccessCatalog: async () => internal,
      modelAccessConfigure: async ({ credentialState }) => {
        internal = {
          revision: 9,
          profiles: [{
            profile_id: 'profile.one', credential_slot_id: slot,
            credential_persistence: credentialState.scope,
            credential_generation: credentialState.generation
          }]
        }
        throw new Error('reply lost after commit')
      },
      modelAccessBind: async () => ({})
    }
  })

  const result = await runtime.configure({
    type: 'setCredential', expectedRevision: 8, profileId: 'profile.one', credential: 'committed-secret'
  })
  assert.deepEqual(result, { ok: true, revision: 9, error: null })
  assert.equal(fs.existsSync(path.join(directory, 'journal.v1.json')), false)
  await instance.borrow(slot, 'persistent', internal.profiles[0].credential_generation,
    async (copy) => assert.equal(copy.toString(), 'committed-secret'))
})

test('SEM-F33/J25: committed session credential write survives a lost storage reply', async (t) => {
  const { instance } = vault(t, false)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  let internal = { revision: 8, profiles: [{
    profile_id: 'profile.one', credential_slot_id: slot,
    credential_persistence: 'absent', credential_generation: null
  }] }
  const runtime = new ModelAccessRuntime({
    vault: instance,
    gateway: {
      modelAccessCatalog: async () => internal,
      modelAccessConfigure: async () => {
        internal = { revision: 9, profiles: [{
          profile_id: 'profile.one', credential_slot_id: slot,
          credential_persistence: 'absent', credential_generation: null
        }] }
        throw new Error('reply lost after commit')
      },
      modelAccessBind: async () => ({})
    }
  })

  const result = await runtime.configure({
    type: 'setCredential', expectedRevision: 8, profileId: 'profile.one', credential: 'session-secret'
  })
  assert.deepEqual(result, { ok: true, revision: 9, error: null })
  assert.deepEqual(instance.state(slot, 'absent', null), { present: true, scope: 'session_only' })
})

test('SEM-F33/J25: committed clearCredential survives a lost storage reply', async (t) => {
  const { instance } = vault(t, true)
  const oldSlot = 'slot.0123456789abcdef0123456789abcdef'
  const newSlot = 'slot.abcdef0123456789abcdef0123456789'
  const oldState = instance.set(oldSlot, 'old-secret')
  let internal = { revision: 8, profiles: [{
    profile_id: 'profile.one', credential_slot_id: oldSlot,
    credential_persistence: 'persistent', credential_generation: oldState.generation
  }] }
  const runtime = new ModelAccessRuntime({
    vault: instance,
    gateway: {
      modelAccessCatalog: async () => internal,
      modelAccessConfigure: async () => {
        internal = { revision: 9, profiles: [{
          profile_id: 'profile.one', credential_slot_id: newSlot,
          credential_persistence: 'absent', credential_generation: null
        }] }
        throw new Error('reply lost after commit')
      },
      modelAccessBind: async () => ({})
    }
  })

  const result = await runtime.configure({ type: 'clearCredential', expectedRevision: 8, profileId: 'profile.one' })
  assert.deepEqual(result, { ok: true, revision: 9, error: null })
  assert.deepEqual(instance.state(oldSlot, 'persistent', oldState.generation), { present: false, scope: 'absent' })
})

test('SEM-F33/J25: committed deleteProfile survives a lost storage reply', async (t) => {
  const { instance } = vault(t, true)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const state = instance.set(slot, 'old-secret')
  let internal = { revision: 8, profiles: [{
    profile_id: 'profile.one', credential_slot_id: slot,
    credential_persistence: 'persistent', credential_generation: state.generation
  }] }
  const runtime = new ModelAccessRuntime({
    vault: instance,
    gateway: {
      modelAccessCatalog: async () => internal,
      modelAccessConfigure: async () => {
        internal = { revision: 9, profiles: [] }
        throw new Error('reply lost after commit')
      },
      modelAccessBind: async () => ({})
    }
  })

  const result = await runtime.configure({ type: 'deleteProfile', expectedRevision: 8, profileId: 'profile.one' })
  assert.deepEqual(result, { ok: true, revision: 9, error: null })
  assert.deepEqual(instance.state(slot, 'persistent', state.generation), { present: false, scope: 'absent' })
})

test('SEM-F33/J25: stale credential commands reject before any vault prepare', async (t) => {
  const { instance } = vault(t, true)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const state = instance.set(slot, 'old-secret')
  const internal = { revision: 9, profiles: [{
    profile_id: 'profile.one', credential_slot_id: slot,
    credential_persistence: 'persistent', credential_generation: state.generation
  }] }
  let prepareSetCount = 0
  let prepareClearCount = 0
  const originalPrepareSet = instance.prepareSet.bind(instance)
  const originalPrepareClear = instance.prepareClear.bind(instance)
  instance.prepareSet = (...args) => { prepareSetCount += 1; return originalPrepareSet(...args) }
  instance.prepareClear = (...args) => { prepareClearCount += 1; return originalPrepareClear(...args) }
  const runtime = new ModelAccessRuntime({
    vault: instance,
    gateway: {
      modelAccessCatalog: async () => internal,
      modelAccessConfigure: async () => { const error = new Error(); error.code = 'MODEL_CONFIG_REVISION_CONFLICT'; throw error },
      modelAccessBind: async () => ({})
    }
  })

  for (const command of [
    { type: 'setCredential', expectedRevision: 8, profileId: 'profile.one', credential: 'new-secret' },
    { type: 'clearCredential', expectedRevision: 8, profileId: 'profile.one' },
    { type: 'deleteProfile', expectedRevision: 8, profileId: 'profile.one' }
  ]) {
    const result = await runtime.configure(command)
    assert.equal(result.error.code, 'MODEL_CONFIG_REVISION_CONFLICT')
  }
  assert.equal(prepareSetCount, 0)
  assert.equal(prepareClearCount, 0)
  assert.deepEqual(instance.state(slot, 'persistent', state.generation), { present: true, scope: 'persistent' })
})

test('SEM-F33/J25: credential quarantine recovery follows the committed SQLite fact', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-vault-recover-'))
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value, 'utf8').reverse(),
    decryptString: (value) => Buffer.from(value).reverse().toString('utf8')
  }
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const first = new CredentialVault({ directory: root, safeStorage })
  const state = first.set(slot, 'recover-secret')
  first.prepareClear(slot, 'persistent', state.generation)

  const beforeCommitRestart = new CredentialVault({ directory: root, safeStorage })
  beforeCommitRestart.recover([{ credential_slot_id: slot, credential_persistence: 'persistent', credential_generation: state.generation }])
  assert.deepEqual(beforeCommitRestart.state(slot, 'persistent', state.generation), { present: true, scope: 'persistent' })

  beforeCommitRestart.prepareClear(slot, 'persistent', state.generation)
  const afterCommitRestart = new CredentialVault({ directory: root, safeStorage })
  afterCommitRestart.recover([])
  assert.deepEqual(afterCommitRestart.state(slot, 'persistent', state.generation), { present: false, scope: 'absent' })
  assert.deepEqual(fs.readdirSync(root), [])
  first.close()
  beforeCommitRestart.close()
  afterCommitRestart.close()
  fs.rmSync(root, { recursive: true, force: true })
})

test('SEM-F25/SEM-F33/J25: immutable binding borrows only its frozen slot identity', async (t) => {
  const { instance } = vault(t, true)
  const oldSlot = 'slot.0123456789abcdef0123456789abcdef'
  const newSlot = 'slot.abcdef0123456789abcdef0123456789'
  const oldState = instance.set(oldSlot, 'old-secret')
  const binding = { profileId: 'profile.one', credentialSlotId: oldSlot }
  const oldProfile = [{
    profile_id: 'profile.one', credential_slot_id: oldSlot,
    credential_persistence: 'persistent', credential_generation: oldState.generation
  }]
  await instance.borrowForBinding(binding, oldProfile, async (copy) => assert.equal(copy.toString(), 'old-secret'))

  instance.clear(oldSlot)
  const newState = instance.set(newSlot, 'new-secret')
  const rebuiltProfile = [{
    profile_id: 'profile.one', credential_slot_id: newSlot,
    credential_persistence: 'persistent', credential_generation: newState.generation
  }]
  await assert.rejects(instance.borrowForBinding(binding, rebuiltProfile, async () => {}), (error) => {
    assert.equal(error.code, 'AGENT_PROVIDER_AUTH_FAILED')
    assert.equal(error.retryable, false)
    return true
  })
})

test('SEM-F33/J25: binding preserves non-auth provider errors from credential consumption', async (t) => {
  const { instance } = vault(t, true)
  const slot = 'slot.0123456789abcdef0123456789abcdef'
  const state = instance.set(slot, 'provider-secret')
  const binding = { profileId: 'profile.one', credentialSlotId: slot }
  const profiles = [{
    profile_id: 'profile.one', credential_slot_id: slot,
    credential_persistence: 'persistent', credential_generation: state.generation
  }]
  const expected = new Error('provider timed out')
  expected.code = 'AGENT_PROVIDER_TIMEOUT'
  await assert.rejects(instance.borrowForBinding(binding, profiles, async () => { throw expected }), (error) => error === expected)
  assert.deepEqual(instance.state(slot, 'persistent', state.generation), { present: true, scope: 'persistent' })
})
