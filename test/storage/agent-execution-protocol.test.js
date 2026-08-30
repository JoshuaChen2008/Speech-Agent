'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { canonicalize, sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')
const { OPERATIONS, PROTOCOL_VERSION } = require('../../src/runtime/storage-worker/protocol')

function fixture (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-execution-protocol-'))
  const databasePath = path.join(root, 'speech-agent.sqlite3')
  const service = new StorageWorkerService()
  let sequence = 0
  const call = (operation, payload) => service.handle({
    version: PROTOCOL_VERSION,
    type: 'storage:request',
    requestId: `protocol.${++sequence}`,
    operation,
    payload
  })
  assert.equal(call(OPERATIONS.INITIALIZE, { databasePath }).ok, true)
  t.after(() => { try { call(OPERATIONS.SHUTDOWN, {}) } catch {}; fs.rmSync(root, { recursive: true, force: true }) })
  return { service, call }
}

function insertRun (service) {
  const database = service.requireStore().database
  const scope = { kind: 'session', reference: 'protocol-session' }
  const inputWatermark = { throughEventOrder: 1 }
  const inputDigest = sha256Canonical({ input: 'protocol' })
  database.prepare(`
    INSERT INTO formal_agent_runs(
      run_id,dedupe_key,client_idempotency_key,request_digest,recipe_id,recipe_version,
      scope_json,scope_digest,transcript_version,input_watermark_json,input_digest,
      requested_by,state,attempt_count,max_attempts,next_attempt_at,lease_owner,
      lease_expires_at,created_at,updated_at
    ) VALUES ('protocol-run', ?, 'protocol-client', ?, 'qa.answer', '1', ?, ?, 'raw', ?, ?,
      'user', 'running', 1, 3, 0, 'protocol-owner', 5000, 1, 1)
  `).run(
    'a'.repeat(64), 'b'.repeat(64), canonicalize(scope), sha256Canonical(scope),
    canonicalize(inputWatermark), inputDigest
  )
  database.prepare(`
    INSERT INTO agent_model_run_bindings(
      run_id,execution_form,purpose,assignment_mode,profile_id,profile_revision,
      adapter_id,api_style,https_origin,base_path,model_id,capability_json,budget_json,
      provider_kind,credential_slot_id,created_at
    ) VALUES ('protocol-run','agent_loop','default','direct','profile.protocol',1,
      'openai-compatible','chat-completions','https://provider.test','/v1','model.protocol',?,?, 'cloud','slot.protocol.00000001',1)
  `).run(
    canonicalize({ maxInputTokens: 64000, maxOutputTokens: 4096, supportsToolCalling: true,
      supportsStructuredOutput: true, supportsStreaming: true, usageReporting: true }),
    canonicalize({ maxTurns: 3 })
  )
}

test('SEM-F28/SEM-F34/J22: storage worker exposes exact v7 execution commands without SQLite handles', (t) => {
  const { service, call } = fixture(t)
  insertRun(service)
  const created = call(OPERATIONS.AGENT_CREATE_INTERACTION, { request: {
    runId: 'protocol-run', interactionId: 'protocol-interaction', routingMode: 'preset', promptDigest: 'c'.repeat(64)
  } })
  assert.equal(created.ok, true)
  assert.equal(created.result.maxTurns, 3)
  const result = call(OPERATIONS.AGENT_TERMINALIZE_INTERACTION, { request: {
    interactionId: 'protocol-interaction', terminalReason: 'cancelled', errorCode: null,
    result: null, usage: null, durationMs: 0
  } })
  assert.equal(result.ok, true)
  assert.equal(result.result.terminalReason, 'cancelled')
  const invalid = call(OPERATIONS.AGENT_START_TOOL_CALL, { request: {
    callId: 'protocol-call', interactionId: 'protocol-interaction', attempt: 1, callOrder: 1,
    toolName: 'search_context', startedOffsetMs: 0, args: {}
  } })
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'AGENT_INTERACTION_STATE_CONFLICT')
  assert.equal(Object.hasOwn(result.result, 'database'), false)
})

