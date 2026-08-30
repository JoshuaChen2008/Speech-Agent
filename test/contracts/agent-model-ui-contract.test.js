'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  CONTRACT_ID, CONTRACT_VERSION, IPC_CHANNELS,
  assertCatalogResponse, assertChangedEvent, assertConfigureRequest,
  assertGetCatalogRequest, assertPullResponse
} = require('../../src/agent/contracts/agent-model-ui')

const header = { contractId: CONTRACT_ID, contractVersion: CONTRACT_VERSION }

test('SEM-F33/J25: agent-model-ui v1 freezes four exact settings channels and unavailable envelope', () => {
  assert.deepEqual(IPC_CHANNELS, {
    getCatalog: 'agent-model:get-catalog', configure: 'agent-model:configure',
    pullRemoteCatalog: 'agent-model:pull-remote-catalog', changed: 'agent-model:changed'
  })
  assert.deepEqual(assertGetCatalogRequest(header), header)
  assert.deepEqual(assertCatalogResponse({ ...header, ok: false, snapshot: null, error: { code: 'MODEL_ACCESS_UNAVAILABLE' } }).error, { code: 'MODEL_ACCESS_UNAVAILABLE' })
  assert.deepEqual(assertChangedEvent({ ...header, revision: 4 }).revision, 4)
})

test('SEM-F33/J25: UI contract rejects extra fields, credentials, endpoint segments and unknown remote status', () => {
  assert.throws(() => assertGetCatalogRequest({ ...header, credential: 'no' }), /invalid/i)
  assert.throws(() => assertConfigureRequest({ ...header, command: {
    type: 'createProfile', expectedRevision: 0, profileId: 'one', label: 'One',
    httpsOrigin: 'https://example.test', basePath: '/v1', endpoint: '/chat/completions'
  } }), /invalid|allowed|exact/i)
  assert.throws(() => assertPullResponse({ ...header, status: 'timeout', suggestions: [] }), /invalid/i)
})
