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
        assert.ok(Array.isArray(request.tools), 'default runtime interaction adapter must expose audited tools')
        await request.tools[0].execute({ schemaVersion: 1, aliasKeys: ['decision'] })
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
  assert.equal(calls.filter(([name]) => name === 'tool:start').length, 1)
  assert.equal(calls.filter(([name]) => name === 'tool:finish').length, 1)
  await runtime.stop()
})
