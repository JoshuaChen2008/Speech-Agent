'use strict'

// @ts-check

/* S3 interaction facts live behind the storage worker.  This module is the
   only writer for v7 interaction/tool/presentation rows; callers submit exact
   commands and never receive the DatabaseSync handle. */

const { canonicalize, sha256Canonical } = require('./canonical-json')
const { rollbackQuietly } = require('./sqlite-store')
const {
  StorageError,
  assertExactKeys,
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
  'AGENT_BUDGET_EXCEEDED'
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
const MAX_INTERACTION_PAGE = 100
const MAX_SOURCE_REFS = 8
const MAX_ARGS_BYTES = 8192
const MAX_RESULT_BYTES = 65536

function fail (code) {
  throw new StorageError(code)
}

function exactObject (value, keys, code = 'AGENT_REQUEST_INVALID') {
  assertExactKeys(value, keys, code)
  if (!isPlainObject(value) || Object.keys(value).length !== keys.length) fail(code)
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
    errorCode: row.error_code,
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

function rowToolCall (row, replayed = false) {
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
    counts: jsonObject(row.counts_json)
  }
  return replayed ? { ...value, replayed: true } : value
}

function historyProjection (row) {
  return {
    interactionId: row.interaction_id,
    runId: row.run_id,
    recipeId: row.recipe_id,
    recipeVersion: row.recipe_version,
    terminalReason: row.terminal_reason,
    errorCode: row.error_code,
    usage: row.usage_json === null ? null : jsonObject(row.usage_json),
    durationMs: Number(row.duration_ms),
    attemptCount: Number(row.attempt_count),
    comparisonGroupId: row.comparison_group_id,
    result: row.result_json === null ? null : jsonObject(row.result_json),
    resultDigest: row.result_digest,
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
    exactObject(input, ['interactionId', 'terminalReason', 'errorCode', 'result', 'usage', 'durationMs'])
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
      const binding = this.bindingForRun(run)
      if (row.terminal_reason === null && ['succeeded', 'failed', 'cancelled'].includes(run.state)) {
        fail('AGENT_INTERACTION_STATE_CONFLICT')
      }
      if (input.usage !== null && JSON.parse(binding.row.capability_json).usageReporting !== true) fail('AGENT_REQUEST_INVALID')
      if (terminalReason === 'succeeded') {
        try { validateRecipeOutput(row.recipe_id, row.recipe_version, input.result) } catch (error) {
          if (error.code === 'AGENT_OUTPUT_INVALID') fail('AGENT_OUTPUT_INVALID')
          fail('AGENT_OUTPUT_INVALID')
        }
        resultEncoded = canonicalize(input.result)
        resultDigest = sha256Canonical(input.result)
      }
      if (row.terminal_reason !== null) {
        const same = row.terminal_reason === terminalReason && row.error_code === input.errorCode &&
          row.result_digest === resultDigest && row.usage_json === usageEncoded && Number(row.duration_ms) === input.durationMs
        if (!same) fail('AGENT_INTERACTION_STATE_CONFLICT')
        return rowInteraction(row, true)
      }
      const now = this.nowValue()
      if (now < Number(row.created_at)) fail('STORAGE_COMMAND_FAILED')
      this.database.prepare(`
        UPDATE formal_agent_interactions
        SET terminal_reason=?, error_code=?, usage_json=?, duration_ms=?, result_json=? ,
            result_digest=?, terminal_at=?
        WHERE interaction_id=? AND terminal_reason IS NULL
      `).run(terminalReason, input.errorCode, usageEncoded, input.durationMs, resultEncoded, resultDigest, now, interactionId)
      const summary = terminalReason === 'succeeded'
        ? { interactionId, resultDigest }
        : null
      if (terminalReason === 'succeeded') {
        this.database.prepare(`
          UPDATE formal_agent_runs SET state='succeeded', lease_owner=NULL, lease_expires_at=NULL,
            lease_renewed_from_expires_at=NULL, error_code=NULL, result_digest=?, result_summary_json=?, updated_at=?
          WHERE run_id=? AND state NOT IN ('succeeded','failed','cancelled')
        `).run(sha256Canonical(summary), canonicalize(summary), now, row.run_id)
      } else if (terminalReason === 'failed') {
        this.database.prepare(`
          UPDATE formal_agent_runs SET state='failed', lease_owner=NULL, lease_expires_at=NULL,
            lease_renewed_from_expires_at=NULL, error_code=?, result_digest=NULL, result_summary_json=NULL, updated_at=?
          WHERE run_id=? AND state NOT IN ('succeeded','failed','cancelled')
        `).run(input.errorCode, now, row.run_id)
      } else {
        this.database.prepare(`
          UPDATE formal_agent_runs SET state='cancelled', lease_owner=NULL, lease_expires_at=NULL,
            lease_renewed_from_expires_at=NULL, error_code=NULL, result_digest=NULL, result_summary_json=NULL, updated_at=?
          WHERE run_id=? AND state NOT IN ('succeeded','failed','cancelled')
        `).run(now, row.run_id)
      }
      return rowInteraction(this.interactionRow(interactionId))
    })
  }

  startToolCall (input) {
    exactObject(input, ['callId', 'interactionId', 'attempt', 'callOrder', 'toolName', 'startedOffsetMs', 'args'])
    const callId = identifier(input.callId)
    const interactionId = identifier(input.interactionId)
    boundedInteger(input.attempt, 1, 100)
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
        return rowToolCall(prior, true)
      }
      const row = this.interactionRow(interactionId)
      const run = this.runRow(row.run_id)
      this.guardTombstone(run)
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
        ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, NULL, NULL, '[]', '{}')
      `).run(callId, interactionId, input.attempt, input.callOrder, input.toolName,
        input.startedOffsetMs, endedOffset, status, errorCode, args.encoded, sha256Canonical(input.args))
      return rowToolCall(this.database.prepare('SELECT * FROM formal_agent_tool_calls WHERE call_id=?').get(callId))
    })
  }

  finishToolCall (input) {
    exactObject(input, ['callId', 'status', 'result', 'errorCode', 'endedOffsetMs', 'sourceRefs', 'counts'])
    const callId = identifier(input.callId)
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
        return this.closeOversizedTool(callId, input.endedOffsetMs, sourceRefs.encoded, counts.encoded)
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
      if (row.status !== 'started') {
        const same = row.status === input.status && row.error_code === input.errorCode &&
          row.result_digest === resultDigest && Number(row.ended_offset_ms) === input.endedOffsetMs &&
          row.source_refs_json === sourceRefs.encoded && row.counts_json === counts.encoded
        if (!same) fail('AGENT_TOOL_STATE_CONFLICT')
        return rowToolCall(row, true)
      }
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

  closeOversizedTool (callId, endedOffsetMs, sourceRefs, counts) {
    nonNegativeInteger(endedOffsetMs)
    const result = this.transaction(() => {
      const row = this.database.prepare('SELECT * FROM formal_agent_tool_calls WHERE call_id=?').get(callId)
      if (!row) fail('AGENT_TOOL_NOT_FOUND')
      if (endedOffsetMs < Number(row.started_offset_ms) || row.status !== 'started') fail('AGENT_TOOL_STATE_CONFLICT')
      const interaction = this.interactionRow(row.interaction_id)
      const run = this.runRow(interaction.run_id)
      this.guardTombstone(run)
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
    let where = "terminal_at IS NOT NULL AND recipe_id <> 'intent.route'"
    if (cursor) {
      where += ' AND (terminal_at < ? OR (terminal_at = ? AND interaction_id > ?))'
      params.push(cursor.terminalAt, cursor.terminalAt, cursor.interactionId)
    }
    params.push(pageLimit + 1)
    const rows = this.database.prepare(`
      SELECT * FROM formal_agent_interactions WHERE ${where}
      ORDER BY terminal_at DESC, interaction_id ASC LIMIT ?
    `).all(...params)
    const hasMore = rows.length > pageLimit
    const page = rows.slice(0, pageLimit)
    const last = page.at(-1)
    const nextCursor = hasMore && last
      ? encodeCursor({ terminalAt: Number(last.terminal_at), interactionId: last.interaction_id })
      : null
    return { items: page.map(historyProjection), hasMore, nextCursor }
  }

  getInteraction (input) {
    exactObject(input, ['interactionId'])
    const interactionId = identifier(input.interactionId)
    const row = this.interactionRow(interactionId)
    const calls = this.database.prepare(`
      SELECT * FROM formal_agent_tool_calls
      WHERE interaction_id=? ORDER BY attempt ASC, call_order ASC
    `).all(interactionId).map((call) => rowToolCall(call))
    const binding = this.database.prepare('SELECT * FROM agent_model_run_bindings WHERE run_id=?').get(row.run_id)
    return {
      interaction: rowInteraction(row),
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
