'use strict'

const { SUBTITLE_BASE_MIGRATIONS, checksum } = require('../../runtime/storage-worker/schema')

const AGENT_MVP_SCHEMA_SQL = `
CREATE TABLE agent_jobs (
  job_id TEXT PRIMARY KEY NOT NULL CHECK (length(job_id) BETWEEN 1 AND 160),
  run_id TEXT NOT NULL UNIQUE CHECK (length(run_id) BETWEEN 1 AND 160),
  dedupe_key TEXT UNIQUE CHECK (dedupe_key IS NULL OR length(dedupe_key) = 64),
  client_idempotency_key TEXT UNIQUE CHECK (client_idempotency_key IS NULL OR length(client_idempotency_key) BETWEEN 1 AND 160),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  session_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL CHECK (plugin_id = 'reference-structured-output'),
  artifact_kind TEXT NOT NULL CHECK (artifact_kind = 'reference-output'),
  transcript_version TEXT NOT NULL CHECK (transcript_version IN ('original', 'refined')),
  input_watermark INTEGER NOT NULL CHECK (input_watermark >= 1),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  recipe_version TEXT NOT NULL CHECK (length(recipe_version) BETWEEN 1 AND 80),
  provider TEXT NOT NULL CHECK (provider IN ('openai-compatible', 'deterministic-test')),
  model TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 160),
  state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed', 'cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 3),
  next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
  lease_owner TEXT,
  lease_expires_at INTEGER,
  cancel_requested_at INTEGER,
  error_code TEXT CHECK (error_code IS NULL OR error_code IN ('AGENT_PROVIDER_AUTH_FAILED','AGENT_PROVIDER_RATE_LIMITED','AGENT_PROVIDER_TIMEOUT','AGENT_PROVIDER_UNAVAILABLE','AGENT_OUTPUT_INVALID','AGENT_PERMISSION_DENIED','AGENT_REQUEST_INVALID','AGENT_WORKER_EXITED','AGENT_INTERNAL_FAILURE')),
  requested_by TEXT NOT NULL CHECK (requested_by IN ('automatic', 'user')),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE RESTRICT,
  CHECK ((state = 'running') = (lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK ((requested_by = 'automatic' AND dedupe_key IS NOT NULL AND client_idempotency_key IS NULL) OR
         (requested_by = 'user' AND dedupe_key IS NULL AND client_idempotency_key IS NOT NULL))
) STRICT;

CREATE TABLE agent_artifacts (
  artifact_id TEXT PRIMARY KEY NOT NULL CHECK (length(artifact_id) BETWEEN 1 AND 160),
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  plugin_id TEXT NOT NULL CHECK (plugin_id = 'reference-structured-output'),
  type TEXT NOT NULL CHECK (type = 'reference-output'),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  content_digest TEXT NOT NULL CHECK (length(content_digest) = 64),
  transcript_version TEXT NOT NULL CHECK (transcript_version IN ('original', 'refined')),
  input_watermark INTEGER NOT NULL CHECK (input_watermark >= 1),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  recipe_version TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  supersedes_artifact_id TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (run_id) REFERENCES agent_jobs(run_id) ON DELETE RESTRICT,
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE RESTRICT,
  FOREIGN KEY (supersedes_artifact_id) REFERENCES agent_artifacts(artifact_id) ON DELETE RESTRICT,
  UNIQUE (run_id, plugin_id, type)
) STRICT;

CREATE TABLE agent_debug_threads (
  thread_id TEXT PRIMARY KEY NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 160),
  session_id TEXT NOT NULL,
  transcript_version TEXT NOT NULL CHECK (transcript_version IN ('original', 'refined')),
  input_watermark INTEGER NOT NULL CHECK (input_watermark >= 1),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE agent_debug_messages (
  message_order INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL UNIQUE CHECK (length(message_id) BETWEEN 1 AND 160),
  thread_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','tool_preview','tool_confirmation','tool_result','status')),
  content_json TEXT NOT NULL CHECK (json_valid(content_json)),
  provider TEXT,
  model TEXT,
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  FOREIGN KEY (thread_id) REFERENCES agent_debug_threads(thread_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX agent_jobs_claim ON agent_jobs(state, next_attempt_at, created_at);
CREATE INDEX agent_jobs_session ON agent_jobs(session_id, created_at);
CREATE INDEX agent_artifacts_session ON agent_artifacts(session_id, created_at);
CREATE INDEX agent_debug_messages_thread ON agent_debug_messages(thread_id, message_order);
`

const AGENT_MVP_MIGRATIONS = Object.freeze([
  ...SUBTITLE_BASE_MIGRATIONS,
  Object.freeze({ version: SUBTITLE_BASE_MIGRATIONS.length + 1, sql: AGENT_MVP_SCHEMA_SQL, checksum: checksum(AGENT_MVP_SCHEMA_SQL) })
])

module.exports = { AGENT_MVP_MIGRATIONS, AGENT_MVP_SCHEMA_SQL }
