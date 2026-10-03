'use strict'

const PERSONAL_MEMORY_FILE_SQL = `
CREATE TABLE personal_memory_roots (root_id TEXT PRIMARY KEY, active INTEGER NOT NULL CHECK(active IN (0,1))) STRICT;
CREATE UNIQUE INDEX personal_memory_one_root ON personal_memory_roots(active) WHERE active=1;
CREATE TABLE personal_memory_files (
  memory_id TEXT PRIMARY KEY REFERENCES personal_context_items(memory_id) ON DELETE CASCADE,
  root_id TEXT NOT NULL REFERENCES personal_memory_roots(root_id),
  relative_name TEXT NOT NULL, content_hash TEXT NOT NULL, byte_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('ready','pending','missing','invalid','conflict','writing','recovery')),
  missing_since INTEGER, attributes_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE TABLE personal_memory_file_operations (
  operation_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, memory_id TEXT NOT NULL,
  relative_name TEXT NOT NULL, operation TEXT NOT NULL,
  old_hash TEXT NOT NULL, target_hash TEXT NOT NULL, content_hash TEXT NOT NULL,
  kind TEXT NOT NULL, scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  item_revision INTEGER NOT NULL, previous_revision TEXT,
  phase TEXT NOT NULL CHECK(phase IN ('prepared','committed','aborted','recovery')),
  created_at INTEGER NOT NULL
) STRICT;
CREATE TABLE personal_memory_file_tombstones (
  memory_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
`
const PERSONAL_MEMORY_INDEX_SQL = `
CREATE TABLE personal_memory_index_documents (
  memory_id TEXT PRIMARY KEY REFERENCES personal_context_items(memory_id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL, content_hash TEXT NOT NULL, policy TEXT NOT NULL,
  text TEXT NOT NULL CHECK(length(CAST(text AS BLOB))<=2048)
) STRICT;
CREATE TABLE personal_memory_index_generations (
  generation_id TEXT PRIMARY KEY, binding_json TEXT NOT NULL CHECK(json_valid(binding_json)),
  dimensions INTEGER CHECK(dimensions BETWEEN 1 AND 4096),
  state TEXT NOT NULL CHECK(state IN ('building','active','retired','cancelled'))
) STRICT;
CREATE UNIQUE INDEX personal_memory_active_generation ON personal_memory_index_generations(state) WHERE state='active';
CREATE TABLE personal_memory_vectors (
  generation_id TEXT NOT NULL REFERENCES personal_memory_index_generations(generation_id) ON DELETE CASCADE,
  memory_id TEXT NOT NULL REFERENCES personal_context_items(memory_id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL, content_hash TEXT NOT NULL,
  dimensions INTEGER NOT NULL CHECK(dimensions BETWEEN 1 AND 4096),
  vector BLOB NOT NULL CHECK(length(vector)=dimensions*4),
  PRIMARY KEY(generation_id,memory_id)
) STRICT;
CREATE TABLE agent_embedding_config (
  singleton_key INTEGER PRIMARY KEY CHECK(singleton_key=1), revision INTEGER NOT NULL,
  https_origin TEXT, base_path TEXT, model_id TEXT,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)), disclosure_accepted INTEGER NOT NULL CHECK(disclosure_accepted IN (0,1)),
  credential_slot_id TEXT NOT NULL, credential_persistence TEXT NOT NULL CHECK(credential_persistence IN ('absent','persistent','session_only')),
  credential_generation TEXT
) STRICT;
CREATE TABLE agent_embedding_bindings (
  job_id TEXT PRIMARY KEY, input_digest TEXT NOT NULL, binding_json TEXT NOT NULL CHECK(json_valid(binding_json))
) STRICT;
`
const PERSONAL_MEMORY_PORTABILITY_SQL = `
CREATE TABLE personal_memory_portable_records (
  record_key TEXT PRIMARY KEY, record_type TEXT NOT NULL CHECK(record_type IN ('source','suppression','lifecycle')),
  memory_id TEXT, content_hash TEXT,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(CAST(payload_json AS BLOB))<=4096)
) STRICT;
CREATE INDEX personal_memory_portable_memory ON personal_memory_portable_records(memory_id,record_type);
`
const PERSONAL_MEMORY_CLEANUP_SQL = `
CREATE TABLE personal_memory_file_cleanup (
  memory_id TEXT PRIMARY KEY, root_id TEXT NOT NULL, relative_name TEXT NOT NULL,
  byte_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','conflict'))
) STRICT;
`
module.exports = { PERSONAL_MEMORY_FILE_SQL, PERSONAL_MEMORY_INDEX_SQL, PERSONAL_MEMORY_PORTABILITY_SQL, PERSONAL_MEMORY_CLEANUP_SQL }
