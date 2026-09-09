'use strict'

const { assertToolCallRecord, assertToolCallSequence } = require('./controlled-tools')

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
  exportInteraction: 'agent-run:export-interaction',
  recordSignal: 'agent-run:record-signal'
})
const TERMINAL_STATES = Object.freeze(['pending', 'running', 'succeeded', 'failed', 'cancelling', 'cancelled'])
const ROUTING_MODES = Object.freeze(['model', 'rules', 'preset'])
const USAGE_STATES = Object.freeze(['known', 'unknown'])
const ELIGIBILITY_STATES = Object.freeze(['ready', 'no_committed_transcript', 'outside_automatic_window', 'agent_disabled', 'provider_not_configured', 'cloud_disclosure_required', 'credential_unavailable', 'local_model_not_ready', 'session_not_terminal'])
const SCOPE_KINDS = Object.freeze(['selection', 'session', 'date_range', 'project'])
const SIGNAL_KINDS = Object.freeze(['prompt', 'edit', 'accept', 'reject', 'remember', 'forget'])
const ERROR_CODES = Object.freeze({ unavailable: 'AGENT_RUN_UNAVAILABLE', invalid: 'AGENT_RUN_INVALID' })
const RUN_ERROR_CODES = Object.freeze(['AGENT_RUN_UNAVAILABLE', 'AGENT_RUN_INVALID', 'AGENT_CANCELLED', 'AGENT_PROVIDER_AUTH_FAILED', 'AGENT_PROVIDER_RATE_LIMITED', 'AGENT_PROVIDER_UNAVAILABLE', 'AGENT_PROVIDER_TIMEOUT', 'AGENT_OUTPUT_INVALID', 'AGENT_PERMISSION_DENIED', 'AGENT_REQUEST_INVALID', 'AGENT_WORKER_EXITED', 'AGENT_INTERNAL_FAILURE', 'AGENT_BUDGET_EXCEEDED'])
const ID = /^[a-z0-9][a-z0-9._:-]{0,159}$/
const FORBIDDEN = new Set(['prompt', 'prompt_text', 'user_prompt', 'prompt_body', 'assistant', 'assistant_text', 'reasoning', 'internal_reasoning', 'provider_event', 'provider_events', 'provider_raw_event', 'raw_error', 'stack', 'credential', 'credentials', 'api_key', 'secret', 'password', 'audio', 'audio_file', 'audio_uri', 'pcm', 'wav', 'audio_path', 'path', 'local_path', 'absolute_path', 'target_path', 'save_target', 'device', 'device_name', 'device_id', 'clock_offset_ms', 'absolute_monotonic_ms', 'monotonic_timestamp', 'amount', 'amount_cents', 'price', 'price_amount', 'cost', 'cost_amount', 'currency', 'currency_code', 'pricing', 'api_token', 'access_token', 'refresh_token', 'token_value', 'transcript_text', 'caption_text'])
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
function assertHistoryRequest (v) { exact(v, ['contract_id', 'contract_version', 'limit', 'cursor'], 'request'); header(v, 'request'); integer(v.limit, 'request.limit'); if (v.limit < 1 || v.limit > 100) fail('request.limit', 'out of range'); assertOpaqueCursor(v.cursor, 'request.cursor'); return v }
function assertInteractionRequest (v) { exact(v, ['contract_id', 'contract_version', 'interaction_id'], 'request'); header(v, 'request'); id(v.interaction_id, 'request.interaction_id'); return v }
function assertExportRequest (v) { exact(v, ['contract_id', 'contract_version', 'interaction_id'], 'request'); header(v, 'request'); id(v.interaction_id, 'request.interaction_id'); return v }
function assertSignalPayload (signalKind, payload, p = 'request.payload') {
  if (signalKind === 'edit') {
    exact(payload, ['text'], p)
    if (typeof payload.text !== 'string' || payload.text.length > 4096 || /[\u0000-\u001f\u007f]/u.test(payload.text)) fail(`${p}.text`, 'must be a bounded text value')
    return payload
  }
  if (payload !== null) fail(p, 'must be null for this signal')
  return payload
}
function assertRecordSignalRequest (v) {
  exact(v, ['contract_id', 'contract_version', 'interaction_id', 'payload', 'result_digest', 'signal_idempotency_key', 'signal_kind'], 'request')
  header(v, 'request')
  id(v.interaction_id, 'request.interaction_id')
  enumValue(v.signal_kind, SIGNAL_KINDS, 'request.signal_kind')
  id(v.signal_idempotency_key, 'request.signal_idempotency_key')
  if (v.result_digest !== null && (typeof v.result_digest !== 'string' || !/^[a-f0-9]{64}$/.test(v.result_digest))) fail('request.result_digest', 'must be null or a SHA-256 digest')
  if (v.signal_kind === 'prompt' && v.result_digest !== null) fail('request.result_digest', 'prompt signal must not bind a result')
  if (v.signal_kind !== 'prompt' && v.result_digest === null) fail('request.result_digest', 'signal must bind a result digest')
  assertSignalPayload(v.signal_kind, v.payload)
  return v
}
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
function assertCommandEnvelope (v, p = 'response') {
  exact(v, ['contract_id', 'contract_version', 'ok', 'error', 'result'], p)
  header(v, p)
  if (typeof v.ok !== 'boolean') fail(`${p}.ok`, 'must be boolean')
  if (v.ok) {
    if (v.error !== null) fail(`${p}.error`, 'must be null')
  } else {
    if (v.result !== null) fail(`${p}.result`, 'must be null')
    assertError(v.error, `${p}.error`)
  }
  return v
}
function assertPublicState (v, p) { enumValue(v, TERMINAL_STATES, p); return v }
function assertRevision (v, p) { integer(v, p); return v }
function assertNullableDigest (v, p) { if (v !== null && (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v))) fail(p, 'must be null or a SHA-256 digest'); return v }
function assertDigest (v, p) { if (typeof v !== 'string' || !/^[a-f0-9]{64}$/.test(v)) fail(p, 'must be a SHA-256 digest'); return v }
function assertUsage (v, p) {
  if (v === null) return v
  exact(v, ['cache_hit_input_tokens', 'cache_miss_input_tokens', 'input_tokens', 'output_tokens', 'usage_source'], p)
  integer(v.input_tokens, `${p}.input_tokens`)
  integer(v.output_tokens, `${p}.output_tokens`)
  if (v.usage_source !== 'provider') fail(`${p}.usage_source`, 'must be provider')
  const bothNull = v.cache_hit_input_tokens === null && v.cache_miss_input_tokens === null
  if (!bothNull) {
    integer(v.cache_hit_input_tokens, `${p}.cache_hit_input_tokens`)
    integer(v.cache_miss_input_tokens, `${p}.cache_miss_input_tokens`)
    if (v.cache_hit_input_tokens + v.cache_miss_input_tokens !== v.input_tokens) fail(p, 'cache input tokens are inconsistent')
  }
  return v
}
function assertUsageState (v, p) { enumValue(v, USAGE_STATES, p); return v }
function assertHistoryItem (v, p = 'history item') {
  exact(v, [
    'attempt_count', 'created_at', 'duration_ms', 'error_code', 'interaction_id',
    'comparison_group_id', 'model', 'recipe_id', 'recipe_version', 'result', 'result_digest', 'terminal_at',
    'terminal_reason', 'usage', 'usage_state'
  ], p)
  id(v.interaction_id, `${p}.interaction_id`)
  assertDigest(v.comparison_group_id, `${p}.comparison_group_id`)
  assertModelIdentity(v.model, `${p}.model`)
  id(v.recipe_id, `${p}.recipe_id`)
  id(v.recipe_version, `${p}.recipe_version`)
  enumValue(v.terminal_reason, ['succeeded', 'failed', 'cancelled'], `${p}.terminal_reason`)
  if (v.error_code !== null) enumValue(v.error_code, RUN_ERROR_CODES, `${p}.error_code`)
  integer(v.duration_ms, `${p}.duration_ms`)
  integer(v.attempt_count, `${p}.attempt_count`)
  integer(v.created_at, `${p}.created_at`)
  integer(v.terminal_at, `${p}.terminal_at`)
  assertUsage(v.usage, `${p}.usage`)
  assertUsageState(v.usage_state, `${p}.usage_state`)
  assertNullableDigest(v.result_digest, `${p}.result_digest`)
  if (v.result !== null) assertFixturePrivacy(v.result, `${p}.result`)
  return v
}
function assertSubmitResult (v, p = 'response.result') {
  exact(v, ['eligibility', 'interaction_id', 'recipe_id', 'revision', 'routing_mode', 'run_id', 'state'], p)
  if (v.interaction_id !== null) id(v.interaction_id, `${p}.interaction_id`)
  if (v.run_id !== null) id(v.run_id, `${p}.run_id`)
  if (v.recipe_id !== null) id(v.recipe_id, `${p}.recipe_id`)
  if (v.routing_mode !== null) enumValue(v.routing_mode, ROUTING_MODES, `${p}.routing_mode`)
  if (v.state !== null) assertPublicState(v.state, `${p}.state`)
  if (v.eligibility !== null) enumValue(v.eligibility, ELIGIBILITY_STATES, `${p}.eligibility`)
  assertRevision(v.revision, `${p}.revision`)
  return v
}
function assertCancelResult (v, p = 'response.result') {
  exact(v, ['interaction_id', 'revision', 'state'], p)
  id(v.interaction_id, `${p}.interaction_id`)
  assertPublicState(v.state, `${p}.state`)
  assertRevision(v.revision, `${p}.revision`)
  return v
}
function assertHistoryResult (v, p = 'response.result') {
  exact(v, ['has_more', 'items', 'next_cursor'], p)
  if (typeof v.has_more !== 'boolean') fail(`${p}.has_more`, 'must be boolean')
  assertOpaqueCursor(v.next_cursor, `${p}.next_cursor`)
  if (!Array.isArray(v.items) || v.items.length > 100) fail(`${p}.items`, 'must be an array of at most 100 items')
  v.items.forEach((item, index) => assertHistoryItem(item, `${p}.items[${index}]`))
  return v
}
function assertModelIdentity (v, p) {
  exact(v, ['adapter_id', 'model_id', 'profile_id', 'profile_revision', 'provider_kind'], p)
  id(v.adapter_id, `${p}.adapter_id`)
  id(v.model_id, `${p}.model_id`)
  id(v.profile_id, `${p}.profile_id`)
  integer(v.profile_revision, `${p}.profile_revision`)
  enumValue(v.provider_kind, ['local', 'cloud'], `${p}.provider_kind`)
  return v
}
function assertToolCall (v, p) {
  exact(v, [
    'args', 'args_digest', 'attempt', 'call_id', 'call_order', 'counts',
    'ended_offset_ms', 'error_code', 'result', 'result_digest',
    'schema_version', 'source_refs', 'started_offset_ms', 'status', 'tool_name'
  ], p)
  try {
    assertToolCallRecord({
      callId: v.call_id,
      attempt: v.attempt,
      callOrder: v.call_order,
      toolName: v.tool_name,
      schemaVersion: v.schema_version,
      startedOffsetMs: v.started_offset_ms,
      endedOffsetMs: v.ended_offset_ms,
      status: v.status,
      errorCode: v.error_code,
      args: v.args,
      argsDigest: v.args_digest,
      result: v.result,
      resultDigest: v.result_digest,
      sourceRefs: v.source_refs,
      counts: v.counts
    })
  } catch (error) {
    fail(p, error instanceof Error ? error.message : 'invalid ToolCallRecordV1')
  }
  assertFixturePrivacy(v.args, `${p}.args`)
  if (v.result !== null) assertFixturePrivacy(v.result, `${p}.result`)
  return v
}
function assertInteractionResult (v, p = 'response.result') {
  exact(v, [
    'attempt_count', 'created_at', 'duration_ms', 'error_code', 'interaction_id',
    'model', 'recipe_id', 'recipe_version', 'result', 'result_digest',
    'routing_mode', 'run_id', 'source_refs', 'state', 'terminal_at',
    'terminal_reason', 'tool_calls', 'usage', 'usage_state'
  ], p)
  id(v.interaction_id, `${p}.interaction_id`)
  id(v.run_id, `${p}.run_id`)
  id(v.recipe_id, `${p}.recipe_id`)
  id(v.recipe_version, `${p}.recipe_version`)
  enumValue(v.routing_mode, ROUTING_MODES, `${p}.routing_mode`)
  assertPublicState(v.state, `${p}.state`)
  if (v.terminal_reason !== null) enumValue(v.terminal_reason, ['succeeded', 'failed', 'cancelled'], `${p}.terminal_reason`)
  if (v.error_code !== null) enumValue(v.error_code, RUN_ERROR_CODES, `${p}.error_code`)
  assertModelIdentity(v.model, `${p}.model`)
  integer(v.duration_ms, `${p}.duration_ms`)
  integer(v.attempt_count, `${p}.attempt_count`)
  integer(v.created_at, `${p}.created_at`)
  if (v.terminal_at !== null) integer(v.terminal_at, `${p}.terminal_at`)
  assertUsage(v.usage, `${p}.usage`)
  assertUsageState(v.usage_state, `${p}.usage_state`)
  assertNullableDigest(v.result_digest, `${p}.result_digest`)
  if (v.result !== null) assertFixturePrivacy(v.result, `${p}.result`)
  if (!Array.isArray(v.source_refs) || v.source_refs.length > 16) fail(`${p}.source_refs`, 'must be an array')
  assertFixturePrivacy(v.source_refs, `${p}.source_refs`)
  if (!Array.isArray(v.tool_calls) || v.tool_calls.length > 100) fail(`${p}.tool_calls`, 'must be an array')
  v.tool_calls.forEach((call, index) => assertToolCall(call, `${p}.tool_calls[${index}]`))
  try {
    assertToolCallSequence(v.tool_calls.map((call) => ({
      callId: call.call_id,
      attempt: call.attempt,
      callOrder: call.call_order,
      toolName: call.tool_name,
      schemaVersion: call.schema_version,
      startedOffsetMs: call.started_offset_ms,
      endedOffsetMs: call.ended_offset_ms,
      status: call.status,
      errorCode: call.error_code,
      args: call.args,
      argsDigest: call.args_digest,
      result: call.result,
      resultDigest: call.result_digest,
      sourceRefs: call.source_refs,
      counts: call.counts
    })))
  } catch (error) {
    fail(`${p}.tool_calls`, error instanceof Error ? error.message : 'invalid ToolCallSequenceV1')
  }
  return v
}
function assertExportResult (v, p = 'response.result') {
  exact(v, ['bytes_sha256', 'interaction_id', 'schema_version', 'snapshot'], p)
  id(v.interaction_id, `${p}.interaction_id`)
  if (v.schema_version !== 1) fail(`${p}.schema_version`, 'must be 1')
  if (typeof v.bytes_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(v.bytes_sha256)) fail(`${p}.bytes_sha256`, 'must be a SHA-256 digest')
  if (!v.snapshot || typeof v.snapshot !== 'object' || Array.isArray(v.snapshot)) fail(`${p}.snapshot`, 'must be an object')
  assertFixturePrivacy(v.snapshot, `${p}.snapshot`)
  return v
}
function assertRecordSignalResult (v, p = 'response.result') {
  exact(v, ['accepted', 'interaction_id', 'replayed', 'signal_kind'], p)
  id(v.interaction_id, `${p}.interaction_id`)
  enumValue(v.signal_kind, SIGNAL_KINDS, `${p}.signal_kind`)
  if (typeof v.accepted !== 'boolean' || typeof v.replayed !== 'boolean') fail(p, 'accepted and replayed must be boolean')
  return v
}
function assertSubmitResponse (v) { assertCommandEnvelope(v); if (v.ok && v.result !== null) assertSubmitResult(v.result); return v }
function assertCancelResponse (v) { assertCommandEnvelope(v); if (v.ok && v.result !== null) assertCancelResult(v.result); return v }
function assertHistoryResponse (v) { assertCommandEnvelope(v); if (v.ok) { if (v.result === null) fail('response.result', 'must be present'); assertHistoryResult(v.result) }; return v }
function assertInteractionResponse (v) { assertCommandEnvelope(v); if (v.ok) { if (v.result === null) fail('response.result', 'must be present'); assertInteractionResult(v.result) }; return v }
function assertExportResponse (v) { assertCommandEnvelope(v); if (v.ok) { if (v.result === null) fail('response.result', 'must be present'); assertExportResult(v.result) }; return v }
function assertRecordSignalResponse (v) { assertCommandEnvelope(v); if (v.ok) { if (v.result === null) fail('response.result', 'must be present'); assertRecordSignalResult(v.result) }; return v }
function assertCommandResponse (v, p = 'response') { assertCommandEnvelope(v, p); if (v.ok && v.result !== null) assertFixturePrivacy(v.result, `${p}.result`); return v }
function assertGetEligibilityResponse (v) { exact(v, ['contract_id', 'contract_version', 'ok', 'error', 'snapshot'], 'response'); header(v, 'response'); if (typeof v.ok !== 'boolean') fail('response.ok', 'must be boolean'); if (v.ok) { if (v.error !== null) fail('response.error', 'must be null'); assertSnapshot(v.snapshot) } else { if (v.snapshot !== null) fail('response.snapshot', 'must be null'); plain(v.error, 'response.error'); exact(v.error, ['category', 'code', 'next_action'], 'response.error'); enumValue(v.error.code, Object.values(ERROR_CODES), 'response.error.code'); if (v.error.next_action !== null && typeof v.error.next_action !== 'string') fail('response.error.next_action', 'invalid') } return v }
function assertChangedEvent (v) { exact(v, ['contract_id', 'contract_version', 'revision'], 'event'); header(v, 'event'); integer(v.revision, 'event.revision'); return v }
function assertFixturePrivacy (v, p = 'fixture') {
  if (typeof v === 'string') {
    if (/^(?:[A-Z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|private|mnt|workspace|root|data|opt|etc)(?:[\\/]|$))/i.test(v)) fail(p, 'forbidden')
    return v
  }
  if (!v || typeof v !== 'object') return v
  for (const [k, val] of Object.entries(v)) {
    if (FORBIDDEN.has(normalizeField(k))) fail(`${p}.${k}`, 'forbidden')
    if (typeof val === 'string' && (/^(?:[A-Z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|private|mnt|workspace|root|data|opt|etc)(?:[\\/]|$))/i.test(val) || /(?:\.wav|\.pcm|\.mp3)$/i.test(val) || /^bearer\s/i.test(val))) fail(`${p}.${k}`, 'forbidden')
    if (val && typeof val === 'object') assertFixturePrivacy(val, `${p}.${k}`)
  }
  return v
}
function isSupportedContract (idValue, version) { return idValue === CONTRACT_ID && version === CONTRACT_VERSION }

module.exports = { CONTRACT_ID, CONTRACT_VERSION, ALLOWED_ROLES, IPC_CHANNELS, TERMINAL_STATES, ROUTING_MODES, USAGE_STATES, ELIGIBILITY_STATES, SCOPE_KINDS, SIGNAL_KINDS, ERROR_CODES, RUN_ERROR_CODES, assertGetScopesRequest, assertGetScopesResponse, assertGetEligibilityRequest, assertGetEligibilityResponse, assertSubmitRequest, assertCancelRequest, assertHistoryRequest, assertInteractionRequest, assertExportRequest, assertRecordSignalRequest, assertCommandResponse, assertSubmitResponse, assertCancelResponse, assertHistoryResponse, assertInteractionResponse, assertExportResponse, assertRecordSignalResponse, assertChangedEvent, assertFixturePrivacy, scope, assertSnapshot, assertScopeItem, isSupportedContract }
