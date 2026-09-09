'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { AgentRunService } = require('../../src/agent/formal-run/agent-run-service')
const c = require('../../src/agent/contracts/agent-run-ui')

function storageWith (sessions, transcript = null) {
  return {
    async listSessions ({ limit, cursor }) {
      assert.ok(limit >= 1)
      return { items: sessions, nextCursor: cursor ? null : null }
    },
    async getSessionTranscript (sessionId) {
      if (transcript && transcript.sessionId === sessionId) return transcript.value
      const error = new Error('not found'); error.code = 'SESSION_NOT_FOUND'; throw error
    }
  }
}

const header = (service) => ({
  contract_id: c.CONTRACT_ID,
  contract_version: c.CONTRACT_VERSION,
  ...service
})

test('S5-1 getScopes projects only committed terminal sessions and picks newest default', async () => {
  const service = new AgentRunService({
    storage: storageWith([
      { sessionId: 'session.new', mode: 'loopback', startedAt: 1730000000000, endedAt: 1730000001000, state: 'closed', segmentCount: 2 },
      { sessionId: 'session.empty', mode: 'mic', startedAt: 1720000000000, endedAt: 1720000001000, state: 'closed', segmentCount: 0 },
      { sessionId: 'session.active', mode: 'mic', startedAt: 1710000000000, endedAt: null, state: 'active', segmentCount: 1 }
    ])
  })
  const result = await service.getScopes(header({ limit: 50, cursor: null }))
  assert.equal(result.ok, true)
  assert.deepEqual(result.scopes.map((item) => item.scope.reference), ['session.new'])
  assert.deepEqual(result.default_scope, { kind: 'session', reference: 'session.new' })
  assert.equal(result.scopes[0].ended_at, '2024-10-27T03:33:21.000Z')
})

test('S5-1 getScopes returns an exact empty projection without fabrication', async () => {
  const service = new AgentRunService({ storage: storageWith([]) })
  const result = await service.getScopes(header({ limit: 1, cursor: null }))
  assert.deepEqual(result.scopes, [])
  assert.equal(result.default_scope, null)
  assert.equal(result.next_cursor, null)
  assert.doesNotThrow(() => c.assertGetScopesResponse(result))
})

test('S5-1 getScopes cursor follows the last scanned source row without skipping valid sessions', async () => {
  const pages = [
    {
      items: [
        { sessionId: 'session.empty', mode: 'mic', startedAt: 1730000000000, endedAt: 1730000000100, state: 'closed', segmentCount: 0 },
        { sessionId: 'session.first', mode: 'mic', startedAt: 1720000000000, endedAt: 1720000000100, state: 'closed', segmentCount: 1 }
      ],
      nextCursor: { startedAt: 1710000000000, sessionId: 'session.cursor' }
    },
    {
      items: [{ sessionId: 'session.second', mode: 'mic', startedAt: 1700000000000, endedAt: 1700000000100, state: 'closed', segmentCount: 1 }],
      nextCursor: null
    }
  ]
  let calls = 0
  const storage = {
    async listSessions ({ cursor }) {
      const page = pages[calls++]
      assert.equal(cursor === null, calls === 1)
      return page
    },
    async getSessionTranscript () { throw new Error('unused') }
  }
  const service = new AgentRunService({ storage })
  const first = await service.getScopes(header({ limit: 1, cursor: null }))
  assert.deepEqual(first.scopes.map((item) => item.scope.reference), ['session.first'])
  const second = await service.getScopes(header({ limit: 1, cursor: first.next_cursor }))
  assert.deepEqual(second.scopes.map((item) => item.scope.reference), ['session.second'])
  assert.equal(calls, 2)
})

test('S5-1 changed revision is monotonic and observable through the service seam', () => {
  const events = []
  const service = new AgentRunService({ storage: storageWith([]), onChanged: (event) => events.push(event) })
  assert.equal(service.emitChanged().revision, 1)
  assert.equal(service.emitChanged().revision, 2)
  assert.deepEqual(events.map((event) => event.revision), [1, 2])
})

test('S5-1 eligibility distinguishes terminal transcript and model readiness', async () => {
  const transcript = {
    sessionId: 'session.ready',
    value: { session: { state: 'closed' }, segments: [{ segmentId: 'segment.1' }] }
  }
  const service = new AgentRunService({
    storage: storageWith([], transcript),
    modelAccess: { catalog: async () => ({ ok: true, snapshot: { readinessByPurpose: { summary: { agentLoop: 'ready' } } } }) }
  })
  const result = await service.getEligibility(header({ scope: { kind: 'session', reference: 'session.ready' } }))
  assert.equal(result.snapshot.eligibility, 'ready')
  assert.equal(result.snapshot.next_action, null)
})

test('SEM-F33/J22/J24: eligibility projects unavailable provider facts without fabricating readiness', async () => {
  const transcript = {
    sessionId: 'session.provider-facts',
    value: { session: { state: 'closed' }, segments: [{ segmentId: 'segment.1' }] }
  }
  for (const [readiness, expected] of [
    ['credential_unavailable', 'credential_unavailable'],
    ['provider_unavailable', 'provider_not_configured'],
    [null, 'provider_not_configured']
  ]) {
    const service = new AgentRunService({
      storage: storageWith([], transcript),
      modelAccess: { catalog: async () => ({ ok: true, snapshot: { readinessByPurpose: { summary: { agentLoop: readiness } } } }) }
    })
    const result = await service.getEligibility(header({ scope: { kind: 'session', reference: 'session.provider-facts' } }))
    assert.equal(result.ok, true)
    assert.equal(result.snapshot.eligibility, expected)
    assert.equal(result.snapshot.next_action, null)
  }
})

test('S5-1/J22: unsupported non-session scopes fail closed before transcript or run creation', async () => {
  let transcriptReads = 0
  let runCreates = 0
  const storage = storageWith([])
  storage.getSessionTranscript = async () => {
    transcriptReads += 1
    throw new Error('unsupported scope should not read a transcript')
  }
  storage.createAgentRun = async () => {
    runCreates += 1
    throw new Error('unsupported scope should not create a run')
  }
  const service = new AgentRunService({ storage })
  for (const kind of ['selection', 'date_range', 'project']) {
    const scope = { kind, reference: `${kind}.unsupported` }
    const eligibility = await service.getEligibility(header({ scope }))
    assert.equal(eligibility.ok, false)
    assert.equal(eligibility.error.code, c.ERROR_CODES.unavailable)
    assert.equal(eligibility.error.next_action, 'choose_supported_scope')
    const submitted = await service.submit(header({
      scope, prompt: 'x', client_idempotency_key: `client.${kind}.unsupported`
    }))
    assert.equal(submitted.ok, false)
    assert.equal(submitted.error.code, c.ERROR_CODES.unavailable)
    assert.equal(submitted.error.next_action, 'choose_supported_scope')
  }
  assert.equal(transcriptReads, 0)
  assert.equal(runCreates, 0)
})

test('S5-2 submit freezes one rules-routed request and replays the same interaction', async () => {
  const h = header({ scope: { kind: 'session', reference: 'session.submit' }, prompt: '请整理会议纪要', client_idempotency_key: 'client.submit' })
  const created = []
  const interactions = new Map()
  const storage = storageWith([], {
    sessionId: 'session.submit',
    value: { session: { state: 'closed' }, segments: [{ segmentId: 'segment.1', firstEventOrder: 1, text: 'hello' }] }
  })
  storage.createAgentRun = async (request) => {
    const replayed = created.length > 0
    if (!replayed) created.push(request)
    return { runId: request.runId, recipeId: request.recipeId, state: 'queued', replayed }
  }
  storage.createAgentInteraction = async (request) => {
    const current = interactions.get(request.interactionId)
    if (current) return { ...current, replayed: true }
    const value = { interactionId: request.interactionId, runId: request.runId, promptDigest: request.promptDigest }
    interactions.set(request.interactionId, value)
    return value
  }
  storage.getAgentInteraction = async ({ interactionId }) => ({ interaction: interactions.get(interactionId) })
  storage.derivePersonalContextSessionSource = async () => ({
    sourceKind: 'session', sessionId: 'session.submit', transcriptVersion: 'raw', inputWatermark: 1,
    inputDigest: 'a'.repeat(64)
  })
  const service = new AgentRunService({
    storage,
    modelAccess: {
      catalog: async () => ({ ok: true, snapshot: { readinessByPurpose: { summary: { agentLoop: 'ready' } } } }),
      bind: async ({ runId }) => ({ runId })
    }
  })
  const first = await service.submit(h)
  const second = await service.submit(h)
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(first.result.interaction_id, second.result.interaction_id)
  assert.equal(created.length, 1)
  const changedPrompt = await service.submit({ ...h, prompt: '换一个问题' })
  assert.equal(changedPrompt.ok, false)
  assert.equal(changedPrompt.error.code, c.ERROR_CODES.invalid)
})

test('S5-2/J22: submit delegates model-first convergence while keeping prompt and scheduling main-owned', async () => {
  const h = header({ scope: { kind: 'session', reference: 'session.route-service' }, prompt: '请整理会议纪要', client_idempotency_key: 'client.route-service' })
  const storage = storageWith([], {
    sessionId: 'session.route-service',
    value: { session: { state: 'closed' }, segments: [{ segmentId: 'segment.1', firstEventOrder: 1, text: 'hello' }] }
  })
  storage.derivePersonalContextSessionSource = async () => ({
    sourceKind: 'session', sessionId: 'session.route-service', transcriptVersion: 'raw', inputWatermark: 1,
    inputDigest: 'c'.repeat(64)
  })
  const routeCalls = []
  const wakes = []
  const prompts = new Map()
  const service = new AgentRunService({
    storage,
    modelAccess: {
      catalog: async () => ({ ok: true, snapshot: { readinessByPurpose: { summary: { agentLoop: 'ready' } } } })
    },
    routeOrchestrator: {
      submit: async (request) => {
        routeCalls.push(request)
        return { runId: 'run.target.route-service', interactionId: 'interaction.target.route-service', recipeId: 'summary.minutes', routingMode: 'model', eligibility: 'ready' }
      }
    },
    scheduler: { wake: (reason) => wakes.push(reason) },
    promptStore: prompts
  })
  const result = await service.submit(h)
  assert.equal(result.ok, true)
  assert.equal(result.result.routing_mode, 'model')
  assert.deepEqual(routeCalls[0], {
    scope: h.scope,
    prompt: h.prompt,
    transcriptVersion: 'raw',
    inputWatermark: { throughEventOrder: 1 },
    inputDigest: 'c'.repeat(64),
    clientIdempotencyKey: h.client_idempotency_key,
    signal: null
  })
  assert.equal(prompts.get('run.target.route-service'), h.prompt)
  assert.deepEqual(wakes, ['submit'])
})

test('S5-2/J22: model-first idempotency mismatch remains an invalid request', async () => {
  const storage = storageWith([], {
    sessionId: 'session.route-mismatch',
    value: { session: { state: 'closed' }, segments: [{ segmentId: 'segment.1', firstEventOrder: 1, text: 'hello' }] }
  })
  storage.derivePersonalContextSessionSource = async () => ({
    sourceKind: 'session', sessionId: 'session.route-mismatch', transcriptVersion: 'raw', inputWatermark: 1,
    inputDigest: 'd'.repeat(64)
  })
  const service = new AgentRunService({
    storage,
    modelAccess: {
      catalog: async () => ({ ok: true, snapshot: { readinessByPurpose: { summary: { agentLoop: 'ready' } } } })
    },
    routeOrchestrator: {
      submit: async ({ prompt }) => {
        if (prompt === '第二个问题') {
          const error = new Error('AGENT_REQUEST_INVALID'); error.code = 'AGENT_REQUEST_INVALID'; throw error
        }
        return { runId: 'run.target.route-mismatch', interactionId: 'interaction.target.route-mismatch', recipeId: 'qa.answer', routingMode: 'rules', eligibility: 'ready', state: 'queued' }
      }
    }
  })
  const first = await service.submit({ ...header({ scope: { kind: 'session', reference: 'session.route-mismatch' }, prompt: '第一个问题', client_idempotency_key: 'client.route-mismatch' }) })
  const second = await service.submit({ ...header({ scope: { kind: 'session', reference: 'session.route-mismatch' }, prompt: '第二个问题', client_idempotency_key: 'client.route-mismatch' }) })
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.error.category, 'invalid')
})

test('S5-2 cancel and detail preserve running/cancelling state projections', async () => {
  const storage = storageWith([])
  storage.getAgentInteraction = async () => ({
    runState: 'running', cancelRequested: false,
    interaction: {
      interactionId: 'interaction.running', runId: 'run.running', recipeId: 'qa.answer', recipeVersion: '1',
      routingMode: 'rules', terminalReason: null, errorCode: null, usage: null, durationMs: 0,
      attemptCount: 1, result: null, resultDigest: null, createdAt: 1, terminalAt: null
    },
    binding: { adapterId: 'openai-compatible', modelId: 'model.demo', profileId: 'profile.demo', profileRevision: 1, providerKind: 'local' },
    toolCalls: []
  })
  let cancelCalls = 0
  storage.cancelAgentRun = async () => {
    cancelCalls += 1
    return cancelCalls === 1 ? { state: 'running', cancelRequested: true } : { state: 'cancelled', cancelRequested: true, replayed: true }
  }
  const service = new AgentRunService({ storage })
  const detail = await service.getInteraction(header({ interaction_id: 'interaction.running' }))
  assert.equal(detail.ok, true)
  assert.equal(detail.result.state, 'running')
  const cancel = await service.cancel(header({ interaction_id: 'interaction.running' }))
  assert.equal(cancel.ok, true)
  assert.equal(cancel.result.state, 'cancelling')
  const revision = cancel.result.revision
  const replay = await service.cancel(header({ interaction_id: 'interaction.running' }))
  assert.equal(replay.ok, true)
  assert.equal(replay.result.state, 'cancelled')
  assert.equal(replay.result.revision, revision)
})
