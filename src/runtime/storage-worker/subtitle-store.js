'use strict'

// @ts-check

/* 字幕事实的唯一 SQLite 写入实现。所有公开写方法都使用短事务；调用方
   不能提供 SQL、数据库路径或 migration。 */

const { assertCaptionEvent } = require('../../contracts')
const { openSubtitleDatabase, rollbackQuietly, scalar } = require('./sqlite-store')
const { StorageError, assertExactKeys, makeCaptionEventId } = require('./protocol')

const MODE_BY_SOURCE = Object.freeze({ loopback: 'meeting', mic: 'dictation' })
const PERSISTED_CAPTION_KINDS = Object.freeze(['final', 'refined'])
const CAPTION_EVENT_KEYS = Object.freeze([
  'schemaVersion',
  'sessionId',
  'sourceId',
  'segmentId',
  'sequence',
  'revision',
  'kind',
  't0',
  't1',
  'text',
  'translation'
])

function integerTimestamp (value, code = 'INVALID_SESSION') {
  if (!Number.isSafeInteger(value) || value < 0) throw new StorageError(code)
  return value
}

function sessionIdValue (value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160) {
    throw new StorageError('INVALID_SESSION')
  }
  return value
}

function sourceValue (value, code = 'INVALID_SESSION') {
  if (!Object.hasOwn(MODE_BY_SOURCE, value)) throw new StorageError(code)
  return value
}

function persistedEvent (event) {
  assertExactKeys(event, CAPTION_EVENT_KEYS, 'INVALID_CAPTION')
  try { assertCaptionEvent(event) } catch { throw new StorageError('INVALID_CAPTION') }
  if (!PERSISTED_CAPTION_KINDS.includes(event.kind)) {
    throw new StorageError('UNSUPPORTED_CAPTION_KIND')
  }
  const t0Ms = Math.round(event.t0 * 1000)
  const t1Ms = Math.round(event.t1 * 1000)
  if (!Number.isSafeInteger(t0Ms) || !Number.isSafeInteger(t1Ms)) {
    throw new StorageError('INVALID_CAPTION')
  }
  return {
    eventId: makeCaptionEventId(event),
    sessionId: event.sessionId,
    sourceId: event.sourceId,
    segmentId: event.segmentId,
    sequence: event.sequence,
    revision: event.revision,
    kind: event.kind,
    t0Ms,
    t1Ms,
    text: event.text
  }
}

function sameEvent (row, event) {
  return row.event_id === event.eventId &&
    row.session_id === event.sessionId &&
    row.source_id === event.sourceId &&
    row.segment_id === event.segmentId &&
    Number(row.sequence) === event.sequence &&
    Number(row.revision) === event.revision &&
    row.kind === event.kind &&
    Number(row.t0_ms) === event.t0Ms &&
    Number(row.t1_ms) === event.t1Ms &&
    row.text === event.text
}

class SqliteSubtitleStore {
  constructor (options = {}) {
    this.database = openSubtitleDatabase(options.databasePath, options)
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.faultInjector = typeof options.faultInjector === 'function' ? options.faultInjector : () => {}
    this.closed = false
  }

  assertOpen () {
    if (this.closed) throw new StorageError('SHUTTING_DOWN')
  }

  inject (point) {
    this.faultInjector(point)
  }

  openSession (input) {
    this.assertOpen()
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some((key) => !['sessionId', 'sourceId', 'startedAt'].includes(key))) {
      throw new StorageError('INVALID_SESSION')
    }
    const sessionId = sessionIdValue(input.sessionId)
    const sourceId = sourceValue(input.sourceId)
    const mode = MODE_BY_SOURCE[sourceId]
    const startedAt = integerTimestamp(input.startedAt)
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      const existing = database.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId)
      if (existing) {
        if (existing.source_id === sourceId && existing.mode === mode &&
            Number(existing.started_at) === startedAt && existing.ended_at === null &&
            existing.state === 'active') {
          database.exec('COMMIT')
          return { status: 'already_processed', sessionId, sourceId }
        }
        throw new StorageError('SESSION_CONFLICT')
      }
      const active = database.prepare("SELECT session_id FROM sessions WHERE state = 'active' LIMIT 1").get()
      if (active) throw new StorageError('ACTIVE_SESSION_EXISTS')
      database.prepare(`
        INSERT INTO sessions(session_id, mode, source_id, started_at, ended_at, state)
        VALUES (?, ?, ?, ?, NULL, 'active')
      `).run(sessionId, mode, sourceId, startedAt)
      database.exec('COMMIT')
      return { status: 'committed', sessionId, sourceId }
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }

  appendCaption (input) {
    this.assertOpen()
    const event = persistedEvent(input)
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    let result
    try {
      const identityRows = database.prepare(`
        SELECT * FROM caption_events
        WHERE event_id = ?
           OR (session_id = ? AND source_id = ? AND sequence = ?)
           OR (session_id = ? AND source_id = ? AND segment_id = ? AND revision = ?)
      `).all(
        event.eventId,
        event.sessionId, event.sourceId, event.sequence,
        event.sessionId, event.sourceId, event.segmentId, event.revision
      )
      if (identityRows.length > 0) {
        if (identityRows.length === 1 && sameEvent(identityRows[0], event)) {
          database.exec('COMMIT')
          return {
            status: 'already_processed',
            eventOrder: Number(identityRows[0].event_order),
            projectionUpdated: false
          }
        }
        throw new StorageError('EVENT_IDENTITY_CONFLICT')
      }

      const session = database.prepare(`
        SELECT source_id, state FROM sessions WHERE session_id = ?
      `).get(event.sessionId)
      if (!session) throw new StorageError('SESSION_NOT_FOUND')
      if (session.source_id !== event.sourceId) throw new StorageError('SESSION_CONFLICT')
      if (session.state !== 'active') throw new StorageError('SESSION_NOT_ACTIVE')

      const current = database.prepare(`
        SELECT * FROM segments
        WHERE session_id = ? AND source_id = ? AND segment_id = ?
      `).get(event.sessionId, event.sourceId, event.segmentId)
      if (!current && event.kind === 'refined') throw new StorageError('MISSING_BASE_SEGMENT')

      const inserted = database.prepare(`
        INSERT INTO caption_events(
          event_id, session_id, source_id, segment_id, sequence, revision,
          kind, t0_ms, t1_ms, text, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.eventId, event.sessionId, event.sourceId, event.segmentId,
        event.sequence, event.revision, event.kind, event.t0Ms, event.t1Ms,
        event.text, integerTimestamp(this.now(), 'STORAGE_COMMAND_FAILED')
      )
      const eventOrder = Number(inserted.lastInsertRowid)
      this.inject('afterEventInsert')

      let projectionUpdated = false
      if (!current) {
        database.prepare(`
          INSERT INTO segments(
            session_id, source_id, segment_id, text, text_revision,
            t0_ms, t1_ms, first_event_order, updated_event_order
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          event.sessionId, event.sourceId, event.segmentId, event.text, event.revision,
          event.t0Ms, event.t1Ms, eventOrder, eventOrder
        )
        projectionUpdated = true
      } else if (event.revision > Number(current.text_revision)) {
        database.prepare(`
          UPDATE segments SET
            text = ?, text_revision = ?, t0_ms = ?, t1_ms = ?, updated_event_order = ?
          WHERE id = ?
        `).run(event.text, event.revision, event.t0Ms, event.t1Ms, eventOrder, current.id)
        projectionUpdated = true
      }
      this.inject('afterProjection')
      database.exec('COMMIT')
      result = { status: 'committed', eventOrder, projectionUpdated }
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
    this.inject('afterCommitBeforeReturn')
    return result
  }

  closeSession (input) {
    this.assertOpen()
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some((key) => !['sessionId', 'sourceId', 'endedAt', 'state'].includes(key))) {
      throw new StorageError('INVALID_SESSION')
    }
    const sessionId = sessionIdValue(input.sessionId)
    const sourceId = sourceValue(input.sourceId)
    const endedAt = integerTimestamp(input.endedAt)
    const state = input.state === undefined ? 'closed' : input.state
    if (!['closed', 'interrupted'].includes(state)) throw new StorageError('INVALID_SESSION')
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      const existing = database.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId)
      if (!existing) throw new StorageError('SESSION_NOT_FOUND')
      if (existing.source_id !== sourceId) throw new StorageError('SESSION_CONFLICT')
      if (existing.state !== 'active') {
        if (existing.state === state && Number(existing.ended_at) === endedAt) {
          database.exec('COMMIT')
          return { status: 'already_processed', sessionId, sourceId, state }
        }
        throw new StorageError('SESSION_CONFLICT')
      }
      if (endedAt < Number(existing.started_at)) throw new StorageError('INVALID_SESSION')
      database.prepare(`
        UPDATE sessions SET ended_at = ?, state = ?
        WHERE session_id = ? AND source_id = ? AND state = 'active'
      `).run(endedAt, state, sessionId, sourceId)
      database.exec('COMMIT')
      return { status: 'committed', sessionId, sourceId, state }
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }

  getSessionTranscript (input) {
    this.assertOpen()
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some((key) => !['sessionId'].includes(key))) {
      throw new StorageError('INVALID_SESSION')
    }
    const sessionId = sessionIdValue(input.sessionId)
    const session = this.database.prepare(`
      SELECT session_id, mode, source_id, started_at, ended_at, state
      FROM sessions WHERE session_id = ?
    `).get(sessionId)
    if (!session) throw new StorageError('SESSION_NOT_FOUND')
    const segments = this.database.prepare(`
      SELECT segment_id, source_id, text, text_revision, t0_ms, t1_ms,
             first_event_order, updated_event_order
      FROM segments
      WHERE session_id = ?
      ORDER BY t0_ms, first_event_order, id
    `).all(sessionId).map((row) => ({
      segmentId: row.segment_id,
      sourceId: row.source_id,
      text: row.text,
      textRevision: Number(row.text_revision),
      t0Ms: Number(row.t0_ms),
      t1Ms: Number(row.t1_ms),
      firstEventOrder: Number(row.first_event_order),
      updatedEventOrder: Number(row.updated_event_order)
    }))
    return {
      session: {
        sessionId: session.session_id,
        mode: session.mode,
        sourceId: session.source_id,
        startedAt: Number(session.started_at),
        endedAt: session.ended_at === null ? null : Number(session.ended_at),
        state: session.state
      },
      segments
    }
  }

  getStats () {
    this.assertOpen()
    return {
      sessions: Number(scalar(this.database, 'SELECT COUNT(*) FROM sessions')),
      activeSessions: Number(scalar(this.database, "SELECT COUNT(*) FROM sessions WHERE state = 'active'")),
      captionEvents: Number(scalar(this.database, 'SELECT COUNT(*) FROM caption_events')),
      segments: Number(scalar(this.database, 'SELECT COUNT(*) FROM segments')),
      legacyImports: Number(scalar(this.database, 'SELECT COUNT(*) FROM legacy_imports')),
      journalMode: String(scalar(this.database, 'PRAGMA journal_mode')).toLowerCase(),
      integrity: String(scalar(this.database, 'PRAGMA integrity_check'))
    }
  }

  close () {
    if (this.closed) return
    this.closed = true
    try { this.database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').all() } catch { /* best effort */ }
    this.database.close()
  }
}

module.exports = {
  CAPTION_EVENT_KEYS,
  MODE_BY_SOURCE,
  PERSISTED_CAPTION_KINDS,
  SqliteSubtitleStore,
  persistedEvent,
  sameEvent
}
