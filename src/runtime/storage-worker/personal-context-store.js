'use strict'

const { canonicalize, sha256Canonical } = require('./canonical-json')
const { rollbackQuietly } = require('./sqlite-store')
const { StorageError, assertExactKeys, isPlainObject } = require('./protocol')
const { FORMAL_AGENT_TASK_ERROR_CODES } = require('../../agent/contracts/personal-context-core')
const { validateRecipeOutput } = require('../../agent/contracts/recipes')

const MAX_CANDIDATES = 256
const MAX_ITEMS = 20
const MAX_SCOPE_DIRECTORY_ITEMS = 50
const MAX_SOURCES_PER_ITEM = 8
const MAX_CANONICAL_BYTES = 65536
const MAX_INTERACTION_TEXT_BYTES = 16384
const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/
const MEMORY_KINDS = new Set([
  'decision', 'conclusion', 'todo', 'term', 'preference', 'project_fact', 'experience'
])
const SCOPE_KINDS = new Set(['global', 'session', 'topic', 'project'])
const INTERACTION_SIGNAL_KINDS = new Set(['prompt', 'edit', 'accept', 'reject', 'remember', 'forget'])
const SUMMARY_MEMORY_ERROR = 'AGENT_SUMMARY_MEMORY_READ_FAILED'

function fail (code) {
  throw new StorageError(code)
}

function safeInteger (value, minimum = 0, code = 'AGENT_REQUEST_INVALID') {
  if (!Number.isSafeInteger(value) || value < minimum) fail(code)
  return value
}

function boundedString (value, minimum, maximum, code = 'AGENT_REQUEST_INVALID') {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) fail(code)
  return value
}

function identifier (value, code = 'AGENT_REQUEST_INVALID') {
  boundedString(value, 1, 160, code)
  if (!ID_PATTERN.test(value)) fail(code)
  return value
}

function automaticTaskPolicy (value) {
  assertExactKeys(value, [
    'agentEnabled', 'automaticProcessingSince', 'memoryEnabled', 'memoryProcessingSince'
  ], 'AGENT_REQUEST_INVALID')
  if (typeof value.agentEnabled !== 'boolean' || typeof value.memoryEnabled !== 'boolean' ||
      (value.automaticProcessingSince !== null &&
       (!Number.isSafeInteger(value.automaticProcessingSince) || value.automaticProcessingSince < 0)) ||
      (value.memoryProcessingSince !== null &&
       (!Number.isSafeInteger(value.memoryProcessingSince) || value.memoryProcessingSince < 0)) ||
      (value.automaticProcessingSince !== null) !== value.agentEnabled ||
      (value.memoryProcessingSince !== null) !== (value.agentEnabled && value.memoryEnabled)) {
    fail('AGENT_REQUEST_INVALID')
  }
  return Object.freeze({
    agentEnabled: value.agentEnabled,
    automaticProcessingSince: value.automaticProcessingSince,
    memoryEnabled: value.memoryEnabled,
    memoryProcessingSince: value.memoryProcessingSince
  })
}

function automaticTaskPolicyAllows (policy) {
  return Boolean(policy && policy.agentEnabled === true && policy.memoryEnabled === true &&
    policy.automaticProcessingSince !== null && policy.memoryProcessingSince !== null)
}

function interactionSignalRequest (value) {
  assertExactKeys(value, ['interactionId', 'signalKind', 'payloadDigest', 'signalIdempotencyKey'], 'AGENT_REQUEST_INVALID')
  identifier(value.interactionId)
  identifier(value.signalIdempotencyKey)
  if (!INTERACTION_SIGNAL_KINDS.has(value.signalKind)) fail('AGENT_REQUEST_INVALID')
  if (value.payloadDigest !== null &&
      (typeof value.payloadDigest !== 'string' || !/^[0-9a-f]{64}$/.test(value.payloadDigest))) {
    fail('AGENT_REQUEST_INVALID')
  }
  if (['edit', 'remember'].includes(value.signalKind) && value.payloadDigest === null) fail('AGENT_REQUEST_INVALID')
  if (!['edit', 'remember'].includes(value.signalKind) && value.payloadDigest !== null) fail('AGENT_REQUEST_INVALID')
  return value
}

function interactionSignalText (value) {
  boundedString(value, 1, 4096)
  if (/[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value, 'utf8') > MAX_INTERACTION_TEXT_BYTES) {
    fail('AGENT_REQUEST_INVALID')
  }
  return value
}

function interactionSignalPayload (value, source) {
  assertExactKeys(value, ['prompt', 'editText', 'result'], 'AGENT_REQUEST_INVALID')
  const prompt = value.prompt === null ? null : interactionSignalText(value.prompt)
  const editText = value.editText === null ? null : interactionSignalText(value.editText)
  let result = value.result
  if (result !== null) {
    if (!isPlainObject(result)) fail('AGENT_REQUEST_INVALID')
    let encoded
    try { encoded = canonicalize(result) } catch { fail('AGENT_REQUEST_INVALID') }
    if (Buffer.byteLength(encoded, 'utf8') > MAX_CANONICAL_BYTES) fail('AGENT_BUDGET_EXCEEDED')
  }
  if (source.signalKind === 'prompt') {
    if (prompt === null || editText !== null) fail('AGENT_REQUEST_INVALID')
    if (source.promptDigest === null || sha256Canonical(prompt) !== source.promptDigest) fail('AGENT_INPUT_CHANGED')
    if (source.resultDigest === null) {
      if (result !== null) fail('AGENT_REQUEST_INVALID')
    } else {
      if (result === null || sha256Canonical(result) !== source.resultDigest) fail('AGENT_INPUT_CHANGED')
    }
  } else {
    if (prompt !== null || result === null || source.resultDigest === null || sha256Canonical(result) !== source.resultDigest) {
      fail('AGENT_INPUT_CHANGED')
    }
    if (source.signalKind === 'edit' || source.signalKind === 'remember') {
      if (editText === null || source.payloadDigest === null || sha256Canonical({ text: editText }) !== source.payloadDigest) {
        fail('AGENT_INPUT_CHANGED')
      }
    } else if (editText !== null || source.payloadDigest !== null) {
      fail('AGENT_REQUEST_INVALID')
    }
  }
  return { prompt, editText, result }
}

function normalizeSemanticKey (value) {
  boundedString(value, 1, 2048)
  const folded = value.normalize('NFKC')
    .toLocaleLowerCase('und')
    .replace(/\u00df/g, 'ss')
    .replace(/\u03c2/g, '\u03c3')
    .replace(/\s+/gu, ' ')
    .trim()
  let result = ''
  let bytes = 0
  for (const codePoint of folded) {
    const codePointBytes = Buffer.byteLength(codePoint, 'utf8')
    if (bytes + codePointBytes > 256) break
    result += codePoint
    bytes += codePointBytes
  }
  if (result.length === 0) fail('AGENT_REQUEST_INVALID')
  return result
}

function exactEntry (value) {
  assertExactKeys(value, ['display_text', 'kind', 'scope'], 'AGENT_REQUEST_INVALID')
  boundedString(value.display_text, 1, 2048)
  if (Buffer.byteLength(value.display_text, 'utf8') > 2048 || !MEMORY_KINDS.has(value.kind)) fail('AGENT_REQUEST_INVALID')
  assertExactKeys(value.scope, ['kind', 'reference'], 'AGENT_REQUEST_INVALID')
  if (!SCOPE_KINDS.has(value.scope.kind)) fail('AGENT_REQUEST_INVALID')
  const reference = value.scope.reference
  if (value.scope.kind === 'global') {
    if (reference !== null) fail('AGENT_REQUEST_INVALID')
  } else {
    identifier(reference)
  }
  return {
    displayText: value.display_text,
    kind: value.kind,
    scopeKind: value.scope.kind,
    scopeReference: reference,
    semanticKey: normalizeSemanticKey(value.display_text)
  }
}

function encodePageCursor (resource, updatedAt, id) {
  return Buffer.from(canonicalize({ id, resource, updatedAt }), 'utf8').toString('base64url')
}

function decodePageCursor (value, resource) {
  if (value === null) return null
  boundedString(value, 1, 256)
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    assertExactKeys(parsed, ['id', 'resource', 'updatedAt'], 'AGENT_REQUEST_INVALID')
    if (parsed.resource !== resource) fail('AGENT_REQUEST_INVALID')
    identifier(parsed.id)
    safeInteger(parsed.updatedAt)
    if (encodePageCursor(parsed.resource, parsed.updatedAt, parsed.id) !== value) fail('AGENT_REQUEST_INVALID')
    return parsed
  } catch (error) {
    if (error instanceof StorageError) throw error
    fail('AGENT_REQUEST_INVALID')
  }
}

function publicItem (row) {
  const content = JSON.parse(row.content_json)
  return {
    memory_id: row.memory_id,
    item_revision: Number(row.item_revision),
    display_text: content.displayText,
    kind: row.kind,
    origin: row.origin,
    lifecycle: row.lifecycle,
    scope: {
      kind: row.scope_kind,
      label: row.scope_label,
      reference: row.scope_kind === 'global' ? null : row.scope_id
    },
    semanticKey: row.semantic_key,
    updatedAt: Number(row.updated_at),
    sourceReferenceCount: Number(row.source_reference_count || 0)
  }
}

class PersonalContextStore {
  constructor (options = {}) {
    if (!options.subtitleStore?.database) throw new TypeError('subtitleStore is required')
    this.subtitleStore = options.subtitleStore
    this.database = options.subtitleStore.database
    this.now = typeof options.now === 'function'
      ? options.now
      : typeof options.subtitleStore.now === 'function' ? options.subtitleStore.now : () => Date.now()
    this.automaticPolicy = null
  }

  nowValue () {
    return safeInteger(this.now(), 0, 'STORAGE_COMMAND_FAILED')
  }

  contentRevision () {
    return Number(this.database.prepare(`
      SELECT content_revision FROM personal_context_projection_state WHERE singleton_key = 1
    `).get().content_revision)
  }

  advanceRevision (resultIdentity) {
    const next = this.contentRevision() + 1
    if (!Number.isSafeInteger(next)) fail('STORAGE_COMMAND_FAILED')
    this.database.prepare(`
      UPDATE personal_context_projection_state
      SET content_revision = ?, last_command_digest = ?, last_result_identity_json = ?, updated_at = ?
      WHERE singleton_key = 1
    `).run(next, sha256Canonical(resultIdentity), canonicalize(resultIdentity), this.nowValue())
    return next
  }

  sessionInput (source, { allowRefinedFallback = false } = {}) {
    assertExactKeys(source, ['sourceKind', 'sessionId', 'transcriptVersion', 'inputWatermark', 'inputDigest'], 'AGENT_REQUEST_INVALID')
    if (source.sourceKind !== 'session' || !['raw', 'refined'].includes(source.transcriptVersion)) fail('AGENT_REQUEST_INVALID')
    const sessionId = identifier(source.sessionId)
    const inputWatermark = safeInteger(source.inputWatermark, 1)
    if (typeof source.inputDigest !== 'string' || !/^[0-9a-f]{64}$/.test(source.inputDigest)) fail('AGENT_REQUEST_INVALID')
    const session = this.database.prepare(`
      SELECT session_id, started_at, ended_at, state
      FROM sessions WHERE session_id = ?
    `).get(sessionId)
    if (!session) fail('AGENT_SESSION_NOT_FOUND')
    if (!['closed', 'interrupted'].includes(session.state) || session.ended_at === null) fail('AGENT_SESSION_NOT_TERMINAL')
    const rows = this.database.prepare(`
      SELECT
        segment.segment_id,
        segment.source_id,
        segment.t0_ms,
        segment.t1_ms,
        first_event.event_order AS first_event_order,
        first_event.text AS raw_text,
        updated_event.event_order AS updated_event_order,
        updated_event.kind AS updated_kind,
        segment.text AS current_text,
        (
          SELECT refined.event_order FROM caption_events AS refined
          WHERE refined.session_id = segment.session_id
            AND refined.source_id = segment.source_id
            AND refined.segment_id = segment.segment_id
            AND refined.kind = 'refined'
          ORDER BY refined.revision DESC, refined.event_order DESC LIMIT 1
        ) AS refined_event_order,
        (
          SELECT refined.text FROM caption_events AS refined
          WHERE refined.session_id = segment.session_id
            AND refined.source_id = segment.source_id
            AND refined.segment_id = segment.segment_id
            AND refined.kind = 'refined'
          ORDER BY refined.revision DESC, refined.event_order DESC LIMIT 1
        ) AS refined_text,
        (
          SELECT refined.t0_ms FROM caption_events AS refined
          WHERE refined.session_id = segment.session_id
            AND refined.source_id = segment.source_id
            AND refined.segment_id = segment.segment_id
            AND refined.kind = 'refined'
          ORDER BY refined.revision DESC, refined.event_order DESC LIMIT 1
        ) AS refined_t0_ms,
        (
          SELECT refined.t1_ms FROM caption_events AS refined
          WHERE refined.session_id = segment.session_id
            AND refined.source_id = segment.source_id
            AND refined.segment_id = segment.segment_id
            AND refined.kind = 'refined'
          ORDER BY refined.revision DESC, refined.event_order DESC LIMIT 1
        ) AS refined_t1_ms
      FROM segments AS segment
      JOIN caption_events AS first_event ON first_event.event_order = segment.first_event_order
      JOIN caption_events AS updated_event ON updated_event.event_order = segment.updated_event_order
      WHERE segment.session_id = ?
      ORDER BY first_event.event_order
    `).all(sessionId)
    if (rows.length === 0) fail('AGENT_INPUT_EMPTY')
    const refinedComplete = rows.every((row) => row.refined_event_order !== null)
    if (source.transcriptVersion === 'refined' && !refinedComplete && !allowRefinedFallback) {
      fail('AGENT_INPUT_VERSION_UNAVAILABLE')
    }
    // A requested refined view is a single-version choice.  If any committed
    // segment lacks a refined event, freeze the complete raw view instead of
    // mixing versions or dropping the session.
    const transcriptVersion = source.transcriptVersion === 'refined' && refinedComplete ? 'refined' : 'raw'
    const events = rows.map((row) => ({
      eventOrder: Number(transcriptVersion === 'refined' ? row.refined_event_order : row.first_event_order),
      segmentId: row.segment_id,
      text: transcriptVersion === 'refined' ? row.refined_text : row.raw_text
    }))
    const selectedWatermark = Math.max(...events.map((event) => event.eventOrder))
    if (inputWatermark !== selectedWatermark) fail('AGENT_INPUT_CHANGED')
    const digestPayload = { sessionId, transcriptVersion, inputWatermark, events }
    if (sha256Canonical(digestPayload) !== source.inputDigest) fail('AGENT_INPUT_CHANGED')
    return {
      sourceKind: 'session',
      sessionId,
      transcriptVersion,
      inputWatermark,
      inputDigest: source.inputDigest,
      startedAt: Number(session.started_at),
      endedAt: Number(session.ended_at),
      fromEventOrder: Math.min(...events.map((event) => event.eventOrder)),
      throughEventOrder: Math.max(...events.map((event) => event.eventOrder)),
      segmentCount: events.length,
      events: events.map((event) => ({ ...event }))
    }
  }

  sessionSnapshot (source, options = {}) {
    const input = this.sessionInput(source, options)
    const { events, ...snapshot } = input
    return snapshot
  }

  readSessionInput (source) {
    return this.sessionInput(source, { allowRefinedFallback: true })
  }

  readInteractionInput (source, ephemeral) {
    assertExactKeys(source, [
      'sourceKind', 'interactionId', 'signalKind', 'payloadDigest', 'recipeId', 'recipeVersion',
      'scopeKind', 'scopeReference', 'transcriptVersion', 'inputWatermark',
      'inputDigest', 'sessionId', 'interactionInputDigest', 'promptDigest', 'resultDigest',
      'signalIdempotencyKey'
    ], 'AGENT_REQUEST_INVALID')
    const signal = interactionSignalRequest({
      interactionId: source.interactionId,
      signalKind: source.signalKind,
      payloadDigest: source.payloadDigest,
      signalIdempotencyKey: source.signalIdempotencyKey
    })
    if (source.sourceKind !== 'interaction' || source.recipeId === 'intent.route' ||
        source.recipeVersion !== '1' || source.scopeKind !== 'session' ||
        typeof source.scopeReference !== 'string' || source.transcriptVersion !== 'raw') {
      fail('AGENT_REQUEST_INVALID')
    }
    identifier(source.scopeReference)
    if (source.sessionId !== source.scopeReference) fail('AGENT_REQUEST_INVALID')
    safeInteger(source.inputWatermark, 1)
    if (typeof source.interactionInputDigest !== 'string' || !/^[0-9a-f]{64}$/.test(source.interactionInputDigest) ||
        (source.promptDigest !== null && (typeof source.promptDigest !== 'string' || !/^[0-9a-f]{64}$/.test(source.promptDigest))) ||
        (source.resultDigest !== null && (typeof source.resultDigest !== 'string' || !/^[0-9a-f]{64}$/.test(source.resultDigest)))) {
      fail('AGENT_REQUEST_INVALID')
    }
    const episode = this.database.prepare(`
      SELECT episode.*, scope.session_id AS scope_session_id
      FROM personal_context_episodes AS episode
      JOIN personal_context_scopes AS scope ON scope.scope_id = episode.scope_id
      WHERE episode.source_kind='interaction' AND episode.interaction_id=? AND episode.input_digest=?
    `).get(signal.interactionId, source.inputDigest)
    if (!episode) fail('AGENT_CONTEXT_NOT_FOUND')
    if (episode.input_digest !== source.inputDigest) fail('AGENT_INPUT_CHANGED')
    let summary
    try { summary = JSON.parse(episode.summary_json) } catch { fail('STORAGE_COMMAND_FAILED') }
    if (!isPlainObject(summary) || summary.signalKind !== signal.signalKind ||
        summary.interactionId !== signal.interactionId ||
        summary.signalIdempotencyKey !== signal.signalIdempotencyKey ||
        summary.payloadDigest !== signal.payloadDigest ||
        summary.recipeId !== source.recipeId || summary.recipeVersion !== source.recipeVersion ||
        summary.scopeKind !== source.scopeKind || summary.scopeReference !== source.scopeReference ||
        episode.scope_session_id !== source.sessionId || episode.transcript_version !== source.transcriptVersion ||
        Number(episode.input_watermark) !== source.inputWatermark ||
        episode.input_digest !== source.inputDigest ||
        summary.interactionInputDigest !== source.interactionInputDigest ||
        summary.promptDigest !== source.promptDigest || summary.resultDigest !== source.resultDigest) {
      fail('AGENT_INPUT_CHANGED')
    }
    const signalPayload = interactionSignalPayload(ephemeral, {
      signalKind: signal.signalKind,
      payloadDigest: signal.payloadDigest,
      promptDigest: summary.promptDigest,
      resultDigest: summary.resultDigest
    })
    return {
      sourceKind: 'interaction', interactionId: signal.interactionId, signalKind: signal.signalKind,
      recipeId: episode.source_kind === 'interaction' ? summary.recipeId : source.recipeId,
      recipeVersion: source.recipeVersion, scopeKind: 'session',
      scopeReference: episode.scope_session_id, sessionId: episode.scope_session_id,
      transcriptVersion: episode.transcript_version,
      inputWatermark: Number(episode.input_watermark), inputDigest: episode.input_digest,
      interactionInputDigest: summary.interactionInputDigest,
      promptDigest: summary.promptDigest, resultDigest: summary.resultDigest,
      payloadDigest: summary.payloadDigest, signalIdempotencyKey: summary.signalIdempotencyKey,
      signal: {
        signalKind: signal.signalKind,
        prompt: signalPayload.prompt,
        editText: signalPayload.editText,
        result: signalPayload.result
      },
      events: []
    }
  }

  readToolContext (input) {
    assertExactKeys(input, ['runId'], 'AGENT_REQUEST_INVALID')
    const runId = identifier(input.runId)
    const run = this.database.prepare(`
      SELECT scope_json, transcript_version, input_watermark_json, input_digest,
        requested_by, personal_context_revision, recipe_id, summary_use_memory
      FROM formal_agent_runs WHERE run_id = ?
    `).get(runId)
    if (!run) fail('AGENT_RUN_NOT_FOUND')
    let scope
    try { scope = JSON.parse(run.scope_json) } catch { fail('STORAGE_COMMAND_FAILED') }
    if (!isPlainObject(scope) || scope.kind !== 'session' || typeof scope.reference !== 'string') {
      fail('AGENT_REQUEST_INVALID')
    }
    const sessionId = identifier(scope.reference)
    let watermark
    try { watermark = JSON.parse(run.input_watermark_json) } catch { fail('STORAGE_COMMAND_FAILED') }
    if (!isPlainObject(watermark) || !Number.isSafeInteger(watermark.throughEventOrder) || watermark.throughEventOrder < 1) {
      fail('AGENT_REQUEST_INVALID')
    }
    const personalContextRevision = Number(run.personal_context_revision)
    if (!Number.isSafeInteger(personalContextRevision) || personalContextRevision < 0) fail('STORAGE_COMMAND_FAILED')
    const useMemory = run.recipe_id !== 'summary.minutes' || run.summary_use_memory === undefined || run.summary_use_memory !== 0
    if (run.requested_by === 'user' && useMemory && personalContextRevision !== this.contentRevision()) {
      fail('AGENT_INPUT_CHANGED')
    }
    if (!useMemory) {
      return {
        scope: { registeredAliasKeys: [], memoryRefs: [], sourceRefs: [] },
        entries: [],
        sources: []
      }
    }
    const items = this.database.prepare(`
      SELECT item.memory_id, item.current_revision_id, item.semantic_key, item.kind, item.content_json
      FROM personal_context_items AS item
      JOIN personal_context_scopes AS scope ON scope.scope_id = item.scope_id
      WHERE item.lifecycle = 'active' AND (
        scope.kind = 'global' OR (scope.kind = 'session' AND scope.session_id = ?)
      )
      ORDER BY item.updated_at DESC, item.memory_id ASC LIMIT ?
    `).all(sessionId, MAX_ITEMS + 1)
    if (items.length > MAX_ITEMS) fail('AGENT_BUDGET_EXCEEDED')

    const sourceByKey = new Map()
    const entries = []
    for (const item of items) {
      if (typeof item.current_revision_id !== 'string') continue
      const evidenceRows = this.database.prepare(`
        SELECT session_id, transcript_version, from_event_order, through_event_order
        FROM personal_context_evidence
        WHERE memory_id = ? AND source_kind = 'session'
        ORDER BY created_at ASC, evidence_id ASC LIMIT ?
      `).all(item.memory_id, MAX_SOURCES_PER_ITEM + 1)
      if (evidenceRows.length > MAX_SOURCES_PER_ITEM) continue
      const sourceRefs = []
      for (const evidence of evidenceRows) {
        const sourceRef = {
          sessionId: evidence.session_id,
          transcriptVersion: evidence.transcript_version,
          fromEventOrder: Number(evidence.from_event_order),
          throughEventOrder: Number(evidence.through_event_order)
        }
        const key = canonicalize(sourceRef)
        if (!sourceByKey.has(key)) {
          const kind = sourceRef.transcriptVersion === 'raw' ? 'final' : 'refined'
          const rows = this.database.prepare(`
            SELECT text FROM caption_events
            WHERE session_id = ? AND kind = ? AND event_order >= ? AND event_order <= ?
            ORDER BY event_order ASC
          `).all(sourceRef.sessionId, kind, sourceRef.fromEventOrder, sourceRef.throughEventOrder)
          if (rows.length === 0) fail('AGENT_INPUT_CHANGED')
          sourceByKey.set(key, { sourceRef, text: rows.map((row) => row.text).join(' ') })
        }
        sourceRefs.push(sourceRef)
      }
      let displayText
      try { displayText = JSON.parse(item.content_json).displayText } catch { fail('STORAGE_COMMAND_FAILED') }
      entries.push({
        aliasKey: item.semantic_key,
        memoryRef: { memoryId: item.memory_id, revisionId: item.current_revision_id },
        kind: item.kind,
        displayText,
        sourceRefs
      })
    }
    const result = {
      scope: {
        registeredAliasKeys: [...new Set(entries.map((entry) => entry.aliasKey))],
        memoryRefs: entries.map((entry) => entry.memoryRef),
        sourceRefs: [...sourceByKey.values()].map((source) => source.sourceRef)
      },
      entries,
      sources: [...sourceByKey.values()]
    }
    if (Buffer.byteLength(canonicalize(result), 'utf8') > MAX_CANONICAL_BYTES) fail('AGENT_BUDGET_EXCEEDED')
    return result
  }

  deriveSessionSource (request) {
    assertExactKeys(request, ['sessionId', 'transcriptVersion'], 'AGENT_REQUEST_INVALID')
    identifier(request.sessionId)
    if (!['raw', 'refined'].includes(request.transcriptVersion)) fail('AGENT_REQUEST_INVALID')
    const session = this.database.prepare('SELECT * FROM sessions WHERE session_id=?').get(request.sessionId)
    if (!session) fail('AGENT_SESSION_NOT_FOUND')
    if (session.state === 'active') fail('AGENT_SESSION_NOT_TERMINAL')
    const rows = this.database.prepare(`
      SELECT segment.segment_id, first_event.event_order AS first_event_order,
        first_event.text AS raw_text,
        (SELECT refined.event_order FROM caption_events AS refined
          WHERE refined.session_id=segment.session_id AND refined.source_id=segment.source_id
            AND refined.segment_id=segment.segment_id AND refined.kind='refined'
          ORDER BY refined.revision DESC, refined.event_order DESC LIMIT 1) AS refined_event_order,
        (SELECT refined.text FROM caption_events AS refined
          WHERE refined.session_id=segment.session_id AND refined.source_id=segment.source_id
            AND refined.segment_id=segment.segment_id AND refined.kind='refined'
          ORDER BY refined.revision DESC, refined.event_order DESC LIMIT 1) AS refined_text
      FROM segments AS segment
      JOIN caption_events AS first_event ON first_event.event_order=segment.first_event_order
      WHERE segment.session_id=? ORDER BY first_event.event_order
    `).all(request.sessionId)
    if (rows.length === 0) fail('AGENT_INPUT_EMPTY')
    const refinedComplete = rows.every((row) => row.refined_event_order !== null)
    const transcriptVersion = request.transcriptVersion === 'refined' && refinedComplete ? 'refined' : 'raw'
    const events = rows.map((row) => ({
      eventOrder: Number(transcriptVersion === 'refined' ? row.refined_event_order : row.first_event_order),
      segmentId: row.segment_id,
      text: transcriptVersion === 'refined' ? row.refined_text : row.raw_text
    }))
    const inputWatermark = Math.max(...events.map((event) => event.eventOrder))
    const inputDigest = sha256Canonical({ sessionId: request.sessionId, transcriptVersion, inputWatermark, events })
    return { sourceKind: 'session', sessionId: request.sessionId, transcriptVersion, inputWatermark, inputDigest }
  }

  prepareSessionIngestRequest (request) {
    const source = this.deriveSessionSource(request)
    return this.prepareSessionIngest(source)
  }

  deriveInteractionSignalSource (request) {
    const signal = interactionSignalRequest(request)
    const interaction = this.database.prepare(`
      SELECT * FROM formal_agent_interactions WHERE interaction_id = ?
    `).get(signal.interactionId)
    if (!interaction) fail('AGENT_INTERACTION_NOT_FOUND')
    if (interaction.requested_by !== 'user' || interaction.recipe_id === 'intent.route') {
      fail('AGENT_REQUEST_INVALID')
    }
    if (interaction.terminal_reason === null) fail('AGENT_INTERACTION_NOT_TERMINAL')
    if (signal.signalKind !== 'prompt' && interaction.terminal_reason !== 'succeeded') {
      fail('AGENT_INTERACTION_NOT_TERMINAL')
    }
    const run = this.database.prepare(`
      SELECT scope_json, input_watermark_json FROM formal_agent_runs WHERE run_id = ?
    `).get(interaction.run_id)
    if (!run) fail('AGENT_CONTEXT_NOT_FOUND')
    let scope
    let watermark
    try {
      scope = JSON.parse(run.scope_json)
      watermark = JSON.parse(run.input_watermark_json)
    } catch { fail('STORAGE_COMMAND_FAILED') }
    if (!isPlainObject(scope) || scope.kind !== 'session' || typeof scope.reference !== 'string') {
      fail('AGENT_REQUEST_INVALID')
    }
    const sessionId = identifier(scope.reference)
    if (!isPlainObject(watermark) || !Number.isSafeInteger(watermark.throughEventOrder) || watermark.throughEventOrder < 1) {
      fail('AGENT_REQUEST_INVALID')
    }
    if (typeof interaction.input_digest !== 'string' || !/^[0-9a-f]{64}$/.test(interaction.input_digest)) {
      fail('STORAGE_COMMAND_FAILED')
    }
    const session = this.database.prepare(`
      SELECT started_at, ended_at, state FROM sessions WHERE session_id = ?
    `).get(sessionId)
    if (!session) fail('AGENT_SESSION_NOT_FOUND')
    if (!['closed', 'interrupted'].includes(session.state) || session.ended_at === null) {
      fail('AGENT_SESSION_NOT_TERMINAL')
    }
    return {
      sourceKind: 'interaction',
      interactionId: interaction.interaction_id,
      signalKind: signal.signalKind,
      payloadDigest: signal.payloadDigest,
      signalIdempotencyKey: signal.signalIdempotencyKey,
      recipeId: interaction.recipe_id,
      recipeVersion: interaction.recipe_version,
      scopeKind: 'session',
      scopeReference: sessionId,
      transcriptVersion: 'raw',
      inputWatermark: Number(watermark.throughEventOrder),
      interactionInputDigest: interaction.input_digest,
      promptDigest: interaction.prompt_digest,
      resultDigest: interaction.result_digest,
      sessionId,
      startedAt: Number(session.started_at),
      endedAt: Number(session.ended_at)
    }
  }

  prepareInteractionIngestRequest (request) {
    return this.prepareInteractionIngest(this.deriveInteractionSignalSource(request))
  }

  applyAutomaticTaskPolicy (request) {
    const policy = automaticTaskPolicy(request)
    const now = this.nowValue()
    const allowed = automaticTaskPolicyAllows(policy)
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      let queuedCancelled = 0
      let runningCancellationRequested = 0
      if (!allowed) {
        const queued = database.prepare(`
          SELECT run_id FROM formal_agent_runs
          WHERE requested_by = 'automatic' AND recipe_id IN ('context.ingest.session', 'context.ingest.interaction')
            AND state IN ('queued', 'retry_wait')
        `).all()
        for (const row of queued) {
          const changed = database.prepare(`
            UPDATE formal_agent_runs
            SET state = 'cancelled', cancel_requested_at = COALESCE(cancel_requested_at, ?),
              lease_owner = NULL, lease_expires_at = NULL,
              lease_renewed_from_expires_at = NULL, error_code = NULL, updated_at = ?
            WHERE run_id = ? AND state IN ('queued', 'retry_wait')
          `).run(now, now, row.run_id)
          queuedCancelled += Number(changed.changes)
          if (Number(changed.changes) === 1) {
            const recipe = database.prepare('SELECT recipe_id FROM formal_agent_runs WHERE run_id=?').get(row.run_id)?.recipe_id
            this.removeIngestSkeleton(row.run_id, recipe === 'context.ingest.interaction' ? 'interaction' : 'session')
          }
        }
        const running = database.prepare(`
          UPDATE formal_agent_runs
          SET cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ?
          WHERE requested_by = 'automatic' AND recipe_id IN ('context.ingest.session', 'context.ingest.interaction')
            AND state = 'running' AND cancel_requested_at IS NULL
        `).run(now, now)
        runningCancellationRequested = Number(running.changes)
      }
      database.exec('COMMIT')
      this.automaticPolicy = policy
      return { queuedCancelled, runningCancellationRequested }
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }

  cancelSessionIngest (request) {
    assertExactKeys(request, ['runId'], 'AGENT_REQUEST_INVALID')
    identifier(request.runId)
    const database = this.database
    const existing = database.prepare(`
      SELECT run_id, recipe_id, requested_by, state FROM formal_agent_runs WHERE run_id = ?
    `).get(request.runId)
    if (!existing || !['context.ingest.session', 'context.ingest.interaction'].includes(existing.recipe_id) || existing.requested_by !== 'automatic') {
      fail('AGENT_RUN_NOT_FOUND')
    }
    if (existing.state === 'cancelled') return { runId: request.runId, state: 'cancelled', replayed: true }
    if (!['queued', 'retry_wait'].includes(existing.state)) {
      if (existing.state === 'running') {
        const now = this.nowValue()
        database.prepare(`
          UPDATE formal_agent_runs
          SET cancel_requested_at = COALESCE(cancel_requested_at, ?), updated_at = ?
          WHERE run_id = ? AND state = 'running'
        `).run(now, now, request.runId)
        return { runId: request.runId, state: 'running', cancellationRequested: true, replayed: false }
      }
      fail('AGENT_CONTEXT_OPERATION_FAILED')
    }
    const now = this.nowValue()
    database.exec('BEGIN IMMEDIATE')
    try {
      const changed = database.prepare(`
        UPDATE formal_agent_runs
        SET state = 'cancelled', cancel_requested_at = COALESCE(cancel_requested_at, ?),
          lease_owner = NULL, lease_expires_at = NULL,
          lease_renewed_from_expires_at = NULL, error_code = NULL, updated_at = ?
        WHERE run_id = ? AND state IN ('queued', 'retry_wait')
      `).run(now, now, request.runId)
      if (Number(changed.changes) !== 1) {
        const current = database.prepare('SELECT state FROM formal_agent_runs WHERE run_id = ?').get(request.runId)
        if (current?.state === 'cancelled') {
          database.exec('COMMIT')
          return { runId: request.runId, state: 'cancelled', replayed: true }
        }
        fail('AGENT_CONTEXT_OPERATION_FAILED')
      }
      this.removeIngestSkeleton(request.runId, existing.recipe_id === 'context.ingest.interaction' ? 'interaction' : 'session')
      database.exec('COMMIT')
      return { runId: request.runId, state: 'cancelled', replayed: false }
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }

  cancelInteractionIngest (request) {
    return this.cancelSessionIngest(request)
  }

  removeSessionIngestSkeleton (runId) {
    const episodes = this.database.prepare(`
      SELECT episode_id, scope_id FROM personal_context_episodes
      WHERE ingest_run_id = ? AND source_kind = 'session'
    `).all(runId)
    for (const episode of episodes) {
      this.database.prepare('DELETE FROM personal_context_episodes WHERE episode_id = ?').run(episode.episode_id)
      this.database.prepare(`
        DELETE FROM personal_context_scopes
        WHERE scope_id = ? AND kind = 'session' AND origin = 'automatic'
          AND NOT EXISTS (SELECT 1 FROM personal_context_episodes WHERE scope_id = ?)
          AND NOT EXISTS (SELECT 1 FROM personal_context_items WHERE scope_id = ?)
      `).run(episode.scope_id, episode.scope_id, episode.scope_id)
    }
  }

  removeInteractionIngestSkeleton (runId) {
    const episodes = this.database.prepare(`
      SELECT episode_id, scope_id FROM personal_context_episodes
      WHERE ingest_run_id = ? AND source_kind = 'interaction'
    `).all(runId)
    for (const episode of episodes) {
      this.database.prepare('DELETE FROM personal_context_episodes WHERE episode_id = ?').run(episode.episode_id)
      this.database.prepare(`
        DELETE FROM personal_context_scopes
        WHERE scope_id = ? AND kind = 'session' AND origin = 'automatic'
          AND NOT EXISTS (SELECT 1 FROM personal_context_episodes WHERE scope_id = ?)
          AND NOT EXISTS (SELECT 1 FROM personal_context_items WHERE scope_id = ?)
      `).run(episode.scope_id, episode.scope_id, episode.scope_id)
    }
  }

  removeIngestSkeleton (runId, sourceKind) {
    if (sourceKind === 'interaction') return this.removeInteractionIngestSkeleton(runId)
    return this.removeSessionIngestSkeleton(runId)
  }

  prepareInteractionIngest (source) {
    if (!isPlainObject(source) || source.sourceKind !== 'interaction') fail('AGENT_REQUEST_INVALID')
    const normalized = this.deriveInteractionSignalSource({
      interactionId: source.interactionId,
      signalKind: source.signalKind,
      payloadDigest: source.payloadDigest || null,
      signalIdempotencyKey: source.signalIdempotencyKey
    })
    const priorKeys = this.database.prepare(`
      SELECT interaction_id, summary_json
      FROM personal_context_episodes
      WHERE source_kind = 'interaction' AND json_extract(summary_json, '$.signalIdempotencyKey') = ?
    `).all(normalized.signalIdempotencyKey)
    for (const row of priorKeys) {
      let priorSummary
      try { priorSummary = JSON.parse(row.summary_json) } catch { fail('STORAGE_COMMAND_FAILED') }
      if (!isPlainObject(priorSummary) ||
          priorSummary.interactionId !== normalized.interactionId ||
          priorSummary.signalKind !== normalized.signalKind ||
          priorSummary.payloadDigest !== normalized.payloadDigest ||
          priorSummary.promptDigest !== normalized.promptDigest ||
          priorSummary.resultDigest !== normalized.resultDigest ||
          priorSummary.interactionInputDigest !== normalized.interactionInputDigest) {
        fail('AGENT_REQUEST_INVALID')
      }
    }
    const identity = {
      recipeId: 'context.ingest.interaction', sourceKind: 'interaction',
      interactionId: normalized.interactionId, signalKind: normalized.signalKind,
      payloadDigest: normalized.payloadDigest,
      signalIdempotencyKey: normalized.signalIdempotencyKey,
      recipeSourceId: normalized.recipeId, recipeVersion: normalized.recipeVersion,
      scopeKind: normalized.scopeKind, scopeReference: normalized.scopeReference,
      transcriptVersion: normalized.transcriptVersion,
      inputWatermark: normalized.inputWatermark,
      interactionInputDigest: normalized.interactionInputDigest,
      promptDigest: normalized.promptDigest, resultDigest: normalized.resultDigest
    }
    const dedupeKey = sha256Canonical(identity)
    const requestDigest = sha256Canonical({ identity })
    const runId = `run.${dedupeKey.slice(0, 48)}`
    const episodeId = `episode.${dedupeKey.slice(0, 44)}`
    const scopeId = `scope.${sha256Canonical({ kind: 'session', reference: normalized.scopeReference }).slice(0, 48)}`
    const existing = this.database.prepare('SELECT * FROM formal_agent_runs WHERE dedupe_key=?').get(dedupeKey)
    const existingEpisode = this.database.prepare(`
      SELECT * FROM personal_context_episodes
      WHERE source_kind='interaction' AND interaction_id=? AND input_digest=?
    `).get(normalized.interactionId, dedupeKey)
    if (existing) {
      if (existing.request_digest !== requestDigest || existing.recipe_id !== 'context.ingest.interaction') fail('AGENT_REQUEST_INVALID')
      if (existingEpisode) {
        return {
          runId: existing.run_id, recipeId: existing.recipe_id, recipeVersion: existing.recipe_version,
          episodeId: existingEpisode.episode_id, state: existing.state,
          source: normalized, replayed: true
        }
      }
      if (!['queued', 'running', 'retry_wait'].includes(existing.state)) fail('AGENT_CONTEXT_OPERATION_FAILED')
    }
    const now = this.nowValue()
    const episodeSummary = {
      title: 'Interaction experience',
      bullets: [`Signal: ${normalized.signalKind}`],
      omissions: [], signalKind: normalized.signalKind,
      interactionId: normalized.interactionId,
      recipeId: normalized.recipeId, recipeVersion: normalized.recipeVersion,
      interactionInputDigest: normalized.interactionInputDigest,
      promptDigest: normalized.promptDigest, resultDigest: normalized.resultDigest,
      payloadDigest: normalized.payloadDigest, signalIdempotencyKey: normalized.signalIdempotencyKey,
      inputWatermark: normalized.inputWatermark,
      scopeKind: normalized.scopeKind, scopeReference: normalized.scopeReference
    }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`
        INSERT OR IGNORE INTO personal_context_scopes(
          scope_id, kind, canonical_key, label, session_id, origin, lifecycle, created_at, updated_at
        ) VALUES (?, 'session', ?, 'Session', ?, 'automatic', 'active', ?, ?)
      `).run(scopeId, `session:${normalized.scopeReference}`, normalized.scopeReference, now, now)
      if (!existing) {
        const personalContextRevision = this.contentRevision()
        this.database.prepare(`
          INSERT INTO formal_agent_runs(
            run_id, dedupe_key, client_idempotency_key, request_digest, recipe_id, recipe_version,
            scope_json, scope_digest, transcript_version, input_watermark_json, input_digest,
            personal_context_revision, requested_by, state, attempt_count, max_attempts, next_attempt_at,
            lease_owner, lease_expires_at, lease_renewed_from_expires_at, cancel_requested_at,
            error_code, result_digest, result_summary_json, created_at, updated_at
          ) VALUES (?, ?, NULL, ?, 'context.ingest.interaction', '1', ?, ?, ?, ?, ?, ?,
            'automatic', 'queued', 0, 3, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
        `).run(
          runId, dedupeKey, requestDigest,
          canonicalize({ kind: 'interaction', reference: normalized.interactionId }),
          sha256Canonical({ kind: 'interaction', reference: normalized.interactionId }), normalized.transcriptVersion,
          canonicalize({ throughEventOrder: normalized.inputWatermark }), dedupeKey,
          personalContextRevision, now, now, now
        )
      }
      this.database.prepare(`
        INSERT OR IGNORE INTO personal_context_episodes(
          episode_id, source_kind, session_id, interaction_id, scope_id, transcript_version,
          input_watermark, from_event_order, through_event_order, input_digest, summary_json,
          occurred_from_offset_ms, occurred_through_offset_ms, ingest_run_id, lifecycle,
          created_at, updated_at
        ) VALUES (?, 'interaction', NULL, ?, ?, ?, ?, 1, ?, ?, ?, 0, ?, ?, 'active', ?, ?)
      `).run(
        episodeId, normalized.interactionId, scopeId, normalized.transcriptVersion,
        normalized.inputWatermark, normalized.inputWatermark, dedupeKey, canonicalize(episodeSummary),
        Math.max(0, normalized.endedAt - normalized.startedAt), existing?.run_id || runId, now, now
      )
      this.database.exec('COMMIT')
      const row = this.database.prepare('SELECT * FROM formal_agent_runs WHERE dedupe_key=?').get(dedupeKey)
      return {
        runId: row.run_id, recipeId: row.recipe_id, recipeVersion: row.recipe_version,
        episodeId, state: row.state, source: normalized, replayed: false
      }
    } catch (error) {
      rollbackQuietly(this.database)
      throw error
    }
  }

  prepareSessionIngest (source) {
    const snapshot = this.sessionSnapshot(source, { allowRefinedFallback: true })
    const identity = {
      recipeId: 'context.ingest.session', sourceKind: 'session',
      sessionId: snapshot.sessionId, transcriptVersion: snapshot.transcriptVersion,
      inputWatermark: snapshot.inputWatermark, inputDigest: snapshot.inputDigest
    }
    const dedupeKey = sha256Canonical(identity)
    const requestDigest = sha256Canonical({ identity })
    const runId = `run.${dedupeKey.slice(0, 48)}`
    const episodeId = `episode.${dedupeKey.slice(0, 44)}`
    const scopeId = `scope.${sha256Canonical({ kind: 'session', reference: snapshot.sessionId }).slice(0, 48)}`
    const existing = this.database.prepare('SELECT * FROM formal_agent_runs WHERE dedupe_key=?').get(dedupeKey)
    const existingEpisode = this.database.prepare(`
      SELECT * FROM personal_context_episodes WHERE source_kind='session' AND session_id=? AND input_digest=?
    `).get(snapshot.sessionId, snapshot.inputDigest)
    if (existing) {
      if (existing.request_digest !== requestDigest || existing.recipe_id !== 'context.ingest.session') fail('AGENT_REQUEST_INVALID')
      if (existingEpisode) {
        return {
          runId: existing.run_id, recipeId: existing.recipe_id, recipeVersion: existing.recipe_version,
          episodeId: existingEpisode.episode_id, state: existing.state, source: snapshot, replayed: true
        }
      }
      if (!['queued', 'running', 'retry_wait'].includes(existing.state)) fail('AGENT_CONTEXT_OPERATION_FAILED')
    }
    const now = this.nowValue()
    const episodeSummary = { title: 'Session experience', bullets: [`Segments: ${snapshot.segmentCount}`], omissions: [] }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`
        INSERT OR IGNORE INTO personal_context_scopes(
          scope_id, kind, canonical_key, label, session_id, origin, lifecycle, created_at, updated_at
        ) VALUES (?, 'session', ?, 'Session', ?, 'automatic', 'active', ?, ?)
      `).run(scopeId, `session:${snapshot.sessionId}`, snapshot.sessionId, now, now)
      if (!existing) {
        const personalContextRevision = this.contentRevision()
        this.database.prepare(`
          INSERT INTO formal_agent_runs(
            run_id, dedupe_key, client_idempotency_key, request_digest, recipe_id, recipe_version,
            scope_json, scope_digest, transcript_version, input_watermark_json, input_digest,
            personal_context_revision, requested_by, state, attempt_count, max_attempts, next_attempt_at,
            lease_owner, lease_expires_at, lease_renewed_from_expires_at, cancel_requested_at,
            error_code, result_digest, result_summary_json, created_at, updated_at
          ) VALUES (?, ?, NULL, ?, 'context.ingest.session', '1', ?, ?, ?, ?, ?, ?,
            'automatic', 'queued', 0, 3, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
        `).run(
          runId, dedupeKey, requestDigest, canonicalize({ kind: 'session', reference: snapshot.sessionId }),
          sha256Canonical({ kind: 'session', reference: snapshot.sessionId }), snapshot.transcriptVersion,
          canonicalize({ throughEventOrder: snapshot.inputWatermark }), snapshot.inputDigest,
          personalContextRevision, now, now, now
        )
      }
      this.database.prepare(`
        INSERT OR IGNORE INTO personal_context_episodes(
          episode_id, source_kind, session_id, interaction_id, scope_id, transcript_version,
          input_watermark, from_event_order, through_event_order, input_digest, summary_json,
          occurred_from_offset_ms, occurred_through_offset_ms, ingest_run_id, lifecycle,
          created_at, updated_at
        ) VALUES (?, 'session', ?, NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'active', ?, ?)
      `).run(
        episodeId, snapshot.sessionId, scopeId, snapshot.transcriptVersion,
        snapshot.inputWatermark, snapshot.fromEventOrder, snapshot.throughEventOrder,
        snapshot.inputDigest, canonicalize(episodeSummary), Math.max(0, snapshot.endedAt - snapshot.startedAt),
        existing?.run_id || runId, now, now
      )
      this.database.exec('COMMIT')
      const row = this.database.prepare('SELECT * FROM formal_agent_runs WHERE dedupe_key=?').get(dedupeKey)
      return {
        runId: row.run_id, recipeId: row.recipe_id, recipeVersion: row.recipe_version,
        episodeId, state: row.state, source: snapshot, replayed: false
      }
    } catch (error) {
      rollbackQuietly(this.database)
      throw error
    }
  }

  ingestAttempt (value) {
    assertExactKeys(value, ['runId', 'attempt', 'owner', 'leaseExpiresAt'], 'AGENT_REQUEST_INVALID')
    identifier(value.runId)
    safeInteger(value.attempt, 1)
    identifier(value.owner)
    safeInteger(value.leaseExpiresAt, 0)
    return value
  }

  ingestScope (candidate, sessionId, now) {
    if (!['global', 'session', 'topic', 'project'].includes(candidate.scopeKind)) fail('AGENT_OUTPUT_INVALID')
    if (candidate.scopeKind === 'session') {
      if (candidate.scopeKeyProposal !== null && candidate.scopeKeyProposal !== sessionId) fail('AGENT_OUTPUT_INVALID')
      const scope = this.database.prepare(`
        SELECT * FROM personal_context_scopes
        WHERE kind='session' AND canonical_key=? AND session_id=? AND origin='automatic' AND lifecycle='active'
      `).get(`session:${sessionId}`, sessionId)
      if (!scope) fail('AGENT_OUTPUT_INVALID')
      return scope
    }
    if (candidate.scopeKind === 'global') {
      if (candidate.scopeKeyProposal !== null) fail('AGENT_OUTPUT_INVALID')
      const scopeId = this.scopeIdentity({ scopeKind: 'global', scopeReference: null }, now)
      return this.database.prepare('SELECT * FROM personal_context_scopes WHERE scope_id=?').get(scopeId)
    }
    if (candidate.scopeKeyProposal === null) fail('AGENT_OUTPUT_INVALID')
    const canonicalKey = `${candidate.scopeKind}:${candidate.scopeKeyProposal}`
    const scopeId = `scope.${sha256Canonical({ kind: candidate.scopeKind, canonicalKey }).slice(0, 48)}`
    this.database.prepare(`
      INSERT OR IGNORE INTO personal_context_scopes(
        scope_id, kind, canonical_key, label, session_id, origin, lifecycle, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, 'automatic', 'active', ?, ?)
    `).run(scopeId, candidate.scopeKind, canonicalKey, candidate.scopeKeyProposal, now, now)
    return this.database.prepare('SELECT * FROM personal_context_scopes WHERE scope_id=?').get(scopeId)
  }

  commitSessionIngest (input) {
    assertExactKeys(input, ['runId', 'attemptIdentity', 'output'], 'AGENT_REQUEST_INVALID')
    const attempt = this.ingestAttempt(input.attemptIdentity)
    identifier(input.runId)
    if (attempt.runId !== input.runId) fail('AGENT_REQUEST_INVALID')
    try { validateRecipeOutput('context.ingest.session', '1', input.output) } catch { fail('AGENT_OUTPUT_INVALID') }
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      const run = database.prepare('SELECT * FROM formal_agent_runs WHERE run_id=?').get(input.runId)
      if (!run) fail('AGENT_CONTEXT_NOT_FOUND')
      const episode = database.prepare(`
        SELECT * FROM personal_context_episodes WHERE ingest_run_id=? AND source_kind='session'
      `).get(input.runId)
      if (!episode) fail('AGENT_CONTEXT_OPERATION_FAILED')
      if (run.state === 'succeeded') {
        database.exec('COMMIT')
        return { runId: input.runId, state: 'succeeded', replayed: true, episodeId: episode.episode_id }
      }
      if (run.state === 'cancelled' || run.state === 'failed') fail('AGENT_CONTEXT_OPERATION_FAILED')
      if (run.state !== 'running' || Number(run.attempt_count) !== attempt.attempt ||
          run.lease_owner !== attempt.owner || Number(run.lease_expires_at) !== attempt.leaseExpiresAt ||
          run.cancel_requested_at !== null) fail('AGENT_CONTEXT_OPERATION_FAILED')
      const snapshot = this.sessionSnapshot({
        sourceKind: 'session', sessionId: episode.session_id, transcriptVersion: episode.transcript_version,
        inputWatermark: Number(episode.input_watermark), inputDigest: episode.input_digest
      })
      const output = input.output
      const validRef = (ref) => ref.sessionId === snapshot.sessionId && ref.transcriptVersion === snapshot.transcriptVersion &&
        ref.fromEventOrder >= snapshot.fromEventOrder && ref.throughEventOrder <= snapshot.throughEventOrder
      for (const experience of output.experiences) {
        if (!validRef(experience.evidence)) fail('AGENT_OUTPUT_INVALID')
      }
      for (const candidate of output.memoryCandidates) {
        if (!validRef(candidate.evidence)) fail('AGENT_OUTPUT_INVALID')
      }
      const now = this.nowValue()
      let acceptedCandidateCount = 0
      let discardedCandidateCount = 0
      let revisionCount = 0
      let evidenceCount = 0
      const touched = new Set()
      for (const candidate of output.memoryCandidates) {
        if (candidate.salience === 'low' || (candidate.confidence === 'low' && candidate.kind !== 'preference')) {
          discardedCandidateCount += 1
          continue
        }
        const semanticKey = normalizeSemanticKey(candidate.content)
        const scope = this.ingestScope(candidate, snapshot.sessionId, now)
        if (!scope) fail('AGENT_OUTPUT_INVALID')
        const identityHash = sha256Canonical({ scopeId: scope.scope_id, kind: candidate.kind, semanticKey })
        if (database.prepare('SELECT 1 FROM personal_context_suppressions WHERE identity_hash=? AND source_digest=?').get(identityHash, snapshot.inputDigest)) {
          discardedCandidateCount += 1
          continue
        }
        const contentJson = canonicalize({ displayText: candidate.content })
        let memory = database.prepare('SELECT * FROM personal_context_items WHERE scope_id=? AND kind=? AND semantic_key=?').get(scope.scope_id, candidate.kind, semanticKey)
        if (memory && memory.origin === 'explicit' && memory.content_json !== contentJson) {
          discardedCandidateCount += 1
          continue
        }
        if (!memory) {
          const memoryId = `memory.${sha256Canonical({ scopeId: scope.scope_id, kind: candidate.kind, semanticKey }).slice(0, 44)}`
          database.prepare(`
            INSERT INTO personal_context_items(
              memory_id, scope_id, kind, semantic_key, content_json, origin,
              confidence_band, salience_band, lifecycle, current_revision_id,
              item_revision, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'inferred', ?, ?, 'active', NULL, 1, ?, ?)
          `).run(memoryId, scope.scope_id, candidate.kind, semanticKey, contentJson, candidate.confidence, candidate.salience, now, now)
          const revisionId = `revision.${sha256Canonical({ memoryId, itemRevision: 1 }).slice(0, 44)}`
          database.prepare(`
            INSERT INTO personal_context_revisions(
              revision_id, memory_id, operation, content_json, previous_revision_id, run_id, created_at
            ) VALUES (?, ?, 'create', ?, NULL, ?, ?)
          `).run(revisionId, memoryId, contentJson, input.runId, now)
          database.prepare('UPDATE personal_context_items SET current_revision_id=? WHERE memory_id=?').run(revisionId, memoryId)
          memory = database.prepare('SELECT * FROM personal_context_items WHERE memory_id=?').get(memoryId)
          revisionCount += 1
        } else if (memory.content_json !== contentJson) {
          const itemRevision = Number(memory.item_revision) + 1
          const revisionId = `revision.${sha256Canonical({ memoryId: memory.memory_id, itemRevision, contentJson }).slice(0, 44)}`
          database.prepare(`
            INSERT INTO personal_context_revisions(
              revision_id, memory_id, operation, content_json, previous_revision_id, run_id, created_at
            ) VALUES (?, ?, 'merge', ?, ?, ?, ?)
          `).run(revisionId, memory.memory_id, contentJson, memory.current_revision_id, input.runId, now)
          database.prepare(`
            UPDATE personal_context_items SET content_json=?, lifecycle='conflicted', current_revision_id=?,
              item_revision=?, updated_at=? WHERE memory_id=?
          `).run(contentJson, revisionId, itemRevision, now, memory.memory_id)
          memory = database.prepare('SELECT * FROM personal_context_items WHERE memory_id=?').get(memory.memory_id)
          revisionCount += 1
        }
        for (const ref of [candidate.evidence]) {
          const inserted = database.prepare(`
            INSERT INTO personal_context_evidence(
              evidence_id, ingest_run_id, memory_id, source_kind, session_id, interaction_id,
              transcript_version, input_watermark, from_event_order, through_event_order,
              input_digest, recipe_id, recipe_version, created_at
            ) VALUES (?, ?, ?, 'session', ?, NULL, ?, ?, ?, ?, ?, 'context.ingest.session', '1', ?)
            ON CONFLICT DO NOTHING
          `).run(
            `evidence.${sha256Canonical({ runId: input.runId, memoryId: memory.memory_id, ref }).slice(0, 44)}`,
            input.runId, memory.memory_id, snapshot.sessionId, snapshot.transcriptVersion,
            snapshot.inputWatermark, ref.fromEventOrder, ref.throughEventOrder, snapshot.inputDigest, now
          )
          evidenceCount += Number(inserted.changes)
        }
        acceptedCandidateCount += 1
        touched.add(memory.memory_id)
      }
      const bullets = output.experiences.slice(0, 8).map((experience) => experience.text)
      const summary = { title: 'Session experience', bullets: bullets.length > 0 ? bullets : [`Segments: ${snapshot.segmentCount}`], omissions: [] }
      database.prepare('UPDATE personal_context_episodes SET summary_json=?, updated_at=? WHERE episode_id=?').run(canonicalize(summary), now, episode.episode_id)
      const result = { acceptedCandidateCount, discardedCandidateCount, memoryItemCount: touched.size, evidenceCount, revisionCount }
      if (acceptedCandidateCount > 0 || bullets.length > 0) this.advanceRevision({ operation: 'ingest', runId: input.runId, episodeId: episode.episode_id })
      database.exec('COMMIT')
      return { runId: input.runId, state: 'committed', replayed: false, episodeId: episode.episode_id, ...result }
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }

  commitInteractionIngest (input) {
    assertExactKeys(input, ['runId', 'attemptIdentity', 'output'], 'AGENT_REQUEST_INVALID')
    const attempt = this.ingestAttempt(input.attemptIdentity)
    identifier(input.runId)
    if (attempt.runId !== input.runId) fail('AGENT_REQUEST_INVALID')
    try { validateRecipeOutput('context.ingest.interaction', '1', input.output) } catch { fail('AGENT_OUTPUT_INVALID') }
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      const run = database.prepare('SELECT * FROM formal_agent_runs WHERE run_id=?').get(input.runId)
      if (!run || run.recipe_id !== 'context.ingest.interaction') fail('AGENT_CONTEXT_NOT_FOUND')
      const episode = database.prepare(`
        SELECT * FROM personal_context_episodes WHERE ingest_run_id=? AND source_kind='interaction'
      `).get(input.runId)
      if (!episode) fail('AGENT_CONTEXT_OPERATION_FAILED')
      if (run.state === 'succeeded') {
        database.exec('COMMIT')
        return { runId: input.runId, state: 'succeeded', replayed: true, episodeId: episode.episode_id }
      }
      if (run.state === 'cancelled' || run.state === 'failed') fail('AGENT_CONTEXT_OPERATION_FAILED')
      if (run.state !== 'running' || Number(run.attempt_count) !== attempt.attempt ||
          run.lease_owner !== attempt.owner || Number(run.lease_expires_at) !== attempt.leaseExpiresAt ||
          run.cancel_requested_at !== null) fail('AGENT_CONTEXT_OPERATION_FAILED')
      let storedSummary
      try { storedSummary = JSON.parse(episode.summary_json) } catch { fail('STORAGE_COMMAND_FAILED') }
      const signalRef = { interactionId: episode.interaction_id, signalKind: storedSummary.signalKind }
      const validRef = (ref) => ref.interactionId === signalRef.interactionId && ref.signalKind === signalRef.signalKind
      const output = input.output
      for (const experience of output.experiences) if (!validRef(experience.evidence)) fail('AGENT_OUTPUT_INVALID')
      for (const candidate of output.memoryCandidates) if (!validRef(candidate.evidence)) fail('AGENT_OUTPUT_INVALID')
      const scope = database.prepare(`
        SELECT scope_id, session_id FROM personal_context_scopes WHERE scope_id = ? AND kind='session'
          AND origin='automatic' AND lifecycle='active'
      `).get(episode.scope_id)
      if (!scope || typeof scope.session_id !== 'string') fail('AGENT_OUTPUT_INVALID')
      const now = this.nowValue()
      let acceptedCandidateCount = 0
      let discardedCandidateCount = 0
      let revisionCount = 0
      let evidenceCount = 0
      const touched = new Set()
      for (const candidate of output.memoryCandidates) {
        if (candidate.salience === 'low' || (candidate.confidence === 'low' && candidate.kind !== 'preference')) {
          discardedCandidateCount += 1
          continue
        }
        const semanticKey = normalizeSemanticKey(candidate.content)
        const targetScope = this.ingestScope(candidate, scope.session_id, now)
        if (!targetScope) fail('AGENT_OUTPUT_INVALID')
        const identityHash = sha256Canonical({ scopeId: targetScope.scope_id, kind: candidate.kind, semanticKey })
        if (database.prepare('SELECT 1 FROM personal_context_suppressions WHERE identity_hash=? AND source_digest=?').get(identityHash, episode.input_digest)) {
          discardedCandidateCount += 1
          continue
        }
        const contentJson = canonicalize({ displayText: candidate.content })
        let memory = database.prepare('SELECT * FROM personal_context_items WHERE scope_id=? AND kind=? AND semantic_key=?').get(targetScope.scope_id, candidate.kind, semanticKey)
        if (memory && memory.origin === 'explicit' && memory.content_json !== contentJson) {
          discardedCandidateCount += 1
          continue
        }
        if (!memory) {
          const memoryId = `memory.${sha256Canonical({ scopeId: targetScope.scope_id, kind: candidate.kind, semanticKey }).slice(0, 44)}`
          database.prepare(`
            INSERT INTO personal_context_items(
              memory_id, scope_id, kind, semantic_key, content_json, origin,
              confidence_band, salience_band, lifecycle, current_revision_id,
              item_revision, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'inferred', ?, ?, 'active', NULL, 1, ?, ?)
          `).run(memoryId, targetScope.scope_id, candidate.kind, semanticKey, contentJson, candidate.confidence, candidate.salience, now, now)
          const revisionId = `revision.${sha256Canonical({ memoryId, itemRevision: 1 }).slice(0, 44)}`
          database.prepare(`
            INSERT INTO personal_context_revisions(
              revision_id, memory_id, operation, content_json, previous_revision_id, run_id, created_at
            ) VALUES (?, ?, 'create', ?, NULL, ?, ?)
          `).run(revisionId, memoryId, contentJson, input.runId, now)
          database.prepare('UPDATE personal_context_items SET current_revision_id=? WHERE memory_id=?').run(revisionId, memoryId)
          memory = database.prepare('SELECT * FROM personal_context_items WHERE memory_id=?').get(memoryId)
          revisionCount += 1
        } else if (memory.content_json !== contentJson) {
          const itemRevision = Number(memory.item_revision) + 1
          const revisionId = `revision.${sha256Canonical({ memoryId: memory.memory_id, itemRevision, contentJson }).slice(0, 44)}`
          database.prepare(`
            INSERT INTO personal_context_revisions(
              revision_id, memory_id, operation, content_json, previous_revision_id, run_id, created_at
            ) VALUES (?, ?, 'merge', ?, ?, ?, ?)
          `).run(revisionId, memory.memory_id, contentJson, memory.current_revision_id, input.runId, now)
          database.prepare(`
            UPDATE personal_context_items SET content_json=?, lifecycle='conflicted', current_revision_id=?,
              item_revision=?, updated_at=? WHERE memory_id=?
          `).run(contentJson, revisionId, itemRevision, now, memory.memory_id)
          memory = database.prepare('SELECT * FROM personal_context_items WHERE memory_id=?').get(memory.memory_id)
          revisionCount += 1
        }
        const inserted = database.prepare(`
          INSERT INTO personal_context_evidence(
            evidence_id, ingest_run_id, memory_id, source_kind, session_id, interaction_id,
            transcript_version, input_watermark, from_event_order, through_event_order,
            input_digest, recipe_id, recipe_version, created_at
          ) VALUES (?, ?, ?, 'interaction', NULL, ?, ?, ?, 1, ?, ?, 'context.ingest.interaction', '1', ?)
          ON CONFLICT DO NOTHING
        `).run(
          `evidence.${sha256Canonical({ runId: input.runId, memoryId: memory.memory_id, signalRef }).slice(0, 44)}`,
          input.runId, memory.memory_id, episode.interaction_id, episode.transcript_version,
          Number(episode.input_watermark), Number(episode.through_event_order), episode.input_digest, now
        )
        evidenceCount += Number(inserted.changes)
        acceptedCandidateCount += 1
        touched.add(memory.memory_id)
      }
      const bullets = output.experiences.slice(0, 8).map((experience) => experience.text)
      const summary = {
        ...storedSummary,
        title: 'Interaction experience',
        bullets: bullets.length > 0 ? bullets : [`Signal: ${storedSummary.signalKind}`],
        omissions: []
      }
      database.prepare('UPDATE personal_context_episodes SET summary_json=?, updated_at=? WHERE episode_id=?').run(canonicalize(summary), now, episode.episode_id)
      const result = { acceptedCandidateCount, discardedCandidateCount, memoryItemCount: touched.size, evidenceCount, revisionCount }
      if (acceptedCandidateCount > 0 || bullets.length > 0) this.advanceRevision({ operation: 'interaction-ingest', runId: input.runId, episodeId: episode.episode_id })
      database.exec('COMMIT')
      return { runId: input.runId, state: 'committed', replayed: false, episodeId: episode.episode_id, ...result }
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }

  ingest (source) {
    if (source?.sourceKind === 'interaction') return this.ingestInteraction(source)
    const snapshot = this.sessionSnapshot(source)
    const identity = {
      recipeId: 'context.ingest.session',
      sourceKind: 'session',
      sessionId: snapshot.sessionId,
      transcriptVersion: snapshot.transcriptVersion,
      inputWatermark: snapshot.inputWatermark,
      inputDigest: snapshot.inputDigest
    }
    const dedupeKey = sha256Canonical(identity)
    const requestDigest = sha256Canonical({ identity })
    const existing = this.database.prepare(`
      SELECT run_id, request_digest, state FROM formal_agent_runs WHERE dedupe_key = ?
    `).get(dedupeKey)
    if (existing) {
      if (existing.request_digest !== requestDigest) fail('AGENT_REQUEST_INVALID')
      const episode = this.database.prepare(`
        SELECT episode_id FROM personal_context_episodes
        WHERE source_kind = 'session' AND session_id = ? AND input_digest = ?
      `).get(snapshot.sessionId, snapshot.inputDigest)
      if (episode) {
        return { runId: existing.run_id, replayed: true, episodeCount: 1, memoryCount: 0, revision: this.contentRevision() }
      }
      if (!['queued', 'running', 'retry_wait'].includes(existing.state)) fail('AGENT_CONTEXT_OPERATION_FAILED')
    }

    const runId = `run.${dedupeKey.slice(0, 48)}`
    const scopeId = `scope.${sha256Canonical({ kind: 'session', reference: snapshot.sessionId }).slice(0, 48)}`
    const episodeId = `episode.${dedupeKey.slice(0, 44)}`
    const now = this.nowValue()
    const resultSummary = { episodeCount: 1, memoryCount: 0 }
    const episodeSummary = {
      title: 'Session experience',
      bullets: [`Segments: ${snapshot.segmentCount}`],
      omissions: []
    }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const personalContextRevision = this.contentRevision()
      this.database.prepare(`
        INSERT OR IGNORE INTO personal_context_scopes(
          scope_id, kind, canonical_key, label, session_id, origin, lifecycle, created_at, updated_at
        ) VALUES (?, 'session', ?, 'Session', ?, 'automatic', 'active', ?, ?)
      `).run(scopeId, `session:${snapshot.sessionId}`, snapshot.sessionId, now, now)
      if (!existing) this.database.prepare(`
        INSERT INTO formal_agent_runs(
          run_id, dedupe_key, client_idempotency_key, request_digest, recipe_id, recipe_version,
          scope_json, scope_digest, transcript_version, input_watermark_json, input_digest,
          personal_context_revision, requested_by, state, attempt_count, max_attempts, next_attempt_at,
          lease_owner, lease_expires_at, lease_renewed_from_expires_at, cancel_requested_at,
          error_code, result_digest, result_summary_json, created_at, updated_at
        ) VALUES (?, ?, NULL, ?, 'context.ingest.session', '1', ?, ?, ?, ?, ?, ?,
          'automatic', 'succeeded', 1, 3, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)
      `).run(
        runId, dedupeKey, requestDigest,
        canonicalize({ kind: 'session', reference: snapshot.sessionId }),
        sha256Canonical({ kind: 'session', reference: snapshot.sessionId }),
        snapshot.transcriptVersion,
        canonicalize({ throughEventOrder: snapshot.inputWatermark }),
        snapshot.inputDigest, personalContextRevision,
        sha256Canonical(resultSummary), canonicalize(resultSummary), now, now
      )
      this.database.prepare(`
        INSERT INTO personal_context_episodes(
          episode_id, source_kind, session_id, interaction_id, scope_id, transcript_version,
          input_watermark, from_event_order, through_event_order, input_digest, summary_json,
          occurred_from_offset_ms, occurred_through_offset_ms, ingest_run_id, lifecycle,
          created_at, updated_at
        ) VALUES (?, 'session', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
      `).run(
        episodeId, snapshot.sessionId, scopeId, snapshot.transcriptVersion,
        snapshot.inputWatermark, snapshot.fromEventOrder, snapshot.throughEventOrder,
        snapshot.inputDigest, canonicalize(episodeSummary), 0,
        Math.max(0, snapshot.endedAt - snapshot.startedAt), runId, now, now
      )
      const revision = this.advanceRevision({ operation: 'ingest', runId, episodeId })
      this.database.exec('COMMIT')
      return { runId, replayed: false, episodeCount: 1, memoryCount: 0, revision }
    } catch (error) {
      rollbackQuietly(this.database)
      throw error
    }
  }

  ingestInteraction (source) {
    const prepared = this.prepareInteractionIngest(source)
    if (prepared.replayed) {
      return { runId: prepared.runId, replayed: true, episodeCount: 1, memoryCount: 0, revision: this.contentRevision() }
    }
    const now = this.nowValue()
    const summary = { episodeCount: 1, memoryCount: 0 }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const run = this.database.prepare('SELECT state FROM formal_agent_runs WHERE run_id=?').get(prepared.runId)
      if (!run || !['queued', 'running', 'retry_wait'].includes(run.state)) fail('AGENT_CONTEXT_OPERATION_FAILED')
      this.database.prepare(`
        UPDATE formal_agent_runs
        SET state='succeeded', attempt_count=CASE WHEN attempt_count < 1 THEN 1 ELSE attempt_count END,
          next_attempt_at=0, lease_owner=NULL, lease_expires_at=NULL,
          error_code=NULL, result_digest=?, result_summary_json=?, updated_at=?
        WHERE run_id=?
      `).run(sha256Canonical(summary), canonicalize(summary), now, prepared.runId)
      const revision = this.advanceRevision({ operation: 'interaction-ingest', runId: prepared.runId, episodeId: prepared.episodeId })
      this.database.exec('COMMIT')
      return { runId: prepared.runId, replayed: false, episodeCount: 1, memoryCount: 0, revision }
    } catch (error) {
      rollbackQuietly(this.database)
      throw error
    }
  }

  scopeIdentity (entry, now) {
    if (entry.scopeKind === 'global') {
      const scopeId = `scope.${sha256Canonical({ kind: 'global', reference: null }).slice(0, 48)}`
      this.database.prepare(`
        INSERT OR IGNORE INTO personal_context_scopes(
          scope_id, kind, canonical_key, label, session_id, origin, lifecycle, created_at, updated_at
        ) VALUES (?, 'global', 'global', 'Global', NULL, 'automatic', 'active', ?, ?)
      `).run(scopeId, now, now)
      return scopeId
    }
    const scope = this.database.prepare(`
      SELECT scope_id FROM personal_context_scopes
      WHERE kind = ? AND origin = 'automatic' AND lifecycle = 'active'
        AND (scope_id = ? OR session_id = ?)
    `).get(entry.scopeKind, entry.scopeReference, entry.scopeReference)
    if (!scope) fail('AGENT_REQUEST_INVALID')
    return scope.scope_id
  }

  assertRevision (expected) {
    safeInteger(expected)
    const current = this.contentRevision()
    if (expected !== current) fail('AGENT_CONTEXT_REVISION_CONFLICT')
    return current
  }

  memoryRow (memoryId) {
    return this.database.prepare(`
      SELECT item.*, scope.kind AS scope_kind, scope.label AS scope_label,
        CASE WHEN scope.kind = 'global' THEN NULL ELSE substr(scope.canonical_key, instr(scope.canonical_key, ':') + 1) END AS scope_reference,
        (SELECT COUNT(*) FROM personal_context_evidence AS evidence WHERE evidence.memory_id = item.memory_id) AS source_reference_count
      FROM personal_context_items AS item
      JOIN personal_context_scopes AS scope ON scope.scope_id = item.scope_id
      WHERE item.memory_id = ?
    `).get(memoryId)
  }

  manage (command) {
    if (!isPlainObject(command) || typeof command.type !== 'string') fail('AGENT_REQUEST_INVALID')
    if (command.type === 'view') return this.manageView(command)
    if (command.type === 'remember') return this.manageRemember(command)
    if (command.type === 'update') return this.manageUpdate(command)
    if (command.type === 'forget') return this.manageForget(command)
    if (command.type === 'delete') return this.manageDelete(command)
    if (command.type === 'set_processing') fail('AGENT_REQUEST_INVALID')
    fail('AGENT_REQUEST_INVALID')
  }

  manageView (command) {
    assertExactKeys(command, ['type', 'resource', 'limit', 'cursor'], 'AGENT_REQUEST_INVALID')
    if (!['personal_memories', 'session_episodes', 'scope_directory'].includes(command.resource)) fail('AGENT_REQUEST_INVALID')
    safeInteger(command.limit, 1)
    const maximum = command.resource === 'scope_directory' ? MAX_SCOPE_DIRECTORY_ITEMS : MAX_ITEMS
    if (command.limit > maximum) fail('AGENT_REQUEST_INVALID')
    const cursor = decodePageCursor(command.cursor, command.resource)
    if (command.resource === 'personal_memories') {
      if (cursor && !this.database.prepare(`
        SELECT 1 FROM personal_context_items WHERE memory_id = ? AND updated_at = ?
      `).get(cursor.id, cursor.updatedAt)) fail('AGENT_REQUEST_INVALID')
      const totalCount = Number(this.database.prepare('SELECT COUNT(*) AS count FROM personal_context_items').get().count)
      const rows = this.database.prepare(`
        SELECT item.*, scope.kind AS scope_kind, scope.label AS scope_label,
          CASE WHEN scope.kind = 'global' THEN NULL ELSE substr(scope.canonical_key, instr(scope.canonical_key, ':') + 1) END AS scope_reference,
          (SELECT COUNT(*) FROM personal_context_evidence AS evidence WHERE evidence.memory_id = item.memory_id) AS source_reference_count
        FROM personal_context_items AS item
        JOIN personal_context_scopes AS scope ON scope.scope_id = item.scope_id
        WHERE (? IS NULL OR item.updated_at < ? OR (item.updated_at = ? AND item.memory_id < ?))
        ORDER BY item.updated_at DESC, item.memory_id DESC LIMIT ?
      `).all(cursor?.id ?? null, cursor?.updatedAt ?? null, cursor?.updatedAt ?? null, cursor?.id ?? null, command.limit + 1)
      const hasMore = rows.length > command.limit
      const pageRows = rows.slice(0, command.limit)
      const last = pageRows.at(-1)
      return {
        revision: this.contentRevision(), totalCount, hasMore,
        nextCursor: hasMore ? encodePageCursor(command.resource, Number(last.updated_at), last.memory_id) : null,
        rows: pageRows.map(publicItem)
      }
    }
    if (command.resource === 'scope_directory') {
      if (cursor !== null) fail('AGENT_REQUEST_INVALID')
      const totalCount = Number(this.database.prepare(`
        SELECT COUNT(*) AS count FROM personal_context_scopes
        WHERE origin = 'automatic' AND lifecycle = 'active' AND kind <> 'global'
      `).get().count)
      const rows = this.database.prepare(`
        SELECT scope_id, kind, label, updated_at FROM personal_context_scopes
        WHERE origin = 'automatic' AND lifecycle = 'active' AND kind <> 'global'
        ORDER BY updated_at DESC, scope_id ASC LIMIT ?
      `).all(command.limit + 1)
      return {
        revision: this.contentRevision(), totalCount,
        hasMore: rows.length > command.limit, nextCursor: null,
        rows: rows.slice(0, command.limit).map((row) => ({
          displayName: row.label,
          kind: row.kind,
          scopeId: row.scope_id
        }))
      }
    }
    if (cursor && !this.database.prepare(`
      SELECT 1 FROM personal_context_episodes
      WHERE episode_id = ? AND updated_at = ? AND lifecycle = 'active'
    `).get(cursor.id, cursor.updatedAt)) fail('AGENT_REQUEST_INVALID')
    const totalCount = Number(this.database.prepare('SELECT COUNT(*) AS count FROM personal_context_episodes WHERE lifecycle = \'active\'').get().count)
    const rows = this.database.prepare(`
      SELECT episode.*, scope.kind AS scope_kind, scope.label AS scope_label,
        CASE WHEN scope.kind = 'global' THEN NULL ELSE substr(scope.canonical_key, instr(scope.canonical_key, ':') + 1) END AS scope_reference
      FROM personal_context_episodes AS episode
      JOIN personal_context_scopes AS scope ON scope.scope_id = episode.scope_id
      WHERE episode.lifecycle = 'active'
        AND (? IS NULL OR episode.updated_at < ? OR (episode.updated_at = ? AND episode.episode_id < ?))
      ORDER BY episode.updated_at DESC, episode.episode_id DESC LIMIT ?
    `).all(cursor?.id ?? null, cursor?.updatedAt ?? null, cursor?.updatedAt ?? null, cursor?.id ?? null, command.limit + 1)
    const hasMore = rows.length > command.limit
    const pageRows = rows.slice(0, command.limit).map((row) => {
      const stored = JSON.parse(row.summary_json)
      return {
        episode_id: row.episode_id,
        lifecycle: row.lifecycle,
        occurredFromOffsetMs: Number(row.occurred_from_offset_ms),
        occurredThroughOffsetMs: Number(row.occurred_through_offset_ms),
        omissions: Array.isArray(stored.omissions) ? stored.omissions : [],
        scope: {
          kind: row.scope_kind,
          label: row.scope_label,
          reference: row.scope_kind === 'global' ? null : row.scope_id
        },
        sourceKind: row.source_kind,
        sourceReferenceCount: 1,
        summary: { title: stored.title, bullets: stored.bullets },
        updatedAt: Number(row.updated_at)
      }
    })
    const last = rows.slice(0, command.limit).at(-1)
    return {
      revision: this.contentRevision(), totalCount, hasMore,
      nextCursor: hasMore ? encodePageCursor(command.resource, Number(last.updated_at), last.episode_id) : null,
      rows: pageRows
    }
  }

  manageRemember (command) {
    assertExactKeys(command, ['type', 'expected_revision', 'entry'], 'AGENT_REQUEST_INVALID')
    this.assertRevision(command.expected_revision)
    const entry = exactEntry(command.entry)
    const now = this.nowValue()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const scopeId = this.scopeIdentity(entry, now)
      const existing = this.database.prepare(`
        SELECT * FROM personal_context_items WHERE scope_id = ? AND kind = ? AND semantic_key = ?
      `).get(scopeId, entry.kind, entry.semanticKey)
      if (existing?.lifecycle === 'active') fail('AGENT_CONTEXT_OPERATION_FAILED')
      let memoryId
      let itemRevision
      let revisionId
      if (existing) {
        memoryId = existing.memory_id
        itemRevision = Number(existing.item_revision) + 1
        revisionId = `revision-${sha256Canonical({ memoryId, itemRevision, displayText: entry.displayText }).slice(0, 44)}`
        this.database.prepare(`
          INSERT INTO personal_context_revisions(
            revision_id, memory_id, operation, content_json, previous_revision_id, run_id, created_at
          ) VALUES (?, ?, 'restore', ?, ?, NULL, ?)
        `).run(revisionId, memoryId, canonicalize({ displayText: entry.displayText }), existing.current_revision_id, now)
        this.database.prepare(`
          UPDATE personal_context_items SET content_json = ?, origin = 'explicit', lifecycle = 'active',
            current_revision_id = ?, item_revision = ?, updated_at = ? WHERE memory_id = ?
        `).run(canonicalize({ displayText: entry.displayText }), revisionId, itemRevision, now, memoryId)
      } else {
        memoryId = `memory.${sha256Canonical({ scopeId, kind: entry.kind, semanticKey: entry.semanticKey }).slice(0, 44)}`
        itemRevision = 1
        revisionId = `revision-${sha256Canonical({ memoryId, itemRevision }).slice(0, 44)}`
        this.database.prepare(`
          INSERT INTO personal_context_items(
            memory_id, scope_id, kind, semantic_key, content_json, origin,
            confidence_band, salience_band, lifecycle, current_revision_id,
            item_revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'explicit', 'high', 'high', 'active', NULL, 1, ?, ?)
        `).run(memoryId, scopeId, entry.kind, entry.semanticKey, canonicalize({ displayText: entry.displayText }), now, now)
        this.database.prepare(`
          INSERT INTO personal_context_revisions(
            revision_id, memory_id, operation, content_json, previous_revision_id, run_id, created_at
          ) VALUES (?, ?, 'create', ?, NULL, NULL, ?)
        `).run(revisionId, memoryId, canonicalize({ displayText: entry.displayText }), now)
        this.database.prepare(`
          UPDATE personal_context_items SET current_revision_id = ? WHERE memory_id = ?
        `).run(revisionId, memoryId)
      }
      const revision = this.advanceRevision({ operation: 'remember', memoryId, itemRevision })
      const item = publicItem(this.memoryRow(memoryId))
      this.database.exec('COMMIT')
      return { revision, item }
    } catch (error) {
      rollbackQuietly(this.database)
      throw error
    }
  }

  manageUpdate (command) {
    assertExactKeys(command, ['type', 'expected_revision', 'item_id', 'item_revision', 'entry'], 'AGENT_REQUEST_INVALID')
    this.assertRevision(command.expected_revision)
    identifier(command.item_id)
    safeInteger(command.item_revision, 1)
    const entry = exactEntry(command.entry)
    const current = this.memoryRow(command.item_id)
    if (!current) fail('AGENT_CONTEXT_NOT_FOUND')
    if (Number(current.item_revision) !== command.item_revision) fail('AGENT_CONTEXT_REVISION_CONFLICT')
    const now = this.nowValue()
    const nextItemRevision = command.item_revision + 1
    const revisionId = `revision-${sha256Canonical({ memoryId: command.item_id, itemRevision: nextItemRevision, displayText: entry.displayText }).slice(0, 44)}`
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const scopeId = this.scopeIdentity(entry, now)
      const collision = this.database.prepare(`
        SELECT memory_id FROM personal_context_items
        WHERE scope_id = ? AND kind = ? AND semantic_key = ? AND memory_id <> ?
      `).get(scopeId, entry.kind, entry.semanticKey, command.item_id)
      if (collision) fail('AGENT_CONTEXT_REVISION_CONFLICT')
      this.database.prepare(`
        INSERT INTO personal_context_revisions(
          revision_id, memory_id, operation, content_json, previous_revision_id, run_id, created_at
        ) VALUES (?, ?, 'user-correct', ?, ?, NULL, ?)
      `).run(revisionId, command.item_id, canonicalize({ displayText: entry.displayText }), current.current_revision_id, now)
      this.database.prepare(`
        UPDATE personal_context_items SET scope_id = ?, kind = ?, semantic_key = ?, content_json = ?,
          origin = 'explicit', lifecycle = 'active', current_revision_id = ?, item_revision = ?, updated_at = ?
        WHERE memory_id = ?
      `).run(scopeId, entry.kind, entry.semanticKey, canonicalize({ displayText: entry.displayText }), revisionId, nextItemRevision, now, command.item_id)
      const revision = this.advanceRevision({ operation: 'update', memoryId: command.item_id, itemRevision: nextItemRevision })
      const item = publicItem(this.memoryRow(command.item_id))
      this.database.exec('COMMIT')
      return { revision, item }
    } catch (error) {
      rollbackQuietly(this.database)
      throw error
    }
  }

  manageForget (command) {
    assertExactKeys(command, ['type', 'expected_revision', 'item_id', 'item_revision'], 'AGENT_REQUEST_INVALID')
    this.assertRevision(command.expected_revision)
    identifier(command.item_id)
    safeInteger(command.item_revision, 1)
    const current = this.memoryRow(command.item_id)
    if (!current) fail('AGENT_CONTEXT_NOT_FOUND')
    if (Number(current.item_revision) !== command.item_revision) fail('AGENT_CONTEXT_REVISION_CONFLICT')
    if (current.lifecycle !== 'active') fail('AGENT_CONTEXT_OPERATION_FAILED')
    const now = this.nowValue()
    const nextItemRevision = command.item_revision + 1
    const revisionId = `revision-${sha256Canonical({ memoryId: command.item_id, itemRevision: nextItemRevision, operation: 'forget' }).slice(0, 44)}`
    this.database.exec('BEGIN IMMEDIATE')
    try {
      this.database.prepare(`
        INSERT INTO personal_context_revisions(
          revision_id, memory_id, operation, content_json, previous_revision_id, run_id, created_at
        ) VALUES (?, ?, 'forget', NULL, ?, NULL, ?)
      `).run(revisionId, command.item_id, current.current_revision_id, now)
      this.database.prepare(`
        UPDATE personal_context_items SET lifecycle = 'forgotten', current_revision_id = ?,
          item_revision = ?, updated_at = ? WHERE memory_id = ?
      `).run(revisionId, nextItemRevision, now, command.item_id)
      const revision = this.advanceRevision({ operation: 'forget', memoryId: command.item_id, itemRevision: nextItemRevision })
      const item = publicItem(this.memoryRow(command.item_id))
      this.database.exec('COMMIT')
      return { revision, item }
    } catch (error) {
      rollbackQuietly(this.database)
      throw error
    }
  }

  manageDelete (command) {
    assertExactKeys(command, ['type', 'expected_revision', 'item_id', 'item_revision', 'deletion_idempotency_key'], 'AGENT_REQUEST_INVALID')
    safeInteger(command.expected_revision)
    identifier(command.item_id)
    safeInteger(command.item_revision, 1)
    identifier(command.deletion_idempotency_key)
    const requestDigest = sha256Canonical({
      itemId: command.item_id,
      itemRevision: command.item_revision,
      deletionIdempotencyKey: command.deletion_idempotency_key
    })
    const receipt = this.database.prepare(`
      SELECT * FROM personal_context_deletion_receipts WHERE deletion_idempotency_key = ?
    `).get(command.deletion_idempotency_key)
    if (receipt) {
      if (receipt.request_digest !== requestDigest) fail('AGENT_REQUEST_INVALID')
      return {
        revision: this.contentRevision(), replayed: true,
        deleted: {
          items: Number(receipt.deleted_item_count),
          revisions: Number(receipt.deleted_revision_count),
          evidence: Number(receipt.deleted_evidence_count)
        }
      }
    }
    this.assertRevision(command.expected_revision)
    const current = this.memoryRow(command.item_id)
    if (!current) fail('AGENT_CONTEXT_NOT_FOUND')
    if (Number(current.item_revision) !== command.item_revision) fail('AGENT_CONTEXT_REVISION_CONFLICT')
    const now = this.nowValue()
    const identityHash = sha256Canonical({ scopeId: current.scope_id, kind: current.kind, semanticKey: current.semantic_key })
    const evidenceRows = this.database.prepare(`
      SELECT input_digest FROM personal_context_evidence WHERE memory_id = ? ORDER BY evidence_id
    `).all(command.item_id)
    const sourceDigests = evidenceRows.length > 0 ? evidenceRows.map((row) => row.input_digest) : [identityHash]
    const revisionCount = Number(this.database.prepare(`
      SELECT COUNT(*) AS count FROM personal_context_revisions WHERE memory_id = ?
    `).get(command.item_id).count)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      for (const sourceDigest of new Set(sourceDigests)) {
        this.database.prepare(`
          INSERT OR IGNORE INTO personal_context_suppressions(identity_hash, scope_id, source_digest, created_at)
          VALUES (?, ?, ?, ?)
        `).run(identityHash, current.scope_id, sourceDigest, now)
      }
      this.database.prepare(`
        UPDATE personal_context_items SET current_revision_id = NULL WHERE memory_id = ?
      `).run(command.item_id)
      this.database.prepare(`
        UPDATE personal_context_revisions SET previous_revision_id = NULL WHERE memory_id = ?
      `).run(command.item_id)
      this.database.prepare('DELETE FROM personal_context_evidence WHERE memory_id = ?').run(command.item_id)
      this.database.prepare('DELETE FROM personal_context_revisions WHERE memory_id = ?').run(command.item_id)
      this.database.prepare('DELETE FROM personal_context_items WHERE memory_id = ?').run(command.item_id)
      this.database.prepare(`
        INSERT INTO personal_context_deletion_receipts(
          deletion_idempotency_key, request_digest, identity_hash,
          deleted_item_count, deleted_revision_count, deleted_evidence_count, created_at
        ) VALUES (?, ?, ?, 1, ?, ?, ?)
      `).run(command.deletion_idempotency_key, requestDigest, identityHash, revisionCount, evidenceRows.length, now)
      const revision = this.advanceRevision({ operation: 'delete', identityHash, requestDigest })
      this.database.exec('COMMIT')
      return { revision, replayed: false, deleted: { items: 1, revisions: revisionCount, evidence: evidenceRows.length } }
    } catch (error) {
      rollbackQuietly(this.database)
      throw error
    }
  }

  resolve (request) {
    assertExactKeys(request, ['scope', 'semantic_keys', 'aliases'], 'AGENT_REQUEST_INVALID')
    assertExactKeys(request.scope, ['kind', 'reference'], 'AGENT_REQUEST_INVALID')
    if (!['selection', 'session', 'date_range', 'project'].includes(request.scope.kind)) fail('AGENT_REQUEST_INVALID')
    if (!Array.isArray(request.semantic_keys) || !Array.isArray(request.aliases) ||
        request.semantic_keys.length > MAX_CANDIDATES || request.aliases.length > MAX_CANDIDATES) fail('AGENT_REQUEST_INVALID')
    const terms = new Set([...request.semantic_keys, ...request.aliases].map(normalizeSemanticKey))
    let episodeRows = []
    const excludedScopes = []
    let notCommittedTail = false
    const reference = request.scope.reference
    if (request.scope.kind === 'session') {
      identifier(reference)
      episodeRows = this.database.prepare(`
        SELECT episode.*, scope.session_id AS scope_session_id
        FROM personal_context_episodes AS episode
        JOIN personal_context_scopes AS scope ON scope.scope_id = episode.scope_id
        WHERE episode.lifecycle = 'active' AND (
          episode.session_id = ? OR
          (episode.source_kind = 'interaction' AND scope.kind = 'session' AND scope.session_id = ?)
        )
        ORDER BY updated_at DESC, episode_id ASC LIMIT ?
      `).all(reference, reference, MAX_ITEMS + 1)
      const session = this.database.prepare('SELECT state, ended_at FROM sessions WHERE session_id = ?').get(reference)
      if (session && (!['closed', 'interrupted'].includes(session.state) || session.ended_at === null)) {
        excludedScopes.push({ kind: 'session', reference, reason: 'session_not_terminal' })
      } else if (session && episodeRows.length === 0) {
        excludedScopes.push({ kind: 'session', reference, reason: 'no_committed_transcript' })
      }
    } else if (request.scope.kind === 'selection') {
      assertExactKeys(reference, ['session_id', 'through_event_order'], 'AGENT_REQUEST_INVALID')
      const sessionId = identifier(reference.session_id)
      const throughEventOrder = safeInteger(reference.through_event_order, 1)
      episodeRows = this.database.prepare(`
        SELECT episode.*, scope.session_id AS scope_session_id
        FROM personal_context_episodes AS episode
        JOIN personal_context_scopes AS scope ON scope.scope_id = episode.scope_id
        WHERE episode.lifecycle = 'active' AND episode.from_event_order <= ? AND (
          episode.session_id = ? OR
          (episode.source_kind = 'interaction' AND scope.kind = 'session' AND scope.session_id = ?)
        )
        ORDER BY updated_at DESC, episode_id ASC LIMIT ?
      `).all(throughEventOrder, sessionId, sessionId, MAX_ITEMS + 1)
      const session = this.database.prepare('SELECT state, ended_at FROM sessions WHERE session_id = ?').get(sessionId)
      if (session && (!['closed', 'interrupted'].includes(session.state) || session.ended_at === null)) {
        excludedScopes.push({ kind: 'session', reference: sessionId, reason: 'session_not_terminal' })
        episodeRows = []
      } else if (session && episodeRows.length === 0) {
        excludedScopes.push({ kind: 'session', reference: sessionId, reason: 'no_committed_transcript' })
      }
      const maximum = this.database.prepare(`
        SELECT MAX(event_order) AS watermark FROM caption_events WHERE session_id = ?
      `).get(sessionId).watermark
      notCommittedTail = maximum !== null && throughEventOrder < Number(maximum)
    } else if (request.scope.kind === 'date_range') {
      assertExactKeys(reference, ['from', 'through'], 'AGENT_REQUEST_INVALID')
      const from = safeInteger(reference.from)
      const through = safeInteger(reference.through)
      if (through < from) fail('AGENT_REQUEST_INVALID')
      episodeRows = this.database.prepare(`
        SELECT episode.*, episode_scope.session_id AS scope_session_id
        FROM personal_context_episodes AS episode
        JOIN personal_context_scopes AS episode_scope ON episode_scope.scope_id = episode.scope_id
        JOIN sessions AS session ON session.session_id = COALESCE(episode.session_id, episode_scope.session_id)
        WHERE episode.lifecycle = 'active' AND session.started_at <= ? AND session.ended_at >= ?
        ORDER BY episode.updated_at DESC, episode.episode_id ASC LIMIT ?
      `).all(through, from, MAX_ITEMS + 1)
      const sessions = this.database.prepare(`
        SELECT session.session_id, session.state, session.ended_at,
          (SELECT COUNT(*) FROM segments WHERE segments.session_id = session.session_id) AS segment_count,
          (SELECT COUNT(*) FROM personal_context_episodes WHERE session_id = session.session_id AND lifecycle = 'active') AS episode_count
        FROM sessions AS session
        WHERE session.started_at <= ? AND COALESCE(session.ended_at, session.started_at) >= ?
        ORDER BY session.started_at, session.session_id
      `).all(through, from)
      for (const session of sessions) {
        if (!['closed', 'interrupted'].includes(session.state) || session.ended_at === null) {
          excludedScopes.push({ kind: 'session', reference: session.session_id, reason: 'session_not_terminal' })
        } else if (Number(session.segment_count) === 0 || Number(session.episode_count) === 0) {
          excludedScopes.push({ kind: 'session', reference: session.session_id, reason: 'no_committed_transcript' })
        }
      }
    } else {
      identifier(reference)
      episodeRows = this.database.prepare(`
        SELECT episode.* FROM personal_context_episodes AS episode
        JOIN personal_context_scopes AS scope ON scope.scope_id = episode.scope_id
        WHERE episode.lifecycle = 'active' AND scope.kind = 'project' AND scope.canonical_key = ?
        ORDER BY episode.updated_at DESC, episode.episode_id ASC LIMIT ?
      `).all(`project:${reference}`, MAX_ITEMS + 1)
    }

    let allowedSessionIds = null
    if (request.scope.kind === 'date_range') {
      allowedSessionIds = new Set(this.database.prepare(`
        SELECT session_id FROM sessions
        WHERE started_at <= ? AND COALESCE(ended_at, started_at) >= ?
      `).all(reference.through, reference.from).map((row) => row.session_id))
    }
    const requestedSessionId = request.scope.kind === 'selection' ? reference.session_id : reference
    const inRequestedScope = (row) => {
      if (row.scope_kind === 'global') return true
      if (request.scope.kind === 'session' || request.scope.kind === 'selection') {
        return row.scope_kind === 'session' && row.scope_reference === requestedSessionId
      }
      if (request.scope.kind === 'project') {
        return row.scope_kind === 'project' && row.scope_reference === reference
      }
      return row.scope_kind === 'session' && allowedSessionIds.has(row.scope_reference)
    }
    const candidateRows = this.database.prepare(`
      SELECT item.*, scope.kind AS scope_kind,
        CASE WHEN scope.kind = 'global' THEN NULL ELSE substr(scope.canonical_key, instr(scope.canonical_key, ':') + 1) END AS scope_reference,
        (SELECT COUNT(*) FROM personal_context_evidence AS evidence WHERE evidence.memory_id = item.memory_id) AS source_count
      FROM personal_context_items AS item
      JOIN personal_context_scopes AS scope ON scope.scope_id = item.scope_id
      WHERE item.lifecycle = 'active'
      ORDER BY item.updated_at DESC, item.memory_id ASC
      LIMIT ?
    `).all(MAX_CANDIDATES + 1)
    let budgetOmitted = candidateRows.length > MAX_CANDIDATES
    const filtered = candidateRows.slice(0, MAX_CANDIDATES).filter((row) =>
      inRequestedScope(row) && (terms.size === 0 || terms.has(normalizeSemanticKey(row.semantic_key))))
    const personalMemories = []
    let bytes = 0
    budgetOmitted = budgetOmitted || filtered.length > MAX_ITEMS
    const episodes = []
    if (episodeRows.length > MAX_ITEMS) {
      budgetOmitted = true
      episodeRows = episodeRows.slice(0, MAX_ITEMS)
    }
    for (const row of episodeRows) {
      let episode = {
        episodeId: row.episode_id, sessionId: row.session_id || row.scope_session_id,
        transcriptVersion: row.transcript_version, inputWatermark: Number(row.input_watermark),
        inputDigest: row.input_digest, summary: JSON.parse(row.summary_json)
      }
      if (request.scope.kind === 'selection' && row.source_kind === 'session' && Number(row.through_event_order) > reference.through_event_order) {
        const selectedRows = this.database.prepare(`
          SELECT segment.segment_id, first_event.event_order AS first_event_order,
            first_event.text AS raw_text, updated_event.event_order AS updated_event_order,
            updated_event.kind AS updated_kind, segment.text AS current_text
          FROM segments AS segment
          JOIN caption_events AS first_event ON first_event.event_order = segment.first_event_order
          JOIN caption_events AS updated_event ON updated_event.event_order = segment.updated_event_order
          WHERE segment.session_id = ? AND first_event.event_order <= ?
          ORDER BY first_event.event_order
        `).all(row.session_id, reference.through_event_order)
        if (selectedRows.length === 0) continue
        const wholeSessionRefinement = this.database.prepare(`
          SELECT COUNT(*) AS segment_count,
            SUM(CASE WHEN updated_event.kind = 'refined' THEN 1 ELSE 0 END) AS refined_count
          FROM segments AS segment
          JOIN caption_events AS updated_event ON updated_event.event_order = segment.updated_event_order
          WHERE segment.session_id = ?
        `).get(row.session_id)
        const refinedComplete = Number(wholeSessionRefinement.segment_count) > 0 &&
          Number(wholeSessionRefinement.segment_count) === Number(wholeSessionRefinement.refined_count) &&
          selectedRows.every((segment) => Number(segment.updated_event_order) <= reference.through_event_order)
        const transcriptVersion = refinedComplete ? 'refined' : 'raw'
        const events = selectedRows.map((segment) => ({
          eventOrder: Number(transcriptVersion === 'refined' ? segment.updated_event_order : segment.first_event_order),
          segmentId: segment.segment_id,
          text: transcriptVersion === 'refined' ? segment.current_text : segment.raw_text
        }))
        const inputWatermark = Math.max(...events.map((event) => event.eventOrder))
        episode = {
          episodeId: row.episode_id, sessionId: row.session_id, transcriptVersion, inputWatermark,
          inputDigest: sha256Canonical({ sessionId: row.session_id, transcriptVersion, inputWatermark, events }),
          summary: { title: 'Session experience', bullets: [`Segments: ${events.length}`], omissions: ['not_committed_tail'] }
        }
      }
      const episodeBytes = Buffer.byteLength(canonicalize(episode), 'utf8')
      if (bytes + episodeBytes > MAX_CANONICAL_BYTES) {
        budgetOmitted = true
        continue
      }
      bytes += episodeBytes
      episodes.push(episode)
    }
    for (const row of filtered) {
      if (personalMemories.length >= MAX_ITEMS) break
      if (Number(row.source_count) > MAX_SOURCES_PER_ITEM) {
        budgetOmitted = true
        continue
      }
      const evidence = this.database.prepare(`
        SELECT input_digest FROM personal_context_evidence
        WHERE memory_id = ? ORDER BY evidence_id
      `).all(row.memory_id).map((item) => item.input_digest)
      const item = {
        memoryId: row.memory_id,
        semanticKey: row.semantic_key,
        displayText: JSON.parse(row.content_json).displayText,
        kind: row.kind,
        scope: { kind: row.scope_kind, reference: row.scope_reference },
        sourceDigests: evidence
      }
      const itemBytes = Buffer.byteLength(canonicalize(item), 'utf8')
      if (bytes + itemBytes > MAX_CANONICAL_BYTES) {
        budgetOmitted = true
        continue
      }
      bytes += itemBytes
      personalMemories.push(item)
    }
    if (budgetOmitted) excludedScopes.push({ kind: request.scope.kind, reference, reason: 'budget' })
    const result = {
      eligibility: episodes.length > 0 || personalMemories.length > 0 ? 'ready' : 'no_committed_transcript',
      episodes,
      personalMemories,
      omissions: [...(notCommittedTail ? ['not_committed_tail'] : []), ...(budgetOmitted ? ['budget'] : [])],
      excludedScopes,
      hasMore: budgetOmitted,
      revision: this.contentRevision()
    }
    while (Buffer.byteLength(canonicalize(result), 'utf8') > MAX_CANONICAL_BYTES) {
      budgetOmitted = true
      if (result.personalMemories.length > 0) result.personalMemories.pop()
      else if (result.episodes.length > 0) result.episodes.pop()
      else if (result.excludedScopes.length > 0) result.excludedScopes.pop()
      else fail('AGENT_BUDGET_EXCEEDED')
      result.hasMore = true
      if (!result.omissions.includes('budget')) result.omissions.push('budget')
      if (!result.excludedScopes.some((item) => item.reason === 'budget')) {
        result.excludedScopes.push({ kind: request.scope.kind, reference, reason: 'budget' })
      }
      result.eligibility = result.episodes.length > 0 || result.personalMemories.length > 0
        ? 'ready'
        : 'no_committed_transcript'
    }
    return result
  }

  planSessionDeletion (sessionId) {
    identifier(sessionId)
    const episodeCount = Number(this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM personal_context_episodes AS episode
      LEFT JOIN personal_context_scopes AS scope ON scope.scope_id = episode.scope_id
      WHERE episode.session_id = ? OR (episode.source_kind = 'interaction' AND scope.session_id = ?)
    `).get(sessionId, sessionId).count)
    const evidenceCount = Number(this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM personal_context_evidence AS evidence
      LEFT JOIN personal_context_episodes AS episode ON episode.ingest_run_id = evidence.ingest_run_id
      LEFT JOIN personal_context_scopes AS scope ON scope.scope_id = episode.scope_id
      WHERE evidence.session_id = ? OR (evidence.source_kind = 'interaction' AND scope.session_id = ?)
    `).get(sessionId, sessionId).count)
    const orphanItemIds = this.database.prepare(`
      SELECT DISTINCT item.memory_id
      FROM personal_context_items AS item
      JOIN personal_context_scopes AS scope ON scope.scope_id = item.scope_id
      LEFT JOIN personal_context_evidence AS own
        ON own.memory_id = item.memory_id AND (
          own.session_id = ? OR (own.source_kind = 'interaction' AND EXISTS (
            SELECT 1
            FROM personal_context_episodes AS own_episode
            JOIN personal_context_scopes AS own_scope ON own_scope.scope_id = own_episode.scope_id
            WHERE own_episode.source_kind = 'interaction'
              AND own_episode.interaction_id = own.interaction_id
              AND own_scope.session_id = ?
          ))
        )
      WHERE (scope.session_id = ? OR own.evidence_id IS NOT NULL) AND NOT EXISTS (
          SELECT 1 FROM personal_context_evidence AS other
          WHERE other.memory_id = item.memory_id
            AND NOT (
              other.session_id = ? OR (other.source_kind = 'interaction' AND EXISTS (
                SELECT 1
                FROM personal_context_episodes AS other_episode
                JOIN personal_context_scopes AS other_scope ON other_scope.scope_id = other_episode.scope_id
                WHERE other_episode.source_kind = 'interaction'
                  AND other_episode.interaction_id = other.interaction_id
                  AND other_scope.session_id = ?
              ))
            )
       )
      ORDER BY item.memory_id
    `).all(sessionId, sessionId, sessionId, sessionId, sessionId).map((row) => row.memory_id)
    return { episodeCount, evidenceCount, orphanItemIds }
  }

  applySessionDeletion (sessionId, plan, now) {
    identifier(sessionId)
    safeInteger(now)
    if (!isPlainObject(plan) || !Array.isArray(plan.orphanItemIds)) fail('STORAGE_COMMAND_FAILED')
    for (const memoryId of plan.orphanItemIds) {
      this.database.prepare(`
        UPDATE personal_context_items SET lifecycle = 'inactive', updated_at = ? WHERE memory_id = ?
      `).run(now, memoryId)
    }
    this.database.prepare(`
      DELETE FROM personal_context_evidence
      WHERE session_id = ? OR (source_kind = 'interaction' AND interaction_id IN (
        SELECT episode.interaction_id
        FROM personal_context_episodes AS episode
        JOIN personal_context_scopes AS scope ON scope.scope_id = episode.scope_id
        WHERE episode.source_kind = 'interaction' AND scope.session_id = ?
      ))
    `).run(sessionId, sessionId)
    this.database.prepare(`
      DELETE FROM personal_context_episodes
      WHERE session_id = ? OR (source_kind = 'interaction' AND scope_id IN (
        SELECT scope_id FROM personal_context_scopes WHERE kind = 'session' AND session_id = ?
      ))
    `).run(sessionId, sessionId)
    if (plan.episodeCount > 0 || plan.evidenceCount > 0 || plan.orphanItemIds.length > 0) {
      this.advanceRevision({
        operation: 'delete-session-context', sessionId,
        deletedEpisodeCount: plan.episodeCount,
        deletedContextEvidenceCount: plan.evidenceCount,
        deletedOrphanContextItemCount: plan.orphanItemIds.length
      })
    }
  }


  claimNextFormalRun (request) {
    if (!isPlainObject(request)) fail('AGENT_REQUEST_INVALID')
    const requestKeys = Object.keys(request).sort()
    const legacyKeys = ['claimIdempotencyKey', 'leaseMs', 'owner']
    const scopedKeys = ['claimIdempotencyKey', 'leaseMs', 'owner', 'requestedBy']
    const policyKeys = ['automaticPolicy', 'claimIdempotencyKey', 'leaseMs', 'owner']
    const scopedPolicyKeys = ['automaticPolicy', 'claimIdempotencyKey', 'leaseMs', 'owner', 'requestedBy']
    const exact = (keys) => requestKeys.length === keys.length && keys.every((key, index) => key === requestKeys[index])
    const hasPolicy = Object.hasOwn(request, 'automaticPolicy')
    if (!exact(legacyKeys) && !exact(scopedKeys) && !exact(policyKeys) && !exact(scopedPolicyKeys)) fail('AGENT_REQUEST_INVALID')
    const requestedBy = request.requestedBy === undefined ? 'automatic' : request.requestedBy
    if (!['automatic', 'user'].includes(requestedBy)) fail('AGENT_REQUEST_INVALID')
    if (hasPolicy && requestedBy !== 'automatic') fail('AGENT_REQUEST_INVALID')
    const requestPolicy = hasPolicy ? automaticTaskPolicy(request.automaticPolicy) : null
    identifier(request.claimIdempotencyKey)
    identifier(request.owner)
    safeInteger(request.leaseMs, 1)
    const requestDigest = sha256Canonical(request)
    const now = this.nowValue()
    const policyMatches = requestedBy !== 'automatic' || !this.automaticPolicy || !requestPolicy ||
      canonicalize(this.automaticPolicy) === canonicalize(requestPolicy)
    const effectivePolicy = requestedBy === 'automatic'
      ? (this.automaticPolicy || requestPolicy)
      : null
    const automaticPolicyAllowed = requestedBy === 'user' ||
      (policyMatches && automaticTaskPolicyAllows(effectivePolicy))
    const receiptResult = (receipt) => {
      if (receipt.run_id === null) return null
      const row = this.database.prepare('SELECT * FROM formal_agent_runs WHERE run_id = ?').get(receipt.run_id)
      if (!row) fail('STORAGE_COMMAND_FAILED')
      const scope = JSON.parse(row.scope_json)
      const watermark = JSON.parse(row.input_watermark_json)
      const interaction = this.database.prepare(`
        SELECT interaction_id FROM formal_agent_interactions WHERE run_id = ?
      `).get(row.run_id)
      if (row.recipe_id === 'context.ingest.interaction') {
        const episode = this.database.prepare(`
          SELECT episode.*, scope.session_id AS scope_session_id
          FROM personal_context_episodes AS episode
          JOIN personal_context_scopes AS scope ON scope.scope_id = episode.scope_id
          WHERE episode.ingest_run_id = ? AND episode.source_kind = 'interaction'
        `).get(row.run_id)
        if (!episode) fail('STORAGE_COMMAND_FAILED')
        let summary
        try { summary = JSON.parse(episode.summary_json) } catch { fail('STORAGE_COMMAND_FAILED') }
        return {
          runId: row.run_id,
          recipeId: row.recipe_id,
          interactionId: interaction?.interaction_id || null,
          requestedBy: row.requested_by,
          source: {
            sourceKind: 'interaction',
            interactionId: episode.interaction_id,
            signalKind: summary.signalKind,
            payloadDigest: summary.payloadDigest || null,
            signalIdempotencyKey: summary.signalIdempotencyKey,
            recipeId: summary.recipeId,
            recipeVersion: summary.recipeVersion,
            scopeKind: 'session',
            scopeReference: episode.scope_session_id,
            inputDigest: episode.input_digest,
            sessionId: episode.scope_session_id,
            transcriptVersion: episode.transcript_version,
            inputWatermark: Number(episode.input_watermark),
            interactionInputDigest: summary.interactionInputDigest,
            promptDigest: summary.promptDigest || null,
            resultDigest: summary.resultDigest || null
          },
          attemptIdentity: {
            runId: row.run_id,
            attempt: Number(row.attempt_count),
            owner: receipt.lease_owner,
            leaseExpiresAt: Number(receipt.lease_expires_at)
          }
        }
      }
      const result = {
        runId: row.run_id,
        recipeId: row.recipe_id,
        interactionId: interaction?.interaction_id || null,
        requestedBy: row.requested_by,
        source: {
          sourceKind: scope.kind,
          sessionId: scope.reference,
          transcriptVersion: row.transcript_version,
          inputWatermark: Number(watermark.throughEventOrder),
          inputDigest: row.input_digest
        },
        attemptIdentity: {
          runId: row.run_id,
          attempt: Number(row.attempt_count),
          owner: receipt.lease_owner,
          leaseExpiresAt: Number(receipt.lease_expires_at)
        }
      }
      if (row.recipe_id === 'summary.minutes') {
        result.summaryUseMemory = row.summary_use_memory === undefined || row.summary_use_memory === null
          ? true
          : row.summary_use_memory !== 0
      }
      return result
    }
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const prior = this.database.prepare(`
        SELECT * FROM formal_agent_run_claim_receipts WHERE claim_idempotency_key = ?
      `).get(request.claimIdempotencyKey)
      if (prior) {
        if (prior.request_digest !== requestDigest) fail('AGENT_REQUEST_INVALID')
        this.database.exec('COMMIT')
        return receiptResult(prior)
      }
      const row = this.database.prepare(`
        SELECT * FROM formal_agent_runs
        WHERE requested_by = ? AND (
          (? = 'automatic' AND recipe_id IN ('context.ingest.session', 'context.ingest.interaction')) OR
          (? = 'user' AND recipe_id IN ('summary.minutes', 'qa.answer'))
        ) AND (? = 1) AND (
          (state IN ('queued', 'retry_wait') AND next_attempt_at <= ? AND cancel_requested_at IS NULL) OR
          (state = 'running' AND lease_expires_at <= ? AND cancel_requested_at IS NULL)
        )
        ORDER BY next_attempt_at, run_order LIMIT 1
      `).get(requestedBy, requestedBy, requestedBy, automaticPolicyAllowed ? 1 : 0, now, now)
      let leaseExpiresAt = null
      if (row) {
        leaseExpiresAt = now + request.leaseMs
        if (!Number.isSafeInteger(leaseExpiresAt)) fail('STORAGE_COMMAND_FAILED')
        const attempt = Number(row.attempt_count) + 1
        this.database.prepare(`
          UPDATE formal_agent_runs
          SET state = 'running', attempt_count = ?, lease_owner = ?, lease_expires_at = ?,
            lease_renewed_from_expires_at = NULL, next_attempt_at = ?, error_code = NULL, updated_at = ?
          WHERE run_id = ?
        `).run(attempt, request.owner, leaseExpiresAt, now, now, row.run_id)
      }
      this.database.prepare(`
        INSERT INTO formal_agent_run_claim_receipts(
          claim_idempotency_key, request_digest, run_id, lease_owner, lease_expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        request.claimIdempotencyKey, requestDigest, row?.run_id || null,
        row ? request.owner : null, leaseExpiresAt, now
      )
      const receipt = this.database.prepare(`
        SELECT * FROM formal_agent_run_claim_receipts WHERE claim_idempotency_key = ?
      `).get(request.claimIdempotencyKey)
      this.database.exec('COMMIT')
      if (requestedBy === 'automatic' && !this.automaticPolicy && requestPolicy) this.automaticPolicy = requestPolicy
      return receiptResult(receipt)
    } catch (error) {
      rollbackQuietly(this.database)
      throw error
    }
  }

  nextFormalRunAt (request = {}) {
    if (!isPlainObject(request)) fail('AGENT_REQUEST_INVALID')
    const keys = Object.keys(request).sort()
    if (!(keys.length === 0 || (keys.length === 1 && (keys[0] === 'requestedBy' || keys[0] === 'automaticPolicy')))) fail('AGENT_REQUEST_INVALID')
    const requestedBy = request.requestedBy === undefined ? 'automatic' : request.requestedBy
    if (!['automatic', 'user'].includes(requestedBy)) fail('AGENT_REQUEST_INVALID')
    if (Object.hasOwn(request, 'automaticPolicy') && requestedBy !== 'automatic') fail('AGENT_REQUEST_INVALID')
    const requestPolicy = Object.hasOwn(request, 'automaticPolicy') ? automaticTaskPolicy(request.automaticPolicy) : null
    const policyMatches = requestedBy !== 'automatic' || !this.automaticPolicy || !requestPolicy ||
      canonicalize(this.automaticPolicy) === canonicalize(requestPolicy)
    const effectivePolicy = requestedBy === 'automatic' ? (this.automaticPolicy || requestPolicy) : null
    if (requestedBy === 'automatic' && (!policyMatches || !automaticTaskPolicyAllows(effectivePolicy))) return null
    if (requestedBy === 'automatic' && !this.automaticPolicy && requestPolicy) this.automaticPolicy = requestPolicy
    const row = this.database.prepare(`
      SELECT MIN(ready_at) AS ready_at FROM (
        SELECT next_attempt_at AS ready_at FROM formal_agent_runs
          WHERE requested_by = ? AND (
            (? = 'automatic' AND recipe_id IN ('context.ingest.session', 'context.ingest.interaction')) OR
            (? = 'user' AND recipe_id IN ('summary.minutes', 'qa.answer'))
          ) AND state IN ('queued', 'retry_wait') AND cancel_requested_at IS NULL
        UNION ALL
        SELECT lease_expires_at AS ready_at FROM formal_agent_runs
          WHERE requested_by = ? AND (
            (? = 'automatic' AND recipe_id IN ('context.ingest.session', 'context.ingest.interaction')) OR
            (? = 'user' AND recipe_id IN ('summary.minutes', 'qa.answer'))
          ) AND state = 'running' AND cancel_requested_at IS NULL
      )
    `).get(requestedBy, requestedBy, requestedBy, requestedBy, requestedBy, requestedBy)
    return row.ready_at === null ? null : Number(row.ready_at)
  }

  assertAttempt (attemptIdentity) {
    assertExactKeys(attemptIdentity, ['runId', 'attempt', 'owner', 'leaseExpiresAt'], 'AGENT_REQUEST_INVALID')
    identifier(attemptIdentity.runId)
    safeInteger(attemptIdentity.attempt, 1)
    identifier(attemptIdentity.owner)
    safeInteger(attemptIdentity.leaseExpiresAt)
    return attemptIdentity
  }

  completeFormalRun (request) {
    assertExactKeys(request, ['attemptIdentity', 'resultDigest', 'resultSummary'], 'AGENT_REQUEST_INVALID')
    const attempt = this.assertAttempt(request.attemptIdentity)
    if (typeof request.resultDigest !== 'string' || !/^[0-9a-f]{64}$/.test(request.resultDigest)) fail('AGENT_REQUEST_INVALID')
    if (sha256Canonical(request.resultSummary) !== request.resultDigest) fail('AGENT_REQUEST_INVALID')
    const summaryJson = canonicalize(request.resultSummary)
    const row = this.database.prepare('SELECT * FROM formal_agent_runs WHERE run_id = ?').get(attempt.runId)
    if (!row) fail('AGENT_CONTEXT_NOT_FOUND')
    if (row.state === 'succeeded') {
      if (row.result_digest !== request.resultDigest) fail('AGENT_CONTEXT_OPERATION_FAILED')
      return { runId: row.run_id, replayed: true, state: 'succeeded' }
    }
    if (row.state !== 'running' || Number(row.attempt_count) !== attempt.attempt ||
        row.lease_owner !== attempt.owner || Number(row.lease_expires_at) !== attempt.leaseExpiresAt) {
      fail('AGENT_CONTEXT_OPERATION_FAILED')
    }
    this.database.prepare(`
      UPDATE formal_agent_runs SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
        result_digest = ?, result_summary_json = ?, error_code = NULL, updated_at = ? WHERE run_id = ?
    `).run(request.resultDigest, summaryJson, this.nowValue(), attempt.runId)
    return { runId: row.run_id, replayed: false, state: 'succeeded' }
  }

  failFormalRun (request) {
    assertExactKeys(request, ['attemptIdentity', 'errorCode'], 'AGENT_REQUEST_INVALID')
    const attempt = this.assertAttempt(request.attemptIdentity)
    const errors = new Set(FORMAL_AGENT_TASK_ERROR_CODES)
    const row = this.database.prepare('SELECT * FROM formal_agent_runs WHERE run_id = ?').get(attempt.runId)
    const summaryInputLimitError = request.errorCode === 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED'
    if (!errors.has(request.errorCode) && !summaryInputLimitError) fail('AGENT_REQUEST_INVALID')
    if (summaryInputLimitError && row?.recipe_id !== 'summary.minutes') fail('AGENT_REQUEST_INVALID')
    if (!row || row.state !== 'running' || Number(row.attempt_count) !== attempt.attempt ||
        row.lease_owner !== attempt.owner || Number(row.lease_expires_at) !== attempt.leaseExpiresAt) {
      fail('AGENT_CONTEXT_OPERATION_FAILED')
    }
    const terminal = summaryInputLimitError || Number(row.attempt_count) >= Number(row.max_attempts)
    const now = this.nowValue()
    const nextAttemptAt = terminal ? now : now + 1000
    const storedErrorCode = request.errorCode === SUMMARY_MEMORY_ERROR ? 'AGENT_INTERNAL_FAILURE' : request.errorCode
    const summaryMemoryError = request.errorCode === SUMMARY_MEMORY_ERROR ? 1 : 0
    this.database.prepare(`
      UPDATE formal_agent_runs SET state = ?, next_attempt_at = ?, lease_owner = NULL,
        lease_expires_at = NULL, error_code = ?, summary_memory_error = ?, summary_input_limit_error = ?, updated_at = ? WHERE run_id = ?
    `).run(
      terminal ? 'failed' : 'retry_wait', nextAttemptAt,
      terminal ? (summaryInputLimitError ? 'AGENT_INTERNAL_FAILURE' : storedErrorCode) : null,
      terminal ? summaryMemoryError : 0,
      terminal && summaryInputLimitError ? 1 : 0,
      now, attempt.runId
    )
    return { runId: row.run_id, state: terminal ? 'failed' : 'retry_wait', nextAttemptAt }
  }
}

module.exports = {
  MAX_CANDIDATES,
  MAX_CANONICAL_BYTES,
  MAX_ITEMS,
  MAX_SCOPE_DIRECTORY_ITEMS,
  MAX_SOURCES_PER_ITEM,
  PersonalContextStore,
  decodePageCursor,
  encodePageCursor,
  normalizeSemanticKey
}
