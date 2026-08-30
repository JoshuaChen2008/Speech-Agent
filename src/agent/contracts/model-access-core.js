'use strict'

const MODEL_CONFIG_COMMANDS = Object.freeze([
  'createProfile', 'updateProfile', 'deleteProfile', 'addModel', 'updateModel',
  'removeModel', 'setCredential', 'clearCredential', 'assignPurpose'
])
const MODEL_PURPOSES = Object.freeze(['default', 'information_extraction', 'summary', 'analysis_planning'])
const MODEL_CAPABILITY_KEYS = Object.freeze([
  'maxInputTokens', 'maxOutputTokens', 'supportsToolCalling',
  'supportsStructuredOutput', 'supportsStreaming', 'usageReporting'
])
const MODEL_CONFIG_ERROR_CODES = Object.freeze(['MODEL_CONFIG_INVALID', 'MODEL_CONFIG_REVISION_CONFLICT'])
const MODEL_ACCESS_ERROR_CODES = Object.freeze(['MODEL_ACCESS_UNAVAILABLE'])
const CREDENTIAL_SCOPES = Object.freeze(['absent', 'persistent', 'session_only'])
const ASSIGNMENT_MODES = Object.freeze(['direct', 'fallback_default', 'unconfigured'])
const MODEL_READINESS = Object.freeze(['ready', 'provider_not_configured', 'credential_unavailable'])
const EXECUTION_FORMS = Object.freeze(['single_shot', 'agent_loop'])
const MODEL_USAGE_SOURCES = Object.freeze(['provider', 'estimated'])
const REMOTE_CATALOG_STATUSES = Object.freeze([
  'success', 'revision_conflict', 'invalid_request', 'credential_unavailable',
  'redirect_rejected', 'remote_unavailable'
])

const PROFILE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/

function fail (path, message) {
  throw new TypeError(`${path}: ${message}`)
}

function record (value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'must be an object')
}

function exact (value, keys, path) {
  record(value, path)
  const expected = [...keys].sort()
  const actual = Object.keys(value).sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(path, `must contain exactly ${expected.join(', ')}`)
  }
}

function revision (value, path) {
  if (!Number.isSafeInteger(value) || value < 0) fail(path, 'must be a non-negative safe integer')
}

function positiveInteger (value, path) {
  if (!Number.isSafeInteger(value) || value < 1) fail(path, 'must be a positive safe integer')
}

function nonNegativeInteger (value, path) {
  if (!Number.isSafeInteger(value) || value < 0) fail(path, 'must be a non-negative safe integer')
}

function text (value, path, maxBytes, pattern = null) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() ||
      Buffer.byteLength(value, 'utf8') > maxBytes || /[\u0000-\u001f\u007f]/.test(value) ||
      (pattern && !pattern.test(value))) {
    fail(path, 'has an invalid value')
  }
}

function profileId (value, path) {
  text(value, path, 128, PROFILE_ID)
}

function modelId (value, path) {
  text(value, path, 256)
}

function assertCapabilities (value, path = 'capabilities') {
  exact(value, MODEL_CAPABILITY_KEYS, path)
  positiveInteger(value.maxInputTokens, `${path}.maxInputTokens`)
  positiveInteger(value.maxOutputTokens, `${path}.maxOutputTokens`)
  for (const key of MODEL_CAPABILITY_KEYS.slice(2)) {
    if (typeof value[key] !== 'boolean') fail(`${path}.${key}`, 'must be a boolean')
  }
  return value
}

function common (command, keys) {
  exact(command, ['type', 'expectedRevision', ...keys], 'command')
  if (!MODEL_CONFIG_COMMANDS.includes(command.type)) fail('command.type', 'is not registered')
  revision(command.expectedRevision, 'command.expectedRevision')
}

function assertConfigureCommand (command) {
  record(command, 'command')
  if (!MODEL_CONFIG_COMMANDS.includes(command.type)) fail('command.type', 'is not registered')
  if (command.type === 'createProfile' || command.type === 'updateProfile') {
    common(command, ['profileId', 'label', 'httpsOrigin', 'basePath'])
    profileId(command.profileId, 'command.profileId')
    text(command.label, 'command.label', 256)
    text(command.httpsOrigin, 'command.httpsOrigin', 2048)
    text(command.basePath, 'command.basePath', 1024)
  } else if (command.type === 'deleteProfile' || command.type === 'clearCredential') {
    common(command, ['profileId'])
    profileId(command.profileId, 'command.profileId')
  } else if (command.type === 'addModel' || command.type === 'updateModel') {
    common(command, ['profileId', 'modelId', 'capabilities'])
    profileId(command.profileId, 'command.profileId')
    modelId(command.modelId, 'command.modelId')
    assertCapabilities(command.capabilities, 'command.capabilities')
  } else if (command.type === 'removeModel') {
    common(command, ['profileId', 'modelId'])
    profileId(command.profileId, 'command.profileId')
    modelId(command.modelId, 'command.modelId')
  } else if (command.type === 'setCredential') {
    common(command, ['profileId', 'credential'])
    profileId(command.profileId, 'command.profileId')
    text(command.credential, 'command.credential', 4096)
  } else {
    common(command, ['purpose', 'target'])
    if (!MODEL_PURPOSES.includes(command.purpose)) fail('command.purpose', 'is not registered')
    if (command.target !== null) {
      exact(command.target, ['profileId', 'modelId'], 'command.target')
      profileId(command.target.profileId, 'command.target.profileId')
      modelId(command.target.modelId, 'command.target.modelId')
    }
  }
  return command
}

function assertRunRequest (request) {
  exact(request, ['runId', 'recipeId', 'recipeVersion', 'executionForm'], 'runRequest')
  text(request.runId, 'runRequest.runId', 160)
  text(request.recipeId, 'runRequest.recipeId', 80)
  text(request.recipeVersion, 'runRequest.recipeVersion', 80)
  if (!EXECUTION_FORMS.includes(request.executionForm)) fail('runRequest.executionForm', 'is not registered')
  return request
}

function assertModelUsage (usage) {
  exact(usage, [
    'inputTokens', 'outputTokens', 'usageSource',
    'cacheHitInputTokens', 'cacheMissInputTokens'
  ], 'ModelUsageV1')
  nonNegativeInteger(usage.inputTokens, 'ModelUsageV1.inputTokens')
  nonNegativeInteger(usage.outputTokens, 'ModelUsageV1.outputTokens')
  if (!MODEL_USAGE_SOURCES.includes(usage.usageSource)) fail('ModelUsageV1.usageSource', 'is not registered')
  const bothNull = usage.cacheHitInputTokens === null && usage.cacheMissInputTokens === null
  if (!bothNull) {
    nonNegativeInteger(usage.cacheHitInputTokens, 'ModelUsageV1.cacheHitInputTokens')
    nonNegativeInteger(usage.cacheMissInputTokens, 'ModelUsageV1.cacheMissInputTokens')
    if (usage.usageSource !== 'provider' ||
        usage.cacheHitInputTokens + usage.cacheMissInputTokens <= 0 ||
        usage.cacheHitInputTokens + usage.cacheMissInputTokens !== usage.inputTokens) {
      fail('ModelUsageV1', 'cache input token facts are inconsistent')
    }
  }
  return usage
}

function deriveCacheHitRate (usage) {
  try {
    assertModelUsage(usage)
    if (usage.usageSource !== 'provider' || usage.cacheHitInputTokens === null) return null
    return usage.cacheHitInputTokens / (usage.cacheHitInputTokens + usage.cacheMissInputTokens)
  } catch {
    return null
  }
}

function normalizeDeepSeekUsage (rawUsage, usageReporting = true) {
  if (!usageReporting || !rawUsage || typeof rawUsage !== 'object' || Array.isArray(rawUsage) ||
      !Number.isSafeInteger(rawUsage.prompt_tokens) || rawUsage.prompt_tokens < 0 ||
      !Number.isSafeInteger(rawUsage.completion_tokens) || rawUsage.completion_tokens < 0) return null
  const hit = rawUsage.prompt_cache_hit_tokens
  const miss = rawUsage.prompt_cache_miss_tokens
  const consistent = Number.isSafeInteger(hit) && hit >= 0 && Number.isSafeInteger(miss) && miss >= 0 &&
    hit + miss > 0 && hit + miss === rawUsage.prompt_tokens
  return Object.freeze({
    inputTokens: rawUsage.prompt_tokens,
    outputTokens: rawUsage.completion_tokens,
    usageSource: 'provider',
    cacheHitInputTokens: consistent ? hit : null,
    cacheMissInputTokens: consistent ? miss : null
  })
}

module.exports = Object.freeze({
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
})
