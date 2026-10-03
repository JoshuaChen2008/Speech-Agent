'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { AgentLoopExecutor, shouldStopAfterTurn } = require('../../src/agent/execution-host/agent-loop')
const { RECIPE_CATALOG } = require('../../src/agent/contracts/recipes')
const {
  deriveRecipeBudget,
  deriveRecipeRequestCapacity,
  usesModelWindowCapacity,
  deriveSummaryMinutesV2RequestCapacity
} = require('../../src/agent/contracts/budget-axes')

test('SEM-F28/SEM-F29/J22/J27: the formal Agent Loop requires an execution-host adapter', () => {
  assert.throws(() => new AgentLoopExecutor(), /agent loop adapter is required/)
})

test('SEM-F16/SEM-F28/J22/J24: every registered recipe enters one agentLoop with static turns and grants', async () => {
  const calls = []
  const executor = new AgentLoopExecutor({
    adapter: {
      run: async (request) => {
        calls.push(request)
        assert.equal(typeof request.shouldStopAfterTurn, 'function')
        assert.equal(request.maxTurns, request.recipe.maxTurns)
        return { text: '{}' }
      }
    }
  })
  for (const recipe of RECIPE_CATALOG) {
    const capabilities = { maxInputTokens: 64000, maxOutputTokens: 4096 }
    const budget = deriveRecipeBudget(capabilities, recipe.recipeId, recipe.recipeVersion, 'user')
    const result = await executor.agentLoop({
      recipeId: recipe.recipeId,
      recipeVersion: recipe.recipeVersion,
      prompt: 'bounded prompt',
      resolvedModel: { model: 'test', streamFn: async function * () {}, capabilities, budget },
      ...(usesModelWindowCapacity(recipe.recipeId, recipe.recipeVersion)
        ? { requestCapacity: deriveRecipeRequestCapacity({ ...recipe, capabilities, budget }) }
        : {})
    })
    assert.equal(result.recipeId, recipe.recipeId)
    assert.equal(result.maxTurns, recipe.maxTurns)
    assert.deepEqual(result.toolGrants, recipe.toolGrants)
  }
  assert.equal(calls.length, RECIPE_CATALOG.length)
})

test('SEM-F39/J31-SIZE/J31-COMPAT: v2 summary alone accepts a prompt above the legacy Loop limit', async () => {
  let calls = 0
  const executor = new AgentLoopExecutor({
    adapter: { run: async () => { calls += 1; return { text: '{}' } } }
  })
  const prompt = '中'.repeat(17000)
  const input = { prompt, resolvedModel: { modelId: 'controlled-model' } }
  await assert.rejects(executor.agentLoop({ ...input, recipeId: 'summary.minutes', recipeVersion: '1' }),
    (error) => error.code === 'AGENT_REQUEST_INVALID')
  await executor.agentLoop({ ...input, recipeId: 'summary.minutes', recipeVersion: '2' })
  assert.equal(calls, 1)
})

test('SEM-F16/SEM-T10/J22: one-turn recipe stops deterministically and never creates a second turn', async () => {
  let turns = 0
  const executor = new AgentLoopExecutor({
    adapter: {
      run: async ({ shouldStopAfterTurn }) => {
        let turn = 0
        while (!shouldStopAfterTurn({ turn: ++turn, toolCalls: 0 })) {}
        turns = turn
        return { text: '{}' }
      }
    }
  })
  await executor.agentLoop({
    recipeId: 'text.rewrite', recipeVersion: '1', prompt: 'rewrite',
    resolvedModel: { model: 'test', streamFn: async function * () {} }
  })
  assert.equal(turns, 1)
  assert.equal(shouldStopAfterTurn({ maxTurns: 1, turn: 1, toolCalls: 0, maxToolCalls: 12 }), true)
  assert.equal(shouldStopAfterTurn({ maxTurns: 3, turn: 1, toolCalls: 0, maxToolCalls: 12 }), false)
})

test('SEM-F16/SEM-F34/J22: tools outside a recipe grant are refused before adapter execution', async () => {
  let adapterCalls = 0
  const executor = new AgentLoopExecutor({
    adapter: { run: async () => { adapterCalls += 1; return { text: '{}' } } }
  })
  await assert.rejects(executor.agentLoop({
    recipeId: 'qa.answer', recipeVersion: '1', prompt: 'answer',
    resolvedModel: { model: 'test', streamFn: async function * () {} },
    tools: [{ name: 'read_sources', execute: async () => {} }]
  }), (error) => error.code === 'TOOL_NOT_AVAILABLE_FOR_RECIPE')
  assert.equal(adapterCalls, 0)
})

test('SEM-F40/J30-DIAG/J12: tool bodies and raw provider progress are reduced to safe loop metadata', async () => {
  const markers = {
    prompt: 'J30_PRIVACY_LOOP_PROMPT_4_4',
    toolArguments: 'J30_PRIVACY_LOOP_TOOL_ARGUMENTS_4_4',
    toolResult: 'J30_PRIVACY_LOOP_TOOL_RESULT_4_4',
    providerEvent: 'J30_PRIVACY_LOOP_PROVIDER_EVENT_4_4'
  }
  const progress = []
  const toolCalls = []
  let observedArguments = null
  const executor = new AgentLoopExecutor({
    adapter: {
      run: async ({ tools, onProgress }) => {
        await onProgress({
          type: 'request_started',
          turn: 1,
          providerEvent: markers.providerEvent,
          prompt: markers.prompt,
          toolArguments: markers.toolArguments,
          toolResult: markers.toolResult
        })
        const result = await tools[0].execute({ query: markers.toolArguments })
        assert.equal(result.matches[0].text, markers.toolResult)
        await onProgress({ type: 'response_received', turn: 1, rawProviderEvent: markers.providerEvent })
        return { text: 'safe response', usage: null }
      }
    },
    onToolCall: (event) => toolCalls.push(event)
  })
  const result = await executor.agentLoop({
    recipeId: 'qa.answer',
    recipeVersion: '1',
    prompt: markers.prompt,
    resolvedModel: { modelId: 'controlled-provider' },
    tools: [{
      name: 'search_context',
      execute: async (input) => {
        observedArguments = input
        return { matches: [{ text: markers.toolResult }] }
      }
    }],
    onProgress: (event) => progress.push(event)
  })

  assert.deepEqual(observedArguments, { query: markers.toolArguments })
  assert.deepEqual(progress, [
    { type: 'request_started', turn: 1 },
    { type: 'response_received', turn: 1 }
  ])
  assert.deepEqual(toolCalls, [{ toolName: 'search_context' }])
  assert.equal(JSON.stringify({ result, progress, toolCalls }).includes('J30_PRIVACY_LOOP_'), false)
})

test('SEM-F28/SEM-T10/J22: cancellation is propagated and no continuation API is exposed', async () => {
  const controller = new AbortController()
  let seenSignal
  const executor = new AgentLoopExecutor({
    adapter: {
      run: async ({ signal }) => {
        seenSignal = signal
        controller.abort()
        throw Object.assign(new Error('cancelled'), { code: 'AGENT_CANCELLED' })
      }
    }
  })
  await assert.rejects(executor.agentLoop({
    recipeId: 'intent.route', recipeVersion: '1', prompt: 'route', signal: controller.signal,
    resolvedModel: { model: 'test', streamFn: async function * () {} }
  }), (error) => error.code === 'AGENT_CANCELLED')
  assert.notEqual(seenSignal, controller.signal)
  assert.equal(seenSignal.aborted, true)
  assert.equal(Object.hasOwn(executor, 'agentLoopContinue'), false)
})

test('SEM-F38/J30-CANCEL: host deadline releases a provider that never settles and consumes its late rejection', async () => {
  let rejectProvider
  let providerSignal
  const executor = new AgentLoopExecutor({
    adapter: {
      run: async ({ signal }) => {
        providerSignal = signal
        return new Promise((resolve, reject) => { rejectProvider = reject })
      }
    }
  })
  const startedAt = Date.now()
  const pending = executor.agentLoop({
    recipeId: 'qa.answer', recipeVersion: '1', prompt: 'answer', timeoutMs: 20,
    resolvedModel: { model: 'test', streamFn: async function * () {} }
  })
  await assert.rejects(pending, (error) => error.code === 'AGENT_PROVIDER_TIMEOUT')
  assert.ok(Date.now() - startedAt < 1000)
  assert.equal(providerSignal.aborted, true)

  rejectProvider(Object.assign(new Error('late provider rejection'), { code: 'AGENT_PROVIDER_UNAVAILABLE' }))
  await new Promise((resolve) => setImmediate(resolve))
})

test('SEM-F38/J30-CANCEL: cancellation releases a never-settling provider before it responds to abort', async () => {
  const controller = new AbortController()
  let providerSignal
  const executor = new AgentLoopExecutor({
    adapter: { run: async ({ signal }) => { providerSignal = signal; return new Promise(() => {}) } }
  })
  const pending = executor.agentLoop({
    recipeId: 'qa.answer', recipeVersion: '1', prompt: 'answer', signal: controller.signal,
    resolvedModel: { model: 'test', streamFn: async function * () {} }
  })
  setTimeout(() => controller.abort(), 10)
  await assert.rejects(pending, (error) => error.code === 'AGENT_CANCELLED')
  assert.equal(providerSignal.aborted, true)
})

test('SEM-F28/SEM-T04/J22/J24: a provider success arriving after cancellation is rejected before interaction settlement', async () => {
  const controller = new AbortController()
  let release
  const entered = new Promise((resolve) => { release = resolve })
  const executor = new AgentLoopExecutor({
    adapter: {
      run: async () => {
        await entered
        return { text: JSON.stringify({ recipeId: 'qa.answer', confidence: 0.5 }) }
      }
    }
  })
  const pending = executor.agentLoop({
    recipeId: 'intent.route', recipeVersion: '1', prompt: 'route', signal: controller.signal,
    resolvedModel: { model: 'test', streamFn: async function * () {} }
  })
  controller.abort()
  release()
  await assert.rejects(pending, (error) => error.code === 'AGENT_CANCELLED')
})

test('SEM-F39/J31-SIZE: the loop carries the recipe output directive as the system prompt', async () => {
  const seen = []
  const executor = new AgentLoopExecutor({
    adapter: { run: async (request) => { seen.push(request); return { text: '{}' } } }
  })
  await executor.agentLoop({
    recipeId: 'summary.minutes', recipeVersion: '2', prompt: '总结',
    resolvedModel: { modelId: 'controlled-model' }
  })
  await executor.agentLoop({
    recipeId: 'intent.route', recipeVersion: '1', prompt: 'route',
    resolvedModel: { modelId: 'controlled-model' }
  })
  assert.equal(seen.length, 2)
  assert.equal(seen[0].systemPrompt.includes('只输出一个 JSON 对象'), true)
  assert.equal(seen[0].systemPrompt.includes('todos'), true)
  assert.equal(seen[1].systemPrompt.includes('recipeId'), true)
  assert.equal(seen[1].systemPrompt.includes('todos'), false)
})

test('SEM-F39/J31-SIZE/J31-COMPAT: only summary.minutes@2 may carry the host request capacity', async () => {
  const seen = []
  const executor = new AgentLoopExecutor({
    adapter: { run: async (request) => { seen.push(request); return { text: '{}' } } }
  })
  const capacity = deriveSummaryMinutesV2RequestCapacity({
    capabilities: { maxInputTokens: 64000, maxOutputTokens: 4096 },
    budget: deriveRecipeBudget({ maxInputTokens: 64000, maxOutputTokens: 4096 }, 'summary.minutes', '2', 'user')
  })
  await executor.agentLoop({
    recipeId: 'summary.minutes', recipeVersion: '2', prompt: '总结',
    resolvedModel: { modelId: 'controlled-model' }, requestCapacity: capacity
  })
  assert.equal(seen[0].requestCapacity, capacity)
  for (const [recipeId, recipeVersion] of [['summary.minutes', '1'], ['qa.answer', '1']]) {
    await assert.rejects(executor.agentLoop({
      recipeId, recipeVersion, prompt: 'prompt',
      resolvedModel: { modelId: 'controlled-model' }, requestCapacity: capacity
    }), (error) => error.code === 'AGENT_REQUEST_INVALID')
  }
  await assert.rejects(executor.agentLoop({
    recipeId: 'summary.minutes', recipeVersion: '2', prompt: '总结',
    resolvedModel: { modelId: 'controlled-model' },
    requestCapacity: { requestOutputTokens: 8192, promptByteLimit: -1 }
  }), (error) => error.code === 'AGENT_REQUEST_INVALID')
  assert.equal(seen.length, 1)
})
