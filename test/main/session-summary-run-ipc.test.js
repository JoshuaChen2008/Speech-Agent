'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const CHANNELS = require('../../src/main/ipc/channels')
const contract = require('../../src/agent/contracts/session-summary-run-ui')
const diagnosticsUI = require('../../src/agent/contracts/agent-run-diagnostics-ui')
const { registerSessionSummaryRunIpc } = require('../../src/main/ipc/session-summary-run-ipc')

function snapshot (overrides = {}) {
  return {
    request_id: 'request.summary.ipc', generation: 1, revision: 0, action: 'summary',
    state: 'accepted', phase: 'accepted', attempt: 0, elapsed_ms: 0,
    last_activity_age_ms: null, validated_chunk_count: null, total_chunk_count: null,
    memory_state: 'not_read', error_code: null, budget: null, freshness: 'unknown',
    cancel_requested: false, resume_required: false, diagnostics_available: false,
    route_run_id: null, target_run_id: null, interaction_id: null, recipe_id: null, routing_mode: null,
    ...overrides
  }
}

function ok (result) {
  return {
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    ok: true,
    error: null,
    result
  }
}

function diagnosticsOk (result) {
  return {
    contract_id: diagnosticsUI.CONTRACT_ID,
    contract_version: diagnosticsUI.CONTRACT_VERSION,
    ok: true,
    error: null,
    result
  }
}

test('SEM-F38/J30-ACCEPT: exact request, query, and cancel contracts cross the main IPC boundary', async () => {
  const handlers = new Map()
  const calls = []
  registerSessionSummaryRunIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    getRole: (event) => event.role,
    service: {
      async accept (request, context) {
        calls.push({ method: 'accept', request, sender: context.sender })
        return ok({ accepted: true, replayed: false, snapshot: snapshot() })
      },
      async get (request, context) {
        calls.push({ method: 'get', request, sender: context.sender })
        return ok({ snapshot: snapshot({ revision: 2, state: 'queued', phase: 'accepted' }) })
      },
      async cancel (request, context) {
        calls.push({ method: 'cancel', request, sender: context.sender })
        return ok({ snapshot: snapshot({ revision: 3, state: 'cancelled', phase: 'terminal', cancel_requested: true }) })
      },
      async resume (request, context) {
        calls.push({ method: 'resume', request, sender: context.sender })
        return ok({ snapshot: snapshot({ generation: 2, revision: 5, state: 'accepted', phase: 'accepted' }) })
      },
      async listRecoverable (request, context) {
        calls.push({ method: 'listRecoverable', request, sender: context.sender })
        return ok({ requests: [{ scope: { kind: 'session', reference: 'session.ipc' }, snapshot: snapshot({ state: 'retry_wait', phase: 'retry_wait', resume_required: true }) }] })
      },
      async getDiagnostics (request, context) {
        calls.push({ method: 'getDiagnostics', request, sender: context.sender })
        return diagnosticsOk({ available: true, records: [], next_before_sequence: null })
      },
      async exportDiagnostics (request, context) {
        calls.push({ method: 'exportDiagnostics', request, sender: context.sender })
        return diagnosticsOk({ status: 'cancelled', record_count: 0, available: true })
      }
    }
  })
  const event = { role: 'agent', sender: { id: 42 } }
  const request = {
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    action: 'summary',
    scope: { kind: 'session', reference: 'session.ipc' },
    client_request_key: 'agent.ui.key'
  }
  const accepted = await handlers.get(CHANNELS.SESSION_SUMMARY_RUN_ACCEPT)(event, request)
  assert.equal(contract.assertAcceptResponse(accepted).result.snapshot.state, 'accepted')
  const query = await handlers.get(CHANNELS.SESSION_SUMMARY_RUN_GET)(event, {
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: 'request.summary.ipc'
  })
  assert.equal(contract.assertGetResponse(query).result.snapshot.state, 'queued')
  const cancelled = await handlers.get(CHANNELS.SESSION_SUMMARY_RUN_CANCEL)(event, {
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: 'request.summary.ipc',
    generation: 1
  })
  assert.equal(contract.assertCancelResponse(cancelled).result.snapshot.state, 'cancelled')
  const resumed = await handlers.get(CHANNELS.SESSION_SUMMARY_RUN_RESUME)(event, {
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    request_id: 'request.summary.ipc',
    generation: 1,
    expected_revision: 4
  })
  assert.equal(contract.assertResumeResponse(resumed).result.snapshot.generation, 2)
  const recoverable = await handlers.get(CHANNELS.SESSION_SUMMARY_RUN_LIST_RECOVERABLE)(event, {
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION
  })
  assert.equal(contract.assertListRecoverableResponse(recoverable).result.requests[0].scope.reference, 'session.ipc')
  const diagnosticsRequest = {
    contract_id: diagnosticsUI.CONTRACT_ID,
    contract_version: diagnosticsUI.CONTRACT_VERSION,
    request_id: 'request.summary.ipc',
    before_sequence: null,
    limit: 50
  }
  const diagnosticsPage = await handlers.get(CHANNELS.SESSION_SUMMARY_RUN_DIAGNOSTICS_QUERY)(event, diagnosticsRequest)
  assert.equal(diagnosticsUI.assertQueryResponse(diagnosticsPage).result.available, true)
  const diagnosticsExport = await handlers.get(CHANNELS.SESSION_SUMMARY_RUN_DIAGNOSTICS_EXPORT)(event, {
    contract_id: diagnosticsUI.CONTRACT_ID,
    contract_version: diagnosticsUI.CONTRACT_VERSION,
    request_id: 'request.summary.ipc'
  })
  assert.equal(diagnosticsUI.assertExportResponse(diagnosticsExport).result.status, 'cancelled')
  assert.deepEqual(calls.map((call) => call.method), ['accept', 'get', 'cancel', 'resume', 'listRecoverable', 'getDiagnostics', 'exportDiagnostics'])
  assert.deepEqual(calls[0].sender, event.sender)
  assert.deepEqual(calls[5].sender, event.sender)
  await assert.rejects(
    () => handlers.get(CHANNELS.SESSION_SUMMARY_RUN_DIAGNOSTICS_QUERY)({ role: 'history' }, diagnosticsRequest),
    /IPC_ACCESS_DENIED/
  )
  await assert.rejects(
    () => handlers.get(CHANNELS.SESSION_SUMMARY_RUN_DIAGNOSTICS_QUERY)(event, { ...diagnosticsRequest, absolute_path: 'D:\\private' }),
    /exact keys/
  )
  await assert.rejects(
    () => handlers.get(CHANNELS.SESSION_SUMMARY_RUN_ACCEPT)(event, { ...request, prompt: 'caller override' }),
    /exact keys/
  )
  await assert.rejects(
    () => handlers.get(CHANNELS.SESSION_SUMMARY_RUN_GET)({ role: 'history' }, {
      contract_id: contract.CONTRACT_ID,
      contract_version: contract.CONTRACT_VERSION,
      request_id: 'request.summary.ipc'
    }),
    /IPC_ACCESS_DENIED/
  )
})

test('SEM-F38/J30-ACCEPT: main IPC fails closed when the request service is unavailable', async () => {
  const handlers = new Map()
  registerSessionSummaryRunIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    service: { accept: async () => { throw new Error('private failure detail') } }
  })
  const response = await handlers.get(CHANNELS.SESSION_SUMMARY_RUN_ACCEPT)({}, {
    contract_id: contract.CONTRACT_ID,
    contract_version: contract.CONTRACT_VERSION,
    action: 'summary',
    scope: { kind: 'session', reference: 'session.ipc' },
    client_request_key: 'agent.ui.key'
  })
  assert.deepEqual(response.error, { code: 'AGENT_RUN_UNAVAILABLE', next_action: 'retry' })
  assert.equal(JSON.stringify(response).includes('private failure detail'), false)
})
