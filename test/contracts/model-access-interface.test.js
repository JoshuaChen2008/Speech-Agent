'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createModelAccess } = require('../../src/agent/model-access')

test('SEM-F33/J25: formal model-access facade exposes exactly catalog configure and bind', async () => {
  const calls = []
  const internal = {
    revision: 0,
    profiles: [],
    assignments: Object.fromEntries(['default', 'information_extraction', 'summary', 'analysis_planning']
      .map((purpose) => [purpose, { profile_id: null, model_id: null }]))
  }
  const facade = await createModelAccess({
    gateway: {
      modelAccessCatalog: async () => { calls.push('catalog'); return internal },
      modelAccessConfigure: async (command) => { calls.push(['configure', command]); return { revision: 1 } },
      modelAccessBind: async (request) => { calls.push(['bind', request]); return {} }
    },
    vault: {
      recover: () => calls.push('recover'),
      state: () => ({ present: false, scope: 'absent' })
    }
  })
  assert.deepEqual(Object.keys(facade).sort(), ['bind', 'catalog', 'configure'])
  assert.deepEqual(await facade.catalog(), {
    ok: true,
    snapshot: {
      revision: 0,
      profiles: [],
      readinessByPurpose: Object.fromEntries(['default', 'information_extraction', 'summary', 'analysis_planning']
        .map((purpose) => [purpose, {
          assignmentMode: 'unconfigured', providerKind: null, target: null,
          singleShot: 'provider_not_configured', agentLoop: 'provider_not_configured'
        }]))
    },
    error: null
  })
  const invalid = await facade.configure({ type: 'clearCredential' })
  assert.equal(invalid.error.code, 'MODEL_CONFIG_INVALID')
  await assert.rejects(facade.bind({ runId: 'run' }), (error) => error.code === 'AGENT_REQUEST_INVALID')
  assert.equal(calls.filter((entry) => entry === 'catalog').length, 2)
  assert.equal(calls.includes('recover'), true)
  assert.equal('pullRemoteCatalog' in facade, false)
})
