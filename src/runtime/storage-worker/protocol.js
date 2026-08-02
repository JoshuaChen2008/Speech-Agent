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
