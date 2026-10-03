'use strict'

const QUESTION_RETRIEVAL_SQL = `
CREATE TABLE formal_agent_question_evidence (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES formal_agent_runs(run_id) ON DELETE CASCADE,
  query_digest TEXT NOT NULL CHECK (length(query_digest)=64),
  evidence_digest TEXT NOT NULL CHECK (length(evidence_digest)=64),
  descriptor_json TEXT NOT NULL CHECK (json_valid(descriptor_json) AND length(CAST(descriptor_json AS BLOB))<=65536),
  source_refs_json TEXT NOT NULL CHECK (json_valid(source_refs_json) AND length(CAST(source_refs_json AS BLOB))<=65536),
  coverage_json TEXT NOT NULL CHECK (json_valid(coverage_json) AND length(CAST(coverage_json AS BLOB))<=8192),
  created_at INTEGER NOT NULL CHECK (created_at>=0)
) STRICT;
`

module.exports = { QUESTION_RETRIEVAL_SQL }
