'use strict'

const {
  ASSIGNMENT_MODES, CREDENTIAL_SCOPES, MODEL_PURPOSES, MODEL_READINESS,
  REMOTE_CATALOG_STATUSES, assertCapabilities, assertConfigureCommand
} = require('../model-access-core')

const CONTRACT_ID = 'agent-model-ui'
const CONTRACT_VERSION = '1.0.0'
const IPC_CHANNELS = Object.freeze({
  getCatalog: 'agent-model:get-catalog',
  configure: 'agent-model:configure',
  pullRemoteCatalog: 'agent-model:pull-remote-catalog',
  changed: 'agent-model:changed'
})

function fail (path) { throw new TypeError(`${path}: invalid model UI contract`) }
function exact (value, keys, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(path)
}
function header (value, path) {
  if (value.contractId !== CONTRACT_ID || value.contractVersion !== CONTRACT_VERSION) fail(path)
}
function requestHeader (value, keys, path) { exact(value, ['contractId', 'contractVersion', ...keys], path); header(value, path) }
function revision (value, path) { if (!Number.isSafeInteger(value) || value < 0) fail(path) }
function text (value, path, maximum = 2048) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() ||
      Buffer.byteLength(value, 'utf8') > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail(path)
}
function nullablePositiveInteger (value, path) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 1)) fail(path)
}

function assertCapabilitySuggestion (value, path) {
  exact(value, [
    'maxInputTokens', 'maxOutputTokens', 'supportsToolCalling',
    'supportsStructuredOutput', 'supportsStreaming', 'usageReporting'
  ], path)
  nullablePositiveInteger(value.maxInputTokens, `${path}.maxInputTokens`)
  nullablePositiveInteger(value.maxOutputTokens, `${path}.maxOutputTokens`)
  for (const key of ['supportsToolCalling', 'supportsStructuredOutput', 'supportsStreaming', 'usageReporting']) {
    if (value[key] !== null && typeof value[key] !== 'boolean') fail(`${path}.${key}`)
  }
}

function assertCredential (value, path) {
  exact(value, ['present', 'scope'], path)
  if (typeof value.present !== 'boolean' || !CREDENTIAL_SCOPES.includes(value.scope) ||
      (value.present !== (value.scope !== 'absent'))) fail(path)
}

function assertTemplateSuggestion (value, path) {
  if (value === null) return
  exact(value, ['templateVersion', 'source', 'sourceSnapshotDate', 'modelId', 'capabilitySuggestion'], path)
  if (value.templateVersion !== 1 || value.source !== 'official_docs' || value.sourceSnapshotDate !== '2026-08-30') fail(path)
  text(value.modelId, `${path}.modelId`, 256)
  assertCapabilitySuggestion(value.capabilitySuggestion, `${path}.capabilitySuggestion`)
}

function assertModel (value, path) {
  exact(value, ['modelId', 'capabilities'], path)
  text(value.modelId, `${path}.modelId`, 256)
  assertCapabilities(value.capabilities, `${path}.capabilities`)
}

function assertProfile (value, path) {
  exact(value, [
    'profileId', 'label', 'profileRevision', 'catalogRevision', 'httpsOrigin', 'basePath',
    'templateId', 'templateSuggestion', 'models', 'credential'
  ], path)
  text(value.profileId, `${path}.profileId`, 128)
  text(value.label, `${path}.label`, 256)
  revision(value.profileRevision, `${path}.profileRevision`)
  revision(value.catalogRevision, `${path}.catalogRevision`)
  text(value.httpsOrigin, `${path}.httpsOrigin`)
  text(value.basePath, `${path}.basePath`, 1024)
  if (value.templateId !== null && value.templateId !== 'deepseek-openai-template@1') fail(`${path}.templateId`)
  assertTemplateSuggestion(value.templateSuggestion, `${path}.templateSuggestion`)
  if ((value.templateId === null) !== (value.templateSuggestion === null)) fail(`${path}.templateSuggestion`)
  if (!Array.isArray(value.models)) fail(`${path}.models`)
  value.models.forEach((model, index) => assertModel(model, `${path}.models[${index}]`))
  if (new Set(value.models.map((model) => model.modelId)).size !== value.models.length) fail(`${path}.models`)
  assertCredential(value.credential, `${path}.credential`)
}

function assertReadiness (value, path) {
  exact(value, ['assignmentMode', 'providerKind', 'target', 'singleShot', 'agentLoop'], path)
  if (!ASSIGNMENT_MODES.includes(value.assignmentMode) || ![null, 'local', 'cloud'].includes(value.providerKind) ||
      !MODEL_READINESS.includes(value.singleShot) || !MODEL_READINESS.includes(value.agentLoop)) fail(path)
  if (value.target !== null) {
    exact(value.target, ['profileId', 'modelId'], `${path}.target`)
    text(value.target.profileId, `${path}.target.profileId`, 128)
    text(value.target.modelId, `${path}.target.modelId`, 256)
  }
  if ((value.assignmentMode === 'unconfigured') !== (value.target === null) ||
      (value.target === null) !== (value.providerKind === null)) fail(path)
}

function assertCatalogSnapshot (value) {
  exact(value, ['revision', 'profiles', 'readinessByPurpose'], 'catalogSnapshot')
  revision(value.revision, 'catalogSnapshot.revision')
  if (!Array.isArray(value.profiles)) fail('catalogSnapshot.profiles')
  value.profiles.forEach((profile, index) => assertProfile(profile, `catalogSnapshot.profiles[${index}]`))
  if (new Set(value.profiles.map((profile) => profile.profileId)).size !== value.profiles.length) fail('catalogSnapshot.profiles')
  exact(value.readinessByPurpose, MODEL_PURPOSES, 'catalogSnapshot.readinessByPurpose')
  for (const purpose of MODEL_PURPOSES) assertReadiness(value.readinessByPurpose[purpose], `catalogSnapshot.readinessByPurpose.${purpose}`)
  return value
}

function assertGetCatalogRequest (value) { requestHeader(value, [], 'getCatalogRequest'); return value }
function assertConfigureRequest (value) {
  requestHeader(value, ['command'], 'configureRequest')
  assertConfigureCommand(value.command)
  return value
}
function assertPullRequest (value) {
  requestHeader(value, ['profileId', 'expectedRevision'], 'pullRequest')
  text(value.profileId, 'pullRequest.profileId', 128)
  revision(value.expectedRevision, 'pullRequest.expectedRevision')
  return value
}
function assertChangedEvent (value) {
  requestHeader(value, ['revision'], 'changedEvent')
  revision(value.revision, 'changedEvent.revision')
  return value
}
function assertCatalogResponse (value) {
  requestHeader(value, ['ok', 'snapshot', 'error'], 'catalogResponse')
  if (typeof value.ok !== 'boolean') fail('catalogResponse.ok')
  if (value.ok) {
    if (value.error !== null) fail('catalogResponse.error')
    assertCatalogSnapshot(value.snapshot)
  } else {
    if (value.snapshot !== null) fail('catalogResponse.snapshot')
    exact(value.error, ['code'], 'catalogResponse.error')
    if (value.error.code !== 'MODEL_ACCESS_UNAVAILABLE') fail('catalogResponse.error')
  }
  return value
}
function assertConfigureResponse (value) {
  requestHeader(value, ['ok', 'revision', 'error'], 'configureResponse')
  if (typeof value.ok !== 'boolean') fail('configureResponse')
  if (value.ok) {
    revision(value.revision, 'configureResponse.revision')
    if (value.error !== null) fail('configureResponse.error')
  } else {
    if (value.revision !== null) fail('configureResponse.revision')
    exact(value.error, ['code', 'nextAction'], 'configureResponse.error')
    const expectedAction = value.error.code === 'MODEL_CONFIG_REVISION_CONFLICT' ? 'reload'
      : value.error.code === 'MODEL_CONFIG_INVALID' ? 'correct_input' : null
    if (value.error.nextAction !== expectedAction) fail('configureResponse.error')
  }
  return value
}
function assertPullResponse (value) {
  requestHeader(value, ['status', 'suggestions'], 'pullResponse')
  if (!REMOTE_CATALOG_STATUSES.includes(value.status) || !Array.isArray(value.suggestions) ||
      (value.status !== 'success' && value.suggestions.length !== 0)) fail('pullResponse')
  value.suggestions.forEach((suggestion, index) => {
    const path = `pullResponse.suggestions[${index}]`
    exact(suggestion, ['modelId', 'capabilitySuggestion'], path)
    text(suggestion.modelId, `${path}.modelId`, 256)
    if (suggestion.capabilitySuggestion !== null) assertCapabilitySuggestion(suggestion.capabilitySuggestion, `${path}.capabilitySuggestion`)
  })
  if (new Set(value.suggestions.map((suggestion) => suggestion.modelId)).size !== value.suggestions.length) fail('pullResponse.suggestions')
  return value
}

module.exports = Object.freeze({
  CONTRACT_ID, CONTRACT_VERSION, IPC_CHANNELS,
  assertCatalogResponse, assertCatalogSnapshot, assertChangedEvent, assertConfigureRequest,
  assertConfigureResponse, assertGetCatalogRequest, assertPullRequest, assertPullResponse
})
