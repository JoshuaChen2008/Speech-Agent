'use strict'

// @ts-check

/* 字幕 SQLite schema 的唯一来源。
   - 只包含字幕事实、当前投影、会话和旧 JSONL 导入审计；
   - 不包含 translated/Agent/FTS/vector，也不包含音频 BLOB 或录音路径；
   - migration checksum 是 fail-closed 边界，已应用 SQL 被改写时拒绝开库。 */

const crypto = require('node:crypto')

const INITIAL_SCHEMA_SQL = `
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY NOT NULL CHECK (length(session_id) BETWEEN 1 AND 160),
  mode TEXT NOT NULL CHECK (mode IN ('meeting', 'dictation')),
  source_id TEXT NOT NULL CHECK (source_id IN ('loopback', 'mic')),
  started_at INTEGER NOT NULL CHECK (started_at >= 0),
  ended_at INTEGER CHECK (ended_at IS NULL OR ended_at >= started_at),
  state TEXT NOT NULL CHECK (state IN ('active', 'closed', 'interrupted')),
  CHECK (
    (mode = 'meeting' AND source_id = 'loopback') OR
    (mode = 'dictation' AND source_id = 'mic')
  ),
  UNIQUE (session_id, source_id)
) STRICT;

CREATE TABLE caption_events (
  event_order INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) BETWEEN 1 AND 320),
  session_id TEXT NOT NULL,
  source_id TEXT NOT NULL CHECK (source_id IN ('loopback', 'mic')),
  segment_id TEXT NOT NULL CHECK (length(segment_id) BETWEEN 1 AND 240),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  kind TEXT NOT NULL CHECK (kind IN ('final', 'refined')),
  t0_ms INTEGER NOT NULL CHECK (t0_ms >= 0),
  t1_ms INTEGER NOT NULL CHECK (t1_ms >= t0_ms),
  text TEXT NOT NULL CHECK (length(text) > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (session_id, source_id) REFERENCES sessions(session_id, source_id) ON DELETE RESTRICT,
  UNIQUE (session_id, source_id, sequence),
  UNIQUE (session_id, source_id, segment_id, revision)
) STRICT;

CREATE TABLE segments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  source_id TEXT NOT NULL CHECK (source_id IN ('loopback', 'mic')),
  segment_id TEXT NOT NULL CHECK (length(segment_id) BETWEEN 1 AND 240),
  text TEXT NOT NULL CHECK (length(text) > 0),
  text_revision INTEGER NOT NULL CHECK (text_revision >= 1),
  t0_ms INTEGER NOT NULL CHECK (t0_ms >= 0),
  t1_ms INTEGER NOT NULL CHECK (t1_ms >= t0_ms),
  first_event_order INTEGER NOT NULL,
  updated_event_order INTEGER NOT NULL,
  FOREIGN KEY (session_id, source_id) REFERENCES sessions(session_id, source_id) ON DELETE RESTRICT,
  FOREIGN KEY (first_event_order) REFERENCES caption_events(event_order) ON DELETE RESTRICT,
  FOREIGN KEY (updated_event_order) REFERENCES caption_events(event_order) ON DELETE RESTRICT,
  UNIQUE (session_id, source_id, segment_id)
) STRICT;

CREATE TABLE legacy_imports (
  source_sha256 TEXT PRIMARY KEY NOT NULL CHECK (length(source_sha256) = 64),
  source_path TEXT NOT NULL CHECK (length(source_path) > 0),
  imported_at INTEGER NOT NULL CHECK (imported_at >= 0),
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  segment_count INTEGER NOT NULL CHECK (segment_count >= 0),
  result TEXT NOT NULL CHECK (result IN ('imported', 'skipped'))
) STRICT;

CREATE INDEX caption_events_session_timeline
  ON caption_events(session_id, t0_ms, event_order);

CREATE INDEX segments_session_timeline
  ON segments(session_id, t0_ms, first_event_order);

CREATE TRIGGER sessions_reject_identity_update
BEFORE UPDATE OF session_id, mode, source_id ON sessions
WHEN
  NEW.session_id IS NOT OLD.session_id OR
  NEW.mode IS NOT OLD.mode OR
  NEW.source_id IS NOT OLD.source_id
BEGIN
  SELECT RAISE(ABORT, 'session identity and source are immutable');
END;

CREATE TRIGGER caption_events_reject_update
BEFORE UPDATE ON caption_events
BEGIN
  SELECT RAISE(ABORT, 'caption_events are immutable');
END;

CREATE TRIGGER caption_events_reject_delete
BEFORE DELETE ON caption_events
BEGIN
  SELECT RAISE(ABORT, 'caption_events are immutable');
END;
`

function checksum (sql) {
  return crypto.createHash('sha256').update(sql, 'utf8').digest('hex')
}

const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    checksum: checksum(INITIAL_SCHEMA_SQL),
    sql: INITIAL_SCHEMA_SQL
  })
])

const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

module.exports = {
  INITIAL_SCHEMA_SQL,
  MIGRATIONS,
  SCHEMA_VERSION,
  checksum
}
