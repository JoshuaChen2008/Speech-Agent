'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { AgentLoopExecutor, shouldStopAfterTurn } = require('../../src/agent/execution-host/agent-loop')
const { RECIPE_CATALOG, getRecipe } = require('../../src/agent/contracts/recipes')
const { outputDirectiveFor, summaryStageDirective } = require('../../src/agent/contracts/recipe-output-directives')
const { deriveRecipeBudget, deriveRecipeRequestCapacity, usesModelWindowCapacity } = require('../../src/agent/contracts/budget-axes')
const { createNetworkAdapter, providerResponse } = require('../integration/provider-network-fixture')

function harness (recipeId = 'qa.answer', recipeVersion = '1', fetch, onToolCall) {
  const recipe = getRecipe(recipeId, recipeVersion)
  const capabilities = { maxInputTokens: 128000, maxOutputTokens: 4096, supportsToolCalling: true,
    supportsStructuredOutput: true, supportsStreaming: false, usageReporting: true }
  const budget = deriveRecipeBudget(capabilities, recipeId, recipeVersion, 'user')
  const binding = { modelId: 'controlled-model', capabilities, budget }
  const summaryStage = recipeId === 'summary.minutes' && recipeVersion === '3' ? 'verifying_sources' : undefined
  const directive = summaryStage ? summaryStageDirective(summaryStage) : outputDirectiveFor(recipe)
  const requests = []
  const adapter = createNetworkAdapter({ fetch: async (url, options) => {
    requests.push(JSON.parse(options.body))
    return fetch ? fetch(url, options) : providerResponse(outputDirectiveFor(recipe).example)
  } })
  const executor = new AgentLoopExecutor({ onToolCall, adapter: { binding, exchange: request => adapter.exchange({
    ...request, resolvedModel: binding, connection: { httpsOrigin: 'https://example.test', basePath: '/' },
    credential: Buffer.from('synthetic-secret') }) } })
  return { executor, requests, input: { recipeId, recipeVersion, prompt: 'bounded prompt', resolvedModel: binding,
    beforeRequest: async () => ({ reserved: true }),
    budget, ...(summaryStage ? { summaryStage } : {}), ...(usesModelWindowCapacity(recipeId, recipeVersion)
      ? { requestCapacity: deriveRecipeRequestCapacity({ ...recipe, capabilities, budget, binding, summaryStage }) } : {}) } }
}

function call (id, name = 'search_context', args = { schemaVersion: 1, aliasKeys: ['none'] }) {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }
}

test('SEM-F28/F33/J22: the Agent Loop requires a single exchange boundary', () => {
  assert.throws(() => new AgentLoopExecutor(), /agent loop exchange is required/)
  assert.throws(() => new AgentLoopExecutor({ adapter: { run: () => {} } }), /agent loop exchange is required/)
})

test('SEM-F28/F33/J22/J24/J31-COMPAT: registered recipe identities use real Pi and their versioned output directives', async () => {
  for (const recipe of RECIPE_CATALOG) {
    const { executor, requests, input } = harness(recipe.recipeId, recipe.recipeVersion)
    const result = await executor.agentLoop(input)
    assert.equal(result.maxTurns, recipe.maxTurns)
    assert.deepEqual(result.toolGrants, recipe.toolGrants)
    assert.equal(requests.length, 1)
    assert.equal(requests[0].model, input.resolvedModel.modelId)
    const directive = input.summaryStage ? summaryStageDirective(input.summaryStage) : outputDirectiveFor(recipe)
    assert.equal(requests[0].messages[0].content, directive.systemPrompt)
    assert.deepEqual(JSON.parse(result.text), outputDirectiveFor(recipe).example)
    assert.equal(result.usage, null)
  }
})

test('SEM-F39/J31-SIZE/J31-COMPAT: window capacity permits the v2 summary prompt above the legacy limit', async () => {
  const short = harness('summary.minutes', '1')
  await assert.rejects(short.executor.agentLoop({ ...short.input, prompt: '中'.repeat(17000) }),
    error => error.code === 'AGENT_REQUEST_INVALID')
  assert.equal(short.requests.length, 0)
  const long = harness('summary.minutes', '2')
  await long.executor.agentLoop({ ...long.input, prompt: '中'.repeat(17000) })
  assert.equal(long.requests.length, 1)
  await assert.rejects(long.executor.agentLoop({ ...long.input, requestCapacity: undefined }),
    error => error.code === 'AGENT_REQUEST_INVALID')
})

test('SEM-F28/F31/J22/J24: static grants and turn limits reject before tool effects', async () => {
  let effects = 0
  const one = harness('intent.route', '1', async () => providerResponse(null, [call('call.1')]))
  await assert.rejects(one.executor.agentLoop(one.input), error => error.code === 'AGENT_BUDGET_EXCEEDED')
  const denied = harness()
  await assert.rejects(denied.executor.agentLoop({ ...denied.input,
    tools: [{ name: 'read_sources', execute: async () => { effects++ } }] }),
  error => error.code === 'TOOL_NOT_AVAILABLE_FOR_RECIPE')
  assert.equal(denied.requests.length, 0)
  const exhausted = harness('qa.answer', '1', async () => providerResponse(null, [call('call.1')]))
  await assert.rejects(exhausted.executor.agentLoop({ ...exhausted.input,
    tools: [{ name: 'search_context', execute: async () => { effects++; return {} } }] }),
  error => error.code === 'AGENT_BUDGET_EXCEEDED')
  assert.equal(exhausted.requests.length, 3)
  assert.equal(effects, 2)
  assert.equal(shouldStopAfterTurn({ maxTurns: 1, turn: 1 }), true)
  assert.equal(shouldStopAfterTurn({ maxTurns: 3, turn: 1, toolCalls: 12, maxToolCalls: 12 }), true)
})

test('SEM-F31/F40/J22/J30-CANCEL: real Pi executes tools in provider order and stops between tools', async () => {
  const order = []; let active = 0; let peak = 0; let turn = 0
  const h = harness('qa.answer', '1', async () => ++turn === 1
    ? providerResponse(null, [call('call.1'), call('call.2')])
    : providerResponse(outputDirectiveFor(getRecipe('qa.answer', '1')).example))
  await h.executor.agentLoop({ ...h.input, tools: [{ name: 'search_context', execute: async () => {
    active++; peak = Math.max(peak, active); order.push(order.length + 1)
    await new Promise(resolve => setImmediate(resolve)); active--; return {}
  } }] })
  assert.deepEqual(order, [1, 2]); assert.equal(peak, 1); assert.equal(h.requests.length, 2)
  const controller = new AbortController()
  let count = 0
  const cancelled = harness('qa.answer', '1', async () => providerResponse(null, [call('call.1'), call('call.2')]))
  await assert.rejects(cancelled.executor.agentLoop({ ...cancelled.input, signal: controller.signal,
    tools: [{ name: 'search_context', execute: async () => { count++; controller.abort(); return {} } }] }),
  error => error.code === 'AGENT_CANCELLED')
  assert.equal(count, 1); assert.equal(cancelled.requests.length, 1)
})

test('SEM-F40/J30-DIAG: intermediate tool content stays out of progress and result metadata', async () => {
  const marker = 'J30_PRIVACY_LOOP_TOOL_MARKER'
  const progress = []; const observed = []; let turn = 0
  const h = harness('qa.answer', '1', async () => ++turn === 1
    ? providerResponse(null, [call('call.1', 'search_context', { query: marker })])
    : providerResponse(outputDirectiveFor(getRecipe('qa.answer', '1')).example), event => observed.push(event))
  const result = await h.executor.agentLoop({ ...h.input, onProgress: event => progress.push(event),
    tools: [{ name: 'search_context', execute: async args => {
      assert.deepEqual(args, { query: marker }); return { text: marker }
    } }] })
  assert.deepEqual(observed, [{ toolName: 'search_context' }])
  assert.equal(progress.length, 4)
  assert.equal(JSON.stringify({ progress, observed, result }).includes(marker), false)
  assert.equal(h.requests[1].messages.at(-1).content.includes(marker), true)
})

test('SEM-F28/F33/J22/J30-CANCEL: frozen identity and cancellation prohibit continuation and late success', async () => {
  const h = harness('intent.route')
  await assert.rejects(h.executor.agentLoop({ ...h.input, resolvedModel: { ...h.input.resolvedModel, modelId: 'changed' } }),
    error => error.code === 'AGENT_REQUEST_INVALID')
  assert.equal(h.requests.length, 0)
  assert.equal(Object.hasOwn(h.executor, 'agentLoopContinue'), false)
  const controller = new AbortController()
  let release; let entered
  const started = new Promise(resolve => { entered = resolve })
  const pendingResponse = new Promise(resolve => { release = resolve })
  const late = harness('intent.route', '1', async () => { entered(); return pendingResponse })
  const pending = late.executor.agentLoop({ ...late.input, signal: controller.signal })
  await started; controller.abort()
  await assert.rejects(pending, error => error.code === 'AGENT_CANCELLED')
  release(providerResponse(outputDirectiveFor(getRecipe('intent.route', '1')).example))
})

test('SEM-F38/J30-CANCEL: host deadline bounds a noncooperative network and consumes late rejection', async () => {
  let reject; let entered; let providerSignal
  const started = new Promise(resolve => { entered = resolve })
  const h = harness('qa.answer', '1', async (_url, options) => {
    providerSignal = options.signal; entered(); return new Promise((resolve, fail) => { reject = fail })
  })
  const pending = h.executor.agentLoop({ ...h.input, timeoutMs: 60 })
  await started
  await assert.rejects(pending, error => error.code === 'AGENT_PROVIDER_TIMEOUT')
  assert.equal(providerSignal.aborted, true)
  reject(new Error('late network failure'))
  await new Promise(resolve => setImmediate(resolve))
})

test('SEM-F28/F31/J22/J24: business Schema validation belongs to the host and forbids partial output', async () => {
  for (const content of ['invalid json', { schemaVersion: 1, answer: 'missing refs' }]) {
    const h = harness('qa.answer', '1', async () => providerResponse(content))
    await assert.rejects(h.executor.agentLoop(h.input), error => error.code === 'AGENT_OUTPUT_INVALID')
    assert.equal(h.requests.length, 1)
  }
})

test('SEM-F28/F40/J30-RECOVERY: unknown and replayed durable reservations prohibit any network effect', async () => {
  for (const receipt of [undefined, { reserved: false }, { reserved: true, replayed: true }]) {
    const h = harness()
    await assert.rejects(h.executor.agentLoop({ ...h.input, beforeRequest: async () => receipt }),
      error => error.code === 'AGENT_RUN_UNAVAILABLE')
    assert.equal(h.requests.length, 0)
  }
})

test('SEM-F28/F40/J30-RECOVERY: Retry-After gates retries and failed exchange usage remains unknown', async () => {
  const times = []; const waits = []; let reservations = 0
  const h = harness('qa.answer', '1', async () => {
    times.push(performance.now())
    return times.length === 1 ? { status: 429, ok: false, headers: { get: name => name === 'retry-after' ? '0.05' : null } }
      : providerResponse(outputDirectiveFor(getRecipe('qa.answer', '1')).example, [], { prompt_tokens: 3, completion_tokens: 2 })
  })
  const result = await h.executor.agentLoop({ ...h.input, retryPolicyVersion: 'agent-retry@2',
    beforeRequest: async () => { reservations++; return { reserved: true, retryPolicyVersion: 'agent-retry@2' } },
    onProgress: event => { if (event.type === 'retry_wait') waits.push(event.waitMs) } })
  assert.deepEqual(waits, [50]); assert.equal(reservations, 2)
  assert.ok(times[1] - times[0] >= 49)
  assert.equal(result.usage, null)
})

test('SEM-F28/F40/J30-CANCEL/RECOVERY: retry waits cancel promptly and cannot exceed the total deadline', async () => {
  const controller = new AbortController()
  const rateLimited = () => ({ status: 503, ok: false, headers: { get: name => name === 'retry-after' ? '2' : null } })
  const h = harness('qa.answer', '1', async () => rateLimited())
  await assert.rejects(h.executor.agentLoop({ ...h.input, retryPolicyVersion: 'agent-retry@2', signal: controller.signal,
    onProgress: event => { if (event.type === 'retry_wait') controller.abort() } }), error => error.code === 'AGENT_CANCELLED')
  assert.equal(h.requests.length, 1)
  const deadline = harness('qa.answer', '1', async () => rateLimited())
  await assert.rejects(deadline.executor.agentLoop({ ...deadline.input, retryPolicyVersion: 'agent-retry@2', timeoutMs: 200 }),
    error => error.code === 'AGENT_PROVIDER_UNAVAILABLE' && error.retryExhausted === true)
  assert.equal(deadline.requests.length, 1)
})
