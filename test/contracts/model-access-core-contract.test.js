'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  ASSIGNMENT_MODES,
  CREDENTIAL_SCOPES,
  EXECUTION_FORMS,
  MODEL_ACCESS_ERROR_CODES,
  MODEL_CAPABILITY_KEYS,
  MODEL_CONFIG_COMMANDS,
  MODEL_CONFIG_ERROR_CODES,
  MODEL_PURPOSES,
  MODEL_READINESS,
  MODEL_USAGE_SOURCES,
  REMOTE_CATALOG_STATUSES,
  assertCapabilities,
  assertConfigureCommand,
  assertModelUsage,
  assertRunRequest,
  deriveCacheHitRate,
  normalizeDeepSeekUsage
} = require('../../src/agent/contracts/model-access-core')

const capabilities = Object.freeze({
  maxInputTokens: 64000,
  maxOutputTokens: 4096,
  supportsToolCalling: true,
  supportsStructuredOutput: true,
  supportsStreaming: true,
  usageReporting: true
})

test('SEM-F33/J25: model-access core freezes the exact closed sets', () => {
  assert.deepEqual(MODEL_CONFIG_COMMANDS, [
    'createProfile', 'updateProfile', 'deleteProfile', 'addModel', 'updateModel',
    'removeModel', 'setCredential', 'clearCredential', 'assignPurpose'
  ])
  assert.deepEqual(MODEL_PURPOSES, ['default', 'information_extraction', 'summary', 'analysis_planning'])
  assert.deepEqual(MODEL_CAPABILITY_KEYS, [
    'maxInputTokens', 'maxOutputTokens', 'supportsToolCalling',
    'supportsStructuredOutput', 'supportsStreaming', 'usageReporting'
  ])
  assert.deepEqual(MODEL_CONFIG_ERROR_CODES, ['MODEL_CONFIG_INVALID', 'MODEL_CONFIG_REVISION_CONFLICT'])
  assert.deepEqual(MODEL_ACCESS_ERROR_CODES, ['MODEL_ACCESS_UNAVAILABLE'])
  assert.deepEqual(CREDENTIAL_SCOPES, ['absent', 'persistent', 'session_only'])
  assert.deepEqual(ASSIGNMENT_MODES, ['direct', 'fallback_default', 'unconfigured'])
  assert.deepEqual(MODEL_READINESS, ['ready', 'provider_not_configured', 'credential_unavailable'])
  assert.deepEqual(EXECUTION_FORMS, ['agent_loop'])
  assert.deepEqual(MODEL_USAGE_SOURCES, ['provider'])
  assert.deepEqual(REMOTE_CATALOG_STATUSES, [
    'success', 'revision_conflict', 'invalid_request', 'credential_unavailable',
    'redirect_rejected', 'remote_unavailable'
  ])
})

test('SEM-F33/J25: capabilities and nine commands are exact and reject pricing or ConfigStore facts', () => {
  assert.deepEqual(assertCapabilities(capabilities), capabilities)
  assert.deepEqual(assertConfigureCommand({
    type: 'addModel', expectedRevision: 2, profileId: 'profile.one', modelId: 'vendor/model-v1', capabilities
  }).capabilities, capabilities)
  assert.deepEqual(assertConfigureCommand({
    type: 'assignPurpose', expectedRevision: 2, purpose: 'summary',
    target: { profileId: 'profile.one', modelId: 'vendor/model-v1' }
  }).target, { profileId: 'profile.one', modelId: 'vendor/model-v1' })
  for (const extra of ['price', 'cost', 'currency', 'pricingRevision', 'agentEnabled', 'memoryEnabled']) {
    assert.throws(() => assertConfigureCommand({
      type: 'addModel', expectedRevision: 2, profileId: 'profile.one', modelId: 'model',
      capabilities, [extra]: true
    }), /not allowed|exact|invalid/i)
  }
  assert.throws(() => assertCapabilities({ ...capabilities, price: 1 }), /not allowed|exact/i)
  assert.throws(() => assertCapabilities({ ...capabilities, maxInputTokens: null }), /positive|integer/i)
})

test('SEM-F33/J25: runRequest is exact and never accepts model selection or credential fields', () => {
  const request = { runId: 'run.one', recipeId: 'context.ingest.session', recipeVersion: '1', executionForm: 'agent_loop' }
  assert.deepEqual(assertRunRequest(request), request)
  assert.throws(() => assertRunRequest({ ...request, executionForm: 'single_shot' }), /not registered/)
  for (const key of ['purpose', 'profileId', 'modelId', 'httpsOrigin', 'header', 'budget', 'credential']) {
    assert.throws(() => assertRunRequest({ ...request, [key]: 'forbidden' }), /not allowed|exact/i)
  }
})

test('SEM-F33/J25: ModelUsageV1 preserves consistent provider cache facts and unknown stays null', () => {
  const provider = assertModelUsage({
    inputTokens: 1000,
    outputTokens: 200,
    usageSource: 'provider',
    cacheHitInputTokens: 250,
    cacheMissInputTokens: 750
  })
  assert.equal(deriveCacheHitRate(provider), 0.25)
  assert.deepEqual(normalizeDeepSeekUsage({
    prompt_tokens: 1000,
    completion_tokens: 200,
    prompt_cache_hit_tokens: 250,
    prompt_cache_miss_tokens: 750
  }), provider)
  assert.deepEqual(normalizeDeepSeekUsage({
    prompt_tokens: 1000,
    completion_tokens: 200,
    prompt_cache_hit_tokens: 250,
    prompt_cache_miss_tokens: 700
  }), { ...provider, cacheHitInputTokens: null, cacheMissInputTokens: null })
  assert.equal(deriveCacheHitRate({ ...provider, usageSource: 'estimated', cacheHitInputTokens: null, cacheMissInputTokens: null }), null)
  assert.throws(() => assertModelUsage({
    ...provider,
    usageSource: 'estimated',
    cacheHitInputTokens: null,
    cacheMissInputTokens: null
  }), /usageSource/)
  assert.equal(normalizeDeepSeekUsage(null), null)
  assert.equal(normalizeDeepSeekUsage({ prompt_tokens: 1, completion_tokens: 1 }, false), null)
  assert.throws(() => assertModelUsage({ ...provider, cost: 1 }), /not allowed|exact/i)
})
