'use strict'
// Historical SQL is byte-stable; daily readers only need this catalog.
const history = require('./historical-migrations')
const { RETIREMENT_SQL } = require('./retirement-migration')
const { RECOGNITION_SESSION_SQL } = require('./recognition-session-store')
const { SESSION_EXPERIENCE_SQL } = require('./session-experience-schema')
const { QUESTION_RETRIEVAL_SQL } = require('./question-retrieval-schema')
const { QUESTION_SCOPE_SQL } = require('./question-scope-schema')
const { CANDIDATE_BATCH_SQL } = require('./candidate-batch-schema')
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
/* SEM-F38 / J30-RECOVERY: keep user summary execution budget accounting
   separate from mutable request progress. Existing attempted runs have no
   trustworthy accounting history and are therefore marked unknown. */
const SESSION_SUMMARY_RUN_BUDGET_SQL = `
CREATE TABLE formal_agent_run_budget_state (
  run_id TEXT PRIMARY KEY NOT NULL,
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 80),
  budget_digest TEXT CHECK (budget_digest IS NULL OR length(budget_digest) = 64),
  max_wall_clock_ms INTEGER CHECK (max_wall_clock_ms IS NULL OR max_wall_clock_ms > 0),
  max_requests_per_attempt INTEGER CHECK (max_requests_per_attempt IS NULL OR max_requests_per_attempt > 0),
  settled_elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK (settled_elapsed_ms >= 0),
  conservative_elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK (conservative_elapsed_ms >= 0),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  accounting_known INTEGER NOT NULL CHECK (accounting_known IN (0,1)),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  CHECK ((accounting_known = 0 AND max_wall_clock_ms IS NULL AND max_requests_per_attempt IS NULL) OR
         (accounting_known = 1 AND max_wall_clock_ms IS NOT NULL AND max_requests_per_attempt IS NOT NULL AND budget_digest IS NOT NULL)),
  FOREIGN KEY (run_id) REFERENCES formal_agent_runs(run_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE formal_agent_run_attempt_budgets (
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 160),
  state TEXT NOT NULL CHECK (state IN ('active','settled','interrupted')),
  reserved_elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK (reserved_elapsed_ms >= 0),
  settled_elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK (settled_elapsed_ms >= 0),
  conservative_elapsed_ms INTEGER NOT NULL DEFAULT 0 CHECK (conservative_elapsed_ms >= 0),
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  request_limit INTEGER NOT NULL CHECK (request_limit > 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (run_id, attempt),
  FOREIGN KEY (run_id) REFERENCES formal_agent_runs(run_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE formal_agent_model_request_reservations (
  reservation_id TEXT PRIMARY KEY NOT NULL CHECK (length(reservation_id) = 64),
  run_id TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  request_sequence INTEGER NOT NULL CHECK (request_sequence > 0),
  owner TEXT NOT NULL CHECK (length(owner) BETWEEN 1 AND 160),
  response_received_at INTEGER CHECK (response_received_at IS NULL OR response_received_at >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  UNIQUE (run_id, attempt, request_sequence),
  FOREIGN KEY (run_id, attempt) REFERENCES formal_agent_run_attempt_budgets(run_id, attempt) ON DELETE CASCADE
) STRICT;

CREATE INDEX formal_agent_request_reservations_attempt
  ON formal_agent_model_request_reservations(run_id, attempt, request_sequence);

INSERT INTO formal_agent_run_budget_state(
  run_id,policy_version,budget_digest,max_wall_clock_ms,max_requests_per_attempt,
  settled_elapsed_ms,conservative_elapsed_ms,request_count,accounting_known,created_at,updated_at
)
SELECT run_id,'unknown',NULL,NULL,NULL,0,0,0,0,created_at,updated_at
FROM formal_agent_runs
WHERE session_summary_request_id IS NOT NULL AND attempt_count > 0
  AND state IN ('running','retry_wait');
`
/* SEM-F39/J31: only reproducible plan identity and cumulative counters survive
   a restart. Leaf text and intermediate model output remain process-local. */
const SESSION_SUMMARY_INPUT_PLAN_SQL = `
CREATE TABLE formal_agent_run_input_plans (
  run_id TEXT PRIMARY KEY NOT NULL,
  policy_version TEXT NOT NULL CHECK (length(policy_version) BETWEEN 1 AND 80),
  plan_digest TEXT NOT NULL CHECK (length(plan_digest) = 64),
  input_digest TEXT NOT NULL CHECK (length(input_digest) = 64),
  binding_digest TEXT NOT NULL CHECK (length(binding_digest) = 64),
  leaf_count INTEGER NOT NULL CHECK (leaf_count BETWEEN 1 AND 256),
  node_count INTEGER NOT NULL CHECK (node_count BETWEEN 1 AND 384),
  segment_count INTEGER NOT NULL CHECK (segment_count BETWEEN 1 AND 50000),
  raw_text_bytes INTEGER NOT NULL CHECK (raw_text_bytes BETWEEN 1 AND 4194304),
  canonical_bytes INTEGER NOT NULL CHECK (canonical_bytes BETWEEN 1 AND 8388608),
  usage_known INTEGER NOT NULL DEFAULT 1 CHECK (usage_known IN (0,1)),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
  FOREIGN KEY (run_id) REFERENCES formal_agent_runs(run_id) ON DELETE CASCADE
) STRICT;
`
/* New runs freeze the five-attempt policy. Old rows retain NULL and their
   original max_attempts. Only digests and counts cross the storage boundary. */
const AGENT_RETRY_POLICY_SQL = `
ALTER TABLE formal_agent_runs ADD COLUMN retry_policy_version TEXT;
ALTER TABLE formal_agent_model_request_reservations
  ADD COLUMN operation_digest TEXT CHECK (operation_digest IS NULL OR length(operation_digest) = 64);
ALTER TABLE formal_agent_requests ADD COLUMN retry_request_attempt INTEGER
  CHECK (retry_request_attempt IS NULL OR retry_request_attempt BETWEEN 2 AND 5);
ALTER TABLE formal_agent_requests ADD COLUMN retry_wait_ms INTEGER
  CHECK (retry_wait_ms IS NULL OR retry_wait_ms BETWEEN 0 AND 1000);
ALTER TABLE formal_agent_requests ADD COLUMN retry_reason TEXT;
CREATE INDEX formal_agent_model_operation_count
  ON formal_agent_model_request_reservations(run_id, operation_digest);
CREATE INDEX formal_agent_tool_operation_count
  ON formal_agent_tool_calls(interaction_id, tool_name, args_digest);
CREATE TABLE formal_agent_model_operation_attempts (
  run_id TEXT NOT NULL REFERENCES formal_agent_runs(run_id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  request_sequence INTEGER NOT NULL CHECK (request_sequence > 0),
  owner TEXT NOT NULL,
  operation_digest TEXT NOT NULL CHECK (length(operation_digest) = 64),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  PRIMARY KEY (run_id, attempt, request_sequence)
) STRICT;
CREATE INDEX formal_agent_model_operation_attempt_count
  ON formal_agent_model_operation_attempts(run_id, operation_digest);
`
const SUMMARY_LONG_INPUT_SQL = `
ALTER TABLE formal_agent_runs ADD COLUMN summary_input_policy TEXT
  CHECK (summary_input_policy IS NULL OR summary_input_policy='summary-long-input@1');
ALTER TABLE formal_agent_model_request_reservations ADD COLUMN usage_json TEXT;
`
// SEM-F31/F33/J22-QA-SIZE: old CHECK constraints and migration bytes stay frozen.
const QA_INPUT_LIMIT_ERROR_SQL = `
ALTER TABLE formal_agent_runs ADD COLUMN qa_input_limit_error INTEGER NOT NULL DEFAULT 0
  CHECK (qa_input_limit_error IN (0,1));
ALTER TABLE formal_agent_interactions ADD COLUMN qa_input_limit_error INTEGER NOT NULL DEFAULT 0
  CHECK (qa_input_limit_error IN (0,1));
`
const PERSONAL_MEMORY_QUESTION_SQL = `
CREATE TABLE personal_context_question_evidence (
  identity_hash TEXT NOT NULL CHECK (length(identity_hash)=64),
  prompt_digest TEXT NOT NULL CHECK (length(prompt_digest)=64),
  ingest_run_id TEXT NOT NULL REFERENCES formal_agent_runs(run_id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES personal_context_episodes(episode_id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL CHECK (created_at>=0),
  PRIMARY KEY (identity_hash,prompt_digest)
) STRICT;
`
const PERSONAL_MEMORY_ASSOCIATION_SQL = `
CREATE TABLE personal_context_ingest_inputs (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES formal_agent_runs(run_id) ON DELETE CASCADE,
  memories_json TEXT NOT NULL CHECK (json_valid(memories_json) AND length(CAST(memories_json AS BLOB))<=8192)
) STRICT;
CREATE TABLE personal_context_session_associations (
  association_id TEXT PRIMARY KEY NOT NULL,
  episode_id TEXT NOT NULL REFERENCES personal_context_episodes(episode_id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES personal_context_items(memory_id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL,
  match_keys_json TEXT NOT NULL CHECK (json_valid(match_keys_json)),
  relation TEXT NOT NULL CHECK (length(relation) BETWEEN 1 AND 300),
  source_ref_json TEXT NOT NULL CHECK (json_valid(source_ref_json)),
  created_at INTEGER NOT NULL CHECK (created_at>=0)
) STRICT;
CREATE INDEX personal_context_association_memory ON personal_context_session_associations(memory_id,revision_id);
UPDATE personal_context_items SET lifecycle='conflicted'
WHERE origin='inferred' AND scope_id IN (SELECT scope_id FROM personal_context_scopes WHERE kind='global');
`
const PERSONAL_MEMORY_OVERVIEW_SQL = `
CREATE TABLE personal_context_overviews (
  scope_key TEXT PRIMARY KEY NOT NULL,
  scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
  target_revision INTEGER NOT NULL CHECK (target_revision>=0),
  cursor_json TEXT NOT NULL CHECK (json_valid(cursor_json)),
  current_json TEXT CHECK (current_json IS NULL OR (json_valid(current_json) AND length(CAST(current_json AS BLOB))<=32768)),
  previous_json TEXT CHECK (previous_json IS NULL OR (json_valid(previous_json) AND length(CAST(previous_json AS BLOB))<=32768)),
  run_id TEXT REFERENCES formal_agent_runs(run_id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL CHECK (updated_at>=0)
) STRICT;
CREATE TABLE personal_context_overview_jobs (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES formal_agent_runs(run_id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL REFERENCES personal_context_overviews(scope_key) ON DELETE CASCADE,
  expected_revision INTEGER NOT NULL CHECK (expected_revision>=0),
  input_digest TEXT NOT NULL CHECK (length(input_digest)=64),
  refs_json TEXT NOT NULL CHECK (json_valid(refs_json) AND length(CAST(refs_json AS BLOB))<=65536)
) STRICT;
`
const { PERSONAL_MEMORY_FILE_SQL, PERSONAL_MEMORY_INDEX_SQL, PERSONAL_MEMORY_PORTABILITY_SQL, PERSONAL_MEMORY_CLEANUP_SQL } = require('./personal-memory-file-schema')
const FORMAL_AGENT_MIGRATIONS = Object.freeze([
  ...history.FORMAL_AGENT_MIGRATIONS,
  Object.freeze({ version: 10, sql: RETIREMENT_SQL, checksum: history.checksum(RETIREMENT_SQL) }),
  Object.freeze({ version: 11, sql: SUMMARY_POLICY_SQL, checksum: history.checksum(SUMMARY_POLICY_SQL) }),
  Object.freeze({ version: 12, sql: SUMMARY_MEMORY_ERROR_SQL, checksum: history.checksum(SUMMARY_MEMORY_ERROR_SQL) }),
  Object.freeze({ version: 13, sql: RECOGNITION_SESSION_SQL, checksum: history.checksum(RECOGNITION_SESSION_SQL) }),
  Object.freeze({ version: 14, sql: SUMMARY_INPUT_LIMIT_ERROR_SQL, checksum: history.checksum(SUMMARY_INPUT_LIMIT_ERROR_SQL) }),
  Object.freeze({ version: 15, sql: SESSION_SUMMARY_REQUEST_SQL, checksum: history.checksum(SESSION_SUMMARY_REQUEST_SQL) }),
  Object.freeze({ version: 16, sql: SESSION_SUMMARY_INPUT_IDENTITY_SQL, checksum: history.checksum(SESSION_SUMMARY_INPUT_IDENTITY_SQL) }),
  Object.freeze({ version: 17, sql: SESSION_SUMMARY_RUN_BUDGET_SQL, checksum: history.checksum(SESSION_SUMMARY_RUN_BUDGET_SQL) }),
  Object.freeze({ version: 18, sql: SESSION_SUMMARY_INPUT_PLAN_SQL, checksum: history.checksum(SESSION_SUMMARY_INPUT_PLAN_SQL) }),
  Object.freeze({ version: 19, sql: AGENT_RETRY_POLICY_SQL, checksum: history.checksum(AGENT_RETRY_POLICY_SQL) }),
  Object.freeze({ version: 20, sql: SUMMARY_LONG_INPUT_SQL, checksum: history.checksum(SUMMARY_LONG_INPUT_SQL) }),
  Object.freeze({ version: 21, sql: QA_INPUT_LIMIT_ERROR_SQL, checksum: history.checksum(QA_INPUT_LIMIT_ERROR_SQL) }),
  Object.freeze({ version: 22, sql: PERSONAL_MEMORY_QUESTION_SQL, checksum: history.checksum(PERSONAL_MEMORY_QUESTION_SQL) }),
  Object.freeze({ version: 23, sql: PERSONAL_MEMORY_ASSOCIATION_SQL, checksum: history.checksum(PERSONAL_MEMORY_ASSOCIATION_SQL) }),
  Object.freeze({ version: 24, sql: PERSONAL_MEMORY_OVERVIEW_SQL, checksum: history.checksum(PERSONAL_MEMORY_OVERVIEW_SQL) }),
  Object.freeze({ version: 25, sql: SESSION_EXPERIENCE_SQL, checksum: history.checksum(SESSION_EXPERIENCE_SQL) }),
  Object.freeze({ version: 26, sql: QUESTION_RETRIEVAL_SQL, checksum: history.checksum(QUESTION_RETRIEVAL_SQL) }),
  Object.freeze({ version: 27, sql: QUESTION_SCOPE_SQL, checksum: history.checksum(QUESTION_SCOPE_SQL) }),
  Object.freeze({ version: 28, sql: CANDIDATE_BATCH_SQL, checksum: history.checksum(CANDIDATE_BATCH_SQL) }),
  Object.freeze({ version: 29, sql: PERSONAL_MEMORY_FILE_SQL, checksum: history.checksum(PERSONAL_MEMORY_FILE_SQL) }),
  Object.freeze({ version: 30, sql: PERSONAL_MEMORY_INDEX_SQL, checksum: history.checksum(PERSONAL_MEMORY_INDEX_SQL) }),
  Object.freeze({ version: 31, sql: PERSONAL_MEMORY_PORTABILITY_SQL, checksum: history.checksum(PERSONAL_MEMORY_PORTABILITY_SQL) }),
  Object.freeze({ version: 32, sql: PERSONAL_MEMORY_CLEANUP_SQL, checksum: history.checksum(PERSONAL_MEMORY_CLEANUP_SQL) })
])
module.exports = {
  ...history,
  SUMMARY_POLICY_SQL,
  SUMMARY_MEMORY_ERROR_SQL,
  SUMMARY_INPUT_LIMIT_ERROR_SQL,
  QA_INPUT_LIMIT_ERROR_SQL,
  SESSION_SUMMARY_REQUEST_SQL,
  SESSION_SUMMARY_INPUT_IDENTITY_SQL,
  SESSION_SUMMARY_RUN_BUDGET_SQL,
  SESSION_SUMMARY_INPUT_PLAN_SQL,
  AGENT_RETRY_POLICY_SQL,
  FORMAL_AGENT_MIGRATIONS,
  FORMAL_AGENT_SCHEMA_VERSION: 32
}
