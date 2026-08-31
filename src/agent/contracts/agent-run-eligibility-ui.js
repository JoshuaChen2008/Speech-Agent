'use strict'

// S3 public preparation contract. It deliberately covers only the eligibility
// read and monotonic changed notification: submit/cancel/history/detail need
// their own signed payloads before the agent window can expose them.

const CONTRACT_ID = 'speech-agent.agent-run.ui'
const CONTRACT_VERSION = '1.0.0'

const ALLOWED_ROLES = Object.freeze(['agent', 'history'])
const IPC_CHANNELS = Object.freeze({
  changed: 'agent-run:changed',
  getEligibility: 'agent-run:get-eligibility'
})
const ELIGIBILITY_STATES = Object.freeze([
  'ready',
  'no_committed_transcript',
  'outside_automatic_window',
  'agent_disabled',
  'provider_not_configured',
  'cloud_disclosure_required',
  'credential_unavailable',
  'local_model_not_ready',
  'session_not_terminal'
])
const SCOPE_KINDS = Object.freeze(['selection', 'session', 'date_range', 'project'])
const ERROR_CODES = Object.freeze({ unavailable: 'AGENT_RUN_UNAVAILABLE' })

const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,159}$/
const FORBIDDEN_FIELD = new Set([
  'prompt', 'prompt_text', 'credential', 'credentials', 'api_key', 'authorization',
  'secret', 'password', 'audio', 'pcm', 'wav', 'audio_path', 'local_path',
  'absolute_path', 'path', 'transcript_text', 'caption_text', 'reasoning',
  'reasoning_content', 'provider_event', 'raw_error', 'stack'
])
const FORBIDDEN_VALUE = /(?:bearer\s+[A-Za-z0-9._~+/-]+|[A-Za-z]:[\\/]|file:\/\/|\.(?:wav|pcm|mp3)(?:\b|$))/i

function fail (path, message) {
  throw new TypeError(`${path}: ${message}`)
}

function record (value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(path, 'must be a plain object')
  }
}

function exact (value, keys, path) {
  record(value, path)
  const expected = [...keys].sort()
  const actual = Object.keys(value).sort()
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    fail(path, 'must contain exact keys')
  }
}

function identifier (value, path) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail(path, 'must be an identifier')
  return value
}

function integer (value, path) {
  if (!Number.isSafeInteger(value) || value < 0) fail(path, 'must be a non-negative safe integer')
  return value
}

function enumValue (value, allowed, path) {
  if (!allowed.includes(value)) fail(path, 'is not registered')
  return value
}

function header (value, path) {
  if (value.contract_id !== CONTRACT_ID) fail(`${path}.contract_id`, `must equal ${CONTRACT_ID}`)
  if (value.contract_version !== CONTRACT_VERSION) fail(`${path}.contract_version`, `must equal ${CONTRACT_VERSION}`)
}

function assertScope (value, path) {
  exact(value, ['kind', 'reference'], path)
  enumValue(value.kind, SCOPE_KINDS, `${path}.kind`)
  identifier(value.reference, `${path}.reference`)
  return value
}

function assertSnapshot (value, path = 'EligibilitySnapshotV1') {
  exact(value, ['eligibility', 'next_action', 'revision', 'scope'], path)
  assertScope(value.scope, `${path}.scope`)
  enumValue(value.eligibility, ELIGIBILITY_STATES, `${path}.eligibility`)
  // A next-action target is intentionally not inferred until AUI-CR-012
  // specifies its exact destination and command semantics.
  if (value.next_action !== null) fail(`${path}.next_action`, 'must be null until an exact action contract is signed')
  integer(value.revision, `${path}.revision`)
  return value
}

function assertPublicError (value, path) {
  exact(value, ['category', 'code', 'next_action'], path)
  if (value.code !== ERROR_CODES.unavailable) fail(`${path}.code`, 'is not registered')
  if (value.category !== 'unavailable') fail(`${path}.category`, 'must equal unavailable')
  if (value.next_action !== null) fail(`${path}.next_action`, 'must be null')
  return value
}

function assertGetEligibilityRequest (value, path = 'GetEligibilityRequest') {
  exact(value, ['contract_id', 'contract_version', 'scope'], path)
  header(value, path)
  assertScope(value.scope, `${path}.scope`)
  return value
}

function assertGetEligibilityResponse (value, path = 'GetEligibilityResponse') {
  exact(value, ['contract_id', 'contract_version', 'error', 'ok', 'snapshot'], path)
  header(value, path)
  if (typeof value.ok !== 'boolean') fail(`${path}.ok`, 'must be a boolean')
  if (value.ok) {
    if (value.error !== null) fail(`${path}.error`, 'must be null for success')
    assertSnapshot(value.snapshot, `${path}.snapshot`)
  } else {
    if (value.snapshot !== null) fail(`${path}.snapshot`, 'must be null for failure')
    assertPublicError(value.error, `${path}.error`)
  }
  return value
}

function assertChangedEvent (value, path = 'ChangedEvent') {
  exact(value, ['contract_id', 'contract_version', 'revision'], path)
  header(value, path)
  integer(value.revision, `${path}.revision`)
  return value
}

function normalizeField (key) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

function assertFixturePrivacy (value, path = 'AgentRunEligibilityFixture') {
  const visit = (current, currentPath) => {
    if (current === null || typeof current !== 'object') {
      if (typeof current === 'string' && FORBIDDEN_VALUE.test(current)) fail(currentPath, 'contains a forbidden private value')
      return
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${currentPath}[${index}]`))
      return
    }
    for (const [key, child] of Object.entries(current)) {
      if (FORBIDDEN_FIELD.has(normalizeField(key))) fail(`${currentPath}.${key}`, 'contains a forbidden private field')
      visit(child, `${currentPath}.${key}`)
    }
  }
  visit(value, path)
  return value
}

function isSupportedContract (contractId, contractVersion) {
  return contractId === CONTRACT_ID && contractVersion === CONTRACT_VERSION
}

module.exports = Object.freeze({
  ALLOWED_ROLES,
  CONTRACT_ID,
  CONTRACT_VERSION,
  ELIGIBILITY_STATES,
  ERROR_CODES,
  IPC_CHANNELS,
  SCOPE_KINDS,
  assertChangedEvent,
  assertFixturePrivacy,
  assertGetEligibilityRequest,
  assertGetEligibilityResponse,
  assertScope,
  assertSnapshot,
  isSupportedContract
})
