'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const { PersonalContextRuntime } = require('../../src/agent/personal-context/runtime')
const { deriveRecipeBudget } = require('../../src/agent/contracts/budget-axes')

function nextTurn () {
  return new Promise((resolve) => setImmediate(resolve))
}

test('SEM-F00/SEM-F28/SEM-F30/J21: runtime keeps S1 terminal notifications ineligible and removes them before stop', async () => {
  let listener = null
  let unsubscribed = false
  let claims = 0
  const gateway = {
    personalContextIngest: async () => ({}),
    personalContextResolve: async () => ({}),
    personalContextManage: async () => ({
      revision: 0, totalCount: 0, hasMore: false, nextCursor: null, rows: []
    }),
    claimNextFormalAgentRun: async () => { claims += 1; return null },
    nextFormalAgentRunAt: async () => null,
    completeFormalAgentRun: async () => ({}),
    failFormalAgentRun: async () => ({})
  }
  const runtime = new PersonalContextRuntime({
    gateway,
    config: {
      get: () => ({
        agentEnabled: false, memoryEnabled: true, cloudDisclosureAccepted: false,
        memoryProcessingSince: null, agentSettingsRevision: 0
      }),
      updateAgentSettings: () => { throw new Error('not expected') }
    }
  })
  assert.equal(runtime.start({
    onTerminalCommitted: (callback) => {
      listener = callback
      return () => { unsubscribed = true; listener = null }
    }
  }), true)
  await nextTurn()
  const initialClaims = claims
  listener({ sessionId: 'session.terminal' })
  await nextTurn()
  assert.equal(claims, initialClaims)
  await runtime.stop()
  assert.equal(unsubscribed, true)
  assert.equal(listener, null)
})

test('SEM-F00/SEM-F30/J21: main stops Agent listeners and scheduler before subtitle gateway shutdown', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'src/main.js'), 'utf8')
  const agentStop = source.indexOf('await personalContextRuntime.stop()')
  const subtitleShutdown = source.indexOf('applicationRuntime.shutdownWithin', agentStop)
  const subtitleStart = source.indexOf('const started = await applicationRuntime.start()')
  const agentRuntimeLoad = source.indexOf("require('./agent/personal-context/runtime')")
  assert.ok(agentStop > 0)
  assert.ok(subtitleShutdown > agentStop)
  assert.ok(agentRuntimeLoad > subtitleStart, 'Agent runtime must load only after subtitle startup enters its guarded seam')
  assert.match(source, /catch \{\s*personalContextRuntime = null\s*console\.error\('\[agent\.runtime\] AGENT_CONTEXT_UNAVAILABLE'\)/)
})

test('SEM-F28/SEM-F30/SEM-T10/J22/J24: ready terminal notice prepares one session ingest through scheduler lifecycle', async () => {
  let listener = null
  const calls = []
  const output = {
    schemaVersion: 1,
    experiences: [],
    memoryCandidates: []
  }
  const source = {
    sourceKind: 'session', sessionId: 'session.runtime', transcriptVersion: 'raw',
    inputWatermark: 1, inputDigest: 'a'.repeat(64)
  }
  const gateway = {
    personalContextIngest: async () => ({}), personalContextResolve: async () => ({}),
    personalContextManage: async () => ({ revision: 0, totalCount: 0, hasMore: false, nextCursor: null, rows: [] }),
    preparePersonalContextSessionIngest: async (request) => { calls.push(['prepare', request]); return { runId: 'run.runtime' } },
    readPersonalContextSessionInput: async () => ({ ...source, events: [{ eventOrder: 1, segmentId: 'segment.1', text: 'x' }] }),
    readPersonalContextToolContext: async () => {
      const sourceRef = { sessionId: 'session.runtime', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 1 }
      const memoryRef = { memoryId: 'memory.runtime', revisionId: 'revision.runtime' }
      return {
        scope: { registeredAliasKeys: ['decision'], memoryRefs: [memoryRef], sourceRefs: [sourceRef] },
        entries: [{ aliasKey: 'decision', memoryRef, kind: 'decision', displayText: 'Bounded decision.', sourceRefs: [sourceRef] }],
        sources: [{ sourceRef, text: 'Bounded source.' }]
      }
    },
    commitPersonalContextSessionIngest: async (request) => { calls.push(['commit', request]); return { state: 'committed' } },
    claimNextFormalAgentRun: async () => calls.some(([name]) => name === 'claim') ? null : (calls.push(['claim']), {
      runId: 'run.runtime', recipeId: 'context.ingest.session', source,
      attemptIdentity: { runId: 'run.runtime', attempt: 1, owner: 'scheduler', leaseExpiresAt: 100000 }
    }),
    renewFormalAgentRun: async ({ attemptIdentity, leaseMs }) => ({
      runId: attemptIdentity.runId,
      attemptIdentity: { ...attemptIdentity, leaseExpiresAt: attemptIdentity.leaseExpiresAt + leaseMs }
    }),
    nextFormalAgentRunAt: async () => null,
    failFormalAgentRun: async (request) => { calls.push(['fail', request]); return { state: 'failed' } },
    createAgentInteraction: async (request) => { calls.push(['interaction:create', request]); return request },
    terminalizeAgentInteraction: async (request) => { calls.push(['interaction:terminalize', request]); return request },
    startAgentToolCall: async (request) => { calls.push(['tool:start', request]); return request },
    finishAgentToolCall: async (request) => { calls.push(['tool:finish', request]); return request }
  }
  const runtime = new PersonalContextRuntime({
    gateway,
    modelAccess: {
      bind: async (request) => {
        calls.push(['bind', request])
        return {
          capabilities: { usageReporting: false },
          budget: deriveRecipeBudget({ maxInputTokens: 64000, maxOutputTokens: 4096 }, 'context.ingest.session', '1', 'automatic')
        }
      }
    },
    loop: {
      agentLoop: async (request) => {
        calls.push(['loop', request])
        assert.equal(request.tools, undefined, 'background context ingestion must remain tool-free')
        return { text: JSON.stringify(output) }
      }
    },
    getAutomaticEligibility: async () => 'ready',
    config: { get: () => ({}), updateAgentSettings: () => ({}) }
  })
  runtime.start({ onTerminalCommitted: (callback) => { listener = callback; return () => { listener = null } } })
  listener({ sessionId: 'session.runtime' })
  for (let i = 0; i < 10 && !calls.some(([name]) => name === 'bind'); i++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(calls.filter(([name]) => name === 'prepare').length, 1)
  assert.equal(calls.some(([name]) => name === 'bind'), true)
  assert.equal(calls.some(([name]) => name === 'commit'), true, JSON.stringify(calls))
  assert.equal(calls.filter(([name]) => name === 'tool:start').length, 0)
  assert.equal(calls.filter(([name]) => name === 'tool:finish').length, 0)
  await runtime.stop()
})

test('SEM-F28/SEM-T04/J21: stopping while eligibility is pending prevents late automatic ingest and scheduler restart', async () => {
  let listener = null
  let releaseEligibility
  let prepared = 0
  const eligibility = new Promise((resolve) => { releaseEligibility = resolve })
  const gateway = {
    personalContextIngest: async () => ({}),
    personalContextResolve: async () => ({}),
    personalContextManage: async () => ({ revision: 0, totalCount: 0, hasMore: false, nextCursor: null, rows: [] }),
    preparePersonalContextSessionIngest: async () => { prepared += 1; return { runId: 'run.late' } },
    readPersonalContextSessionInput: async () => ({}),
    readPersonalContextToolContext: async () => ({}),
    commitPersonalContextSessionIngest: async () => ({}),
    claimNextFormalAgentRun: async () => null,
    nextFormalAgentRunAt: async () => null,
    completeFormalAgentRun: async () => ({}),
    failFormalAgentRun: async () => ({})
  }
  const runtime = new PersonalContextRuntime({
    gateway,
    modelAccess: { bind: async () => ({}) },
    loopFactory: async () => ({ agentLoop: async () => ({ text: '{}' }) }),
    getAutomaticEligibility: async () => eligibility,
    config: { get: () => ({}), updateAgentSettings: () => ({}) }
  })
  runtime.start({
    onTerminalCommitted: (callback) => {
      listener = callback
      return () => { listener = null }
    }
  })
  listener({ sessionId: 'session.late' })
  await new Promise((resolve) => setImmediate(resolve))
  const stopping = runtime.stop()
  releaseEligibility('ready')
  await stopping
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(prepared, 0)
  assert.equal(runtime.scheduler.started, false)
})

test('SEM-F28/SEM-T04/J21: stopping after automatic prepare starts cancels its queued skeleton before returning', async () => {
  let listener = null
  let prepareStarted = false
  let releasePrepare
  let cancelled = 0
  const prepare = new Promise((resolve) => { releasePrepare = resolve })
  const gateway = {
    personalContextIngest: async () => ({}),
    personalContextResolve: async () => ({}),
    personalContextManage: async () => ({ revision: 0, totalCount: 0, hasMore: false, nextCursor: null, rows: [] }),
    preparePersonalContextSessionIngest: async () => {
      prepareStarted = true
      await prepare
      return { runId: 'run.prepare-late' }
    },
    cancelPersonalContextSessionIngest: async ({ runId }) => {
      assert.equal(runId, 'run.prepare-late')
      cancelled += 1
      return { runId, state: 'cancelled', replayed: false }
    },
    readPersonalContextSessionInput: async () => ({}),
    readPersonalContextToolContext: async () => ({}),
    commitPersonalContextSessionIngest: async () => ({}),
    claimNextFormalAgentRun: async () => null,
    nextFormalAgentRunAt: async () => null,
    completeFormalAgentRun: async () => ({}),
    failFormalAgentRun: async () => ({})
  }
  const runtime = new PersonalContextRuntime({
    gateway,
    modelAccess: { bind: async () => ({}) },
    loopFactory: async () => ({ agentLoop: async () => ({ text: '{}' }) }),
    getAutomaticEligibility: async () => 'ready',
    config: { get: () => ({}), updateAgentSettings: () => ({}) }
  })
  runtime.start({
    onTerminalCommitted: (callback) => {
      listener = callback
      return () => { listener = null }
    }
  })
  listener({ sessionId: 'session.prepare-late' })
  for (let index = 0; index < 10 && !prepareStarted; index += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(prepareStarted, true)
  const stopping = runtime.stop()
  releasePrepare()
  await stopping
  assert.equal(cancelled, 1)
  assert.equal(runtime.scheduler.started, false)
})

test('SEM-F32/SEM-F35/SEM-T04/J21: stopping with a queued interaction signal cancels its skeleton and settles its waiter', async () => {
  let cancelled = 0
  const settings = {
    agentEnabled: true,
    automaticProcessingSince: 100,
    memoryEnabled: true,
    memoryProcessingSince: 100,
    cloudDisclosureAccepted: false,
    agentSettingsRevision: 0
  }
  const gateway = {
    personalContextIngest: async () => ({}),
    personalContextResolve: async () => ({}),
    personalContextManage: async () => ({ revision: 0, totalCount: 0, hasMore: false, nextCursor: null, rows: [] }),
    applyPersonalContextAutomaticPolicy: async () => ({ applied: true }),
    preparePersonalContextInteractionIngest: async () => ({ runId: 'run.interaction.stop', recipeId: 'context.ingest.interaction', replayed: false }),
    cancelPersonalContextInteractionIngest: async ({ runId }) => {
      assert.equal(runId, 'run.interaction.stop')
      cancelled += 1
      return { runId, state: 'cancelled', replayed: false }
    },
    claimNextFormalAgentRun: async () => null,
    nextFormalAgentRunAt: async () => null,
    completeFormalAgentRun: async () => ({}),
    failFormalAgentRun: async () => ({})
  }
  const runtime = new PersonalContextRuntime({
    gateway,
    config: { get: () => ({ ...settings }), updateAgentSettings: () => ({ ...settings }) },
    executionAdapter: {
      prepareSessionIngest: async () => ({ runId: 'run.session.placeholder' }),
      commitSessionIngest: async () => ({ state: 'committed' }),
      prepareInteractionIngest: async () => ({ runId: 'run.interaction.stop', recipeId: 'context.ingest.interaction', replayed: false })
    },
    modelAccess: { bind: async () => ({}) },
    loop: { agentLoop: async () => ({ text: '{}' }) }
  })
  runtime.start({ onTerminalCommitted: () => () => {} })
  for (let index = 0; index < 10 && !runtime.policyReady; index += 1) await nextTurn()
  const recording = runtime.recordInteractionSignal({
    interactionId: 'interaction.stop', signalKind: 'accept', payloadDigest: null,
    signalIdempotencyKey: 'signal.stop',
    transient: { prompt: null, editText: null, result: { schemaVersion: 1, answer: 'queued' } },
    awaitCompletion: true
  })
  for (let index = 0; index < 10 && runtime.interactionPayloads.size === 0; index += 1) await nextTurn()
  assert.equal(runtime.interactionPayloads.size, 1)
  await runtime.stop()
  const result = await recording
  assert.equal(cancelled, 1)
  assert.deepEqual(result, {
    accepted: true, replayed: false, prepared: {
      runId: 'run.interaction.stop', recipeId: 'context.ingest.interaction', replayed: false
    }, completed: false, terminalReason: 'cancelled'
  })
  assert.equal(runtime.interactionPayloads.size, 0)
  assert.equal(runtime.interactionWaiters.size, 0)
})

test('SEM-F28/SEM-T04/J21: settings refresh invalidates old terminal work but new terminal notices use the current generation', async () => {
  let listener = null
  let prepared = 0
  const eligibilityWaiters = []
  const settings = {
    agentEnabled: true,
    automaticProcessingSince: 100,
    memoryEnabled: true,
    memoryProcessingSince: 100,
    cloudDisclosureAccepted: false,
    agentSettingsRevision: 0
  }
  const gateway = {
    personalContextIngest: async () => ({}),
    personalContextResolve: async () => ({}),
    personalContextManage: async () => ({ revision: 0, totalCount: 0, hasMore: false, nextCursor: null, rows: [] }),
    applyPersonalContextAutomaticPolicy: async () => ({ applied: true }),
    preparePersonalContextSessionIngest: async () => { prepared += 1; return { runId: `run.generation.${prepared}` } },
    readPersonalContextSessionInput: async () => ({}),
    readPersonalContextToolContext: async () => ({}),
    commitPersonalContextSessionIngest: async () => ({}),
    claimNextFormalAgentRun: async () => null,
    nextFormalAgentRunAt: async () => null,
    completeFormalAgentRun: async () => ({}),
    failFormalAgentRun: async () => ({})
  }
  const runtime = new PersonalContextRuntime({
    gateway,
    modelAccess: { bind: async () => ({}) },
    loopFactory: async () => ({ agentLoop: async () => ({ text: '{}' }) }),
    getAutomaticEligibility: async () => new Promise((resolve) => eligibilityWaiters.push(resolve)),
    config: {
      get: () => ({ ...settings }),
      updateAgentSettings: (request) => {
        settings.agentEnabled = request.agentEnabled
        settings.memoryEnabled = request.memoryEnabled
        settings.cloudDisclosureAccepted = request.cloudDisclosureAccepted
        settings.agentSettingsRevision += 1
        return { ...settings }
      }
    }
  })
  runtime.start({
    onTerminalCommitted: (callback) => {
      listener = callback
      return () => { listener = null }
    }
  })
  listener({ sessionId: 'session.before-settings' })
  for (let index = 0; index < 10 && eligibilityWaiters.length < 1; index += 1) await nextTurn()
  assert.equal(eligibilityWaiters.length, 1)

  const updating = runtime.updateAgentSettings({
    expectedRevision: 0, agentEnabled: true, memoryEnabled: true, cloudDisclosureAccepted: false
  })
  await updating
  eligibilityWaiters.shift()('ready')
  await nextTurn()
  assert.equal(prepared, 0, 'work started before settings refresh must be invalidated')

  listener({ sessionId: 'session.after-settings' })
  for (let index = 0; index < 10 && eligibilityWaiters.length < 1; index += 1) await nextTurn()
  assert.equal(eligibilityWaiters.length, 1)
  eligibilityWaiters.shift()('ready')
  for (let index = 0; index < 10 && prepared === 0; index += 1) await nextTurn()
  assert.equal(prepared, 1, 'new terminal notices must observe the refreshed generation')
  await runtime.stop()
})

test('SEM-F28/SEM-T04/J21: policy application failure is surfaced and stops the automatic scheduler fail closed', async () => {
  let policyCalls = 0
  let diagnostic = null
  const gateway = {
    personalContextIngest: async () => ({}),
    personalContextResolve: async () => ({}),
    personalContextManage: async () => ({ revision: 0, totalCount: 0, hasMore: false, nextCursor: null, rows: [] }),
    applyPersonalContextAutomaticPolicy: async () => {
      policyCalls += 1
      if (policyCalls > 1) throw new Error('storage details must stay private')
      return { applied: true }
    },
    claimNextFormalAgentRun: async () => null,
    nextFormalAgentRunAt: async () => null,
    completeFormalAgentRun: async () => ({}),
    failFormalAgentRun: async () => ({})
  }
  const settings = {
    agentEnabled: true,
    automaticProcessingSince: 100,
    memoryEnabled: true,
    memoryProcessingSince: 100,
    cloudDisclosureAccepted: false,
    agentSettingsRevision: 0
  }
  const runtime = new PersonalContextRuntime({
    gateway,
    config: {
      get: () => ({ ...settings }),
      updateAgentSettings: (request) => {
        settings.agentEnabled = request.agentEnabled
        settings.memoryEnabled = request.memoryEnabled
        settings.cloudDisclosureAccepted = request.cloudDisclosureAccepted
        settings.agentSettingsRevision += 1
        return { ...settings }
      }
    },
    onDiagnostic: (event) => { diagnostic = event }
  })
  runtime.start({ onTerminalCommitted: () => () => {} })
  for (let index = 0; index < 10 && !runtime.policyReady; index += 1) await nextTurn()
  await assert.rejects(
    runtime.updateAgentSettings({
      expectedRevision: 0, agentEnabled: true, memoryEnabled: false, cloudDisclosureAccepted: false
    }),
    (error) => error?.code === 'AGENT_CONTEXT_OPERATION_FAILED'
  )
  assert.equal(runtime.policyReady, false)
  assert.equal(runtime.scheduler.started, false)
  assert.deepEqual(diagnostic, { code: 'AGENT_SCHEDULER_FAILED' })
  await runtime.stop()
})

test('SEM-F32/SEM-F35/SEM-T04/J21: policy application failure cancels queued interaction signals and settles prompt waiters', async () => {
  let policyCalls = 0
  let cancelled = 0
  const settings = {
    agentEnabled: true,
    automaticProcessingSince: 100,
    memoryEnabled: true,
    memoryProcessingSince: 100,
    cloudDisclosureAccepted: false,
    agentSettingsRevision: 0
  }
  const gateway = {
    personalContextIngest: async () => ({}),
    personalContextResolve: async () => ({}),
    personalContextManage: async () => ({ revision: 0, totalCount: 0, hasMore: false, nextCursor: null, rows: [] }),
    applyPersonalContextAutomaticPolicy: async () => {
      policyCalls += 1
      if (policyCalls > 1) throw new Error('policy store unavailable')
      return { applied: true }
    },
    cancelPersonalContextInteractionIngest: async ({ runId }) => {
      assert.equal(runId, 'run.interaction.policy-failure')
      cancelled += 1
      return { runId, state: 'cancelled', replayed: false }
    },
    claimNextFormalAgentRun: async () => null,
    nextFormalAgentRunAt: async () => null,
    completeFormalAgentRun: async () => ({}),
    failFormalAgentRun: async () => ({})
  }
  const runtime = new PersonalContextRuntime({
    gateway,
    config: {
      get: () => ({ ...settings }),
      updateAgentSettings: (request) => {
        settings.memoryEnabled = request.memoryEnabled
        settings.memoryProcessingSince = request.memoryEnabled ? 100 : null
        settings.agentSettingsRevision += 1
        return { ...settings }
      }
    },
    executionAdapter: {
      prepareSessionIngest: async () => ({ runId: 'run.session.placeholder' }),
      commitSessionIngest: async () => ({ state: 'committed' }),
      prepareInteractionIngest: async () => ({ runId: 'run.interaction.policy-failure', recipeId: 'context.ingest.interaction', replayed: false })
    },
    modelAccess: { bind: async () => ({}) },
    loop: { agentLoop: async () => ({ text: '{}' }) }
  })
  runtime.start({ onTerminalCommitted: () => () => {} })
  for (let index = 0; index < 10 && !runtime.policyReady; index += 1) await nextTurn()
  const recording = runtime.recordInteractionSignal({
    interactionId: 'interaction.policy-failure', signalKind: 'prompt', payloadDigest: null,
    signalIdempotencyKey: 'signal.policy-failure',
    transient: { prompt: 'remember this', editText: null, result: null },
    awaitCompletion: true
  })
  for (let index = 0; index < 10 && runtime.interactionPayloads.size === 0; index += 1) await nextTurn()
  assert.equal(runtime.interactionPayloads.size, 1)
  await assert.rejects(
    runtime.updateAgentSettings({ expectedRevision: 0, agentEnabled: true, memoryEnabled: false, cloudDisclosureAccepted: false }),
    (error) => error?.code === 'AGENT_CONTEXT_OPERATION_FAILED'
  )
  const result = await recording
  assert.equal(cancelled, 1)
  assert.equal(result.completed, false)
  assert.equal(result.terminalReason, 'cancelled')
  assert.equal(runtime.interactionPayloads.size, 0)
  assert.equal(runtime.interactionWaiters.size, 0)
  await runtime.stop()
})

test('SEM-F32/SEM-F35/SEM-T10/J21: explicit interaction signal is prepared only under the current automatic policy and wakes the scheduler', async () => {
  const prepared = []
  let claims = 0
  let listener = null
  const gateway = {
    personalContextIngest: async () => ({}),
    personalContextResolve: async () => ({}),
    personalContextManage: async () => ({ revision: 0, totalCount: 0, hasMore: false, nextCursor: null, rows: [] }),
    applyPersonalContextAutomaticPolicy: async () => ({ applied: true }),
    claimNextFormalAgentRun: async () => { claims += 1; return null },
    nextFormalAgentRunAt: async () => null
  }
  const settings = {
    agentEnabled: true,
    automaticProcessingSince: 100,
    memoryEnabled: true,
    memoryProcessingSince: 100,
    cloudDisclosureAccepted: false,
    agentSettingsRevision: 0
  }
  const runtime = new PersonalContextRuntime({
    gateway,
    config: { get: () => ({ ...settings }), updateAgentSettings: () => ({ ...settings }) },
    executionAdapter: {
      prepareSessionIngest: async () => ({ runId: 'run.session' }),
      prepareInteractionIngest: async (request) => {
        prepared.push(request)
        return { runId: 'run.interaction', recipeId: 'context.ingest.interaction', replayed: prepared.length > 1 }
      },
      commitSessionIngest: async () => ({ state: 'committed' })
    },
    modelAccess: { bind: async () => ({}) },
    loop: { agentLoop: async () => ({ text: '{}' }) }
  })
  runtime.start({ onTerminalCommitted: (callback) => { listener = callback; return () => { listener = null } } })
  await nextTurn()
  assert.deepEqual(await runtime.recordInteractionSignal({
    interactionId: 'interaction.runtime', signalKind: 'accept', payloadDigest: null
  }), {
    accepted: true, replayed: false,
    prepared: { runId: 'run.interaction', recipeId: 'context.ingest.interaction', replayed: false }
  })
  await nextTurn()
  assert.deepEqual(prepared, [{ interactionId: 'interaction.runtime', signalKind: 'accept', payloadDigest: null, ingestRecipeVersion: '2' }])
  assert.equal(runtime.scheduler.started, true)
  assert.equal(claims > 0, true)

  settings.memoryEnabled = false
  assert.deepEqual(await runtime.recordInteractionSignal({
    interactionId: 'interaction.disabled', signalKind: 'remember', payloadDigest: null
  }), { accepted: false, replayed: false })
  assert.equal(prepared.length, 1)
  await runtime.stop()
  assert.equal(listener, null)
})
