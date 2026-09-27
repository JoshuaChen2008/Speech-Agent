'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')

const { IntentRouteOrchestrator } = require('../../src/agent/execution-host/intent-route-orchestrator')

function harness ({ eligibility = 'ready', loopResult = { recipeId: 'summary.minutes', confidence: 0.83 }, loopError = null, routeBudget = Object.freeze({ maxWallClockMs: 45000 }), bindOperation = null, routeRunReplayed = false, interactionReadOperation = null } = {}) {
  const calls = []
  let sequence = 0
  const runs = new Map()
  const interactions = new Map()
  const orchestrator = new IntentRouteOrchestrator({
    eligibility: async () => eligibility,
    runs: {
      create: async (request) => {
        calls.push(['run.create', request])
        const run = { runId: request.runId, recipeId: request.recipeId, state: 'queued', ...(routeRunReplayed && request.recipeId === 'intent.route' ? { replayed: true } : {}) }
        runs.set(run.runId, run)
        return run
      },
      getInteraction: async (request) => {
        calls.push(['run.getInteraction', request])
        return interactionReadOperation ? interactionReadOperation(request) : null
      },
      cancel: async (request) => {
        calls.push(['run.cancel', request])
        const run = runs.get(request.runId) || { runId: request.runId }
        run.state = 'cancelled'
        return { ...run, state: 'cancelled' }
      }
    },
    modelAccess: { bind: async (request) => {
      calls.push(['bind', request])
      return bindOperation
        ? bindOperation(request)
        : { runId: request.runId, modelId: 'model.test', budget: routeBudget, capabilities: { usageReporting: true } }
    } },
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
  const routeBudget = Object.freeze({ maxWallClockMs: 45000 })
  const { orchestrator, calls } = harness({ routeBudget })
  const result = await orchestrator.submit(base)
  assert.equal(result.recipeId, 'summary.minutes')
  assert.equal(result.routingMode, 'model')
  assert.equal(calls.filter(([name]) => name === 'run.create').length, 2)
  assert.equal(calls.filter(([name]) => name === 'bind').length, 2)
  const route = calls.find(([name, request]) => name === 'run.create' && request.recipeId === 'intent.route')
  const target = calls.find(([name, request]) => name === 'run.create' && request.recipeId === 'summary.minutes')
  assert.notEqual(route[1].runId, target[1].runId)
  assert.equal(calls.find(([name, request]) => name === 'interaction.create' && request.runId === target[1].runId)[1].routingMode, 'model')
  assert.strictEqual(calls.find(([name]) => name === 'loop')[1].budget, routeBudget)
})

test('SEM-F38/SEM-F29/J30-CANCEL: cancellation during a non-cooperative route binding does not start the model or create a target', async () => {
  let markBindStarted
  const bindStarted = new Promise((resolve) => { markBindStarted = resolve })
  const neverSettles = new Promise(() => {})
  const controller = new AbortController()
  const { orchestrator, calls } = harness({
    bindOperation: () => {
      markBindStarted()
      return neverSettles
    }
  })
  const pending = orchestrator.submit({ ...base, signal: controller.signal })
  await bindStarted
  controller.abort()
  await assert.rejects(pending, (error) => error.code === 'AGENT_CANCELLED')
  assert.equal(calls.filter(([name]) => name === 'loop').length, 0)
  assert.deepEqual(calls.filter(([name]) => name === 'run.create').map(([, request]) => request.recipeId), ['intent.route'])
  assert.equal(calls.some(([name]) => name === 'run.cancel'), true)
})

test('SEM-F38/SEM-F29/J30-CANCEL: cancellation during fixed-target binding also stops the created run', async () => {
  let markBindStarted
  const bindStarted = new Promise((resolve) => { markBindStarted = resolve })
  const neverSettles = new Promise(() => {})
  const controller = new AbortController()
  const { orchestrator, calls } = harness({
    bindOperation: () => {
      markBindStarted()
      return neverSettles
    }
  })
  const pending = orchestrator.submitFixedTarget({
    ...base,
    requestId: 'request.fixed.cancel',
    requestGeneration: 1,
    summaryUseMemory: false,
    signal: controller.signal
  })
  await bindStarted
  controller.abort()
  await assert.rejects(pending, (error) => error.code === 'AGENT_CANCELLED')
  assert.deepEqual(calls.filter(([name]) => name === 'run.create').map(([, request]) => request.recipeId), ['summary.minutes'])
  assert.equal(calls.some(([name]) => name === 'run.cancel'), true)
  assert.equal(calls.filter(([name]) => name === 'interaction.create').length, 0)
})

test('SEM-F38/SEM-F29/J30-CANCEL: cancellation releases a replay while its existing interaction read is pending', async () => {
  let markReadStarted
  const readStarted = new Promise((resolve) => { markReadStarted = resolve })
  const neverSettles = new Promise(() => {})
  const controller = new AbortController()
  const { orchestrator, calls } = harness({
    routeRunReplayed: true,
    interactionReadOperation: () => {
      markReadStarted()
      return neverSettles
    }
  })
  const pending = orchestrator.submit({ ...base, signal: controller.signal })
  await readStarted
  controller.abort()
  await assert.rejects(pending, (error) => error.code === 'AGENT_CANCELLED')
  assert.equal(calls.filter(([name]) => name === 'run.create').length, 1)
  assert.equal(calls.filter(([name]) => name === 'run.cancel').length, 1)
  assert.equal(calls.filter(([name]) => name === 'loop').length, 0)
})

test('SEM-F38/J30-ACCEPT: fixed summary preset creates its linked target without model intent routing', async () => {
  const { orchestrator, calls } = harness()
  const result = await orchestrator.submitFixedTarget({
    ...base,
    requestId: 'request.summary.fixed',
    requestGeneration: 1,
    summaryUseMemory: false
  })
  assert.equal(result.recipeId, 'summary.minutes')
  assert.equal(result.routingMode, 'preset')
  assert.equal(calls.filter(([name]) => name === 'run.create').length, 1)
  assert.equal(calls.filter(([name]) => name === 'loop').length, 0)
  const target = calls.find(([name]) => name === 'run.create')[1]
  assert.equal(target.requestId, 'request.summary.fixed')
  assert.equal(target.requestGeneration, 1)
  assert.equal(target.summaryUseMemory, false)
})

test('SEM-F38/J30-ACCEPT: question routing keeps the real model route while excluding the fixed summary recipe', async () => {
  const { orchestrator, calls } = harness()
  const result = await orchestrator.submit({
    ...base,
    requestId: 'request.question.route',
    requestGeneration: 1,
    permittedTargetRecipes: ['qa.answer']
  })
  assert.equal(result.recipeId, 'qa.answer')
  assert.equal(result.routingMode, 'model')
  assert.equal(calls.filter(([name]) => name === 'loop').length, 1)
  const requestRuns = calls.filter(([name]) => name === 'run.create').map(([, request]) => request)
  assert.deepEqual(requestRuns.map((request) => request.recipeId), ['intent.route', 'qa.answer'])
  assert.ok(requestRuns.every((request) => request.requestId === 'request.question.route' && request.requestGeneration === 1))
  assert.equal(requestRuns.some((request) => request.recipeId === 'summary.minutes'), false)
})

test('SEM-F38/J30-ACCEPT: question rules fallback cannot turn into a fixed summary action', async () => {
  const { orchestrator, calls } = harness({ loopError: 'AGENT_PROVIDER_TIMEOUT' })
  const result = await orchestrator.submit({
    ...base,
    prompt: '请总结本次会话',
    requestId: 'request.question.fallback',
    requestGeneration: 1,
    permittedTargetRecipes: ['qa.answer']
  })
  assert.equal(result.recipeId, 'qa.answer')
  assert.equal(result.routingMode, 'rules')
  assert.equal(calls.some(([name, request]) => name === 'run.create' && request.recipeId === 'summary.minutes'), false)
})

test('SEM-F38/SEM-F16: the existing target allowlist still rejects recipes outside the configured set', async () => {
  const { orchestrator, calls } = harness({ loopResult: { recipeId: 'report.analysis', confidence: 1 } })
  orchestrator.allowedTargetRecipes = new Set(['summary.minutes', 'qa.answer'])
  const result = await orchestrator.submit(base)
  assert.equal(result.unsupported, true)
  assert.equal(result.recipeId, 'report.analysis')
  assert.equal(calls.filter(([name, request]) => name === 'run.create' && request.recipeId !== 'intent.route').length, 0)
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

test('SEM-F16/SEM-F28/J22: loopFactory is a supported production seam and stable client keys reuse route identities', async () => {
  const first = harness()
  const binding = { modelId: 'model.test', capabilities: { usageReporting: true } }
  let factoryCalls = 0
  const loopFactoryOrchestrator = new IntentRouteOrchestrator({
    runs: first.orchestrator.runs,
    modelAccess: { bind: async () => binding },
    interactions: first.orchestrator.interactions,
    loopFactory: async () => {
      factoryCalls += 1
      return { agentLoop: async () => ({ result: { recipeId: 'qa.answer', confidence: 0.8 }, usage: null }) }
    },
    idFactory: (prefix, key) => `${prefix}.${key || 'missing'}`
  })
  const result = await loopFactoryOrchestrator.submit(base)
  assert.equal(result.recipeId, 'qa.answer')
  assert.equal(factoryCalls, 1)
  const route = first.calls.find(([name, request]) => name === 'run.create' && request.recipeId === 'intent.route')
  const target = first.calls.find(([name, request]) => name === 'run.create' && request.recipeId === 'qa.answer')
  assert.equal(route[1].runId, `run.route.${base.clientIdempotencyKey}`)
  assert.equal(target[1].runId, `run.target.${base.clientIdempotencyKey}`)
})

test('SEM-F31/SEM-F32/J22/J24: model-first replay rejects a reused client key with a different prompt', async () => {
  const runs = new Map()
  const interactions = new Map()
  const orchestrator = new IntentRouteOrchestrator({
    runs: {
      create: async (request) => {
        const existing = runs.get(request.runId)
        if (existing) return { ...existing, replayed: true }
        const row = { runId: request.runId, recipeId: request.recipeId, state: 'queued' }
        runs.set(request.runId, row)
        return row
      },
      cancel: async () => ({ state: 'cancelled' }),
      getInteraction: async ({ interactionId }) => ({ interaction: interactions.get(interactionId) || null })
    },
    modelAccess: { bind: async (request) => ({ runId: request.runId, modelId: 'model.test', capabilities: { usageReporting: false } }) },
    interactions: {
      create: async (request) => {
        const existing = interactions.get(request.interactionId)
        if (existing) return { ...existing, replayed: true }
        const row = { ...request, terminalReason: null }
        interactions.set(request.interactionId, row)
        return row
      },
      terminalize: async (request) => {
        const row = interactions.get(request.interactionId)
        if (row) Object.assign(row, request)
        return request
      }
    },
    loop: { agentLoop: async () => ({ result: { recipeId: 'summary.minutes', confidence: 0.9 }, usage: null }) },
    idFactory: (prefix, stableKey) => `${prefix}.${stableKey}`
  })

  const first = await orchestrator.submit(base)
  assert.equal(first.recipeId, 'summary.minutes')
  await assert.rejects(
    () => orchestrator.submit({ ...base, prompt: '换一个问题' }),
    (error) => error?.code === 'AGENT_REQUEST_INVALID'
  )
})

test('SEM-F31/SEM-F32/J22: in-flight idempotency compares the frozen context identity as well as prompt', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const harnessed = harness()
  const orchestrator = new IntentRouteOrchestrator({
    eligibility: async () => { await gate; return 'ready' },
    runs: harnessed.orchestrator.runs,
    modelAccess: harnessed.orchestrator.modelAccess,
    interactions: harnessed.orchestrator.interactions,
    loop: { agentLoop: async () => ({ result: { recipeId: 'summary.minutes', confidence: 0.9 }, usage: null }) },
    idFactory: (prefix, key) => `${prefix}.${key || 'missing'}`
  })
  const first = orchestrator.submit(base)
  await new Promise((resolve) => setImmediate(resolve))
  const changedContext = { ...base, inputDigest: 'c'.repeat(64) }
  await assert.rejects(
    () => orchestrator.submit(changedContext),
    (error) => error?.code === 'AGENT_REQUEST_INVALID'
  )
  release()
  await first
})

test('SEM-F31/SEM-F32/J22: concurrent duplicate route submissions share one in-flight execution', async () => {
  let releaseLoop
  const loopGate = new Promise((resolve) => { releaseLoop = resolve })
  let loopCalls = 0
  const harnessed = harness()
  const orchestrator = new IntentRouteOrchestrator({
    eligibility: async () => 'ready',
    runs: harnessed.orchestrator.runs,
    modelAccess: harnessed.orchestrator.modelAccess,
    interactions: harnessed.orchestrator.interactions,
    loop: { agentLoop: async () => { loopCalls += 1; await loopGate; return { result: { recipeId: 'summary.minutes', confidence: 0.9 }, usage: null } } },
    idFactory: (prefix, key) => `${prefix}.${key || 'missing'}`
  })
  const first = orchestrator.submit(base)
  await new Promise((resolve) => setImmediate(resolve))
  const second = orchestrator.submit(base)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(loopCalls, 1)
  releaseLoop()
  const [a, b] = await Promise.all([first, second])
  assert.deepEqual(a, b)
  assert.equal(harnessed.calls.filter(([name]) => name === 'loop').length, 0)
  assert.equal(loopCalls, 1)
})

test('SEM-F31/SEM-F32/J22: persisted pending route is terminalized for recovery without a second model execution', async () => {
  const runs = new Map([['run.route.client.route', { runId:'run.route.client.route', recipeId:'intent.route', state:'queued' }]])
  const interactions = new Map([['interaction.route.client.route', {
    interactionId:'interaction.route.client.route', promptDigest:sha256Canonical(base.prompt), terminalReason:null
  }]])
  const calls = []
  const orchestrator = new IntentRouteOrchestrator({
    runs: {
      create: async (request) => { calls.push(['run.create', request]); return { ...runs.get(request.runId), replayed:true } },
      cancel: async (request) => { calls.push(['run.cancel', request]); return { runId:request.runId, state:'cancelled' } },
      getInteraction: async ({ interactionId }) => interactions.get(interactionId) || null
    },
    modelAccess: { bind: async (request) => { calls.push(['bind', request]); return {} } },
    interactions: {
      create: async () => { calls.push(['interaction.create']); return {} },
      terminalize: async (request) => { calls.push(['interaction.terminalize', request]); return request }
    },
    loop: { agentLoop: async () => { calls.push(['loop']); return { result:{ recipeId:'summary.minutes', confidence:0.9 }, usage:null } } },
    idFactory: (prefix, key) => `${prefix}.${key}`
  })
  const result = await orchestrator.submit(base)
  assert.equal(result.recipeId, 'qa.answer')
  assert.equal(calls.some(([name]) => name === 'loop'), false)
  assert.equal(calls.some(([name, request]) => name === 'bind' && request?.recipeId === 'intent.route'), false)
  assert.equal(calls.some(([name, request]) => name === 'interaction.terminalize' && request.errorCode === 'AGENT_WORKER_EXITED'), true)
})

test('SEM-F31/SEM-F32/J22: failed route recovery blocks target creation when terminalization is unconfirmed', async () => {
  const calls = []
  const orchestrator = new IntentRouteOrchestrator({
    runs: {
      create: async (request) => { calls.push(['run.create', request]); return { runId:request.runId, recipeId:'intent.route', state:'queued', replayed:true } },
      cancel: async (request) => { calls.push(['run.cancel', request]); return { state:'cancelled' } },
      getInteraction: async () => ({ terminalReason: null, promptDigest: sha256Canonical(base.prompt) })
    },
    modelAccess: { bind: async () => { calls.push(['bind']); return {} } },
    interactions: {
      create: async () => { calls.push(['interaction.create']); return {} },
      terminalize: async () => { calls.push(['interaction.terminalize']); return null }
    },
    loop: { agentLoop: async () => { calls.push(['loop']); return { result:{ recipeId:'summary.minutes', confidence:0.9 }, usage:null } } },
    idFactory: (prefix, key) => `${prefix}.${key}`
  })
  await assert.rejects(() => orchestrator.submit(base), (error) => error?.code === 'AGENT_RECOVERY_BLOCKED')
  assert.equal(calls.some(([name]) => name === 'bind'), false)
  assert.equal(calls.some(([name]) => name === 'interaction.create'), false)
  assert.equal(calls.some(([name]) => name === 'loop'), false)
})

test('SEM-F31/SEM-F32/J22: replayed route recovery blocks target creation when cancellation is unconfirmed', async () => {
  const calls = []
  const orchestrator = new IntentRouteOrchestrator({
    runs: {
      create: async (request) => { calls.push(['run.create', request]); return { runId:request.runId, recipeId:'intent.route', state:'queued', replayed:true } },
      cancel: async (request) => { calls.push(['run.cancel', request]); return null }
    },
    modelAccess: { bind: async () => { calls.push(['bind']); return {} } },
    interactions: {
      create: async () => { calls.push(['interaction.create']); return {} },
      terminalize: async () => { calls.push(['interaction.terminalize']); return {} }
    },
    loop: { agentLoop: async () => { calls.push(['loop']); return { result:{ recipeId:'summary.minutes', confidence:0.9 }, usage:null } } },
    idFactory: (prefix, key) => `${prefix}.${key}`
  })
  await assert.rejects(() => orchestrator.submit(base), (error) => error?.code === 'AGENT_RECOVERY_BLOCKED')
  assert.equal(calls.filter(([name]) => name === 'run.create').length, 1)
  assert.equal(calls.some(([name]) => name === 'bind'), false)
  assert.equal(calls.some(([name]) => name === 'interaction.create'), false)
  assert.equal(calls.some(([name]) => name === 'loop'), false)
})
