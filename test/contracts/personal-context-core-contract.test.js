'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  AGENT_PROCESSING_ELIGIBILITIES,
  FORMAL_AGENT_TASK_ERROR_CODES,
  PERSONAL_CONTEXT_MANAGE_COMMANDS,
  S1_RECIPE_IDS
} = require('../../src/agent/contracts')
const { canonicalize, sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')

test('SEM-F28/SEM-F30/J21: S1 freezes only its recipe, task errors, eligibility and manage commands', () => {
  assert.deepEqual(S1_RECIPE_IDS, ['context.ingest.session'])
  assert.deepEqual(FORMAL_AGENT_TASK_ERROR_CODES, [
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
  assert.deepEqual(AGENT_PROCESSING_ELIGIBILITIES, [
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
  assert.deepEqual(PERSONAL_CONTEXT_MANAGE_COMMANDS, [
    'view', 'remember', 'update', 'forget', 'delete', 'set_processing'
  ])
  for (const values of [
    S1_RECIPE_IDS,
    FORMAL_AGENT_TASK_ERROR_CODES,
    AGENT_PROCESSING_ELIGIBILITIES,
    PERSONAL_CONTEXT_MANAGE_COMMANDS
  ]) assert.equal(Object.isFrozen(values), true)
})

test('SEM-F30/J21: canonical JSON follows deterministic JCS vectors and rejects non-JSON inputs', () => {
  assert.equal(canonicalize({ z: 1, a: '€', n: 1e-7 }), '{"a":"€","n":1e-7,"z":1}')
  assert.equal(canonicalize({ '\r': 1, '1': 2, '€': 3 }), '{"\\r":1,"1":2,"€":3}')
  assert.equal(canonicalize({ value: -0 }), '{"value":0}')
  assert.match(sha256Canonical({ a: 1 }), /^[0-9a-f]{64}$/)
  assert.equal(sha256Canonical({ a: 1, b: 2 }), sha256Canonical({ b: 2, a: 1 }))
  assert.throws(() => canonicalize({ value: Number.NaN }), /finite/)
  assert.throws(() => canonicalize({ value: Number.POSITIVE_INFINITY }), /finite/)
  const cyclic = {}
  cyclic.self = cyclic
  assert.throws(() => canonicalize(cyclic), /cycles/)
})
