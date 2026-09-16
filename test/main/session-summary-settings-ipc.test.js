'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const CHANNELS = require('../../src/main/ipc/channels')
const { registerSessionSummarySettingsIpc } = require('../../src/main/ipc/session-summary-settings-ipc')
const contract = require('../../src/agent/contracts/session-summary-settings-ui')

function harness (options = {}) {
  const handlers = new Map()
  const changed = []
  const ipcMain = {
    handle: (channel, handler) => handlers.set(channel, handler),
    removeHandler: (channel) => handlers.delete(channel)
  }
  const dispose = registerSessionSummarySettingsIpc({
    ipcMain,
    authorize: options.authorize || (() => {}),
    getConfig: options.getConfig || (() => ({ summaryUseMemory: true, agentSettingsRevision: 4 })),
    updateSummaryUseMemory: options.updateSummaryUseMemory || (async ({ expectedRevision, summaryUseMemory }) => ({
      summaryUseMemory, agentSettingsRevision: expectedRevision + 1
    })),
    onChanged: (value) => changed.push(value)
  })
  return { changed, dispose, handler: handlers.get(CHANNELS.SESSION_SUMMARY_SETTINGS_UPDATE), handlers }
}

const request = (overrides = {}) => ({
  contract_id: contract.CONTRACT_ID,
  contract_version: contract.CONTRACT_VERSION,
  expected_revision: 4,
  summary_use_memory: false,
  ...overrides
})

test('SEM-F38/J29: summary settings IPC preserves exact request, shared revision and public response', async () => {
  const calls = []
  const h = harness({ updateSummaryUseMemory: async (value) => {
    calls.push(value)
    return { summaryUseMemory: value.summaryUseMemory, agentSettingsRevision: 5 }
  } })
  const response = await h.handler({ sender: { id: 'settings' } }, request())
  assert.equal(response.ok, true)
  assert.deepEqual(calls, [{ expectedRevision: 4, summaryUseMemory: false }])
  assert.deepEqual(response.settings, { summary_use_memory: false, agent_settings_revision: 5 })
  assert.deepEqual(h.changed, [response.settings])
  assert.doesNotThrow(() => contract.assertUpdateResponse(response))
  h.dispose()
  assert.equal(h.handlers.has(CHANNELS.SESSION_SUMMARY_SETTINGS_UPDATE), false)
})

test('SEM-F38/SEM-T04/J29: summary settings IPC rejects stale writes and unauthorized or malformed callers', async () => {
  const conflict = harness({ updateSummaryUseMemory: async () => {
    const error = new Error('stale')
    error.code = 'SETTINGS_REVISION_CONFLICT'
    throw error
  } })
  const stale = await conflict.handler({}, request())
  assert.equal(stale.ok, false)
  assert.equal(stale.error.code, contract.ERROR_CODES.revisionConflict)
  assert.equal(stale.error.next_action, 'reload')
  conflict.dispose()

  const denied = harness({ authorize: () => { throw new Error('denied') } })
  const deniedResponse = await denied.handler({}, request())
  assert.equal(deniedResponse.ok, false)
  assert.equal(deniedResponse.error.code, contract.ERROR_CODES.permissionDenied)
  denied.dispose()

  const malformed = harness()
  const invalid = await malformed.handler({}, request({ unexpected: true }))
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, contract.ERROR_CODES.invalid)
  malformed.dispose()
})
