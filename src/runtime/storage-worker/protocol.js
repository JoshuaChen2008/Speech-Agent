'use strict'

// @ts-check

const crypto = require('node:crypto')

const PROTOCOL_VERSION = 1
const OPERATIONS = Object.freeze({
  DB0_QUALIFY: 'db0:qualify',
  INITIALIZE: 'storage:initialize',
  OPEN_SESSION: 'session:open',
  RECORD_REFINEMENT_FAULT: 'refinement:record-fault',
  RECORD_RECOGNITION_STATUS: 'recognition:record-status',
  APPEND_CAPTION: 'caption:append',
  CLOSE_SESSION: 'session:close',
  RECOVER_STALE_SESSIONS: 'session:recover-stale',
  IMPORT_LEGACY_JSONL: 'legacy:import-jsonl',
  GET_SESSION: 'history:get-session',
  GET_SESSION_PAGE: 'history:get-session-page',
  LIST_SESSIONS: 'history:list-sessions',
  GET_STATS: 'storage:get-stats',
  PERSONAL_CONTEXT_INGEST: 'personal-context:ingest',
  PERSONAL_CONTEXT_RESOLVE: 'personal-context:resolve',
  PERSONAL_CONTEXT_MANAGE: 'personal-context:manage',
  PERSONAL_CONTEXT_DELETE_SESSION_DATA: 'personal-context:delete-session-data',
  PERSONAL_CONTEXT_PREPARE_SESSION_INGEST: 'personal-context:prepare-session-ingest',
  PERSONAL_CONTEXT_APPLY_AUTOMATIC_POLICY: 'personal-context:apply-automatic-policy',
  PERSONAL_CONTEXT_CANCEL_SESSION_INGEST: 'personal-context:cancel-session-ingest',
  PERSONAL_CONTEXT_DERIVE_SESSION_SOURCE: 'personal-context:derive-session-source',
  PERSONAL_CONTEXT_READ_SESSION_INPUT: 'personal-context:read-session-input',
  PERSONAL_CONTEXT_READ_TOOL_CONTEXT: 'personal-context:read-tool-context',
  PERSONAL_CONTEXT_COMMIT_SESSION_INGEST: 'personal-context:commit-session-ingest',
  PERSONAL_CONTEXT_PREPARE_INTERACTION_INGEST: 'personal-context:prepare-interaction-ingest',
  PERSONAL_CONTEXT_READ_INTERACTION_INPUT: 'personal-context:read-interaction-input',
  PERSONAL_CONTEXT_COMMIT_INTERACTION_INGEST: 'personal-context:commit-interaction-ingest',
  PERSONAL_CONTEXT_CANCEL_INTERACTION_INGEST: 'personal-context:cancel-interaction-ingest',
  FORMAL_AGENT_CLAIM_RUN: 'formal-agent:claim-run',
  FORMAL_AGENT_NEXT_RUN_AT: 'formal-agent:next-run-at',
  FORMAL_AGENT_COMPLETE_RUN: 'formal-agent:complete-run',
  FORMAL_AGENT_FAIL_RUN: 'formal-agent:fail-run',
  MODEL_ACCESS_CATALOG: 'model-access:catalog',
  MODEL_ACCESS_CONFIGURE: 'model-access:configure',
  MODEL_ACCESS_BIND: 'model-access:bind',
  AGENT_CREATE_INTERACTION: 'agent-execution:create-interaction',
  AGENT_CREATE_RUN: 'agent-execution:create-run',
  AGENT_CANCEL_RUN: 'agent-execution:cancel-run',
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
  SCHEMA_IDENTITY_INVALID: 'Database migration identity is invalid.',
  RETIREMENT_BACKUP_CREATE_FAILED: 'Database backup could not be created. Restart to retry.',
  RETIREMENT_BACKUP_VERIFY_FAILED: 'Database backup could not be verified. Restart to retry.',
  RETIREMENT_MIGRATION_FAILED: 'Database retirement could not be applied. Restart to retry.',
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
  INVALID_RECOGNITION_STATUS: 'Recognition session data is invalid.',
  RECOGNITION_RESULT_UNAVAILABLE: 'Recognition session result is unavailable.',
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
  AGENT_SUMMARY_MEMORY_READ_FAILED: 'Summary memory could not be read.',
  AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED: 'Summary input exceeded the legacy limit.',
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

function makeRecognitionStatusKey (input) {
  return `recognition-status-v1-${digestParts([input?.sessionId, input?.actualProvider,
    input?.fallbackCode, input?.fallbackAtMs, input?.faultCode, input?.faultAtMs])}`
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
  makeRecognitionStatusKey,
  publicError
}
