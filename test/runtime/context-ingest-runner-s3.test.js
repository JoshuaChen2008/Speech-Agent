'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { ContextIngestSessionRunner } = require('../../src/agent/execution-host')
const { sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')

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

test('SEM-F28/SEM-F30/J21: production session ingest creates its loop from the frozen model binding', async () => {
  const { options, calls } = seams({
    loop: undefined,
    loopFactory: async (binding) => {
      calls.push(['loopFactory', binding])
      return { agentLoop: async (value) => {
        calls.push(['loop', value])
        return { text: JSON.stringify(output), usage: undefined }
      } }
    }
  })
  const runner = new ContextIngestSessionRunner(options)
  const result = await runner.run({
    recipeId: 'context.ingest.session', source,
    attemptIdentity: { runId: 'run.ingest', attempt: 1, owner: 'runner', leaseExpiresAt: 1000 },
    interactionId: 'interaction.ingest'
  })
  assert.equal(result.state, 'succeeded')
  assert.equal(calls.some(([name]) => name === 'loopFactory'), true)
  assert.equal(calls.filter(([name]) => name === 'loop').length, 1)
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

test('SEM-F15/SEM-F28/SEM-F34/J21/J22/J24: background context ingestion is tool-free and passes only the frozen input to the unified loop', async () => {
  const { options, calls } = seams({
    personalContext: {
      prepareSessionIngest: async () => ({ runId: 'run.ingest', episodeId: 'episode.ingest' }),
      readSessionInput: async () => ({ ...source, events: [{ eventOrder: 1, segmentId: 'segment.1', text: 'boundary' }] }),
      commitSessionIngest: async (value) => { calls.push(['commit', value]); return { state: 'committed' } }
    },
    modelAccess: { bind: async (value) => ({ ...value, capabilities: { usageReporting: false } }) },
    interactions: {
      create: async (value) => { calls.push(['interaction:create', value]); return value },
      terminalize: async (value) => { calls.push(['interaction:terminalize', value]); return value },
    },
    loop: {
      agentLoop: async (value) => {
        calls.push(['loop', value])
        assert.equal(Object.hasOwn(value, 'tools'), false)
        return { text: JSON.stringify(output) }
      }
    }
  })
  const runner = new ContextIngestSessionRunner(options)
  const result = await runner.run({
    recipeId: 'context.ingest.session', source,
    attemptIdentity: { runId: 'run.ingest', attempt: 1, owner: 'runner', leaseExpiresAt: 1000 },
    interactionId: 'interaction.ingest'
  })
  assert.equal(result.state, 'succeeded')
  assert.equal(calls.some(([name]) => name === 'tool-context'), false)
  assert.equal(calls.some(([name]) => name === 'tool:start'), false)
  assert.equal(calls.some(([name]) => name === 'tool:finish'), false)
})

test('SEM-F32/J21/J22/J24: interaction signal runner uses the same bounded loop with a frozen signal reference and no tools', async () => {
  const interactionSource = {
    sourceKind: 'interaction', interactionId: 'interaction.runner.signal', signalKind: 'remember', payloadDigest: sha256Canonical({ text: 'remembered' }),
    recipeId: 'qa.answer', recipeVersion: '1', scopeKind: 'session', scopeReference: 'session.runner', sessionId: 'session.runner',
    transcriptVersion: 'raw', inputWatermark: 2, inputDigest: 'b'.repeat(64), interactionInputDigest: 'c'.repeat(64),
    promptDigest: 'd'.repeat(64), resultDigest: 'e'.repeat(64)
  }
  const interactionOutput = {
    schemaVersion: 1,
    experiences: [{ kind: 'event', text: 'remembered', evidence: { interactionId: interactionSource.interactionId, signalKind: 'remember' }, confidence: 'high' }],
    memoryCandidates: []
  }
  const transientResult = { schemaVersion: 1, answer: 'result content', sourceRefs: [], memoryRefs: [], unresolved: [] }
  const { options, calls } = seams({
    personalContext: {
      prepareSessionIngest: async () => ({ runId: 'run.session.placeholder', episodeId: 'episode.session.placeholder' }),
      prepareInteractionIngest: async (value) => { calls.push(['prepare-interaction', value]); return { runId: 'run.interaction.signal', episodeId: 'episode.interaction.signal' } },
      readInteractionInput: async (value, ephemeral) => {
        calls.push(['interaction-input', value, ephemeral])
        return {
          ...interactionSource,
          events: [],
          signal: { signalKind: value.signalKind, prompt: ephemeral.prompt, editText: ephemeral.editText, result: ephemeral.result }
        }
      },
      commitSessionIngest: async () => ({ state: 'committed' }),
      commitInteractionIngest: async (value) => { calls.push(['commit-interaction', value]); return { state: 'committed' } }
    },
    interactionPayloadProvider: async () => ({ prompt: null, editText: 'remembered', result: transientResult }),
    onSettled: async (runId, reason, interactionId) => { calls.push(['settled', runId, reason, interactionId]) },
    loop: { agentLoop: async (value) => { calls.push(['loop', value]); return { text: JSON.stringify(interactionOutput) } } }
  })
  const runner = new ContextIngestSessionRunner(options)
  const prepared = await runner.prepare({ interactionId: interactionSource.interactionId, signalKind: 'remember', payloadDigest: interactionSource.payloadDigest, sourceKind: 'interaction' })
  assert.deepEqual(prepared, { runId: 'run.interaction.signal', episodeId: 'episode.interaction.signal' })
  const result = await runner.run({
    recipeId: 'context.ingest.interaction', source: interactionSource,
    attemptIdentity: { runId: 'run.interaction.signal', attempt: 1, owner: 'runner', leaseExpiresAt: 1000 },
    interactionId: 'interaction.ingest.signal'
  })
  assert.equal(result.state, 'succeeded')
  assert.equal(calls.find(([name]) => name === 'loop')[1].recipeId, 'context.ingest.interaction')
  assert.equal(Object.hasOwn(calls.find(([name]) => name === 'loop')[1], 'tools'), false)
  assert.deepEqual(calls.find(([name]) => name === 'interaction-input')[1], interactionSource)
  assert.deepEqual(calls.find(([name]) => name === 'interaction-input')[2], {
    prompt: null, editText: 'remembered', result: transientResult
  })
  const loopPrompt = JSON.parse(calls.find(([name]) => name === 'loop')[1].prompt)
  assert.deepEqual(loopPrompt.signal, {
    signalKind: 'remember', prompt: null, editText: 'remembered', result: transientResult
  })
  assert.equal(calls.find(([name]) => name === 'commit-interaction')[1].output.experiences[0].evidence.signalKind, 'remember')
  assert.deepEqual(calls.find(([name]) => name === 'settled').slice(1), [
    'run.interaction.signal', 'succeeded', 'interaction.ingest.signal'
  ])
})
