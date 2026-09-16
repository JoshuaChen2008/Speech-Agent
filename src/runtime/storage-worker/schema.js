'use strict'
// Historical SQL is byte-stable; daily readers only need this catalog.
const history = require('./historical-migrations')
const { RETIREMENT_SQL } = require('./retirement-migration')
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
const FORMAL_AGENT_MIGRATIONS = Object.freeze([
  ...history.FORMAL_AGENT_MIGRATIONS,
  Object.freeze({ version: 10, sql: RETIREMENT_SQL, checksum: history.checksum(RETIREMENT_SQL) }),
  Object.freeze({ version: 11, sql: SUMMARY_POLICY_SQL, checksum: history.checksum(SUMMARY_POLICY_SQL) }),
  Object.freeze({ version: 12, sql: SUMMARY_MEMORY_ERROR_SQL, checksum: history.checksum(SUMMARY_MEMORY_ERROR_SQL) })
])
module.exports = {
  ...history,
  SUMMARY_POLICY_SQL,
  SUMMARY_MEMORY_ERROR_SQL,
  FORMAL_AGENT_MIGRATIONS,
  FORMAL_AGENT_SCHEMA_VERSION: 12
}
