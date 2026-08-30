'use strict'

const S1_RECIPE_IDS = Object.freeze(['context.ingest.session'])

const FORMAL_AGENT_TASK_ERROR_CODES = Object.freeze([
  'AGENT_PROVIDER_AUTH_FAILED',
  'AGENT_PROVIDER_RATE_LIMITED',
  'AGENT_PROVIDER_UNAVAILABLE',
  'AGENT_PROVIDER_TIMEOUT',
  'AGENT_OUTPUT_INVALID',
  'AGENT_PERMISSION_DENIED',
  'AGENT_REQUEST_INVALID',
  'AGENT_WORKER_EXITED',
  'AGENT_INTERNAL_FAILURE',
  'AGENT_BUDGET_EXCEEDED'
])

const AGENT_PROCESSING_ELIGIBILITIES = Object.freeze([
  'ready',
  'no_committed_transcript',
  'outside_automatic_window',
  'agent_disabled',
  'provider_not_configured',
  'cloud_disclosure_required',
  'credential_unavailable',
  'local_model_not_ready',
  'session_not_terminal'
])

const PERSONAL_CONTEXT_MANAGE_COMMANDS = Object.freeze([
  'view',
  'remember',
  'update',
  'forget',
  'delete',
  'set_processing'
])

module.exports = {
  AGENT_PROCESSING_ELIGIBILITIES,
  FORMAL_AGENT_TASK_ERROR_CODES,
  PERSONAL_CONTEXT_MANAGE_COMMANDS,
  S1_RECIPE_IDS
}
