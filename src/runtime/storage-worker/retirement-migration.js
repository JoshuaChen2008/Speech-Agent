'use strict'
// Exact retirement set, in child-before-parent order. Never expand by prefix.
const RETIRED_TABLES = Object.freeze([
  'recognition_session_configs', 'recognition_term_set_members', 'recognition_terms',
  'recognition_term_sets', 'agent_debug_messages', 'agent_debug_threads',
  'memory_evidence', 'memory_suppressions', 'memory_deletion_receipts',
  'memory_revisions', 'memory_items', 'memory_scopes',
  'agent_artifacts', 'agent_claim_receipts', 'agent_jobs'
])
const RETIRED_TRIGGERS = Object.freeze([
  'memory_revision_requires_memory_job_insert',
  'memory_revision_requires_memory_job_update',
  'recognition_term_set_member_snapshot_insert',
  'recognition_term_set_member_immutable',
  'recognition_term_set_member_reject_delete',
  'agent_debug_message_provider_pair_insert',
  'agent_debug_message_provider_pair_update'
])
const RETIREMENT_SQL = RETIRED_TRIGGERS.map(trigger => 'DROP TRIGGER IF EXISTS ' + trigger + ';').join('\n') + `
UPDATE memory_items SET current_revision_id = NULL;
UPDATE memory_revisions SET previous_revision_id = NULL;
UPDATE agent_artifacts SET supersedes_artifact_id = NULL;
` + RETIRED_TABLES.map(table => 'DELETE FROM ' + table + ';').join('\n') + '\n' +
RETIRED_TABLES.map(table => 'DROP TABLE ' + table + ';').join('\n') + '\n'
module.exports = { RETIRED_TABLES, RETIRED_TRIGGERS, RETIREMENT_SQL }
