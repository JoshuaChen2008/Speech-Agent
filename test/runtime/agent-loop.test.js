'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { AgentLoopExecutor, shouldStopAfterTurn } = require('../../src/agent/execution-host/agent-loop')
const { RECIPE_CATALOG } = require('../../src/agent/contracts/recipes')

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
    const result = await executor.agentLoop({
      recipeId: recipe.recipeId,
      recipeVersion: recipe.recipeVersion,
      prompt: 'bounded prompt',
      resolvedModel: { model: 'test', streamFn: async function * () {} }
    })
    assert.equal(result.recipeId, recipe.recipeId)
    assert.equal(result.maxTurns, recipe.maxTurns)
    assert.deepEqual(result.toolGrants, recipe.toolGrants)
  }
  assert.equal(calls.length, RECIPE_CATALOG.length)
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
  assert.equal(seenSignal, controller.signal)
  assert.equal(Object.hasOwn(executor, 'agentLoopContinue'), false)
})
