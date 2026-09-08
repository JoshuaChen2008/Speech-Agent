'use strict'

const crypto = require('node:crypto')
const { canonicalize } = require('../../runtime/storage-worker/canonical-json')
const { sha256Canonical } = require('../../runtime/storage-worker/canonical-json')
const c = require('../contracts/agent-run-ui')
const { deterministicRoute } = require('../execution-host/intent-router')

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
  const label = `${item.mode || 'session'} · ${new Date(item.startedAt).toISOString()}`
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
  return scope?.kind === 'session'
}

function mapErrorCode (error) {
  const code = error?.code
  if (code === 'AGENT_REQUEST_INVALID') return 'invalid'
  if (code === 'SESSION_NOT_FOUND' || code === 'SESSION_ACTIVE') return 'unavailable'
  return 'unavailable'
}

class AgentRunService {
  constructor (options = {}) {
    if (!options.storage || typeof options.storage.listSessions !== 'function' ||
        typeof options.storage.getSessionTranscript !== 'function') {
      throw new TypeError('storage gateway is required')
    }
    this.storage = options.storage
    this.modelAccess = options.modelAccess || null
    this.scheduler = options.scheduler || null
    this.routeOrchestrator = options.routeOrchestrator || null
    this.promptStore = options.promptStore instanceof Map ? options.promptStore : null
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.idFactory = typeof options.idFactory === 'function' ? options.idFactory : () => crypto.randomUUID()
    this.onChanged = typeof options.onChanged === 'function' ? options.onChanged : () => {}
    this.listeners = new Set()
    this.revision = 0
  }

  emitChanged () {
    this.revision += 1
    const event = c.assertChangedEvent({ ...header(), revision: this.revision })
    try { this.onChanged(event) } catch { /* renderer observers are isolated */ }
    for (const listener of [...this.listeners]) {
      try { listener(event) } catch { /* observers are isolated */ }
    }
    return event
  }

  subscribeChanged (listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function')
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async getScopes (request) {
    try {
      c.assertGetScopesRequest(request)
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
      if (!isSupportedExecutionScope(request.scope)) return publicEligibilityFailure('choose_supported_scope')
      const transcript = await this.storage.getSessionTranscript(request.scope.reference)
      const session = transcript?.session
      if (!session || !isTerminal(session.state)) return publicEligibility(request.scope, 'session_not_terminal', this.revision)
      if (!Array.isArray(transcript.segments) || transcript.segments.length === 0) return publicEligibility(request.scope, 'no_committed_transcript', this.revision)
      if (!this.modelAccess || typeof this.modelAccess.catalog !== 'function') return publicEligibility(request.scope, 'provider_not_configured', this.revision)
      const catalog = await this.modelAccess.catalog()
      const readiness = catalog?.snapshot?.readinessByPurpose?.summary?.agentLoop
      if (readiness === 'credential_unavailable') return publicEligibility(request.scope, 'credential_unavailable', this.revision)
      if (readiness !== 'ready') return publicEligibility(request.scope, 'provider_not_configured', this.revision)
      return publicEligibility(request.scope, 'ready', this.revision)
    } catch (error) {
      if (error?.code === 'SESSION_ACTIVE') return publicEligibility(request.scope, 'session_not_terminal', this.revision)
      if (error?.code === 'SESSION_NOT_FOUND') return publicEligibility(request.scope, 'no_committed_transcript', this.revision)
      if (error?.message === 'AGENT_REQUEST_INVALID' || error?.code === 'AGENT_REQUEST_INVALID') return { ...header(), ok: false, error: { category: 'invalid', code: c.ERROR_CODES.invalid, next_action: 'correct_input' }, snapshot: null }
      return publicEligibilityFailure('retry')
    }
  }

  async submit (request) {
    try {
      c.assertSubmitRequest(request)
      if (!isSupportedExecutionScope(request.scope)) return publicFailure(c.ERROR_CODES.unavailable, 'choose_supported_scope')
      const eligibility = await this.getEligibility({ ...header(), scope: request.scope })
      if (!eligibility.ok || eligibility.snapshot?.eligibility !== 'ready') {
        return publicFailure(c.ERROR_CODES.unavailable, 'retry')
      }
      const route = deterministicRoute({ scope: request.scope, prompt: request.prompt })
      if (!['summary.minutes', 'qa.answer'].includes(route.recipeId)) {
        return publicFailure(c.ERROR_CODES.unavailable, 'choose_supported_recipe')
      }
      const transcript = await this.storage.getSessionTranscript(request.scope.reference)
      const frozen = typeof this.storage.derivePersonalContextSessionSource === 'function'
        ? await this.storage.derivePersonalContextSessionSource({ sessionId: request.scope.reference, transcriptVersion: 'raw' })
        : freezeSourceFromTranscript(request.scope.reference, transcript)
      const inputWatermark = Number.isSafeInteger(frozen.inputWatermark)
        ? { throughEventOrder: frozen.inputWatermark }
        : frozen.inputWatermark
      if (!inputWatermark || !Number.isSafeInteger(inputWatermark.throughEventOrder)) {
        const error = new Error('frozen input watermark is invalid'); error.code = 'AGENT_REQUEST_INVALID'; throw error
      }
      const requestKeyDigest = sha256Canonical(request.client_idempotency_key)
      const runId = `run.user.${requestKeyDigest.slice(0, 48)}`
      const interactionId = `interaction.user.${requestKeyDigest.slice(0, 44)}`
      if (this.routeOrchestrator && typeof this.routeOrchestrator.submit === 'function') {
        let routed
        try {
          routed = await this.routeOrchestrator.submit({
            scope: request.scope,
            prompt: request.prompt,
            transcriptVersion: frozen.transcriptVersion,
            inputWatermark,
            inputDigest: frozen.inputDigest,
            clientIdempotencyKey: request.client_idempotency_key,
            signal: null
          })
        } catch (error) {
          if (error?.code === 'AGENT_CANCELLED') return publicFailure(c.ERROR_CODES.unavailable, 'retry')
          if (error?.code === 'AGENT_REQUEST_INVALID') return invalid()
          return publicFailure(c.ERROR_CODES.unavailable, 'retry')
        }
        if (routed?.unsupported === true) return publicFailure(c.ERROR_CODES.unavailable, 'choose_supported_recipe')
        if (routed?.eligibility !== 'ready' || typeof routed?.runId !== 'string' || typeof routed?.interactionId !== 'string') {
          return publicFailure(c.ERROR_CODES.unavailable, 'retry')
        }
        if (this.promptStore && routed.state !== 'succeeded' && routed.state !== 'failed' && routed.state !== 'cancelled') {
          this.promptStore.set(routed.runId, request.prompt)
        }
        if (this.scheduler && typeof this.scheduler.wake === 'function') this.scheduler.wake('submit')
        if (routed.replayed !== true) this.emitChanged()
        return projectSubmit(routed, routed.interactionId, routed.recipeId, routed.routingMode, this.revision)
      }
      const run = await this.storage.createAgentRun({
        runId,
        recipeId: route.recipeId,
        recipeVersion: '1',
        scope: request.scope,
        transcriptVersion: frozen.transcriptVersion,
        inputWatermark,
        inputDigest: frozen.inputDigest,
        requestedBy: 'user',
        clientIdempotencyKey: request.client_idempotency_key
      })
      const promptDigest = sha256Canonical(request.prompt)
      if (run?.replayed && typeof this.storage.getAgentInteraction === 'function') {
        const existing = await this.storage.getAgentInteraction({ interactionId }).catch(() => null)
        const existingDigest = existing?.interaction?.promptDigest || existing?.interaction?.prompt_digest
        if (existingDigest && existingDigest !== promptDigest) {
          return { ...publicFailure(c.ERROR_CODES.invalid, 'correct_input'), error: { category: 'invalid', code: c.ERROR_CODES.invalid, next_action: 'correct_input' } }
        }
      }
      if (!this.modelAccess || typeof this.modelAccess.bind !== 'function') {
        await this.storage.cancelAgentRun({ runId: run.runId }).catch(() => {})
        return publicFailure(c.ERROR_CODES.unavailable, 'settings')
      }
      try {
        await this.modelAccess.bind({ runId: run.runId, recipeId: route.recipeId, recipeVersion: '1', executionForm: 'agent_loop' })
        await this.storage.createAgentInteraction({
          runId: run.runId,
          interactionId,
          routingMode: route.routingMode,
          promptDigest
        })
      } catch (error) {
        await this.storage.cancelAgentRun({ runId: run.runId }).catch(() => {})
        return publicFailure(c.ERROR_CODES.unavailable, error?.code === 'AGENT_PROVIDER_AUTH_FAILED' ? 'settings' : 'retry')
      }
      if (this.promptStore && typeof request.prompt === 'string') this.promptStore.set(run.runId, request.prompt)
      if (this.scheduler && typeof this.scheduler.wake === 'function') this.scheduler.wake('submit')
      if (run?.replayed !== true) this.emitChanged()
      return projectSubmit(run, interactionId, route.recipeId, route.routingMode, this.revision)
    } catch (error) {
      if (error?.code === 'AGENT_REQUEST_INVALID') return { ...publicFailure(c.ERROR_CODES.invalid, 'correct_input'), error: { category: 'invalid', code: c.ERROR_CODES.invalid, next_action: 'correct_input' } }
      if (error?.code === 'SESSION_ACTIVE') return publicFailure(c.ERROR_CODES.unavailable, 'wait_for_terminal')
      if (error?.code === 'AGENT_INPUT_EMPTY') return publicFailure(c.ERROR_CODES.unavailable, 'choose_committed_session')
      return publicFailure()
    }
  }

  async cancel (request) {
    try {
      c.assertCancelRequest(request)
      if (!this.storage.getAgentInteraction || !this.storage.cancelAgentRun) return publicFailure()
      const detail = await this.storage.getAgentInteraction({ interactionId: request.interaction_id })
      const runId = detail?.interaction?.runId || detail?.interaction?.run_id || detail?.runId
      if (typeof runId !== 'string') return publicFailure()
      const run = await this.storage.cancelAgentRun({ runId })
      if (this.scheduler && typeof this.scheduler.cancel === 'function') this.scheduler.cancel(runId)
      if (run?.state === 'cancelled' && this.promptStore) this.promptStore.delete(runId)
      if (run?.replayed !== true) this.emitChanged()
      return c.assertCancelResponse({ ...header(), ok: true, error: null, result: {
        interaction_id: request.interaction_id,
        revision: this.revision,
        state: publicState(run?.state, run?.state === 'cancelled' ? 'cancelled' : null, run?.cancelRequested)
      } })
    } catch (error) {
      if (error?.code === 'AGENT_REQUEST_INVALID') return { ...publicFailure(c.ERROR_CODES.invalid, 'correct_input'), error: { category: 'invalid', code: c.ERROR_CODES.invalid, next_action: 'correct_input' } }
      return publicFailure()
    }
  }

  async getHistory (request) {
    try {
      c.assertHistoryRequest(request)
      if (typeof this.storage.listAgentInteractions !== 'function') return c.assertHistoryResponse({ ...header(), ok: true, error: null, result: { items: [], has_more: false, next_cursor: null } })
      const page = await this.storage.listAgentInteractions({ limit: request.limit, cursor: request.cursor })
      const items = (page?.items || []).map((item) => {
        const usage = publicUsage(item.usage)
        return {
          attempt_count: item.attemptCount,
          created_at: item.createdAt,
          duration_ms: item.durationMs,
          error_code: item.errorCode,
          interaction_id: item.interactionId,
          recipe_id: item.recipeId,
          recipe_version: item.recipeVersion,
          result: item.result,
          result_digest: item.resultDigest,
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
      const binding = detail.binding
      if (!binding || typeof binding.adapterId !== 'string' || typeof binding.modelId !== 'string' ||
          typeof binding.profileId !== 'string' || !Number.isSafeInteger(binding.profileRevision) ||
          !['local', 'cloud'].includes(binding.providerKind)) return publicFailure()
      const usage = publicUsage(item.usage)
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
        routing_mode: item.routingMode,
        run_id: item.runId,
        source_refs: (detail.toolCalls || []).flatMap((call) => Array.isArray(call.sourceRefs) ? call.sourceRefs : []),
        state,
        terminal_at: item.terminalAt,
        terminal_reason: item.terminalReason,
        tool_calls: (detail.toolCalls || []).map((call) => ({
          attempt: call.attempt, call_order: call.callOrder, counts: call.counts,
          ended_offset_ms: call.endedOffsetMs, error_code: call.errorCode,
          result_digest: call.resultDigest, source_refs: call.sourceRefs,
          started_offset_ms: call.startedOffsetMs, status: call.status, tool_name: call.toolName
        })),
        usage: usage.usage,
        usage_state: usage.usage_state
      }
      return c.assertInteractionResponse({ ...header(), ok: true, error: null, result })
    } catch (error) {
      if (error?.code === 'AGENT_REQUEST_INVALID') return { ...publicFailure(c.ERROR_CODES.invalid, 'correct_input'), error: { category: 'invalid', code: c.ERROR_CODES.invalid, next_action: 'correct_input' } }
      return publicFailure()
    }
  }

  async exportInteraction () { return unavailable() }
}

function createAgentRunService (options) { return new AgentRunService(options) }

module.exports = { AgentRunService, createAgentRunService, decodeCursor, encodeCursor, sessionItem }
