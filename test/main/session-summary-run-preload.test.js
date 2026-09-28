'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const vm = require('node:vm')

const CHANNELS = require('../../src/main/ipc/channels')
const contract = require('../../src/agent/contracts/session-summary-run-ui')
const diagnosticsUI = require('../../src/agent/contracts/agent-run-diagnostics-ui')

function loadAgentPreload () {
  const exposed = {}
  const listeners = new Map()
  const calls = []
  const snapshot = {
    request_id: 'request.summary.preload', generation: 1, revision: 0, action: 'summary',
    state: 'accepted', phase: 'accepted', attempt: 0, elapsed_ms: 0,
    last_activity_age_ms: null, validated_chunk_count: null, total_chunk_count: null,
    memory_state: 'not_read', error_code: null, budget: null, freshness: 'unknown',
    cancel_requested: false, resume_required: false, diagnostics_available: false,
    route_run_id: null, target_run_id: null, interaction_id: null, recipe_id: null, routing_mode: null
  }
  const response = {
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    ok: true,
    error: null,
    result: { accepted: true, replayed: false, snapshot }
  }
  const diagnosticsResponse = {
    contract_id: diagnosticsUI.CONTRACT_ID,
    contract_version: diagnosticsUI.CONTRACT_VERSION,
    ok: true,
    error: null,
    result: { available: true, records: [], next_before_sequence: null }
  }
  const source = fs.readFileSync(path.join(process.cwd(), 'src', 'preload', 'agent.js'), 'utf8')
  const localRequire = (specifier) => {
    if (specifier === 'electron') return { contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value } } }
    if (specifier === './shared') {
      return {
        createWindowInteractionBridge: () => ({ dragStart: () => {}, dragEnd: () => {}, onInteractionSync: () => () => {} }),
        ipcRenderer: {
          invoke: async (channel, request) => {
            calls.push({ channel, request })
            if (channel === CHANNELS.SESSION_SUMMARY_RUN_LIST_RECOVERABLE) {
              return { ...response, result: { requests: [] } }
            }
            if (channel === CHANNELS.SESSION_SUMMARY_RUN_RESUME) {
              return { ...response, result: { snapshot: { ...snapshot, generation: 2, revision: 1, state: 'accepted' } } }
            }
            if (channel === CHANNELS.SESSION_SUMMARY_RUN_DIAGNOSTICS_QUERY) return diagnosticsResponse
            if (channel === CHANNELS.SESSION_SUMMARY_RUN_DIAGNOSTICS_EXPORT) {
              return {
                ...diagnosticsResponse,
                result: { status: 'cancelled', record_count: 0, available: true }
              }
            }
            return response
          },
          on: (channel, callback) => listeners.set(channel, callback),
          removeListener: (channel, callback) => { if (listeners.get(channel) === callback) listeners.delete(channel) },
          send: () => {}
        },
        subscribe: () => () => {}
      }
    }
    if (specifier === '../main/ipc/channels') return CHANNELS
    if (specifier === '../agent/contracts/agent-run-ui') return require('../../src/agent/contracts/agent-run-ui')
    if (specifier === '../agent/contracts/session-summary-run-ui') return contract
    if (specifier === '../agent/contracts/agent-run-diagnostics-ui') return diagnosticsUI
    if (specifier === '../agent/contracts/agent-context-ui') return require('../../src/agent/contracts/agent-context-ui')
    throw new Error(`unexpected preload dependency: ${specifier}`)
  }
  vm.runInNewContext(`(function (require, module, exports) { ${source}\n})`, {})
    (localRequire, { exports: {} }, {})
  return { api: exposed.agentApi, calls, listeners }
}

test('SEM-F38/J30-ACCEPT: agent preload validates and forwards summary request controls', async () => {
  const { api, calls, listeners } = loadAgentPreload()
  const request = {
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    action: 'summary',
    scope: { kind: 'session', reference: 'session.preload' },
    client_request_key: 'agent.ui.preload'
  }
  const accepted = await api.acceptSessionSummaryRun(request)
  assert.equal(accepted.ok, true)
  assert.equal(calls[0].channel, CHANNELS.SESSION_SUMMARY_RUN_ACCEPT)
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].request)), request)
  const listed = await api.listRecoverableSessionSummaryRuns({
    contract_id: contract.CONTRACT_ID, contract_version: contract.CONTRACT_VERSION
  })
  assert.deepEqual(JSON.parse(JSON.stringify(listed.result)), { requests: [] })
  const resumed = await api.resumeSessionSummaryRun({
    contract_id: contract.CONTRACT_ID, contract_version: contract.CONTRACT_VERSION,
    request_id: 'request.summary.preload', generation: 1, expected_revision: 0
  })
  assert.equal(resumed.result.snapshot.generation, 2)
  assert.equal(calls[1].channel, CHANNELS.SESSION_SUMMARY_RUN_LIST_RECOVERABLE)
  assert.equal(calls[2].channel, CHANNELS.SESSION_SUMMARY_RUN_RESUME)
  const diagnosticsRequest = {
    contract_id: diagnosticsUI.CONTRACT_ID,
    contract_version: diagnosticsUI.CONTRACT_VERSION,
    request_id: 'request.summary.preload',
    before_sequence: null,
    limit: 50
  }
  const queriedDiagnostics = await api.getSessionSummaryRunDiagnostics(diagnosticsRequest)
  assert.equal(queriedDiagnostics.result.available, true)
  const exportedDiagnostics = await api.exportSessionSummaryRunDiagnostics({
    contract_id: diagnosticsUI.CONTRACT_ID,
    contract_version: diagnosticsUI.CONTRACT_VERSION,
    request_id: 'request.summary.preload'
  })
  assert.equal(exportedDiagnostics.result.status, 'cancelled')
  assert.equal(calls[3].channel, CHANNELS.SESSION_SUMMARY_RUN_DIAGNOSTICS_QUERY)
  assert.deepEqual(JSON.parse(JSON.stringify(calls[3].request)), diagnosticsRequest)
  assert.equal(calls[4].channel, CHANNELS.SESSION_SUMMARY_RUN_DIAGNOSTICS_EXPORT)
  assert.throws(() => api.getSessionSummaryRunDiagnostics({ ...diagnosticsRequest, file_path: 'D:\\private' }), /exact keys/)
  assert.throws(() => api.getSessionSummaryRun({
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: 'request.summary.preload',
    prompt: 'extra field'
  }), /exact keys/)

  const events = []
  const unsubscribe = api.onSessionSummaryRunChanged((event) => events.push(event))
  const deliver = listeners.get(CHANNELS.SESSION_SUMMARY_RUN_CHANGED)
  const changed = {
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: 'request.summary.preload', generation: 1, revision: 2
  }
  deliver({}, changed)
  deliver({}, { ...changed, privateField: true })
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [changed])
  unsubscribe()
  assert.equal(listeners.has(CHANNELS.SESSION_SUMMARY_RUN_CHANGED), false)
})
