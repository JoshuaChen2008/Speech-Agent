'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { evaluateAutomaticEligibility } = require('../../src/agent/personal-context/automatic-eligibility')

const session = Object.freeze({ state: 'closed', endedAt: 200 })
const settings = Object.freeze({
  agentEnabled: true,
  automaticProcessingSince: 100,
  memoryEnabled: true,
  memoryProcessingSince: 150,
  cloudDisclosureAccepted: true
})
const catalog = (readiness = 'ready', providerKind = 'cloud') => ({
  ok: true,
  snapshot: { readinessByPurpose: { information_extraction: { agentLoop: readiness, providerKind } } }
})

test('SEM-F26/SEM-F28/J21: automatic session ingest applies terminal, boundary and provider ordering', () => {
  const cases = [
    [{ session: { state: 'active', endedAt: null }, segmentCount: 1, settings, catalog: catalog() }, 'session_not_terminal'],
    [{ session, segmentCount: 0, settings, catalog: catalog() }, 'no_committed_transcript'],
    [{ session: { ...session, endedAt: 99 }, segmentCount: 1, settings, catalog: catalog() }, 'outside_automatic_window'],
    [{ session, segmentCount: 1, settings: { ...settings, agentEnabled: false }, catalog: catalog() }, 'agent_disabled'],
    [{ session, segmentCount: 1, settings, catalog: catalog('provider_not_configured') }, 'provider_not_configured'],
    [{ session, segmentCount: 1, settings: { ...settings, cloudDisclosureAccepted: false }, catalog: catalog() }, 'cloud_disclosure_required'],
    [{ session, segmentCount: 1, settings, catalog: catalog('credential_unavailable') }, 'credential_unavailable'],
    [{ session, segmentCount: 1, settings, catalog: catalog('local_model_not_ready', 'local') }, 'local_model_not_ready'],
    [{ session, segmentCount: 1, settings, catalog: catalog() }, 'ready']
  ]
  for (const [input, expected] of cases) assert.equal(evaluateAutomaticEligibility(input), expected)
})

test('SEM-F26/SEM-F28/J21: disabled personal memory or stale boundary creates no automatic work', () => {
  assert.equal(evaluateAutomaticEligibility({ session, segmentCount: 1, settings: {
    agentEnabled: false,
    automaticProcessingSince: null,
    memoryEnabled: true,
    memoryProcessingSince: null,
    cloudDisclosureAccepted: false
  }, catalog: catalog() }), 'agent_disabled')
  assert.equal(evaluateAutomaticEligibility({ session, segmentCount: 1, settings: { ...settings, memoryEnabled: false }, catalog: catalog() }), 'outside_automatic_window')
  assert.equal(evaluateAutomaticEligibility({ session, segmentCount: 1, settings: { ...settings, memoryProcessingSince: null }, catalog: catalog() }), 'outside_automatic_window')
  assert.equal(evaluateAutomaticEligibility({ session, segmentCount: 1, settings, catalog: { ok: false, snapshot: null } }), 'provider_not_configured')
})
