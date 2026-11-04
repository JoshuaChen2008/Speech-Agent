'use strict'

const { canonicalize } = require('../../runtime/storage-worker/canonical-json')
const { sha256Canonical } = require('../../runtime/storage-worker/canonical-json')
const c = require('../contracts/agent-run-ui')

const MAX_SCOPE_LABEL_BYTES = 256

function header () {
  return { contract_id: c.CONTRACT_ID, contract_version: c.CONTRACT_VERSION }
}

function okSnapshot (snapshot) {
  return { ...header(), ok: true, error: null, snapshot }
}

function okCommand (result = null) {
  return { ...header(), ok: true, error: null, result }
}

function unavailable (code = c.ERROR_CODES.unavailable, nextAction = null) {
  return {
    ...header(),
    ok: false,
    error: { category: 'unavailable', code, next_action: nextAction },
    result: null
  }
}

function invalid () {
  return {
    ...header(),
    ok: false,
    error: { category: 'invalid', code: c.ERROR_CODES.invalid, next_action: 'correct_input' },
    result: null
  }
}

function boundedText (value, fallback) {
  const text = typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback
  return Buffer.byteLength(text, 'utf8') <= MAX_SCOPE_LABEL_BYTES ? text : text.slice(0, MAX_SCOPE_LABEL_BYTES)
}

function toUtc (value) {
  if (!Number.isSafeInteger(value) || value < 0) return null
  return new Date(value).toISOString()
}

function encodeCursor (value) {
  return Buffer.from(canonicalize(value), 'utf8').toString('base64url')
}

function decodeCursor (value) {
  if (value === null) return null
  if (typeof value !== 'string' || value.length < 1 || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new TypeError('AGENT_REQUEST_INVALID')
  }
  let parsed
  try { parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) } catch { throw new TypeError('AGENT_REQUEST_INVALID') }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).sort().join(',') !== 'sessionId,startedAt' ||
      !Number.isSafeInteger(parsed.startedAt) || parsed.startedAt < 0 || typeof parsed.sessionId !== 'string' || parsed.sessionId.length < 1) {
    throw new TypeError('AGENT_REQUEST_INVALID')
  }
  if (encodeCursor(parsed) !== value) throw new TypeError('AGENT_REQUEST_INVALID')
  return parsed
}

function sessionScope (sessionId) {
  return { kind: 'session', reference: sessionId }
}

function sessionItem (item) {
  const scope = sessionScope(item.sessionId)
  const modeLabel = item.mode === 'meeting' ? '系统音频字幕' : item.mode === 'dictation' ? '麦克风听写' : '字幕会话'
  const stateLabel = item.state === 'interrupted' ? ' · 会话中断，仅总结已保存内容' : ''
  const label = `${modeLabel} · ${new Date(item.startedAt).toISOString()}${stateLabel}`
  return {
    scope,
    display_name: boundedText(label, item.sessionId),
    started_at: toUtc(item.startedAt),
    ended_at: toUtc(item.endedAt),
    state: 'terminal'
  }
}

function publicEligibility (scope, eligibility, revision) {
  return okSnapshot({ scope, eligibility, next_action: null, revision })
}

function publicEligibilityFailure (nextAction = 'retry') {
  return {
    ...header(),
    ok: false,
    error: { category: 'unavailable', code: c.ERROR_CODES.unavailable, next_action: nextAction },
    snapshot: null
  }
}

function publicFailure (code = c.ERROR_CODES.unavailable, nextAction = 'retry') {
  return {
    ...header(),
    ok: false,
    error: { category: 'unavailable', code, next_action: nextAction },
    result: null
  }
}

function publicState (value, terminalReason = null, cancelRequested = false) {
  if (terminalReason === 'succeeded') return 'succeeded'
  if (terminalReason === 'failed') return 'failed'
  if (terminalReason === 'cancelled') return 'cancelled'
  if (cancelRequested) return 'cancelling'
  if (value === 'running') return 'running'
  return 'pending'
}

function terminalInteractionState (detail) {
  const interaction = detail?.interaction || {}
  const reason = interaction.terminalReason || interaction.terminal_reason
  if (['succeeded', 'failed', 'cancelled'].includes(reason)) return reason
  const runState = detail?.runState || detail?.state
  return ['succeeded', 'failed', 'cancelled'].includes(runState) ? runState : null
}

function publicUsage (usage) {
  if (!usage) return { usage: null, usage_state: 'unknown' }
  return {
    usage: {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      usage_source: usage.usageSource,
      cache_hit_input_tokens: usage.cacheHitInputTokens,
      cache_miss_input_tokens: usage.cacheMissInputTokens
    },
    usage_state: 'known'
  }
}

function publicModel (model) {
  if (!model || typeof model !== 'object' || Array.isArray(model) ||
      typeof model.adapterId !== 'string' || typeof model.modelId !== 'string' ||
      typeof model.profileId !== 'string' || !Number.isSafeInteger(model.profileRevision) ||
      !['local', 'cloud'].includes(model.providerKind)) {
    const error = new Error('model identity is unavailable')
    error.code = 'AGENT_REQUEST_INVALID'
    throw error
  }
  return {
    adapter_id: model.adapterId,
    model_id: model.modelId,
    profile_id: model.profileId,
    profile_revision: model.profileRevision,
    provider_kind: model.providerKind
  }
}

function memoryReferenceCount (toolCalls, recipeId) {
  if (recipeId !== 'summary.minutes' || !Array.isArray(toolCalls)) return null
  const refs = new Set()
  for (const call of toolCalls) {
    if (call?.toolName !== 'search_context' || call.status !== 'succeeded') continue
    const matches = call.result?.matches
    if (!Array.isArray(matches)) continue
    for (const match of matches) {
      if (!Array.isArray(match?.entries)) continue
      for (const entry of match.entries) {
        const memory = entry?.memoryRef
        if (memory && typeof memory.memoryId === 'string' && typeof memory.revisionId === 'string') {
          refs.add(`${memory.memoryId}:${memory.revisionId}`)
        }
      }
    }
  }
  return refs.size
}

function publicInteractionId (value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function projectSubmit (run, interactionId, recipeId, routingMode, revision) {
  return c.assertSubmitResponse({
    ...header(), ok: true, error: null,
    result: {
      eligibility: 'ready',
      interaction_id: publicInteractionId(interactionId),
      recipe_id: recipeId || run?.recipeId || null,
      revision,
      routing_mode: routingMode || null,
      run_id: publicInteractionId(run?.runId),
      state: publicState(run?.state)
    }
  })
}

function freezeSourceFromTranscript (sessionId, transcript) {
  const session = transcript?.session
  if (!session || !isTerminal(session.state)) {
    const error = new Error('session not terminal'); error.code = 'SESSION_ACTIVE'; throw error
  }
  const segments = Array.isArray(transcript.segments) ? transcript.segments : []
  const events = segments.map((segment) => ({
    eventOrder: segment.firstEventOrder,
    segmentId: segment.segmentId,
    text: segment.text
  }))
  if (events.length === 0 || events.some((event) => !Number.isSafeInteger(event.eventOrder) || event.eventOrder < 1 ||
      typeof event.segmentId !== 'string' || typeof event.text !== 'string')) {
    const error = new Error('no committed transcript'); error.code = 'AGENT_INPUT_EMPTY'; throw error
  }
  const inputWatermark = Math.max(...events.map((event) => event.eventOrder))
  return {
    transcriptVersion: 'raw',
    inputWatermark: { throughEventOrder: inputWatermark },
    inputDigest: sha256Canonical({ sessionId, transcriptVersion: 'raw', inputWatermark, events })
  }
}

function isTerminal (state) {
  return state === 'closed' || state === 'interrupted'
}

function isSupportedExecutionScope (scope) {
  return ['session', 'date_range', 'project'].includes(scope?.kind)
}

function mapErrorCode (error) {
  const code = error?.code
  if (code === 'AGENT_REQUEST_INVALID') return 'invalid'
  if (code === 'SESSION_NOT_FOUND' || code === 'SESSION_ACTIVE') return 'unavailable'
  return 'unavailable'
}

class AgentInteractionReader {
  constructor (options = {}) {
    if (!options.storage || typeof options.storage !== 'object') {
      throw new TypeError('storage gateway is required')
    }
    this.storage = options.storage
    this.modelAccess = options.modelAccess || null
    this.exporter = options.exporter || null
    this.getConfig = typeof options.getConfig === 'function' ? options.getConfig : null
    this.getOwnerWindow = typeof options.getOwnerWindow === 'function' ? options.getOwnerWindow : () => null
    this.onHistoryChanged = typeof options.onChanged === 'function' ? options.onChanged : () => {}
    this.historyListeners = new Set()
    this.revision = 0
  }

  emitHistoryChanged () {
    this.revision += 1
    const event = c.assertChangedEvent({ ...header(), revision: this.revision })
    try { this.onHistoryChanged(event) } catch { /* renderer observers are isolated */ }
    for (const listener of [...this.historyListeners]) {
      try { listener(event) } catch { /* observers are isolated */ }
    }
    return event
  }

  subscribeHistoryChanged (listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    this.historyListeners.add(listener)
    return () => this.historyListeners.delete(listener)
  }

  async getScopes (request) {
    try {
      c.assertGetScopesRequest(request)
      const retirement = this.storage.getRetirementFailure?.()
      if (retirement) return c.assertGetScopesResponse({ ...header(), ok: false, error: { category: retirement, code: c.ERROR_CODES.unavailable, next_action: 'restart_application' }, scopes: [], next_cursor: null, default_scope: null, revision: this.revision })
      if (request.kind === 'project') {
        const after = request.cursor === null ? '' : Buffer.from(request.cursor, 'base64url').toString('utf8')
        if (request.cursor !== null && Buffer.from(after).toString('base64url') !== request.cursor) throw new TypeError('AGENT_REQUEST_INVALID')
        const page = await this.storage.personalContextQuestionEvidence({ action: 'projects', after, limit: request.limit })
        const scopes = page.items.map(item => ({ scope: { kind: 'project', reference: item.scope_id }, display_name: `${item.label} · ${item.scope_id}`,
          started_at: null, ended_at: null, state: 'ready' }))
        return c.assertGetScopesResponse({ ...header(), ok: true, error: null, scopes, default_scope: scopes[0]?.scope || null,
          next_cursor: page.next ? Buffer.from(page.next).toString('base64url') : null, revision: this.revision })
      }
      let cursor = decodeCursor(request.cursor)
      const items = []
      let nextCursor = null
      let exhausted = false
      while (items.length < request.limit && !exhausted) {
        const page = await this.storage.listSessions({ limit: 100, cursor })
        const sourceItems = Array.isArray(page?.items) ? page.items : []
        let lastScanned = null
        for (const item of sourceItems) {
          lastScanned = item
          if (isTerminal(item.state) && Number(item.segmentCount) > 0) items.push(sessionItem(item))
          if (items.length >= request.limit) break
        }
        const rawNext = page?.nextCursor || null
        if (items.length >= request.limit && lastScanned) {
          nextCursor = rawNext
            ? encodeCursor({ startedAt: lastScanned.startedAt, sessionId: lastScanned.sessionId })
            : null
          break
        }
        if (!rawNext || typeof rawNext !== 'object') {
          exhausted = true
          nextCursor = null
          break
        }
        cursor = { startedAt: rawNext.startedAt, sessionId: rawNext.sessionId }
        nextCursor = encodeCursor(cursor)
      }
      const projectedItems = items.slice(0, request.limit)
      const defaultScope = request.cursor === null && projectedItems.length > 0 ? projectedItems[0].scope : null
      const response = {
        ...header(),
        ok: true,
        error: null,
        scopes: projectedItems,
        next_cursor: nextCursor,
        default_scope: defaultScope,
        revision: this.revision
      }
      return c.assertGetScopesResponse(response)
    } catch (error) {
      if (error?.message === 'AGENT_REQUEST_INVALID' || error?.code === 'AGENT_REQUEST_INVALID') {
        return c.assertGetScopesResponse({ ...header(), ok: false, error: { category: 'invalid', code: c.ERROR_CODES.invalid, next_action: 'correct_input' }, scopes: [], next_cursor: null, default_scope: null, revision: this.revision })
      }
      return c.assertGetScopesResponse({ ...header(), ok: false, error: { category: 'unavailable', code: c.ERROR_CODES.unavailable, next_action: 'retry' }, scopes: [], next_cursor: null, default_scope: null, revision: this.revision })
    }
  }

  async getEligibility (request) {
    try {
      c.assertGetEligibilityRequest(request)
      if (this.storage.getRetirementFailure?.()) return publicEligibilityFailure('restart_application')
      if (!isSupportedExecutionScope(request.scope)) return publicEligibilityFailure('choose_supported_scope')
      if (this.getConfig) {
        const settings = this.getConfig()
        if (!settings || settings.agentEnabled !== true) return publicEligibility(request.scope, 'agent_disabled', this.revision)
      }
      const transcript = request.scope.kind === 'session' ? await this.storage.getSessionTranscript(request.scope.reference) : null
      const session = transcript?.session
      if (request.scope.kind === 'session') {
        if (!session || !isTerminal(session.state)) return publicEligibility(request.scope, 'session_not_terminal', this.revision)
        if (!Array.isArray(transcript.segments) || transcript.segments.length === 0) return publicEligibility(request.scope, 'no_committed_transcript', this.revision)
      } else await this.storage.personalContextQuestionEvidence({ action: 'freeze', scope: request.scope })
      if (!this.modelAccess || typeof this.modelAccess.catalog !== 'function') return publicEligibility(request.scope, 'provider_not_configured', this.revision)
      const catalog = await this.modelAccess.catalog()
      const readiness = catalog?.snapshot?.readinessByPurpose?.[request.scope.kind === 'session' ? 'summary' : 'default']?.agentLoop
      if (readiness === 'credential_unavailable') return publicEligibility(request.scope, 'credential_unavailable', this.revision)
      if (readiness !== 'ready') return publicEligibility(request.scope, 'provider_not_configured', this.revision)
      return publicEligibility(request.scope, 'ready', this.revision)
    } catch (error) {
      if (error?.code === 'SESSION_ACTIVE') return publicEligibility(request.scope, 'session_not_terminal', this.revision)
      if (error?.code === 'SESSION_NOT_FOUND') return publicEligibility(request.scope, 'no_committed_transcript', this.revision)
      if (error?.code === 'AGENT_INPUT_EMPTY') return publicEligibility(request.scope, 'no_committed_transcript', this.revision)
      if (error?.message === 'AGENT_REQUEST_INVALID' || error?.code === 'AGENT_REQUEST_INVALID') return { ...header(), ok: false, error: { category: 'invalid', code: c.ERROR_CODES.invalid, next_action: 'correct_input' }, snapshot: null }
      return publicEligibilityFailure('retry')
    }
  }

  async getHistory (request) {
    try {
      c.assertHistoryRequest(request)
      if (typeof this.storage.listAgentInteractions !== 'function') return c.assertHistoryResponse({ ...header(), ok: true, error: null, result: { items: [], has_more: false, next_cursor: null } })
      const page = await this.storage.listAgentInteractions({ limit: request.limit, cursor: request.cursor,
        ...(request.scope ? { scope: request.scope } : {}),
        ...(request.recipe_id ? { recipeId: request.recipe_id } : {}) })
      const items = (page?.items || []).map((item) => {
        const usage = publicUsage(item.usage)
        return {
          attempt_count: item.attemptCount,
          created_at: item.createdAt,
          duration_ms: item.durationMs,
          error_code: item.errorCode,
          interaction_id: item.interactionId,
          comparison_group_id: item.comparisonGroupId,
          model: publicModel(item.model),
          recipe_id: item.recipeId,
          recipe_version: item.recipeVersion,
          result: item.result,
          result_digest: item.resultDigest,
          summary_use_memory: item.recipeId === 'summary.minutes' ? (item.summaryUseMemory ?? null) : null,
          memory_reference_count: item.recipeId === 'summary.minutes' ? (item.memoryReferenceCount ?? null) : null,
          terminal_at: item.terminalAt,
          terminal_reason: item.terminalReason,
          usage: usage.usage,
          usage_state: usage.usage_state
        }
      })
      return c.assertHistoryResponse({ ...header(), ok: true, error: null, result: {
        items, has_more: Boolean(page?.hasMore), next_cursor: page?.nextCursor || null
      } })
    } catch (error) {
      if (error?.code === 'AGENT_REQUEST_INVALID') return { ...publicFailure(c.ERROR_CODES.invalid, 'correct_input'), error: { category: 'invalid', code: c.ERROR_CODES.invalid, next_action: 'correct_input' } }
      return publicFailure()
    }
  }

  async getInteraction (request) {
    try {
      c.assertInteractionRequest(request)
      if (typeof this.storage.getAgentInteraction !== 'function') return publicFailure()
      const detail = await this.storage.getAgentInteraction({ interactionId: request.interaction_id })
      const item = detail?.interaction
      if (!item) return publicFailure()
      if (!['summary.minutes', 'qa.answer'].includes(item.recipeId)) return publicFailure()
      const binding = detail.binding
      if (!binding || typeof binding.adapterId !== 'string' || typeof binding.modelId !== 'string' ||
          typeof binding.profileId !== 'string' || !Number.isSafeInteger(binding.profileRevision) ||
          !['local', 'cloud'].includes(binding.providerKind)) return publicFailure()
      const usage = publicUsage(item.usage)
      const referenceCount = memoryReferenceCount(detail.toolCalls, item.recipeId)
      const state = publicState(detail.runState, item.terminalReason, detail.cancelRequested === true)
      const result = {
        attempt_count: item.attemptCount,
        created_at: item.createdAt,
        duration_ms: item.durationMs,
        error_code: item.errorCode,
        interaction_id: item.interactionId,
        model: { adapter_id: binding.adapterId, model_id: binding.modelId, profile_id: binding.profileId, profile_revision: binding.profileRevision, provider_kind: binding.providerKind },
        recipe_id: item.recipeId,
        recipe_version: item.recipeVersion,
        result: item.result,
        result_digest: item.resultDigest,
        summary_use_memory: item.recipeId === 'summary.minutes' ? (detail.summaryUseMemory ?? null) : null,
        memory_reference_count: referenceCount,
        routing_mode: item.routingMode,
        run_id: item.runId,
        source_refs: (detail.toolCalls || []).flatMap((call) => Array.isArray(call.sourceRefs) ? call.sourceRefs : []),
        state,
        terminal_at: item.terminalAt,
        terminal_reason: item.terminalReason,
        tool_calls: (detail.toolCalls || []).map((call) => ({
          args: call.args, args_digest: call.argsDigest, attempt: call.attempt,
          call_id: call.callId, call_order: call.callOrder, counts: call.counts,
          ended_offset_ms: call.endedOffsetMs, error_code: call.errorCode,
          result: call.result, result_digest: call.resultDigest,
          schema_version: call.schemaVersion, source_refs: call.sourceRefs,
          started_offset_ms: call.startedOffsetMs, status: call.status, tool_name: call.toolName
        })),
        usage: usage.usage,
        usage_state: usage.usage_state
      }
      if (item.recipeId === 'qa.answer' && ['4', '5'].includes(item.recipeVersion) && item.terminalReason === 'succeeded') {
        result.source_positions = await this.storage.personalContextQuestionEvidence({ action: 'positions', runId: item.runId })
      }
      if (detail.summaryQuality) result.summary_processing_mode = detail.summaryQuality.mode
      if (detail.outputValidation) result.output_validation = detail.outputValidation
      if (item.recipeId === 'summary.minutes' && detail.summaryUseMemory === true && typeof this.storage.personalContextManage === 'function') {
        const refs = new Map()
        for (const call of detail.toolCalls || []) {
          if (call.toolName !== 'search_context' || call.status !== 'succeeded') continue
          for (const match of call.result?.matches || []) for (const entry of match.entries || []) {
            if (entry.memoryRef) refs.set(canonicalize(entry.memoryRef), entry.memoryRef)
          }
        }
        const settings = this.getConfig?.()
        result.memory_inputs = []; result.memory_inputs_error = null
        if (settings && (settings.agentEnabled !== true || settings.memoryEnabled !== true)) result.memory_inputs_error = 'suspended'
        else {
          try { result.memory_inputs = await this.storage.personalContextManage({ type: 'memory_inputs', refs: [...refs.values()].slice(0, 20), sessionId: item.scope?.kind === 'session' ? item.scope.reference : null }) }
          catch { result.memory_inputs_error = 'unavailable' }
        }
      }
      return c.assertInteractionResponse({ ...header(), ok: true, error: null, result })
    } catch (error) {
      if (error?.code === 'AGENT_REQUEST_INVALID') return { ...publicFailure(c.ERROR_CODES.invalid, 'correct_input'), error: { category: 'invalid', code: c.ERROR_CODES.invalid, next_action: 'correct_input' } }
      return publicFailure()
    }
  }

  async exportInteraction (request, context = {}) {
    try {
      c.assertExportRequest(request)
    } catch {
      return c.assertExportResponse({ ...publicFailure(c.ERROR_CODES.invalid, 'correct_input'), error: { category: 'invalid', code: c.ERROR_CODES.invalid, next_action: 'correct_input' } })
    }
    if (!this.exporter || typeof this.exporter.exportInteraction !== 'function') {
      return c.assertExportResponse(publicFailure(c.ERROR_CODES.unavailable, 'retry'))
    }
    try {
      const ownerWindow = context?.sender ? this.getOwnerWindow(context.sender) : null
      const result = await this.exporter.exportInteraction({ interactionId: request.interaction_id, ownerWindow })
      if (result?.cancelled === true) return c.assertExportResponse(publicFailure(c.ERROR_CODES.unavailable, 'export_cancelled'))
      return c.assertExportResponse({ ...header(), ok: true, error: null, result })
    } catch {
      return c.assertExportResponse(publicFailure(c.ERROR_CODES.unavailable, 'retry'))
    }
  }
}

module.exports = { AgentInteractionReader, decodeCursor, encodeCursor, sessionItem, publicFailure, invalid, projectSubmit,
  freezeSourceFromTranscript, isSupportedExecutionScope, terminalInteractionState, publicState }
