'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const {
  ALLOWED_ROLES,
  CONTRACT_ID,
  CONTRACT_VERSION,
  ELIGIBILITY_STATES,
  ERROR_CODES,
  IPC_CHANNELS,
  assertChangedEvent,
  assertFixturePrivacy,
  assertGetEligibilityRequest,
  assertGetEligibilityResponse,
  isSupportedContract
} = require('../../src/agent/contracts/agent-run-eligibility-ui')

const header = Object.freeze({
  contract_id: 'speech-agent.agent-run.ui',
  contract_version: '1.0.0'
})

test('SEM-F28/SEM-F31/J22/J24: Agent Bar eligibility and changed use a bounded exact public contract', () => {
  assert.equal(CONTRACT_ID, header.contract_id)
  assert.equal(CONTRACT_VERSION, header.contract_version)
  assert.deepEqual(ALLOWED_ROLES, ['agent', 'history'])
  assert.deepEqual(IPC_CHANNELS, {
    changed: 'agent-run:changed',
    getEligibility: 'agent-run:get-eligibility'
  })
  assert.deepEqual(ELIGIBILITY_STATES, [
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
  assert.equal(isSupportedContract(header.contract_id, header.contract_version), true)
  assert.equal(isSupportedContract(header.contract_id, '1.0.1'), false)

  const request = { ...header, scope: { kind: 'session', reference: 'session.demo-1' } }
  const response = {
    ...header,
    ok: true,
    error: null,
    snapshot: {
      scope: request.scope,
      eligibility: 'ready',
      next_action: null,
      revision: 7
    }
  }
  assert.equal(assertGetEligibilityRequest(request), request)
  assert.equal(assertGetEligibilityResponse(response), response)
  assert.equal(assertChangedEvent({ ...header, revision: 8 }).revision, 8)
})

test('SEM-F28/SEM-T04/J22: eligibility contract fails closed for unknown scope, state, action, version and fields', () => {
  const request = { ...header, scope: { kind: 'project', reference: 'project.demo-1' } }
  assert.throws(() => assertGetEligibilityRequest({ ...request, prompt: 'not allowed' }), /exact keys/)
  assert.throws(() => assertGetEligibilityRequest({ ...request, scope: { kind: 'unknown', reference: 'x' } }), /not registered/)
  assert.throws(() => assertGetEligibilityRequest({ ...request, scope: { kind: 'session', reference: '' } }), /identifier/)
  assert.throws(() => assertGetEligibilityResponse({
    ...header,
    ok: true,
    error: null,
    snapshot: { scope: request.scope, eligibility: 'unknown', next_action: null, revision: 0 }
  }), /not registered/)
  assert.throws(() => assertGetEligibilityResponse({
    ...header,
    ok: true,
    error: null,
    snapshot: { scope: request.scope, eligibility: 'ready', next_action: 'settings', revision: 0 }
  }), /must be null/)
  assert.throws(() => assertGetEligibilityResponse({
    ...header,
    ok: false,
    error: { code: 'AGENT_RUN_UNKNOWN', category: 'unavailable', next_action: null },
    snapshot: null
  }), /not registered/)
  assert.throws(() => assertChangedEvent({ ...header, revision: 1, state: 'ready' }), /exact keys/)
})

test('SEM-F14/SEM-F31/J22: Agent Bar eligibility fixtures reject prompt, credentials, audio, paths and raw diagnostics', () => {
  assert.deepEqual(ERROR_CODES, { unavailable: 'AGENT_RUN_UNAVAILABLE' })
  assert.doesNotThrow(() => assertFixturePrivacy({
    ...header,
    scope: { kind: 'session', reference: 'session.synthetic' },
    eligibility: 'provider_not_configured',
    next_action: null,
    revision: 0
  }))
  for (const value of [
    { prompt: 'synthetic' },
    { credential: 'synthetic' },
    { audioPath: 'synthetic' },
    { localPath: 'C:\\synthetic' },
    { rawError: 'TypeError: synthetic' }
  ]) assert.throws(() => assertFixturePrivacy(value), /forbidden/)
})
