'use strict'

const { assertRecognitionBinding, assertRecognitionStatus, assertRecognitionMetadata,
  unknownRecognition } = require('../../contracts/recognition')
const { StorageError } = require('./protocol')

const RECOGNITION_SESSION_SQL = `
CREATE TABLE subtitle_recognition_sessions (
  session_id TEXT PRIMARY KEY NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  binding_json TEXT NOT NULL CHECK (json_valid(binding_json)),
  actual_provider TEXT NOT NULL CHECK (actual_provider IN ('local', 'nls')),
  fallback_code TEXT,
  fallback_at_ms INTEGER CHECK (fallback_at_ms >= 0),
  fault_code TEXT,
  fault_at_ms INTEGER CHECK (fault_at_ms >= 0),
  CHECK ((fallback_code IS NULL) = (fallback_at_ms IS NULL)),
  CHECK ((fault_code IS NULL) = (fault_at_ms IS NULL)),
  CHECK (fallback_code IS NULL OR actual_provider = 'local')
) STRICT;
`

function hasRecognitionTable (database) {
  return !!database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='subtitle_recognition_sessions'").get()
}

function canonicalBinding (binding) {
  try { assertRecognitionBinding(binding) } catch { throw new StorageError('INVALID_RECOGNITION_STATUS') }
  const { strategy, provider, region, configRevision, projectRef, modelLabel, parameters } = binding
  return JSON.stringify({ strategy, provider, region, configRevision, projectRef, modelLabel,
    parameters: parameters === null ? null : Object.fromEntries(Object.keys(parameters).sort().map(key => [key, parameters[key]])) })
}

function recognitionMetadata (database, sessionId) {
  const row = hasRecognitionTable(database)
    ? database.prepare('SELECT * FROM subtitle_recognition_sessions WHERE session_id = ?').get(sessionId) : null
  if (!row) return unknownRecognition()
  return assertRecognitionMetadata({ resultStatus: 'known', binding: JSON.parse(row.binding_json),
    actualProvider: row.actual_provider, fallbackCode: row.fallback_code, fallbackAtMs: row.fallback_at_ms,
    faultCode: row.fault_code, faultAtMs: row.fault_at_ms })
}

function openRecognition (database, sessionId, binding, existing) {
  if (!hasRecognitionTable(database)) {
    if (binding !== undefined) throw new StorageError('RECOGNITION_RESULT_UNAVAILABLE')
    return
  }
  const json = binding === undefined ? null : canonicalBinding(binding)
  if (existing) {
    const row = database.prepare('SELECT binding_json FROM subtitle_recognition_sessions WHERE session_id = ?').get(sessionId)
    if ((row?.binding_json ?? null) !== json) throw new StorageError('SESSION_CONFLICT')
  } else if (json !== null) {
    database.prepare('INSERT INTO subtitle_recognition_sessions(session_id, binding_json, actual_provider) VALUES (?, ?, ?)')
      .run(sessionId, json, binding.provider)
  }
}

function recordRecognitionStatus (database, input) {
  try { assertRecognitionStatus(input) } catch { throw new StorageError('INVALID_RECOGNITION_STATUS') }
  const session = database.prepare('SELECT state FROM sessions WHERE session_id = ?').get(input.sessionId)
  if (!session) throw new StorageError('SESSION_NOT_FOUND')
  const current = recognitionMetadata(database, input.sessionId)
  if (current.resultStatus !== 'known') throw new StorageError('RECOGNITION_RESULT_UNAVAILABLE')
  const next = { ...current, actualProvider: input.actualProvider,
    fallbackCode: current.fallbackCode ?? input.fallbackCode, fallbackAtMs: current.fallbackAtMs ?? input.fallbackAtMs,
    faultCode: current.faultCode ?? input.faultCode, faultAtMs: current.faultAtMs ?? input.faultAtMs }
  try { assertRecognitionMetadata(next) } catch { throw new StorageError('INVALID_RECOGNITION_STATUS') }
  if (JSON.stringify(current) === JSON.stringify(next)) return { status: 'already_processed', sessionId: input.sessionId }
  if (session.state !== 'active') throw new StorageError('SESSION_NOT_ACTIVE')
  database.prepare(`UPDATE subtitle_recognition_sessions SET actual_provider = ?, fallback_code = ?,
    fallback_at_ms = ?, fault_code = ?, fault_at_ms = ? WHERE session_id = ?`)
    .run(next.actualProvider, next.fallbackCode, next.fallbackAtMs, next.faultCode, next.faultAtMs, input.sessionId)
  return { status: 'committed', sessionId: input.sessionId }
}

module.exports = { RECOGNITION_SESSION_SQL, recognitionMetadata, openRecognition, recordRecognitionStatus }
