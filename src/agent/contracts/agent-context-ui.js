'use strict'

// @ts-check

const CONTRACT_ID = 'speech-agent.personal-context.ui'
const CONTRACT_VERSION = '1.1.0'
const MAX_SCOPE_DIRECTORY_ITEMS = 50

const ALLOWED_ROLES = Object.freeze(['history', 'settings'])
const IPC_CHANNELS = Object.freeze({
  changed: 'agent-context:changed',
  getOverview: 'agent-context:get-overview',
  manage: 'agent-context:manage'
})
const PRELOAD_GLOBALS = Object.freeze({
  history: 'historyApi',
  settings: 'shell'
})
const PRELOAD_METHODS = Object.freeze({
  getOverview: 'getAgentContextOverview',
  manage: 'manageAgentContext',
  onChanged: 'onAgentContextChanged'
})
const MANAGE_COMMANDS = Object.freeze([
  'delete',
  'forget',
  'remember',
  'set_processing',
  'update',
  'view'
])
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
const MEMORY_KINDS = Object.freeze([
  'decision',
  'conclusion',
  'todo',
  'term',
  'preference',
  'project_fact',
  'experience'
])
const SCOPE_KINDS = Object.freeze(['global', 'session', 'topic', 'project'])
const ERROR_CODES = Object.freeze({
  notFound: 'AGENT_CONTEXT_NOT_FOUND',
  operationFailed: 'AGENT_CONTEXT_OPERATION_FAILED',
  permissionDenied: 'AGENT_CONTEXT_PERMISSION_DENIED',
  requestInvalid: 'AGENT_CONTEXT_REQUEST_INVALID',
  revisionConflict: 'AGENT_CONTEXT_REVISION_CONFLICT',
  unavailable: 'AGENT_CONTEXT_UNAVAILABLE'
})

const ERROR_RULES = Object.freeze({
  [ERROR_CODES.notFound]: Object.freeze({ category: 'not_found', retry_policy: 'reload', next_action: 'reload' }),
  [ERROR_CODES.operationFailed]: Object.freeze({ category: 'failure', retry_policy: 'reload', next_action: 'reload' }),
  [ERROR_CODES.permissionDenied]: Object.freeze({ category: 'permission', retry_policy: 'none', next_action: null }),
  [ERROR_CODES.requestInvalid]: Object.freeze({ category: 'validation', retry_policy: 'none', next_action: null }),
  [ERROR_CODES.revisionConflict]: Object.freeze({ category: 'conflict', retry_policy: 'reload', next_action: 'reload' }),
  [ERROR_CODES.unavailable]: Object.freeze({ category: 'unavailable', retry_policy: 'retry_same_request', next_action: 'retry' })
})

const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,256}$/
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const FIXTURE_SCENARIOS = Object.freeze([
  'delete_result',
  'empty',
  'failure',
  'forget_result',
  'loading',
  'pagination',
  'permission_failure',
  'processing',
  'ready',
  'reload_result',
  'revision_conflict',
  'scope_directory',
  'scope_empty',
  'unavailable',
  'validation_error'
])
const CALLER_ROLES = Object.freeze(['caption', 'history', 'settings', 'toolbar', 'unknown'])
const FORBIDDEN_PRIVACY_KEY = /(?:^|_)(?:api_?key|authorization|credential|password|secret|audio|pcm|wav|device|local_path|absolute_path|transcript_text|caption_text|monotonic|clock_offset|raw_error|stack|scheduler|wake_epoch|claim|lease|timer|generation)(?:_|$)/i
const FORBIDDEN_PRIVACY_VALUE = /(?:bearer\s+[A-Za-z0-9._~+/-]+|[A-Za-z]:[\\/]|file:\/\/|\.wav(?:\b|$))/i
const SYNTHETIC_FIXTURE_TIMESTAMP = /^2000-01-01T00:\d{2}:\d{2}\.000Z$/

function fail (path, message) {
  throw new TypeError(`${path}: ${message}`)
}

function assertRecord (value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object')
  }
}

function assertExactObject (value, requiredKeys, optionalKeys, path) {
  assertRecord(value, path)
  const allowed = new Set([...requiredKeys, ...optionalKeys])
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'is not allowed')
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${path}.${key}`, 'is required')
  }
}

function assertString (value, path, options = {}) {
  if (typeof value !== 'string') fail(path, 'must be a string')
  if (options.nonEmpty && value.trim().length === 0) fail(path, 'must not be empty')
  if (options.pattern && !options.pattern.test(value)) fail(path, 'has an invalid format')
  if (options.maxBytes !== undefined && Buffer.byteLength(value, 'utf8') > options.maxBytes) {
    fail(path, `must be <= ${options.maxBytes} UTF-8 bytes`)
  }
}

function assertInteger (value, path, options = {}) {
  if (!Number.isInteger(value)) fail(path, 'must be an integer')
  if (options.min !== undefined && value < options.min) fail(path, `must be >= ${options.min}`)
  if (options.max !== undefined && value > options.max) fail(path, `must be <= ${options.max}`)
}

function assertBoolean (value, path) {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean')
}

function assertEnum (value, allowed, path) {
  if (!allowed.includes(value)) fail(path, `must be one of: ${allowed.join(', ')}`)
}

function assertNullableEnum (value, allowed, path) {
  if (value !== null) assertEnum(value, allowed, path)
}

function assertArray (value, path, options = {}) {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  if (options.max !== undefined && value.length > options.max) fail(path, `must contain <= ${options.max} items`)
}

function assertId (value, path) {
  assertString(value, path, { nonEmpty: true, pattern: ID_PATTERN })
}

function assertTimestamp (value, path) {
  assertString(value, path, { pattern: RFC3339_PATTERN })
  if (!Number.isFinite(Date.parse(value))) fail(path, 'must be a valid RFC 3339 UTC timestamp')
}

function assertContractHeader (value, path) {
  if (value.contract_id !== CONTRACT_ID) fail(`${path}.contract_id`, `must equal ${CONTRACT_ID}`)
  if (value.contract_version !== CONTRACT_VERSION) fail(`${path}.contract_version`, `must equal ${CONTRACT_VERSION}`)
}

function isSupportedContract (contractId, contractVersion) {
  return contractId === CONTRACT_ID && contractVersion === CONTRACT_VERSION
}

function assertScopeInput (value, path) {
  assertExactObject(value, ['kind', 'reference'], [], path)
  assertEnum(value.kind, SCOPE_KINDS, `${path}.kind`)
  if (value.kind === 'global') {
    if (value.reference !== null) fail(`${path}.reference`, 'must be null for global scope')
  } else {
    assertId(value.reference, `${path}.reference`)
  }
}

function assertScopeProjection (value, path) {
  assertExactObject(value, ['kind', 'label', 'reference'], [], path)
  assertScopeInput({ kind: value.kind, reference: value.reference }, path)
  assertString(value.label, `${path}.label`, { nonEmpty: true, maxBytes: 256 })
}

function assertStructuredEntry (value, path) {
  assertExactObject(value, ['display_text', 'kind', 'scope'], [], path)
  assertString(value.display_text, `${path}.display_text`, { nonEmpty: true, maxBytes: 2048 })
  assertEnum(value.kind, MEMORY_KINDS, `${path}.kind`)
  assertScopeInput(value.scope, `${path}.scope`)
}

function assertScopeDirectory (value, path) {
  assertExactObject(value, ['has_more', 'items'], [], path)
  assertBoolean(value.has_more, `${path}.has_more`)
  assertArray(value.items, `${path}.items`, { max: MAX_SCOPE_DIRECTORY_ITEMS })
  const scopeIds = new Set()
  value.items.forEach((item, index) => {
    const itemPath = `${path}.items[${index}]`
    assertExactObject(item, ['display_name', 'kind', 'scope_id'], [], itemPath)
    assertString(item.display_name, `${itemPath}.display_name`, { nonEmpty: true, maxBytes: 256 })
    assertEnum(item.kind, ['session', 'topic', 'project'], `${itemPath}.kind`)
    assertId(item.scope_id, `${itemPath}.scope_id`)
    if (scopeIds.has(item.scope_id)) fail(`${itemPath}.scope_id`, 'must be unique')
    scopeIds.add(item.scope_id)
  })
}

function assertMemoryItem (value, path) {
  assertExactObject(value, [
    'display_text',
    'kind',
    'lifecycle',
    'memory_id',
    'origin',
    'revision',
    'scope',
    'source_reference_count',
    'updated_at'
  ], [], path)
  assertString(value.display_text, `${path}.display_text`, { nonEmpty: true, maxBytes: 2048 })
  assertEnum(value.kind, MEMORY_KINDS, `${path}.kind`)
  assertEnum(value.lifecycle, ['active', 'forgotten'], `${path}.lifecycle`)
  assertId(value.memory_id, `${path}.memory_id`)
  assertEnum(value.origin, ['explicit', 'inferred'], `${path}.origin`)
  assertInteger(value.revision, `${path}.revision`, { min: 1 })
  assertScopeProjection(value.scope, `${path}.scope`)
  assertInteger(value.source_reference_count, `${path}.source_reference_count`, { min: 0 })
  assertTimestamp(value.updated_at, `${path}.updated_at`)
}

function assertEpisode (value, path) {
  assertExactObject(value, [
    'episode_id',
    'lifecycle',
    'occurred_from_offset_ms',
    'occurred_through_offset_ms',
    'omissions',
    'scope',
    'source_kind',
    'source_reference_count',
    'summary',
    'updated_at'
  ], [], path)
  assertId(value.episode_id, `${path}.episode_id`)
  assertEnum(value.lifecycle, ['active'], `${path}.lifecycle`)
  assertInteger(value.occurred_from_offset_ms, `${path}.occurred_from_offset_ms`, { min: 0 })
  assertInteger(value.occurred_through_offset_ms, `${path}.occurred_through_offset_ms`, { min: 0 })
  if (value.occurred_through_offset_ms < value.occurred_from_offset_ms) {
    fail(`${path}.occurred_through_offset_ms`, 'must be >= occurred_from_offset_ms')
  }
  assertArray(value.omissions, `${path}.omissions`, { max: 2 })
  const omissions = new Set()
  value.omissions.forEach((item, index) => {
    assertEnum(item, ['budget', 'not_committed_tail'], `${path}.omissions[${index}]`)
    if (omissions.has(item)) fail(`${path}.omissions[${index}]`, 'must be unique')
    omissions.add(item)
  })
  assertScopeProjection(value.scope, `${path}.scope`)
  assertEnum(value.source_kind, ['interaction', 'session'], `${path}.source_kind`)
  assertInteger(value.source_reference_count, `${path}.source_reference_count`, { min: 1 })
  assertExactObject(value.summary, ['bullets', 'title'], [], `${path}.summary`)
  assertString(value.summary.title, `${path}.summary.title`, { nonEmpty: true, maxBytes: 512 })
  assertArray(value.summary.bullets, `${path}.summary.bullets`, { max: 8 })
  value.summary.bullets.forEach((item, index) => {
    assertString(item, `${path}.summary.bullets[${index}]`, { nonEmpty: true, maxBytes: 1024 })
  })
  assertTimestamp(value.updated_at, `${path}.updated_at`)
}

function assertMemoryProcessing (value, path) {
  assertExactObject(value, ['automatic_processing_boundary', 'state'], [], path)
  assertEnum(value.state, ['enabled', 'suspended'], `${path}.state`)
  assertEnum(value.automatic_processing_boundary, ['current_effective_cycle', 'not_established'], `${path}.automatic_processing_boundary`)
  if (value.state === 'suspended' && value.automatic_processing_boundary !== 'not_established') {
    fail(`${path}.automatic_processing_boundary`, 'must be not_established while suspended')
  }
}

function assertOverviewSnapshot (value, path) {
  assertExactObject(value, ['counts', 'eligibility', 'memory_processing', 'revision', 'scope_directory'], [], path)
  assertExactObject(value.counts, ['personal_memories', 'session_episodes'], [], `${path}.counts`)
  assertInteger(value.counts.personal_memories, `${path}.counts.personal_memories`, { min: 0 })
  assertInteger(value.counts.session_episodes, `${path}.counts.session_episodes`, { min: 0 })
  assertEnum(value.eligibility, ELIGIBILITY_STATES, `${path}.eligibility`)
  assertMemoryProcessing(value.memory_processing, `${path}.memory_processing`)
  assertInteger(value.revision, `${path}.revision`, { min: 0 })
  assertScopeDirectory(value.scope_directory, `${path}.scope_directory`)
}

function assertPublicError (value, path) {
  assertExactObject(value, ['category', 'code', 'current_revision', 'next_action', 'retry_policy'], [], path)
  assertString(value.code, `${path}.code`, { nonEmpty: true })
  const rule = ERROR_RULES[value.code]
  if (!rule) fail(`${path}.code`, 'is not registered')
  if (value.category !== rule.category) fail(`${path}.category`, `must equal ${rule.category}`)
  if (value.retry_policy !== rule.retry_policy) fail(`${path}.retry_policy`, `must equal ${rule.retry_policy}`)
  if (value.next_action !== rule.next_action) fail(`${path}.next_action`, `must equal ${String(rule.next_action)}`)
  if (value.code === ERROR_CODES.revisionConflict) {
    assertInteger(value.current_revision, `${path}.current_revision`, { min: 0 })
  } else if (value.current_revision !== null) {
    fail(`${path}.current_revision`, 'must be null unless the error is a revision conflict')
  }
}

function assertGetOverviewRequest (value, path = 'GetOverviewRequest') {
  assertExactObject(value, ['contract_id', 'contract_version'], [], path)
  assertContractHeader(value, path)
  return value
}

function assertGetOverviewResponse (value, path = 'GetOverviewResponse') {
  assertExactObject(value, ['contract_id', 'contract_version', 'error', 'ok', 'snapshot'], [], path)
  assertContractHeader(value, path)
  assertBoolean(value.ok, `${path}.ok`)
  if (value.ok) {
    assertOverviewSnapshot(value.snapshot, `${path}.snapshot`)
    if (value.error !== null) fail(`${path}.error`, 'must be null for success')
  } else {
    if (value.snapshot !== null) fail(`${path}.snapshot`, 'must be null for failure')
    assertPublicError(value.error, `${path}.error`)
  }
  return value
}

function assertViewCommand (value, path) {
  assertExactObject(value, ['cursor', 'limit', 'resource', 'type'], [], path)
  assertEnum(value.resource, ['personal_memories', 'session_episodes'], `${path}.resource`)
  assertInteger(value.limit, `${path}.limit`, { min: 1, max: 20 })
  if (value.cursor !== null) assertString(value.cursor, `${path}.cursor`, { pattern: CURSOR_PATTERN })
}

function assertWriteRevision (value, path) {
  assertInteger(value.expected_revision, `${path}.expected_revision`, { min: 0 })
}

function assertManageCommand (value, path) {
  assertRecord(value, path)
  assertEnum(value.type, MANAGE_COMMANDS, `${path}.type`)
  switch (value.type) {
    case 'view':
      assertViewCommand(value, path)
      break
    case 'remember':
      assertExactObject(value, ['entry', 'expected_revision', 'type'], [], path)
      assertWriteRevision(value, path)
      assertStructuredEntry(value.entry, `${path}.entry`)
      break
    case 'update':
      assertExactObject(value, ['entry', 'expected_revision', 'item_id', 'item_revision', 'type'], [], path)
      assertWriteRevision(value, path)
      assertId(value.item_id, `${path}.item_id`)
      assertInteger(value.item_revision, `${path}.item_revision`, { min: 1 })
      assertStructuredEntry(value.entry, `${path}.entry`)
      break
    case 'forget':
      assertExactObject(value, ['expected_revision', 'item_id', 'item_revision', 'type'], [], path)
      assertWriteRevision(value, path)
      assertId(value.item_id, `${path}.item_id`)
      assertInteger(value.item_revision, `${path}.item_revision`, { min: 1 })
      break
    case 'delete':
      assertExactObject(value, ['deletion_idempotency_key', 'expected_revision', 'item_id', 'item_revision', 'type'], [], path)
      assertWriteRevision(value, path)
      assertString(value.deletion_idempotency_key, `${path}.deletion_idempotency_key`, { pattern: ID_PATTERN })
      assertId(value.item_id, `${path}.item_id`)
      assertInteger(value.item_revision, `${path}.item_revision`, { min: 1 })
      break
    case 'set_processing':
      assertExactObject(value, ['expected_revision', 'state', 'type'], [], path)
      assertWriteRevision(value, path)
      assertEnum(value.state, ['enabled', 'suspended'], `${path}.state`)
      break
  }
}

function assertManageRequest (value, path = 'ManageRequest') {
  assertExactObject(value, ['command', 'contract_id', 'contract_version', 'request_id'], [], path)
  assertContractHeader(value, path)
  assertId(value.request_id, `${path}.request_id`)
  assertManageCommand(value.command, `${path}.command`)
  return value
}

function assertPageResult (value, path, resource) {
  const expectedKind = resource === 'personal_memories' ? 'memory_page' : 'episode_page'
  assertExactObject(value, ['has_more', 'items', 'kind', 'next_cursor'], [], path)
  if (value.kind !== expectedKind) fail(`${path}.kind`, `must equal ${expectedKind}`)
  assertBoolean(value.has_more, `${path}.has_more`)
  assertArray(value.items, `${path}.items`, { max: 20 })
  value.items.forEach((item, index) => {
    if (resource === 'personal_memories') assertMemoryItem(item, `${path}.items[${index}]`)
    else assertEpisode(item, `${path}.items[${index}]`)
  })
  if (value.next_cursor !== null) assertString(value.next_cursor, `${path}.next_cursor`, { pattern: CURSOR_PATTERN })
  if (value.has_more !== (value.next_cursor !== null)) {
    fail(path, 'has_more must be true exactly when next_cursor is non-null')
  }
}

function assertManageResult (value, path) {
  assertRecord(value, path)
  assertString(value.kind, `${path}.kind`, { nonEmpty: true })
  switch (value.kind) {
    case 'memory_page':
      assertPageResult(value, path, 'personal_memories')
      break
    case 'episode_page':
      assertPageResult(value, path, 'session_episodes')
      break
    case 'memory_item':
      assertExactObject(value, ['item', 'kind', 'operation'], [], path)
      assertEnum(value.operation, ['forget', 'remember', 'update'], `${path}.operation`)
      assertMemoryItem(value.item, `${path}.item`)
      if (value.operation === 'forget' && value.item.lifecycle !== 'forgotten') {
        fail(`${path}.item.lifecycle`, 'must be forgotten after forget')
      }
      break
    case 'deletion':
      assertExactObject(value, ['deleted', 'kind', 'operation', 'replayed'], [], path)
      if (value.operation !== 'delete') fail(`${path}.operation`, 'must equal delete')
      assertBoolean(value.replayed, `${path}.replayed`)
      assertExactObject(value.deleted, ['evidence', 'items', 'revisions'], [], `${path}.deleted`)
      assertInteger(value.deleted.evidence, `${path}.deleted.evidence`, { min: 0 })
      assertInteger(value.deleted.items, `${path}.deleted.items`, { min: 0 })
      assertInteger(value.deleted.revisions, `${path}.deleted.revisions`, { min: 0 })
      break
    case 'processing':
      assertExactObject(value, ['kind', 'memory_processing', 'operation'], [], path)
      if (value.operation !== 'set_processing') fail(`${path}.operation`, 'must equal set_processing')
      assertMemoryProcessing(value.memory_processing, `${path}.memory_processing`)
      break
    default:
      fail(`${path}.kind`, 'is not registered')
  }
}

function assertManageResponse (value, path = 'ManageResponse') {
  assertExactObject(value, ['contract_id', 'contract_version', 'error', 'ok', 'result', 'revision'], [], path)
  assertContractHeader(value, path)
  assertBoolean(value.ok, `${path}.ok`)
  if (value.ok) {
    assertInteger(value.revision, `${path}.revision`, { min: 0 })
    assertManageResult(value.result, `${path}.result`)
    if (value.error !== null) fail(`${path}.error`, 'must be null for success')
  } else {
    if (value.result !== null) fail(`${path}.result`, 'must be null for failure')
    assertPublicError(value.error, `${path}.error`)
    if (value.error.code === ERROR_CODES.revisionConflict) {
      if (value.revision !== value.error.current_revision) {
        fail(`${path}.revision`, 'must equal error.current_revision for conflict')
      }
    } else if (value.revision !== null) {
      fail(`${path}.revision`, 'must be null unless the response is a revision conflict')
    }
  }
  return value
}

function assertChangedEvent (value, path = 'ChangedEvent') {
  assertExactObject(value, ['contract_id', 'contract_version', 'revision'], [], path)
  assertContractHeader(value, path)
  assertInteger(value.revision, `${path}.revision`, { min: 0 })
  return value
}

function assertPending (value, path) {
  assertExactObject(value, ['command_type', 'operation'], [], path)
  assertEnum(value.operation, ['get_overview', 'manage'], `${path}.operation`)
  if (value.operation === 'manage') assertEnum(value.command_type, MANAGE_COMMANDS, `${path}.command_type`)
  else if (value.command_type !== null) fail(`${path}.command_type`, 'must be null for get_overview')
}

function assertFixture (value, path = 'AgentContextUiFixture') {
  assertExactObject(value, [
    'caller_role',
    'contract_id',
    'contract_version',
    'event',
    'fixture_id',
    'j21_evidence',
    'pending',
    'preview_only',
    'request',
    'response',
    'scenario',
    'seam'
  ], [], path)
  assertContractHeader(value, path)
  assertEnum(value.caller_role, CALLER_ROLES, `${path}.caller_role`)
  assertId(value.fixture_id, `${path}.fixture_id`)
  if (value.j21_evidence !== false) fail(`${path}.j21_evidence`, 'must be false')
  if (value.preview_only !== true) fail(`${path}.preview_only`, 'must be true')
  assertEnum(value.scenario, FIXTURE_SCENARIOS, `${path}.scenario`)
  assertEnum(value.seam, Object.values(IPC_CHANNELS), `${path}.seam`)

  if (value.seam === IPC_CHANNELS.changed) {
    if (value.request !== null || value.response !== null || value.pending !== null) {
      fail(path, 'changed fixture must contain only an event')
    }
    assertChangedEvent(value.event, `${path}.event`)
  } else {
    if (value.event !== null) fail(`${path}.event`, 'must be null for invoke fixtures')
    if (value.request === null) fail(`${path}.request`, 'is required for invoke fixtures')
    if ((value.response === null) === (value.pending === null)) {
      fail(path, 'invoke fixture must contain exactly one of response or pending')
    }
    if (value.seam === IPC_CHANNELS.getOverview) {
      assertGetOverviewRequest(value.request, `${path}.request`)
      if (value.response !== null) assertGetOverviewResponse(value.response, `${path}.response`)
    } else {
      assertManageRequest(value.request, `${path}.request`)
      if (value.response !== null) assertManageResponse(value.response, `${path}.response`)
    }
    if (value.pending !== null) assertPending(value.pending, `${path}.pending`)
  }

  const permissionFailure = value.scenario === 'permission_failure'
  const allowedCaller = ALLOWED_ROLES.includes(value.caller_role)
  if (permissionFailure === allowedCaller) {
    fail(`${path}.caller_role`, 'permission_failure requires a denied caller and all other scenarios require an allowed caller')
  }
  return value
}

function assertFixturePrivacy (value, path = 'AgentContextUiFixture') {
  const visit = (current, currentPath) => {
    if (current === null || typeof current !== 'object') {
      if (typeof current === 'string' && FORBIDDEN_PRIVACY_VALUE.test(current)) {
        fail(currentPath, 'privacy violation in string value')
      }
      if (typeof current === 'string' && RFC3339_PATTERN.test(current) && !SYNTHETIC_FIXTURE_TIMESTAMP.test(current)) {
        fail(currentPath, 'privacy violation: fixture timestamps must use the reserved synthetic date')
      }
      return
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${currentPath}[${index}]`))
      return
    }
    for (const [key, child] of Object.entries(current)) {
      if (FORBIDDEN_PRIVACY_KEY.test(key)) fail(`${currentPath}.${key}`, 'privacy violation in field name')
      visit(child, `${currentPath}.${key}`)
    }
  }
  visit(value, path)
  return value
}

module.exports = {
  ALLOWED_ROLES,
  CONTRACT_ID,
  CONTRACT_VERSION,
  ELIGIBILITY_STATES,
  ERROR_CODES,
  ERROR_RULES,
  IPC_CHANNELS,
  MANAGE_COMMANDS,
  MAX_SCOPE_DIRECTORY_ITEMS,
  MEMORY_KINDS,
  PRELOAD_GLOBALS,
  PRELOAD_METHODS,
  SCOPE_KINDS,
  assertChangedEvent,
  assertFixture,
  assertFixturePrivacy,
  assertGetOverviewRequest,
  assertGetOverviewResponse,
  assertManageRequest,
  assertManageResponse,
  isSupportedContract
}
