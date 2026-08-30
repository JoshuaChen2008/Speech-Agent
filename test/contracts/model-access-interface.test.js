'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { createModelAccess } = require('../../src/agent/model-access')

test('SEM-F33/J25: formal model-access facade exposes exactly catalog configure and bind', async () => {
  const calls = []
  const facade = createModelAccess({ storage: {
    modelAccessCatalog: async () => { calls.push('catalog'); return {} },
    modelAccessConfigure: async (command) => { calls.push(['configure', command]); return {} },
    modelAccessBind: async (request) => { calls.push(['bind', request]); return {} }
  } })
  assert.deepEqual(Object.keys(facade).sort(), ['bind', 'catalog', 'configure'])
  await facade.catalog()
  await facade.configure({ type: 'clearCredential' })
  await facade.bind({ runId: 'run' })
  assert.equal(calls.length, 3)
  assert.equal('pullRemoteCatalog' in facade, false)
})
