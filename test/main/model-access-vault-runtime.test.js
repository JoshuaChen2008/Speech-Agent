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
const { deriveRecipeBudget, deriveSummaryMinutesV2RequestCapacity } = require('../../src/agent/contracts/budget-axes')
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
      choices: [{ finish_reason: 'tool_calls', message: {
        role: 'assistant', content: null,
        tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_context', arguments: '{"schemaVersion":1,"aliasKeys":["decision"]}' } }]
      } }],
      usage: { prompt_tokens: 11, completion_tokens: 3, prompt_cache_hit_tokens: 4, prompt_cache_miss_tokens: 7 }
    },
    {
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"schemaVersion":1,"answer":"bounded"}' } }],
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

test('SEM-F39/J31-SIZE/J31-COMPAT: transport accepts only versioned summary prompts above 16 KiB', async () => {
  let sent = 0
  const adapter = new OpenAiCompatibleAdapter({
    fetch: async () => {
      sent += 1
      return { ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}' } }] }) }
    }
  })
  const request = {
    connection: { httpsOrigin: 'https://example.test', basePath: '/v1' },
    credential: Buffer.from('controlled-secret'),
    resolvedModel: { modelId: 'model.one', capabilities: {
      maxInputTokens: 64000, maxOutputTokens: 1024, supportsToolCalling: true, supportsStructuredOutput: true, usageReporting: false
    } },
    prompt: '中'.repeat(6000)
  }
  await assert.rejects(adapter.run({ ...request, recipe: { recipeId: 'summary.minutes', recipeVersion: '1' } }),
    (error) => error.code === 'AGENT_REQUEST_INVALID')
  const v2Capabilities = { maxInputTokens: 64000, maxOutputTokens: 1024, supportsToolCalling: true, supportsStructuredOutput: true, usageReporting: false }
  const v2Budget = deriveRecipeBudget(v2Capabilities, 'summary.minutes', '2', 'user')
  await adapter.run({
    ...request,
    recipe: { recipeId: 'summary.minutes', recipeVersion: '2' },
    resolvedModel: { modelId: 'model.one', capabilities: v2Capabilities, budget: v2Budget },
    requestCapacity: deriveSummaryMinutesV2RequestCapacity({ capabilities: v2Capabilities, budget: v2Budget })
  })
  assert.equal(sent, 1)
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
  for (const [status, code] of [[301, 'AGENT_REQUEST_INVALID'], [400, 'AGENT_REQUEST_INVALID'],
    [401, 'AGENT_PROVIDER_AUTH_FAILED'], [403, 'AGENT_PROVIDER_AUTH_FAILED'],
    [404, 'AGENT_REQUEST_INVALID'], [422, 'AGENT_REQUEST_INVALID'],
    [408, 'AGENT_PROVIDER_TIMEOUT'], [409, 'AGENT_PROVIDER_UNAVAILABLE'],
    [425, 'AGENT_PROVIDER_UNAVAILABLE'], [429, 'AGENT_PROVIDER_RATE_LIMITED'],
    [503, 'AGENT_PROVIDER_UNAVAILABLE'], [504, 'AGENT_PROVIDER_TIMEOUT']]) {
    const adapter = new OpenAiCompatibleAdapter({ fetch: async () => ({ ok: false, status }) })
    await assert.rejects(adapter.run(request), (error) => error.code === code)
  }
  const malformed = new OpenAiCompatibleAdapter({
    fetch: async () => ({ ok: true, status: 200, text: async () => '{"choices":[{"finish_reason":"stop","message":{"content":null}}]}' })
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

test('SEM-F38/J30-RECOVERY: one model operation retries transient responses at most five times and never retries invalid requests', async () => {
  const request = {
    connection: { httpsOrigin: 'https://example.test', basePath: '/' },
    credential: Buffer.from('synthetic-secret'),
    resolvedModel: { modelId: 'model.one', capabilities: {
      maxOutputTokens: 128, supportsToolCalling: false, supportsStructuredOutput: false, usageReporting: false
    } }, prompt: 'synthetic prompt'
  }
  let calls = 0
  const attempts = []
  const progress = []
  const adapter = new OpenAiCompatibleAdapter({ fetch: async () => {
    calls += 1
    return { status: 503, ok: false }
  } })
  await assert.rejects(adapter.run({ ...request, beforeRequest: ({ requestAttempt }) => attempts.push(requestAttempt),
    onProgress: (event) => progress.push(event) }),
    (error) => error.code === 'AGENT_PROVIDER_UNAVAILABLE' && error.retryExhausted === true)
  assert.equal(calls, 5)
  assert.deepEqual(attempts, [1, 2, 3, 4, 5])
  assert.deepEqual(progress.filter((event) => event.type === 'retry_wait').map((event) =>
    [event.nextAttempt, event.reason, event.waitMs]), [
    [2, 'AGENT_PROVIDER_UNAVAILABLE', 100], [3, 'AGENT_PROVIDER_UNAVAILABLE', 200],
    [4, 'AGENT_PROVIDER_UNAVAILABLE', 400], [5, 'AGENT_PROVIDER_UNAVAILABLE', 800]
  ])

  calls = 0
  const invalid = new OpenAiCompatibleAdapter({ fetch: async () => { calls += 1; return { status: 400, ok: false } } })
  await assert.rejects(invalid.run({ ...request, beforeRequest: () => {} }),
    (error) => error.code === 'AGENT_REQUEST_INVALID' && error.retryable === false)
  assert.equal(calls, 1)

  calls = 0
  const offline = new OpenAiCompatibleAdapter({ fetch: () => {
    calls += 1
    const error = new Error('offline')
    error.code = 'ECONNRESET'
    throw error
  } })
  await assert.rejects(offline.run({ ...request, beforeRequest: () => {} }),
    (error) => error.code === 'AGENT_PROVIDER_UNAVAILABLE' && error.retryExhausted === true)
  assert.equal(calls, 5)
})

test('SEM-F38/SEM-T04/J30-RECOVERY: a durable request reservation gates provider egress', async () => {
  const order = []
  const request = {
    connection: { httpsOrigin: 'https://example.test', basePath: '/' },
    credential: Buffer.from('secret'),
    resolvedModel: { modelId: 'model.one', capabilities: {
      maxOutputTokens: 1024, supportsToolCalling: false, supportsStructuredOutput: false, usageReporting: true
    } },
    prompt: 'prompt',
    beforeRequest: async ({ turn }) => { order.push(`reserved:${turn}`) }
  }
  const adapter = new OpenAiCompatibleAdapter({
    fetch: async () => {
      order.push('provider-egress')
      return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'ok' } }] }) }
    }
  })
  await adapter.run(request)
  assert.deepEqual(order, ['reserved:1', 'provider-egress'])

  let fetchCount = 0
  const blocked = new OpenAiCompatibleAdapter({ fetch: async () => { fetchCount += 1 } })
  await assert.rejects(blocked.run({
    ...request,
    beforeRequest: async () => { throw Object.assign(new Error('reservation unavailable'), { code: 'AGENT_RUN_UNAVAILABLE' }) }
  }), (error) => error.code === 'AGENT_RUN_UNAVAILABLE')
  assert.equal(fetchCount, 0)
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
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }) }
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
  const malformedTest = new OpenAiCompatibleAdapter({
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":false}' } }] }) })
  })
  await assert.rejects(malformedTest.run({ ...base, testMode: true }), (error) => error.code === 'AGENT_OUTPUT_INVALID')
  const extra = new OpenAiCompatibleAdapter({
    fetch: async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true,"extra":1}' } }] }) })
  })
  await assert.rejects(extra.run({ ...base, testMode: true }), (error) => error.code === 'AGENT_OUTPUT_INVALID')
})

test('SEM-F34/J24: production loop adapter bounds tool execution and propagates cancellation without waiting for a hanging tool', async () => {
  const toolResponse = () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      choices: [{ finish_reason: 'tool_calls', message: {
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

function v2Scenario ({ maxInputTokens = 128000, maxOutputTokens = 81920 } = {}) {
  const capabilities = {
    maxInputTokens, maxOutputTokens,
    supportsToolCalling: true, supportsStructuredOutput: true,
    supportsStreaming: true, usageReporting: true
  }
  const budget = deriveRecipeBudget(capabilities, 'summary.minutes', '2', 'user')
  return {
    capabilities,
    budget,
    requestCapacity: deriveSummaryMinutesV2RequestCapacity({ capabilities, budget }),
    recipe: { recipeId: 'summary.minutes', recipeVersion: '2' }
  }
}

function v2Request (scenario, overrides = {}) {
  return {
    connection: { httpsOrigin: 'https://example.test', basePath: '/v1' },
    credential: Buffer.from('summary-secret'),
    resolvedModel: { modelId: 'summary-model', capabilities: scenario.capabilities, budget: scenario.budget },
    recipe: scenario.recipe,
    requestCapacity: scenario.requestCapacity,
    prompt: '{"userPrompt":"总结"}',
    maxTurns: 3,
    timeoutMs: 1000,
    ...overrides
  }
}

function stopResponse (content, usage = undefined) {
  return {
    ok: true, status: 200, headers: { get: () => null },
    text: async () => JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { role: 'assistant', content } }],
      ...(usage === undefined ? {} : { usage })
    })
  }
}

function toolCallsResponse (usage = undefined) {
  return {
    ok: true, status: 200, headers: { get: () => null },
    text: async () => JSON.stringify({
      choices: [{
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant', content: null,
          tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_context', arguments: '{"schemaVersion":1,"aliasKeys":[]}' } }]
        }
      }],
      ...(usage === undefined ? {} : { usage })
    })
  }
}

function searchTool (results = { schemaVersion: 1, matches: [] }) {
  return { name: 'search_context', execute: async () => results }
}


function qaScenario (options = {}) {
  const { deriveRecipeRequestCapacity } = require('../../src/agent/contracts/budget-axes')
  const { capabilities } = v2Scenario(options)
  const recipe = { recipeId: 'qa.answer', recipeVersion: '2' }
  const budget = deriveRecipeBudget(capabilities, recipe.recipeId, recipe.recipeVersion, 'user')
  return { capabilities, budget, recipe,
    requestCapacity: deriveRecipeRequestCapacity({ ...recipe, capabilities, budget }) }
}

test('SEM-F31/F33/J22-QA-WINDOW/J24-QA-BUDGET: real Agent Loop and adapter accept windowed Chinese input with bounded output', async () => {
  const { AgentLoopExecutor } = require('../../src/agent/execution-host/agent-loop')
  const scenario = qaScenario()
  const bodies = []
  const adapter = new OpenAiCompatibleAdapter({
    fetch: async (_url, options) => { bodies.push(JSON.parse(options.body)); return stopResponse('{"schemaVersion":1}') }
  })
  const loop = new AgentLoopExecutor({ adapter: { run: (request) => adapter.run({
    ...request, connection: { httpsOrigin: 'https://example.test', basePath: '/v1' }, credential: Buffer.from('synthetic-qa-secret')
  }) } })
  const prompt = '中'.repeat(6000) + 'a'.repeat(17000)
  await loop.agentLoop({ ...scenario.recipe, requestCapacity: scenario.requestCapacity,
    resolvedModel: { modelId: 'qa-model', capabilities: scenario.capabilities, budget: scenario.budget },
    prompt, budget: scenario.budget, tools: [] })
  assert.equal(bodies.length, 1)
  assert.equal(bodies[0].messages[1].content, prompt)
  assert.equal(bodies[0].max_tokens, 8000)
})

test('SEM-F31/F33/J22-QA-SIZE: exact prompt capacity accepts its edge and rejects overflow, missing or forged capacity before fetch', async () => {
  const scenario = qaScenario({ maxInputTokens: 12000, maxOutputTokens: 4096 })
  let fetches = 0
  const adapter = new OpenAiCompatibleAdapter({ fetch: async () => { fetches++; return stopResponse('{"schemaVersion":1}') } })
  for (const bytes of [3807, 3808]) await adapter.run(v2Request(scenario, { prompt: 'a'.repeat(bytes) }))
  assert.equal(fetches, 2)
  await assert.rejects(adapter.run(v2Request(scenario, { prompt: 'a'.repeat(3809) })),
    (error) => {
      assert.equal(error.code, 'AGENT_QA_INPUT_LIMIT_EXCEEDED')
      assert.deepEqual(error.diagnosticMetrics, { actual: 3809, limit: 3808, unit: 'bytes' })
      return true
    })
  await assert.rejects(adapter.run(v2Request(scenario, { requestCapacity: undefined })), { code: 'AGENT_REQUEST_INVALID' })
  await assert.rejects(adapter.run(v2Request(scenario, { requestCapacity: { promptByteLimit: 64000, requestOutputTokens: 4096 } })),
    { code: 'AGENT_REQUEST_INVALID' })
  assert.equal(fetches, 2)
})

test('SEM-F31/F33/J22-QA-SIZE/J24-QA-BUDGET: serialized escaping rejects before fetch and post-tool growth uses the budget error', async () => {
  const scenario = qaScenario({ maxInputTokens: 12000, maxOutputTokens: 4096 })
  let fetches = 0
  const adapter = new OpenAiCompatibleAdapter({ fetch: async () => { fetches++; return toolCallsResponse() } })
  await assert.rejects(adapter.run(v2Request(scenario, { prompt: '\\'.repeat(3808), systemPrompt: 'a'.repeat(6000) })),
    (error) => error.code === 'AGENT_QA_INPUT_LIMIT_EXCEEDED' && error.diagnosticMetrics.actual > 12000)
  assert.equal(fetches, 0)
  await assert.rejects(adapter.run(v2Request(scenario, { prompt: 'a'.repeat(3808),
    tools: [searchTool({ schemaVersion: 1, matches: [], text: '中'.repeat(10000) })] })), { code: 'AGENT_BUDGET_EXCEEDED' })
  assert.equal(fetches, 1)
})

test('SEM-F33/J24-QA-BUDGET: provider usage narrows QA output, unknown usage stays null and exhausted output prevents another request', async () => {
  for (const [usage, expectedQuota, exhausted] of [
    [{ prompt_tokens: 100, completion_tokens: 6000 }, 2000, false],
    [undefined, 8000, false],
    [{ prompt_tokens: 100, completion_tokens: 8000 }, null, true]
  ]) {
    const bodies = []
    const scenario = qaScenario()
    const adapter = new OpenAiCompatibleAdapter({
      fetch: async (_url, options) => {
        bodies.push(JSON.parse(options.body))
        return bodies.length === 1 ? toolCallsResponse(usage) : stopResponse('{"schemaVersion":1}', usage)
      }
    })
    const pending = adapter.run(v2Request(scenario, { tools: [searchTool()] }))
    if (exhausted) {
      await assert.rejects(pending, { code: 'AGENT_BUDGET_EXCEEDED' })
      assert.equal(bodies.length, 1)
    } else {
      const result = await pending
      assert.equal(bodies[1].max_tokens, expectedQuota)
      if (usage === undefined) assert.equal(result.usage, null)
    }
    assert.equal(bodies[0].max_tokens, 8000)
  }
})

test('SEM-F38/J24-QA-BUDGET: QA retries preserve the derived request quota and body', async () => {
  const bodies = []
  const scenario = qaScenario()
  const adapter = new OpenAiCompatibleAdapter({ fetch: async (_url, options) => {
    bodies.push(options.body)
    return bodies.length === 1 ? { ok: false, status: 503, headers: { get: () => null } } : stopResponse('{"schemaVersion":1}')
  } })
  await adapter.run(v2Request(scenario, { beforeRequest: async () => {} }))
  assert.equal(bodies.length, 2)
  assert.equal(bodies[0], bodies[1])
  assert.equal(JSON.parse(bodies[1]).max_tokens, 8000)
})

test('SEM-F39/J31-SIZE: v2 outbound max_tokens comes from the derived quota instead of the raw capability', async () => {
  const bodies = []
  const scenario = v2Scenario({ maxInputTokens: 128000, maxOutputTokens: 81920 })
  const roomy = new OpenAiCompatibleAdapter({
    fetch: async (_url, options) => { bodies.push(JSON.parse(options.body)); return stopResponse('{"schemaVersion":1}') }
  })
  await roomy.run(v2Request(scenario))
  assert.equal(bodies[0].max_tokens, 8192, 'an 81920 output capability still requests the registered 8192 target')

  bodies.length = 0
  const bounded = v2Scenario({ maxInputTokens: 128000, maxOutputTokens: 4096 })
  const small = new OpenAiCompatibleAdapter({
    fetch: async (_url, options) => { bodies.push(JSON.parse(options.body)); return stopResponse('{"schemaVersion":1}') }
  })
  await small.run(v2Request(bounded))
  assert.equal(bodies[0].max_tokens, 4096, 'a 4096 output capability requests 4096')
})

test('SEM-F39/J31-SIZE: known provider usage narrows the next outbound quota and unknown usage never becomes zero', async () => {
  const bodies = []
  const scenario = v2Scenario({ maxInputTokens: 128000, maxOutputTokens: 81920 })
  const responses = [
    toolCallsResponse({ prompt_tokens: 100, completion_tokens: 996000 }),
    stopResponse('{"schemaVersion":1}')
  ]
  const bounded = new OpenAiCompatibleAdapter({
    fetch: async (_url, options) => { bodies.push(JSON.parse(options.body)); return responses.shift() }
  })
  const result = await bounded.run(v2Request(scenario, { tools: [searchTool()] }))
  assert.equal(bodies[0].max_tokens, 8192)
  assert.equal(bodies[1].max_tokens, 4000, 'a known remaining balance of 4000 requests exactly 4000')
  assert.equal(typeof result.text, 'string')

  bodies.length = 0
  const unknownResponses = [toolCallsResponse(null), stopResponse('{"schemaVersion":1}')]
  const unknown = new OpenAiCompatibleAdapter({
    fetch: async (_url, options) => { bodies.push(JSON.parse(options.body)); return unknownResponses.shift() }
  })
  await unknown.run(v2Request(scenario, { tools: [searchTool()] }))
  assert.equal(bodies[1].max_tokens, 8192, 'missing provider usage keeps the quota at the target instead of assuming zero')
})

test('SEM-F39/F40/J31-SIZE: retry after missing request usage keeps the whole result usage unknown', async () => {
  for (const failure of ['network', 'http']) {
    let requests = 0
    const adapter = new OpenAiCompatibleAdapter({
      fetch: async () => {
        requests += 1
        if (requests === 1) {
          if (failure === 'network') throw new Error('connection reset')
          return { ok: false, status: 503 }
        }
        return stopResponse('{"schemaVersion":1}', { prompt_tokens: 100, completion_tokens: 10 })
      }
    })
    const result = await adapter.run(v2Request(v2Scenario(), { beforeRequest: async () => {} }))
    assert.equal(requests, 2)
    assert.equal(result.usage, null, `${failure}: later known usage cannot account for the failed request`)
  }
})

test('SEM-F39/J31-SIZE: an exhausted output balance rejects before any further egress', async () => {
  let egress = 0
  const scenario = v2Scenario({ maxInputTokens: 128000, maxOutputTokens: 81920 })
  const adapter = new OpenAiCompatibleAdapter({
    fetch: async () => { egress += 1; return toolCallsResponse({ prompt_tokens: 100, completion_tokens: 1000000 }) }
  })
  await assert.rejects(adapter.run(v2Request(scenario, { tools: [searchTool()] })),
    (error) => error.code === 'AGENT_BUDGET_EXCEEDED')
  assert.equal(egress, 1, 'zero remaining output balance means zero additional outbound requests')
})

test('SEM-F39/J31-SIZE/J31-COMPAT: v2 fails closed without the host quota and legacy bindings keep their request bytes', async () => {
  let egress = 0
  const scenario = v2Scenario()
  const adapter = new OpenAiCompatibleAdapter({
    fetch: async () => { egress += 1; return stopResponse('{"schemaVersion":1}') }
  })
  const { requestCapacity, ...withoutCapacity } = v2Request(scenario)
  await assert.rejects(adapter.run(withoutCapacity), (error) => error.code === 'AGENT_REQUEST_INVALID')
  await assert.rejects(adapter.run({ ...v2Request(scenario), requestCapacity: { requestOutputTokens: 8192 } }),
    (error) => error.code === 'AGENT_REQUEST_INVALID')
  assert.equal(egress, 0)
  await assert.rejects(adapter.run({
    connection: { httpsOrigin: 'https://example.test', basePath: '/v1' },
    credential: Buffer.from('secret'),
    resolvedModel: { modelId: 'model.one', capabilities: {
      maxInputTokens: 64000, maxOutputTokens: 1024, supportsToolCalling: false,
      supportsStructuredOutput: false, usageReporting: false
    } },
    prompt: 'prompt',
    requestCapacity: scenario.requestCapacity
  }), (error) => error.code === 'AGENT_REQUEST_INVALID')
  assert.equal(egress, 0)

  const bodies = []
  const legacy = new OpenAiCompatibleAdapter({
    fetch: async (_url, options) => { bodies.push(JSON.parse(options.body)); return stopResponse('{"schemaVersion":1,"answer":"bounded"}') }
  })
  await legacy.run({
    connection: { httpsOrigin: 'https://example.test', basePath: '/v1' },
    credential: Buffer.from('secret'),
    resolvedModel: { modelId: 'model.one', capabilities: {
      maxInputTokens: 64000, maxOutputTokens: 4096, supportsToolCalling: false,
      supportsStructuredOutput: false, usageReporting: false
    } },
    prompt: 'prompt'
  })
  assert.equal(bodies[0].max_tokens, 4096, 'legacy bindings keep the frozen capability as the output reserve')
})

test('SEM-F28/SEM-T04/J31-SIZE: the transport enforces the closed finish_reason set before tools or content', async () => {
  const rejections = [
    ['length', { role: 'assistant', content: '{"schemaVersion":1}' }],
    ['length', { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_context', arguments: '{}' } }] }],
    ['content_filter', { role: 'assistant', content: '{"schemaVersion":1}' }],
    [undefined, { role: 'assistant', content: '{"schemaVersion":1}' }],
    ['function_call', { role: 'assistant', content: '{"schemaVersion":1}' }],
    ['stop', { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'search_context', arguments: '{}' } }] }],
    ['tool_calls', { role: 'assistant', content: null, tool_calls: [] }]
  ]
  for (const [finishReason, message] of rejections) {
    let toolRan = false
    let egress = 0
    const adapter = new OpenAiCompatibleAdapter({
      fetch: async () => {
        egress += 1
        const choice = finishReason === undefined ? { message } : { finish_reason: finishReason, message }
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [choice] }) }
      }
    })
    await assert.rejects(adapter.run({
      connection: { httpsOrigin: 'https://example.test', basePath: '/' },
      credential: Buffer.from('secret'),
      resolvedModel: { modelId: 'model.one', capabilities: {
        maxInputTokens: 64000, maxOutputTokens: 1024, supportsToolCalling: true,
        supportsStructuredOutput: false, usageReporting: false
      } },
      prompt: 'prompt',
      tools: [{ name: 'search_context', execute: async () => { toolRan = true; return { schemaVersion: 1, matches: [] } } }],
      maxTurns: 3,
      timeoutMs: 1000
    }), (error) => error.code === 'AGENT_OUTPUT_INVALID')
    assert.equal(toolRan, false, `tools must stay idle for ${finishReason ?? 'a missing'} finish_reason`)
    assert.equal(egress, 1, `a rejected result must not trigger another egress for ${finishReason ?? 'a missing'} finish_reason`)
  }

  const whitespace = new OpenAiCompatibleAdapter({ fetch: async () => stopResponse('   \n  ') })
  await assert.rejects(whitespace.run({
    connection: { httpsOrigin: 'https://example.test', basePath: '/' },
    credential: Buffer.from('secret'),
    resolvedModel: { modelId: 'model.one', capabilities: {
      maxInputTokens: 64000, maxOutputTokens: 1024, supportsToolCalling: false,
      supportsStructuredOutput: false, usageReporting: false
    } },
    prompt: 'prompt'
  }), (error) => error.code === 'AGENT_OUTPUT_INVALID')

  const responses = [toolCallsResponse(null), stopResponse('{"schemaVersion":1}')]
  const cooperative = new OpenAiCompatibleAdapter({ fetch: async () => responses.shift() })
  const result = await cooperative.run({
    connection: { httpsOrigin: 'https://example.test', basePath: '/' },
    credential: Buffer.from('secret'),
    resolvedModel: { modelId: 'model.one', capabilities: {
      maxInputTokens: 64000, maxOutputTokens: 1024, supportsToolCalling: true,
      supportsStructuredOutput: false, usageReporting: false
    } },
    prompt: 'prompt',
    tools: [searchTool()],
    maxTurns: 3,
    timeoutMs: 1000
  })
  assert.equal(result.text, '{"schemaVersion":1}')
})

test('SEM-F39/J31-SIZE: tool message growth beyond the v2 input window rejects before the next egress', async () => {
  let egress = 0
  const scenario = v2Scenario({ maxInputTokens: 20000, maxOutputTokens: 8192 })
  const responses = [toolCallsResponse(null), stopResponse('{"schemaVersion":1}')]
  const adapter = new OpenAiCompatibleAdapter({
    fetch: async () => { egress += 1; return responses.shift() }
  })
  await assert.rejects(adapter.run(v2Request(scenario, {
    tools: [searchTool({ schemaVersion: 1, matches: [{ text: 'x'.repeat(60000) }] })]
  })), (error) => error.code === 'AGENT_BUDGET_EXCEEDED')
  assert.equal(egress, 1, 'the growth check must fire before the second outbound request')
})
