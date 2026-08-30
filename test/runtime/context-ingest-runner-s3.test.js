'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { ContextIngestSessionRunner } = require('../../src/agent/execution-host')

const source = Object.freeze({
  sourceKind: 'session', sessionId: 'session.runner', transcriptVersion: 'raw',
  inputWatermark: 2, inputDigest: 'a'.repeat(64)
})

const output = {
  schemaVersion: 1,
  experiences: [{
    kind: 'decision', text: 'Keep the boundary',
    evidence: { sessionId: 'session.runner', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 2 },
    confidence: 'high'
  }],
  memoryCandidates: []
}

function seams (overrides = {}) {
  const calls = []
  const base = {
    personalContext: {
      prepareSessionIngest: async (value) => { calls.push(['prepare', value]); return { runId: 'run.ingest', episodeId: 'episode.ingest' } },
      readSessionInput: async (value) => { calls.push(['input', value]); return { ...value, events: [{ eventOrder: 1, segmentId: 'segment.1', text: 'boundary' }] } },
      commitSessionIngest: async (value) => { calls.push(['commit', value]); return { state: 'committed', ...value } }
    },
    storage: {
      failFormalAgentRun: async (value) => { calls.push(['fail', value]); return { state: 'retry_wait' } }
    },
    modelAccess: { bind: async (value) => { calls.push(['bind', value]); return { capabilities: { usageReporting: false } } } },
    interactions: {
      create: async (value) => { calls.push(['interaction:create', value]); return value },
      terminalize: async (value) => { calls.push(['interaction:terminalize', value]); return value }
    },
    loop: { agentLoop: async (value) => { calls.push(['loop', value]); return { text: JSON.stringify(output), usage: undefined } } },
    resolveModel: async (value) => { calls.push(['model', value]); return { model: 'fixture', streamFn: async function * () {} } },
    now: () => 100
  }
  return { options: { ...base, ...overrides }, calls }
}

test('SEM-F28/SEM-F30/SEM-T10/J22/J24: S3 session runner freezes a skeleton before bind and uses the unified loop', async () => {
  const { options, calls } = seams()
  const runner = new ContextIngestSessionRunner(options)
  assert.deepEqual(await runner.prepare(source), { runId: 'run.ingest', episodeId: 'episode.ingest' })
  const result = await runner.run({
    recipeId: 'context.ingest.session', source, attemptIdentity: { runId: 'run.ingest', attempt: 1, owner: 'runner', leaseExpiresAt: 1000 },
    interactionId: 'interaction.ingest'
  })
  assert.equal(result.state, 'succeeded')
  assert.deepEqual(calls.map(([name]) => name), ['prepare', 'bind', 'interaction:create', 'input', 'model', 'loop', 'commit', 'interaction:terminalize'])
  assert.equal(calls.find(([name]) => name === 'loop')[1].recipeId, 'context.ingest.session')
  assert.equal(calls.find(([name]) => name === 'interaction:create')[1].routingMode, 'preset')
})

test('SEM-F28/SEM-F30/SEM-T04/J22/J24: S3 session runner keeps the skeleton replayable after provider failure', async () => {
  const { options, calls } = seams({
    loop: { agentLoop: async () => { const error = new Error('provider unavailable'); error.code = 'AGENT_PROVIDER_UNAVAILABLE'; throw error } }
  })
  const runner = new ContextIngestSessionRunner(options)
  const result = await runner.run({
    recipeId: 'context.ingest.session', source, attemptIdentity: { runId: 'run.ingest', attempt: 1, owner: 'runner', leaseExpiresAt: 1000 },
    interactionId: 'interaction.ingest'
  })
  assert.equal(result, null)
  assert.deepEqual(calls.map(([name]) => name), ['bind', 'interaction:create', 'input', 'model', 'fail'])
  assert.equal(calls.some(([name]) => name === 'commit'), false)
})

test('SEM-F28/SEM-F30/SEM-T04/J22/J24: refined request with incomplete coverage falls back to one raw frozen input', async () => {
  const fallbackSource = { ...source, transcriptVersion: 'raw' }
  const { options, calls } = seams({
    personalContext: {
      prepareSessionIngest: async () => ({ runId: 'run.fallback', episodeId: 'episode.fallback', source: fallbackSource }),
      readSessionInput: async () => {
        const input = { ...fallbackSource, events: [{ eventOrder: 1, segmentId: 'segment.1', text: 'raw only' }] }
        calls.push(['input', input])
        return input
      },
      commitSessionIngest: async (value) => { calls.push(['commit', value]); return { state: 'committed' } }
    }
  })
  const runner = new ContextIngestSessionRunner(options)
  const result = await runner.run({
    recipeId: 'context.ingest.session', source: fallbackSource,
    attemptIdentity: { runId: 'run.fallback', attempt: 1, owner: 'runner', leaseExpiresAt: 1000 }, interactionId: 'interaction.fallback'
  })
  assert.equal(result.state, 'succeeded')
  const input = calls.find(([name]) => name === 'input')[1]
  assert.equal(input.transcriptVersion, 'raw')
})
