'use strict'
const CANDIDATE_BATCH_SQL = `
CREATE TABLE personal_context_candidate_batches (
  batch_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL UNIQUE REFERENCES formal_agent_runs(run_id) ON DELETE CASCADE,
  scope_key TEXT NOT NULL,
  input_revision INTEGER NOT NULL CHECK(input_revision>=0),
  refs_json TEXT NOT NULL CHECK(json_valid(refs_json)),
  consumed_at INTEGER CHECK(consumed_at>=0)
) STRICT;
CREATE TABLE personal_context_candidate_consumptions (
  scope_key TEXT NOT NULL,
  memory_id TEXT NOT NULL REFERENCES personal_context_items(memory_id) ON DELETE CASCADE,
  revision_id TEXT NOT NULL REFERENCES personal_context_revisions(revision_id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL REFERENCES personal_context_candidate_batches(batch_id) ON DELETE CASCADE,
  PRIMARY KEY(scope_key,memory_id,revision_id)
) STRICT;
`
module.exports = { CANDIDATE_BATCH_SQL }
