'use strict'
// Historical SQL is byte-stable; daily readers only need this catalog.
const history = require('./historical-migrations')
const { RETIREMENT_SQL } = require('./retirement-migration')
const { RECOGNITION_SESSION_SQL } = require('./recognition-session-store')
/* Existing summaries predate this fact.  NULL therefore means "未记录是否参考记忆";
   new summary runs always write an explicit 0/1 value. */
const SUMMARY_POLICY_SQL = 'ALTER TABLE formal_agent_runs ADD COLUMN summary_use_memory INTEGER CHECK (summary_use_memory IN (0,1));'
/* SQLite CHECK constraints in the frozen v5/v7 tables cannot be widened in
   place.  Store the new public summary-memory failure beside the legacy
   terminal error and project it back at the execution boundary. */
const SUMMARY_MEMORY_ERROR_SQL = `
ALTER TABLE formal_agent_runs
  ADD COLUMN summary_memory_error INTEGER NOT NULL DEFAULT 0 CHECK (summary_memory_error IN (0,1));
ALTER TABLE formal_agent_interactions
  ADD COLUMN summary_memory_error INTEGER NOT NULL DEFAULT 0 CHECK (summary_memory_error IN (0,1));
`
/* Keep a precise legacy summary-input failure without widening frozen v5/v7
   error-code CHECK constraints. */
const SUMMARY_INPUT_LIMIT_ERROR_SQL = `
ALTER TABLE formal_agent_runs
  ADD COLUMN summary_input_limit_error INTEGER NOT NULL DEFAULT 0 CHECK (summary_input_limit_error IN (0,1));
ALTER TABLE formal_agent_interactions
  ADD COLUMN summary_input_limit_error INTEGER NOT NULL DEFAULT 0 CHECK (summary_input_limit_error IN (0,1));
`
const SESSION_SUMMARY_REQUEST_SQL = `
CREATE TABLE formal_agent_requests (
  request_id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL,
  client_key_digest TEXT NOT NULL UNIQUE CHECK (length(client_key_digest) = 64),
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  scope_digest TEXT NOT NULL CHECK (length(scope_digest) = 64),
  prompt_digest TEXT NOT NULL CHECK (length(prompt_digest) = 64),
  action TEXT NOT NULL CHECK (action IN ('summary','question')),
  summary_use_memory INTEGER CHECK (summary_use_memory IN (0,1)),
  state TEXT NOT NULL CHECK (state IN ('accepted','preparing','routing','queued','running','retry_wait','cancelling','succeeded','failed','cancelled')),
  phase TEXT NOT NULL CHECK (phase IN ('accepted','preparing','waiting_model','reading_context','reducing','validating','retry_wait','cancelling','terminal')),
  generation INTEGER NOT NULL CHECK (generation > 0),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  route_run_id TEXT REFERENCES formal_agent_runs(run_id) ON DELETE SET NULL,
  target_run_id TEXT REFERENCES formal_agent_runs(run_id) ON DELETE SET NULL,
  cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0,1)),
  resume_required INTEGER NOT NULL CHECK (resume_required IN (0,1)),
  attempt INTEGER NOT NULL CHECK (attempt >= 0),
  elapsed_ms INTEGER NOT NULL CHECK (elapsed_ms >= 0),
  last_activity_elapsed_ms INTEGER NOT NULL CHECK (last_activity_elapsed_ms >= 0),
  validated_chunk_count INTEGER CHECK (validated_chunk_count IS NULL OR validated_chunk_count >= 0),
  total_chunk_count INTEGER CHECK (total_chunk_count IS NULL OR total_chunk_count >= 0),
  memory_state TEXT NOT NULL CHECK (memory_state IN ('not_read','not_used','empty','referenced','failed','unknown')),
  error_code TEXT,
  budget_axis TEXT,
  budget_actual INTEGER CHECK (budget_actual IS NULL OR budget_actual >= 0),
  budget_limit INTEGER CHECK (budget_limit IS NULL OR budget_limit >= 0),
  diagnostics_available INTEGER NOT NULL CHECK (diagnostics_available IN (0,1)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  CHECK ((action = 'summary' AND summary_use_memory IS NOT NULL AND summary_use_memory IN (0,1)) OR
         (action = 'question' AND summary_use_memory IS NULL)),
  CHECK ((validated_chunk_count IS NULL AND total_chunk_count IS NULL) OR
         (validated_chunk_count IS NOT NULL AND total_chunk_count IS NOT NULL AND validated_chunk_count <= total_chunk_count)),
  CHECK ((budget_axis IS NULL AND budget_actual IS NULL AND budget_limit IS NULL) OR
         (budget_axis IS NOT NULL AND budget_actual IS NOT NULL AND budget_limit IS NOT NULL))
) STRICT;
CREATE TABLE formal_agent_request_tombstones (
  client_key_digest TEXT PRIMARY KEY NOT NULL CHECK (length(client_key_digest) = 64),
  request_id_digest TEXT NOT NULL UNIQUE CHECK (length(request_id_digest) = 64),
  session_id TEXT NOT NULL,
  request_digest TEXT NOT NULL CHECK (length(request_digest) = 64),
  deleted_at INTEGER NOT NULL CHECK (deleted_at >= 0)
) STRICT;
CREATE INDEX formal_agent_requests_state ON formal_agent_requests(state, updated_at, request_id);
CREATE INDEX formal_agent_requests_route ON formal_agent_requests(route_run_id);
CREATE UNIQUE INDEX formal_agent_requests_target ON formal_agent_requests(target_run_id) WHERE target_run_id IS NOT NULL;
ALTER TABLE formal_agent_runs
  ADD COLUMN session_summary_request_id TEXT REFERENCES formal_agent_requests(request_id) ON DELETE SET NULL;
ALTER TABLE formal_agent_runs
  ADD COLUMN resume_required INTEGER NOT NULL DEFAULT 0 CHECK (resume_required IN (0,1));
ALTER TABLE session_deletion_tombstones
  ADD COLUMN deleted_summary_request_count INTEGER NOT NULL DEFAULT 0 CHECK (deleted_summary_request_count >= 0);
`;
/* A durable acceptance must retain the exact input identity so a retry after
   a lost receipt cannot re-read a changed transcript. */
const SESSION_SUMMARY_INPUT_IDENTITY_SQL = `
ALTER TABLE formal_agent_requests ADD COLUMN input_watermark_json TEXT;
ALTER TABLE formal_agent_requests
  ADD COLUMN transcript_version TEXT CHECK (transcript_version IS NULL OR transcript_version IN ('raw','refined'));
ALTER TABLE formal_agent_requests
  ADD COLUMN input_digest TEXT CHECK (input_digest IS NULL OR length(input_digest) = 64);
UPDATE formal_agent_requests SET state='failed',phase='terminal',error_code='AGENT_RUN_UNAVAILABLE',
  revision=revision+1
WHERE input_watermark_json IS NULL AND transcript_version IS NULL AND input_digest IS NULL
  AND route_run_id IS NULL AND target_run_id IS NULL
  AND state IN ('accepted','preparing','routing','queued','retry_wait');
`
const FORMAL_AGENT_MIGRATIONS = Object.freeze([
  ...history.FORMAL_AGENT_MIGRATIONS,
  Object.freeze({ version: 10, sql: RETIREMENT_SQL, checksum: history.checksum(RETIREMENT_SQL) }),
  Object.freeze({ version: 11, sql: SUMMARY_POLICY_SQL, checksum: history.checksum(SUMMARY_POLICY_SQL) }),
  Object.freeze({ version: 12, sql: SUMMARY_MEMORY_ERROR_SQL, checksum: history.checksum(SUMMARY_MEMORY_ERROR_SQL) }),
  Object.freeze({ version: 13, sql: RECOGNITION_SESSION_SQL, checksum: history.checksum(RECOGNITION_SESSION_SQL) }),
  Object.freeze({ version: 14, sql: SUMMARY_INPUT_LIMIT_ERROR_SQL, checksum: history.checksum(SUMMARY_INPUT_LIMIT_ERROR_SQL) }),
  Object.freeze({ version: 15, sql: SESSION_SUMMARY_REQUEST_SQL, checksum: history.checksum(SESSION_SUMMARY_REQUEST_SQL) }),
  Object.freeze({ version: 16, sql: SESSION_SUMMARY_INPUT_IDENTITY_SQL, checksum: history.checksum(SESSION_SUMMARY_INPUT_IDENTITY_SQL) })
])
module.exports = {
  ...history,
  SUMMARY_POLICY_SQL,
  SUMMARY_MEMORY_ERROR_SQL,
  SUMMARY_INPUT_LIMIT_ERROR_SQL,
  SESSION_SUMMARY_REQUEST_SQL,
  SESSION_SUMMARY_INPUT_IDENTITY_SQL,
  FORMAL_AGENT_MIGRATIONS,
  FORMAL_AGENT_SCHEMA_VERSION: 16
}
