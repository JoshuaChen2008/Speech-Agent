'use strict'

// Independently committed range products, never Agent Loop intermediate output.
const SESSION_EXPERIENCE_SQL = `
CREATE TABLE personal_context_experience_ranges (
  range_id TEXT PRIMARY KEY NOT NULL,
  run_id TEXT NOT NULL REFERENCES formal_agent_runs(run_id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES personal_context_episodes(episode_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 255),
  plan_digest TEXT NOT NULL CHECK (length(plan_digest)=64),
  parts_json TEXT NOT NULL CHECK (json_valid(parts_json) AND length(CAST(parts_json AS BLOB))<=65536),
  product_digest TEXT NOT NULL CHECK (length(product_digest)=64),
  experience_count INTEGER NOT NULL CHECK (experience_count BETWEEN 0 AND 64),
  created_at INTEGER NOT NULL CHECK (created_at>=0),
  UNIQUE(run_id,ordinal)
) STRICT;
CREATE TABLE personal_context_experiences (
  experience_id TEXT PRIMARY KEY NOT NULL,
  range_id TEXT NOT NULL REFERENCES personal_context_experience_ranges(range_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 63),
  kind TEXT NOT NULL CHECK (kind IN ('decision','conclusion','todo','risk','topic','event')),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 600),
  confidence TEXT NOT NULL CHECK (confidence IN ('low','medium','high')),
  source_ref_json TEXT NOT NULL CHECK (json_valid(source_ref_json)),
  source_parts_json TEXT NOT NULL CHECK (json_valid(source_parts_json) AND length(CAST(source_parts_json AS BLOB))<=65536),
  occurred_from_offset_ms INTEGER NOT NULL CHECK (occurred_from_offset_ms>=0),
  occurred_through_offset_ms INTEGER NOT NULL CHECK (occurred_through_offset_ms>=occurred_from_offset_ms),
  UNIQUE(range_id,ordinal)
) STRICT;
CREATE INDEX personal_context_experience_episode ON personal_context_experience_ranges(episode_id,ordinal);
CREATE INDEX personal_context_experience_kind ON personal_context_experiences(kind,range_id);
`

module.exports = { SESSION_EXPERIENCE_SQL }
