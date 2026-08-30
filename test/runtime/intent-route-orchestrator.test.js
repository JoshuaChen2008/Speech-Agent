'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { IntentRouteOrchestrator } = require('../../src/agent/execution-host/intent-route-orchestrator')

function harness ({ eligibility = 'ready', loopResult = { recipeId: 'summary.minutes', confidence: 0.83 }, loopError = null } = {}) {
  const calls = []
  let sequence = 0
  const runs = new Map()
  const interactions = new Map()
  const orchestrator = new IntentRouteOrchestrator({
    eligibility: async () => eligibility,
    runs: {
      create: async (request) => {
        calls.push(['run.create', request])
        const run = { runId: request.runId, recipeId: request.recipeId, state: 'queued' }
        runs.set(run.runId, run)
        return run
      },
      cancel: async (request) => {
        calls.push(['run.cancel', request])
        const run = runs.get(request.runId) || { runId: request.runId }
        run.state = 'cancelled'
        return { ...run, state: 'cancelled' }
      }
    },
    modelAccess: { bind: async (request) => { calls.push(['bind', request]); return { runId: request.runId, modelId: 'model.test', capabilities: { usageReporting: true } } } },
    interactions: {
      create: async (request) => { calls.push(['interaction.create', request]); interactions.set(request.interactionId, request); return { interactionId: request.interactionId, terminalReason: null } },
      terminalize: async (request) => { calls.push(['interaction.terminalize', request]); return { interactionId: request.interactionId, terminalReason: request.terminalReason } }
    },
    loop: {
      agentLoop: async (request) => {
        calls.push(['loop', request])
        if (loopError) throw Object.assign(new Error(loopError), { code: loopError })
        return { result: loopResult, usage: null }
      }
    },
    resolveModel: async () => ({ model: 'model.test', streamFn: async function * () {} }),
    idFactory: () => `id.${++sequence}`
  })
  return { orchestrator, calls, runs, interactions }
}

const base = {
  scope: { kind: 'session', reference: 'session.route' },
  prompt: '请整理这场会',
  transcriptVersion: 'raw', inputWatermark: { throughEventOrder: 3 }, inputDigest: 'b'.repeat(64),
  clientIdempotencyKey: 'client.route', signal: null
}

test('SEM-F16/SEM-F28/J22/J24: model-first route creates independent route and target runs', async () => {
  const { orchestrator, calls } = harness()
  const result = await orchestrator.submit(base)
  assert.equal(result.recipeId, 'summary.minutes')
  assert.equal(result.routingMode, 'model')
  assert.equal(calls.filter(([name]) => name === 'run.create').length, 2)
  assert.equal(calls.filter(([name]) => name === 'bind').length, 2)
  const route = calls.find(([name, request]) => name === 'run.create' && request.recipeId === 'intent.route')
  const target = calls.find(([name, request]) => name === 'run.create' && request.recipeId === 'summary.minutes')
  assert.notEqual(route[1].runId, target[1].runId)
  assert.equal(calls.find(([name, request]) => name === 'interaction.create' && request.runId === target[1].runId)[1].routingMode, 'model')
})

test('SEM-F16/SEM-F28/J22: non-ready and route failures use deterministic rules without confidence thresholds', async () => {
  const unavailable = harness({ eligibility: 'credential_unavailable' })
  const fallback = await unavailable.orchestrator.submit({ ...base, prompt: '请分析内容' })
  assert.equal(fallback.recipeId, 'report.analysis')
  assert.equal(fallback.routingMode, 'rules')
  assert.equal(unavailable.calls.filter(([name]) => name === 'loop').length, 0)
  const failed = harness({ loopError: 'AGENT_PROVIDER_TIMEOUT' })
  const result = await failed.orchestrator.submit({ ...base, prompt: '没有关键词' })
  assert.equal(result.recipeId, 'qa.answer')
  assert.equal(result.routingMode, 'rules')
  assert.equal(failed.calls.some(([name, request]) => name === 'interaction.terminalize' && request.terminalReason === 'failed'), true)
})

test('SEM-F29/SEM-F16/J22: cancelled route never falls back or creates a target run', async () => {
  const harnessed = harness({ loopError: 'AGENT_CANCELLED' })
  await assert.rejects(harnessed.orchestrator.submit({ ...base, signal: new AbortController().signal }), (error) => error.code === 'AGENT_CANCELLED')
  assert.equal(harnessed.calls.filter(([name]) => name === 'run.create').length, 1)
  assert.equal(harnessed.calls.filter(([name, request]) => name === 'run.create' && request.recipeId !== 'intent.route').length, 0)
})

test('SEM-F29/SEM-F16/J22: reselect cancels the current run before creating a new recipe run', async () => {
  const harnessed = harness()
  const result = await harnessed.orchestrator.reselect({ ...base, currentRunId: 'run.current', recipeId: 'plan.proposal' })
  assert.equal(result.recipeId, 'plan.proposal')
  assert.equal(harnessed.calls[0][0], 'run.cancel')
  assert.equal(harnessed.calls.some(([name, request]) => name === 'run.create' && request.recipeId === 'plan.proposal'), true)
})
