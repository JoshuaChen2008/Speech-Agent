'use strict'

// @ts-check

/* 字幕事实的唯一 SQLite 写入实现。所有公开写方法都使用短事务；调用方
   不能提供 SQL、数据库路径或 migration。 */

const { assertCaptionEvent } = require('../../contracts')
const { openSubtitleDatabase, rollbackQuietly, scalar } = require('./sqlite-store')
const {
  LEGACY_IMPORT_KEYS,
  StorageError,
  assertExactKeys,
  makeCaptionEventId
} = require('./protocol')

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

const LEGACY_SESSION_KEYS = Object.freeze(['sessionId', 'sourceId', 'startedAt', 'endedAt', 'state'])

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

function nonNegativeInteger (value, code = 'INVALID_LEGACY_IMPORT') {
  if (!Number.isSafeInteger(value) || value < 0) throw new StorageError(code)
  return value
}

function positiveInteger (value, code = 'INVALID_SESSION') {
  if (!Number.isSafeInteger(value) || value < 1) throw new StorageError(code)
  return value
}

function legacySourceName (value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 240 ||
      value === '.' || value === '..' || /[\\/\0]/.test(value)) {
    throw new StorageError('INVALID_LEGACY_IMPORT')
  }
  return value
}

function legacySession (value) {
  if (value === null) return null
  try {
    assertExactKeys(value, LEGACY_SESSION_KEYS, 'INVALID_LEGACY_IMPORT')
    const sessionId = sessionIdValue(value.sessionId)
    const sourceId = sourceValue(value.sourceId, 'INVALID_LEGACY_IMPORT')
    const startedAt = nonNegativeInteger(value.startedAt)
    const endedAt = nonNegativeInteger(value.endedAt)
    if (endedAt < startedAt || !['closed', 'interrupted'].includes(value.state)) {
      throw new StorageError('INVALID_LEGACY_IMPORT')
    }
    return { sessionId, sourceId, startedAt, endedAt, state: value.state }
  } catch (error) {
    if (error instanceof StorageError && error.code === 'INVALID_LEGACY_IMPORT') throw error
    throw new StorageError('INVALID_LEGACY_IMPORT')
  }
}

function legacyImport (input) {
  assertExactKeys(input, LEGACY_IMPORT_KEYS, 'INVALID_LEGACY_IMPORT')
  if (typeof input.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(input.sourceSha256) ||
      !Number.isSafeInteger(input.importedAt) || input.importedAt < 0 ||
      !Number.isSafeInteger(input.sourceRecordCount) || input.sourceRecordCount < 0 ||
      !Number.isSafeInteger(input.captionEventCount) || input.captionEventCount < 0 ||
      !Number.isSafeInteger(input.translatedEventCount) || input.translatedEventCount < 0 ||
      !Number.isSafeInteger(input.corruptLineCount) || input.corruptLineCount < 0 ||
      typeof input.truncatedTail !== 'boolean' || !Array.isArray(input.captions)) {
    throw new StorageError('INVALID_LEGACY_IMPORT')
  }
  const sourceName = legacySourceName(input.sourceName)
  const session = legacySession(input.session)
  const captions = input.captions.map((event) => persistedEvent(event))
  if (input.translatedEventCount > input.sourceRecordCount ||
      input.captionEventCount !== captions.length || captions.length > input.sourceRecordCount) {
    throw new StorageError('INVALID_LEGACY_IMPORT')
  }
  if (!session && captions.length > 0) throw new StorageError('INVALID_LEGACY_IMPORT')
  if (session && captions.some((event) => event.sessionId !== session.sessionId || event.sourceId !== session.sourceId)) {
    throw new StorageError('INVALID_LEGACY_IMPORT')
  }
  return {
    sourceSha256: input.sourceSha256,
    sourceName,
    importedAt: input.importedAt,
    sourceRecordCount: input.sourceRecordCount,
    captionEventCount: input.captionEventCount,
    translatedEventCount: input.translatedEventCount,
    corruptLineCount: input.corruptLineCount,
    truncatedTail: input.truncatedTail,
    session,
    captions
  }
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

  /* 冷启动时，唯一进程锁确认本次没有并行产品实例后，上一进程遗留的
     active 会话只能来自未完成退出。一次短事务将其收束为 interrupted；
     字幕事实保持不可变，ended_at 在系统时钟回拨时也不会早于 started_at。 */
  recoverStaleSessions (input) {
    this.assertOpen()
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).length !== 1 || !Object.hasOwn(input, 'recoveredAt')) {
      throw new StorageError('INVALID_SESSION')
    }
    const recoveredAt = integerTimestamp(input.recoveredAt)
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      const active = database.prepare(`
        SELECT session_id, started_at
        FROM sessions
        WHERE state = 'active'
        ORDER BY started_at, session_id
      `).all()
      if (active.length > 0) {
        database.prepare(`
          UPDATE sessions
          SET ended_at = CASE WHEN started_at > ? THEN started_at ELSE ? END,
              state = 'interrupted'
          WHERE state = 'active'
        `).run(recoveredAt, recoveredAt)
      }
      this.inject('afterStaleRecovery')
      database.exec('COMMIT')
      return {
        status: active.length > 0 ? 'committed' : 'none',
        recoveredSessionCount: active.length
      }
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }

  /* 单个旧 JSONL 的所有副作用（session、事实、投影、导入审计）共用一个短
     事务。source_sha256 是迁移幂等键；失败/中断时审计行也会回滚，重跑从头
     开始，提交后重跑只返回 already_processed。 */
  importLegacyJsonl (input) {
    this.assertOpen()
    const legacy = legacyImport(input)
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      const prior = database.prepare(`
        SELECT source_path, event_count, segment_count, result
        FROM legacy_imports WHERE source_sha256 = ?
      `).get(legacy.sourceSha256)
      if (prior) {
        database.exec('COMMIT')
        return {
          status: 'already_processed',
          sourceName: prior.source_path,
          sourceSha256: legacy.sourceSha256,
          captionEventCount: Number(prior.event_count),
          segmentCount: Number(prior.segment_count),
          result: prior.result
        }
      }

      const active = database.prepare("SELECT session_id FROM sessions WHERE state = 'active' LIMIT 1").get()
      if (active) throw new StorageError('ACTIVE_SESSION_EXISTS')

      if (!legacy.session) {
        database.prepare(`
          INSERT INTO legacy_imports(
            source_sha256, source_path, imported_at, event_count, segment_count, result
          ) VALUES (?, ?, ?, ?, 0, 'skipped')
        `).run(legacy.sourceSha256, legacy.sourceName, legacy.importedAt, legacy.captionEventCount)
        database.exec('COMMIT')
        return {
          status: 'skipped',
          sourceName: legacy.sourceName,
          sourceSha256: legacy.sourceSha256,
          captionEventCount: legacy.captionEventCount,
          segmentCount: 0,
          result: 'skipped'
        }
      }

      const session = legacy.session
      const existing = database.prepare('SELECT session_id FROM sessions WHERE session_id = ?').get(session.sessionId)
      if (existing) throw new StorageError('SESSION_CONFLICT')
      database.prepare(`
        INSERT INTO sessions(session_id, mode, source_id, started_at, ended_at, state)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        session.sessionId, MODE_BY_SOURCE[session.sourceId], session.sourceId,
        session.startedAt, session.endedAt, session.state
      )
      this.inject('legacyAfterSession')

      const seenEventIds = new Set()
      const seenSequences = new Set()
      const seenRevisions = new Set()
      for (const event of legacy.captions) {
        const sequenceKey = `${event.sessionId}\u0000${event.sourceId}\u0000${event.sequence}`
        const revisionKey = `${event.sessionId}\u0000${event.sourceId}\u0000${event.segmentId}\u0000${event.revision}`
        if (seenEventIds.has(event.eventId) || seenSequences.has(sequenceKey) || seenRevisions.has(revisionKey)) {
          throw new StorageError('EVENT_IDENTITY_CONFLICT')
        }
        seenEventIds.add(event.eventId)
        seenSequences.add(sequenceKey)
        seenRevisions.add(revisionKey)

        const current = database.prepare(`
          SELECT id, text_revision FROM segments
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
          event.text, legacy.importedAt
        )
        const eventOrder = Number(inserted.lastInsertRowid)
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
        } else if (event.revision > Number(current.text_revision)) {
          database.prepare(`
            UPDATE segments SET
              text = ?, text_revision = ?, t0_ms = ?, t1_ms = ?, updated_event_order = ?
            WHERE id = ?
          `).run(event.text, event.revision, event.t0Ms, event.t1Ms, eventOrder, current.id)
        }
        this.inject('legacyAfterCaption')
      }

      const segmentCount = Number(database.prepare(
        'SELECT COUNT(*) AS count FROM segments WHERE session_id = ?'
      ).get(session.sessionId).count)
      this.inject('legacyBeforeAudit')
      database.prepare(`
        INSERT INTO legacy_imports(
          source_sha256, source_path, imported_at, event_count, segment_count, result
        ) VALUES (?, ?, ?, ?, ?, 'imported')
      `).run(
        legacy.sourceSha256, legacy.sourceName, legacy.importedAt,
        legacy.captionEventCount, segmentCount
      )
      database.exec('COMMIT')
      return {
        status: 'imported',
        sourceName: legacy.sourceName,
        sourceSha256: legacy.sourceSha256,
        captionEventCount: legacy.captionEventCount,
        translatedEventCount: legacy.translatedEventCount,
        segmentCount,
        state: session.state,
        result: 'imported'
      }
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

  /* 终态会话不能再接受新事实，因此 session/count/page 三次只读查询不会发生
     投影漂移；游标顺序与 segments_session_timeline 索引完全一致。 */
  getSessionPage (input) {
    this.assertOpen()
    assertExactKeys(input, ['sessionId', 'limit', 'cursor'], 'INVALID_SESSION')
    const sessionId = sessionIdValue(input.sessionId)
    const limit = positiveInteger(input.limit)
    if (limit > 100) throw new StorageError('INVALID_SESSION')

    let cursor = null
    if (input.cursor !== null) {
      assertExactKeys(input.cursor, ['t0Ms', 'firstEventOrder'], 'INVALID_SESSION')
      cursor = {
        t0Ms: integerTimestamp(input.cursor.t0Ms),
        firstEventOrder: positiveInteger(input.cursor.firstEventOrder)
      }
    }

    const session = this.database.prepare(`
      SELECT session_id, mode, source_id, started_at, ended_at, state
      FROM sessions WHERE session_id = ?
    `).get(sessionId)
    if (!session) throw new StorageError('SESSION_NOT_FOUND')
    if (!['closed', 'interrupted'].includes(session.state)) {
      throw new StorageError('SESSION_ACTIVE')
    }

    const params = [sessionId]
    let afterCursor = ''
    if (cursor) {
      afterCursor = `
        AND (t0_ms > ? OR (t0_ms = ? AND first_event_order > ?))
      `
      params.push(cursor.t0Ms, cursor.t0Ms, cursor.firstEventOrder)
    }
    params.push(limit + 1)
    const rows = this.database.prepare(`
      SELECT segment_id, source_id, text, text_revision, t0_ms, t1_ms,
             first_event_order
      FROM segments
      WHERE session_id = ?
      ${afterCursor}
      ORDER BY t0_ms, first_event_order
      LIMIT ?
    `).all(...params)
    const hasMore = rows.length > limit
    const pageRows = rows.slice(0, limit)
    const items = pageRows.map((row) => ({
      segmentId: row.segment_id,
      sourceId: row.source_id,
      text: row.text,
      textRevision: Number(row.text_revision),
      t0Ms: Number(row.t0_ms),
      t1Ms: Number(row.t1_ms)
    }))
    const last = pageRows.at(-1)
    return {
      session: {
        sessionId: session.session_id,
        mode: session.mode,
        sourceId: session.source_id,
        startedAt: Number(session.started_at),
        endedAt: Number(session.ended_at),
        state: session.state
      },
      totalCount: Number(this.database.prepare(
        'SELECT COUNT(*) AS count FROM segments WHERE session_id = ?'
      ).get(sessionId).count),
      items,
      nextCursor: hasMore
        ? { t0Ms: Number(last.t0_ms), firstEventOrder: Number(last.first_event_order) }
        : null
    }
  }

  listSessions (input) {
    this.assertOpen()
    assertExactKeys(input, ['limit', 'cursor'], 'INVALID_SESSION')
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
      throw new StorageError('INVALID_SESSION')
    }

    let cursor = null
    if (input.cursor !== null) {
      assertExactKeys(input.cursor, ['startedAt', 'sessionId'], 'INVALID_SESSION')
      cursor = {
        startedAt: integerTimestamp(input.cursor.startedAt),
        sessionId: sessionIdValue(input.cursor.sessionId)
      }
    }

    const params = []
    let afterCursor = ''
    if (cursor) {
      afterCursor = `
        AND (s.started_at < ? OR (s.started_at = ? AND s.session_id < ?))
      `
      params.push(cursor.startedAt, cursor.startedAt, cursor.sessionId)
    }
    params.push(input.limit + 1)
    const rows = this.database.prepare(`
      SELECT s.session_id, s.mode, s.source_id, s.started_at, s.ended_at, s.state,
             COUNT(seg.id) AS segment_count
      FROM sessions AS s
      LEFT JOIN segments AS seg ON seg.session_id = s.session_id
      WHERE s.state IN ('closed', 'interrupted')
      ${afterCursor}
      GROUP BY s.session_id, s.mode, s.source_id, s.started_at, s.ended_at, s.state
      ORDER BY s.started_at DESC, s.session_id DESC
      LIMIT ?
    `).all(...params)
    const hasMore = rows.length > input.limit
    const items = rows.slice(0, input.limit).map((row) => ({
      sessionId: row.session_id,
      mode: row.mode,
      sourceId: row.source_id,
      startedAt: Number(row.started_at),
      endedAt: Number(row.ended_at),
      state: row.state,
      segmentCount: Number(row.segment_count)
    }))
    const last = items.at(-1)
    return {
      items,
      nextCursor: hasMore ? { startedAt: last.startedAt, sessionId: last.sessionId } : null
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
  LEGACY_SESSION_KEYS,
  MODE_BY_SOURCE,
  PERSISTED_CAPTION_KINDS,
  SqliteSubtitleStore,
  legacyImport,
  persistedEvent,
  sameEvent
}
