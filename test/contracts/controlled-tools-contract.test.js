'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')
const {
  MEMORY_KINDS,
  TOOL_DEFINITIONS,
  TOOL_ERROR_CODES,
  TOOL_NAMES,
  assertRecipeToolAuthorization,
  assertToolArgs,
  assertToolCallRecord,
  assertToolCallSequence,
  assertToolResult,
  assertToolScope,
  deriveToolResultMetadata,
  getToolDefinition
} = require('../../src/agent/contracts/controlled-tools')
const {
  BUDGET_AXES,
  BUDGET_EXCEEDED_ERROR_CODE,
  BUDGET_AXIS_STATES,
  LIMITS,
  TOOL_PAYLOAD_LIMITS,
  assertBudgetObservation,
  assertBudgetSnapshot,
  assertRecipeBudgetSnapshot,
  deriveRecipeBudget,
  evaluateBudgetAxes
} = require('../../src/agent/contracts/budget-axes')

const capabilities = Object.freeze({ maxInputTokens: 64000, maxOutputTokens: 4096 })
const source = Object.freeze({
  sessionId: 'session.synthetic.1',
  transcriptVersion: 'raw',
  fromEventOrder: 1,
  throughEventOrder: 1
})
const outsideSource = Object.freeze({
  sessionId: 'session.synthetic.outside',
  transcriptVersion: 'raw',
  fromEventOrder: 1,
  throughEventOrder: 1
})
const memory = Object.freeze({ memoryId: 'memory.synthetic.1', revisionId: 'revision.synthetic.1' })
const searchArgs = Object.freeze({ schemaVersion: 1, aliasKeys: ['synthetic-topic'] })
const searchResult = Object.freeze({
  schemaVersion: 1,
  matches: [Object.freeze({
    aliasKey: 'synthetic-topic',
    entries: [Object.freeze({
      memoryRef: memory,
      kind: 'decision',
      displayText: 'Synthetic reference note.',
      sourceRefs: [source]
    })]
  })],
  unmatchedAliasKeys: []
})
const readArgs = Object.freeze({ schemaVersion: 1, sourceRefs: [source] })
const readResult = Object.freeze({
  schemaVersion: 1,
  sources: [Object.freeze({ sourceRef: source, text: 'Synthetic source excerpt.' })]
})

function clone (value) {
  return JSON.parse(JSON.stringify(value))
}

function succeededRecord (overrides = {}) {
  const toolName = overrides.toolName || 'search_context'
  const args = overrides.args || (toolName === 'read_sources' ? readArgs : searchArgs)
  const result = overrides.result || (toolName === 'read_sources' ? readResult : searchResult)
  const metadata = deriveToolResultMetadata(toolName, args, result)
  return {
    callId: overrides.callId || 'tool.call.1.1',
    attempt: overrides.attempt || 1,
    callOrder: overrides.callOrder || 1,
    toolName,
    schemaVersion: 1,
    startedOffsetMs: overrides.startedOffsetMs ?? 1,
    endedOffsetMs: overrides.endedOffsetMs ?? 2,
    status: 'succeeded',
    errorCode: null,
    args,
    argsDigest: sha256Canonical(args),
    result,
    resultDigest: metadata.resultDigest,
    sourceRefs: metadata.sourceRefs,
    counts: {
      resultBytes: metadata.resultBytes,
      sourceTextBytes: metadata.sourceTextBytes,
      sourceReferenceCount: metadata.sourceReferenceCount
    }
  }
}

function terminalFailureRecord (overrides = {}) {
  const toolName = overrides.toolName || 'search_context'
  const args = overrides.args || searchArgs
  const errorCode = overrides.errorCode || 'TOOL_INTERNAL_FAILURE'
  const status = overrides.status || (errorCode === 'TOOL_CANCELLED' ? 'cancelled' : 'failed')
  return {
    callId: overrides.callId || 'tool.call.1.1',
    attempt: overrides.attempt || 1,
    callOrder: overrides.callOrder || 1,
    toolName,
    schemaVersion: 1,
    startedOffsetMs: overrides.startedOffsetMs ?? 1,
    endedOffsetMs: overrides.endedOffsetMs ?? 2,
    status,
    errorCode,
    args,
    argsDigest: sha256Canonical(args),
    result: null,
    resultDigest: null,
    sourceRefs: [],
    counts: { resultBytes: 0, sourceTextBytes: 0, sourceReferenceCount: 0 }
  }
}

function codeIs (code) {
  return (error) => error && error.code === code
}

test('SEM-F34/J22/J24: S4 freezes exactly two controlled read-only tool schemas and byte limits', () => {
  assert.deepEqual(TOOL_NAMES, ['search_context', 'read_sources'])
  assert.deepEqual(TOOL_ERROR_CODES, [
    'TOOL_ARGS_INVALID',
    'TOOL_SCOPE_DENIED',
    'TOOL_NOT_AVAILABLE_FOR_RECIPE',
    'TOOL_BUDGET_EXCEEDED',
    'TOOL_TIMEOUT',
    'TOOL_CANCELLED',
    'TOOL_INTERNAL_FAILURE'
  ])
  assert.deepEqual(MEMORY_KINDS, [
    'decision', 'conclusion', 'todo', 'term', 'preference', 'project_fact', 'experience'
  ])
  assert.equal(TOOL_PAYLOAD_LIMITS.maxArgsBytes, 8 * 1024)
  assert.equal(TOOL_PAYLOAD_LIMITS.maxResultBytes, 64 * 1024)
  assert.deepEqual(TOOL_DEFINITIONS.map((definition) => definition.maxResultBytes), [64 * 1024, 64 * 1024])
  assert.equal(assertToolArgs('search_context', searchArgs), searchArgs)
  assert.equal(assertToolResult('search_context', searchArgs, searchResult), searchResult)
  assert.equal(assertToolArgs('read_sources', readArgs), readArgs)
  assert.equal(assertToolResult('read_sources', readArgs, readResult), readResult)
  assert.throws(() => getToolDefinition('write_file'), codeIs('TOOL_NOT_AVAILABLE_FOR_RECIPE'))
  assert.throws(() => assertToolArgs('search_context', { schemaVersion: 1, aliasKeys: [] }), codeIs('TOOL_ARGS_INVALID'))
  assert.throws(() => assertToolArgs('search_context', { schemaVersion: 1, aliasKeys: ['synthetic-topic'], extra: true }), codeIs('TOOL_ARGS_INVALID'))
  assert.throws(() => assertToolResult('read_sources', readArgs, {
    schemaVersion: 1,
    sources: [{ sourceRef: source, text: 'x'.repeat(TOOL_PAYLOAD_LIMITS.maxResultBytes) }]
  }), codeIs('TOOL_BUDGET_EXCEEDED'))
  const oversizedKeys = Array.from({ length: 64 }, (_, index) => `${String(index).padStart(3, '0')}${'x'.repeat(125)}`)
  assert.throws(() => assertToolArgs('search_context', { schemaVersion: 1, aliasKeys: oversizedKeys }), codeIs('TOOL_BUDGET_EXCEEDED'))
})

test('SEM-F34/J22/J24: S4 refuses recipe overreach and frozen-scope overreach before any adapter exists', () => {
  assert.doesNotThrow(() => assertRecipeToolAuthorization('report.analysis', '1', 'read_sources'))
  assert.throws(() => assertRecipeToolAuthorization('text.rewrite', '1', 'search_context'), codeIs('TOOL_NOT_AVAILABLE_FOR_RECIPE'))
  const scope = { registeredAliasKeys: ['synthetic-topic'], memoryRefs: [memory], sourceRefs: [source] }
  assert.doesNotThrow(() => assertToolScope('search_context', searchArgs, searchResult, scope))
  assert.doesNotThrow(() => assertToolScope('read_sources', readArgs, readResult, scope))
  assert.throws(() => assertToolScope('read_sources', {
    schemaVersion: 1,
    sourceRefs: [outsideSource]
  }, null, scope), codeIs('TOOL_SCOPE_DENIED'))
  const unregisteredArgs = { schemaVersion: 1, aliasKeys: ['synthetic-unregistered'] }
  const unregisteredResult = clone(searchResult)
  unregisteredResult.matches[0].aliasKey = 'synthetic-unregistered'
  assert.throws(() => assertToolScope('search_context', unregisteredArgs, unregisteredResult, scope), codeIs('TOOL_SCOPE_DENIED'))
  const outsideSearch = clone(searchResult)
  outsideSearch.matches[0].entries[0].memoryRef = { memoryId: 'memory.synthetic.outside', revisionId: 'revision.synthetic.1' }
  assert.throws(() => assertToolScope('search_context', searchArgs, outsideSearch, scope), codeIs('TOOL_SCOPE_DENIED'))
})

test('SEM-F34/J22/J24: audit metadata binds canonical args/results and keeps tool errors separate', () => {
  const successful = succeededRecord()
  assert.equal(assertToolCallRecord(successful), successful)
  assert.deepEqual(deriveToolResultMetadata('read_sources', readArgs, readResult), {
    resultBytes: 183,
    resultDigest: sha256Canonical(readResult),
    sourceRefs: [source],
    sourceTextBytes: 25,
    sourceReferenceCount: 1
  })
  assert.equal(assertToolCallRecord(terminalFailureRecord({ errorCode: 'TOOL_TIMEOUT' })).errorCode, 'TOOL_TIMEOUT')
  assert.equal(assertToolCallRecord(terminalFailureRecord({ errorCode: 'TOOL_CANCELLED' })).status, 'cancelled')
  assert.throws(() => assertToolCallRecord({ ...successful, counts: { ...successful.counts, resultBytes: 0 } }), codeIs('TOOL_INTERNAL_FAILURE'))
  assert.throws(() => assertToolCallRecord(terminalFailureRecord({ errorCode: 'AGENT_BUDGET_EXCEEDED' })), codeIs('TOOL_INTERNAL_FAILURE'))
})

test('SEM-F34/J22/J24: Tool Call Trace is a total retained order and retries never overwrite an attempt', () => {
  const firstAttempt = terminalFailureRecord({ callId: 'tool.call.1.1', attempt: 1, callOrder: 1 })
  const retry = succeededRecord({ callId: 'tool.call.2.1', attempt: 2, callOrder: 1, toolName: 'read_sources' })
  assert.deepEqual(assertToolCallSequence([firstAttempt, retry]), [firstAttempt, retry])

  const repeatedFailure = terminalFailureRecord({ callId: 'tool.call.1.2', attempt: 1, callOrder: 2 })
  const laterCall = succeededRecord({ callId: 'tool.call.1.3', attempt: 1, callOrder: 3 })
  assert.throws(() => assertToolCallSequence([firstAttempt, repeatedFailure, laterCall]), codeIs('TOOL_INTERNAL_FAILURE'))

  const cancelled = terminalFailureRecord({
    callId: 'tool.call.1.cancelled',
    attempt: 1,
    callOrder: 1,
    errorCode: 'TOOL_CANCELLED'
  })
  assert.throws(() => assertToolCallSequence([cancelled, retry]), codeIs('TOOL_INTERNAL_FAILURE'))
  assert.throws(() => assertToolCallSequence([{ ...firstAttempt, attempt: 2 }]), codeIs('TOOL_INTERNAL_FAILURE'))
})

test('SEM-F28/SEM-F34/J22/J24: ten budget axes share one static contract and converge to AGENT_BUDGET_EXCEEDED', () => {
  const budget = deriveRecipeBudget(capabilities, 'report.analysis', '1', 'user')
  assert.equal(assertBudgetSnapshot(budget), budget)
  assert.equal(assertRecipeBudgetSnapshot('report.analysis', '1', ['search_context', 'read_sources'], budget), budget)
  assert.throws(() => assertRecipeBudgetSnapshot('report.analysis', '1', ['search_context'], budget), /AGENT_REQUEST_INVALID/)
  assert.deepEqual(BUDGET_AXES, [
    'maxTurns', 'maxRequestInputTokens', 'maxCumulativeInputTokens', 'maxCumulativeOutputTokens',
    'maxWallClockMs', 'maxToolCalls', 'toolTimeoutMs', 'maxParallelTools',
    'maxToolResultBytes', 'maxSourceTextBytes'
  ])
  assert.equal(LIMITS.maxCumulativeInputTokens, 120000)
  assert.equal(LIMITS.maxCumulativeOutputTokens, 8000)
  assert.equal(LIMITS.maxToolCalls, 12)
  assert.equal(LIMITS.toolTimeoutMs, 5000)
  assert.equal(LIMITS.maxParallelTools, 1)
  assert.equal(LIMITS.maxToolResultBytes, 256 * 1024)
  assert.equal(LIMITS.maxSourceTextBytes, 128 * 1024)

  const normal = {
    turnCount: 0,
    requestInputTokens: 0,
    cumulativeBilledInputTokens: 0,
    cumulativeBilledOutputTokens: 0,
    wallClockMs: 0,
    toolCallCount: 0,
    activeToolCalls: 0,
    activeToolElapsedMs: 0,
    cumulativeToolResultBytes: 0,
    cumulativeSourceTextBytes: 0
  }
  const cases = [
    ['maxTurns', 'turnCount', budget.maxTurns],
    ['maxRequestInputTokens', 'requestInputTokens', budget.maxRequestInputTokens],
    ['maxCumulativeInputTokens', 'cumulativeBilledInputTokens', budget.maxCumulativeInputTokens],
    ['maxCumulativeOutputTokens', 'cumulativeBilledOutputTokens', budget.maxCumulativeOutputTokens],
    ['maxWallClockMs', 'wallClockMs', budget.maxWallClockMs],
    ['maxToolCalls', 'toolCallCount', budget.maxToolCalls],
    ['toolTimeoutMs', 'activeToolElapsedMs', budget.toolTimeoutMs],
    ['maxParallelTools', 'activeToolCalls', budget.maxParallelTools + 1],
    ['maxToolResultBytes', 'cumulativeToolResultBytes', budget.maxToolResultBytes],
    ['maxSourceTextBytes', 'cumulativeSourceTextBytes', budget.maxSourceTextBytes]
  ]
  for (const [axis, field, value] of cases) {
    const outcome = evaluateBudgetAxes(budget, { ...normal, [field]: value })
    assert.equal(outcome.exhausted, true, axis)
    assert.equal(outcome.taskErrorCode, BUDGET_EXCEEDED_ERROR_CODE, axis)
    assert.ok(outcome.exhaustedAxes.includes(axis), axis)
    assert.equal(outcome.axisStates[axis], 'exhausted', axis)
  }

  const unknownUsage = evaluateBudgetAxes(budget, {
    ...normal,
    cumulativeBilledInputTokens: null,
    cumulativeBilledOutputTokens: null
  })
  assert.equal(unknownUsage.exhausted, false)
  assert.equal(unknownUsage.axisStates.maxCumulativeInputTokens, 'not_evaluated')
  assert.equal(unknownUsage.axisStates.maxCumulativeOutputTokens, 'not_evaluated')
  assert.deepEqual(BUDGET_AXIS_STATES, ['within', 'exhausted', 'not_evaluated'])
  assert.throws(() => assertBudgetObservation({ ...normal, estimatedInputTokens: 1 }), /AGENT_REQUEST_INVALID/)
  assert.throws(() => assertBudgetObservation({ ...normal, cumulativeBilledInputTokens: null }), /AGENT_REQUEST_INVALID/)
})
