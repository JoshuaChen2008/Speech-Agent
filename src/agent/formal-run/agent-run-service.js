'use strict'

const crypto = require('node:crypto')
const { canonicalize } = require('../../runtime/storage-worker/canonical-json')
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

function isTerminal (state) {
  return state === 'closed' || state === 'interrupted'
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
      return { ...header(), ok: false, error: { category: 'unavailable', code: c.ERROR_CODES.unavailable, next_action: 'retry' }, snapshot: null }
    }
  }

  async submit () { return unavailable() }

  async cancel () { return unavailable() }

  async getHistory () { return okCommand({ items: [], has_more: false, next_cursor: null }) }

  async getInteraction () { return unavailable() }

  async exportInteraction () { return unavailable() }
}

function createAgentRunService (options) { return new AgentRunService(options) }

module.exports = { AgentRunService, createAgentRunService, decodeCursor, encodeCursor, sessionItem }
