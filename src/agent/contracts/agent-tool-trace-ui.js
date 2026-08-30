'use strict'

// S4 preview contract only. It projects already-audited controlled tool calls
// for a future renderer without adding IPC, storage reads, or runtime wiring.

const { sha256Canonical } = require('../../runtime/storage-worker/canonical-json')
const {
  TOOL_ERROR_CODES,
  TOOL_NAMES,
  TOOL_STATUSES,
  assertToolCallRecord,
  assertToolCallSequence
} = require('./controlled-tools')

const CONTRACT_ID = 'speech-agent.agent-tool-trace.ui'
const CONTRACT_VERSION = '1.0.0'
const INTERACTION_STATUSES = Object.freeze(['running', 'succeeded', 'failed', 'cancelled'])
const BUDGET_STATES = Object.freeze(['within_budget', 'exhausted'])
const FIXTURE_SCENARIOS = Object.freeze([
  'search_context_succeeded',
  'read_sources_succeeded',
  'tool_args_invalid',
  'tool_scope_denied',
  'tool_not_available_for_recipe',
  'tool_budget_exceeded',
  'tool_timeout',
  'tool_cancelled',
  'retry_preserved',
  'running_call'
])

const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,159}$/
const FORBIDDEN_FIELD_KEYS = new Set([
  'recipe_id', 'recipe_version', 'max_turns', 'tool_grants',
  'single_shot', 'agent_loop', 'execution_form', 'escalation_reason',
  'prompt', 'prompt_text', 'reasoning', 'reasoning_content', 'internal_reasoning',
  'chain_of_thought', 'thought', 'provider_event', 'provider_raw_event', 'raw_provider_event',
  'provider_response', 'raw_event', 'transcript_text', 'transcript_body', 'caption_text', 'caption_body',
  'credential', 'credentials', 'api_key', 'authorization', 'secret', 'password',
  'audio', 'pcm', 'wav', 'audio_path', 'local_path', 'absolute_path', 'path',
  'stack', 'raw_error'
])
const FORBIDDEN_VALUE = /(?:bearer\s+[A-Za-z0-9._~+/-]+|[A-Za-z]:[\\/]|file:\/\/|\.wav(?:\b|$)|\.pcm(?:\b|$)|\.mp3(?:\b|$))/i

function fail (path, message) {
  throw new TypeError(`${path}: ${message}`)
}

function assertRecord (value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(path, 'must be a plain object')
  }
}

function assertExactObject (value, keys, path) {
  assertRecord(value, path)
  const expected = [...keys].sort()
  const actual = Object.keys(value).sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(path, 'must contain exact keys')
  }
}

function assertInteger (value, path, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(path, 'must be a safe integer')
  return value
}

function assertEnum (value, allowed, path) {
  if (!allowed.includes(value)) fail(path, 'is not registered')
  return value
}

function assertIdentifier (value, path) {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail(path, 'has an invalid identifier')
  return value
}

function assertContractHeader (value, path) {
  if (value.contract_id !== CONTRACT_ID) fail(`${path}.contract_id`, `must equal ${CONTRACT_ID}`)
  if (value.contract_version !== CONTRACT_VERSION) fail(`${path}.contract_version`, `must equal ${CONTRACT_VERSION}`)
}

function isSupportedContract (contractId, contractVersion) {
  return contractId === CONTRACT_ID && contractVersion === CONTRACT_VERSION
}

function asCoreRecord (call) {
  return {
    callId: `preview.tool.${call.attempt}.${call.callOrder}`,
    attempt: call.attempt,
    callOrder: call.callOrder,
    toolName: call.toolName,
    schemaVersion: 1,
    startedOffsetMs: call.startedOffsetMs,
    endedOffsetMs: call.endedOffsetMs,
    status: call.status,
    errorCode: call.errorCode,
    args: call.args,
    argsDigest: sha256Canonical(call.args),
    result: call.result,
    resultDigest: call.result === null ? null : sha256Canonical(call.result),
    sourceRefs: call.sourceRefs,
    counts: call.counts
  }
}

function assertToolTraceCall (value, path) {
  assertExactObject(value, [
    'attempt', 'callOrder', 'toolName', 'startedOffsetMs', 'endedOffsetMs',
    'status', 'errorCode', 'args', 'result', 'sourceRefs', 'counts'
  ], path)
  assertInteger(value.attempt, `${path}.attempt`, 1)
  assertInteger(value.callOrder, `${path}.callOrder`, 1)
  assertEnum(value.toolName, TOOL_NAMES, `${path}.toolName`)
  assertInteger(value.startedOffsetMs, `${path}.startedOffsetMs`)
  assertEnum(value.status, TOOL_STATUSES, `${path}.status`)
  if (value.errorCode !== null) assertEnum(value.errorCode, TOOL_ERROR_CODES, `${path}.errorCode`)
  try {
    assertToolCallRecord(asCoreRecord(value))
  } catch (error) {
    fail(path, error.message)
  }
  return value
}

function assertToolCalls (toolCalls, path) {
  if (!Array.isArray(toolCalls)) fail(path, 'must be an array')
  const coreRecords = toolCalls.map((call, index) => {
    assertToolTraceCall(call, `${path}[${index}]`)
    return asCoreRecord(call)
  })
  try {
    assertToolCallSequence(coreRecords)
  } catch (error) {
    fail(path, error.message)
  }
  return toolCalls
}

function assertSnapshot (value, path = 'ToolTraceSnapshotV1') {
  assertExactObject(value, ['status', 'budgetState', 'attemptCount', 'toolCalls'], path)
  assertEnum(value.status, INTERACTION_STATUSES, `${path}.status`)
  assertEnum(value.budgetState, BUDGET_STATES, `${path}.budgetState`)
  assertInteger(value.attemptCount, `${path}.attemptCount`)
  assertToolCalls(value.toolCalls, `${path}.toolCalls`)

  const lastAttempt = value.toolCalls.length === 0 ? 0 : value.toolCalls[value.toolCalls.length - 1].attempt
  if (value.attemptCount !== lastAttempt) fail(`${path}.attemptCount`, 'must equal the final retained attempt')
  const hasStarted = value.toolCalls.some((call) => call.status === 'started')
  if (value.status === 'running') {
    if (value.budgetState !== 'within_budget') fail(`${path}.budgetState`, 'running interactions cannot report exhaustion')
  } else {
    if (hasStarted) fail(`${path}.toolCalls`, 'terminal interactions cannot retain a started call')
    if (value.status !== 'failed' && value.budgetState !== 'within_budget') {
      fail(`${path}.budgetState`, 'only failed interactions can report exhaustion')
    }
  }
  return value
}

function normalizeFieldKey (key) {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

function assertFixturePrivacy (value, path = 'AgentToolTraceUiFixture') {
  const visit = (current, currentPath) => {
    if (current === null || typeof current !== 'object') {
      if (typeof current === 'string' && FORBIDDEN_VALUE.test(current)) {
        fail(currentPath, 'contains a forbidden private value')
      }
      return
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${currentPath}[${index}]`))
      return
    }
    for (const [key, child] of Object.entries(current)) {
      if (FORBIDDEN_FIELD_KEYS.has(normalizeFieldKey(key))) {
        fail(`${currentPath}.${key}`, 'contains a forbidden private field')
      }
      visit(child, `${currentPath}.${key}`)
    }
  }
  visit(value, path)
  return value
}

function assertFixture (value, path = 'AgentToolTraceUiFixture') {
  assertExactObject(value, [
    'contract_id', 'contract_version', 'fixture_id', 'preview_only', 'synthetic',
    'j22_evidence', 'j24_evidence', 'scenario', 'snapshot'
  ], path)
  assertContractHeader(value, path)
  assertIdentifier(value.fixture_id, `${path}.fixture_id`)
  if (value.preview_only !== true) fail(`${path}.preview_only`, 'must be true')
  if (value.synthetic !== true) fail(`${path}.synthetic`, 'must be true')
  if (value.j22_evidence !== false || value.j24_evidence !== false) {
    fail(path, 'fixtures cannot claim J22 or J24 evidence')
  }
  assertEnum(value.scenario, FIXTURE_SCENARIOS, `${path}.scenario`)
  assertSnapshot(value.snapshot, `${path}.snapshot`)
  assertFixturePrivacy(value, path)
  return value
}

module.exports = Object.freeze({
  BUDGET_STATES,
  CONTRACT_ID,
  CONTRACT_VERSION,
  FIXTURE_SCENARIOS,
  INTERACTION_STATUSES,
  assertFixture,
  assertFixturePrivacy,
  assertSnapshot,
  assertToolTraceCall,
  isSupportedContract
})
