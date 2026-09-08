'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const c = require('../../src/agent/contracts/agent-run-ui')
const { canonicalize, sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')
const { AgentRunService } = require('../../src/agent/formal-run/agent-run-service')
const {
  AgentInteractionExporter,
  buildExportSnapshot,
  writeAtomic
} = require('../../src/agent/formal-run/agent-interaction-exporter')

const scope = { kind: 'session', reference: 'session.export.1' }
const sourceRef = { sessionId: scope.reference, transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 1 }

function detailFor (terminalReason = 'succeeded', options = {}) {
  const result = terminalReason === 'succeeded' ? { schemaVersion: 1, answer: '受控结果', sourceRefs: [sourceRef], memoryRefs: [], unresolved: [] } : null
  const toolResult = { schemaVersion: 1, matches: [], unmatchedAliasKeys: ['missing'] }
  const args = { schemaVersion: 1, aliasKeys: ['missing'] }
  const usage = options.usage === true
    ? { inputTokens: 12, outputTokens: 3, usageSource: 'provider', cacheHitInputTokens: 4, cacheMissInputTokens: 8 }
    : null
  const calls = terminalReason === 'cancelled' ? [] : [{
    callId: 'tool.interaction.export.1.1.1', interactionId: 'interaction.export.1', attempt: 1, callOrder: 1,
    toolName: 'search_context', schemaVersion: 1, startedOffsetMs: 1, endedOffsetMs: terminalReason === 'failed' ? 3 : 8,
    status: terminalReason === 'failed' ? 'failed' : 'succeeded', errorCode: terminalReason === 'failed' ? 'TOOL_TIMEOUT' : null,
    args, argsDigest: sha256Canonical(args), result: terminalReason === 'failed' ? null : toolResult,
    resultDigest: terminalReason === 'failed' ? null : sha256Canonical(toolResult), sourceRefs: [],
    counts: { resultBytes: terminalReason === 'failed' ? 0 : Buffer.byteLength(canonicalize(toolResult), 'utf8'), sourceTextBytes: 0, sourceReferenceCount: 0 }
  }]
  if (options.multiAttempt === true && terminalReason === 'succeeded') calls.push({
    ...calls[0], callId: 'tool.interaction.export.1.2.1', attempt: 2, startedOffsetMs: 9, endedOffsetMs: 12,
    args: { schemaVersion: 1, aliasKeys: ['again'] }, argsDigest: sha256Canonical({ schemaVersion: 1, aliasKeys: ['again'] }),
    result: { schemaVersion: 1, matches: [], unmatchedAliasKeys: ['again'] },
    resultDigest: sha256Canonical({ schemaVersion: 1, matches: [], unmatchedAliasKeys: ['again'] }),
    counts: { resultBytes: Buffer.byteLength(canonicalize({ schemaVersion: 1, matches: [], unmatchedAliasKeys: ['again'] }), 'utf8'), sourceTextBytes: 0, sourceReferenceCount: 0 }
  })
  return {
    runState: terminalReason,
    cancelRequested: terminalReason === 'cancelled',
    interaction: {
      interactionId: 'interaction.export.1', runId: 'run.export.1', recipeId: 'qa.answer', recipeVersion: '1',
      scope, inputDigest: '1'.repeat(64), terminalReason,
      errorCode: terminalReason === 'failed' ? 'AGENT_PROVIDER_TIMEOUT' : null,
      usage, durationMs: 42, attemptCount: options.multiAttempt === true ? 2 : 1,
      result, resultDigest: result ? sha256Canonical(result) : null,
      createdAt: 1000, terminalAt: 1042
    },
    binding: { adapterId: 'adapter.internal', modelId: 'model.internal', profileId: 'profile.internal', profileRevision: 2, providerKind: 'local' },
    toolCalls: calls
  }
}

function responseHeader (value) {
  return { contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION, ...value }
}

test('SEM-F35/J26: exporter validates one terminal snapshot and repeats canonical bytes', async () => {
  const writes = []
  const exporter = new AgentInteractionExporter({
    storage: { async getAgentInteraction ({ interactionId }) { assert.equal(interactionId, 'interaction.export.1'); return detailFor() } },
    showSaveDialog: async () => ({ canceled: false, filePath: 'C:\\chosen\\agent.json' }),
    writeAtomic: async (filePath, bytes) => writes.push({ filePath, bytes: Buffer.from(bytes) })
  })
  const first = await exporter.exportInteraction({ interactionId: 'interaction.export.1' })
  const second = await exporter.exportInteraction({ interactionId: 'interaction.export.1' })
  assert.equal(first.bytes_sha256, second.bytes_sha256)
  assert.deepEqual(writes.map((item) => item.bytes), [writes[0].bytes, writes[0].bytes])
  assert.equal(JSON.parse(writes[0].bytes.toString()).schema_version, 1)
  assert.deepEqual(JSON.parse(writes[0].bytes.toString()), first.snapshot)
  assert.doesNotThrow(() => c.assertExportResponse(responseHeader({ ok: true, error: null, result: first })))
  assert.equal(JSON.stringify(first.snapshot).includes('chosen'), false)
})

test('SEM-F35/J26: failed and cancelled terminal interactions preserve null result', () => {
  for (const terminalReason of ['failed', 'cancelled']) {
    const snapshot = buildExportSnapshot(detailFor(terminalReason), 'interaction.export.1')
    assert.equal(snapshot.terminal_reason, terminalReason)
    assert.equal(snapshot.result, null)
    assert.equal(snapshot.result_digest, null)
  }
})

test('SEM-F35/J26: known usage and multiple attempts retain provider facts and total order', () => {
  const snapshot = buildExportSnapshot(detailFor('succeeded', { usage: true, multiAttempt: true }), 'interaction.export.1')
  assert.deepEqual(snapshot.usage, { inputTokens: 12, outputTokens: 3, usageSource: 'provider', cacheHitInputTokens: 4, cacheMissInputTokens: 8 })
  assert.deepEqual(snapshot.tool_calls.map((call) => [call.attempt, call.call_order]), [[1, 1], [2, 1]])
})

test('SEM-F35/J26: save cancellation performs zero writes', async () => {
  let writes = 0
  const exporter = new AgentInteractionExporter({
    storage: { async getAgentInteraction () { return detailFor() } },
    showSaveDialog: async () => ({ canceled: true, filePath: 'C:\\must-not-write.json' }),
    writeAtomic: async () => { writes += 1 }
  })
  const result = await exporter.exportInteraction({ interactionId: 'interaction.export.1' })
  assert.deepEqual(result, { cancelled: true })
  assert.equal(writes, 0)
})

test('SEM-F35/J26: digest/order/schema mismatch fails before save', async () => {
  let writes = 0
  const exporter = new AgentInteractionExporter({
    storage: { async getAgentInteraction () { const detail = detailFor(); detail.interaction.resultDigest = 'f'.repeat(64); return detail } },
    showSaveDialog: async () => ({ canceled: false, filePath: 'C:\\must-not-write.json' }),
    writeAtomic: async () => { writes += 1 }
  })
  await assert.rejects(() => exporter.exportInteraction({ interactionId: 'interaction.export.1' }), (error) => error.code === 'AGENT_EXPORT_INVALID')
  assert.equal(writes, 0)
})

test('SEM-F35/J26: valid digests cannot bypass recipe or tool exact schemas', async () => {
  for (const mutate of [
    (detail) => {
      detail.interaction.result = { schemaVersion: 1, answer: 'x', sourceRefs: [], memoryRefs: [], unresolved: [], extra: 'schema drift' }
      detail.interaction.resultDigest = sha256Canonical(detail.interaction.result)
    },
    (detail) => {
      const call = detail.toolCalls[0]
      call.args = { schemaVersion: 1, aliasKeys: [] }
      call.argsDigest = sha256Canonical(call.args)
    },
    (detail) => {
      const call = detail.toolCalls[0]
      call.result = { schemaVersion: 1, matches: [], unmatchedAliasKeys: [] }
      call.resultDigest = sha256Canonical(call.result)
      call.counts.resultBytes = Buffer.byteLength(canonicalize(call.result), 'utf8')
    }
  ]) {
    let writes = 0
    const exporter = new AgentInteractionExporter({
      storage: { async getAgentInteraction () { const detail = detailFor(); mutate(detail); return detail } },
      showSaveDialog: async () => ({ canceled: false, filePath: 'C:\\must-not-write.json' }),
      writeAtomic: async () => { writes += 1 }
    })
    await assert.rejects(() => exporter.exportInteraction({ interactionId: 'interaction.export.1' }), (error) => error.code === 'AGENT_EXPORT_INVALID')
    assert.equal(writes, 0)
  }
})

test('SEM-F35/J26: forbidden prompt, reasoning, provider, device, audio, path and amount fields fail closed', () => {
  for (const key of ['prompt', 'reasoning', 'provider_event', 'credential', 'audio', 'local_path', 'device_name', 'clock_offset_ms', 'cost', 'currency']) {
    const detail = detailFor()
    detail.interaction.result = { answer: 'x', [key]: 'synthetic' }
    detail.interaction.resultDigest = sha256Canonical(detail.interaction.result)
    assert.throws(() => buildExportSnapshot(detail, 'interaction.export.1'), (error) => error.code === 'AGENT_EXPORT_INVALID')
  }
})

test('SEM-F35/J26: atomic writer replaces target and cleans temporary file', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-export-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const target = path.join(root, 'result.json')
  fs.writeFileSync(target, 'old', 'utf8')
  await writeAtomic(target, Buffer.from('{"schema_version":1}', 'utf8'), { randomUUID: () => 'fixed' })
  assert.equal(fs.readFileSync(target, 'utf8'), '{"schema_version":1}')
  assert.deepEqual(fs.readdirSync(root), ['result.json'])
})

test('SEM-F35/J26: service keeps export target main-owned and projects cancellation as bounded error', async () => {
  const requests = []
  const service = new AgentRunService({
    storage: {
      async listSessions () { return { items: [], nextCursor: null } },
      async getSessionTranscript () { return { session: { state: 'closed' }, segments: [] } }
    },
    exporter: {
      async exportInteraction (request) { requests.push(request); return { cancelled: true } }
    },
    getOwnerWindow: (sender) => sender
  })
  const response = await service.exportInteraction({ contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION, interaction_id: 'interaction.export.1' }, { sender: { id: 1 } })
  assert.equal(response.ok, false)
  assert.equal(response.error.code, c.ERROR_CODES.unavailable)
  assert.equal(response.error.next_action, 'export_cancelled')
  assert.deepEqual(requests, [{ interactionId: 'interaction.export.1', ownerWindow: { id: 1 } }])
})
