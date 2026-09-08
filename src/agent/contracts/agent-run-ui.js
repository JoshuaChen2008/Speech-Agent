'use strict'

const CONTRACT_ID = 'speech-agent.agent-run.ui'
const CONTRACT_VERSION = '1.0.0'
const ALLOWED_ROLES = Object.freeze(['agent', 'history'])
const IPC_CHANNELS = Object.freeze({
  getScopes: 'agent-run:get-scopes',
  getEligibility: 'agent-run:get-eligibility',
  submit: 'agent-run:submit',
  cancel: 'agent-run:cancel',
  getHistory: 'agent-run:get-history',
  getInteraction: 'agent-run:get-interaction',
  changed: 'agent-run:changed',
  exportInteraction: 'agent-run:export-interaction'
})
const TERMINAL_STATES = Object.freeze(['pending', 'running', 'succeeded', 'failed', 'cancelling', 'cancelled'])
const ROUTING_MODES = Object.freeze(['model', 'rules', 'preset'])
const USAGE_STATES = Object.freeze(['known', 'unknown'])
const ELIGIBILITY_STATES = Object.freeze(['ready', 'no_committed_transcript', 'outside_automatic_window', 'agent_disabled', 'provider_not_configured', 'cloud_disclosure_required', 'credential_unavailable', 'local_model_not_ready', 'session_not_terminal'])
const SCOPE_KINDS = Object.freeze(['selection', 'session', 'date_range', 'project'])
const ERROR_CODES = Object.freeze({ unavailable: 'AGENT_RUN_UNAVAILABLE', invalid: 'AGENT_RUN_INVALID' })
const RUN_ERROR_CODES = Object.freeze(['AGENT_RUN_UNAVAILABLE', 'AGENT_RUN_INVALID', 'AGENT_CANCELLED', 'AGENT_PROVIDER_AUTH_FAILED', 'AGENT_PROVIDER_RATE_LIMITED', 'AGENT_PROVIDER_UNAVAILABLE', 'AGENT_PROVIDER_TIMEOUT', 'AGENT_OUTPUT_INVALID', 'AGENT_PERMISSION_DENIED', 'AGENT_REQUEST_INVALID', 'AGENT_WORKER_EXITED', 'AGENT_INTERNAL_FAILURE', 'AGENT_BUDGET_EXCEEDED'])
const ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/
const FORBIDDEN = new Set(['prompt', 'prompt_text', 'assistant', 'reasoning', 'provider_event', 'raw_error', 'stack', 'credential', 'credentials', 'api_key', 'secret', 'password', 'audio', 'pcm', 'wav', 'audio_path', 'path', 'local_path', 'absolute_path', 'amount', 'price', 'cost', 'currency', 'api_token', 'access_token', 'refresh_token', 'token_value', 'transcript_text', 'caption_text'])
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/

function fail (p, m) { throw new TypeError(`${p}: ${m}`) }
function plain (v, p) { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getPrototypeOf(v) !== Object.prototype) fail(p, 'must be a plain object') }
function exact (v, keys, p) { plain(v, p); const a = Object.keys(v).sort(); const e = [...keys].sort(); if (a.length !== e.length || a.some((x, i) => x !== e[i])) fail(p, 'must contain exact keys') }
function id (v, p) { if (typeof v !== 'string' || !ID.test(v)) fail(p, 'must be an identifier'); return v }
function integer (v, p) { if (!Number.isSafeInteger(v) || v < 0) fail(p, 'must be a non-negative safe integer'); return v }
function enumValue (v, allowed, p) { if (!allowed.includes(v)) fail(p, 'is not registered'); return v }
function normalizeField (key) { return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase() }
function header (v, p) { if (v.contract_id !== CONTRACT_ID || v.contract_version !== CONTRACT_VERSION) fail(p, 'unsupported contract version') }
function scope (v, p = 'scope') { exact(v, ['kind', 'reference'], p); enumValue(v.kind, SCOPE_KINDS, `${p}.kind`); id(v.reference, `${p}.reference`); return v }
function assertTimestamp (v, p) { if (v !== null && (typeof v !== 'string' || !RFC3339_UTC.test(v) || !Number.isFinite(Date.parse(v)))) fail(p, 'must be null or an RFC 3339 UTC timestamp'); return v }
function assertBoundedText (v, p, max = 256) { if (typeof v !== 'string' || v.length === 0 || v.length > max) fail(p, 'must be a non-empty bounded string'); return v }
function assertOpaqueCursor (v, p) { if (v !== null && (typeof v !== 'string' || v.length === 0 || v.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(v))) fail(p, 'must be null or an opaque cursor'); return v }
function assertScopeItem (v, p = 'scope') {
  exact(v, ['display_name', 'ended_at', 'scope', 'started_at', 'state'], p)
  scope(v.scope, `${p}.scope`)
  if (v.scope.kind !== 'session') fail(`${p}.scope.kind`, 'must be session')
  assertBoundedText(v.display_name, `${p}.display_name`)
  assertTimestamp(v.started_at, `${p}.started_at`)
  assertTimestamp(v.ended_at, `${p}.ended_at`)
  enumValue(v.state, ['terminal'], `${p}.state`)
  if (v.ended_at === null) fail(`${p}.ended_at`, 'must be non-null for terminal scope')
  return v
}
function assertGetEligibilityRequest (v) { exact(v, ['contract_id', 'contract_version', 'scope'], 'request'); header(v, 'request'); scope(v.scope); return v }
function assertGetScopesRequest (v) { exact(v, ['contract_id', 'contract_version', 'cursor', 'limit'], 'request'); header(v, 'request'); integer(v.limit, 'request.limit'); if (v.limit < 1 || v.limit > 50) fail('request.limit', 'out of range'); assertOpaqueCursor(v.cursor, 'request.cursor'); return v }
function assertSubmitRequest (v) { exact(v, ['client_idempotency_key', 'contract_id', 'contract_version', 'prompt', 'scope'], 'request'); header(v, 'request'); scope(v.scope); if (typeof v.prompt !== 'string' || v.prompt.length === 0 || v.prompt.length > 4096) fail('request.prompt', 'invalid'); id(v.client_idempotency_key, 'request.client_idempotency_key'); return v }
function assertCancelRequest (v) { exact(v, ['contract_id', 'contract_version', 'interaction_id'], 'request'); header(v, 'request'); id(v.interaction_id, 'request.interaction_id'); return v }
function assertHistoryRequest (v) { exact(v, ['contract_id', 'contract_version', 'limit', 'cursor'], 'request'); header(v, 'request'); integer(v.limit, 'request.limit'); if (v.limit < 1 || v.limit > 100) fail('request.limit', 'out of range'); if (v.cursor !== null) id(v.cursor, 'request.cursor'); return v }
function assertInteractionRequest (v) { exact(v, ['contract_id', 'contract_version', 'interaction_id'], 'request'); header(v, 'request'); id(v.interaction_id, 'request.interaction_id'); return v }
function assertExportRequest (v) { exact(v, ['contract_id', 'contract_version', 'interaction_id'], 'request'); header(v, 'request'); id(v.interaction_id, 'request.interaction_id'); return v }
function assertSnapshot (v, p = 'snapshot') { exact(v, ['scope', 'eligibility', 'next_action', 'revision'], p); scope(v.scope, `${p}.scope`); enumValue(v.eligibility, ELIGIBILITY_STATES, `${p}.eligibility`); if (v.next_action !== null) fail(`${p}.next_action`, 'must be null until an exact action contract is signed'); integer(v.revision, `${p}.revision`); return v }
function assertGetScopesResponse (v) {
  exact(v, ['contract_id', 'contract_version', 'default_scope', 'error', 'next_cursor', 'ok', 'revision', 'scopes'], 'response')
  header(v, 'response')
  if (typeof v.ok !== 'boolean') fail('response.ok', 'must be boolean')
  integer(v.revision, 'response.revision')
  assertOpaqueCursor(v.next_cursor, 'response.next_cursor')
  if (v.default_scope !== null) {
    scope(v.default_scope, 'response.default_scope')
    if (v.default_scope.kind !== 'session') fail('response.default_scope.kind', 'must be session')
  }
  if (!Array.isArray(v.scopes) || v.scopes.length > 50) fail('response.scopes', 'must be an array of at most 50 items')
  const seen = new Set()
  v.scopes.forEach((item, index) => { assertScopeItem(item, `response.scopes[${index}]`); const key = item.scope.reference; if (seen.has(key)) fail(`response.scopes[${index}].scope.reference`, 'must be unique'); seen.add(key) })
  if (v.ok) {
    if (v.error !== null) fail('response.error', 'must be null')
  } else {
    if (v.error === null) fail('response.error', 'must be present')
    plain(v.error, 'response.error')
    exact(v.error, ['category', 'code', 'next_action'], 'response.error')
    enumValue(v.error.code, Object.values(ERROR_CODES), 'response.error.code')
    if (typeof v.error.category !== 'string' || (v.error.next_action !== null && typeof v.error.next_action !== 'string')) fail('response.error', 'invalid error projection')
  }
  if (v.default_scope !== null && !seen.has(v.default_scope.reference)) fail('response.default_scope', 'must be one of response.scopes')
  if (v.scopes.length === 0 && v.default_scope !== null) fail('response.default_scope', 'must be null for an empty scope directory')
  return v
}
function assertError (v, p = 'error') { plain(v, p); exact(v, ['category', 'code', 'next_action'], p); if (typeof v.category !== 'string') fail(`${p}.category`, 'must be a string'); enumValue(v.code, RUN_ERROR_CODES, `${p}.code`); if (v.next_action !== null && typeof v.next_action !== 'string') fail(`${p}.next_action`, 'must be null or string'); return v }
function assertCommandResponse (v, p = 'response') { exact(v, ['contract_id', 'contract_version', 'ok', 'error', 'result'], p); header(v, p); if (typeof v.ok !== 'boolean') fail(`${p}.ok`, 'must be boolean'); if (v.ok) { if (v.error !== null) fail(`${p}.error`, 'must be null'); if (v.result !== null && (!v.result || typeof v.result !== 'object' || Array.isArray(v.result) || Object.getPrototypeOf(v.result) !== Object.prototype)) fail(`${p}.result`, 'must be a plain object or null') } else { if (v.result !== null) fail(`${p}.result`, 'must be null'); assertError(v.error, `${p}.error`) } if (v.result !== null) assertFixturePrivacy(v.result, `${p}.result`); return v }
function assertGetEligibilityResponse (v) { exact(v, ['contract_id', 'contract_version', 'ok', 'error', 'snapshot'], 'response'); header(v, 'response'); if (typeof v.ok !== 'boolean') fail('response.ok', 'must be boolean'); if (v.ok) { if (v.error !== null) fail('response.error', 'must be null'); assertSnapshot(v.snapshot) } else { if (v.snapshot !== null) fail('response.snapshot', 'must be null'); plain(v.error, 'response.error'); exact(v.error, ['category', 'code', 'next_action'], 'response.error'); enumValue(v.error.code, Object.values(ERROR_CODES), 'response.error.code'); if (v.error.next_action !== null && typeof v.error.next_action !== 'string') fail('response.error.next_action', 'invalid') } return v }
function assertChangedEvent (v) { exact(v, ['contract_id', 'contract_version', 'revision'], 'event'); header(v, 'event'); integer(v.revision, 'event.revision'); return v }
function assertFixturePrivacy (v, p = 'fixture') { if (!v || typeof v !== 'object') return v; for (const [k, val] of Object.entries(v)) { if (FORBIDDEN.has(normalizeField(k))) fail(`${p}.${k}`, 'forbidden'); if (typeof val === 'string' && (/^[A-Z]:[\\/]/i.test(val) || /(?:\.wav|\.pcm|\.mp3)$/i.test(val) || /^bearer\s/i.test(val))) fail(`${p}.${k}`, 'forbidden'); if (val && typeof val === 'object') assertFixturePrivacy(val, `${p}.${k}`) } return v }
function isSupportedContract (idValue, version) { return idValue === CONTRACT_ID && version === CONTRACT_VERSION }

module.exports = { CONTRACT_ID, CONTRACT_VERSION, ALLOWED_ROLES, IPC_CHANNELS, TERMINAL_STATES, ROUTING_MODES, USAGE_STATES, ELIGIBILITY_STATES, SCOPE_KINDS, ERROR_CODES, RUN_ERROR_CODES, assertGetScopesRequest, assertGetScopesResponse, assertGetEligibilityRequest, assertGetEligibilityResponse, assertSubmitRequest, assertCancelRequest, assertHistoryRequest, assertInteractionRequest, assertExportRequest, assertCommandResponse, assertChangedEvent, assertFixturePrivacy, scope, assertScopeItem, isSupportedContract }
