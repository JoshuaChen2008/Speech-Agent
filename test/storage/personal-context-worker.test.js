'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { createPersonalContextModule } = require('../../src/agent/personal-context')
const { OPERATIONS, PROTOCOL_VERSION } = require('../../src/runtime/storage-worker/protocol')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')

function request (requestId, operation, payload) {
  return { version: PROTOCOL_VERSION, type: 'storage:request', requestId, operation, payload }
}

test('SEM-F00/SEM-F30/J21: personal-context store is independent and lazy for subtitle and old Agent operations', () => {
  let personalLoads = 0
  let oldLoads = 0
  const subtitleStore = {
    getStats: () => ({ sessions: 0 }),
    close: () => {}
  }
  const service = new StorageWorkerService({
    storeFactory: () => subtitleStore,
    agentStoreFactory: () => {
      oldLoads += 1
      return { evaluateEligibility: () => ({ eligibility: 'provider_not_configured' }) }
    },
    personalContextStoreFactory: () => {
      personalLoads += 1
      return {
        ingest: (payload) => ({ seam: 'ingest', payload }),
        resolve: (payload) => ({ seam: 'resolve', payload }),
        manage: (payload) => ({ seam: 'manage', payload })
      }
    }
  })
  assert.equal(service.handle(request('init', OPERATIONS.INITIALIZE, { databasePath: 'synthetic' })).ok, true)
  assert.equal(service.handle(request('stats', OPERATIONS.GET_STATS, {})).ok, true)
  assert.deepEqual({ personalLoads, oldLoads }, { personalLoads: 0, oldLoads: 0 })
  assert.equal(service.handle(request('old', OPERATIONS.AGENT_EVALUATE_ELIGIBILITY, {
    sessionId: 's', requestedBy: 'automatic', eligibilityContext: {}
  })).ok, true)
  assert.deepEqual({ personalLoads, oldLoads }, { personalLoads: 0, oldLoads: 1 })
  const response = service.handle(request('new', OPERATIONS.PERSONAL_CONTEXT_RESOLVE, {
    request: { scope: { kind: 'project', reference: 'p' }, semantic_keys: [], aliases: [] }
  }))
  assert.equal(response.ok, true)
  assert.equal(response.result.seam, 'resolve')
  assert.deepEqual({ personalLoads, oldLoads }, { personalLoads: 1, oldLoads: 1 })
  const invalid = service.handle(request('invalid-new', OPERATIONS.PERSONAL_CONTEXT_RESOLVE, {
    request: {}, sql: 'SELECT *'
  }))
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'INVALID_REQUEST')
})

test('SEM-F30/J21: the formal module exposes exactly ingest, resolve and manage', async () => {
  const calls = []
  const module = createPersonalContextModule({
    storage: {
      personalContextIngest: async (source) => { calls.push(['ingest', source]); return { ok: true } },
      personalContextResolve: async (request) => { calls.push(['resolve', request]); return { ok: true } },
      personalContextManage: async (request) => { calls.push(['manage', request]); return { ok: true } }
    }
  })
  assert.deepEqual(Object.keys(module).sort(), ['ingest', 'manage', 'resolve'])
  await module.ingest({ sourceKind: 'session' })
  await module.resolve({ scope: { kind: 'project' } })
  await module.manage({
    contract_id: 'speech-agent.personal-context.ui',
    contract_version: '1.0.0',
    request_id: 'view-1',
    command: { type: 'view', resource: 'personal_memories', limit: 20, cursor: null }
  })
  assert.deepEqual(calls.map(([name]) => name), ['ingest', 'resolve', 'manage'])
})
