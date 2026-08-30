'use strict'

const { assertConfigureCommand, REMOTE_CATALOG_STATUSES } = require('./model-access-core')

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

function assertGetCatalogRequest (value) { requestHeader(value, [], 'getCatalogRequest'); return value }
function assertConfigureRequest (value) {
  requestHeader(value, ['command'], 'configureRequest')
  assertConfigureCommand(value.command)
  return value
}
function assertPullRequest (value) {
  requestHeader(value, ['profileId', 'expectedRevision'], 'pullRequest')
  if (typeof value.profileId !== 'string' || value.profileId.length === 0) fail('pullRequest.profileId')
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
  if (typeof value.ok !== 'boolean' || (value.ok ? value.snapshot === null || value.error !== null : value.snapshot !== null || value.error?.code !== 'MODEL_ACCESS_UNAVAILABLE')) fail('catalogResponse')
  if (value.ok) revision(value.snapshot.revision, 'catalogResponse.snapshot.revision')
  return value
}
function assertConfigureResponse (value) {
  requestHeader(value, ['ok', 'revision', 'error'], 'configureResponse')
  if (typeof value.ok !== 'boolean') fail('configureResponse')
  if (value.ok) { revision(value.revision, 'configureResponse.revision'); if (value.error !== null) fail('configureResponse.error') } else {
    if (value.revision !== null || !['MODEL_CONFIG_INVALID', 'MODEL_CONFIG_REVISION_CONFLICT'].includes(value.error?.code) || !['correct_input', 'reload'].includes(value.error?.nextAction)) fail('configureResponse.error')
  }
  return value
}
function assertPullResponse (value) {
  requestHeader(value, ['status', 'suggestions'], 'pullResponse')
  if (!REMOTE_CATALOG_STATUSES.includes(value.status) || !Array.isArray(value.suggestions) || (value.status !== 'success' && value.suggestions.length !== 0)) fail('pullResponse')
  return value
}

module.exports = Object.freeze({
  CONTRACT_ID, CONTRACT_VERSION, IPC_CHANNELS,
  assertCatalogResponse, assertChangedEvent, assertConfigureRequest, assertConfigureResponse,
  assertGetCatalogRequest, assertPullRequest, assertPullResponse
})
