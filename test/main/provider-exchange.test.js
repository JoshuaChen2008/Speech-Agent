'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { OpenAiCompatibleAdapter } = require('../../src/agent/model-access/openai-compatible-adapter')
const { canonicalize } = require('../../src/runtime/storage-worker/canonical-json')

function input (overrides = {}) {
  return {
    connection: { httpsOrigin: 'https://provider.example:8443', basePath: '/v1' },
    credential: Buffer.from('synthetic-exchange-secret'),
    resolvedModel: { modelId: 'model.one', capabilities: {
      maxOutputTokens: 1024, supportsToolCalling: true, supportsStructuredOutput: true, usageReporting: true
    } },
    requestStrategy: 'openai-compatible@1',
    request: {
      schemaVersion: 1,
      messages: [{ role: 'user', content: 'Return JSON.' }],
      tools: [],
      outputContract: { mode: 'json' },
      limits: { maxOutputTokens: 128, maxRequestBytes: 512 * 1024, maxResponseBytes: 512 * 1024,
        timeoutMs: 1000, inputByteLimit: null, inputLimitError: 'AGENT_BUDGET_EXCEEDED' }
    },
    ...overrides
  }
}

function response (finishReason = 'stop', message = { content: '{"ok":true}' }, usage) {
  return new Response(JSON.stringify({ choices: [{ finish_reason: finishReason, message }], usage }))
}

test('SEM-F28/F33/J25: one exchange preserves ordered tool calls and nullable usage without executing tools', async () => {
  const requests = []
  const adapter = new OpenAiCompatibleAdapter({ fetch: async (url, options) => {
    requests.push({ url, options })
    return response('tool_calls', { content: null, reasoning_content: 'discarded-provider-field', tool_calls: [
      { id: 'call.two', type: 'function', function: { name: 'second', arguments: '{"value":2}' } },
      { id: 'call.one', type: 'function', function: { name: 'first', arguments: '{"value":1}' } }
    ] })
  } })
  const request = input()
  request.request.tools = ['first', 'second'].map(name => ({ name, parameters: { type: 'object' } }))
  const result = await adapter.exchange(request)
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://provider.example:8443/v1/chat/completions')
  assert.equal(requests[0].options.redirect, 'manual')
  assert.equal(requests[0].options.headers.authorization, '')
  assert.equal(result.schemaVersion, 1)
  assert.equal(result.finishReason, 'tool_calls')
  assert.deepEqual(result.message.toolCalls.map(call => [call.id, call.name, call.arguments.value]), [
    ['call.two', 'second', 2], ['call.one', 'first', 1]
  ])
  assert.equal(result.usage, null)
  assert.equal(JSON.stringify(result).includes('discarded-provider-field'), false)
  assert.equal(JSON.stringify(result).includes('synthetic-exchange-secret'), false)
})

test('SEM-F33/J25: frozen protocol strategies retain request bytes and reject unsupported output before egress', async () => {
  const sent = []
  const adapter = new OpenAiCompatibleAdapter({ fetch: async (_url, options) => { sent.push(options.body); return response() } })
  for (const strategy of ['openai-compatible@1', 'deepseek-openai@1', 'qwen-beijing@1']) {
    const request = input({ requestStrategy: strategy })
    await adapter.exchange(request)
    const expected = { model: 'model.one', messages: [{ role: 'user', content: 'Return JSON.' }], max_tokens: 128,
      response_format: { type: 'json_object' },
      ...(strategy === 'deepseek-openai@1' ? { thinking: { type: 'disabled' } } : {}),
      ...(strategy === 'qwen-beijing@1' ? { enable_thinking: false } : {}) }
    assert.equal(sent.at(-1), canonicalize(expected))
  }
  for (const mutate of [
    value => { value.request.outputContract = { mode: 'json_schema', name: 'Output', schema: { type: 'object' } } },
    value => { value.resolvedModel.capabilities.supportsStructuredOutput = false },
    value => { value.request.tools = [{ name: 'unsafe', parameters: {}, execute: () => { throw new Error('must not execute') } }] },
    value => { value.request.schemaVersion = 2 },
    value => { value.request.modelId = 'other.model' },
    value => { value.request.limits.maxOutputTokens = 1025 }
  ]) {
    const request = input(); mutate(request)
    await assert.rejects(adapter.exchange(request), { code: 'AGENT_REQUEST_INVALID' })
  }
  assert.equal(sent.length, 3)
  const textRequest = input()
  textRequest.request.outputContract = { mode: 'text' }
  textRequest.resolvedModel.capabilities.supportsStructuredOutput = false
  await adapter.exchange(textRequest)
  assert.equal(Object.hasOwn(JSON.parse(sent.at(-1)), 'response_format'), false)
  const nullable = new OpenAiCompatibleAdapter({ fetch: async () => response('stop', { content: '{}', tool_calls: null }) })
  assert.deepEqual((await nullable.exchange(input({ requestStrategy: 'qwen-beijing@1' }))).message.toolCalls, [])
  const malformed = new OpenAiCompatibleAdapter({ fetch: async () => response('stop', { content: '{}', tool_calls: {} }) })
  await assert.rejects(malformed.exchange(input()), { code: 'AGENT_OUTPUT_INVALID' })
})

test('SEM-F28/F40/J25/J30: exchange distinguishes finish reasons and returns bounded non-retrying errors', async () => {
  for (const finishReason of ['stop', 'length', 'content_filter', 'insufficient_system_resource', 'aborted']) {
    let requests = 0
    const adapter = new OpenAiCompatibleAdapter({ fetch: async () => { requests++; return response(finishReason) } })
    const result = await adapter.exchange(input())
    assert.equal(result.finishReason, finishReason)
    assert.equal(requests, 1)
  }
  for (const finishReason of [undefined, 'unknown', 'tool_calls']) {
    const adapter = new OpenAiCompatibleAdapter({ fetch: async () => response(finishReason) })
    // Explicit undefined must remain absent rather than the helper default.
    if (finishReason === undefined) adapter.fetch = async () => new Response('{"choices":[{"message":{"content":"{}"}}]}')
    await assert.rejects(adapter.exchange(input()), { code: 'AGENT_OUTPUT_INVALID' })
  }
  for (const [status, code] of [[401, 'AGENT_PROVIDER_AUTH_FAILED'], [429, 'AGENT_PROVIDER_RATE_LIMITED'],
    [503, 'AGENT_PROVIDER_UNAVAILABLE'], [302, 'AGENT_REQUEST_INVALID']]) {
    let requests = 0
    const adapter = new OpenAiCompatibleAdapter({ fetch: async () => { requests++; return new Response('private-provider-error', { status }) } })
    await assert.rejects(adapter.exchange(input()), error => error.code === code && !error.message.includes('private-provider-error'))
    assert.equal(requests, 1)
  }
})

test('SEM-F28/F40/J25/J30: actual response bytes bound success and error streams with absent or false length headers', async () => {
  for (const status of [200, 429]) {
    for (const length of [null, '1']) {
      let cancelled = false; let read = 0
      const body = new ReadableStream({
        pull (controller) { read++; controller.enqueue(new Uint8Array(65)) },
        cancel () { cancelled = true }
      }, { highWaterMark: 0 })
      const adapter = new OpenAiCompatibleAdapter({ fetch: async () => ({ status, ok: status === 200,
        headers: { get: () => length }, body,
        text: () => { throw new Error('whole-body consumption is forbidden') }
      }) })
      const request = input(); request.request.limits.maxResponseBytes = 128
      await assert.rejects(adapter.exchange(request), { code: 'AGENT_OUTPUT_INVALID' })
      assert.equal(read, 2)
      assert.equal(cancelled, true)
    }
  }
  const adapter = new OpenAiCompatibleAdapter({ fetch: async () => response() })
  const request = input()
  request.request.limits.maxResponseBytes = Buffer.byteLength(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }))
  assert.equal((await adapter.exchange(request)).finishReason, 'stop')
})

test('SEM-F28/F40/J30: non-cooperative network and body cancellation settle without late activity', async () => {
  let resolveFetch; const events = []
  const adapter = new OpenAiCompatibleAdapter({ fetch: () => new Promise(resolve => { resolveFetch = resolve }) })
  const request = input(); request.request.limits.timeoutMs = 20
  const pending = adapter.exchange({ ...request, onProgress: event => events.push(event.type) })
  await assert.rejects(pending, { code: 'AGENT_PROVIDER_TIMEOUT' })
  resolveFetch(response())
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(events, ['request_started'])

  let bodyCancelled = false; let bodyEntered
  const entered = new Promise(resolve => { bodyEntered = resolve })
  const body = new ReadableStream({
    pull () { bodyEntered(); return new Promise(() => {}) },
    cancel () { bodyCancelled = true }
  }, { highWaterMark: 0 })
  const bodyAdapter = new OpenAiCompatibleAdapter({ fetch: async () => ({ ok: true, status: 200, body }) })
  const controller = new AbortController()
  const bodyPending = bodyAdapter.exchange({ ...input(), signal: controller.signal })
  await entered; controller.abort()
  await assert.rejects(bodyPending, { code: 'AGENT_CANCELLED' })
  assert.equal(bodyCancelled, true)
})

test('SEM-F14/F40/J25/J30: response reader exceptions retain no raw provider details or retry flags', async () => {
  const marker = 'private-reader-exception'
  const adapter = new OpenAiCompatibleAdapter({ fetch: async () => new Response(new ReadableStream({
    pull () { throw Object.assign(new Error(marker), { code: 'AGENT_PROVIDER_AUTH_FAILED', retryable: true, body: marker }) }
  }, { highWaterMark: 0 })) })
  await assert.rejects(adapter.exchange(input()), error => {
    assert.equal(error.code, 'AGENT_OUTPUT_INVALID')
    assert.equal(error.retryable, false)
    assert.equal(JSON.stringify(error).includes(marker), false)
    assert.equal(error.stack.includes(marker), false)
    return true
  })
  const timedOut = new OpenAiCompatibleAdapter({ fetch: async () => new Response(new ReadableStream({
    pull () { throw new DOMException(marker, 'TimeoutError') }
  }, { highWaterMark: 0 })) })
  await assert.rejects(timedOut.exchange(input()), error => {
    assert.equal(error.code, 'AGENT_PROVIDER_TIMEOUT')
    assert.equal(error.retryable, false)
    assert.equal(error.stack.includes(marker), false)
    return true
  })
})
