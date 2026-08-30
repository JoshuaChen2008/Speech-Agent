'use strict'

// @ts-check

const crypto = require('node:crypto')

const PROTOCOL_VERSION = 1
const OPERATIONS = Object.freeze({
  DB0_QUALIFY: 'db0:qualify',
  INITIALIZE: 'storage:initialize',
  OPEN_SESSION: 'session:open',
  RECORD_REFINEMENT_FAULT: 'refinement:record-fault',
  APPEND_CAPTION: 'caption:append',
  CLOSE_SESSION: 'session:close',
  RECOVER_STALE_SESSIONS: 'session:recover-stale',
  IMPORT_LEGACY_JSONL: 'legacy:import-jsonl',
  GET_SESSION: 'history:get-session',
  GET_SESSION_PAGE: 'history:get-session-page',
  LIST_SESSIONS: 'history:list-sessions',
  GET_STATS: 'storage:get-stats',
  AGENT_EVALUATE_ELIGIBILITY: 'agent:evaluate-eligibility',
  AGENT_RECONCILE_TERMINAL_SESSION: 'agent:reconcile-terminal-session',
  AGENT_READ_INPUT_SNAPSHOT: 'agent:read-input-snapshot',
  AGENT_REQUEST_JOB: 'agent:request-job',
  AGENT_CLAIM_NEXT_JOB: 'agent:claim-next-job',
  AGENT_RENEW_JOB_LEASE: 'agent:renew-job-lease',
  AGENT_MARK_JOB_RETRY: 'agent:mark-job-retry',
  AGENT_MARK_JOB_FAILED: 'agent:mark-job-failed',
  AGENT_REQUEST_CANCEL: 'agent:request-cancel',
  AGENT_MARK_JOB_CANCELLED: 'agent:mark-job-cancelled',
  AGENT_COMMIT_ARTIFACT: 'agent:commit-artifact',
  AGENT_COMMIT_MEMORY_CANDIDATES: 'agent:commit-memory-candidates',
  AGENT_READ_MEMORY_CONTEXT: 'agent:read-memory-context',
  AGENT_DELETE_MEMORY_ITEM: 'agent:delete-memory-item',
  AGENT_APPLY_TASK_POLICY: 'agent:apply-task-policy',
  AGENT_GET_SESSION_DETAIL: 'agent:get-session-detail',
  AGENT_DELETE_SESSION_DATA: 'agent:delete-session-data',
  PERSONAL_CONTEXT_INGEST: 'personal-context:ingest',
  PERSONAL_CONTEXT_RESOLVE: 'personal-context:resolve',
  PERSONAL_CONTEXT_MANAGE: 'personal-context:manage',
  PERSONAL_CONTEXT_DELETE_SESSION_DATA: 'personal-context:delete-session-data',
  FORMAL_AGENT_CLAIM_RUN: 'formal-agent:claim-run',
  FORMAL_AGENT_NEXT_RUN_AT: 'formal-agent:next-run-at',
  FORMAL_AGENT_COMPLETE_RUN: 'formal-agent:complete-run',
  FORMAL_AGENT_FAIL_RUN: 'formal-agent:fail-run',
  MODEL_ACCESS_CATALOG: 'model-access:catalog',
  MODEL_ACCESS_CONFIGURE: 'model-access:configure',
  MODEL_ACCESS_BIND: 'model-access:bind',
  AGENT_CREATE_INTERACTION: 'agent-execution:create-interaction',
  AGENT_TERMINALIZE_INTERACTION: 'agent-execution:terminalize-interaction',
  AGENT_START_TOOL_CALL: 'agent-execution:start-tool-call',
  AGENT_FINISH_TOOL_CALL: 'agent-execution:finish-tool-call',
  AGENT_CREATE_PRESENTATION: 'agent-execution:create-presentation',
  AGENT_MARK_PRESENTATION: 'agent-execution:mark-presentation',
  AGENT_LIST_INTERACTIONS: 'agent-execution:list-interactions',
  AGENT_GET_INTERACTION: 'agent-execution:get-interaction',
  SHUTDOWN: 'storage:shutdown'
})

const SAFE_ERROR_MESSAGES = Object.freeze({
  INVALID_REQUEST: 'Storage request is invalid.',
  UNSUPPORTED_OPERATION: 'Storage operation is not supported.',
  NOT_INITIALIZED: 'Storage is not initialized.',
  ALREADY_INITIALIZED: 'Storage is already initialized.',
  SHUTTING_DOWN: 'Storage is shutting down.',
  STORAGE_UNAVAILABLE: 'Storage is unavailable.',
  STORAGE_QUEUE_FULL: 'Storage queue is full.',
  IDEMPOTENCY_KEY_MISMATCH: 'Storage idempotency key is invalid.',
  INVALID_SESSION: 'Session data is invalid.',
  SESSION_NOT_FOUND: 'Session was not found.',
  SESSION_CONFLICT: 'Session identity conflicts with persisted data.',
  ACTIVE_SESSION_EXISTS: 'Another subtitle session is active.',
  SESSION_ACTIVE: 'Session is still active.',
  SESSION_NOT_ACTIVE: 'Session is not active.',
  REFINEMENT_RESULT_UNAVAILABLE: 'Refinement session result is unavailable.',
  REFINEMENT_RESULT_CONFLICT: 'Refinement session result conflicts with persisted data.',
  INVALID_REFINEMENT_FAULT: 'Refinement fault data is invalid.',
  INVALID_CAPTION: 'Caption data is invalid.',
  UNSUPPORTED_CAPTION_KIND: 'Only final and refined captions can be persisted.',
  REFINEMENT_DISABLED: 'Refined captions are disabled for this session.',
  EVENT_IDENTITY_CONFLICT: 'Caption identity conflicts with persisted data.',
  MISSING_BASE_SEGMENT: 'A refined caption cannot create a segment.',
  INVALID_LEGACY_IMPORT: 'Legacy transcript import data is invalid.',
  AGENT_REQUEST_INVALID: 'Agent request is invalid.',
  AGENT_SESSION_NOT_FOUND: 'Agent session was not found.',
  AGENT_SESSION_NOT_TERMINAL: 'Agent session is not terminal.',
  AGENT_INPUT_EMPTY: 'Agent input has no committed transcript.',
  AGENT_INPUT_VERSION_UNAVAILABLE: 'Agent input version is unavailable.',
  AGENT_INPUT_CHANGED: 'Agent input identity has changed.',
  AGENT_OUTPUT_INVALID: 'Agent output is invalid.',
  AGENT_RUN_NOT_FOUND: 'Agent run was not found.',
  AGENT_SESSION_DELETED: 'The session has been deleted.',
  AGENT_INTERACTION_NOT_FOUND: 'Agent interaction was not found.',
  AGENT_INTERACTION_STATE_CONFLICT: 'Agent interaction state conflicts with the request.',
  AGENT_TOOL_NOT_FOUND: 'Agent tool call was not found.',
  AGENT_TOOL_STATE_CONFLICT: 'Agent tool call state conflicts with the request.',
  AGENT_PRESENTATION_NOT_FOUND: 'Agent presentation was not found.',
  AGENT_PRESENTATION_STATE_CONFLICT: 'Agent presentation state conflicts with the request.',
  AGENT_EXECUTION_UNAVAILABLE: 'Agent execution storage is unavailable.',
  TOOL_ARGS_INVALID: 'Agent tool arguments are invalid.',
  TOOL_SCOPE_DENIED: 'Agent tool scope is denied.',
  TOOL_NOT_AVAILABLE_FOR_RECIPE: 'The tool is not available for this recipe.',
  TOOL_BUDGET_EXCEEDED: 'The agent tool budget was exceeded.',
  TOOL_TIMEOUT: 'The agent tool timed out.',
  TOOL_CANCELLED: 'The agent tool was cancelled.',
  TOOL_INTERNAL_FAILURE: 'The agent tool failed.',
  AGENT_JOB_NOT_FOUND: 'Agent job was not found.',
  AGENT_JOB_STATE_CONFLICT: 'Agent job state conflicts with the request.',
  AGENT_CONTEXT_REVISION_CONFLICT: 'Personal context revision conflicts with the request.',
  AGENT_CONTEXT_NOT_FOUND: 'Personal context item was not found.',
  AGENT_CONTEXT_OPERATION_FAILED: 'Personal context operation failed.',
  MODEL_CONFIG_INVALID: 'Agent model configuration is invalid.',
  MODEL_CONFIG_REVISION_CONFLICT: 'Agent model configuration revision conflicts with the request.',
  MODEL_ACCESS_UNAVAILABLE: 'Agent model access is unavailable.',
  STORAGE_COMMAND_FAILED: 'Storage command failed.'
})

const LEGACY_IMPORT_KEYS = Object.freeze([
  'sourceSha256',
  'sourceName',
  'importedAt',
  'sourceRecordCount',
  'captionEventCount',
  'translatedEventCount',
  'corruptLineCount',
  'truncatedTail',
  'session',
  'captions'
])

class StorageError extends Error {
  constructor (code) {
    super(SAFE_ERROR_MESSAGES[code] || SAFE_ERROR_MESSAGES.STORAGE_COMMAND_FAILED)
    this.name = 'StorageError'
    this.code = SAFE_ERROR_MESSAGES[code] ? code : 'STORAGE_COMMAND_FAILED'
  }
}

function isPlainObject (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function assertExactKeys (value, allowed, code = 'INVALID_REQUEST') {
  if (!isPlainObject(value)) throw new StorageError(code)
  const allowlist = new Set(allowed)
  if (Object.keys(value).some((key) => !allowlist.has(key))) throw new StorageError(code)
  return value
}

function assertRequestEnvelope (message) {
  assertExactKeys(message, ['version', 'type', 'requestId', 'operation', 'payload', 'idempotencyKey'])
  if (message.version !== PROTOCOL_VERSION || message.type !== 'storage:request' ||
      typeof message.requestId !== 'string' || message.requestId.length < 1 || message.requestId.length > 128 ||
      typeof message.operation !== 'string' || message.operation.length < 1 || message.operation.length > 80 ||
      !isPlainObject(message.payload)) {
    throw new StorageError('INVALID_REQUEST')
  }
  if (message.idempotencyKey !== undefined &&
      (typeof message.idempotencyKey !== 'string' || message.idempotencyKey.length < 1 || message.idempotencyKey.length > 160)) {
    throw new StorageError('INVALID_REQUEST')
  }
  return message
}

function digestParts (parts) {
  return crypto.createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex')
}

function makeCaptionEventId (event) {
  return `cap-v1-${digestParts([event.sessionId, event.sourceId, event.sequence])}`
}

function makeOpenSessionKey (sessionId) {
  return `open-v1-${digestParts([sessionId])}`
}

function makeCloseSessionKey (sessionId) {
  return `close-v1-${digestParts([sessionId])}`
}

function makeRefinementFaultKey (sessionId, faultCode) {
  return `refinement-fault-v1-${digestParts([sessionId, faultCode])}`
}

function makeLegacyImportKey (sourceSha256) {
  return `legacy-v1-${digestParts([sourceSha256])}`
}

function assertIdempotencyKey (actual, expected) {
  if (actual !== expected) throw new StorageError('IDEMPOTENCY_KEY_MISMATCH')
}

function publicError (error) {
  if (error instanceof StorageError) return { code: error.code, message: error.message }
  if (error?.code === 'MODEL_CONFIG_INVALID' || error?.code === 'MODEL_CONFIG_REVISION_CONFLICT') {
    return { code: error.code, message: SAFE_ERROR_MESSAGES[error.code] }
  }
  return { code: 'STORAGE_COMMAND_FAILED', message: SAFE_ERROR_MESSAGES.STORAGE_COMMAND_FAILED }
}

module.exports = {
  OPERATIONS,
  LEGACY_IMPORT_KEYS,
  PROTOCOL_VERSION,
  SAFE_ERROR_MESSAGES,
  StorageError,
  assertExactKeys,
  assertIdempotencyKey,
  assertRequestEnvelope,
  isPlainObject,
  makeCaptionEventId,
  makeCloseSessionKey,
  makeLegacyImportKey,
  makeOpenSessionKey,
  makeRefinementFaultKey,
  publicError
}
