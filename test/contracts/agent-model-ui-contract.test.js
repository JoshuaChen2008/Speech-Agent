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

test('SEM-F14/SEM-F33/J25: catalog and remote suggestions validate every nested public field exactly', () => {
  const readiness = {
    assignmentMode: 'unconfigured', providerKind: null, target: null,
    singleShot: 'provider_not_configured', agentLoop: 'provider_not_configured'
  }
  const snapshot = {
    revision: 0,
    profiles: [{
      profileId: 'deepseek', label: 'DeepSeek', profileRevision: 1, catalogRevision: 0,
      httpsOrigin: 'https://api.deepseek.com', basePath: '/', templateId: 'deepseek-openai-template@1',
      templateSuggestion: {
        templateVersion: 1, source: 'official_docs', sourceSnapshotDate: '2026-08-30', modelId: 'deepseek-v4-flash',
        capabilitySuggestion: {
          maxInputTokens: null, maxOutputTokens: null, supportsToolCalling: true,
          supportsStructuredOutput: true, supportsStreaming: true, usageReporting: true
        }
      },
      models: [], credential: { present: false, scope: 'absent' }
    }],
    readinessByPurpose: {
      default: readiness, information_extraction: readiness, summary: readiness, analysis_planning: readiness
    }
  }
  assert.equal(assertCatalogResponse({ ...header, ok: true, snapshot, error: null }).ok, true)
  assert.throws(() => assertCatalogResponse({
    ...header, ok: true,
    snapshot: { ...snapshot, profiles: [{ ...snapshot.profiles[0], credentialSlotId: 'private' }] }, error: null
  }), /invalid/i)
  assert.throws(() => assertCatalogResponse({
    ...header, ok: true,
    snapshot: { ...snapshot, readinessByPurpose: { ...snapshot.readinessByPurpose, summary: { ...readiness, unknown: true } } }, error: null
  }), /invalid/i)
  assert.throws(() => assertPullResponse({
    ...header, status: 'success', suggestions: [{ modelId: 'model.one', capabilitySuggestion: null, endpoint: '/models' }]
  }), /invalid/i)
})

test('SEM-F33/J25: capability suggestions preserve independently unknown fields', () => {
  assert.doesNotThrow(() => assertPullResponse({
    ...header,
    status: 'success',
    suggestions: [{
      modelId: 'future-model',
      capabilitySuggestion: {
        maxInputTokens: null,
        maxOutputTokens: null,
        supportsToolCalling: null,
        supportsStructuredOutput: true,
        supportsStreaming: null,
        usageReporting: false
      }
    }]
  }))
})
