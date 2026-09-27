'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { AgentLoopExecutor } = require('../../src/agent/execution-host/agent-loop')
const { FormalAgentRunRunner } = require('../../src/agent/execution-host/formal-agent-run-runner')
const { deriveRecipeBudget } = require('../../src/agent/contracts/budget-axes')

function deferred () {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

const capabilities = {
  maxInputTokens: 64000,
  maxOutputTokens: 4096,
  supportsToolCalling: true,
  supportsStructuredOutput: true,
  supportsStreaming: true,
  usageReporting: true
}

function harness ({ adapterRun, failResult = { state: 'retry_wait' }, recipeId = 'qa.answer', toolContext = null } = {}) {
  const sourceRef = { sessionId: 'session.runner', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 2 }
  const binding = {
    runId: 'run.user.runner', modelId: 'model.runner', profileId: 'profile.runner',
    credentialSlotId: 'slot.runner', httpsOrigin: 'https://provider.test', basePath: '/v1',
    capabilities, budget: deriveRecipeBudget(capabilities, recipeId, '1', 'user')
  }
  const calls = []
  const interactions = {
    async startToolCall (request) { calls.push(['tool.start', request]); return request },
    async finishToolCall (request) { calls.push(['tool.finish', request]); return request },
    async terminalize (request) { calls.push(['terminalize', request]); return request }
  }
  const loop = new AgentLoopExecutor({
    adapter: { run: adapterRun || (async ({ recipe, tools }) => {
      const result = await tools[0].execute({ schemaVersion: 1, aliasKeys: ['none'] })
      assert.deepEqual(result, { schemaVersion: 1, matches: [], unmatchedAliasKeys: ['none'] })
      if (recipe?.recipeId === 'summary.minutes') {
        return {
          text: JSON.stringify({
            schemaVersion: 1,
            overview: '已整理会话重点。',
            conclusions: [{ text: '形成一个结论。', sourceRefs: [sourceRef] }],
            todos: [{ text: '跟进一个事项。', ownerHint: null, dueHint: null, sourceRefs: [sourceRef] }],
            risks: []
          }),
          usage: null
        }
      }
      return {
        text: JSON.stringify({
          schemaVersion: 1,
          answer: '已读取冻结会话。',
          sourceRefs: [sourceRef],
          memoryRefs: [],
          unresolved: []
        }),
        usage: null
      }
    }) }
  })
  const runner = new FormalAgentRunRunner({
    storage: {
      async failFormalAgentRun (request) {
        calls.push(['fail', request])
        const result = Array.isArray(failResult)
          ? failResult[Math.min(calls.filter(([kind]) => kind === 'fail').length - 1, failResult.length - 1)]
          : failResult
        return typeof result === 'function' ? result(request) : result
      }
    },
    personalContext: {
      async readSessionInput () {
        return {
          sourceKind: 'session', sessionId: 'session.runner', transcriptVersion: 'raw',
          inputWatermark: 2, inputDigest: 'a'.repeat(64), fromEventOrder: 1, throughEventOrder: 2,
          events: [{ eventOrder: 1, segmentId: 'segment.1', text: '第一段' }]
        }
      },
      async resolve (request) { calls.push(['resolve', request]); return { eligibility: 'ready', episodes: [], personalMemories: [], omissions: [], excludedScopes: [], hasMore: false, revision: 0 } },
      async readToolContext () {
        return toolContext || {
          scope: { registeredAliasKeys: [], memoryRefs: [], sourceRefs: [] },
          entries: [], sources: []
        }
      }
    },
    modelAccess: {
      async bind (request) { calls.push(['bind', request]); return binding }
    },
    interactions,
    promptProvider: () => '请回答这场会的重点',
    loopFactory: () => loop,
    now: () => 100
  })
  return { runner, calls, sourceRef, binding }
}

function job (overrides = {}) {
  return {
    runId: 'run.user.runner', recipeId: 'qa.answer', requestedBy: 'user',
    interactionId: 'interaction.user.runner',
    source: {
      sourceKind: 'session', sessionId: 'session.runner', transcriptVersion: 'raw',
      inputWatermark: 2, inputDigest: 'a'.repeat(64)
    },
    attemptIdentity: { runId: 'run.user.runner', attempt: 1, owner: 'scheduler.user', leaseExpiresAt: 1000 },
    ...overrides
  }
}

test('SEM-F15/SEM-F16/SEM-F28/SEM-F34/SEM-F38/J22/J29: user target runner uses bounded tool context without discarded memory pre-read', async () => {
  const { runner, calls, sourceRef } = harness()
  const result = await runner.run(job())
  assert.equal(result.terminalReason, 'succeeded')
  assert.equal(calls.filter(([kind]) => kind === 'bind').length, 1)
  assert.equal(calls.filter(([kind]) => kind === 'resolve').length, 0)
  assert.equal(calls.filter(([kind]) => kind === 'tool.start').length, 1)
  const terminal = calls.find(([kind]) => kind === 'terminalize')[1]
  assert.equal(terminal.terminalReason, 'succeeded')
  assert.deepEqual(terminal.result.sourceRefs, [sourceRef])
})

test('SEM-F28/SEM-T04/J22/J24: provider retry keeps the same attempt claim without terminalizing a partial result', async () => {
  const { runner, calls } = harness({
    adapterRun: async () => { const error = new Error('timeout'); error.code = 'AGENT_PROVIDER_TIMEOUT'; throw error }
  })
  const result = await runner.run(job())
  assert.equal(result, null)
  assert.equal(calls.filter(([kind]) => kind === 'fail').length, 1)
  assert.equal(calls.filter(([kind]) => kind === 'terminalize').length, 0)
  assert.equal(calls.find(([kind]) => kind === 'fail')[1].attemptIdentity.attempt, 1)
})

test('SEM-F28/SEM-T04/J22/J24: cancellation terminalizes without accepting a late provider result', async () => {
  const controller = new AbortController()
  const { runner, calls } = harness({
    adapterRun: async () => { controller.abort(); const error = new Error('cancelled'); error.code = 'AGENT_CANCELLED'; throw error }
  })
  await runner.run(job({ signal: controller.signal }))
  const terminal = calls.find(([kind]) => kind === 'terminalize')[1]
  assert.equal(terminal.terminalReason, 'cancelled')
  assert.equal(terminal.result, null)
})

test('SEM-F15/SEM-F16/SEM-F34/J22: summary.minutes uses the same Agent Loop and exact output Schema', async () => {
  const { runner, calls, sourceRef } = harness({ recipeId: 'summary.minutes' })
  const result = await runner.run(job({ recipeId: 'summary.minutes' }))
  assert.equal(result.terminalReason, 'succeeded')
  const terminal = calls.find(([kind]) => kind === 'terminalize')[1]
  assert.equal(terminal.terminalReason, 'succeeded')
  assert.equal(terminal.result.overview, '已整理会话重点。')
  assert.deepEqual(terminal.result.conclusions[0].sourceRefs, [sourceRef])
})

test('SEM-F38/J30-PROGRESS: runner reports actual provider and memory events without content', async () => {
  const progress = []
  const { runner, sourceRef } = harness({
    recipeId: 'summary.minutes',
    adapterRun: async ({ tools, onProgress }) => {
      await onProgress({ type: 'request_started', turn: 1 })
      const lookup = await tools[0].execute({ schemaVersion: 1, aliasKeys: ['none'] })
      assert.equal(lookup.matches.length, 0)
      await onProgress({ type: 'response_received', turn: 1 })
      return {
        text: JSON.stringify({
          schemaVersion: 1,
          overview: '只依据本次会话。',
          conclusions: [{ text: '本次决定。', sourceRefs: [sourceRef] }],
          todos: [],
          risks: []
        }),
        usage: null
      }
    }
  })
  runner.onProgress = (event) => progress.push(event)
  await runner.run(job({
    recipeId: 'summary.minutes',
    sessionSummaryRequest: { requestId: 'request.runner.progress', generation: 1 }
  }))

  assert.deepEqual(progress.map(({ phase, activity, memoryState }) => ({ phase, activity, memoryState })), [
    { phase: 'preparing', activity: false, memoryState: undefined },
    { phase: 'reading_context', activity: false, memoryState: undefined },
    { phase: 'waiting_model', activity: true, memoryState: undefined },
    { phase: 'reading_context', activity: true, memoryState: undefined },
    { phase: 'reading_context', activity: true, memoryState: 'empty' },
    { phase: 'waiting_model', activity: true, memoryState: undefined },
    { phase: 'validating', activity: false, memoryState: undefined },
    { phase: 'validating', activity: false, memoryState: undefined }
  ])
  assert.ok(progress.every((event) => event.runId === 'run.user.runner' && event.attempt === 1))
  assert.equal(JSON.stringify(progress).includes('只依据本次会话'), false)
  assert.equal(JSON.stringify(progress).includes('none'), false)
})

test('SEM-F38/J30-PROGRESS: reading_context is visible while session input is still being read', async () => {
  const { runner } = harness()
  const inputRead = deferred()
  const inputReadStarted = deferred()
  const originalReadSessionInput = runner.personalContext.readSessionInput
  const progress = []
  runner.onProgress = (event) => progress.push(event)
  runner.personalContext.readSessionInput = () => {
    inputReadStarted.resolve()
    return inputRead.promise
  }

  const pending = runner.run(job({
    sessionSummaryRequest: { requestId: 'request.runner.input-wait', generation: 1 }
  }))
  await inputReadStarted.promise
  assert.deepEqual(progress.at(-1), {
    requestId: 'request.runner.input-wait', generation: 1, runId: 'run.user.runner',
    attempt: 1, phase: 'reading_context', activity: false
  })
  inputRead.resolve(await originalReadSessionInput())
  await pending
})

test('SEM-F38/J29: summary.minutes with memory reference disabled never resolves or reads personal context', async () => {
  const seen = []
  const { runner, calls, sourceRef } = harness({
    recipeId: 'summary.minutes',
    adapterRun: async ({ prompt, tools }) => {
      seen.push({ prompt, toolCount: tools.length })
      const lookup = await tools[0].execute({ schemaVersion: 1, aliasKeys: ['memory-canary'] })
      assert.deepEqual(lookup, { schemaVersion: 1, matches: [], unmatchedAliasKeys: ['memory-canary'] })
      return {
        text: JSON.stringify({
          schemaVersion: 1,
          overview: '只依据本次会话。',
          conclusions: [{ text: '本次决定。', sourceRefs: [sourceRef] }],
          todos: [],
          risks: []
        }),
        usage: null
      }
    }
  })
  runner.personalContext.resolve = async () => { throw new Error('memory resolution must be skipped') }
  runner.personalContext.readToolContext = async () => { throw new Error('memory read must be skipped') }
  const result = await runner.run(job({ recipeId: 'summary.minutes', summaryUseMemory: false }))
  assert.equal(result.terminalReason, 'succeeded')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].prompt.includes('memory-canary'), false)
  assert.equal(seen[0].toolCount, 1)
  assert.equal(calls.some(([kind]) => kind === 'resolve'), false)
})

test('SEM-F38/SEM-T04/J29: summary memory read failure is explicit and produces no provider result', async () => {
  let providerCalls = 0
  const { runner, calls } = harness({
    recipeId: 'summary.minutes',
    adapterRun: async () => { providerCalls += 1; throw new Error('provider must not run') }
  })
  runner.personalContext.readToolContext = async () => {
    const error = new Error('changed')
    error.code = 'AGENT_INPUT_CHANGED'
    throw error
  }
  const result = await runner.run(job({ recipeId: 'summary.minutes', summaryUseMemory: true }))
  assert.equal(result, null)
  assert.equal(providerCalls, 0)
  const terminal = calls.find(([kind]) => kind === 'terminalize')[1]
  assert.equal(terminal.errorCode, 'AGENT_SUMMARY_MEMORY_READ_FAILED')
  assert.equal(terminal.result, null)
})

test('SEM-F38/SEM-T04/J29: bounded memory read failures use the same explicit recovery code', async () => {
  for (const code of ['AGENT_BUDGET_EXCEEDED', 'AGENT_REQUEST_INVALID']) {
    let providerCalls = 0
    const { runner, calls } = harness({
      recipeId: 'summary.minutes',
      adapterRun: async () => { providerCalls += 1; throw new Error('provider must not run') }
    })
    runner.personalContext.readToolContext = async () => {
      const error = new Error(code)
      error.code = code
      throw error
    }
    const result = await runner.run(job({ recipeId: 'summary.minutes', summaryUseMemory: true }))
    assert.equal(result, null)
    assert.equal(providerCalls, 0)
    const terminal = calls.find(([kind]) => kind === 'terminalize')[1]
    assert.equal(terminal.errorCode, 'AGENT_SUMMARY_MEMORY_READ_FAILED')
    assert.equal(terminal.result, null)
  }
})

test('SEM-F28/SEM-F34/J22/J24: invalid output Schema terminalizes without a partial result', async () => {
  const { runner, calls } = harness({
    adapterRun: async () => ({ text: JSON.stringify({ schemaVersion: 1, answer: '缺少引用字段' }) })
  })
  const result = await runner.run(job())
  assert.equal(result, null)
  const terminal = calls.find(([kind]) => kind === 'terminalize')[1]
  assert.deepEqual(terminal, {
    interactionId: 'interaction.user.runner', terminalReason: 'failed',
    errorCode: 'AGENT_OUTPUT_INVALID', result: null, usage: null, durationMs: 0
  })
})

test('SEM-F28/SEM-F34/J22/J24: budget exhaustion terminalizes with the task error and no result', async () => {
  const entries = Array.from({ length: 16 }, (_, index) => ({
    aliasKey: 'budget',
    memoryRef: { memoryId: `memory.budget.${index}`, revisionId: 'revision.1' },
    kind: 'decision',
    displayText: 'x'.repeat(4096),
    sourceRefs: []
  }))
  const { runner, calls } = harness({
    toolContext: {
      scope: {
        registeredAliasKeys: ['budget'],
        memoryRefs: entries.map((entry) => entry.memoryRef),
        sourceRefs: []
      },
      entries,
      sources: []
    },
    adapterRun: async ({ tools, shouldStopAfterTurn }) => {
      assert.equal(shouldStopAfterTurn({ turn: 1, toolCalls: 12 }), true)
      await tools[0].execute({ schemaVersion: 1, aliasKeys: ['budget'] })
    }
  })
  const result = await runner.run(job())
  assert.equal(result, null)
  const terminal = calls.find(([kind]) => kind === 'terminalize')[1]
  assert.equal(terminal.errorCode, 'AGENT_BUDGET_EXCEEDED')
  assert.equal(terminal.result, null)
})

test('SEM-F28/SEM-F34/J22/J24: provider timeout terminalizes only after the retry budget is exhausted', async () => {
  const { runner, calls } = harness({
    failResult: [{ state: 'retry_wait' }, { state: 'failed' }],
    adapterRun: async () => { const error = new Error('timeout'); error.code = 'AGENT_PROVIDER_TIMEOUT'; throw error }
  })
  assert.equal(await runner.run(job()), null)
  assert.equal(calls.filter(([kind]) => kind === 'terminalize').length, 0)
  assert.equal(calls.find(([kind]) => kind === 'fail')[1].attemptIdentity.attempt, 1)
  assert.equal(await runner.run(job({ attemptIdentity: { runId: 'run.user.runner', attempt: 2, owner: 'scheduler.user', leaseExpiresAt: 1100 } })), null)
  assert.equal(calls.filter(([kind]) => kind === 'fail').length, 2)
  const terminal = calls.find(([kind]) => kind === 'terminalize')[1]
  assert.equal(terminal.errorCode, 'AGENT_PROVIDER_TIMEOUT')
  assert.equal(terminal.result, null)
  assert.deepEqual(calls.filter(([kind]) => kind === 'bind').map(([, request]) => request.runId), ['run.user.runner', 'run.user.runner'])
})
