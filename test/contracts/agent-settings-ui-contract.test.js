'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const c = require('../../src/agent/contracts/agent-settings-ui')

const header = { contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION }

test('SEM-F27/SEM-F30/J21: Agent settings contract freezes public toggles and rejects boundaries or provider fields', () => {
  const request = {
    ...header,
    expected_revision: 0,
    agent_enabled: true,
    memory_enabled: true,
    cloud_disclosure_accepted: false
  }
  assert.deepEqual(c.assertUpdateRequest(request), request)
  assert.throws(() => c.assertUpdateRequest({ ...request, automatic_processing_since: 1 }), /exact keys/)
  assert.throws(() => c.assertUpdateRequest({ ...request, agent_enabled: 1 }), /must be boolean/)
  assert.throws(() => c.assertUpdateRequest({ ...request, expected_revision: -1 }), /non-negative/)

  const response = c.assertUpdateResponse({
    ...header,
    ok: true,
    settings: {
      agent_enabled: true,
      memory_enabled: true,
      cloud_disclosure_accepted: false,
      agent_settings_revision: 1
    },
    error: null
  })
  assert.equal(response.settings.agent_settings_revision, 1)
  assert.throws(() => c.assertUpdateResponse({ ...response, settings: { ...response.settings, agent_enabled: true, prompt: 'private' } }), /exact keys/)
  assert.throws(() => c.assertUpdateResponse({
    ...header, ok: false, settings: null,
    error: { code: c.ERROR_CODES.invalid, next_action: 'retry' }
  }), /registered action|registered/) // the action is part of the public error contract
})

test('SEM-F14/J21: settings response error projection contains no raw exception or private fields', () => {
  for (const code of Object.values(c.ERROR_CODES)) {
    const response = c.assertUpdateResponse({
      ...header, ok: false, settings: null,
      error: { code, next_action: c.ERROR_RULES[code].next_action }
    })
    assert.deepEqual(Object.keys(response.error).sort(), ['code', 'next_action'])
    assert.doesNotMatch(JSON.stringify(response), /stack|path|prompt|credential|audio|timestamp/i)
  }
})
