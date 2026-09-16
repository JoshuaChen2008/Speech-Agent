'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { AgentInteractionSignalService } = require('../../src/agent/formal-run/agent-interaction-signal-service')
const { sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')
const c = require('../../src/agent/contracts/agent-run-ui')

const header = { contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION }
const result = { schemaVersion: 1, answer: 'bounded result', sourceRefs: [], memoryRefs: [], unresolved: [] }
const resultDigest = sha256Canonical(result)

function interaction (overrides = {}) {
  return {
    interactionId: 'interaction.signal.service',
    runId: 'run.signal.service',
    recipeId: 'qa.answer',
    recipeVersion: '1',
    requestedBy: 'user',
    terminalReason: 'succeeded',
    promptDigest: sha256Canonical('bounded prompt'),
    resultDigest,
    result,
    ...overrides
  }
}

function request (signalKind = 'accept', overrides = {}) {
  return {
    ...header,
    interaction_id: 'interaction.signal.service',
    payload: null,
    result_digest: signalKind === 'prompt' ? null : resultDigest,
    signal_idempotency_key: `signal.${signalKind}.service`,
    signal_kind: signalKind,
    ...overrides
  }
}

test('SEM-F32/J21: signal service binds terminal user interactions and projects replay safely', async () => {
  const calls = []
  const service = new AgentInteractionSignalService({
    storage: { getAgentInteraction: async () => ({ interaction: interaction() }) },
    personalContext: {
      recordInteractionSignal: async (value) => { calls.push(value); return { accepted: true, replayed: calls.length > 1 } }
    }
  })
  const first = await service.recordSignal(request('accept'))
  assert.deepEqual(first, {
    ...header, ok: true, error: null,
    result: { accepted: true, interaction_id: 'interaction.signal.service', replayed: false, signal_kind: 'accept' }
  })
  const replay = await service.recordSignal(request('accept'))
  assert.equal(replay.ok, true)
  assert.equal(replay.result.replayed, true)
  assert.deepEqual(calls, [
    {
      interactionId: 'interaction.signal.service', signalKind: 'accept', payloadDigest: null,
      signalIdempotencyKey: 'signal.accept.service',
      transient: { prompt: null, editText: null, result }
    },
    {
      interactionId: 'interaction.signal.service', signalKind: 'accept', payloadDigest: null,
      signalIdempotencyKey: 'signal.accept.service',
      transient: { prompt: null, editText: null, result }
    }
  ])
})

test('SEM-F38/J29: summary prompt and ordinary feedback acknowledge without creating interaction memory work', async () => {
  const calls = []
  const summary = interaction({ recipeId: 'summary.minutes' })
  const service = new AgentInteractionSignalService({
    storage: { getAgentInteraction: async () => ({ interaction: summary }) },
    personalContext: { recordInteractionSignal: async (value) => { calls.push(value); return { accepted: true } } }
  })
  assert.equal(await service.recordPromptSignal({ interactionId: summary.interactionId, prompt: 'bounded prompt' }), false)
  for (const signalKind of ['edit', 'accept', 'reject']) {
    const response = await service.recordSignal(request(signalKind, {
      payload: signalKind === 'edit' ? { text: '更具体' } : null,
      result_digest: resultDigest
    }))
    assert.equal(response.ok, true)
    assert.equal(response.result.accepted, true)
  }
  assert.deepEqual(calls, [])
})

test('SEM-F32/J21/SEM-T04: stale, nonterminal and routed results fail closed without context writes', async () => {
  const calls = []
  let current = interaction()
  const service = new AgentInteractionSignalService({
    storage: { getAgentInteraction: async () => ({ interaction: current }) },
    personalContext: { recordInteractionSignal: async (value) => { calls.push(value); return { accepted: true, replayed: false } } }
  })
  const stale = await service.recordSignal(request('accept', { result_digest: 'b'.repeat(64) }))
  assert.equal(stale.ok, false)
  assert.equal(stale.error.next_action, 'refresh_result')
  current = interaction({ terminalReason: 'failed' })
  const failed = await service.recordSignal(request('reject'))
  assert.equal(failed.ok, false)
  assert.equal(failed.error.next_action, 'result_unavailable')
  current = interaction({ recipeId: 'intent.route' })
  const routed = await service.recordSignal(request('accept'))
  assert.equal(routed.ok, false)
  assert.equal(routed.error.next_action, 'wait_for_terminal')
  assert.equal(calls.length, 0)
})

test('SEM-F31/SEM-F32/J21: terminal cleanup hashes the bounded prompt and deletes the prompt store even when enqueue is unavailable', async () => {
  const prompts = new Map([['run.signal.service', 'bounded prompt']])
  const service = new AgentInteractionSignalService({
    storage: { getAgentInteraction: async () => ({ interaction: interaction() }) },
    personalContext: { recordInteractionSignal: async () => { throw new Error('context disabled') } },
    promptStore: prompts
  })
  assert.equal(await service.recordPromptSignal({ interactionId: 'interaction.signal.service' }), false)
  assert.equal(prompts.has('run.signal.service'), false)
})

test('SEM-F32/J21: prompt signal accepts an explicit bounded prompt only when its stored digest matches', async () => {
  const calls = []
  const service = new AgentInteractionSignalService({
    storage: { getAgentInteraction: async () => ({ interaction: interaction() }) },
    personalContext: { recordInteractionSignal: async (value) => { calls.push(value); return { accepted: true } } }
  })
  assert.equal(await service.recordPromptSignal({ interactionId: 'interaction.signal.service', prompt: 'bounded prompt' }), true)
  assert.equal(await service.recordPromptSignal({ interactionId: 'interaction.signal.service', prompt: 'different prompt' }), false)
  assert.deepEqual(calls, [{
    interactionId: 'interaction.signal.service', signalKind: 'prompt', payloadDigest: null,
    signalIdempotencyKey: `signal.prompt.${sha256Canonical('interaction.signal.service').slice(0, 48)}`,
    transient: { prompt: 'bounded prompt', editText: null, result },
    awaitCompletion: true
  }])
})

test('SEM-F28/SEM-F32/J21: prompt remains in the bounded store until extraction settles', async () => {
  const prompts = new Map([['run.signal.service', 'bounded prompt']])
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const service = new AgentInteractionSignalService({
    storage: { getAgentInteraction: async () => ({ interaction: interaction() }) },
    personalContext: {
      recordInteractionSignal: async () => pending
    },
    promptStore: prompts
  })
  const recording = service.recordPromptSignal({ interactionId: 'interaction.signal.service' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(prompts.has('run.signal.service'), true)
  release({ accepted: true, completed: true })
  assert.equal(await recording, true)
  assert.equal(prompts.has('run.signal.service'), false)
})
