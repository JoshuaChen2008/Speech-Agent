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
