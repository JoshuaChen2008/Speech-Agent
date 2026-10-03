'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { canonicalize, sha256Canonical } = require('../../runtime/storage-worker/canonical-json')
const { assertModelUsage } = require('../contracts/model-access-core')
const { assertSourceRef, validateRecipeOutput } = require('../contracts/recipes')
const {
  assertRecipeToolAuthorization,
  assertToolCallRecord,
  assertToolCallSequence
} = require('../contracts/controlled-tools')
const c = require('../contracts/agent-run-ui')

const EXPORT_SCHEMA_VERSION = 2
const LEGACY_EXPORT_SCHEMA_VERSION = 1
const IDENTIFIER = /^[a-z0-9][a-z0-9._:-]{0,159}$/
const DIGEST = /^[a-f0-9]{64}$/
const TOOL_NAMES = Object.freeze(['search_context', 'read_sources'])
const TOOL_STATUSES = Object.freeze(['started', 'succeeded', 'failed', 'cancelled'])
const TOOL_ERROR_CODES = Object.freeze([
  'TOOL_ARGS_INVALID', 'TOOL_SCOPE_DENIED', 'TOOL_NOT_AVAILABLE_FOR_RECIPE',
  'TOOL_BUDGET_EXCEEDED', 'TOOL_TIMEOUT', 'TOOL_CANCELLED', 'TOOL_INTERNAL_FAILURE'
])
const TASK_ERROR_CODES = new Set(c.RUN_ERROR_CODES)
const TERMINAL_REASONS = Object.freeze(['succeeded', 'failed', 'cancelled'])
const SCOPE_KINDS = Object.freeze(['selection', 'session', 'date_range', 'project', 'interaction'])
const MAX_TOOL_CALLS = 100

function exportError (message = 'AGENT_EXPORT_INVALID') {
  const error = new TypeError(message)
  error.code = 'AGENT_EXPORT_INVALID'
  return error
}

function fail (message) { throw exportError(message) }

function plain (value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`)
  }
  return value
}

function identifier (value, label) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail(`${label} is invalid`)
  return value
}

function digest (value, label, nullable = false) {
  if (nullable && value === null) return null
  if (typeof value !== 'string' || !DIGEST.test(value)) fail(`${label} is invalid`)
  return value
}

function nonNegativeInteger (value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} is invalid`)
  return value
}

function nullableBoolean (value, label) {
  if (value !== null && typeof value !== 'boolean') fail(`${label} is invalid`)
  return value
}

function memoryReferenceCount (toolCalls, recipeId) {
  if (recipeId !== 'summary.minutes') return null
  const refs = new Set()
  for (const call of toolCalls || []) {
    if (call?.toolName !== 'search_context' || call.status !== 'succeeded') continue
    for (const match of call.result?.matches || []) {
      for (const entry of match?.entries || []) {
        const ref = entry?.memoryRef
        if (ref && typeof ref.memoryId === 'string' && typeof ref.revisionId === 'string') {
          refs.add(`${ref.memoryId}:${ref.revisionId}`)
        }
      }
    }
  }
  return refs.size
}

function boundedInteger (value, label, maximum) {
  nonNegativeInteger(value, label)
  if (value > maximum) fail(`${label} is out of range`)
  return value
}

function cloneCanonical (value, label) {
  let encoded
  try { encoded = canonicalize(value) } catch { fail(`${label} is not canonical JSON`) }
  try { return JSON.parse(encoded) } catch { fail(`${label} is not canonical JSON`) }
}

function isLocalAbsolutePath (value) {
  return /^(?:[A-Za-z]:[\\/]|\\\\|\/(?:Users|home|tmp|var|private|mnt|workspace|root|data|opt|etc)(?:[\\/]|$))/i.test(value)
}

function assertExportPrivacy (value, label = 'snapshot', seen = new Set()) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'string' && isLocalAbsolutePath(value)) fail(`${label} contains a local path`)
    return value
  }
  if (seen.has(value)) fail(`${label} contains a cycle`)
  seen.add(value)
  try {
    c.assertFixturePrivacy(value, label)
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string' && isLocalAbsolutePath(child)) fail(`${label}.${key} contains a local path`)
      assertExportPrivacy(child, `${label}.${key}`, seen)
    }
  } finally {
    seen.delete(value)
  }
  return value
}

function validateScope (value) {
  plain(value, 'scope')
  const keys = Object.keys(value).sort()
  if (keys.join(',') !== 'kind,reference') fail('scope has non-exact keys')
  if (!SCOPE_KINDS.includes(value.kind)) fail('scope.kind is invalid')
  identifier(value.reference, 'scope.reference')
  return { kind: value.kind, reference: value.reference }
}

function validateModel (binding) {
  plain(binding, 'binding')
  identifier(binding.adapterId, 'binding.adapterId')
  identifier(binding.modelId, 'binding.modelId')
  identifier(binding.profileId, 'binding.profileId')
  nonNegativeInteger(binding.profileRevision, 'binding.profileRevision')
  if (!['local', 'cloud'].includes(binding.providerKind)) fail('binding.providerKind is invalid')
  return {
    adapter_id: binding.adapterId,
    model_id: binding.modelId,
    profile_id: binding.profileId,
    profile_revision: binding.profileRevision,
    provider_kind: binding.providerKind
  }
}

function validateUsage (usage) {
  if (usage === null) return null
  try { assertModelUsage(usage) } catch { fail('usage is invalid') }
  return cloneCanonical(usage, 'usage')
}

function validateResult (item, terminalReason, recipeId, recipeVersion) {
  digest(item.resultDigest, 'resultDigest', true)
  if (terminalReason !== 'succeeded') {
    if (item.result !== null || item.resultDigest !== null) fail('non-success interaction must not have a result')
    return null
  }
  plain(item.result, 'result')
  try { c.assertFixturePrivacy(item.result, 'result') } catch { fail('result violates privacy boundary') }
  const result = cloneCanonical(item.result, 'result')
  try { validateRecipeOutput(recipeId, recipeVersion, result) } catch { fail('result schema is invalid') }
  if (sha256Canonical(result) !== item.resultDigest) fail('result digest mismatch')
  return result
}

function validateToolCall (call, interactionId, previous, recipeId, recipeVersion) {
  plain(call, 'tool call')
  const expected = [
    'args', 'argsDigest', 'attempt', 'callId', 'callOrder', 'counts', 'endedOffsetMs',
    'errorCode', 'interactionId', 'result', 'resultDigest', 'schemaVersion',
    'sourceRefs', 'startedOffsetMs', 'status', 'toolName'
  ]
  if (Object.keys(call).sort().join(',') !== expected.sort().join(',')) fail('tool call schema is invalid')
  identifier(call.callId, 'tool call.callId')
  if (call.interactionId !== interactionId) fail('tool call interaction mismatch')
  boundedInteger(call.attempt, 'tool call.attempt', 100)
  if (call.attempt < 1) fail('tool call.attempt is invalid')
  boundedInteger(call.callOrder, 'tool call.callOrder', 12)
  if (call.callOrder < 1) fail('tool call.callOrder is invalid')
  if (previous && (call.attempt < previous.attempt || call.attempt === previous.attempt && call.callOrder <= previous.callOrder)) {
    fail('tool call order is not strictly increasing')
  }
  if (!TOOL_NAMES.includes(call.toolName) || call.schemaVersion !== 1) fail('tool call identity is invalid')
  nonNegativeInteger(call.startedOffsetMs, 'tool call.startedOffsetMs')
  if (call.endedOffsetMs !== null) {
    nonNegativeInteger(call.endedOffsetMs, 'tool call.endedOffsetMs')
    if (call.endedOffsetMs < call.startedOffsetMs) fail('tool call offsets are invalid')
  }
  if (!TOOL_STATUSES.includes(call.status) || call.status === 'started') fail('tool call is not terminal')
  if (call.errorCode !== null && !TOOL_ERROR_CODES.includes(call.errorCode)) fail('tool call.errorCode is invalid')
  if (call.status === 'succeeded' && call.errorCode !== null) fail('succeeded tool call has an error')
  if (call.status === 'succeeded' && call.result === null) fail('succeeded tool call has no result')
  if (call.status !== 'succeeded' && call.result !== null) fail('failed tool call has a result')
  if (call.status === 'cancelled' && call.errorCode !== 'TOOL_CANCELLED') fail('cancelled tool call has no cancellation code')
  if (call.status === 'failed' && call.errorCode === 'TOOL_CANCELLED') fail('failed tool call has a cancellation code')
  const args = cloneCanonical(call.args, 'tool call.args')
  digest(call.argsDigest, 'tool call.argsDigest')
  if (sha256Canonical(args) !== call.argsDigest) fail('tool args digest mismatch')
  let result = null
  if (call.result !== null) {
    result = cloneCanonical(call.result, 'tool call.result')
    digest(call.resultDigest, 'tool call.resultDigest')
    if (sha256Canonical(result) !== call.resultDigest) fail('tool result digest mismatch')
  } else if (call.resultDigest !== null) {
    fail('null tool result has a digest')
  }
  if (!Array.isArray(call.sourceRefs) || call.sourceRefs.length > 8) fail('tool call.sourceRefs is invalid')
  try { call.sourceRefs.forEach(assertSourceRef) } catch { fail('tool call.sourceRefs is invalid') }
  plain(call.counts, 'tool call.counts')
  const record = {
    callId: call.callId,
    attempt: call.attempt,
    callOrder: call.callOrder,
    toolName: call.toolName,
    schemaVersion: call.schemaVersion,
    startedOffsetMs: call.startedOffsetMs,
    endedOffsetMs: call.endedOffsetMs,
    status: call.status,
    errorCode: call.errorCode,
    args,
    argsDigest: call.argsDigest,
    result,
    resultDigest: call.resultDigest,
    sourceRefs: call.sourceRefs,
    counts: call.counts
  }
  try {
    assertRecipeToolAuthorization(recipeId, recipeVersion, call.toolName)
    assertToolCallRecord(record)
  } catch { fail('tool call schema is invalid') }
  assertExportPrivacy({ args, result, sourceRefs: call.sourceRefs, counts: call.counts }, 'tool call')
  return {
    call_id: call.callId,
    attempt: call.attempt,
    call_order: call.callOrder,
    tool_name: call.toolName,
    schema_version: call.schemaVersion,
    started_offset_ms: call.startedOffsetMs,
    ended_offset_ms: call.endedOffsetMs,
    status: call.status,
    error_code: call.errorCode,
    args,
    args_digest: call.argsDigest,
    result,
    result_digest: call.resultDigest,
    source_refs: cloneCanonical(call.sourceRefs, 'tool call.sourceRefs'),
    counts: cloneCanonical(call.counts, 'tool call.counts')
  }
}

function buildExportSnapshot (detail, requestedInteractionId = null) {
  plain(detail, 'detail')
  const item = plain(detail.interaction, 'detail.interaction')
  const interactionId = identifier(item.interactionId, 'interactionId')
  if (requestedInteractionId !== null && interactionId !== requestedInteractionId) fail('interaction identity mismatch')
  identifier(item.runId, 'runId')
  identifier(item.recipeId, 'recipeId')
  identifier(item.recipeVersion, 'recipeVersion')
  const scope = validateScope(item.scope)
  digest(item.inputDigest, 'inputDigest')
  const terminalReason = item.terminalReason
  if (!TERMINAL_REASONS.includes(terminalReason)) fail('interaction is not terminal')
  if (detail.runState !== terminalReason) fail('run and interaction terminal states disagree')
  nonNegativeInteger(item.durationMs, 'durationMs')
  boundedInteger(item.attemptCount, 'attemptCount', 100)
  if (item.attemptCount < 1) fail('attemptCount is invalid')
  nonNegativeInteger(item.createdAt, 'createdAt')
  nonNegativeInteger(item.terminalAt, 'terminalAt')
  if (item.terminalAt < item.createdAt) fail('terminalAt precedes createdAt')
  if (item.errorCode !== null && !TASK_ERROR_CODES.has(item.errorCode)) fail('errorCode is invalid')
  if (terminalReason === 'failed' && item.errorCode === null) fail('failed interaction has no error code')
  if (terminalReason !== 'failed' && item.errorCode !== null) fail('non-failed interaction has an error code')
  const model = validateModel(detail.binding)
  const result = validateResult(item, terminalReason, item.recipeId, item.recipeVersion)
  const usage = validateUsage(item.usage)
  const rawCalls = Array.isArray(detail.toolCalls) ? detail.toolCalls : null
  if (!rawCalls || rawCalls.length > MAX_TOOL_CALLS) fail('tool call list is invalid')
  let previous = null
  const toolCalls = rawCalls.map((call) => {
    const normalized = validateToolCall(call, interactionId, previous, item.recipeId, item.recipeVersion)
    previous = { attempt: normalized.attempt, callOrder: normalized.call_order }
    return normalized
  })
  try {
    const records = rawCalls.map((call) => ({
      callId: call.callId,
      attempt: call.attempt,
      callOrder: call.callOrder,
      toolName: call.toolName,
      schemaVersion: call.schemaVersion,
      startedOffsetMs: call.startedOffsetMs,
      endedOffsetMs: call.endedOffsetMs,
      status: call.status,
      errorCode: call.errorCode,
      args: call.args,
      argsDigest: call.argsDigest,
      result: call.result,
      resultDigest: call.resultDigest,
      sourceRefs: call.sourceRefs,
      counts: call.counts
    }))
    assertToolCallSequence(records)
    if (records.some((record) => record.status === 'started')) fail('terminal export contains a started tool call')
  } catch (error) {
    if (error?.code === 'AGENT_EXPORT_INVALID') throw error
    fail('tool call sequence is invalid')
  }
  const frozenSummaryPolicy = item.recipeId === 'summary.minutes'
    ? (detail.summaryUseMemory ?? item.summaryUseMemory ?? null)
    : null
  nullableBoolean(frozenSummaryPolicy, 'summaryUseMemory')
  const summaryMemoryReferenceCount = memoryReferenceCount(rawCalls, item.recipeId)
  const snapshot = {
    schema_version: frozenSummaryPolicy === null ? LEGACY_EXPORT_SCHEMA_VERSION : EXPORT_SCHEMA_VERSION,
    interaction_id: interactionId,
    run_id: item.runId,
    scope,
    recipe_id: item.recipeId,
    recipe_version: item.recipeVersion,
    model,
    input_digest: item.inputDigest,
    result_digest: item.resultDigest,
    terminal_reason: terminalReason,
    error_code: item.errorCode,
    usage,
    duration_ms: item.durationMs,
    attempt_count: item.attemptCount,
    created_at: item.createdAt,
    terminal_at: item.terminalAt,
    result,
    tool_calls: toolCalls
  }
  if (frozenSummaryPolicy !== null) {
    snapshot.summary_use_memory = frozenSummaryPolicy
    snapshot.memory_reference_count = summaryMemoryReferenceCount
  }
  if (detail.summaryInputPolicy !== undefined) {
    if (detail.summaryInputPolicy !== 'summary-long-input@1' || item.recipeId !== 'summary.minutes' || item.recipeVersion !== '2') fail('invalid summary policy')
    snapshot.schema_version = 3
    snapshot.summary_input_policy = detail.summaryInputPolicy
    snapshot.summary_input_plan = null
    if (detail.summaryPlan !== null) {
      const plan = plain(detail.summaryPlan, 'summary plan')
      if (Object.keys(plan).sort().join(',') !== 'binding_digest,canonical_bytes,input_digest,leaf_count,node_count,plan_digest,policy_version,raw_text_bytes,segment_count') fail('invalid summary plan fields')
      if (plan.policy_version !== detail.summaryInputPolicy || plan.input_digest !== item.inputDigest) fail('invalid summary plan identity')
      for (const key of ['plan_digest', 'input_digest', 'binding_digest']) digest(plan[key], key)
      for (const [key, max] of Object.entries({ leaf_count: 256, node_count: 384, segment_count: 50000, raw_text_bytes: 4194304, canonical_bytes: 8388608 })) {
        boundedInteger(plan[key], key, max)
        if (plan[key] < 1) fail('invalid summary plan count')
      }
      snapshot.summary_input_plan = cloneCanonical(plan, 'summary plan')
    } else if (terminalReason === 'succeeded') fail('successful long summary has no plan')
  }
  if (item.recipeId === 'qa.answer' && ['3', '4', '5'].includes(item.recipeVersion) && detail.questionInputPolicy === undefined) fail('question policy is missing')
  if (detail.questionInputPolicy !== undefined) {
    const retrieval = ['4', '5'].includes(item.recipeVersion)
    if (detail.questionInputPolicy !== (retrieval ? 'question-retrieval@1' : 'qa-long-input@1') || item.recipeId !== 'qa.answer' || !['3', '4', '5'].includes(item.recipeVersion)) fail('invalid question policy')
    snapshot.schema_version = retrieval ? 5 : 4
    snapshot.question_input_policy = detail.questionInputPolicy
    snapshot.question_input_plan = null
    if (detail.questionPlan !== null) {
      const plan = plain(detail.questionPlan, 'question plan')
      if (Object.keys(plan).sort().join(',') !== 'binding_digest,canonical_bytes,input_digest,leaf_count,node_count,plan_digest,policy_version,raw_text_bytes,segment_count') fail('invalid question plan fields')
      if (plan.policy_version !== detail.questionInputPolicy || plan.input_digest !== item.inputDigest) fail('invalid question plan identity')
      for (const key of ['plan_digest', 'input_digest', 'binding_digest']) digest(plan[key], key)
      for (const [key, max] of Object.entries({ leaf_count: 256, node_count: 384, segment_count: 50000, raw_text_bytes: 4194304, canonical_bytes: 8388608 })) {
        boundedInteger(plan[key], key, max)
        if (plan[key] < 1) fail('invalid question plan count')
      }
      if (plan.node_count < plan.leaf_count) fail('invalid question node count')
      snapshot.question_input_plan = cloneCanonical(plan, 'question plan')
    } else if (terminalReason === 'succeeded') fail('successful long question has no plan')
    if (retrieval) {
      snapshot.question_evidence = null
      if (detail.questionEvidence !== null && detail.questionEvidence !== undefined) {
        const evidence = plain(detail.questionEvidence, 'question evidence')
        if (Object.keys(evidence).sort().join(',') !== 'coverage_json,descriptor_json,evidence_digest,source_refs_json') fail('invalid evidence fields')
        digest(evidence.evidence_digest, 'evidence digest')
        let descriptor, sourceRefs, coverage
        try { descriptor = JSON.parse(evidence.descriptor_json); sourceRefs = JSON.parse(evidence.source_refs_json); coverage = JSON.parse(evidence.coverage_json) } catch { fail('invalid question evidence') }
        if (!Array.isArray(sourceRefs)) fail('invalid question references')
        sourceRefs.forEach(assertSourceRef)
        if (terminalReason === 'succeeded' && canonicalize(item.result.coverage) !== canonicalize(coverage)) fail('question coverage mismatch')
        snapshot.question_evidence = { evidence_digest: evidence.evidence_digest, descriptor, source_refs: sourceRefs, coverage }
        if (descriptor.pages) {
          if (!Array.isArray(detail.questionEvidencePages) || detail.questionEvidencePages.length !== descriptor.pages.length) fail('question evidence pages are missing')
          const pages = detail.questionEvidencePages.map((page, ordinal) => {
            if (Object.keys(page).sort().join(',') !== 'descriptor_json,evidence_digest,ordinal' || Number(page.ordinal) !== ordinal ||
                page.evidence_digest !== descriptor.pages[ordinal].evidenceDigest) fail('question evidence page mismatch')
            digest(page.evidence_digest, 'evidence page digest')
            if (descriptor.pages[ordinal].descriptorDigest !== undefined &&
                sha256Canonical(JSON.parse(page.descriptor_json)) !== descriptor.pages[ordinal].descriptorDigest) fail('question evidence descriptor mismatch')
            return { ordinal, evidence_digest: page.evidence_digest, descriptor: JSON.parse(page.descriptor_json) }
          })
          snapshot.schema_version = 6
          snapshot.question_evidence.pages = pages
        }
      } else if (terminalReason === 'succeeded') fail('successful retrieval question has no evidence')
    }
  }
  try { assertExportPrivacy(snapshot) } catch { fail('snapshot violates privacy boundary') }
  return snapshot
}

async function writeAtomic (filePath, bytes, options = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0 || !Buffer.isBuffer(bytes)) fail('write target is invalid')
  const fsApi = options.fsApi || fs.promises
  const makeId = options.randomUUID || crypto.randomUUID
  const directory = path.dirname(filePath)
  const base = path.basename(filePath)
  const temporaryPath = path.join(directory, `.${base}.${makeId()}.tmp`)
  let handle = null
  let renamed = false
  try {
    handle = await fsApi.open(temporaryPath, 'wx', 0o600)
    await handle.writeFile(bytes)
    await handle.sync()
    await handle.close()
    handle = null
    await fsApi.rename(temporaryPath, filePath)
    renamed = true
  } finally {
    if (handle) await handle.close().catch(() => {})
    if (!renamed) await fsApi.unlink(temporaryPath).catch(() => {})
  }
}

function defaultFileName (interactionId) {
  return `agent-interaction-${interactionId.replace(/[^a-z0-9._-]/gi, '_')}.json`
}

class AgentInteractionExporter {
  constructor (options = {}) {
    if (!options.storage || typeof options.storage.getAgentInteraction !== 'function') throw new TypeError('storage gateway is required')
    if (typeof options.showSaveDialog !== 'function') throw new TypeError('showSaveDialog is required')
    this.storage = options.storage
    this.showSaveDialog = options.showSaveDialog
    this.writeAtomic = typeof options.writeAtomic === 'function' ? options.writeAtomic : writeAtomic
  }

  async exportInteraction ({ interactionId, ownerWindow = null } = {}) {
    identifier(interactionId, 'interactionId')
    const detail = await this.storage.getAgentInteraction({ interactionId })
    const snapshot = buildExportSnapshot(detail, interactionId)
    const encoded = canonicalize(snapshot)
    const bytes = Buffer.from(encoded, 'utf8')
    const dialogResult = await this.showSaveDialog(ownerWindow, {
      title: '导出 Agent 交互 JSON',
      defaultPath: defaultFileName(interactionId),
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['createDirectory', 'showOverwriteConfirmation']
    })
    if (!dialogResult || dialogResult.canceled === true || typeof dialogResult.filePath !== 'string' || dialogResult.filePath.length === 0) {
      return { cancelled: true }
    }
    await this.writeAtomic(dialogResult.filePath, bytes)
    return {
      bytes_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      interaction_id: interactionId,
      schema_version: snapshot.schema_version,
      snapshot
    }
  }
}

module.exports = {
  AgentInteractionExporter,
  EXPORT_SCHEMA_VERSION,
  buildExportSnapshot,
  writeAtomic
}
