'use strict'

/* The summary preference has its own exact contract so the existing Agent
 * settings form can keep its established request shape.  Both settings share
 * the same main-owned revision, which makes stale writes fail closed. */

const CONTRACT_ID = 'speech-agent.session-summary-settings.ui'
const CONTRACT_VERSION = '1.0.0'

const ERROR_CODES = Object.freeze({
  permissionDenied: 'SESSION_SUMMARY_SETTINGS_PERMISSION_DENIED',
  unavailable: 'SESSION_SUMMARY_SETTINGS_UNAVAILABLE',
  invalid: 'SESSION_SUMMARY_SETTINGS_INVALID',
  revisionConflict: 'SESSION_SUMMARY_SETTINGS_REVISION_CONFLICT',
  updateFailed: 'SESSION_SUMMARY_SETTINGS_UPDATE_FAILED'
})

const ERROR_RULES = Object.freeze({
  [ERROR_CODES.permissionDenied]: Object.freeze({ next_action: 'reload' }),
  [ERROR_CODES.unavailable]: Object.freeze({ next_action: 'retry' }),
  [ERROR_CODES.invalid]: Object.freeze({ next_action: 'correct_input' }),
  [ERROR_CODES.revisionConflict]: Object.freeze({ next_action: 'reload' }),
  [ERROR_CODES.updateFailed]: Object.freeze({ next_action: 'retry' })
})

const SETTINGS_KEYS = Object.freeze(['summary_use_memory', 'agent_settings_revision'])

function fail (path, message) { throw new TypeError(`${path}: ${message}`) }

function assertRecord (value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(path, 'must be a plain object')
  }
}

function assertExactObject (value, keys, path) {
  assertRecord(value, path)
  const expected = [...keys].sort()
  const actual = Object.keys(value).sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) fail(path, 'must contain exact keys')
}

function assertHeader (value, path) {
  if (value.contract_id !== CONTRACT_ID || value.contract_version !== CONTRACT_VERSION) fail(path, 'unsupported contract version')
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
  if (value.next_action !== ERROR_RULES[value.code].next_action) fail(`${path}.next_action`, 'does not match the registered action')
  return value
}

function assertSettings (value, path) {
  assertExactObject(value, SETTINGS_KEYS, path)
  assertBoolean(value.summary_use_memory, `${path}.summary_use_memory`)
  assertRevision(value.agent_settings_revision, `${path}.agent_settings_revision`)
  return value
}

function assertUpdateRequest (value, path = 'SessionSummarySettingsUpdateRequest') {
  assertExactObject(value, ['contract_id', 'contract_version', 'expected_revision', 'summary_use_memory'], path)
  assertHeader(value, path)
  assertRevision(value.expected_revision, `${path}.expected_revision`)
  assertBoolean(value.summary_use_memory, `${path}.summary_use_memory`)
  return value
}

function assertUpdateResponse (value, path = 'SessionSummarySettingsUpdateResponse') {
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

module.exports = Object.freeze({
  CONTRACT_ID,
  CONTRACT_VERSION,
  ERROR_CODES,
  ERROR_RULES,
  SETTINGS_KEYS,
  assertSettings,
  assertUpdateRequest,
  assertUpdateResponse
})
