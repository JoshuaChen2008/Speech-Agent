'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { createPersonalContextModule } = require('../../src/agent/personal-context')
const { CONTRACT_ID, CONTRACT_VERSION } = require('../../src/agent/contracts/agent-context-ui')
const { OPERATIONS, PROTOCOL_VERSION } = require('../../src/runtime/storage-worker/protocol')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')

function request (requestId, operation, payload) {
  return { version: PROTOCOL_VERSION, type: 'storage:request', requestId, operation, payload }
}

test('SEM-F00/SEM-F30/J21: personal-context store is independent and old Agent operations are removed', () => {
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
  const removedOldOperation = service.handle(request('old', 'agent:evaluate-eligibility', {
    sessionId: 's', requestedBy: 'automatic', eligibilityContext: {}
  }))
  assert.equal(removedOldOperation.ok, false)
  assert.equal(removedOldOperation.error.code, 'UNSUPPORTED_OPERATION')
  assert.deepEqual({ personalLoads, oldLoads }, { personalLoads: 0, oldLoads: 0 })
  const removedOldDeletion = service.handle(request('old-delete', 'agent:delete-session-data', {
    sessionId: 's', deletionIdempotencyKey: 'delete'
  }))
  assert.equal(removedOldDeletion.ok, false)
  assert.equal(removedOldDeletion.error.code, 'UNSUPPORTED_OPERATION')
  assert.deepEqual({ personalLoads, oldLoads }, { personalLoads: 0, oldLoads: 0 })
  const response = service.handle(request('new', OPERATIONS.PERSONAL_CONTEXT_RESOLVE, {
    request: { scope: { kind: 'project', reference: 'p' }, semantic_keys: [], aliases: [] }
  }))
  assert.equal(response.ok, true)
  assert.equal(response.result.seam, 'resolve')
  assert.deepEqual({ personalLoads, oldLoads }, { personalLoads: 1, oldLoads: 0 })
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
    contract_id: CONTRACT_ID,
    contract_version: CONTRACT_VERSION,
    request_id: 'view-1',
    command: { type: 'view', resource: 'personal_memories', limit: 20, cursor: null }
  })
  assert.deepEqual(calls.map(([name]) => name), ['ingest', 'resolve', 'manage'])
})
