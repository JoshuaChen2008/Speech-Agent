'use strict'

// @ts-check

/* S3 interaction facts live behind the storage worker.  This module is the
   only writer for v7 interaction/tool/presentation rows; callers submit exact
   commands and never receive the DatabaseSync handle. */

const { canonicalize, sha256Canonical } = require('./canonical-json')
const { rollbackQuietly } = require('./sqlite-store')
const {
  StorageError,
  isPlainObject
} = require('./protocol')
const {
  assertModelUsage,
  EXECUTION_FORMS
} = require('../../agent/contracts/model-access-core')
const {
  assertSourceRef,
  comparisonGroupId,
  getRecipe,
  validateRecipeOutput
} = require('../../agent/contracts/recipes')

const TASK_ERROR_CODES = Object.freeze([
  'AGENT_PROVIDER_AUTH_FAILED',
  'AGENT_PROVIDER_RATE_LIMITED',
  'AGENT_PROVIDER_UNAVAILABLE',
  'AGENT_PROVIDER_TIMEOUT',
  'AGENT_OUTPUT_INVALID',
  'AGENT_PERMISSION_DENIED',
  'AGENT_REQUEST_INVALID',
  'AGENT_WORKER_EXITED',
  'AGENT_INTERNAL_FAILURE',
  'AGENT_BUDGET_EXCEEDED',
  'AGENT_SUMMARY_MEMORY_READ_FAILED',
  'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED'
])

const TOOL_ERROR_CODES = Object.freeze([
  'TOOL_ARGS_INVALID',
  'TOOL_SCOPE_DENIED',
  'TOOL_NOT_AVAILABLE_FOR_RECIPE',
  'TOOL_BUDGET_EXCEEDED',
  'TOOL_TIMEOUT',
  'TOOL_CANCELLED',
  'TOOL_INTERNAL_FAILURE'
])

const TOOL_NAMES = Object.freeze(['search_context', 'read_sources'])
const ROUTING_MODES = Object.freeze(['model', 'rules', 'preset'])
const TERMINAL_REASONS = Object.freeze(['succeeded', 'failed', 'cancelled'])
const TOOL_STATUSES = Object.freeze(['started', 'succeeded', 'failed', 'cancelled'])
const SUMMARY_MEMORY_ERROR = 'AGENT_SUMMARY_MEMORY_READ_FAILED'
const SUMMARY_INPUT_LIMIT_ERROR = 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED'
const MAX_INTERACTION_PAGE = 100
const MAX_SOURCE_REFS = 8
const MAX_ARGS_BYTES = 8192
const MAX_RESULT_BYTES = 65536
const RUN_SCOPE_KINDS = Object.freeze(['selection', 'session', 'date_range', 'project', 'interaction'])
const RUN_WATERMARK_KEYS = Object.freeze(['fromEventOrder', 'throughEventOrder', 'throughInteractionRevision'])

function fail (code) {
  throw new StorageError(code)
}

function exactObject (value, keys, code = 'AGENT_REQUEST_INVALID', optional = []) {
  if (Array.isArray(code)) {
    optional = code
    code = 'AGENT_REQUEST_INVALID'
  }
  if (!isPlainObject(value)) fail(code)
  const allowed = new Set([...keys, ...optional])
  const actual = Object.keys(value)
  if (actual.some((key) => !allowed.has(key)) || keys.some((key) => !Object.hasOwn(value, key))) fail(code)
  if (actual.length !== keys.length + optional.filter((key) => Object.hasOwn(value, key)).length) fail(code)
  return value
}

function identifier (value, code = 'AGENT_REQUEST_INVALID') {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) fail(code)
  return value
}

function digest (value, code = 'AGENT_REQUEST_INVALID') {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(code)
  return value
}

function nonNegativeInteger (value, code = 'AGENT_REQUEST_INVALID') {
  if (!Number.isSafeInteger(value) || value < 0) fail(code)
  return value
}

function boundedInteger (value, minimum, maximum, code = 'AGENT_REQUEST_INVALID') {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(code)
  return value
}

function jsonValue (value, code = 'AGENT_REQUEST_INVALID') {
  let encoded
  try { encoded = canonicalize(value) } catch { fail(code) }
  return { value, encoded }
}

function jsonObject (encoded, code = 'STORAGE_COMMAND_FAILED') {
  try { return JSON.parse(encoded) } catch { fail(code) }
}

function publicErrorCode (error, fallback = 'AGENT_REQUEST_INVALID') {
  return error?.code && (TASK_ERROR_CODES.includes(error.code) || TOOL_ERROR_CODES.includes(error.code))
    ? error.code
    : fallback
}

function visibleErrorCode (row) {
  if (row?.summary_input_limit_error === 1) return SUMMARY_INPUT_LIMIT_ERROR
  return row?.summary_memory_error === 1 ? SUMMARY_MEMORY_ERROR : row?.error_code
}

function memoryReferenceCountFromRows (rows, recipeId) {
  if (recipeId !== 'summary.minutes') return null
  const references = new Set()
  for (const row of rows || []) {
    if (row.tool_name !== 'search_context' || row.status !== 'succeeded' || row.result_json === null) continue
    let result
    try { result = JSON.parse(row.result_json) } catch { fail('STORAGE_COMMAND_FAILED') }
    for (const match of result?.matches || []) {
      for (const entry of match?.entries || []) {
        const reference = entry?.memoryRef
        if (reference && typeof reference.memoryId === 'string' && typeof reference.revisionId === 'string') {
          references.add(`${reference.memoryId}\u0000${reference.revisionId}`)
        }
      }
    }
  }
  return references.size
}

function storedErrorCode (code) {
  return code === SUMMARY_MEMORY_ERROR || code === SUMMARY_INPUT_LIMIT_ERROR ? 'AGENT_INTERNAL_FAILURE' : code
}

function runScope (row) {
  try { return JSON.parse(row.scope_json) } catch { fail('STORAGE_COMMAND_FAILED') }
}

function inputWatermark (row) {
  try { return JSON.parse(row.input_watermark_json) } catch { fail('STORAGE_COMMAND_FAILED') }
}

function rowInteraction (row, replayed = false) {
  const result = row.result_json === null ? null : jsonObject(row.result_json)
  const usage = row.usage_json === null ? null : jsonObject(row.usage_json)
  const value = {
    interactionId: row.interaction_id,
    runId: row.run_id,
    recipeId: row.recipe_id,
    recipeVersion: row.recipe_version,
    maxTurns: Number(row.max_turns),
    toolGrants: jsonObject(row.tool_grants_json),
    routingMode: row.routing_mode,
    requestedBy: row.requested_by,
    scope: jsonObject(row.scope_json),
    scopeDigest: row.scope_digest,
    inputDigest: row.input_digest,
    promptDigest: row.prompt_digest,
    terminalReason: row.terminal_reason,
    errorCode: visibleErrorCode(row),
    usage,
    durationMs: Number(row.duration_ms),
    attemptCount: Number(row.attempt_count),
    comparisonGroupId: row.comparison_group_id,
    result,
    resultDigest: row.result_digest,
    createdAt: Number(row.created_at),
    terminalAt: row.terminal_at === null ? null : Number(row.terminal_at)
  }
  return replayed ? { ...value, replayed: true } : value
}

function rowRun (row, replayed = false) {
  const value = {
    runId: row.run_id,
    recipeId: row.recipe_id,
    recipeVersion: row.recipe_version,
    scope: jsonObject(row.scope_json),
    scopeDigest: row.scope_digest,
    transcriptVersion: row.transcript_version,
    inputWatermark: jsonObject(row.input_watermark_json),
    inputDigest: row.input_digest,
    requestedBy: row.requested_by,
    summaryUseMemory: row.summary_use_memory === undefined || row.summary_use_memory === null
      ? null
      : row.summary_use_memory !== 0,
    state: row.state,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: Number(row.next_attempt_at),
    cancelRequested: row.cancel_requested_at !== null,
    errorCode: visibleErrorCode(row),
    resultDigest: row.result_digest,
    resultSummary: row.result_summary_json === null ? null : jsonObject(row.result_summary_json),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
  return replayed ? { ...value, replayed: true } : value
}

function rowToolCall (row, replayed = false) {
  const parsedCounts = jsonObject(row.counts_json)
  const counts = Object.keys(parsedCounts).length === 0
    ? { resultBytes: 0, sourceTextBytes: 0, sourceReferenceCount: 0 }
    : parsedCounts
  const value = {
    callId: row.call_id,
    interactionId: row.interaction_id,
    attempt: Number(row.attempt),
    callOrder: Number(row.call_order),
    toolName: row.tool_name,
    schemaVersion: Number(row.schema_version),
    startedOffsetMs: Number(row.started_offset_ms),
    endedOffsetMs: row.ended_offset_ms === null ? null : Number(row.ended_offset_ms),
    status: row.status,
    errorCode: row.error_code,
    args: jsonObject(row.args_json),
    argsDigest: row.args_digest,
    result: row.result_json === null ? null : jsonObject(row.result_json),
    resultDigest: row.result_digest,
    sourceRefs: jsonObject(row.source_refs_json),
    counts
  }
  return replayed ? { ...value, replayed: true } : value
}

function historyModelProjection (row) {
  const model = {
    adapterId: row.binding_adapter_id,
    modelId: row.binding_model_id,
    profileId: row.binding_profile_id,
    profileRevision: Number(row.binding_profile_revision),
    providerKind: row.binding_provider_kind
  }
  if (typeof model.adapterId !== 'string' || model.adapterId.length === 0 ||
      typeof model.modelId !== 'string' || model.modelId.length === 0 ||
      typeof model.profileId !== 'string' || model.profileId.length === 0 ||
      !Number.isSafeInteger(model.profileRevision) || model.profileRevision < 1 ||
      !['local', 'cloud'].includes(model.providerKind)) {
    fail('STORAGE_COMMAND_FAILED')
  }
  return model
}

function historyProjection (row) {
  return {
    interactionId: row.interaction_id,
    runId: row.run_id,
    recipeId: row.recipe_id,
    recipeVersion: row.recipe_version,
    terminalReason: row.terminal_reason,
    errorCode: visibleErrorCode(row),
    usage: row.usage_json === null ? null : jsonObject(row.usage_json),
    durationMs: Number(row.duration_ms),
    attemptCount: Number(row.attempt_count),
    comparisonGroupId: row.comparison_group_id,
    model: historyModelProjection(row),
    result: row.result_json === null ? null : jsonObject(row.result_json),
    resultDigest: row.result_digest,
    summaryUseMemory: row.summary_use_memory === undefined || row.summary_use_memory === null
      ? null
      : row.summary_use_memory !== 0,
    memoryReferenceCount: row.recipe_id === 'summary.minutes'
      ? (Number.isSafeInteger(row.memory_reference_count) ? row.memory_reference_count : null)
      : null,
    createdAt: Number(row.created_at),
    terminalAt: Number(row.terminal_at)
  }
}

function encodeCursor (value) {
  return Buffer.from(canonicalize(value), 'utf8').toString('base64url')
}

function decodeCursor (value) {
  if (value === null) return null
  if (typeof value !== 'string' || value.length < 1 || value.length > 240 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('AGENT_REQUEST_INVALID')
  let parsed
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) } catch { fail('AGENT_REQUEST_INVALID') }
  exactObject(parsed, ['terminalAt', 'interactionId'])
  nonNegativeInteger(parsed.terminalAt)
  identifier(parsed.interactionId)
  if (encodeCursor(parsed) !== value) fail('AGENT_REQUEST_INVALID')
  return parsed
}

function validateRunScope (value) {
  exactObject(value, ['kind', 'reference'])
  if (!RUN_SCOPE_KINDS.includes(value.kind)) fail('AGENT_REQUEST_INVALID')
  identifier(value.reference)
  return { kind: value.kind, reference: value.reference }
}

function runWatermark (value) {
  if (!isPlainObject(value)) fail('AGENT_REQUEST_INVALID')
  const keys = Object.keys(value)
  if (keys.some((key) => !RUN_WATERMARK_KEYS.includes(key))) fail('AGENT_REQUEST_INVALID')
  for (const key of keys) nonNegativeInteger(value[key])
  return JSON.parse(canonicalize(value))
}

class AgentExecutionStore {
  constructor (options = {}) {
    if (!options.subtitleStore?.database) throw new TypeError('subtitleStore is required')
    this.database = options.subtitleStore.database
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
  }

  nowValue () {
    const value = this.now()
    return nonNegativeInteger(value, 'STORAGE_COMMAND_FAILED')
  }

  transaction (callback) {
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      this.database.exec('COMMIT')
      return result
    } catch (error) {
      rollbackQuietly(this.database)
      throw error
    }
  }

  interactionRow (interactionId) {
    const row = this.database.prepare('SELECT * FROM formal_agent_interactions WHERE interaction_id = ?').get(interactionId)
    if (!row) fail('AGENT_INTERACTION_NOT_FOUND')
    return row
  }

  runRow (runId) {
    const row = this.database.prepare('SELECT * FROM formal_agent_runs WHERE run_id = ?').get(runId)
    if (!row) fail('AGENT_RUN_NOT_FOUND')
    return row
  }

  assertActiveAttempt (run, attemptIdentity, now, { allowCancelRequested = false } = {}) {
    exactObject(attemptIdentity, ['runId', 'attempt', 'owner', 'leaseExpiresAt'])
    const runId = identifier(attemptIdentity.runId)
    boundedInteger(attemptIdentity.attempt, 1, 100)
    identifier(attemptIdentity.owner)
    nonNegativeInteger(attemptIdentity.leaseExpiresAt)
    if (!run || run.run_id !== runId || run.state !== 'running' ||
        Number(run.attempt_count) !== attemptIdentity.attempt || run.lease_owner !== attemptIdentity.owner ||
        attemptIdentity.leaseExpiresAt > Number(run.lease_expires_at) || Number(run.lease_expires_at) <= now ||
        (!allowCancelRequested && run.cancel_requested_at !== null)) {
      fail('AGENT_CONTEXT_OPERATION_FAILED')
    }
    return attemptIdentity
  }

  guardTombstone (row) {
    const scope = runScope(row)
    const sessionId = scope && scope.kind === 'session' ? scope.reference : null
    if (typeof sessionId === 'string' && this.database.prepare(
      'SELECT 1 FROM session_deletion_tombstones WHERE session_id = ?'
    ).get(sessionId)) fail('AGENT_SESSION_DELETED')
  }

  recipeForRun (run) {
    try { return getRecipe(run.recipe_id, run.recipe_version) } catch (error) {
      if (error.code === 'AGENT_REQUEST_INVALID') throw new StorageError('AGENT_REQUEST_INVALID')
      throw error
    }
  }

  bindingForRun (run) {
    const binding = this.database.prepare('SELECT * FROM agent_model_run_bindings WHERE run_id = ?').get(run.run_id)
    if (!binding || !EXECUTION_FORMS.includes(binding.execution_form)) fail('AGENT_REQUEST_INVALID')
    if (binding.execution_form !== 'agent_loop') fail('AGENT_REQUEST_INVALID')
    if (binding.purpose !== this.recipeForRun(run).modelPurpose) fail('AGENT_REQUEST_INVALID')
    let capabilities
    try { capabilities = JSON.parse(binding.capability_json) } catch { fail('STORAGE_COMMAND_FAILED') }
    return { row: binding, capabilities }
  }

  createRun (input) {
    exactObject(input, [
      'runId', 'recipeId', 'recipeVersion', 'scope', 'transcriptVersion',
      'inputWatermark', 'inputDigest', 'requestedBy', 'clientIdempotencyKey'
    ], ['summaryUseMemory', 'requestId', 'requestGeneration'])
    const runId = identifier(input.runId)
    let recipe
    try { recipe = getRecipe(input.recipeId, input.recipeVersion) } catch { fail('AGENT_REQUEST_INVALID') }
    const scope = validateRunScope(input.scope)
    if (!recipe.inputScopes.includes(scope.kind)) fail('AGENT_REQUEST_INVALID')
    if (!['raw', 'refined'].includes(input.transcriptVersion)) fail('AGENT_REQUEST_INVALID')
    const inputWatermark = runWatermark(input.inputWatermark)
    digest(input.inputDigest)
    if (input.requestedBy !== 'automatic' && input.requestedBy !== 'user') fail('AGENT_REQUEST_INVALID')
    if (input.requestedBy === 'user') identifier(input.clientIdempotencyKey)
    else if (input.clientIdempotencyKey !== null) fail('AGENT_REQUEST_INVALID')
    const summaryUseMemory = recipe.recipeId === 'summary.minutes'
      ? (input.summaryUseMemory === undefined ? true : input.summaryUseMemory)
      : null
    if (recipe.recipeId === 'summary.minutes' && typeof summaryUseMemory !== 'boolean') fail('AGENT_REQUEST_INVALID')
    if (Object.hasOwn(input, 'requestId') !== Object.hasOwn(input, 'requestGeneration')) fail('AGENT_REQUEST_INVALID')
    const requestId = input.requestId === undefined ? null : identifier(input.requestId)
    const requestGeneration = input.requestGeneration === undefined ? null : boundedInteger(input.requestGeneration, 1, Number.MAX_SAFE_INTEGER)
    if (requestId !== null && input.requestedBy !== 'user') fail('AGENT_REQUEST_INVALID')
    if (scope.kind === 'session' && !Object.hasOwn(inputWatermark, 'throughEventOrder')) fail('AGENT_REQUEST_INVALID')
    let acceptedRequest = null
    const requestIdentity = {
      recipeId: recipe.recipeId,
      recipeVersion: recipe.recipeVersion,
      scope,
      transcriptVersion: input.transcriptVersion,
      inputWatermark,
      inputDigest: input.inputDigest,
      requestedBy: input.requestedBy,
      clientIdempotencyKey: input.clientIdempotencyKey
    }
    /* Preserve replay identity for rows created before the summary policy was
       added; only explicitly supplied policies become part of a new digest. */
    if (recipe.recipeId === 'summary.minutes' && Object.hasOwn(input, 'summaryUseMemory')) requestIdentity.summaryUseMemory = summaryUseMemory
    if (requestId !== null) requestIdentity.requestId = requestId
    const requestDigest = sha256Canonical(requestIdentity)
    const dedupeKey = input.requestedBy === 'user'
      ? sha256Canonical({ requestedBy: 'user', clientIdempotencyKey: input.clientIdempotencyKey })
      : sha256Canonical({
          requestedBy: 'automatic', recipeId: recipe.recipeId, recipeVersion: recipe.recipeVersion,
          scope, transcriptVersion: input.transcriptVersion, inputWatermark, inputDigest: input.inputDigest
        })
    const scopeDigest = sha256Canonical(scope)
    return this.transaction(() => {
      if (requestId !== null) {
        acceptedRequest = this.database.prepare('SELECT * FROM formal_agent_requests WHERE request_id=?').get(requestId)
        if (!acceptedRequest || Number(acceptedRequest.generation) !== requestGeneration) fail('AGENT_REQUEST_IDENTITY_CONFLICT')
        if (acceptedRequest.cancel_requested !== 0 || acceptedRequest.state === 'cancelled') fail('AGENT_INTERACTION_STATE_CONFLICT')
        if ((acceptedRequest.action === 'summary') !== (recipe.recipeId === 'summary.minutes')) {
          fail('AGENT_REQUEST_IDENTITY_CONFLICT')
        }
        if (acceptedRequest.session_id !== scope.reference || acceptedRequest.scope_digest !== scopeDigest) {
          fail('AGENT_REQUEST_IDENTITY_CONFLICT')
        }
        if (recipe.recipeId === 'summary.minutes' && acceptedRequest.summary_use_memory !== (summaryUseMemory ? 1 : 0)) {
          fail('AGENT_REQUEST_IDENTITY_CONFLICT')
        }
      }
      const byId = this.database.prepare('SELECT * FROM formal_agent_runs WHERE run_id=?').get(runId)
      if (byId) {
        if (byId.request_digest !== requestDigest || byId.dedupe_key !== dedupeKey ||
            requestId !== null && byId.session_summary_request_id !== requestId) fail('AGENT_REQUEST_INVALID')
        return rowRun(byId, true)
      }
      const byDedupe = this.database.prepare('SELECT * FROM formal_agent_runs WHERE dedupe_key=?').get(dedupeKey)
      if (byDedupe) {
        if (byDedupe.request_digest !== requestDigest || requestId !== null && byDedupe.session_summary_request_id !== requestId) fail('AGENT_REQUEST_INVALID')
        return rowRun(byDedupe, true)
      }
      const byClient = input.clientIdempotencyKey === null ? null : this.database.prepare(
        'SELECT * FROM formal_agent_runs WHERE client_idempotency_key=?'
      ).get(input.clientIdempotencyKey)
      if (byClient) {
        if (byClient.request_digest !== requestDigest || requestId !== null && byClient.session_summary_request_id !== requestId) fail('AGENT_REQUEST_INVALID')
        return rowRun(byClient, true)
      }
      if (acceptedRequest && (acceptedRequest.transcript_version !== input.transcriptVersion ||
          acceptedRequest.input_watermark_json !== canonicalize(inputWatermark) || acceptedRequest.input_digest !== input.inputDigest)) {
        fail('AGENT_REQUEST_IDENTITY_CONFLICT')
      }
      const now = this.nowValue()
      const revisionRow = this.database.prepare(`
        SELECT content_revision FROM personal_context_projection_state WHERE singleton_key = 1
      `).get()
      const personalContextRevision = Number(revisionRow?.content_revision)
      if (!Number.isSafeInteger(personalContextRevision) || personalContextRevision < 0) {
        fail('STORAGE_COMMAND_FAILED')
      }
      this.database.prepare(`
        INSERT INTO formal_agent_runs(
          run_id, dedupe_key, client_idempotency_key, request_digest,
          session_summary_request_id,
          recipe_id, recipe_version, scope_json, scope_digest, transcript_version,
        input_watermark_json, input_digest, personal_context_revision, summary_use_memory, requested_by, state, attempt_count,
          max_attempts, next_attempt_at, lease_owner, lease_expires_at,
          lease_renewed_from_expires_at, cancel_requested_at, error_code,
          result_digest, result_summary_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, 3, ?, NULL, NULL,
          NULL, NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        runId, dedupeKey, input.clientIdempotencyKey, requestDigest, requestId,
        recipe.recipeId, recipe.recipeVersion, canonicalize(scope), scopeDigest,
        input.transcriptVersion, canonicalize(inputWatermark), input.inputDigest,
        personalContextRevision, summaryUseMemory === null ? null : (summaryUseMemory ? 1 : 0), input.requestedBy, now, now, now
      )
      const run = this.database.prepare('SELECT * FROM formal_agent_runs WHERE run_id=?').get(runId)
      if (requestId !== null) {
        const isRoute = recipe.recipeId === 'intent.route'
        const column = isRoute ? 'route_run_id' : 'target_run_id'
        const state = isRoute ? 'routing' : 'queued'
        const phase = 'preparing'
        const linked = this.database.prepare(`
          UPDATE formal_agent_requests SET ${column}=?, state=?, phase=?, revision=revision+1,
            updated_at=?
          WHERE request_id=? AND generation=? AND cancel_requested=0 AND ${column} IS NULL
        `).run(runId, state, phase, now, requestId, requestGeneration)
        if (Number(linked.changes) !== 1) fail('AGENT_INTERACTION_STATE_CONFLICT')
      }
      return rowRun(run)
    })
  }

  sessionSummaryRequestRow (requestId) {
    const normalizedRequestId = identifier(requestId)
    const row = this.database.prepare('SELECT * FROM formal_agent_requests WHERE request_id=?').get(normalizedRequestId)
    if (!row) {
      const tombstone = this.database.prepare(`
        SELECT 1 FROM formal_agent_request_tombstones WHERE request_id_digest=?
      `).get(sha256Canonical({ requestId: normalizedRequestId }))
      if (tombstone) fail('AGENT_SESSION_DELETED')
      fail('AGENT_RUN_NOT_FOUND')
    }
    return row
  }

  sessionSummaryRequestProjection (row, replayed = false) {
    const targetRun = row.target_run_id === null
      ? null
      : this.database.prepare('SELECT run_id,recipe_id,state,attempt_count FROM formal_agent_runs WHERE run_id=?').get(row.target_run_id)
    const routeRun = row.route_run_id === null
      ? null
      : this.database.prepare('SELECT run_id,state FROM formal_agent_runs WHERE run_id=?').get(row.route_run_id)
    const targetInteraction = targetRun === null
      ? null
      : this.database.prepare('SELECT interaction_id,routing_mode FROM formal_agent_interactions WHERE run_id=?').get(targetRun.run_id)
    let state = row.state
    let phase = row.phase
    if (targetRun) {
      if (['succeeded', 'failed', 'cancelled'].includes(targetRun.state)) {
        state = targetRun.state
        phase = 'terminal'
      } else if (row.cancel_requested === 0) {
        state = targetRun.state
      }
    } else if (routeRun && row.cancel_requested === 0 && routeRun.state === 'running') {
      state = 'running'
    }
    const budget = row.budget_axis === null
      ? null
      : { axis: row.budget_axis, actual: Number(row.budget_actual), limit: Number(row.budget_limit) }
    return {
      requestId: row.request_id,
      clientKeyDigest: row.client_key_digest,
      requestDigest: row.request_digest,
      scopeDigest: row.scope_digest,
      promptDigest: row.prompt_digest,
      inputWatermark: row.input_watermark_json === null ? null : jsonObject(row.input_watermark_json),
      transcriptVersion: row.transcript_version,
      inputDigest: row.input_digest,
      action: row.action,
      summaryUseMemory: row.summary_use_memory === null ? null : row.summary_use_memory !== 0,
      routeRunId: row.route_run_id,
      targetRunId: row.target_run_id,
      targetInteractionId: targetInteraction?.interaction_id || null,
      targetRoutingMode: targetInteraction?.routing_mode || null,
      targetRecipeId: targetRun?.recipe_id || null,
      state,
      phase,
      generation: Number(row.generation),
      revision: Number(row.revision),
      cancelRequested: row.cancel_requested !== 0,
      resumeRequired: row.resume_required !== 0,
      attempt: Number(row.attempt),
      elapsedMs: Number(row.elapsed_ms),
      lastActivityElapsedMs: Number(row.last_activity_elapsed_ms),
      validatedChunkCount: row.validated_chunk_count === null ? null : Number(row.validated_chunk_count),
      totalChunkCount: row.total_chunk_count === null ? null : Number(row.total_chunk_count),
      memoryState: row.memory_state,
      errorCode: row.error_code,
      budget,
      diagnosticsAvailable: row.diagnostics_available !== 0,
      replayed
    }
  }

  acceptSessionSummaryRequest (input) {
    exactObject(input, [
      'requestId', 'sessionId', 'clientKeyDigest', 'requestDigest', 'scopeDigest', 'promptDigest', 'action', 'summaryUseMemory',
      'inputWatermark', 'transcriptVersion', 'inputDigest'
    ])
    const requestId = identifier(input.requestId)
    const sessionId = identifier(input.sessionId)
    for (const field of ['clientKeyDigest', 'requestDigest', 'scopeDigest', 'promptDigest']) digest(input[field])
    const inputWatermark = runWatermark(input.inputWatermark)
    if (Object.keys(inputWatermark).length !== 1 || inputWatermark.throughEventOrder === undefined || input.transcriptVersion !== 'raw') fail('AGENT_REQUEST_INVALID')
    digest(input.inputDigest)
    if (!['summary', 'question'].includes(input.action) ||
        input.action === 'summary' && typeof input.summaryUseMemory !== 'boolean' ||
        input.action === 'question' && input.summaryUseMemory !== null) fail('AGENT_REQUEST_INVALID')
    if (input.scopeDigest !== sha256Canonical({ kind: 'session', reference: sessionId })) fail('AGENT_REQUEST_INVALID')
    const now = this.nowValue()
    return this.transaction(() => {
      const tombstone = this.database.prepare(`
        SELECT * FROM formal_agent_request_tombstones WHERE client_key_digest=?
      `).get(input.clientKeyDigest)
      if (tombstone) {
        if (tombstone.request_digest !== input.requestDigest || tombstone.session_id !== sessionId) {
          fail('AGENT_REQUEST_IDENTITY_CONFLICT')
        }
        fail('AGENT_SESSION_DELETED')
      }
      if (this.database.prepare(`
        SELECT 1 FROM formal_agent_request_tombstones WHERE request_id_digest=?
      `).get(sha256Canonical({ requestId }))) fail('AGENT_REQUEST_IDENTITY_CONFLICT')
      if (this.database.prepare('SELECT 1 FROM session_deletion_tombstones WHERE session_id=?').get(sessionId)) {
        fail('AGENT_SESSION_DELETED')
      }
      const prior = this.database.prepare('SELECT * FROM formal_agent_requests WHERE client_key_digest=?').get(input.clientKeyDigest)
      if (prior) {
        if (prior.request_id !== requestId || prior.request_digest !== input.requestDigest ||
            prior.session_id !== sessionId || prior.scope_digest !== input.scopeDigest || prior.prompt_digest !== input.promptDigest || prior.action !== input.action ||
            prior.summary_use_memory !== (input.summaryUseMemory === null ? null : (input.summaryUseMemory ? 1 : 0)) ||
            prior.input_watermark_json !== canonicalize(inputWatermark) || prior.transcript_version !== input.transcriptVersion ||
            prior.input_digest !== input.inputDigest) {
          fail('AGENT_REQUEST_IDENTITY_CONFLICT')
        }
        return this.sessionSummaryRequestProjection(prior, true)
      }
      const priorByRequestId = this.database.prepare('SELECT 1 FROM formal_agent_requests WHERE request_id=?').get(requestId)
      if (priorByRequestId) fail('AGENT_REQUEST_IDENTITY_CONFLICT')
      this.database.prepare(`
        INSERT INTO formal_agent_requests(
          request_id,session_id,client_key_digest,request_digest,scope_digest,prompt_digest,action,summary_use_memory,
          input_watermark_json,transcript_version,input_digest,
          state,phase,generation,revision,route_run_id,target_run_id,cancel_requested,resume_required,
          attempt,elapsed_ms,last_activity_elapsed_ms,validated_chunk_count,total_chunk_count,memory_state,
          error_code,budget_axis,budget_actual,budget_limit,diagnostics_available,created_at,updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'accepted','accepted',1,0,NULL,NULL,0,0,0,0,0,NULL,NULL,?,NULL,NULL,NULL,NULL,0,?,?)
      `).run(
        requestId, sessionId, input.clientKeyDigest, input.requestDigest, input.scopeDigest, input.promptDigest,
        input.action, input.summaryUseMemory === null ? null : (input.summaryUseMemory ? 1 : 0),
        canonicalize(inputWatermark), input.transcriptVersion, input.inputDigest,
        input.action === 'summary' && input.summaryUseMemory === false ? 'not_used' : 'not_read', now, now
      )
      return this.sessionSummaryRequestProjection(this.sessionSummaryRequestRow(requestId))
    })
  }

  getSessionSummaryRequest (input) {
    exactObject(input, ['requestId'])
    return this.sessionSummaryRequestProjection(this.sessionSummaryRequestRow(input.requestId))
  }

  updateSessionSummaryRequest (input) {
    exactObject(input, ['requestId', 'generation', 'expectedRevision'], [
      'state', 'phase', 'attempt', 'elapsedMs', 'lastActivityElapsedMs', 'validatedChunkCount',
      'totalChunkCount', 'memoryState', 'errorCode', 'budget', 'resumeRequired', 'diagnosticsAvailable', 'attemptIdentity'
    ])
    const requestId = identifier(input.requestId)
    boundedInteger(input.generation, 1, Number.MAX_SAFE_INTEGER)
    nonNegativeInteger(input.expectedRevision)
    const current = this.sessionSummaryRequestRow(requestId)
    if (Number(current.generation) !== input.generation || Number(current.revision) !== input.expectedRevision ||
        ['succeeded', 'failed', 'cancelled'].includes(current.state) || current.cancel_requested !== 0) {
      fail('AGENT_CONTEXT_REVISION_CONFLICT')
    }
    const state = input.state === undefined ? current.state : input.state
    const phase = input.phase === undefined ? current.phase : input.phase
    if (!['accepted', 'preparing', 'routing', 'queued', 'running', 'retry_wait', 'cancelling', 'succeeded', 'failed', 'cancelled'].includes(state) ||
        !['accepted', 'preparing', 'waiting_model', 'reading_context', 'reducing', 'validating', 'retry_wait', 'cancelling', 'terminal'].includes(phase)) fail('AGENT_REQUEST_INVALID')
    const numberOrCurrent = (field, column) => {
      const value = input[field] === undefined ? Number(current[column]) : nonNegativeInteger(input[field])
      return value
    }
    const attempt = numberOrCurrent('attempt', 'attempt')
    const elapsedMs = numberOrCurrent('elapsedMs', 'elapsed_ms')
    const activity = numberOrCurrent('lastActivityElapsedMs', 'last_activity_elapsed_ms')
    const chunk = (field, column) => input[field] === undefined
      ? current[column] === null ? null : Number(current[column])
      : input[field] === null ? null : nonNegativeInteger(input[field])
    const validated = chunk('validatedChunkCount', 'validated_chunk_count')
    const total = chunk('totalChunkCount', 'total_chunk_count')
    if ((validated === null) !== (total === null) || validated !== null && validated > total) fail('AGENT_REQUEST_INVALID')
    const memoryState = input.memoryState === undefined ? current.memory_state : input.memoryState
    if (!['not_read', 'not_used', 'empty', 'referenced', 'failed', 'unknown'].includes(memoryState)) fail('AGENT_REQUEST_INVALID')
    const errorCode = input.errorCode === undefined ? current.error_code : input.errorCode
    if (errorCode !== null && !require('../../agent/contracts/session-summary-run-ui').ERROR_CODES.includes(errorCode)) fail('AGENT_REQUEST_INVALID')
    const budget = input.budget === undefined
      ? current.budget_axis === null ? null : { axis: current.budget_axis, actual: Number(current.budget_actual), limit: Number(current.budget_limit) }
      : input.budget
    if (budget !== null) {
      exactObject(budget, ['axis', 'actual', 'limit'])
      if (!require('../../agent/contracts/budget-axes').BUDGET_AXES.includes(budget.axis)) fail('AGENT_REQUEST_INVALID')
      nonNegativeInteger(budget.actual); nonNegativeInteger(budget.limit)
    }
    const resumeRequired = input.resumeRequired === undefined ? Number(current.resume_required) : (input.resumeRequired ? 1 : 0)
    const diagnosticsAvailable = input.diagnosticsAvailable === undefined ? Number(current.diagnostics_available) : (input.diagnosticsAvailable ? 1 : 0)
    return this.transaction(() => {
      if (input.attemptIdentity !== undefined) {
        const attemptIdentity = input.attemptIdentity
        const run = this.runRow(attemptIdentity.runId)
        if (run.session_summary_request_id !== requestId) fail('AGENT_CONTEXT_OPERATION_FAILED')
        this.assertActiveAttempt(run, attemptIdentity, this.nowValue())
      }
      const result = this.database.prepare(`
        UPDATE formal_agent_requests SET state=?,phase=?,attempt=?,elapsed_ms=?,last_activity_elapsed_ms=?,
          validated_chunk_count=?,total_chunk_count=?,memory_state=?,error_code=?,budget_axis=?,budget_actual=?,budget_limit=?,
          resume_required=?,diagnostics_available=?,revision=revision+1,updated_at=?
        WHERE request_id=? AND generation=? AND revision=? AND cancel_requested=0
          AND state NOT IN ('succeeded','failed','cancelled')
      `).run(
        state, phase, attempt, elapsedMs, activity, validated, total, memoryState, errorCode,
        budget?.axis ?? null, budget?.actual ?? null, budget?.limit ?? null, resumeRequired, diagnosticsAvailable,
        this.nowValue(), requestId, input.generation, input.expectedRevision
      )
      if (Number(result.changes) !== 1) fail('AGENT_CONTEXT_REVISION_CONFLICT')
      return this.sessionSummaryRequestProjection(this.sessionSummaryRequestRow(requestId))
    })
  }

  cancelSessionSummaryRequest (input) {
    exactObject(input, ['requestId', 'generation'], ['elapsedMs'])
    const requestId = identifier(input.requestId)
    boundedInteger(input.generation, 1, Number.MAX_SAFE_INTEGER)
    if (input.elapsedMs !== undefined) nonNegativeInteger(input.elapsedMs)
    return this.transaction(() => {
      let row = this.sessionSummaryRequestRow(requestId)
      if (Number(row.generation) !== input.generation) fail('AGENT_CONTEXT_REVISION_CONFLICT')
      if (['succeeded', 'failed', 'cancelled'].includes(row.state)) return this.sessionSummaryRequestProjection(row, true)
      const linkedRunId = row.target_run_id || row.route_run_id
      if (row.cancel_requested !== 0 && linkedRunId && ['queued', 'retry_wait', 'running'].includes(this.runRow(linkedRunId).state)) {
        return this.sessionSummaryRequestProjection(row, true)
      }
      const now = this.nowValue()
      if (row.cancel_requested === 0 && input.elapsedMs !== undefined && input.elapsedMs > Number(row.elapsed_ms)) {
        this.database.prepare(`
          UPDATE formal_agent_requests SET elapsed_ms=?,revision=revision+1,updated_at=?
          WHERE request_id=? AND generation=?
        `).run(input.elapsedMs, now, requestId, input.generation)
        row = this.sessionSummaryRequestRow(requestId)
      }
      if (!linkedRunId) {
        this.database.prepare(`
          UPDATE formal_agent_requests SET state='cancelled',phase='terminal',cancel_requested=1,
            revision=revision+1,updated_at=? WHERE request_id=?
        `).run(now, requestId)
      } else {
        const linkedRun = this.runRow(linkedRunId)
        if (['queued', 'retry_wait'].includes(linkedRun.state)) {
          this.database.prepare(`
            UPDATE formal_agent_runs SET state='cancelled', cancel_requested_at=COALESCE(cancel_requested_at,?),
              lease_owner=NULL,lease_expires_at=NULL,lease_renewed_from_expires_at=NULL,updated_at=?
            WHERE run_id=? AND state IN ('queued','retry_wait')
          `).run(now, now, linkedRunId)
          const interaction = this.database.prepare('SELECT * FROM formal_agent_interactions WHERE run_id=?').get(linkedRunId)
          if (interaction && interaction.terminal_reason === null) {
            this.database.prepare(`
              UPDATE formal_agent_interactions SET terminal_reason='cancelled',error_code=NULL,usage_json=NULL,
                duration_ms=0,result_json=NULL,result_digest=NULL,terminal_at=?
              WHERE interaction_id=? AND terminal_reason IS NULL
            `).run(now, interaction.interaction_id)
            this.database.prepare(`
              UPDATE formal_agent_tool_calls SET ended_offset_ms=started_offset_ms,status='cancelled',
                error_code='TOOL_CANCELLED',result_json=NULL,result_digest=NULL
              WHERE interaction_id=? AND status='started'
            `).run(interaction.interaction_id)
          }
          this.database.prepare(`
            UPDATE formal_agent_requests SET state='cancelled',phase='terminal',cancel_requested=1,
              revision=revision+1,updated_at=? WHERE request_id=?
          `).run(now, requestId)
        } else if (linkedRun.state === 'running') {
          this.database.prepare(`
            UPDATE formal_agent_requests SET state='cancelling',phase='cancelling',cancel_requested=1,
              revision=revision+1,updated_at=? WHERE request_id=?
          `).run(now, requestId)
          this.database.prepare(`
            UPDATE formal_agent_runs SET cancel_requested_at=COALESCE(cancel_requested_at,?),updated_at=?
            WHERE run_id=? AND state='running'
          `).run(now, now, linkedRunId)
        } else if (linkedRun.state === 'failed' && !row.target_run_id) {
          this.database.prepare(`
            UPDATE formal_agent_requests SET state='failed',phase='terminal',cancel_requested=0,error_code=?,
              revision=revision+1,updated_at=? WHERE request_id=?
          `).run(linkedRun.error_code, now, requestId)
        } else if (row.target_run_id) {
          const state = linkedRun.state
          this.database.prepare(`
            UPDATE formal_agent_requests SET state=?,phase='terminal',cancel_requested=?,error_code=?,
              revision=revision+1,updated_at=? WHERE request_id=?
          `).run(state, state === 'cancelled' ? 1 : 0, linkedRun.error_code, now, requestId)
        } else {
          this.database.prepare(`
            UPDATE formal_agent_requests SET state='cancelled',phase='terminal',cancel_requested=1,
              revision=revision+1,updated_at=? WHERE request_id=?
          `).run(now, requestId)
        }
      }
      return this.sessionSummaryRequestProjection(this.sessionSummaryRequestRow(requestId))
    })
  }

  resumeSessionSummaryRequest (input) {
    exactObject(input, ['requestId', 'generation', 'expectedRevision'])
    const requestId = identifier(input.requestId)
    nonNegativeInteger(input.generation)
    nonNegativeInteger(input.expectedRevision)
    return this.transaction(() => {
      const now = this.nowValue()
      const result = this.database.prepare(`
        UPDATE formal_agent_requests SET state='accepted',phase='accepted',generation=generation+1,
          revision=revision+1,resume_required=0,cancel_requested=0,error_code=NULL,updated_at=?
        WHERE request_id=? AND generation=? AND revision=? AND state='retry_wait' AND resume_required=1 AND cancel_requested=0
      `).run(now, requestId, input.generation, input.expectedRevision)
      if (Number(result.changes) !== 1) fail('AGENT_CONTEXT_REVISION_CONFLICT')
      return this.sessionSummaryRequestProjection(this.sessionSummaryRequestRow(requestId))
    })
  }

  listRecoverableSessionSummaryRequests () {
    return this.database.prepare(`
      SELECT * FROM formal_agent_requests WHERE state NOT IN ('succeeded','failed','cancelled')
      ORDER BY updated_at,request_id LIMIT 1000
    `).all().map((row) => this.sessionSummaryRequestProjection(row))
  }

  cancelRun (input) {
    exactObject(input, ['runId'])
    const runId = identifier(input.runId)
    return this.transaction(() => {
      const row = this.runRow(runId)
      this.guardTombstone(row)
      if (row.state === 'cancelled' && row.cancel_requested_at !== null) return rowRun(row, true)
      if (['succeeded', 'failed'].includes(row.state)) fail('AGENT_INTERACTION_STATE_CONFLICT')
      const now = this.nowValue()
      if (row.state === 'running') {
        this.database.prepare(`
          UPDATE formal_agent_runs SET cancel_requested_at=COALESCE(cancel_requested_at, ?), updated_at=?
          WHERE run_id=? AND state='running'
        `).run(now, now, runId)
      } else {
        this.database.prepare(`
          UPDATE formal_agent_runs SET state='cancelled', cancel_requested_at=COALESCE(cancel_requested_at, ?),
            lease_owner=NULL, lease_expires_at=NULL, lease_renewed_from_expires_at=NULL,
            error_code=NULL, result_digest=NULL, result_summary_json=NULL, updated_at=?
          WHERE run_id=? AND state IN ('queued','retry_wait')
        `).run(now, now, runId)
        const interaction = this.database.prepare(`
          SELECT * FROM formal_agent_interactions WHERE run_id=?
        `).get(runId)
        if (interaction && interaction.terminal_reason === null) {
          this.database.prepare(`
            UPDATE formal_agent_interactions
            SET terminal_reason='cancelled', error_code=NULL, usage_json=NULL, duration_ms=0,
                result_json=NULL, result_digest=NULL, terminal_at=?
            WHERE interaction_id=? AND terminal_reason IS NULL
          `).run(now, interaction.interaction_id)
          this.database.prepare(`
            UPDATE formal_agent_tool_calls
            SET ended_offset_ms=started_offset_ms, status='cancelled', error_code='TOOL_CANCELLED',
                result_json=NULL, result_digest=NULL
            WHERE interaction_id=? AND status='started'
          `).run(interaction.interaction_id)
        }
      }
      return rowRun(this.runRow(runId))
    })
  }

  createInteraction (input) {
    exactObject(input, ['runId', 'interactionId', 'routingMode', 'promptDigest'])
    const runId = identifier(input.runId)
    const interactionId = identifier(input.interactionId)
    if (!ROUTING_MODES.includes(input.routingMode)) fail('AGENT_REQUEST_INVALID')
    if (input.promptDigest !== null) digest(input.promptDigest)
    return this.transaction(() => {
      const existingById = this.database.prepare('SELECT * FROM formal_agent_interactions WHERE interaction_id = ?').get(interactionId)
      const existingByRun = this.database.prepare('SELECT * FROM formal_agent_interactions WHERE run_id = ?').get(runId)
      if (existingById || existingByRun) {
        const row = existingById || existingByRun
        if (row.interaction_id !== interactionId || row.run_id !== runId || row.routing_mode !== input.routingMode || row.prompt_digest !== input.promptDigest) {
          fail('AGENT_INTERACTION_STATE_CONFLICT')
        }
        return rowInteraction(row, true)
      }
      const run = this.runRow(runId)
      this.guardTombstone(run)
      const recipe = this.recipeForRun(run)
      const binding = this.bindingForRun(run)
      if (run.requested_by === 'user' && input.promptDigest === null) fail('AGENT_REQUEST_INVALID')
      if (run.requested_by === 'automatic' && input.promptDigest !== null) fail('AGENT_REQUEST_INVALID')
      const createdAt = this.nowValue()
      const scope = runScope(run)
      const scopeDigest = digest(run.scope_digest)
      const inputDigest = digest(run.input_digest)
      const comparison = comparisonGroupId(recipe.recipeId, recipe.recipeVersion, scopeDigest, inputDigest)
      const attemptCount = Math.max(1, Number(run.attempt_count))
      this.database.prepare(`
        INSERT INTO formal_agent_interactions(
          interaction_id, run_id, recipe_id, recipe_version, max_turns, tool_grants_json,
          routing_mode, requested_by, scope_json, scope_digest, input_digest, prompt_digest,
          terminal_reason, error_code, usage_json, duration_ms, attempt_count,
          comparison_group_id, result_json, result_digest, created_at, terminal_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0, ?, ?, NULL, NULL, ?, NULL)
      `).run(
        interactionId, runId, recipe.recipeId, recipe.recipeVersion, recipe.maxTurns,
        canonicalize(recipe.toolGrants), input.routingMode, run.requested_by,
        canonicalize(scope), scopeDigest, inputDigest, input.promptDigest,
        attemptCount, comparison, createdAt
      )
      return rowInteraction(this.interactionRow(interactionId))
    })
  }

  terminalizeInteraction (input) {
    exactObject(input, ['interactionId', 'terminalReason', 'errorCode', 'result', 'usage', 'durationMs'], ['attemptIdentity'])
    const interactionId = identifier(input.interactionId)
    if (!TERMINAL_REASONS.includes(input.terminalReason)) fail('AGENT_REQUEST_INVALID')
    nonNegativeInteger(input.durationMs)
    const terminalReason = input.terminalReason
    if (terminalReason === 'failed') {
      if (!TASK_ERROR_CODES.includes(input.errorCode)) fail('AGENT_REQUEST_INVALID')
      if (input.result !== null) fail('AGENT_REQUEST_INVALID')
    } else {
      if (input.errorCode !== null) fail('AGENT_REQUEST_INVALID')
      if (terminalReason === 'cancelled' && input.result !== null) fail('AGENT_REQUEST_INVALID')
    }
    let resultEncoded = null
    let resultDigest = null
    if (terminalReason === 'succeeded' && !isPlainObject(input.result)) fail('AGENT_OUTPUT_INVALID')
    let usageEncoded = null
    if (input.usage !== null) {
      try {
        assertModelUsage(input.usage)
        usageEncoded = canonicalize(input.usage)
      } catch { fail('AGENT_REQUEST_INVALID') }
    }
    return this.transaction(() => {
      const row = this.interactionRow(interactionId)
      const run = this.runRow(row.run_id)
      this.guardTombstone(run)
      const now = this.nowValue()
      if (row.terminal_reason === null) {
        if (input.attemptIdentity !== undefined) {
          if (run.cancel_requested_at !== null && terminalReason !== 'cancelled') fail('AGENT_INTERACTION_STATE_CONFLICT')
          this.assertActiveAttempt(run, input.attemptIdentity, now, { allowCancelRequested: terminalReason === 'cancelled' })
        } else if (run.recipe_id !== 'intent.route' || run.state !== 'queued' ||
            terminalReason === 'succeeded' && run.cancel_requested_at !== null) {
          fail('AGENT_CONTEXT_OPERATION_FAILED')
        }
      } else {
        if (input.attemptIdentity !== undefined) {
          exactObject(input.attemptIdentity, ['runId', 'attempt', 'owner', 'leaseExpiresAt'])
          if (input.attemptIdentity.runId !== run.run_id) fail('AGENT_CONTEXT_OPERATION_FAILED')
        }
      }
      const binding = this.bindingForRun(run)
      const storedError = storedErrorCode(input.errorCode)
      const summaryMemoryError = input.errorCode === SUMMARY_MEMORY_ERROR ? 1 : 0
      if (row.terminal_reason === null && ['succeeded', 'failed', 'cancelled'].includes(run.state)) {
        fail('AGENT_INTERACTION_STATE_CONFLICT')
      }
      if (input.usage !== null && JSON.parse(binding.row.capability_json).usageReporting !== true) fail('AGENT_REQUEST_INVALID')
      if (terminalReason === 'succeeded') {
        /* A running request may receive a provider result after the user has
           requested cancellation.  The cancellation fact is authoritative;
           do not allow that late result to rewrite the run into success. */
        if (run.cancel_requested_at !== null) fail('AGENT_INTERACTION_STATE_CONFLICT')
        if (row.recipe_id === 'summary.minutes' && run.summary_use_memory !== 0) {
          const currentRevision = Number(this.database.prepare(`
            SELECT content_revision FROM personal_context_projection_state WHERE singleton_key = 1
          `).get()?.content_revision)
          if (!Number.isSafeInteger(currentRevision) || currentRevision < 0 ||
              currentRevision !== Number(run.personal_context_revision)) {
            fail('AGENT_INPUT_CHANGED')
          }
        }
        try { validateRecipeOutput(row.recipe_id, row.recipe_version, input.result) } catch (error) {
          if (error.code === 'AGENT_OUTPUT_INVALID') fail('AGENT_OUTPUT_INVALID')
          fail('AGENT_OUTPUT_INVALID')
        }
        resultEncoded = canonicalize(input.result)
        resultDigest = sha256Canonical(input.result)
      }
      if (row.terminal_reason !== null) {
        const same = row.terminal_reason === terminalReason && visibleErrorCode(row) === input.errorCode &&
          row.result_digest === resultDigest && row.usage_json === usageEncoded && Number(row.duration_ms) === input.durationMs
        if (!same) fail('AGENT_INTERACTION_STATE_CONFLICT')
        return rowInteraction(row, true)
      }
      if (now < Number(row.created_at)) fail('STORAGE_COMMAND_FAILED')
      const summaryInputLimitError = input.errorCode === SUMMARY_INPUT_LIMIT_ERROR ? 1 : 0
      this.database.prepare(`
        UPDATE formal_agent_interactions
        SET terminal_reason=?, error_code=?, summary_memory_error=?, summary_input_limit_error=?, usage_json=?, duration_ms=?, result_json=? ,
            result_digest=?, terminal_at=?
        WHERE interaction_id=? AND terminal_reason IS NULL
      `).run(terminalReason, storedError, summaryMemoryError, summaryInputLimitError, usageEncoded, input.durationMs, resultEncoded, resultDigest, now, interactionId)
      const summary = terminalReason === 'succeeded'
        ? { interactionId, resultDigest }
        : null
      if (terminalReason === 'succeeded') {
        this.database.prepare(`
          UPDATE formal_agent_runs SET state='succeeded', lease_owner=NULL, lease_expires_at=NULL,
            lease_renewed_from_expires_at=NULL, error_code=NULL, summary_memory_error=0, summary_input_limit_error=0,
            result_digest=?, result_summary_json=?, updated_at=?
          WHERE run_id=? AND state NOT IN ('succeeded','failed','cancelled')
        `).run(sha256Canonical(summary), canonicalize(summary), now, row.run_id)
      } else if (terminalReason === 'failed') {
        this.database.prepare(`
          UPDATE formal_agent_runs SET state='failed', lease_owner=NULL, lease_expires_at=NULL,
            lease_renewed_from_expires_at=NULL, error_code=?, summary_memory_error=?, summary_input_limit_error=?,
            result_digest=NULL, result_summary_json=NULL, updated_at=?
          WHERE run_id=? AND state NOT IN ('succeeded','failed','cancelled')
        `).run(storedError, summaryMemoryError, summaryInputLimitError, now, row.run_id)
      } else {
        this.database.prepare(`
          UPDATE formal_agent_runs SET state='cancelled', lease_owner=NULL, lease_expires_at=NULL,
            lease_renewed_from_expires_at=NULL, error_code=NULL, summary_memory_error=0, summary_input_limit_error=0,
            result_digest=NULL, result_summary_json=NULL, updated_at=?
          WHERE run_id=? AND state NOT IN ('succeeded','failed','cancelled')
        `).run(now, row.run_id)
      }
      const summaryRequestState = terminalReason === 'succeeded' ? 'succeeded' : terminalReason
      const summaryRequestError = terminalReason === 'failed' ? input.errorCode : null
      this.database.prepare(`
        UPDATE formal_agent_requests SET state=?,phase='terminal',error_code=?,revision=revision+1,updated_at=?
        WHERE target_run_id=? AND state NOT IN ('succeeded','failed','cancelled')
      `).run(summaryRequestState, summaryRequestError, now, row.run_id)
      return rowInteraction(this.interactionRow(interactionId))
    })
  }

  startToolCall (input) {
    exactObject(input, ['callId', 'interactionId', 'attemptIdentity', 'attempt', 'callOrder', 'toolName', 'startedOffsetMs', 'args'])
    const callId = identifier(input.callId)
    const interactionId = identifier(input.interactionId)
    boundedInteger(input.attempt, 1, 100)
    if (input.attemptIdentity?.attempt !== input.attempt) fail('AGENT_REQUEST_INVALID')
    boundedInteger(input.callOrder, 1, 12)
    if (!TOOL_NAMES.includes(input.toolName)) fail('AGENT_REQUEST_INVALID')
    nonNegativeInteger(input.startedOffsetMs)
    const args = jsonValue(input.args, 'TOOL_ARGS_INVALID')
    if (Buffer.byteLength(args.encoded, 'utf8') > MAX_ARGS_BYTES) fail('TOOL_BUDGET_EXCEEDED')
    return this.transaction(() => {
      const prior = this.database.prepare('SELECT * FROM formal_agent_tool_calls WHERE call_id=?').get(callId)
      if (prior) {
        const same = prior.interaction_id === interactionId && Number(prior.attempt) === input.attempt &&
          Number(prior.call_order) === input.callOrder && prior.tool_name === input.toolName &&
          prior.started_offset_ms === input.startedOffsetMs && prior.args_digest === sha256Canonical(input.args)
        if (!same) fail('AGENT_TOOL_STATE_CONFLICT')
        if (prior.status === 'started') {
          const priorInteraction = this.interactionRow(prior.interaction_id)
          this.assertActiveAttempt(this.runRow(priorInteraction.run_id), input.attemptIdentity, this.nowValue())
        }
        return rowToolCall(prior, true)
      }
      const row = this.interactionRow(interactionId)
      const run = this.runRow(row.run_id)
      this.guardTombstone(run)
      this.assertActiveAttempt(run, input.attemptIdentity, this.nowValue())
      if (row.terminal_reason !== null) fail('AGENT_INTERACTION_STATE_CONFLICT')
      const orderConflict = this.database.prepare(`
        SELECT 1 FROM formal_agent_tool_calls WHERE interaction_id=? AND attempt=? AND call_order=?
      `).get(interactionId, input.attempt, input.callOrder)
      if (orderConflict) fail('AGENT_TOOL_STATE_CONFLICT')
      const grants = jsonObject(row.tool_grants_json)
      const denied = !Array.isArray(grants) || !grants.includes(input.toolName)
      const status = denied ? 'failed' : 'started'
      const errorCode = denied ? 'TOOL_NOT_AVAILABLE_FOR_RECIPE' : null
      const endedOffset = denied ? input.startedOffsetMs : null
      this.database.prepare(`
        INSERT INTO formal_agent_tool_calls(
          call_id, interaction_id, attempt, call_order, tool_name, schema_version,
          started_offset_ms, ended_offset_ms, status, error_code, args_json, args_digest,
          result_json, result_digest, source_refs_json, counts_json
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, NULL, NULL, '[]', '{"resultBytes":0,"sourceTextBytes":0,"sourceReferenceCount":0}')
      `).run(callId, interactionId, input.attempt, input.callOrder, input.toolName,
        input.startedOffsetMs, endedOffset, status, errorCode, args.encoded, sha256Canonical(input.args))
      return rowToolCall(this.database.prepare('SELECT * FROM formal_agent_tool_calls WHERE call_id=?').get(callId))
    })
  }

  finishToolCall (input) {
    exactObject(input, ['callId', 'attemptIdentity', 'status', 'result', 'errorCode', 'endedOffsetMs', 'sourceRefs', 'counts'])
    const callId = identifier(input.callId)
    exactObject(input.attemptIdentity, ['runId', 'attempt', 'owner', 'leaseExpiresAt'])
    if (!TOOL_STATUSES.includes(input.status) || input.status === 'started') fail('AGENT_REQUEST_INVALID')
    if (!Array.isArray(input.sourceRefs) || input.sourceRefs.length > MAX_SOURCE_REFS) fail('TOOL_ARGS_INVALID')
    try { input.sourceRefs.forEach(assertSourceRef) } catch { fail('TOOL_ARGS_INVALID') }
    if (!isPlainObject(input.counts)) fail('TOOL_ARGS_INVALID')
    const sourceRefs = jsonValue(input.sourceRefs, 'TOOL_ARGS_INVALID')
    const counts = jsonValue(input.counts, 'TOOL_ARGS_INVALID')
    let resultEncoded = null
    let resultDigest = null
    if (input.status === 'succeeded') {
      if (input.errorCode !== null || input.result === null) fail('AGENT_REQUEST_INVALID')
      const result = jsonValue(input.result, 'TOOL_ARGS_INVALID')
      if (Buffer.byteLength(result.encoded, 'utf8') > MAX_RESULT_BYTES) {
        return this.closeOversizedTool(callId, input.attemptIdentity, input.endedOffsetMs, sourceRefs.encoded, counts.encoded)
      }
      resultEncoded = result.encoded
      resultDigest = sha256Canonical(input.result)
    } else {
      if (!TOOL_ERROR_CODES.includes(input.errorCode) || input.result !== null) fail('AGENT_REQUEST_INVALID')
      if (input.status === 'cancelled' && input.errorCode !== 'TOOL_CANCELLED') fail('AGENT_REQUEST_INVALID')
      if (input.status === 'failed' && input.errorCode === 'TOOL_CANCELLED') fail('AGENT_REQUEST_INVALID')
    }
    nonNegativeInteger(input.endedOffsetMs)
    return this.transaction(() => {
      const row = this.database.prepare('SELECT * FROM formal_agent_tool_calls WHERE call_id=?').get(callId)
      if (!row) fail('AGENT_TOOL_NOT_FOUND')
      if (input.endedOffsetMs < Number(row.started_offset_ms)) fail('AGENT_REQUEST_INVALID')
      const interaction = this.interactionRow(row.interaction_id)
      const run = this.runRow(interaction.run_id)
      this.guardTombstone(run)
      if (Number(row.attempt) !== input.attemptIdentity.attempt) fail('AGENT_CONTEXT_OPERATION_FAILED')
      if (row.status !== 'started') {
        const same = row.status === input.status && row.error_code === input.errorCode &&
          row.result_digest === resultDigest && Number(row.ended_offset_ms) === input.endedOffsetMs &&
          row.source_refs_json === sourceRefs.encoded && row.counts_json === counts.encoded
        if (!same) fail('AGENT_TOOL_STATE_CONFLICT')
        return rowToolCall(row, true)
      }
      this.assertActiveAttempt(run, input.attemptIdentity, this.nowValue(), { allowCancelRequested: input.status === 'cancelled' })
      if (interaction.terminal_reason !== null) fail('AGENT_INTERACTION_STATE_CONFLICT')
      this.database.prepare(`
        UPDATE formal_agent_tool_calls SET ended_offset_ms=?, status=?, error_code=?,
          result_json=?, result_digest=?, source_refs_json=?, counts_json=?
        WHERE call_id=? AND status='started'
      `).run(input.endedOffsetMs, input.status, input.errorCode, resultEncoded, resultDigest,
        sourceRefs.encoded, counts.encoded, callId)
      return rowToolCall(this.database.prepare('SELECT * FROM formal_agent_tool_calls WHERE call_id=?').get(callId))
    })
  }

  closeOversizedTool (callId, attemptIdentity, endedOffsetMs, sourceRefs, counts) {
    nonNegativeInteger(endedOffsetMs)
    const result = this.transaction(() => {
      const row = this.database.prepare('SELECT * FROM formal_agent_tool_calls WHERE call_id=?').get(callId)
      if (!row) fail('AGENT_TOOL_NOT_FOUND')
      if (endedOffsetMs < Number(row.started_offset_ms) || row.status !== 'started') fail('AGENT_TOOL_STATE_CONFLICT')
      const interaction = this.interactionRow(row.interaction_id)
      const run = this.runRow(interaction.run_id)
      this.guardTombstone(run)
      if (Number(row.attempt) !== attemptIdentity.attempt) fail('AGENT_CONTEXT_OPERATION_FAILED')
      this.assertActiveAttempt(run, attemptIdentity, this.nowValue())
      if (interaction.terminal_reason !== null) fail('AGENT_INTERACTION_STATE_CONFLICT')
      this.database.prepare(`
        UPDATE formal_agent_tool_calls SET ended_offset_ms=?, status='failed', error_code='TOOL_BUDGET_EXCEEDED',
          result_json=NULL, result_digest=NULL, source_refs_json=?, counts_json=?
        WHERE call_id=? AND status='started'
      `).run(endedOffsetMs, sourceRefs, counts, callId)
      return rowToolCall(this.database.prepare('SELECT * FROM formal_agent_tool_calls WHERE call_id=?').get(callId))
    })
    // The failed audit fact is durable, but the caller still receives an
    // explicit budget error and must not mistake the oversized result as saved.
    void result
    fail('TOOL_BUDGET_EXCEEDED')
  }

  createPresentation (input) {
    exactObject(input, ['sessionId', 'runId'])
    const sessionId = identifier(input.sessionId)
    const runId = identifier(input.runId)
    return this.transaction(() => {
      const existing = this.database.prepare('SELECT * FROM formal_agent_report_presentations WHERE session_id=?').get(sessionId)
      if (existing) {
        if (existing.run_id !== runId) fail('AGENT_PRESENTATION_STATE_CONFLICT')
        return { ...this.presentationProjection(existing), replayed: true }
      }
      const run = this.runRow(runId)
      this.guardTombstone(run)
      const recipe = this.recipeForRun(run)
      if (recipe.recipeId !== 'summary.minutes' || run.requested_by !== 'automatic') fail('AGENT_REQUEST_INVALID')
      const scope = runScope(run)
      if (scope.kind !== 'session' || scope.reference !== sessionId) fail('AGENT_REQUEST_INVALID')
      const duplicateRun = this.database.prepare('SELECT * FROM formal_agent_report_presentations WHERE run_id=?').get(runId)
      if (duplicateRun) fail('AGENT_PRESENTATION_STATE_CONFLICT')
      const createdAt = this.nowValue()
      this.database.prepare(`
        INSERT INTO formal_agent_report_presentations(session_id, run_id, presented_at, created_at)
        VALUES (?, ?, NULL, ?)
      `).run(sessionId, runId, createdAt)
      return this.presentationProjection(this.database.prepare('SELECT * FROM formal_agent_report_presentations WHERE session_id=?').get(sessionId))
    })
  }

  presentationProjection (row) {
    return {
      sessionId: row.session_id,
      runId: row.run_id,
      presentedAt: row.presented_at === null ? null : Number(row.presented_at),
      createdAt: Number(row.created_at)
    }
  }

  markPresentation (input) {
    exactObject(input, ['sessionId', 'presentedAt'])
    const sessionId = identifier(input.sessionId)
    nonNegativeInteger(input.presentedAt)
    return this.transaction(() => {
      const row = this.database.prepare('SELECT * FROM formal_agent_report_presentations WHERE session_id=?').get(sessionId)
      if (!row) fail('AGENT_PRESENTATION_NOT_FOUND')
      const run = this.runRow(row.run_id)
      this.guardTombstone(run)
      if (row.presented_at !== null) {
        if (Number(row.presented_at) !== input.presentedAt) fail('AGENT_PRESENTATION_STATE_CONFLICT')
        return { ...this.presentationProjection(row), replayed: true }
      }
      this.database.prepare('UPDATE formal_agent_report_presentations SET presented_at=? WHERE session_id=? AND presented_at IS NULL').run(input.presentedAt, sessionId)
      return this.presentationProjection(this.database.prepare('SELECT * FROM formal_agent_report_presentations WHERE session_id=?').get(sessionId))
    })
  }

  listInteractions (input) {
    exactObject(input, ['limit', 'cursor'])
    const limit = boundedInteger(input.limit, 1, Number.MAX_SAFE_INTEGER)
    const cursor = decodeCursor(input.cursor)
    const pageLimit = Math.min(limit, MAX_INTERACTION_PAGE)
    const params = []
    let where = "i.terminal_at IS NOT NULL AND i.recipe_id <> 'intent.route'"
    if (cursor) {
      where += ' AND (i.terminal_at < ? OR (i.terminal_at = ? AND i.interaction_id > ?))'
      params.push(cursor.terminalAt, cursor.terminalAt, cursor.interactionId)
    }
    params.push(pageLimit + 1)
    const rows = this.database.prepare(`
      SELECT i.*,
        r.summary_use_memory AS summary_use_memory,
        b.adapter_id AS binding_adapter_id,
        b.model_id AS binding_model_id,
        b.profile_id AS binding_profile_id,
        b.profile_revision AS binding_profile_revision,
        b.provider_kind AS binding_provider_kind
      FROM formal_agent_interactions AS i
      JOIN formal_agent_runs AS r ON r.run_id = i.run_id
      JOIN agent_model_run_bindings AS b ON b.run_id = i.run_id
      WHERE ${where}
      ORDER BY i.terminal_at DESC, i.interaction_id ASC LIMIT ?
    `).all(...params)
    const hasMore = rows.length > pageLimit
    const page = rows.slice(0, pageLimit)
    const last = page.at(-1)
    const nextCursor = hasMore && last
      ? encodeCursor({ terminalAt: Number(last.terminal_at), interactionId: last.interaction_id })
      : null
    const items = page.map((row) => {
      if (row.recipe_id !== 'summary.minutes') return historyProjection(row)
      const calls = this.database.prepare(`
        SELECT tool_name, status, result_json
        FROM formal_agent_tool_calls
        WHERE interaction_id=? ORDER BY attempt ASC, call_order ASC
      `).all(row.interaction_id)
      return historyProjection({
        ...row,
        memory_reference_count: memoryReferenceCountFromRows(calls, row.recipe_id)
      })
    })
    return { items, hasMore, nextCursor }
  }

  getInteraction (input) {
    exactObject(input, ['interactionId'])
    const interactionId = identifier(input.interactionId)
    const row = this.interactionRow(interactionId)
    const run = this.runRow(row.run_id)
    const calls = this.database.prepare(`
      SELECT * FROM formal_agent_tool_calls
      WHERE interaction_id=? ORDER BY attempt ASC, call_order ASC
    `).all(interactionId).map((call) => rowToolCall(call))
    const binding = this.database.prepare('SELECT * FROM agent_model_run_bindings WHERE run_id=?').get(row.run_id)
    return {
      interaction: rowInteraction(row),
      runState: run.state,
      summaryUseMemory: run.recipe_id === 'summary.minutes'
        ? (run.summary_use_memory === undefined || run.summary_use_memory === null
            ? null
            : run.summary_use_memory !== 0)
        : null,
      cancelRequested: run.cancel_requested_at !== null,
      binding: binding
        ? {
            runId: binding.run_id,
            purpose: binding.purpose,
            assignmentMode: binding.assignment_mode,
            profileId: binding.profile_id,
            profileRevision: Number(binding.profile_revision),
            adapterId: binding.adapter_id,
            apiStyle: binding.api_style,
            httpsOrigin: binding.https_origin,
            basePath: binding.base_path,
            modelId: binding.model_id,
            capabilities: jsonObject(binding.capability_json),
            budget: jsonObject(binding.budget_json),
            providerKind: binding.provider_kind,
            createdAt: Number(binding.created_at)
          }
        : null,
      toolCalls: calls
    }
  }
}

module.exports = {
  AgentExecutionStore,
  MAX_ARGS_BYTES,
  MAX_RESULT_BYTES,
  TOOL_ERROR_CODES,
  TASK_ERROR_CODES
}
