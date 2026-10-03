'use strict'

const QUESTION_SCOPE_SQL = `
CREATE TABLE formal_agent_question_scopes (
  input_digest TEXT PRIMARY KEY NOT NULL CHECK(length(input_digest)=64),
  scope_json TEXT NOT NULL CHECK(json_valid(scope_json)),
  source_count INTEGER NOT NULL CHECK(source_count>0),
  created_at INTEGER NOT NULL CHECK(created_at>=0)
) STRICT;
CREATE TABLE formal_agent_question_scope_sources (
  input_digest TEXT NOT NULL REFERENCES formal_agent_question_scopes(input_digest) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0),
  session_id TEXT NOT NULL,
  source_digest TEXT NOT NULL CHECK(length(source_digest)=64),
  watermark INTEGER NOT NULL CHECK(watermark>0),
  PRIMARY KEY(input_digest,ordinal), UNIQUE(input_digest,session_id)
) STRICT;
CREATE TABLE formal_agent_question_evidence_pages (
  run_id TEXT NOT NULL REFERENCES formal_agent_runs(run_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<256),
  descriptor_json TEXT NOT NULL CHECK(json_valid(descriptor_json) AND length(CAST(descriptor_json AS BLOB))<=65536),
  evidence_digest TEXT NOT NULL CHECK(length(evidence_digest)=64),
  PRIMARY KEY(run_id,ordinal)
) STRICT;
`

module.exports = { QUESTION_SCOPE_SQL }
