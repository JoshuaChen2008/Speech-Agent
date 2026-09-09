'use strict'

/*
 * The settings surface intentionally has its own small contract.  The
 * persisted ConfigStore shape uses camelCase, while renderer IPC payloads use
 * the same snake_case vocabulary as the Personal Context contract.  Keeping
 * this projection exact prevents timestamp boundaries or provider details from
 * becoming renderer writable fields.
 */

const CONTRACT_ID = 'speech-agent.agent-settings.ui'
const CONTRACT_VERSION = '1.0.0'
const IPC_CHANNELS = Object.freeze({ update: 'agent-settings:update' })

const ERROR_CODES = Object.freeze({
  permissionDenied: 'AGENT_SETTINGS_PERMISSION_DENIED',
  unavailable: 'AGENT_SETTINGS_UNAVAILABLE',
  invalid: 'AGENT_SETTINGS_INVALID',
  revisionConflict: 'AGENT_SETTINGS_REVISION_CONFLICT',
  updateFailed: 'AGENT_SETTINGS_UPDATE_FAILED'
})

const ERROR_RULES = Object.freeze({
  [ERROR_CODES.permissionDenied]: Object.freeze({ next_action: 'reload' }),
  [ERROR_CODES.unavailable]: Object.freeze({ next_action: 'retry' }),
  [ERROR_CODES.invalid]: Object.freeze({ next_action: 'correct_input' }),
  [ERROR_CODES.revisionConflict]: Object.freeze({ next_action: 'reload' }),
  [ERROR_CODES.updateFailed]: Object.freeze({ next_action: 'retry' })
})

const SETTINGS_KEYS = Object.freeze([
  'agent_enabled',
  'memory_enabled',
  'cloud_disclosure_accepted',
  'agent_settings_revision'
])

function fail (path, message) {
  throw new TypeError(`${path}: ${message}`)
}

function assertRecord (value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype) fail(path, 'must be a plain object')
}

function assertExactObject (value, keys, path) {
  assertRecord(value, path)
  const expected = [...keys].sort()
  const actual = Object.keys(value).sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(path, 'must contain exact keys')
  }
}

function assertHeader (value, path) {
  if (value.contract_id !== CONTRACT_ID || value.contract_version !== CONTRACT_VERSION) {
    fail(path, 'unsupported contract version')
  }
}

function assertBoolean (value, path) {
  if (typeof value !== 'boolean') fail(path, 'must be boolean')
  return value
}

function assertRevision (value, path) {
  if (!Number.isSafeInteger(value) || value < 0) fail(path, 'must be a non-negative safe integer')
  return value
}

function assertError (value, path) {
  assertExactObject(value, ['code', 'next_action'], path)
  if (!Object.hasOwn(ERROR_RULES, value.code)) fail(`${path}.code`, 'is not registered')
  if (value.next_action !== ERROR_RULES[value.code].next_action) {
    fail(`${path}.next_action`, 'does not match the registered action')
  }
  return value
}

function assertSettings (value, path) {
  assertExactObject(value, SETTINGS_KEYS, path)
  assertBoolean(value.agent_enabled, `${path}.agent_enabled`)
  assertBoolean(value.memory_enabled, `${path}.memory_enabled`)
  assertBoolean(value.cloud_disclosure_accepted, `${path}.cloud_disclosure_accepted`)
  assertRevision(value.agent_settings_revision, `${path}.agent_settings_revision`)
  return value
}

function assertUpdateRequest (value, path = 'AgentSettingsUpdateRequest') {
  assertExactObject(value, [
    'contract_id', 'contract_version', 'expected_revision',
    'agent_enabled', 'memory_enabled', 'cloud_disclosure_accepted'
  ], path)
  assertHeader(value, path)
  assertRevision(value.expected_revision, `${path}.expected_revision`)
  assertBoolean(value.agent_enabled, `${path}.agent_enabled`)
  assertBoolean(value.memory_enabled, `${path}.memory_enabled`)
  assertBoolean(value.cloud_disclosure_accepted, `${path}.cloud_disclosure_accepted`)
  return value
}

function assertUpdateResponse (value, path = 'AgentSettingsUpdateResponse') {
  assertExactObject(value, ['contract_id', 'contract_version', 'ok', 'settings', 'error'], path)
  assertHeader(value, path)
  assertBoolean(value.ok, `${path}.ok`)
  if (value.ok) {
    if (value.error !== null) fail(`${path}.error`, 'must be null for success')
    assertSettings(value.settings, `${path}.settings`)
  } else {
    if (value.settings !== null) fail(`${path}.settings`, 'must be null for failure')
    assertError(value.error, `${path}.error`)
  }
  return value
}

function isSupportedContract (contractId, contractVersion) {
  return contractId === CONTRACT_ID && contractVersion === CONTRACT_VERSION
}

module.exports = Object.freeze({
  CONTRACT_ID,
  CONTRACT_VERSION,
  ERROR_CODES,
  ERROR_RULES,
  IPC_CHANNELS,
  SETTINGS_KEYS,
  assertSettings,
  assertUpdateRequest,
  assertUpdateResponse,
  isSupportedContract
})
