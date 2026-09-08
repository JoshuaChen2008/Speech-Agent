'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { AgentLoopExecutor } = require('../../src/agent/execution-host/agent-loop')
const { FormalAgentRunRunner } = require('../../src/agent/execution-host/formal-agent-run-runner')
const { deriveRecipeBudget } = require('../../src/agent/contracts/budget-axes')

const capabilities = {
  maxInputTokens: 64000,
  maxOutputTokens: 4096,
  supportsToolCalling: true,
  supportsStructuredOutput: true,
  supportsStreaming: true,
  usageReporting: true
}

function harness ({ adapterRun, failResult = { state: 'retry_wait' } } = {}) {
  const sourceRef = { sessionId: 'session.runner', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 2 }
  const binding = {
    runId: 'run.user.runner', modelId: 'model.runner', profileId: 'profile.runner',
    credentialSlotId: 'slot.runner', httpsOrigin: 'https://provider.test', basePath: '/v1',
    capabilities, budget: deriveRecipeBudget(capabilities, 'qa.answer', '1', 'user')
  }
  const calls = []
  const interactions = {
    async startToolCall (request) { calls.push(['tool.start', request]); return request },
    async finishToolCall (request) { calls.push(['tool.finish', request]); return request },
    async terminalize (request) { calls.push(['terminalize', request]); return request }
  }
  const loop = new AgentLoopExecutor({
    adapter: { run: adapterRun || (async ({ tools }) => {
      const result = await tools[0].execute({ schemaVersion: 1, aliasKeys: ['none'] })
      assert.deepEqual(result, { schemaVersion: 1, matches: [], unmatchedAliasKeys: ['none'] })
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
      async failFormalAgentRun (request) { calls.push(['fail', request]); return failResult }
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
        return {
          scope: { registeredAliasKeys: [], memoryRefs: [], sourceRefs: [] },
          entries: [], sources: []
        }
      }
    },
    modelAccess: {
      async bind () { calls.push(['bind']); return binding }
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

test('SEM-F15/SEM-F16/SEM-F28/SEM-F34/J22: user target runner resolves bounded context, uses one loop and terminalizes SQLite interaction facts', async () => {
  const { runner, calls, sourceRef } = harness()
  const result = await runner.run(job())
  assert.equal(result.terminalReason, 'succeeded')
  assert.equal(calls.filter(([kind]) => kind === 'bind').length, 1)
  assert.equal(calls.filter(([kind]) => kind === 'resolve').length, 1)
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
