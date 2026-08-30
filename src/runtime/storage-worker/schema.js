'use strict'

// @ts-check

/* 正式产品 SQLite migration 的唯一来源。
   - 字幕基础 catalog 只包含字幕事实、当前投影、会话和旧 JSONL 导入审计；
   - 正式 Agent v3 按 ADR 0010 另行追加，不进入 SEM-F29/J23 候选 catalog；
   - 两个 catalog 都不包含 translated/FTS/vector、音频 BLOB 或录音路径；
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

/* J15c 的会话级精修运行事实必须以独立 migration 加入：绝不能改写 v1，
   因为既有数据库已持有 v1 checksum。覆盖 N/M 不落表，而由权威字幕行查询派生。 */
const REFINEMENT_SESSION_RESULTS_SCHEMA_SQL = `
CREATE TABLE refinement_session_results (
  session_id TEXT PRIMARY KEY NOT NULL,
  result_status TEXT NOT NULL CHECK (result_status IN ('known', 'not_recorded')),
  refinement_enabled INTEGER CHECK (refinement_enabled IN (0, 1)),
  fault_code TEXT CHECK (fault_code IS NULL OR fault_code IN (
    'REFINE_WORKER_START_FAILED',
    'REFINE_WORKER_EXITED',
    'REFINE_DECODE_FAILED',
    'REFINE_INVALID_RESPONSE',
    'REFINE_INTERNAL_FAILURE'
  )),
  fault_stage TEXT CHECK (fault_stage IS NULL OR fault_stage IN (
    'start', 'worker', 'decode', 'response', 'internal'
  )),
  fault_at_ms INTEGER CHECK (fault_at_ms IS NULL OR fault_at_ms >= 0),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE RESTRICT,
  CHECK (
    (result_status = 'not_recorded' AND refinement_enabled IS NULL AND
      fault_code IS NULL AND fault_stage IS NULL AND fault_at_ms IS NULL) OR
    (result_status = 'known' AND refinement_enabled IN (0, 1) AND
      ((fault_code IS NULL AND fault_stage IS NULL AND fault_at_ms IS NULL) OR
       (fault_code IS NOT NULL AND fault_stage IS NOT NULL AND fault_at_ms IS NOT NULL)))
  )
) STRICT;

INSERT INTO refinement_session_results(
  session_id, result_status, refinement_enabled, fault_code, fault_stage, fault_at_ms
)
SELECT session_id, 'not_recorded', NULL, NULL, NULL, NULL
FROM sessions;
`

/* ADR 0010：正式 Agent v3 与隔离候选 v3 属于不同 catalog。这里不得加入
   SEM-F29/J23 的 reference-output 约束；正式表仍与字幕事实共用同一写连接。 */
const FORMAL_AGENT_SCHEMA_SQL = `
CREATE TABLE session_deletion_tombstones (
  session_id TEXT PRIMARY KEY NOT NULL CHECK (length(session_id) BETWEEN 1 AND 160),
  deletion_idempotency_key TEXT NOT NULL UNIQUE CHECK (length(deletion_idempotency_key) BETWEEN 1 AND 160),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  deleted_job_count INTEGER NOT NULL CHECK (deleted_job_count >= 0),
  deleted_artifact_count INTEGER NOT NULL CHECK (deleted_artifact_count >= 0),
  deleted_debug_thread_count INTEGER NOT NULL CHECK (deleted_debug_thread_count >= 0),
  deleted_memory_evidence_count INTEGER NOT NULL CHECK (deleted_memory_evidence_count >= 0),
  deleted_orphan_memory_count INTEGER NOT NULL CHECK (deleted_orphan_memory_count >= 0),
  deleted_at INTEGER NOT NULL CHECK (deleted_at >= 0)
) STRICT;

DROP TRIGGER caption_events_reject_delete;
CREATE TRIGGER caption_events_reject_delete
BEFORE DELETE ON caption_events
WHEN NOT EXISTS (
  SELECT 1 FROM session_deletion_tombstones AS tombstone
  WHERE tombstone.session_id = OLD.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'caption_events are immutable');
END;

CREATE TRIGGER sessions_reject_deleted_identity_insert
BEFORE INSERT ON sessions
WHEN EXISTS (
  SELECT 1 FROM session_deletion_tombstones AS tombstone
  WHERE tombstone.session_id = NEW.session_id
)
BEGIN
  SELECT RAISE(ABORT, 'deleted session identity cannot be reused');
END;

CREATE TABLE agent_jobs (
  job_order INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL UNIQUE CHECK (length(job_id) BETWEEN 1 AND 160),
  run_id TEXT NOT NULL UNIQUE CHECK (length(run_id) BETWEEN 1 AND 160),
  dedupe_key TEXT NOT NULL UNIQUE CHECK (length(dedupe_key) = 64),
  client_idempotency_key TEXT UNIQUE CHECK (
    client_idempotency_key IS NULL OR length(client_idempotency_key) BETWEEN 1 AND 160
  ),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  session_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL CHECK (plugin_id IN (
    'meeting-minutes', 'memory-extraction', 'enhanced-transcript'
  )),
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN (
    'meeting-minutes', 'memory-candidates', 'enhanced-transcript'
  )),
  transcript_version TEXT NOT NULL CHECK (transcript_version IN ('original', 'refined')),
  input_watermark INTEGER NOT NULL CHECK (input_watermark >= 1),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  recipe_version TEXT NOT NULL CHECK (length(recipe_version) BETWEEN 1 AND 80),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 160),
  provider_kind TEXT NOT NULL CHECK (provider_kind IN ('cloud', 'local')),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 160),
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 3),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  lease_owner TEXT CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 160),
  lease_expires_at INTEGER CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
  lease_renewed_from_expires_at INTEGER CHECK (
    lease_renewed_from_expires_at IS NULL OR lease_renewed_from_expires_at >= 0
  ),
  cancel_requested_at INTEGER CHECK (cancel_requested_at IS NULL OR cancel_requested_at >= 0),
  error_code TEXT CHECK (error_code IS NULL OR error_code IN (
    'AGENT_PROVIDER_AUTH_FAILED',
    'AGENT_PROVIDER_RATE_LIMITED',
    'AGENT_PROVIDER_UNAVAILABLE',
    'AGENT_PROVIDER_TIMEOUT',
    'AGENT_OUTPUT_INVALID',
    'AGENT_PERMISSION_DENIED',
    'AGENT_REQUEST_INVALID',
    'AGENT_WORKER_EXITED',
    'AGENT_INTERNAL_FAILURE'
  )),
  result_digest TEXT CHECK (result_digest IS NULL OR length(result_digest) = 64),
  result_summary_json TEXT CHECK (result_summary_json IS NULL OR json_valid(result_summary_json)),
  requested_by TEXT NOT NULL CHECK (requested_by IN ('automatic', 'user')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  UNIQUE (
    run_id, session_id, plugin_id, artifact_kind, transcript_version,
    input_watermark, input_digest, recipe_version, provider, model
  ),
  UNIQUE (
    run_id, session_id, plugin_id, transcript_version,
    input_watermark, input_digest, recipe_version, provider, model
  ),
  CHECK ((state = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (state = 'running' OR lease_renewed_from_expires_at IS NULL),
  CHECK (
    (state = 'succeeded' AND result_digest IS NOT NULL AND result_summary_json IS NOT NULL) OR
    (state <> 'succeeded' AND result_digest IS NULL AND result_summary_json IS NULL)
  ),
  CHECK (
    (requested_by = 'automatic' AND client_idempotency_key IS NULL) OR
    (requested_by = 'user' AND client_idempotency_key IS NOT NULL)
  ),
  CHECK (
    (plugin_id = 'meeting-minutes' AND artifact_kind = 'meeting-minutes' AND recipe_version = 'meeting-minutes@1') OR
    (plugin_id = 'memory-extraction' AND artifact_kind = 'memory-candidates' AND recipe_version = 'memory-extraction@1') OR
    (plugin_id = 'enhanced-transcript' AND artifact_kind = 'enhanced-transcript' AND recipe_version = 'enhanced-transcript@1')
  )
) STRICT;

CREATE TABLE agent_claim_receipts (
  claim_idempotency_key TEXT PRIMARY KEY NOT NULL CHECK (length(claim_idempotency_key) BETWEEN 1 AND 160),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  run_id TEXT CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 160),
  lease_owner TEXT CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 160),
  lease_expires_at INTEGER CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (
    (run_id IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL) OR
    (run_id IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE agent_artifacts (
  artifact_id TEXT PRIMARY KEY NOT NULL CHECK (length(artifact_id) BETWEEN 1 AND 160),
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL CHECK (plugin_id IN ('meeting-minutes', 'enhanced-transcript')),
  type TEXT NOT NULL CHECK (type IN ('meeting-minutes', 'enhanced-transcript')),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  transcript_version TEXT NOT NULL CHECK (transcript_version IN ('original', 'refined')),
  input_through_event_order INTEGER NOT NULL CHECK (input_through_event_order >= 1),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  recipe_version TEXT NOT NULL CHECK (length(recipe_version) BETWEEN 1 AND 80),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 160),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 160),
  supersedes_artifact_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  FOREIGN KEY (
    run_id, session_id, plugin_id, type, transcript_version,
    input_through_event_order, input_digest, recipe_version, provider, model
  ) REFERENCES agent_jobs(
    run_id, session_id, plugin_id, artifact_kind, transcript_version,
    input_watermark, input_digest, recipe_version, provider, model
  ) ON DELETE CASCADE,
  FOREIGN KEY (supersedes_artifact_id, session_id, plugin_id, type)
    REFERENCES agent_artifacts(artifact_id, session_id, plugin_id, type) ON DELETE RESTRICT,
  UNIQUE (run_id, plugin_id, type),
  UNIQUE (artifact_id, session_id, plugin_id, type),
  CHECK (plugin_id = type)
) STRICT;

CREATE TABLE memory_scopes (
  scope_id TEXT PRIMARY KEY NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 160),
  kind TEXT NOT NULL CHECK (kind IN ('global', 'session', 'topic', 'project')),
  canonical_key TEXT NOT NULL CHECK (length(canonical_key) BETWEEN 1 AND 240),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 400),
  session_id TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('user', 'automatic')),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'dormant', 'deleted')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  UNIQUE (kind, canonical_key),
  CHECK ((kind = 'session') = (session_id IS NOT NULL))
) STRICT;

CREATE TABLE memory_items (
  memory_id TEXT PRIMARY KEY NOT NULL CHECK (length(memory_id) BETWEEN 1 AND 160),
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('decision', 'conclusion', 'action-item', 'term', 'preference', 'project-fact', 'experience')),
  semantic_key TEXT NOT NULL CHECK (length(semantic_key) BETWEEN 1 AND 240),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  origin TEXT NOT NULL CHECK (origin IN ('explicit', 'automatic')),
  confidence_band TEXT NOT NULL CHECK (confidence_band IN ('low', 'medium', 'high')),
  salience_band TEXT NOT NULL CHECK (salience_band IN ('low', 'medium', 'high')),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'conflicted', 'inactive')),
  current_revision_id TEXT CHECK (current_revision_id IS NULL OR length(current_revision_id) BETWEEN 1 AND 160),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (scope_id) REFERENCES memory_scopes(scope_id) ON DELETE CASCADE,
  FOREIGN KEY (current_revision_id, memory_id)
    REFERENCES memory_revisions(revision_id, memory_id) ON DELETE SET NULL,
  UNIQUE (scope_id, kind, semantic_key)
) STRICT;

CREATE TABLE memory_revisions (
  revision_id TEXT PRIMARY KEY NOT NULL CHECK (length(revision_id) BETWEEN 1 AND 160),
  memory_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('create', 'merge', 'replace', 'invalidate', 'user-correct')),
  content_json TEXT CHECK (content_json IS NULL OR json_valid(content_json)),
  previous_revision_id TEXT,
  run_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (memory_id) REFERENCES memory_items(memory_id) ON DELETE CASCADE,
  FOREIGN KEY (previous_revision_id, memory_id)
    REFERENCES memory_revisions(revision_id, memory_id) ON DELETE SET NULL,
  FOREIGN KEY (run_id) REFERENCES agent_jobs(run_id) ON DELETE SET NULL,
  UNIQUE (revision_id, memory_id)
) STRICT;

CREATE TABLE memory_evidence (
  evidence_id TEXT PRIMARY KEY NOT NULL CHECK (length(evidence_id) BETWEEN 1 AND 160),
  run_id TEXT NOT NULL CHECK (length(run_id) BETWEEN 1 AND 160),
  memory_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  transcript_version TEXT NOT NULL CHECK (transcript_version IN ('original', 'refined')),
  input_watermark INTEGER NOT NULL CHECK (input_watermark >= 1),
  from_event_order INTEGER NOT NULL CHECK (from_event_order >= 1),
  through_event_order INTEGER NOT NULL CHECK (through_event_order >= from_event_order),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  plugin_id TEXT NOT NULL CHECK (plugin_id = 'memory-extraction'),
  recipe_version TEXT NOT NULL CHECK (recipe_version = 'memory-extraction@1'),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 160),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 160),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (
    run_id, session_id, plugin_id, transcript_version,
    input_watermark, input_digest, recipe_version, provider, model
  ) REFERENCES agent_jobs(
    run_id, session_id, plugin_id, transcript_version,
    input_watermark, input_digest, recipe_version, provider, model
  ) ON DELETE CASCADE,
  FOREIGN KEY (memory_id) REFERENCES memory_items(memory_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  UNIQUE (memory_id, session_id, transcript_version, from_event_order, through_event_order, input_digest)
) STRICT;

CREATE TABLE memory_suppressions (
  identity_hash TEXT PRIMARY KEY NOT NULL CHECK (length(identity_hash) = 64),
  scope_id TEXT NOT NULL,
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (scope_id) REFERENCES memory_scopes(scope_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE agent_debug_threads (
  thread_id TEXT PRIMARY KEY NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 160),
  selected_session_id TEXT NOT NULL,
  selected_input_watermark INTEGER NOT NULL CHECK (selected_input_watermark >= 1),
  selected_transcript_version TEXT NOT NULL CHECK (selected_transcript_version IN ('original', 'refined')),
  selected_input_digest TEXT NOT NULL CHECK (length(selected_input_digest) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (selected_session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE agent_debug_messages (
  message_order INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE CHECK (length(message_id) BETWEEN 1 AND 160),
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN (
    'user', 'assistant', 'tool_preview', 'tool_confirmation', 'tool_result', 'status'
  )),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  provider TEXT CHECK (provider IS NULL OR length(provider) BETWEEN 1 AND 160),
  model TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 160),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (thread_id) REFERENCES agent_debug_threads(thread_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE recognition_terms (
  term_id TEXT PRIMARY KEY NOT NULL CHECK (length(term_id) BETWEEN 1 AND 160),
  scope_id TEXT NOT NULL,
  canonical_text TEXT NOT NULL CHECK (length(canonical_text) BETWEEN 1 AND 400),
  aliases_json TEXT NOT NULL CHECK (json_valid(aliases_json)),
  proposal_origin TEXT NOT NULL CHECK (proposal_origin IN ('manual', 'memory-candidate')),
  source_memory_identity_hash TEXT CHECK (
    source_memory_identity_hash IS NULL OR length(source_memory_identity_hash) = 64
  ),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (scope_id) REFERENCES memory_scopes(scope_id) ON DELETE CASCADE,
  UNIQUE (scope_id, canonical_text),
  CHECK (
    (proposal_origin = 'manual' AND source_memory_identity_hash IS NULL) OR
    (proposal_origin = 'memory-candidate' AND source_memory_identity_hash IS NOT NULL)
  )
) STRICT;

CREATE TABLE recognition_term_sets (
  term_set_version INTEGER PRIMARY KEY NOT NULL CHECK (term_set_version >= 1),
  digest TEXT NOT NULL UNIQUE CHECK (length(digest) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (term_set_version, digest)
) STRICT;

CREATE TABLE recognition_term_set_members (
  term_set_version INTEGER NOT NULL,
  term_id TEXT NOT NULL,
  term_revision INTEGER NOT NULL CHECK (term_revision >= 1),
  canonical_text TEXT NOT NULL CHECK (length(canonical_text) BETWEEN 1 AND 400),
  aliases_json TEXT NOT NULL CHECK (json_valid(aliases_json)),
  matched_aliases_json TEXT NOT NULL CHECK (json_valid(matched_aliases_json)),
  PRIMARY KEY (term_set_version, term_id),
  FOREIGN KEY (term_set_version) REFERENCES recognition_term_sets(term_set_version) ON DELETE RESTRICT,
  FOREIGN KEY (term_id) REFERENCES recognition_terms(term_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE recognition_session_configs (
  session_id TEXT PRIMARY KEY NOT NULL,
  strategy TEXT NOT NULL CHECK (strategy IN ('local-only', 'cloud-primary-local-fallback')),
  primary_provider TEXT NOT NULL CHECK (length(primary_provider) BETWEEN 1 AND 160),
  fallback_provider TEXT CHECK (fallback_provider IS NULL OR length(fallback_provider) BETWEEN 1 AND 160),
  term_set_version INTEGER,
  term_set_digest TEXT CHECK (term_set_digest IS NULL OR length(term_set_digest) = 64),
  fallback_code TEXT CHECK (fallback_code IS NULL OR fallback_code IN (
    'RECOGNITION_PROVIDER_DISCONNECTED',
    'RECOGNITION_PROVIDER_UNAVAILABLE',
    'RECOGNITION_PROVIDER_PROTOCOL_ERROR'
  )),
  fallback_at_ms INTEGER CHECK (fallback_at_ms IS NULL OR fallback_at_ms >= 0),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  FOREIGN KEY (term_set_version, term_set_digest)
    REFERENCES recognition_term_sets(term_set_version, digest) ON DELETE RESTRICT,
  CHECK (
    (term_set_version IS NULL AND term_set_digest IS NULL) OR
    (term_set_version IS NOT NULL AND term_set_digest IS NOT NULL)
  ),
  CHECK (
    (fallback_code IS NULL AND fallback_at_ms IS NULL) OR
    (fallback_code IS NOT NULL AND fallback_at_ms IS NOT NULL)
  ),
  CHECK (
    (strategy = 'local-only' AND fallback_provider IS NULL AND fallback_code IS NULL) OR
    (strategy = 'cloud-primary-local-fallback' AND fallback_provider IS NOT NULL)
  ),
  CHECK (fallback_provider IS NULL OR fallback_provider <> primary_provider)
) STRICT;

CREATE TRIGGER memory_revision_requires_memory_job_insert
BEFORE INSERT ON memory_revisions
WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_jobs AS job
  WHERE job.run_id = NEW.run_id AND job.plugin_id = 'memory-extraction'
)
BEGIN
  SELECT RAISE(ABORT, 'memory revision job mismatch');
END;

CREATE TRIGGER memory_revision_requires_memory_job_update
BEFORE UPDATE OF run_id ON memory_revisions
WHEN NEW.run_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM agent_jobs AS job
  WHERE job.run_id = NEW.run_id AND job.plugin_id = 'memory-extraction'
)
BEGIN
  SELECT RAISE(ABORT, 'memory revision job mismatch');
END;

CREATE TRIGGER recognition_term_set_member_snapshot_insert
BEFORE INSERT ON recognition_term_set_members
WHEN NOT EXISTS (
  SELECT 1 FROM recognition_terms AS term
  WHERE term.term_id = NEW.term_id
    AND term.revision = NEW.term_revision
    AND term.canonical_text = NEW.canonical_text
    AND json(term.aliases_json) = json(NEW.aliases_json)
)
BEGIN
  SELECT RAISE(ABORT, 'recognition term snapshot mismatch');
END;

CREATE TRIGGER recognition_term_set_member_immutable
BEFORE UPDATE ON recognition_term_set_members
BEGIN
  SELECT RAISE(ABORT, 'recognition term set members are immutable');
END;

CREATE TRIGGER recognition_term_set_member_reject_delete
BEFORE DELETE ON recognition_term_set_members
BEGIN
  SELECT RAISE(ABORT, 'recognition term set members are immutable');
END;

CREATE TRIGGER agent_debug_message_provider_pair_insert
BEFORE INSERT ON agent_debug_messages
WHEN (NEW.provider IS NULL) <> (NEW.model IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'debug message provider snapshot mismatch');
END;

CREATE TRIGGER agent_debug_message_provider_pair_update
BEFORE UPDATE OF provider, model ON agent_debug_messages
WHEN (NEW.provider IS NULL) <> (NEW.model IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'debug message provider snapshot mismatch');
END;

CREATE INDEX agent_jobs_claim
  ON agent_jobs(state, provider_kind, next_attempt_at, job_order);
CREATE INDEX agent_jobs_session
  ON agent_jobs(session_id, job_order);
CREATE INDEX agent_claim_receipts_run
  ON agent_claim_receipts(run_id, created_at);
CREATE INDEX agent_artifacts_session
  ON agent_artifacts(session_id, created_at, artifact_id);
CREATE INDEX memory_items_lookup
  ON memory_items(lifecycle, scope_id, kind, updated_at);
CREATE INDEX memory_evidence_session
  ON memory_evidence(session_id, through_event_order);
CREATE INDEX agent_debug_messages_thread
  ON agent_debug_messages(thread_id, message_order);
`

/* D5 单条个人记忆删除必须为每个既有来源 digest 保留 suppression，且回执
   不得保存被删内容。正式 v3 已不可变，因此用追加 v4 扩展复合身份。 */
const FORMAL_AGENT_MEMORY_DELETION_SCHEMA_SQL = `
ALTER TABLE memory_suppressions RENAME TO memory_suppressions_v3;

CREATE TABLE memory_suppressions (
  identity_hash TEXT NOT NULL CHECK (length(identity_hash) = 64),
  scope_id TEXT NOT NULL,
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (identity_hash, source_digest),
  FOREIGN KEY (scope_id) REFERENCES memory_scopes(scope_id) ON DELETE CASCADE
) STRICT;

INSERT INTO memory_suppressions(identity_hash, scope_id, source_digest, created_at)
SELECT identity_hash, scope_id, source_digest, created_at
FROM memory_suppressions_v3;

DROP TABLE memory_suppressions_v3;

CREATE TABLE memory_deletion_receipts (
  deletion_idempotency_key TEXT PRIMARY KEY NOT NULL CHECK (
    length(deletion_idempotency_key) BETWEEN 1 AND 160
  ),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  memory_id TEXT NOT NULL CHECK (length(memory_id) BETWEEN 1 AND 160),
  suppressed_source_count INTEGER NOT NULL CHECK (suppressed_source_count >= 0),
  deleted_evidence_count INTEGER NOT NULL CHECK (deleted_evidence_count >= 0),
  deleted_revision_count INTEGER NOT NULL CHECK (deleted_revision_count >= 0),
  deleted_at INTEGER NOT NULL CHECK (deleted_at >= 0)
) STRICT;
`

/* SEM-F30 / DB7 / J21：新个人上下文实现使用独立命名空间。正式 v1-v4
   已由 migration checksum 冻结，因此这里只能追加 v5，不能改写旧 Agent 表。 */
const PERSONAL_CONTEXT_SCHEMA_SQL = `
ALTER TABLE session_deletion_tombstones
  ADD COLUMN deleted_interaction_count INTEGER NOT NULL DEFAULT 0 CHECK (deleted_interaction_count >= 0);
ALTER TABLE session_deletion_tombstones
  ADD COLUMN deleted_tool_call_count INTEGER NOT NULL DEFAULT 0 CHECK (deleted_tool_call_count >= 0);
ALTER TABLE session_deletion_tombstones
  ADD COLUMN deleted_episode_count INTEGER NOT NULL DEFAULT 0 CHECK (deleted_episode_count >= 0);
ALTER TABLE session_deletion_tombstones
  ADD COLUMN deleted_context_evidence_count INTEGER NOT NULL DEFAULT 0 CHECK (deleted_context_evidence_count >= 0);
ALTER TABLE session_deletion_tombstones
  ADD COLUMN deleted_orphan_context_item_count INTEGER NOT NULL DEFAULT 0 CHECK (deleted_orphan_context_item_count >= 0);

CREATE TABLE formal_agent_runs (
  run_order INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL UNIQUE CHECK (length(run_id) BETWEEN 1 AND 160),
  dedupe_key TEXT NOT NULL UNIQUE CHECK (length(dedupe_key) = 64),
  client_idempotency_key TEXT UNIQUE CHECK (
    client_idempotency_key IS NULL OR length(client_idempotency_key) BETWEEN 1 AND 160
  ),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  recipe_id TEXT NOT NULL CHECK (length(recipe_id) BETWEEN 1 AND 80),
  recipe_version TEXT NOT NULL CHECK (length(recipe_version) BETWEEN 1 AND 80),
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  scope_digest TEXT NOT NULL CHECK (length(scope_digest) = 64),
  transcript_version TEXT NOT NULL CHECK (transcript_version IN ('raw', 'refined')),
  input_watermark_json TEXT NOT NULL CHECK (json_valid(input_watermark_json)),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  requested_by TEXT NOT NULL CHECK (requested_by IN ('automatic', 'user')),
  state TEXT NOT NULL CHECK (state IN (
    'queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled'
  )),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 100),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 100),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  lease_owner TEXT CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 160),
  lease_expires_at INTEGER CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
  lease_renewed_from_expires_at INTEGER CHECK (
    lease_renewed_from_expires_at IS NULL OR lease_renewed_from_expires_at >= 0
  ),
  cancel_requested_at INTEGER CHECK (cancel_requested_at IS NULL OR cancel_requested_at >= 0),
  error_code TEXT CHECK (error_code IS NULL OR error_code IN (
    'AGENT_PROVIDER_AUTH_FAILED',
    'AGENT_PROVIDER_RATE_LIMITED',
    'AGENT_PROVIDER_UNAVAILABLE',
    'AGENT_PROVIDER_TIMEOUT',
    'AGENT_OUTPUT_INVALID',
    'AGENT_PERMISSION_DENIED',
    'AGENT_REQUEST_INVALID',
    'AGENT_WORKER_EXITED',
    'AGENT_INTERNAL_FAILURE',
    'AGENT_BUDGET_EXCEEDED'
  )),
  result_digest TEXT CHECK (result_digest IS NULL OR length(result_digest) = 64),
  result_summary_json TEXT CHECK (result_summary_json IS NULL OR json_valid(result_summary_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK ((state = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK (state = 'running' OR lease_renewed_from_expires_at IS NULL),
  CHECK ((state = 'failed') = (error_code IS NOT NULL)),
  CHECK (
    (state = 'succeeded' AND result_digest IS NOT NULL AND result_summary_json IS NOT NULL) OR
    (state <> 'succeeded' AND result_digest IS NULL AND result_summary_json IS NULL)
  ),
  CHECK (
    (requested_by = 'automatic' AND client_idempotency_key IS NULL) OR
    (requested_by = 'user' AND client_idempotency_key IS NOT NULL)
  )
) STRICT;

CREATE TABLE formal_agent_run_claim_receipts (
  claim_idempotency_key TEXT PRIMARY KEY NOT NULL CHECK (length(claim_idempotency_key) BETWEEN 1 AND 160),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  run_id TEXT CHECK (run_id IS NULL OR length(run_id) BETWEEN 1 AND 160),
  lease_owner TEXT CHECK (lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 160),
  lease_expires_at INTEGER CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  CHECK (
    (run_id IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL) OR
    (run_id IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
) STRICT;

CREATE TABLE personal_context_projection_state (
  singleton_key INTEGER PRIMARY KEY NOT NULL CHECK (singleton_key = 1),
  content_revision INTEGER NOT NULL CHECK (content_revision >= 0),
  last_command_digest TEXT CHECK (last_command_digest IS NULL OR length(last_command_digest) = 64),
  last_result_identity_json TEXT CHECK (
    last_result_identity_json IS NULL OR json_valid(last_result_identity_json)
  ),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  CHECK ((last_command_digest IS NULL) = (last_result_identity_json IS NULL))
) STRICT;

INSERT INTO personal_context_projection_state(
  singleton_key, content_revision, last_command_digest, last_result_identity_json, updated_at
) VALUES (1, 0, NULL, NULL, 0);

CREATE TABLE personal_context_scopes (
  scope_id TEXT PRIMARY KEY NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 160),
  kind TEXT NOT NULL CHECK (kind IN ('global', 'session', 'topic', 'project')),
  canonical_key TEXT NOT NULL CHECK (length(canonical_key) BETWEEN 1 AND 240),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 400),
  session_id TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('user', 'automatic')),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'forgotten', 'conflicted', 'inactive')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  UNIQUE (kind, canonical_key),
  CHECK ((kind = 'session') = (session_id IS NOT NULL))
) STRICT;

CREATE TABLE personal_context_items (
  memory_id TEXT PRIMARY KEY NOT NULL CHECK (length(memory_id) BETWEEN 1 AND 160),
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'decision', 'conclusion', 'todo', 'term', 'preference', 'project_fact', 'experience'
  )),
  semantic_key TEXT NOT NULL CHECK (length(semantic_key) BETWEEN 1 AND 256),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  origin TEXT NOT NULL CHECK (origin IN ('explicit', 'inferred')),
  confidence_band TEXT NOT NULL CHECK (confidence_band IN ('low', 'medium', 'high')),
  salience_band TEXT NOT NULL CHECK (salience_band IN ('low', 'medium', 'high')),
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'forgotten', 'conflicted', 'inactive')),
  current_revision_id TEXT CHECK (current_revision_id IS NULL OR length(current_revision_id) BETWEEN 1 AND 160),
  item_revision INTEGER NOT NULL CHECK (item_revision >= 1),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (scope_id) REFERENCES personal_context_scopes(scope_id) ON DELETE CASCADE,
  FOREIGN KEY (current_revision_id, memory_id)
    REFERENCES personal_context_revisions(revision_id, memory_id) ON DELETE SET NULL,
  UNIQUE (scope_id, kind, semantic_key)
) STRICT;

CREATE TABLE personal_context_revisions (
  revision_id TEXT PRIMARY KEY NOT NULL CHECK (length(revision_id) BETWEEN 1 AND 160),
  memory_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN (
    'create', 'merge', 'replace', 'invalidate', 'user-correct', 'forget', 'restore'
  )),
  content_json TEXT CHECK (content_json IS NULL OR json_valid(content_json)),
  previous_revision_id TEXT,
  run_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (memory_id) REFERENCES personal_context_items(memory_id) ON DELETE CASCADE,
  FOREIGN KEY (previous_revision_id, memory_id)
    REFERENCES personal_context_revisions(revision_id, memory_id) ON DELETE SET NULL,
  FOREIGN KEY (run_id) REFERENCES formal_agent_runs(run_id) ON DELETE SET NULL,
  UNIQUE (revision_id, memory_id)
) STRICT;

CREATE TABLE personal_context_evidence (
  evidence_id TEXT PRIMARY KEY NOT NULL CHECK (length(evidence_id) BETWEEN 1 AND 160),
  ingest_run_id TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('session', 'interaction')),
  session_id TEXT,
  interaction_id TEXT,
  transcript_version TEXT NOT NULL CHECK (transcript_version IN ('raw', 'refined')),
  input_watermark INTEGER NOT NULL CHECK (input_watermark >= 1),
  from_event_order INTEGER NOT NULL CHECK (from_event_order >= 1),
  through_event_order INTEGER NOT NULL CHECK (through_event_order >= from_event_order),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  recipe_id TEXT NOT NULL CHECK (recipe_id IN ('context.ingest.session', 'context.ingest.interaction')),
  recipe_version TEXT NOT NULL CHECK (length(recipe_version) BETWEEN 1 AND 80),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (ingest_run_id) REFERENCES formal_agent_runs(run_id) ON DELETE CASCADE,
  FOREIGN KEY (memory_id) REFERENCES personal_context_items(memory_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  CHECK (
    (source_kind = 'session' AND session_id IS NOT NULL AND interaction_id IS NULL) OR
    (source_kind = 'interaction' AND session_id IS NULL AND interaction_id IS NOT NULL)
  )
) STRICT;

CREATE TABLE personal_context_suppressions (
  identity_hash TEXT NOT NULL CHECK (length(identity_hash) = 64),
  scope_id TEXT NOT NULL,
  source_digest TEXT NOT NULL CHECK (length(source_digest) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (identity_hash, source_digest),
  FOREIGN KEY (scope_id) REFERENCES personal_context_scopes(scope_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE personal_context_deletion_receipts (
  deletion_idempotency_key TEXT PRIMARY KEY NOT NULL CHECK (
    length(deletion_idempotency_key) BETWEEN 1 AND 160
  ),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  identity_hash TEXT NOT NULL CHECK (length(identity_hash) = 64),
  deleted_item_count INTEGER NOT NULL CHECK (deleted_item_count >= 0),
  deleted_revision_count INTEGER NOT NULL CHECK (deleted_revision_count >= 0),
  deleted_evidence_count INTEGER NOT NULL CHECK (deleted_evidence_count >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0)
) STRICT;

CREATE TABLE personal_context_episodes (
  episode_id TEXT PRIMARY KEY NOT NULL CHECK (length(episode_id) BETWEEN 1 AND 160),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('session', 'interaction')),
  session_id TEXT,
  interaction_id TEXT,
  scope_id TEXT NOT NULL,
  transcript_version TEXT NOT NULL CHECK (transcript_version IN ('raw', 'refined')),
  input_watermark INTEGER NOT NULL CHECK (input_watermark >= 1),
  from_event_order INTEGER NOT NULL CHECK (from_event_order >= 1),
  through_event_order INTEGER NOT NULL CHECK (through_event_order >= from_event_order),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  summary_json TEXT NOT NULL CHECK (
    json_valid(summary_json) AND length(CAST(summary_json AS BLOB)) <= 8192
  ),
  occurred_from_offset_ms INTEGER NOT NULL CHECK (occurred_from_offset_ms >= 0),
  occurred_through_offset_ms INTEGER NOT NULL CHECK (
    occurred_through_offset_ms >= occurred_from_offset_ms
  ),
  ingest_run_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK (lifecycle IN ('active', 'forgotten', 'conflicted', 'inactive')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
  FOREIGN KEY (scope_id) REFERENCES personal_context_scopes(scope_id) ON DELETE CASCADE,
  FOREIGN KEY (ingest_run_id) REFERENCES formal_agent_runs(run_id) ON DELETE CASCADE,
  UNIQUE (source_kind, session_id, interaction_id, input_digest),
  CHECK (
    (source_kind = 'session' AND session_id IS NOT NULL AND interaction_id IS NULL) OR
    (source_kind = 'interaction' AND session_id IS NULL AND interaction_id IS NOT NULL)
  )
) STRICT;

CREATE INDEX formal_agent_runs_claim
  ON formal_agent_runs(state, next_attempt_at, run_order);
CREATE INDEX formal_agent_run_claim_receipts_run
  ON formal_agent_run_claim_receipts(run_id, created_at);
CREATE INDEX personal_context_items_lookup
  ON personal_context_items(lifecycle, scope_id, kind, updated_at);
CREATE INDEX personal_context_evidence_session
  ON personal_context_evidence(session_id, through_event_order);
CREATE INDEX personal_context_episodes_session
  ON personal_context_episodes(session_id, through_event_order);
`

/* SEM-F33 / DB7 / J25: model-access facts are appended as v6. Credentials
   remain in the main-owned vault; these tables contain only non-sensitive
   configuration, slot identity, and immutable run binding snapshots. */
const MODEL_ACCESS_SCHEMA_SQL = `
CREATE TABLE agent_model_profiles (
  profile_id TEXT PRIMARY KEY NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 128),
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
  label TEXT NOT NULL CHECK (length(CAST(label AS BLOB)) BETWEEN 1 AND 256),
  template_id TEXT CHECK (template_id IS NULL OR template_id = 'deepseek-openai-template@1'),
  adapter_id TEXT NOT NULL CHECK (adapter_id = 'openai-compatible'),
  api_style TEXT NOT NULL CHECK (api_style = 'chat-completions'),
  https_origin TEXT NOT NULL CHECK (length(https_origin) BETWEEN 9 AND 2048),
  base_path TEXT NOT NULL CHECK (length(base_path) BETWEEN 1 AND 1024),
  catalog_revision INTEGER NOT NULL CHECK (catalog_revision >= 0),
  credential_slot_id TEXT NOT NULL UNIQUE CHECK (length(credential_slot_id) BETWEEN 16 AND 160),
  credential_generation TEXT CHECK (credential_generation IS NULL OR length(credential_generation) BETWEEN 16 AND 160),
  credential_persistence TEXT NOT NULL CHECK (credential_persistence IN ('absent', 'persistent')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  CHECK ((credential_persistence = 'persistent') = (credential_generation IS NOT NULL))
) STRICT;

CREATE TABLE agent_model_profile_models (
  profile_id TEXT NOT NULL,
  model_id TEXT NOT NULL CHECK (length(CAST(model_id AS BLOB)) BETWEEN 1 AND 256),
  capability_json TEXT NOT NULL CHECK (json_valid(capability_json)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  PRIMARY KEY (profile_id, model_id),
  FOREIGN KEY (profile_id) REFERENCES agent_model_profiles(profile_id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER agent_model_capability_insert_exact
BEFORE INSERT ON agent_model_profile_models
WHEN (SELECT COUNT(*) FROM json_each(NEW.capability_json)) <> 6 OR
  EXISTS (SELECT 1 FROM json_each(NEW.capability_json) WHERE key NOT IN (
    'maxInputTokens', 'maxOutputTokens', 'supportsToolCalling',
    'supportsStructuredOutput', 'supportsStreaming', 'usageReporting'
  )) OR
  json_type(NEW.capability_json, '$.maxInputTokens') <> 'integer' OR
  json_extract(NEW.capability_json, '$.maxInputTokens') < 1 OR
  json_type(NEW.capability_json, '$.maxOutputTokens') <> 'integer' OR
  json_extract(NEW.capability_json, '$.maxOutputTokens') < 1 OR
  json_type(NEW.capability_json, '$.supportsToolCalling') NOT IN ('true', 'false') OR
  json_type(NEW.capability_json, '$.supportsStructuredOutput') NOT IN ('true', 'false') OR
  json_type(NEW.capability_json, '$.supportsStreaming') NOT IN ('true', 'false') OR
  json_type(NEW.capability_json, '$.usageReporting') NOT IN ('true', 'false')
BEGIN
  SELECT RAISE(ABORT, 'invalid model capability');
END;

CREATE TRIGGER agent_model_capability_update_exact
BEFORE UPDATE OF capability_json ON agent_model_profile_models
WHEN (SELECT COUNT(*) FROM json_each(NEW.capability_json)) <> 6 OR
  EXISTS (SELECT 1 FROM json_each(NEW.capability_json) WHERE key NOT IN (
    'maxInputTokens', 'maxOutputTokens', 'supportsToolCalling',
    'supportsStructuredOutput', 'supportsStreaming', 'usageReporting'
  )) OR
  json_type(NEW.capability_json, '$.maxInputTokens') <> 'integer' OR
  json_extract(NEW.capability_json, '$.maxInputTokens') < 1 OR
  json_type(NEW.capability_json, '$.maxOutputTokens') <> 'integer' OR
  json_extract(NEW.capability_json, '$.maxOutputTokens') < 1 OR
  json_type(NEW.capability_json, '$.supportsToolCalling') NOT IN ('true', 'false') OR
  json_type(NEW.capability_json, '$.supportsStructuredOutput') NOT IN ('true', 'false') OR
  json_type(NEW.capability_json, '$.supportsStreaming') NOT IN ('true', 'false') OR
  json_type(NEW.capability_json, '$.usageReporting') NOT IN ('true', 'false')
BEGIN
  SELECT RAISE(ABORT, 'invalid model capability');
END;

CREATE TABLE agent_model_purpose_assignments (
  purpose TEXT PRIMARY KEY NOT NULL CHECK (purpose IN (
    'default', 'information_extraction', 'summary', 'analysis_planning'
  )),
  profile_id TEXT,
  model_id TEXT,
  assigned_profile_revision INTEGER CHECK (assigned_profile_revision IS NULL OR assigned_profile_revision >= 1),
  configuration_revision INTEGER NOT NULL CHECK (configuration_revision >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  CHECK (
    (profile_id IS NULL AND model_id IS NULL AND assigned_profile_revision IS NULL) OR
    (profile_id IS NOT NULL AND model_id IS NOT NULL AND assigned_profile_revision IS NOT NULL)
  ),
  FOREIGN KEY (profile_id, model_id)
    REFERENCES agent_model_profile_models(profile_id, model_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE agent_model_run_bindings (
  run_id TEXT PRIMARY KEY NOT NULL,
  execution_form TEXT NOT NULL CHECK (execution_form IN ('single_shot', 'agent_loop')),
  purpose TEXT NOT NULL CHECK (purpose IN (
    'default', 'information_extraction', 'summary', 'analysis_planning'
  )),
  assignment_mode TEXT NOT NULL CHECK (assignment_mode IN ('direct', 'fallback_default')),
  profile_id TEXT NOT NULL CHECK (length(profile_id) BETWEEN 1 AND 128),
  profile_revision INTEGER NOT NULL CHECK (profile_revision >= 1),
  adapter_id TEXT NOT NULL CHECK (adapter_id = 'openai-compatible'),
  api_style TEXT NOT NULL CHECK (api_style = 'chat-completions'),
  https_origin TEXT NOT NULL CHECK (length(https_origin) BETWEEN 9 AND 2048),
  base_path TEXT NOT NULL CHECK (length(base_path) BETWEEN 1 AND 1024),
  model_id TEXT NOT NULL CHECK (length(CAST(model_id AS BLOB)) BETWEEN 1 AND 256),
  capability_json TEXT NOT NULL CHECK (json_valid(capability_json)),
  budget_json TEXT NOT NULL CHECK (json_valid(budget_json)),
  provider_kind TEXT NOT NULL CHECK (provider_kind IN ('cloud', 'local')),
  credential_slot_id TEXT NOT NULL CHECK (length(credential_slot_id) BETWEEN 16 AND 160),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (run_id) REFERENCES formal_agent_runs(run_id) ON DELETE CASCADE
) STRICT;

CREATE TRIGGER agent_model_purpose_no_delete
BEFORE DELETE ON agent_model_purpose_assignments
BEGIN
  SELECT RAISE(ABORT, 'model purpose rows are permanent');
END;

CREATE TRIGGER agent_model_purpose_revision_monotonic
BEFORE UPDATE OF configuration_revision ON agent_model_purpose_assignments
WHEN NEW.configuration_revision <> OLD.configuration_revision AND
  NEW.configuration_revision <> OLD.configuration_revision + 1
BEGIN
  SELECT RAISE(ABORT, 'invalid configuration revision');
END;

CREATE TRIGGER agent_model_purpose_revision_sync
AFTER UPDATE OF configuration_revision ON agent_model_purpose_assignments
WHEN EXISTS (
  SELECT 1 FROM agent_model_purpose_assignments
  WHERE configuration_revision <> NEW.configuration_revision
)
BEGIN
  UPDATE agent_model_purpose_assignments
  SET configuration_revision = NEW.configuration_revision
  WHERE configuration_revision <> NEW.configuration_revision;
END;

CREATE TRIGGER agent_model_binding_no_update
BEFORE UPDATE ON agent_model_run_bindings
BEGIN
  SELECT RAISE(ABORT, 'model run binding is immutable');
END;

CREATE TRIGGER agent_model_binding_owned_delete
BEFORE DELETE ON agent_model_run_bindings
WHEN EXISTS (SELECT 1 FROM formal_agent_runs WHERE run_id = OLD.run_id)
BEGIN
  SELECT RAISE(ABORT, 'model run binding is owned by its run');
END;

INSERT INTO agent_model_purpose_assignments(
  purpose, profile_id, model_id, assigned_profile_revision, configuration_revision, updated_at
) VALUES
  ('default', NULL, NULL, NULL, 0, 0),
  ('information_extraction', NULL, NULL, NULL, 0, 0),
  ('summary', NULL, NULL, NULL, 0, 0),
  ('analysis_planning', NULL, NULL, NULL, 0, 0);

INSERT INTO agent_model_profiles(
  profile_id, profile_revision, label, template_id, adapter_id, api_style,
  https_origin, base_path, catalog_revision, credential_slot_id,
  credential_generation, credential_persistence, created_at, updated_at
) VALUES (
  'deepseek', 1, 'DeepSeek', 'deepseek-openai-template@1',
  'openai-compatible', 'chat-completions', 'https://api.deepseek.com', '/', 0,
  'slot.' || lower(hex(randomblob(16))), NULL, 'absent', 0, 0
);

CREATE INDEX agent_model_profiles_catalog
  ON agent_model_profiles(profile_id, profile_revision, catalog_revision);
CREATE INDEX agent_model_purpose_target
  ON agent_model_purpose_assignments(profile_id, model_id);
CREATE INDEX agent_model_bindings_profile
  ON agent_model_run_bindings(profile_id, model_id, created_at);
`

/* SEM-F28 / SEM-F34 / J22/J24: formal Agent interaction facts are appended as
   v7.  This migration is deliberately the only place that creates the three
   interaction/presentation tables, adds the presentation tombstone counter,
   and creates the four registered keyset indexes.  It must not touch the
   recognition_* tables or rewrite any prior migration. */
const AGENT_EXECUTION_SCHEMA_SQL = `
ALTER TABLE session_deletion_tombstones
  ADD COLUMN deleted_report_presentation_count INTEGER NOT NULL DEFAULT 0 CHECK (deleted_report_presentation_count >= 0);

CREATE TABLE formal_agent_interactions (
  interaction_id TEXT PRIMARY KEY NOT NULL CHECK (length(interaction_id) BETWEEN 1 AND 160),
  run_id TEXT NOT NULL UNIQUE CHECK (length(run_id) BETWEEN 1 AND 160),
  recipe_id TEXT NOT NULL CHECK (length(recipe_id) BETWEEN 1 AND 80),
  recipe_version TEXT NOT NULL CHECK (length(recipe_version) BETWEEN 1 AND 80),
  max_turns INTEGER NOT NULL CHECK (max_turns IN (1, 3, 6)),
  tool_grants_json TEXT NOT NULL CHECK (json_valid(tool_grants_json)),
  routing_mode TEXT NOT NULL CHECK (routing_mode IN ('model', 'rules', 'preset')),
  requested_by TEXT NOT NULL CHECK (requested_by IN ('automatic', 'user')),
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  scope_digest TEXT NOT NULL CHECK (length(scope_digest) = 64),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  prompt_digest TEXT CHECK (prompt_digest IS NULL OR length(prompt_digest) = 64),
  terminal_reason TEXT CHECK (terminal_reason IS NULL OR terminal_reason IN ('succeeded', 'failed', 'cancelled')),
  error_code TEXT CHECK (error_code IS NULL OR error_code IN (
    'AGENT_PROVIDER_AUTH_FAILED',
    'AGENT_PROVIDER_RATE_LIMITED',
    'AGENT_PROVIDER_UNAVAILABLE',
    'AGENT_PROVIDER_TIMEOUT',
    'AGENT_OUTPUT_INVALID',
    'AGENT_PERMISSION_DENIED',
    'AGENT_REQUEST_INVALID',
    'AGENT_WORKER_EXITED',
    'AGENT_INTERNAL_FAILURE',
    'AGENT_BUDGET_EXCEEDED'
  )),
  usage_json TEXT CHECK (usage_json IS NULL OR json_valid(usage_json)),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 1 AND 100),
  comparison_group_id TEXT NOT NULL CHECK (length(comparison_group_id) = 64),
  result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
  result_digest TEXT CHECK (result_digest IS NULL OR length(result_digest) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  terminal_at INTEGER CHECK (terminal_at IS NULL OR terminal_at >= created_at),
  FOREIGN KEY (run_id) REFERENCES formal_agent_runs(run_id) ON DELETE CASCADE,
  CHECK (terminal_reason IS NULL OR (terminal_reason = 'failed') = (error_code IS NOT NULL)),
  CHECK (terminal_reason IS NULL OR terminal_reason <> 'succeeded' OR (result_json IS NOT NULL AND result_digest IS NOT NULL)),
  CHECK ((terminal_reason IS NULL) = (terminal_at IS NULL)),
  CHECK (terminal_reason IS NOT NULL OR (error_code IS NULL AND result_json IS NULL AND result_digest IS NULL)),
  CHECK ((requested_by = 'user') = (prompt_digest IS NOT NULL)),
  CHECK (terminal_reason IS NULL OR terminal_reason <> 'succeeded' OR result_digest IS NOT NULL),
  CHECK (terminal_reason IS NULL OR terminal_reason <> 'succeeded' OR result_json IS NOT NULL)
) STRICT;

CREATE TRIGGER formal_agent_interactions_tool_grants_exact_insert
BEFORE INSERT ON formal_agent_interactions
WHEN NOT json_valid(NEW.tool_grants_json) OR json_type(NEW.tool_grants_json) <> 'array' OR
  (SELECT COUNT(*) FROM json_each(NEW.tool_grants_json)) > 2 OR
  EXISTS (SELECT 1 FROM json_each(NEW.tool_grants_json)
    WHERE value NOT IN ('search_context', 'read_sources')) OR
  (SELECT COUNT(DISTINCT value) FROM json_each(NEW.tool_grants_json)) <
    (SELECT COUNT(*) FROM json_each(NEW.tool_grants_json))
BEGIN
  SELECT RAISE(ABORT, 'invalid recipe tool grants');
END;

CREATE TRIGGER formal_agent_interactions_tool_grants_exact_update
BEFORE UPDATE OF tool_grants_json ON formal_agent_interactions
WHEN NOT json_valid(NEW.tool_grants_json) OR json_type(NEW.tool_grants_json) <> 'array' OR
  (SELECT COUNT(*) FROM json_each(NEW.tool_grants_json)) > 2 OR
  EXISTS (SELECT 1 FROM json_each(NEW.tool_grants_json)
    WHERE value NOT IN ('search_context', 'read_sources')) OR
  (SELECT COUNT(DISTINCT value) FROM json_each(NEW.tool_grants_json)) <
    (SELECT COUNT(*) FROM json_each(NEW.tool_grants_json))
BEGIN
  SELECT RAISE(ABORT, 'invalid recipe tool grants');
END;

CREATE TRIGGER formal_agent_interactions_usage_exact_insert
BEFORE INSERT ON formal_agent_interactions
WHEN NEW.usage_json IS NOT NULL AND (
  NOT json_valid(NEW.usage_json) OR json_type(NEW.usage_json) <> 'object' OR
  (SELECT COUNT(*) FROM json_each(NEW.usage_json)) <> 5 OR
  EXISTS (SELECT 1 FROM json_each(NEW.usage_json) WHERE key NOT IN (
    'inputTokens', 'outputTokens', 'usageSource', 'cacheHitInputTokens', 'cacheMissInputTokens'
  )) OR
  json_type(NEW.usage_json, '$.inputTokens') <> 'integer' OR
  json_extract(NEW.usage_json, '$.inputTokens') < 0 OR
  json_type(NEW.usage_json, '$.outputTokens') <> 'integer' OR
  json_extract(NEW.usage_json, '$.outputTokens') < 0 OR
  json_extract(NEW.usage_json, '$.usageSource') <> 'provider' OR
  NOT (
    (json_type(NEW.usage_json, '$.cacheHitInputTokens') = 'null' AND
      json_type(NEW.usage_json, '$.cacheMissInputTokens') = 'null') OR
    (json_type(NEW.usage_json, '$.cacheHitInputTokens') = 'integer' AND
      json_type(NEW.usage_json, '$.cacheMissInputTokens') = 'integer' AND
      json_extract(NEW.usage_json, '$.cacheHitInputTokens') >= 0 AND
      json_extract(NEW.usage_json, '$.cacheMissInputTokens') >= 0 AND
      json_extract(NEW.usage_json, '$.cacheHitInputTokens') +
        json_extract(NEW.usage_json, '$.cacheMissInputTokens') > 0 AND
      json_extract(NEW.usage_json, '$.cacheHitInputTokens') +
        json_extract(NEW.usage_json, '$.cacheMissInputTokens') =
        json_extract(NEW.usage_json, '$.inputTokens'))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid ModelUsageV1');
END;

CREATE TRIGGER formal_agent_interactions_usage_exact_update
BEFORE UPDATE OF usage_json ON formal_agent_interactions
WHEN NEW.usage_json IS NOT NULL AND (
  NOT json_valid(NEW.usage_json) OR json_type(NEW.usage_json) <> 'object' OR
  (SELECT COUNT(*) FROM json_each(NEW.usage_json)) <> 5 OR
  EXISTS (SELECT 1 FROM json_each(NEW.usage_json) WHERE key NOT IN (
    'inputTokens', 'outputTokens', 'usageSource', 'cacheHitInputTokens', 'cacheMissInputTokens'
  )) OR
  json_type(NEW.usage_json, '$.inputTokens') <> 'integer' OR
  json_extract(NEW.usage_json, '$.inputTokens') < 0 OR
  json_type(NEW.usage_json, '$.outputTokens') <> 'integer' OR
  json_extract(NEW.usage_json, '$.outputTokens') < 0 OR
  json_extract(NEW.usage_json, '$.usageSource') <> 'provider' OR
  NOT (
    (json_type(NEW.usage_json, '$.cacheHitInputTokens') = 'null' AND
      json_type(NEW.usage_json, '$.cacheMissInputTokens') = 'null') OR
    (json_type(NEW.usage_json, '$.cacheHitInputTokens') = 'integer' AND
      json_type(NEW.usage_json, '$.cacheMissInputTokens') = 'integer' AND
      json_extract(NEW.usage_json, '$.cacheHitInputTokens') >= 0 AND
      json_extract(NEW.usage_json, '$.cacheMissInputTokens') >= 0 AND
      json_extract(NEW.usage_json, '$.cacheHitInputTokens') +
        json_extract(NEW.usage_json, '$.cacheMissInputTokens') > 0 AND
      json_extract(NEW.usage_json, '$.cacheHitInputTokens') +
        json_extract(NEW.usage_json, '$.cacheMissInputTokens') =
        json_extract(NEW.usage_json, '$.inputTokens'))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid ModelUsageV1');
END;

CREATE TABLE formal_agent_tool_calls (
  call_id TEXT PRIMARY KEY NOT NULL CHECK (length(call_id) BETWEEN 1 AND 160),
  interaction_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt BETWEEN 1 AND 100),
  call_order INTEGER NOT NULL CHECK (call_order BETWEEN 1 AND 12),
  tool_name TEXT NOT NULL CHECK (tool_name IN ('search_context', 'read_sources')),
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  started_offset_ms INTEGER NOT NULL CHECK (started_offset_ms >= 0),
  ended_offset_ms INTEGER CHECK (ended_offset_ms IS NULL OR ended_offset_ms >= started_offset_ms),
  status TEXT NOT NULL CHECK (status IN ('started', 'succeeded', 'failed', 'cancelled')),
  error_code TEXT CHECK (error_code IS NULL OR error_code IN (
    'TOOL_ARGS_INVALID', 'TOOL_SCOPE_DENIED', 'TOOL_NOT_AVAILABLE_FOR_RECIPE',
    'TOOL_BUDGET_EXCEEDED', 'TOOL_TIMEOUT', 'TOOL_CANCELLED', 'TOOL_INTERNAL_FAILURE'
  )),
  args_json TEXT NOT NULL CHECK (
    json_valid(args_json) AND length(CAST(args_json AS BLOB)) <= 8192
  ),
  args_digest TEXT NOT NULL CHECK (length(args_digest) = 64),
  result_json TEXT CHECK (
    result_json IS NULL OR (json_valid(result_json) AND length(CAST(result_json AS BLOB)) <= 65536)
  ),
  result_digest TEXT CHECK (result_digest IS NULL OR length(result_digest) = 64),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json)),
  counts_json TEXT NOT NULL CHECK (json_valid(counts_json)),
  FOREIGN KEY (interaction_id) REFERENCES formal_agent_interactions(interaction_id) ON DELETE CASCADE,
  UNIQUE (interaction_id, attempt, call_order),
  CHECK ((status IN ('failed', 'cancelled')) = (error_code IS NOT NULL)),
  CHECK ((status = 'cancelled') = (error_code = 'TOOL_CANCELLED')),
  CHECK ((status = 'succeeded') = (result_json IS NOT NULL)),
  CHECK (status = 'started' OR ended_offset_ms IS NOT NULL),
  CHECK (status = 'started' OR result_digest IS NOT NULL OR status IN ('failed', 'cancelled'))
) STRICT;

CREATE TABLE formal_agent_report_presentations (
  session_id TEXT PRIMARY KEY NOT NULL CHECK (length(session_id) BETWEEN 1 AND 160),
  run_id TEXT NOT NULL UNIQUE CHECK (length(run_id) BETWEEN 1 AND 160),
  presented_at INTEGER CHECK (presented_at IS NULL OR presented_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (run_id) REFERENCES formal_agent_runs(run_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX formal_agent_interactions_page
  ON formal_agent_interactions(terminal_at DESC, interaction_id);
CREATE INDEX formal_agent_tool_calls_order
  ON formal_agent_tool_calls(interaction_id, attempt, call_order);
CREATE INDEX personal_context_items_page
  ON personal_context_items(lifecycle, updated_at DESC, memory_id);
CREATE INDEX personal_context_episodes_page
  ON personal_context_episodes(lifecycle, updated_at DESC, episode_id);
`

function checksum (sql) {
  return crypto.createHash('sha256').update(sql, 'utf8').digest('hex')
}

const SUBTITLE_BASE_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    checksum: checksum(INITIAL_SCHEMA_SQL),
    sql: INITIAL_SCHEMA_SQL
  }),
  Object.freeze({
    version: 2,
    checksum: checksum(REFINEMENT_SESSION_RESULTS_SCHEMA_SQL),
    sql: REFINEMENT_SESSION_RESULTS_SCHEMA_SQL
  })
])

/* MIGRATIONS/SCHEMA_VERSION remain the subtitle-only DB0 qualification catalog.
   The product storage worker opts into FORMAL_AGENT_MIGRATIONS explicitly. */
const MIGRATIONS = SUBTITLE_BASE_MIGRATIONS
const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version

const FORMAL_AGENT_MIGRATIONS = Object.freeze([
  ...SUBTITLE_BASE_MIGRATIONS,
  Object.freeze({
    version: SUBTITLE_BASE_MIGRATIONS.length + 1,
    checksum: checksum(FORMAL_AGENT_SCHEMA_SQL),
    sql: FORMAL_AGENT_SCHEMA_SQL
  }),
  Object.freeze({
    version: SUBTITLE_BASE_MIGRATIONS.length + 2,
    checksum: checksum(FORMAL_AGENT_MEMORY_DELETION_SCHEMA_SQL),
    sql: FORMAL_AGENT_MEMORY_DELETION_SCHEMA_SQL
  }),
  Object.freeze({
    version: SUBTITLE_BASE_MIGRATIONS.length + 3,
    checksum: checksum(PERSONAL_CONTEXT_SCHEMA_SQL),
    sql: PERSONAL_CONTEXT_SCHEMA_SQL
  }),
  Object.freeze({
    version: SUBTITLE_BASE_MIGRATIONS.length + 4,
    checksum: checksum(MODEL_ACCESS_SCHEMA_SQL),
    sql: MODEL_ACCESS_SCHEMA_SQL
  }),
  Object.freeze({
    version: SUBTITLE_BASE_MIGRATIONS.length + 5,
    checksum: checksum(AGENT_EXECUTION_SCHEMA_SQL),
    sql: AGENT_EXECUTION_SCHEMA_SQL
  })
])

const FORMAL_AGENT_SCHEMA_VERSION = FORMAL_AGENT_MIGRATIONS[FORMAL_AGENT_MIGRATIONS.length - 1].version

module.exports = {
  INITIAL_SCHEMA_SQL,
  REFINEMENT_SESSION_RESULTS_SCHEMA_SQL,
  FORMAL_AGENT_SCHEMA_SQL,
  FORMAL_AGENT_MEMORY_DELETION_SCHEMA_SQL,
  PERSONAL_CONTEXT_SCHEMA_SQL,
  MODEL_ACCESS_SCHEMA_SQL,
  AGENT_EXECUTION_SCHEMA_SQL,
  SUBTITLE_BASE_MIGRATIONS,
  FORMAL_AGENT_MIGRATIONS,
  MIGRATIONS,
  SCHEMA_VERSION,
  FORMAL_AGENT_SCHEMA_VERSION,
  checksum
}
