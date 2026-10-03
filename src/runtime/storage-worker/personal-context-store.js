'use strict'

const crypto = require('node:crypto')
const { canonicalize, sha256Canonical } = require('./canonical-json')
const { rollbackQuietly } = require('./sqlite-store')
const { StorageError, assertExactKeys, isPlainObject } = require('./protocol')
const {
  createRunBudgetAccount,
  isLongInputRun,
  isLongBudgetPolicy,
  interruptActiveAttempt,
  remainingWallClockMs,
  reserveModelRequest,
  settleActiveAttempt,
  startAttemptBudget
} = require('./session-summary-budget')
const { FORMAL_AGENT_TASK_ERROR_CODES } = require('../../agent/contracts/personal-context-core')
const { validateRecipeOutput } = require('../../agent/contracts/recipes')
const { questionSource, allowsQuestionCandidate } = require('../../agent/personal-context/question-memory-source')
const { fileCache, memoryContent, memoryReadable } = require('./personal-memory-file-content')

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
const SESSION_INPUT_PAGE_SIZE = 128

const SESSION_INPUT_ROWS_SQL = `
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
  WHERE segment.session_id = ? AND first_event.event_order > ?
  ORDER BY first_event.event_order
  LIMIT ?
`

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

function publicItem (row, database) {
  const content = memoryContent(database, row)
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
    this.overview = new (require('./personal-memory-overview-store').PersonalMemoryOverviewStore)(this)
    this.hasOverview = Boolean(this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='personal_context_overviews'").get())
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
    if (this.hasOverview) this.overview.invalidate()
    return next
  }

  validateSessionInputSource (source) {
    assertExactKeys(source, ['sourceKind', 'sessionId', 'transcriptVersion', 'inputWatermark', 'inputDigest', ...(Object.hasOwn(source, 'ingestRunId') ? ['ingestRunId'] : [])], 'AGENT_REQUEST_INVALID')
    if (Object.hasOwn(source, 'ingestRunId')) identifier(source.ingestRunId)
    if (source.sourceKind !== 'session' || !['raw', 'refined'].includes(source.transcriptVersion)) fail('AGENT_REQUEST_INVALID')
    const sessionId = identifier(source.sessionId)
    const inputWatermark = safeInteger(source.inputWatermark, 1)
    if (typeof source.inputDigest !== 'string' || !/^[0-9a-f]{64}$/.test(source.inputDigest)) fail('AGENT_REQUEST_INVALID')
    return { sessionId, inputWatermark }
  }

  getSessionInputSession (sessionId) {
    const session = this.database.prepare(`
      SELECT session_id, started_at, ended_at, state
      FROM sessions WHERE session_id = ?
    `).get(sessionId)
    if (!session) fail('AGENT_SESSION_NOT_FOUND')
    if (!['closed', 'interrupted'].includes(session.state) || session.ended_at === null) fail('AGENT_SESSION_NOT_TERMINAL')
    return session
  }

  getSessionInputRows (sessionId, afterEventOrder = 0, limit = -1) {
    return this.database.prepare(SESSION_INPUT_ROWS_SQL).all(sessionId, afterEventOrder, limit)
  }

  buildSessionInput (source, session, rows, { allowRefinedFallback = false } = {}) {
    const { sessionId, inputWatermark } = this.validateSessionInputSource(source)
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
    const selectedWatermark = events.reduce((maximum, event) => Math.max(maximum, event.eventOrder), 0)
    if (inputWatermark !== selectedWatermark) fail('AGENT_INPUT_CHANGED')
    const digestPayload = { sessionId, transcriptVersion, inputWatermark, events }
    if (sha256Canonical(digestPayload) !== source.inputDigest) fail('AGENT_INPUT_CHANGED')
    const fromEventOrder = events.reduce((minimum, event) => Math.min(minimum, event.eventOrder), Number.MAX_SAFE_INTEGER)
    return {
      sourceKind: 'session',
      sessionId,
      transcriptVersion,
      inputWatermark,
      inputDigest: source.inputDigest,
      startedAt: Number(session.started_at),
      endedAt: Number(session.ended_at),
      fromEventOrder,
      throughEventOrder: selectedWatermark,
      segmentCount: events.length,
      events: events.map((event) => ({ ...event }))
    }
  }

  async buildSessionInputPaged (source, session, rows, options = {}) {
    const { sessionId, inputWatermark } = this.validateSessionInputSource(source)
    const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : () => false
    const checkCancelled = () => {
      if (isCancelled()) fail('AGENT_CANCELLED')
    }
    if (rows.length === 0) fail('AGENT_INPUT_EMPTY')
    let refinedComplete = true
    for (let index = 0; index < rows.length; index += 1) {
      checkCancelled()
      if (rows[index].refined_event_order === null) refinedComplete = false
      if ((index + 1) % SESSION_INPUT_PAGE_SIZE === 0) {
        await new Promise((resolve) => setImmediate(resolve))
        checkCancelled()
      }
    }
    if (source.transcriptVersion === 'refined' && !refinedComplete && !options.allowRefinedFallback) {
      fail('AGENT_REFINED_INPUT_INCOMPLETE')
    }
    const transcriptVersion = source.transcriptVersion === 'refined' && refinedComplete ? 'refined' : 'raw'
    const events = []
    let selectedWatermark = 0
    let fromEventOrder = Number.MAX_SAFE_INTEGER
    for (let index = 0; index < rows.length; index += 1) {
      checkCancelled()
      const row = rows[index]
      const event = {
        eventOrder: Number(transcriptVersion === 'refined' ? row.refined_event_order : row.first_event_order),
        segmentId: row.segment_id,
        text: transcriptVersion === 'refined' ? row.refined_text : row.raw_text
      }
      selectedWatermark = Math.max(selectedWatermark, event.eventOrder)
      fromEventOrder = Math.min(fromEventOrder, event.eventOrder)
      events.push(event)
      if ((index + 1) % SESSION_INPUT_PAGE_SIZE === 0) {
        await new Promise((resolve) => setImmediate(resolve))
        checkCancelled()
      }
    }
    if (inputWatermark !== selectedWatermark) fail('AGENT_INPUT_CHANGED')

    const hash = crypto.createHash('sha256')
    hash.update('{"events":[')
    for (let index = 0; index < events.length; index += 1) {
      checkCancelled()
      if (index > 0) hash.update(',')
      hash.update(canonicalize(events[index]))
      if ((index + 1) % SESSION_INPUT_PAGE_SIZE === 0) {
        await new Promise((resolve) => setImmediate(resolve))
        checkCancelled()
      }
    }
    hash.update(`],"inputWatermark":${canonicalize(inputWatermark)},"sessionId":${canonicalize(sessionId)},"transcriptVersion":${canonicalize(transcriptVersion)}}`)
    checkCancelled()
    if (hash.digest('hex') !== source.inputDigest) fail('AGENT_INPUT_CHANGED')
    return {
      sourceKind: 'session',
      sessionId,
      transcriptVersion,
      inputWatermark,
      inputDigest: source.inputDigest,
      startedAt: Number(session.started_at),
      endedAt: Number(session.ended_at),
      fromEventOrder,
      throughEventOrder: selectedWatermark,
      segmentCount: events.length,
      events
    }
  }

  sessionInput (source, options = {}) {
    const { sessionId } = this.validateSessionInputSource(source)
    const session = this.getSessionInputSession(sessionId)
    return this.buildSessionInput(source, session, this.getSessionInputRows(sessionId), options)
  }

  sessionSnapshot (source, options = {}) {
    const input = this.sessionInput(source, options)
    const { events, ...snapshot } = input
    return snapshot
  }

  readSessionInput (source) {
    return this.attachIngestMemories(this.sessionInput(source, { allowRefinedFallback: true }), source)
  }

  async readSessionInputPaged (source, options = {}) {
    const { sessionId } = this.validateSessionInputSource(source)
    const session = this.getSessionInputSession(sessionId)
    const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : () => false
    const rows = []
    let afterEventOrder = 0
    const checkCancelled = () => {
      if (isCancelled()) fail('AGENT_CANCELLED')
    }

    while (true) {
      checkCancelled()
      const page = this.getSessionInputRows(sessionId, afterEventOrder, SESSION_INPUT_PAGE_SIZE)
      if (page.length === 0) break
      rows.push(...page)
      afterEventOrder = Number(page[page.length - 1].first_event_order)
      await new Promise((resolve) => setImmediate(resolve))
      checkCancelled()
    }

    const input = await this.buildSessionInputPaged(source, session, rows, {
      allowRefinedFallback: true,
      isCancelled
    })
    return this.attachIngestMemories(input, source)
  }

  readSessionInputRangePage (request) {
    assertExactKeys(request, ['source', 'cursor'], 'AGENT_REQUEST_INVALID')
    const { sessionId } = this.validateSessionInputSource(request.source)
    const session = this.getSessionInputSession(sessionId)
    const cursor = request.cursor
    assertExactKeys(cursor, ['afterEventOrder', 'codePointOffset', 'utf16Offset'], 'AGENT_REQUEST_INVALID')
    safeInteger(cursor.afterEventOrder)
    safeInteger(cursor.codePointOffset)
    safeInteger(cursor.utf16Offset)
    if ((cursor.codePointOffset === 0) !== (cursor.utf16Offset === 0)) fail('AGENT_REQUEST_INVALID')
    const rows = this.getSessionInputRows(sessionId, cursor.afterEventOrder, 500)
    const events = []
    let textBytes = 0
    let nextCursor = { ...cursor }
    let stoppedWithinSegment = false
    for (const row of rows) {
      const eventOrder = Number(row.first_event_order)
      const segmentId = row.segment_id
      const text = row.raw_text
      let codePointEnd = 0
      let utf16End = 0
      // Partial rows use their actual event order as the cursor identity; event
      // orders need not be consecutive because other event kinds share the table.
      if (cursor.codePointOffset > 0 && events.length === 0) {
        codePointEnd = cursor.codePointOffset
        utf16End = cursor.utf16Offset
      }
      if (utf16End > text.length || (utf16End > 0 && /[\uDC00-\uDFFF]/u.test(text[utf16End] || ''))) {
        fail('AGENT_INPUT_CHANGED')
      }
      const codePointStart = codePointEnd
      let fragment = ''
      for (const point of text.slice(utf16End)) {
        const pointBytes = Buffer.byteLength(point, 'utf8')
        if (textBytes + pointBytes > 256 * 1024) break
        fragment += point
        textBytes += pointBytes
        codePointEnd += 1
        utf16End += point.length
      }
      if (fragment.length === 0 && utf16End < text.length && events.length > 0) break
      if (fragment.length === 0 && utf16End < text.length) fail('AGENT_BUDGET_EXCEEDED')
      events.push({ eventOrder, segmentId, codePointStart, codePointEnd, text: fragment })
      if (utf16End < text.length) {
        nextCursor = { afterEventOrder: eventOrder - 1, codePointOffset: codePointEnd, utf16Offset: utf16End }
        stoppedWithinSegment = true
        break
      }
      nextCursor = { afterEventOrder: eventOrder, codePointOffset: 0, utf16Offset: 0 }
      if (events.length >= 500) break
    }
    return {
      source: { ...request.source },
      startedAt: Number(session.started_at),
      endedAt: Number(session.ended_at),
      events,
      textBytes,
      nextCursor,
      done: !stoppedWithinSegment && rows.length < 500 && events.length === rows.length
    }
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
        (source.recipeVersion !== '1' && !(source.recipeId === 'qa.answer' && ['2', '3', '4', '5'].includes(source.recipeVersion))) || source.scopeKind !== 'session' ||
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

  getToolContextSourceRows (sourceRef, kind, afterEventOrder, limit) {
    return this.database.prepare(`
      SELECT event_order, text FROM caption_events
      WHERE session_id = ? AND kind = ? AND event_order >= ?
        AND event_order > ? AND event_order <= ?
      ORDER BY event_order ASC LIMIT ?
    `).all(
      sourceRef.sessionId, kind, sourceRef.fromEventOrder,
      afterEventOrder, sourceRef.throughEventOrder, limit
    )
  }

  *readToolContextSteps (input) {
    const hybrid = input.schemaVersion === 2
    assertExactKeys(input, hybrid ? ['runId', 'schemaVersion', 'query', 'memoryIds'] : ['runId'], 'AGENT_REQUEST_INVALID')
    if (hybrid && (typeof input.query !== 'string' || !input.query.trim() || Buffer.byteLength(input.query) > 4096 || !Array.isArray(input.memoryIds) || input.memoryIds.length > MAX_ITEMS)) fail('AGENT_REQUEST_INVALID')
    if (hybrid) input.memoryIds.forEach(value => identifier(value))
    const runId = identifier(input.runId)
    const run = this.database.prepare(`
      SELECT scope_json, transcript_version, input_watermark_json, input_digest,
        requested_by, personal_context_revision, recipe_id, recipe_version, summary_use_memory
      FROM formal_agent_runs WHERE run_id = ?
    `).get(runId)
    if (!run) fail('AGENT_RUN_NOT_FOUND')
    if (hybrid && (run.recipe_id !== 'qa.answer' || run.recipe_version !== '5')) fail('AGENT_REQUEST_INVALID')
    let scope
    try { scope = JSON.parse(run.scope_json) } catch { fail('STORAGE_COMMAND_FAILED') }
    if (!isPlainObject(scope) || (!hybrid && scope.kind !== 'session') || typeof scope.reference !== 'string') {
      fail('AGENT_REQUEST_INVALID')
    }
    const sessionId = scope.kind === 'session' ? identifier(scope.reference) : null
    let watermark
    try { watermark = JSON.parse(run.input_watermark_json) } catch { fail('STORAGE_COMMAND_FAILED') }
    if ((!hybrid || scope.kind === 'session') && (!isPlainObject(watermark) || !Number.isSafeInteger(watermark.throughEventOrder) || watermark.throughEventOrder < 1)) {
      fail('AGENT_REQUEST_INVALID')
    }
    const personalContextRevision = Number(run.personal_context_revision)
    if (!Number.isSafeInteger(personalContextRevision) || personalContextRevision < 0) fail('STORAGE_COMMAND_FAILED')
    const useMemory = (!this.automaticPolicy || this.automaticPolicy.agentEnabled && this.automaticPolicy.memoryEnabled) && (run.recipe_id !== 'summary.minutes' || run.summary_use_memory === undefined || run.summary_use_memory !== 0)
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
    const boundedScope = hybrid ? require('./personal-memory-index-store').scopeFilter(scope) : null
    const scopeSql = hybrid ? boundedScope.sql : `scope.kind = 'global' OR (scope.kind = 'session' AND scope.session_id = ?) OR
      EXISTS (SELECT 1 FROM personal_context_session_associations AS association
        JOIN personal_context_episodes AS episode ON episode.episode_id=association.episode_id
        WHERE association.memory_id=item.memory_id AND association.revision_id=item.current_revision_id
          AND item.origin='explicit' AND episode.lifecycle='active' AND episode.session_id=?)`
    const items = this.database.prepare(`
      SELECT item.memory_id, item.current_revision_id, item.semantic_key, item.kind, item.content_json
      FROM personal_context_items AS item
      JOIN personal_context_scopes AS scope ON scope.scope_id = item.scope_id
      WHERE item.lifecycle = 'active' AND scope.lifecycle='active' AND (${scopeSql})
      ${hybrid ? `AND item.memory_id IN (${input.memoryIds.length ? input.memoryIds.map(() => '?').join(',') : "''"})` : ''}
      ORDER BY item.updated_at DESC, item.memory_id ASC LIMIT ?
    `).all(...(hybrid ? boundedScope.args : [sessionId, sessionId]), ...(hybrid ? input.memoryIds : []), MAX_ITEMS + 1)
    if (items.length > MAX_ITEMS) fail('AGENT_BUDGET_EXCEEDED')

    const sourceByKey = new Map()
    const entries = []
    let sourceTextBytes = 0
    let displayTextBytes = 0
    for (const item of items) {
      if (!memoryReadable(this.database, item)) continue
      if (typeof item.current_revision_id !== 'string') {
        yield null
        continue
      }
      const evidenceRows = this.database.prepare(`
        SELECT session_id, transcript_version, from_event_order, through_event_order
        FROM personal_context_evidence
        WHERE memory_id = ? AND source_kind = 'session'
        ORDER BY created_at ASC, evidence_id ASC LIMIT ?
      `).all(item.memory_id, MAX_SOURCES_PER_ITEM + 1)
      for (const association of this.sessionAssociations(sessionId, item.memory_id)) {
        evidenceRows.push({ session_id: association.sourceRef.sessionId, transcript_version: association.sourceRef.transcriptVersion,
          from_event_order: association.sourceRef.fromEventOrder, through_event_order: association.sourceRef.throughEventOrder })
      }
      if (evidenceRows.length > MAX_SOURCES_PER_ITEM) {
        yield null
        continue
      }
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
          let afterEventOrder = sourceRef.fromEventOrder - 1
          const textParts = []
          while (true) {
            const rows = this.getToolContextSourceRows(
              sourceRef, kind, afterEventOrder, SESSION_INPUT_PAGE_SIZE
            )
            if (rows.length === 0) break
            for (const row of rows) {
              sourceTextBytes += Buffer.byteLength(row.text, 'utf8') + (textParts.length > 0 ? 1 : 0)
              if (sourceTextBytes > MAX_CANONICAL_BYTES) fail('AGENT_BUDGET_EXCEEDED')
              textParts.push(row.text)
              afterEventOrder = Number(row.event_order)
              yield null
            }
            if (rows.length < SESSION_INPUT_PAGE_SIZE) break
          }
          if (textParts.length === 0) fail('AGENT_INPUT_CHANGED')
          sourceByKey.set(key, { sourceRef, text: textParts.join(' ') })
        }
        sourceRefs.push(sourceRef)
        yield null
      }
      let displayText
      try { displayText = memoryContent(this.database, item).displayText } catch { fail('STORAGE_COMMAND_FAILED') }
      displayTextBytes += Buffer.byteLength(displayText, 'utf8')
      if (displayTextBytes > MAX_CANONICAL_BYTES) fail('AGENT_BUDGET_EXCEEDED')
      entries.push({
        aliasKey: item.semantic_key,
        memoryRef: { memoryId: item.memory_id, revisionId: item.current_revision_id },
        kind: item.kind,
        displayText,
        sourceRefs
      })
      yield null
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

  readToolContext (input) {
    const steps = this.readToolContextSteps(input)
    let step = steps.next()
    while (!step.done) step = steps.next()
    return step.value
  }

  async readToolContextPaged (input, options = {}) {
    const isCancelled = typeof options.isCancelled === 'function' ? options.isCancelled : () => false
    const checkCancelled = () => {
      if (isCancelled()) fail('AGENT_CANCELLED')
    }
    const steps = this.readToolContextSteps(input)
    checkCancelled()
    await new Promise((resolve) => setImmediate(resolve))
    checkCancelled()
    let batchSteps = 0
    while (true) {
      checkCancelled()
      const step = steps.next()
      if (step.done) {
        checkCancelled()
        return step.value
      }
      batchSteps += 1
      if (batchSteps >= SESSION_INPUT_PAGE_SIZE) {
        batchSteps = 0
        await new Promise((resolve) => setImmediate(resolve))
        checkCancelled()
      }
    }
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
    const { ingestRecipeVersion = '1', ...input } = request
    if (!['1', '2', '3'].includes(ingestRecipeVersion)) fail('AGENT_REQUEST_INVALID')
    const source = this.deriveSessionSource(input)
    return this.prepareSessionIngest({ ...source, ingestRecipeVersion })
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
    const { ingestRecipeVersion = '1', ...signal } = request
    if (!['1', '2'].includes(ingestRecipeVersion)) fail('AGENT_REQUEST_INVALID')
    return this.prepareInteractionIngest({ ...this.deriveInteractionSignalSource(signal), ingestRecipeVersion })
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
          WHERE requested_by = 'automatic' AND recipe_id IN ('context.ingest.session', 'context.ingest.interaction', 'context.synthesize')
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
          WHERE requested_by = 'automatic' AND recipe_id IN ('context.ingest.session', 'context.ingest.interaction', 'context.synthesize')
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
    // Published range products survive cancellation of the remaining work.
    if (this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='personal_context_experience_ranges'").get() &&
        this.database.prepare('SELECT 1 FROM personal_context_experience_ranges WHERE run_id=? LIMIT 1').get(runId)) return
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
    const recipeVersion = source.ingestRecipeVersion || '1'
    if (!['1', '2'].includes(recipeVersion)) fail('AGENT_REQUEST_INVALID')
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
    if (recipeVersion === '2') identity.ingestRecipeVersion = '2'
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
            error_code, result_digest, result_summary_json, created_at, updated_at, retry_policy_version
          ) VALUES (?, ?, NULL, ?, 'context.ingest.interaction', ?, ?, ?, ?, ?, ?, ?,
            'automatic', 'queued', 0, 5, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, 'agent-retry@1')
        `).run(
          runId, dedupeKey, requestDigest, recipeVersion,
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

  confirmedIngestMemories (sessionId) {
    if (this.automaticPolicy && (!this.automaticPolicy.agentEnabled || !this.automaticPolicy.memoryEnabled)) return []
    const rows = this.database.prepare(`SELECT item.*,scope.kind AS scope_kind,scope.canonical_key FROM personal_context_items AS item
      JOIN personal_context_scopes AS scope ON scope.scope_id=item.scope_id
      WHERE item.origin='explicit' AND item.lifecycle='active' AND scope.lifecycle='active'
        AND (scope.kind<>'session' OR scope.session_id=?) ORDER BY item.updated_at DESC,item.memory_id LIMIT 21
    `).all(sessionId)
    const items = []
    let bytes = 0
    for (const row of rows.slice(0, 20)) {
      if (!memoryReadable(this.database, row)) continue
      const content = memoryContent(this.database, row)
      const entityKeys = [...new Set([...(content.entityKeys || []),
        ...(['project', 'topic'].includes(row.scope_kind) ? [row.canonical_key.slice(row.scope_kind.length + 1)] : [])].map(normalizeSemanticKey))].slice(0, 8)
      const item = { memoryRef: { memoryId: row.memory_id, revisionId: row.current_revision_id }, kind: row.kind,
        scopeKind: row.scope_kind, entityKeys, displayText: content.displayText }
      const size = Buffer.byteLength(canonicalize(item), 'utf8')
      if (bytes + size > 8192) break
      bytes += size
      items.push(item)
    }
    return items
  }

  attachIngestMemories (input, source) {
    if (!source.ingestRunId) return input
    const row = this.database.prepare(`SELECT run.*,frozen.memories_json FROM formal_agent_runs AS run
      JOIN personal_context_ingest_inputs AS frozen ON frozen.run_id=run.run_id WHERE run.run_id=?
    `).get(source.ingestRunId)
    if (!row || row.recipe_id !== 'context.ingest.session' || !['2', '3'].includes(row.recipe_version) ||
      JSON.parse(row.scope_json).reference !== source.sessionId || row.input_digest !== source.inputDigest ||
      row.transcript_version !== source.transcriptVersion || JSON.parse(row.input_watermark_json).throughEventOrder !== source.inputWatermark) fail('AGENT_INPUT_CHANGED')
    const memories = JSON.parse(row.memories_json).map((item) => {
      const current = this.database.prepare(`SELECT item.* FROM personal_context_items AS item
        JOIN personal_context_scopes AS scope ON scope.scope_id=item.scope_id WHERE item.memory_id=? AND scope.lifecycle='active'`).get(item.memoryRef.memoryId)
      if (!current || !memoryReadable(this.database, current) || current.origin !== 'explicit' || current.lifecycle !== 'active' || current.current_revision_id !== item.memoryRef.revisionId) fail('AGENT_INPUT_CHANGED')
      return { ...item, displayText: memoryContent(this.database, current).displayText }
    })
    return { ...input, confirmedMemories: memories }
  }

  sessionAssociations (sessionId = null, memoryId = null) {
    if (this.automaticPolicy && (!this.automaticPolicy.agentEnabled || !this.automaticPolicy.memoryEnabled)) return []
    return this.database.prepare(`SELECT association.*,episode.session_id,episode.transcript_version,episode.input_watermark,episode.input_digest
      FROM personal_context_session_associations AS association
      JOIN personal_context_episodes AS episode ON episode.episode_id=association.episode_id
      JOIN personal_context_items AS memory ON memory.memory_id=association.memory_id
      JOIN personal_context_scopes AS scope ON scope.scope_id=memory.scope_id
      WHERE episode.lifecycle='active' AND memory.lifecycle='active' AND memory.origin='explicit' AND scope.lifecycle='active'
        AND memory.current_revision_id=association.revision_id
        AND (? IS NULL OR episode.session_id=?) AND (? IS NULL OR memory.memory_id=?)
      ORDER BY association.created_at DESC,association.association_id LIMIT 32
    `).all(sessionId, sessionId, memoryId, memoryId).filter(row => memoryReadable(this.database, this.memoryRow(row.memory_id))).map((row) => ({
      associationId: row.association_id, memoryRef: { memoryId: row.memory_id, revisionId: row.revision_id },
      matchKeys: JSON.parse(row.match_keys_json), relation: row.relation, sourceRef: JSON.parse(row.source_ref_json),
      inputWatermark: Number(row.input_watermark), inputDigest: row.input_digest
    }))
  }

  prepareSessionIngest (source) {
    const { ingestRecipeVersion: recipeVersion = '1', ...frozenSource } = source
    if (!['1', '2', '3'].includes(recipeVersion)) fail('AGENT_REQUEST_INVALID')
    source = frozenSource
    if (recipeVersion === '3') {
      if (source.transcriptVersion !== undefined && source.transcriptVersion !== 'raw') fail('AGENT_REQUEST_INVALID')
      source = { ...source, transcriptVersion: 'raw' }
    }
    const snapshot = this.sessionSnapshot(source, { allowRefinedFallback: true })
    const identity = {
      recipeId: 'context.ingest.session', sourceKind: 'session',
      sessionId: snapshot.sessionId, transcriptVersion: snapshot.transcriptVersion,
      inputWatermark: snapshot.inputWatermark, inputDigest: snapshot.inputDigest
    }
    if (recipeVersion !== '1') identity.ingestRecipeVersion = recipeVersion
    const dedupeKey = sha256Canonical(identity)
    const requestDigest = sha256Canonical({ identity })
    const runId = `run.${dedupeKey.slice(0, 48)}`
    const episodeId = `episode.${dedupeKey.slice(0, 44)}`
    const scopeId = `scope.${sha256Canonical({ kind: 'session', reference: snapshot.sessionId }).slice(0, 48)}`
    const existing = this.database.prepare('SELECT * FROM formal_agent_runs WHERE dedupe_key=?').get(dedupeKey)
    const existingEpisode = this.database.prepare(`
      SELECT * FROM personal_context_episodes WHERE source_kind='session' AND ingest_run_id=?
    `).get(runId)
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
            error_code, result_digest, result_summary_json, created_at, updated_at, retry_policy_version
          ) VALUES (?, ?, NULL, ?, 'context.ingest.session', ?, ?, ?, ?, ?, ?, ?,
            'automatic', 'queued', 0, 5, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, 'agent-retry@1')
        `).run(
          runId, dedupeKey, requestDigest, recipeVersion, canonicalize({ kind: 'session', reference: snapshot.sessionId }),
          sha256Canonical({ kind: 'session', reference: snapshot.sessionId }), snapshot.transcriptVersion,
          canonicalize({ throughEventOrder: snapshot.inputWatermark }), snapshot.inputDigest,
          personalContextRevision, now, now, now
        )
        if (recipeVersion !== '1') {
          const frozen = this.confirmedIngestMemories(snapshot.sessionId).map(({ displayText, ...item }) => item)
          this.database.prepare('INSERT INTO personal_context_ingest_inputs(run_id,memories_json) VALUES (?,?)').run(runId, canonicalize(frozen))
        }
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

  commitSessionIngest (input, rangeCommit = null) {
    assertExactKeys(input, ['runId', 'attemptIdentity', 'output'], 'AGENT_REQUEST_INVALID')
    const attempt = this.ingestAttempt(input.attemptIdentity)
    identifier(input.runId)
    if (attempt.runId !== input.runId) fail('AGENT_REQUEST_INVALID')
    const database = this.database
    if (!rangeCommit) database.exec('BEGIN IMMEDIATE')
    try {
      const run = database.prepare('SELECT * FROM formal_agent_runs WHERE run_id=?').get(input.runId)
      if (!run) fail('AGENT_CONTEXT_NOT_FOUND')
      try { validateRecipeOutput('context.ingest.session', run.recipe_version, input.output) } catch { fail('AGENT_OUTPUT_INVALID') }
      if (run.recipe_version === '3' && (!rangeCommit || input.output.stage !== 'range')) fail('AGENT_REQUEST_INVALID')
      const episode = database.prepare(`
        SELECT * FROM personal_context_episodes WHERE ingest_run_id=? AND source_kind='session'
      `).get(input.runId)
      if (!episode) fail('AGENT_CONTEXT_OPERATION_FAILED')
      if (run.state === 'succeeded') {
        if (!rangeCommit) database.exec('COMMIT')
        return { runId: input.runId, state: 'succeeded', replayed: true, episodeId: episode.episode_id }
      }
      if (run.state === 'cancelled' || run.state === 'failed') fail('AGENT_CONTEXT_OPERATION_FAILED')
      this.assertActiveFormalAttempt(run, attempt, this.nowValue(), { allowPreviouslyRenewedLease: true })
      const now = this.nowValue()
      const snapshot = rangeCommit?.snapshot || this.sessionInput({
        sourceKind: 'session', sessionId: episode.session_id, transcriptVersion: episode.transcript_version,
        inputWatermark: Number(episode.input_watermark), inputDigest: episode.input_digest
      })
      const output = run.recipe_version === '3' ? input.output.content : input.output
      const validRef = (ref) => ref.sessionId === snapshot.sessionId && ref.transcriptVersion === snapshot.transcriptVersion &&
        ref.fromEventOrder >= snapshot.fromEventOrder && ref.throughEventOrder <= snapshot.throughEventOrder &&
        (!rangeCommit || rangeCommit.validRef(ref))
      for (const experience of output.experiences) {
        if (!validRef(experience.evidence)) fail('AGENT_OUTPUT_INVALID')
      }
      for (const candidate of output.memoryCandidates) {
        if (!validRef(candidate.evidence)) fail('AGENT_OUTPUT_INVALID')
      }
      if (run.recipe_version !== '1') {
        const frozen = this.attachIngestMemories(snapshot, { ...snapshot, ingestRunId: input.runId }).confirmedMemories
        for (const association of output.associations) {
          const memory = frozen.find((item) => item.memoryRef.memoryId === association.memoryRef.memoryId && item.memoryRef.revisionId === association.memoryRef.revisionId)
          if (!memory || !validRef(association.evidence)) fail('AGENT_OUTPUT_INVALID')
          const keys = association.matchKeys.map(normalizeSemanticKey)
          if (keys.some((key) => !memory.entityKeys.includes(key))) fail('AGENT_OUTPUT_INVALID')
          const evidenceText = snapshot.events.filter((event) => event.eventOrder >= association.evidence.fromEventOrder && event.eventOrder <= association.evidence.throughEventOrder)
            .map((event) => event.text.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/gu, ' ')).join(' ')
          for (const key of keys) {
            const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            if (!new RegExp(`${/^[a-z0-9]/u.test(key) ? '(?<![a-z0-9])' : ''}${escaped}${/[a-z0-9]$/u.test(key) ? '(?![a-z0-9])' : ''}`, 'u').test(evidenceText)) fail('AGENT_OUTPUT_INVALID')
          }
          const sourceRef = association.evidence
          database.prepare(`INSERT OR IGNORE INTO personal_context_session_associations
            (association_id,episode_id,memory_id,revision_id,match_keys_json,relation,source_ref_json,created_at) VALUES (?,?,?,?,?,?,?,?)
          `).run(`association.${sha256Canonical({ episodeId: episode.episode_id, memoryRef: association.memoryRef, sourceRef, keys }).slice(0, 44)}`,
            episode.episode_id, memory.memoryRef.memoryId, memory.memoryRef.revisionId, canonicalize(keys), association.relation, canonicalize(sourceRef), now)
        }
      }
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
        if (database.prepare("SELECT 1 FROM personal_context_suppressions WHERE identity_hash=? AND source_digest=? UNION ALL SELECT 1 FROM personal_memory_portable_records WHERE record_type='suppression' AND json_extract(payload_json,'$.identity_hash')=? AND json_extract(payload_json,'$.source_digest')=? LIMIT 1").get(identityHash, snapshot.inputDigest, identityHash, snapshot.inputDigest)) {
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
            ) VALUES (?, ?, ?, 'session', ?, NULL, ?, ?, ?, ?, ?, 'context.ingest.session', ?, ?)
            ON CONFLICT DO NOTHING
          `).run(
            `evidence.${sha256Canonical({ runId: input.runId, memoryId: memory.memory_id, ref }).slice(0, 44)}`,
            input.runId, memory.memory_id, snapshot.sessionId, snapshot.transcriptVersion,
            snapshot.inputWatermark, ref.fromEventOrder, ref.throughEventOrder, snapshot.inputDigest, run.recipe_version, now
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
      if (acceptedCandidateCount > 0 || bullets.length > 0 || output.associations?.length > 0) this.advanceRevision({ operation: 'ingest', runId: input.runId, episodeId: episode.episode_id })
      if (rangeCommit) rangeCommit.publish(episode, output)
      else database.exec('COMMIT')
      return { runId: input.runId, state: 'committed', replayed: false, episodeId: episode.episode_id, ...result }
    } catch (error) {
      if (!rangeCommit) rollbackQuietly(database)
      throw error
    }
  }

  sessionExperiences (request) {
    return require('./session-experience-store').operate(this, request)
  }

  questionEvidence (request) {
    return require('./question-retrieval-store').operate(this, request)
  }

  commitInteractionIngest (input) {
    assertExactKeys(input, ['runId', 'attemptIdentity', 'output', ...(Object.hasOwn(input, 'userText') ? ['userText'] : [])], 'AGENT_REQUEST_INVALID')
    const attempt = this.ingestAttempt(input.attemptIdentity)
    identifier(input.runId)
    if (attempt.runId !== input.runId) fail('AGENT_REQUEST_INVALID')
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      const run = database.prepare('SELECT * FROM formal_agent_runs WHERE run_id=?').get(input.runId)
      if (!run || run.recipe_id !== 'context.ingest.interaction') fail('AGENT_CONTEXT_NOT_FOUND')
      try { validateRecipeOutput('context.ingest.interaction', run.recipe_version, input.output) } catch { fail('AGENT_OUTPUT_INVALID') }
      if (run.recipe_version === '1' && Object.hasOwn(input, 'userText')) fail('AGENT_REQUEST_INVALID')
      const episode = database.prepare(`
        SELECT * FROM personal_context_episodes WHERE ingest_run_id=? AND source_kind='interaction'
      `).get(input.runId)
      if (!episode) fail('AGENT_CONTEXT_OPERATION_FAILED')
      if (run.state === 'succeeded') {
        database.exec('COMMIT')
        return { runId: input.runId, state: 'succeeded', replayed: true, episodeId: episode.episode_id }
      }
      if (run.state === 'cancelled' || run.state === 'failed') fail('AGENT_CONTEXT_OPERATION_FAILED')
      this.assertActiveFormalAttempt(run, attempt, this.nowValue(), { allowPreviouslyRenewedLease: true })
      let storedSummary
      try { storedSummary = JSON.parse(episode.summary_json) } catch { fail('STORAGE_COMMAND_FAILED') }
      const signalRef = { interactionId: episode.interaction_id, signalKind: storedSummary.signalKind }
      let userSource = null
      if (run.recipe_version === '2') {
        if (!Object.hasOwn(input, 'userText')) fail('AGENT_REQUEST_INVALID')
        const userText = input.userText === null ? null : interactionSignalText(input.userText)
        const signalKind = storedSummary.signalKind
        if (signalKind === 'prompt') {
          if (userText === null || sha256Canonical(userText) !== storedSummary.promptDigest) fail('AGENT_INPUT_CHANGED')
        } else if (['edit', 'remember'].includes(signalKind)) {
          if (userText === null || sha256Canonical({ text: userText }) !== storedSummary.payloadDigest) fail('AGENT_INPUT_CHANGED')
        } else if (userText !== null) fail('AGENT_REQUEST_INVALID')
        userSource = questionSource({ signalKind, prompt: signalKind === 'prompt' ? userText : null, editText: ['edit', 'remember'].includes(signalKind) ? userText : null, result: null })
        if (input.output.questionSummary !== null && userText !== null &&
            input.output.questionSummary.replace(/[\s。.!?！？]/gu, '') === userText.replace(/[\s。.!?！？]/gu, '')) fail('AGENT_OUTPUT_INVALID')
      }
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
        if (run.recipe_version === '2' && !allowsQuestionCandidate(candidate, userSource)) {
          discardedCandidateCount += 1
          continue
        }
        if (candidate.salience === 'low' || (candidate.confidence === 'low' && candidate.kind !== 'preference')) {
          discardedCandidateCount += 1
          continue
        }
        const semanticKey = normalizeSemanticKey(candidate.content)
        const targetScope = this.ingestScope(candidate, scope.session_id, now)
        if (!targetScope) fail('AGENT_OUTPUT_INVALID')
        const identityHash = sha256Canonical({ scopeId: targetScope.scope_id, kind: candidate.kind, semanticKey })
        if (database.prepare("SELECT 1 FROM personal_context_suppressions WHERE identity_hash=? AND source_digest=? UNION ALL SELECT 1 FROM personal_memory_portable_records WHERE record_type='suppression' AND json_extract(payload_json,'$.identity_hash')=? AND json_extract(payload_json,'$.source_digest')=? LIMIT 1").get(identityHash, episode.input_digest, identityHash, episode.input_digest)) {
          discardedCandidateCount += 1
          continue
        }
        let patternEpisodes = null
        if (run.recipe_version === '2' && candidate.attribution === 'repeated_pattern') {
          if (storedSummary.signalKind !== 'prompt') { discardedCandidateCount += 1; continue }
          database.prepare(`INSERT OR IGNORE INTO personal_context_question_evidence
            (identity_hash,prompt_digest,ingest_run_id,episode_id,created_at) VALUES (?,?,?,?,?)
          `).run(identityHash, storedSummary.promptDigest, input.runId, episode.episode_id, now)
          patternEpisodes = database.prepare(`SELECT episode.* FROM personal_context_question_evidence AS question
            JOIN personal_context_episodes AS episode ON episode.episode_id=question.episode_id
            WHERE question.identity_hash=? AND episode.lifecycle='active' ORDER BY question.created_at,question.prompt_digest LIMIT 8
          `).all(identityHash)
          if (patternEpisodes.length < 2) { discardedCandidateCount += 1; continue }
        }
        let contentJson = canonicalize({ displayText: candidate.content,
          ...(run.recipe_version === '2' ? { attribution: candidate.attribution, entityKeys: candidate.entityKeys.map(normalizeSemanticKey) } : {}) })
        let memory = database.prepare('SELECT * FROM personal_context_items WHERE scope_id=? AND kind=? AND semantic_key=?').get(targetScope.scope_id, candidate.kind, semanticKey)
        if (memory && memory.origin === 'explicit') {
          if (!memoryReadable(this.database, memory) || memoryContent(this.database, memory).displayText !== candidate.content) { discardedCandidateCount += 1; continue }
          contentJson = memory.content_json
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
        for (const sourceEpisode of patternEpisodes || [episode]) {
          const sourceSignal = { interactionId: sourceEpisode.interaction_id, signalKind: JSON.parse(sourceEpisode.summary_json).signalKind }
          const inserted = database.prepare(`
          INSERT INTO personal_context_evidence(
            evidence_id, ingest_run_id, memory_id, source_kind, session_id, interaction_id,
            transcript_version, input_watermark, from_event_order, through_event_order,
            input_digest, recipe_id, recipe_version, created_at
          ) VALUES (?, ?, ?, 'interaction', NULL, ?, ?, ?, 1, ?, ?, 'context.ingest.interaction', ?, ?)
          ON CONFLICT DO NOTHING
        `).run(
          `evidence.${sha256Canonical({ runId: sourceEpisode.ingest_run_id, memoryId: memory.memory_id, signalRef: sourceSignal }).slice(0, 44)}`,
          sourceEpisode.ingest_run_id, memory.memory_id, sourceEpisode.interaction_id, sourceEpisode.transcript_version,
          Number(sourceEpisode.input_watermark), Number(sourceEpisode.through_event_order), sourceEpisode.input_digest, run.recipe_version, now
        )
        evidenceCount += Number(inserted.changes)
        }
        acceptedCandidateCount += 1
        touched.add(memory.memory_id)
      }
      const bullets = output.experiences.slice(0, 8).map((experience) => experience.text)
      const summary = {
        ...storedSummary,
        ...(run.recipe_version === '2' ? { questionSummary: output.questionSummary } : {}),
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
          error_code, result_digest, result_summary_json, created_at, updated_at, retry_policy_version
        ) VALUES (?, ?, NULL, ?, 'context.ingest.session', '1', ?, ?, ?, ?, ?, ?,
          'automatic', 'succeeded', 1, 5, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?, 'agent-retry@1')
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
        CASE WHEN scope.kind = 'global' THEN NULL WHEN scope.kind='session' THEN scope.session_id ELSE scope.scope_id END AS scope_reference,
        (SELECT COUNT(*) FROM personal_context_evidence AS evidence WHERE evidence.memory_id = item.memory_id) AS source_reference_count
      FROM personal_context_items AS item
      JOIN personal_context_scopes AS scope ON scope.scope_id = item.scope_id
      WHERE item.memory_id = ?
    `).get(memoryId)
  }

  manage (command) {
    if (!isPlainObject(command) || typeof command.type !== 'string') fail('AGENT_REQUEST_INVALID')
    if (command.type === 'source') return this.sourceLocation(command)
    if (command.type === 'synthesize') return this.overview.manage(command)
    if (command.type === 'view_item') {
      assertExactKeys(command, ['type', 'item_id'], 'AGENT_REQUEST_INVALID'); identifier(command.item_id)
      const row = this.memoryRow(command.item_id)
      if (!row) fail('AGENT_CONTEXT_NOT_FOUND')
      return { revision: this.contentRevision(), rows: [{ ...publicItem(row, this.database), sources: this.memorySources(row) }], hasMore: false, nextCursor: null }
    }
    if (command.type === 'refresh_overview') {
      assertExactKeys(command, ['type', 'expected_revision'], 'AGENT_REQUEST_INVALID'); this.assertRevision(command.expected_revision)
      return { revision: this.contentRevision(), scheduled: this.overview.prepare(true).preparedCount > 0 }
    }
    if (command.type === 'memory_inputs') {
      assertExactKeys(command, ['type', 'refs', ...(Object.hasOwn(command, 'sessionId') ? ['sessionId'] : [])], 'AGENT_REQUEST_INVALID')
      if (command.sessionId !== undefined && command.sessionId !== null) identifier(command.sessionId)
      if (!Array.isArray(command.refs) || command.refs.length > 20) fail('AGENT_REQUEST_INVALID')
      return command.refs.map((ref) => {
        try { require('../../agent/contracts/recipes').assertMemoryRef(ref) } catch { fail('AGENT_REQUEST_INVALID') }
        const row = this.memoryRow(ref.memoryId)
        if (!row || !memoryReadable(this.database, row) || row.lifecycle !== 'active' || row.current_revision_id !== ref.revisionId) return { memory_ref: ref, availability: 'removed', display_text: null, sources: [], associations: [] }
        return { memory_ref: ref, availability: 'accessible', display_text: memoryContent(this.database, row).displayText, sources: this.memorySources(row),
          associations: this.sessionAssociations(command.sessionId ?? null, row.memory_id).map((item) => ({ memory_id: item.memoryRef.memoryId, relation: item.relation, match_keys: item.matchKeys, target: {
            kind: 'session', reference: item.sourceRef.sessionId, transcript_version: item.sourceRef.transcriptVersion, from_event_order: item.sourceRef.fromEventOrder, through_event_order: item.sourceRef.throughEventOrder } })) }
      })
    }
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
          CASE WHEN scope.kind = 'global' THEN NULL WHEN scope.kind='session' THEN scope.session_id ELSE scope.scope_id END AS scope_reference,
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
        rows: pageRows.map((row) => ({ ...publicItem(row, this.database), sources: this.memorySources(row) }))
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
        CASE WHEN scope.kind = 'global' THEN NULL WHEN scope.kind='session' THEN scope.session_id ELSE scope.scope_id END AS scope_reference
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
        updatedAt: Number(row.updated_at),
        sources: [this.episodeSource(row)], associations: this.sessionAssociations(row.session_id).filter((item) => item.sourceRef.sessionId === row.session_id).map((item) => ({ memory_id: item.memoryRef.memoryId, relation: item.relation, match_keys: item.matchKeys }))
      }
    })
    const last = rows.slice(0, command.limit).at(-1)
    return {
      revision: this.contentRevision(), totalCount, hasMore,
      nextCursor: hasMore ? encodePageCursor(command.resource, Number(last.updated_at), last.episode_id) : null,
      rows: pageRows
    }
  }

  episodeSource (row) {
    const summary = JSON.parse(row.summary_json)
    if (row.source_kind === 'interaction') {
      const interaction = this.database.prepare('SELECT created_at FROM formal_agent_interactions WHERE interaction_id=?').get(row.interaction_id)
      return { occurred_at: new Date(Number(interaction?.created_at || row.created_at)).toISOString(),
        summary: summary.questionSummary || '原始问题未保留；此记录没有提问摘要。',
        summary_kind: summary.questionSummary ? 'question_summary' : 'missing_summary', availability: interaction ? 'accessible' : 'removed',
        target: interaction ? { kind: 'interaction', reference: row.interaction_id, transcript_version: null, from_event_order: null, through_event_order: null } : null }
    }
    const event = this.database.prepare(`SELECT text,t0_ms FROM caption_events WHERE session_id=? AND event_order BETWEEN ? AND ? AND kind=? ORDER BY event_order LIMIT 1`)
      .get(row.session_id, Number(row.from_event_order), Number(row.through_event_order), row.transcript_version === 'raw' ? 'final' : 'refined')
    const session = this.database.prepare('SELECT started_at FROM sessions WHERE session_id=?').get(row.session_id)
    return { occurred_at: new Date(Number(session?.started_at || row.created_at) + Number(event?.t0_ms || 0)).toISOString(),
      summary: event ? Array.from(event.text).slice(0, 160).join('') : '来源记录已删除。', summary_kind: 'transcript_excerpt',
      availability: event ? 'accessible' : 'removed', target: event ? { kind: 'session', reference: row.session_id, transcript_version: row.transcript_version,
        from_event_order: Number(row.from_event_order), through_event_order: Number(row.through_event_order) } : null }
  }

  memorySources (row) {
    const sources = []
    if (row.origin === 'explicit') sources.push({ occurred_at: new Date(Number(row.updated_at)).toISOString(),
      summary: Array.from(memoryContent(this.database, row).displayText).slice(0, 160).join(''), summary_kind: 'user_statement', availability: 'accessible', target: null })
    const episodes = this.database.prepare(`SELECT episode.*,evidence.from_event_order AS evidence_from,evidence.through_event_order AS evidence_through FROM personal_context_evidence AS evidence
      JOIN personal_context_episodes AS episode ON episode.ingest_run_id=evidence.ingest_run_id
      WHERE evidence.memory_id=? AND episode.lifecycle='active' ORDER BY evidence.created_at DESC LIMIT ?
    `).all(row.memory_id, 8 - sources.length)
    sources.push(...episodes.map((episode) => this.episodeSource({ ...episode,
      from_event_order: episode.evidence_from ?? episode.from_event_order, through_event_order: episode.evidence_through ?? episode.through_event_order })))
    if (sources.length < 8) sources.push(...require('./personal-memory-portability').portableMemorySources(this, row, 8 - sources.length))
    return sources
  }

  sourceLocation (command) {
    assertExactKeys(command, ['type', 'target'], 'AGENT_REQUEST_INVALID')
    try { require('../../agent/contracts/agent-context-ui').assertSourceTarget(command.target) } catch { fail('AGENT_REQUEST_INVALID') }
    const target = command.target
    if (target.kind === 'interaction') {
      const row = this.database.prepare("SELECT scope_json FROM formal_agent_interactions WHERE interaction_id=? AND requested_by='user'").get(target.reference)
      if (!row) fail('AGENT_CONTEXT_NOT_FOUND')
      return { target, scope: JSON.parse(row.scope_json), cursor: null, offset: 0 }
    }
    const matches = this.database.prepare(`SELECT DISTINCT segment.segment_id,origin.t0_ms,segment.first_event_order FROM caption_events AS event
      JOIN segments AS segment ON segment.session_id=event.session_id AND segment.source_id=event.source_id AND segment.segment_id=event.segment_id
      JOIN caption_events AS origin ON origin.event_order=segment.first_event_order
      WHERE event.session_id=? AND event.event_order BETWEEN ? AND ? AND event.kind=?
      ORDER BY origin.t0_ms,segment.first_event_order LIMIT 50
    `).all(target.reference, target.from_event_order, target.through_event_order, target.transcript_version === 'raw' ? 'final' : 'refined')
    const event = matches[0]
    if (!event) fail('AGENT_CONTEXT_NOT_FOUND')
    const previous = this.database.prepare(`SELECT origin.t0_ms,segment.first_event_order FROM segments AS segment
      JOIN caption_events AS origin ON origin.event_order=segment.first_event_order WHERE segment.session_id=?
      AND (origin.t0_ms<? OR (origin.t0_ms=? AND segment.first_event_order<?))
      ORDER BY origin.t0_ms DESC,segment.first_event_order DESC LIMIT 1
    `).get(target.reference, event.t0_ms, event.t0_ms, event.first_event_order)
    const offset = Number(this.database.prepare(`SELECT count(*) AS n FROM segments AS segment
      JOIN caption_events AS origin ON origin.event_order=segment.first_event_order WHERE segment.session_id=?
      AND (origin.t0_ms<? OR (origin.t0_ms=? AND segment.first_event_order<?))
    `).get(target.reference, event.t0_ms, event.t0_ms, event.first_event_order).n)
    return { target, scope: { kind: 'session', reference: target.reference }, cursor: previous ? { t0Ms: Number(previous.t0_ms), firstEventOrder: Number(previous.first_event_order) } : null, offset,
      highlightedSegmentIds: matches.map(row => row.segment_id) }
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
      if (existing && JSON.parse(existing.content_json).storage === 'markdown') fail('AGENT_CONTEXT_OPERATION_FAILED')
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
      const item = publicItem(this.memoryRow(memoryId), this.database)
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
    const oldContent = memoryContent(this.database, current)
    if (JSON.parse(current.content_json).storage === 'markdown') fail('AGENT_CONTEXT_OPERATION_FAILED')
    const contentJson = canonicalize({ ...(oldContent.displayText === entry.displayText ? oldContent : {}), displayText: entry.displayText })
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
      `).run(revisionId, command.item_id, contentJson, current.current_revision_id, now)
      this.database.prepare(`
        UPDATE personal_context_items SET scope_id = ?, kind = ?, semantic_key = ?, content_json = ?,
          origin = 'explicit', lifecycle = 'active', current_revision_id = ?, item_revision = ?, updated_at = ?
        WHERE memory_id = ?
      `).run(scopeId, entry.kind, entry.semanticKey, contentJson, revisionId, nextItemRevision, now, command.item_id)
      const revision = this.advanceRevision({ operation: 'update', memoryId: command.item_id, itemRevision: nextItemRevision })
      this.database.prepare('DELETE FROM personal_context_session_associations WHERE memory_id=?').run(command.item_id)
      const item = publicItem(this.memoryRow(command.item_id), this.database)
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
      this.database.prepare('DELETE FROM personal_context_session_associations WHERE memory_id=?').run(command.item_id)
      const item = publicItem(this.memoryRow(command.item_id), this.database)
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
      const fileMeta = fileCache(this.database).metadata.get(command.item_id)
      if (fileMeta) this.database.prepare('INSERT OR REPLACE INTO personal_memory_file_tombstones(memory_id,root_id,content_hash,created_at) VALUES (?,?,?,?)')
        .run(command.item_id, fileMeta.root_id, fileMeta.content_hash, now)
      if (fileMeta) this.database.prepare("INSERT OR REPLACE INTO personal_memory_file_cleanup(memory_id,root_id,relative_name,byte_hash,state) VALUES (?,?,?,?,'pending')")
        .run(command.item_id, fileMeta.root_id, fileMeta.relative_name, fileMeta.byte_hash)
      this.database.prepare('DELETE FROM personal_context_question_evidence WHERE identity_hash=?').run(identityHash)
      this.database.prepare(`
        UPDATE personal_context_items SET current_revision_id = NULL WHERE memory_id = ?
      `).run(command.item_id)
      this.database.prepare(`
        UPDATE personal_context_revisions SET previous_revision_id = NULL WHERE memory_id = ?
      `).run(command.item_id)
      this.database.prepare('DELETE FROM personal_context_evidence WHERE memory_id = ?').run(command.item_id)
      this.database.prepare('DELETE FROM personal_memory_portable_records WHERE memory_id=?').run(command.item_id)
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
        WHERE episode.lifecycle = 'active' AND scope.kind = 'project' AND (scope.scope_id=? OR scope.canonical_key = ?)
        ORDER BY episode.updated_at DESC, episode.episode_id ASC LIMIT ?
      `).all(reference, `project:${reference}`, MAX_ITEMS + 1)
    }

    let allowedSessionIds = null
    if (request.scope.kind === 'date_range') {
      allowedSessionIds = new Set(this.database.prepare(`
        SELECT session_id FROM sessions
        WHERE started_at <= ? AND COALESCE(ended_at, started_at) >= ?
      `).all(reference.through, reference.from).map((row) => row.session_id))
    }
    const requestedSessionId = request.scope.kind === 'selection' ? reference.session_id : reference
    const relatedMemoryIds = new Set(['session', 'selection'].includes(request.scope.kind) ? this.sessionAssociations(requestedSessionId).map((item) => item.memoryRef.memoryId) : [])
    const inRequestedScope = (row) => {
      if (row.scope_kind === 'global') return true
      if (request.scope.kind === 'session' || request.scope.kind === 'selection') {
        return (row.scope_kind === 'session' && row.scope_reference === requestedSessionId) || relatedMemoryIds.has(row.memory_id)
      }
      if (request.scope.kind === 'project') {
        return row.scope_kind === 'project' && (row.scope_id === reference || row.scope_reference === reference)
      }
      return row.scope_kind === 'session' && allowedSessionIds.has(row.scope_reference)
    }
    const candidateRows = this.database.prepare(`
      SELECT item.*, scope.kind AS scope_kind,
        CASE WHEN scope.kind = 'global' THEN NULL ELSE substr(scope.canonical_key, instr(scope.canonical_key, ':') + 1) END AS scope_reference,
        (SELECT COUNT(*) FROM personal_context_evidence AS evidence WHERE evidence.memory_id = item.memory_id) AS source_count
      FROM personal_context_items AS item
      JOIN personal_context_scopes AS scope ON scope.scope_id = item.scope_id
      WHERE item.lifecycle = 'active' AND scope.lifecycle='active'
      ORDER BY item.updated_at DESC, item.memory_id ASC
      LIMIT ?
    `).all(MAX_CANDIDATES + 1)
    let budgetOmitted = candidateRows.length > MAX_CANDIDATES
    const filtered = candidateRows.slice(0, MAX_CANDIDATES).filter((row) =>
      memoryReadable(this.database, row) && (!this.automaticPolicy || this.automaticPolicy.agentEnabled && this.automaticPolicy.memoryEnabled) && inRequestedScope(row) && (terms.size === 0 || terms.has(normalizeSemanticKey(row.semantic_key))))
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
        displayText: memoryContent(this.database, row).displayText,
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
    // Repeated style remains a candidate only while two independent questions
    // still support it. Explicit confirmation is its own current evidence.
    for (const row of this.database.prepare("SELECT * FROM personal_context_items WHERE origin='inferred' AND lifecycle='active' AND json_extract(content_json,'$.attribution')='repeated_pattern'").all()) {
      const identityHash = sha256Canonical({ scopeId: row.scope_id, kind: row.kind, semanticKey: row.semantic_key })
      const count = Number(this.database.prepare('SELECT count(*) AS n FROM personal_context_question_evidence WHERE identity_hash=?').get(identityHash).n)
      if (count < 2) this.database.prepare("UPDATE personal_context_items SET lifecycle='inactive',updated_at=? WHERE memory_id=?").run(now, row.memory_id)
    }
    if (plan.episodeCount > 0 || plan.evidenceCount > 0 || plan.orphanItemIds.length > 0) {
      this.advanceRevision({
        operation: 'delete-session-context', sessionId,
        deletedEpisodeCount: plan.episodeCount,
        deletedContextEvidenceCount: plan.evidenceCount,
        deletedOrphanContextItemCount: plan.orphanItemIds.length
      })
    }
  }

  failUnaccountedSessionSummaryRun (run, now, errorCode = 'AGENT_RUN_UNAVAILABLE') {
    const durableRunErrorCode = errorCode === 'AGENT_RUN_UNAVAILABLE' ? 'AGENT_INTERNAL_FAILURE' : errorCode
    this.database.prepare(`
      UPDATE formal_agent_runs SET state='failed',error_code=?,lease_owner=NULL,lease_expires_at=NULL,
        lease_renewed_from_expires_at=NULL,resume_required=0,result_digest=NULL,result_summary_json=NULL,updated_at=?
      WHERE run_id=? AND state IN ('queued','retry_wait','running')
    `).run(durableRunErrorCode, now, run.run_id)
    const interaction = this.database.prepare(`
      SELECT interaction_id FROM formal_agent_interactions WHERE run_id=? AND terminal_reason IS NULL
    `).get(run.run_id)
    if (interaction) {
      this.database.prepare(`
        UPDATE formal_agent_interactions SET terminal_reason='failed',error_code=?,usage_json=NULL,
          result_json=NULL,result_digest=NULL,terminal_at=? WHERE interaction_id=? AND terminal_reason IS NULL
      `).run(durableRunErrorCode, now, interaction.interaction_id)
      this.database.prepare(`
        UPDATE formal_agent_tool_calls SET ended_offset_ms=started_offset_ms,status='cancelled',
          error_code='TOOL_CANCELLED',result_json=NULL,result_digest=NULL
        WHERE interaction_id=? AND status='started'
      `).run(interaction.interaction_id)
    }
    if (typeof run.session_summary_request_id === 'string' || run.summary_input_policy === 'summary-long-input@1' || isLongInputRun(run)) {
      this.database.prepare(`
        UPDATE formal_agent_requests SET state='failed',phase='terminal',resume_required=0,
          error_code=?,revision=revision+1,updated_at=?
        WHERE request_id=? AND state NOT IN ('succeeded','failed','cancelled')
      `).run(errorCode, now, run.session_summary_request_id)
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
      if (row.recipe_id === 'context.synthesize') return {
        runId: row.run_id, recipeId: row.recipe_id, recipeVersion: row.recipe_version,
        interactionId: interaction?.interaction_id || null, requestedBy: 'automatic',
        source: { sourceKind: 'context', runId: row.run_id },
        attemptIdentity: { runId: row.run_id, attempt: Number(row.attempt_count), owner: receipt.lease_owner, leaseExpiresAt: Number(receipt.lease_expires_at) }
      }
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
          recipeVersion: row.recipe_version,
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
        recipeVersion: row.recipe_version,
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
      if (row.recipe_id === 'context.ingest.session' && ['2', '3'].includes(row.recipe_version)) result.source.ingestRunId = row.run_id
      if (typeof row.session_summary_request_id === 'string') {
        // Summary requests retain their existing source contract.
        const summaryRequest = this.database.prepare(`
          SELECT request_id,generation FROM formal_agent_requests WHERE request_id=?
        `).get(row.session_summary_request_id)
        if (summaryRequest) {
          result.sessionSummaryRequest = {
            requestId: summaryRequest.request_id,
            generation: Number(summaryRequest.generation)
          }
        }
      }
      if (typeof row.session_summary_request_id === 'string' || row.summary_input_policy === 'summary-long-input@1' || isLongInputRun(row)) {
        const budget = this.database.prepare(`
          SELECT * FROM formal_agent_run_budget_state WHERE run_id=?
        `).get(row.run_id)
        if (budget && Number(budget.accounting_known) === 1) {
          result.remainingWallClockMs = isLongBudgetPolicy(budget.policy_version)
            ? Math.min(remainingWallClockMs(budget), Math.max(0,
              60 * 60 * 1000 - Number(this.database.prepare(`
                SELECT settled_elapsed_ms + conservative_elapsed_ms AS elapsed
                FROM formal_agent_run_attempt_budgets WHERE run_id=? AND attempt=?
              `).get(row.run_id, Number(row.attempt_count))?.elapsed || 0)))
            : remainingWallClockMs(budget)
          const attemptBudget = this.database.prepare(`
            SELECT request_count,request_limit FROM formal_agent_run_attempt_budgets
            WHERE run_id=? AND attempt=?
          `).get(row.run_id, Number(row.attempt_count))
          if (attemptBudget) {
            result.requestCount = Number(attemptBudget.request_count)
            result.requestLimit = Number(attemptBudget.request_limit)
          }
        }
      }
      if (row.summary_input_policy) result.summaryInputPolicy = row.summary_input_policy
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
      let row = this.database.prepare(`
        SELECT * FROM formal_agent_runs
        WHERE requested_by = ? AND (
          (? = 'automatic' AND recipe_id IN ('context.ingest.session', 'context.ingest.interaction', 'context.synthesize')) OR
          (? = 'user' AND recipe_id IN ('summary.minutes', 'qa.answer'))
        ) AND (? = 1) AND attempt_count < max_attempts AND COALESCE(resume_required,0)=0 AND (
          session_summary_request_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM formal_agent_requests AS summary_request
            WHERE summary_request.request_id=formal_agent_runs.session_summary_request_id
              AND summary_request.resume_required=1
          )
        ) AND (
          (state IN ('queued', 'retry_wait') AND next_attempt_at <= ? AND cancel_requested_at IS NULL) OR
          (state = 'running' AND lease_expires_at <= ? AND cancel_requested_at IS NULL)
        )
        ORDER BY next_attempt_at, run_order LIMIT 1
      `).get(requestedBy, requestedBy, requestedBy, automaticPolicyAllowed ? 1 : 0, now, now)
      let leaseExpiresAt = null
      let budgetAccount = null
      let budgetRemainingWallClockMs = null
      if (row) {
        if ((requestedBy === 'user' && (typeof row.session_summary_request_id === 'string' || row.summary_input_policy === 'summary-long-input@1' || isLongInputRun(row))) ||
            (requestedBy === 'automatic' && row.recipe_id === 'context.ingest.session' && row.recipe_version === '3')) {
          budgetAccount = createRunBudgetAccount(this.database, { run: row, now })
          if (row.state === 'running') {
            interruptActiveAttempt(this.database, row.run_id, now)
            budgetAccount = this.database.prepare('SELECT * FROM formal_agent_run_budget_state WHERE run_id=?').get(row.run_id)
          }
          budgetRemainingWallClockMs = remainingWallClockMs(budgetAccount)
          if (Number(budgetAccount.accounting_known) !== 1 || budgetRemainingWallClockMs === null) {
            this.failUnaccountedSessionSummaryRun(row, now)
            row = null
          } else if (budgetRemainingWallClockMs <= 0) {
            this.failUnaccountedSessionSummaryRun(row, now, 'AGENT_BUDGET_EXCEEDED')
            row = null
          }
        }
      }
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
        if (budgetAccount) {
          const budgetAttempt = startAttemptBudget(this.database, {
            runId: row.run_id,
            attempt,
            owner: request.owner,
            leaseMs: request.leaseMs,
            account: budgetAccount,
            now
          })
          budgetRemainingWallClockMs = budgetAttempt.remainingWallClockMs
        }
        if (typeof row.session_summary_request_id === 'string') {
          const summaryRequest = this.database.prepare(`
            SELECT summary_use_memory FROM formal_agent_requests WHERE request_id=?
          `).get(row.session_summary_request_id)
          if (summaryRequest) {
            this.database.prepare(`
              UPDATE formal_agent_requests SET state='running',phase='preparing',attempt=?,
                validated_chunk_count=NULL,total_chunk_count=NULL,
                retry_request_attempt=NULL,retry_wait_ms=NULL,retry_reason=NULL,
                memory_state=?,revision=revision+1,updated_at=?
              WHERE request_id=? AND cancel_requested=0 AND state NOT IN ('succeeded','failed','cancelled')
            `).run(
              attempt,
              summaryRequest.summary_use_memory === 0 ? 'not_used' : 'not_read',
              now,
              row.session_summary_request_id
            )
          }
        }
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
      const claimed = receiptResult(receipt)
      if (claimed && budgetRemainingWallClockMs !== null) {
        claimed.remainingWallClockMs = budgetRemainingWallClockMs
        const attemptBudget = this.database.prepare(`
          SELECT request_count,request_limit FROM formal_agent_run_attempt_budgets
          WHERE run_id=? AND attempt=?
        `).get(claimed.runId, claimed.attemptIdentity.attempt)
        if (attemptBudget) {
          claimed.requestCount = Number(attemptBudget.request_count)
          claimed.requestLimit = Number(attemptBudget.request_limit)
        }
      }
      return claimed
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
          WHERE requested_by = ? AND attempt_count < max_attempts AND COALESCE(resume_required,0)=0 AND (
            (? = 'automatic' AND recipe_id IN ('context.ingest.session', 'context.ingest.interaction', 'context.synthesize')) OR
            (? = 'user' AND recipe_id IN ('summary.minutes', 'qa.answer'))
          ) AND state IN ('queued', 'retry_wait') AND cancel_requested_at IS NULL AND
            (session_summary_request_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM formal_agent_requests AS summary_request
              WHERE summary_request.request_id=formal_agent_runs.session_summary_request_id
                AND summary_request.resume_required=1
            ))
        UNION ALL
        SELECT lease_expires_at AS ready_at FROM formal_agent_runs
          WHERE requested_by = ? AND attempt_count < max_attempts AND COALESCE(resume_required,0)=0 AND (
            (? = 'automatic' AND recipe_id IN ('context.ingest.session', 'context.ingest.interaction', 'context.synthesize')) OR
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

  assertActiveFormalAttempt (row, attempt, now, {
    allowCancelRequested = false,
    allowPreviouslyRenewedLease = false
  } = {}) {
    if (!row || row.state !== 'running' || Number(row.attempt_count) !== attempt.attempt ||
        row.lease_owner !== attempt.owner ||
        (allowPreviouslyRenewedLease
          ? attempt.leaseExpiresAt > Number(row.lease_expires_at)
          : Number(row.lease_expires_at) !== attempt.leaseExpiresAt) ||
        Number(row.lease_expires_at) <= now || (!allowCancelRequested && row.cancel_requested_at !== null)) {
      fail('AGENT_CONTEXT_OPERATION_FAILED')
    }
    return row
  }

  renewFormalRunLease (request) {
    const requestKeys = Object.keys(request || {}).sort()
    if (!(requestKeys.join(',') === 'attemptIdentity,leaseMs' || requestKeys.join(',') === 'attemptIdentity,elapsedMs,leaseMs')) {
      fail('AGENT_REQUEST_INVALID')
    }
    const attempt = this.assertAttempt(request.attemptIdentity)
    const leaseMs = safeInteger(request.leaseMs, 1)
    if (leaseMs > 60000) fail('AGENT_REQUEST_INVALID')
    const elapsedMs = Object.hasOwn(request, 'elapsedMs') ? safeInteger(request.elapsedMs) : null
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      const now = this.nowValue()
      const row = database.prepare('SELECT * FROM formal_agent_runs WHERE run_id=?').get(attempt.runId)
      this.assertActiveFormalAttempt(row, attempt, now)
      const budgetState = database.prepare('SELECT * FROM formal_agent_run_budget_state WHERE run_id=?').get(attempt.runId)
      let remaining = null
      if (budgetState) {
        if (Number(budgetState.accounting_known) !== 1 || elapsedMs === null) fail('AGENT_RUN_UNAVAILABLE')
        const settled = settleActiveAttempt(database, {
          attemptIdentity: attempt,
          elapsedMs,
          now,
          nextLeaseMs: leaseMs
        })
        remaining = settled.remainingWallClockMs
      }
      const leaseExpiresAt = now + leaseMs
      if (!Number.isSafeInteger(leaseExpiresAt) || leaseExpiresAt <= attempt.leaseExpiresAt) {
        fail('AGENT_CONTEXT_OPERATION_FAILED')
      }
      const updated = database.prepare(`
        UPDATE formal_agent_runs SET lease_renewed_from_expires_at=?,lease_expires_at=?
        WHERE run_id=? AND state='running' AND attempt_count=? AND lease_owner=?
          AND lease_expires_at=? AND lease_expires_at>? AND cancel_requested_at IS NULL
      `).run(
        attempt.leaseExpiresAt, leaseExpiresAt, attempt.runId, attempt.attempt,
        attempt.owner, attempt.leaseExpiresAt, now
      )
      if (Number(updated.changes) !== 1) fail('AGENT_CONTEXT_OPERATION_FAILED')
      database.exec('COMMIT')
      return {
        runId: attempt.runId,
        attemptIdentity: { ...attempt, leaseExpiresAt },
        ...(remaining === null ? {} : { remainingWallClockMs: remaining })
      }
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }

  summaryInputPlan (request) {
    return require('./summary-input-plan-store').operate(this, request)
  }

  reserveFormalAgentModelRequest (request) {
    assertExactKeys(request, ['attemptIdentity', 'requestSequence', 'operationDigest'], 'AGENT_REQUEST_INVALID')
    const attempt = this.assertAttempt(request.attemptIdentity)
    safeInteger(request.requestSequence, 1)
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      const now = this.nowValue()
      const run = database.prepare('SELECT * FROM formal_agent_runs WHERE run_id=?').get(attempt.runId)
      this.assertActiveFormalAttempt(run, attempt, now, { allowPreviouslyRenewedLease: true })
      if (run.retry_policy_version === 'agent-retry@1' &&
          (typeof request.operationDigest !== 'string' || !/^[0-9a-f]{64}$/.test(request.operationDigest))) fail('AGENT_REQUEST_INVALID')
      let result
      if (typeof run.session_summary_request_id === 'string' || run.summary_input_policy === 'summary-long-input@1' || isLongInputRun(run)) {
        result = reserveModelRequest(database, {
          attemptIdentity: attempt,
          requestSequence: request.requestSequence,
          operationDigest: run.retry_policy_version === 'agent-retry@1' ? request.operationDigest : null,
          now
        })
      } else if (run.retry_policy_version === 'agent-retry@1') {
        const existing = database.prepare(`SELECT owner FROM formal_agent_model_operation_attempts
          WHERE run_id=? AND attempt=? AND request_sequence=?`).get(attempt.runId, attempt.attempt, request.requestSequence)
        if (existing) {
          if (existing.owner !== attempt.owner) fail('AGENT_CONTEXT_OPERATION_FAILED')
          result = { reserved: true, replayed: true }
        } else {
          const sequence = database.prepare(`SELECT COUNT(*) AS count FROM formal_agent_model_operation_attempts
            WHERE run_id=? AND attempt=?`).get(attempt.runId, attempt.attempt)
          if (Number(sequence.count) + 1 !== request.requestSequence) fail('AGENT_CONTEXT_OPERATION_FAILED')
          const used = database.prepare(`SELECT COUNT(*) AS count FROM formal_agent_model_operation_attempts
            WHERE run_id=? AND operation_digest=?`).get(attempt.runId, request.operationDigest)
          if (Number(used.count) >= 5) fail('AGENT_BUDGET_EXCEEDED')
          database.prepare(`INSERT INTO formal_agent_model_operation_attempts
            (run_id,attempt,request_sequence,owner,operation_digest,created_at) VALUES(?,?,?,?,?,?)`)
            .run(attempt.runId, attempt.attempt, request.requestSequence, attempt.owner, request.operationDigest, now)
          result = { reserved: true, replayed: false }
        }
      } else fail('AGENT_REQUEST_INVALID')
      database.exec('COMMIT')
      return result
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
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
    const now = this.nowValue()
    this.assertActiveFormalAttempt(row, attempt, now, { allowPreviouslyRenewedLease: true })
    this.database.prepare(`
      UPDATE formal_agent_runs SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
        lease_renewed_from_expires_at=NULL, result_digest = ?, result_summary_json = ?, error_code = NULL, updated_at = ?
      WHERE run_id = ? AND state='running' AND attempt_count=? AND lease_owner=? AND lease_expires_at=?
    `).run(request.resultDigest, summaryJson, now, attempt.runId, attempt.attempt, attempt.owner, Number(row.lease_expires_at))
    return { runId: row.run_id, replayed: false, state: 'succeeded' }
  }

  failFormalRun (request) {
    assertExactKeys(request, ['attemptIdentity', 'errorCode', 'elapsedMs'], 'AGENT_REQUEST_INVALID')
    const attempt = this.assertAttempt(request.attemptIdentity)
    const errors = new Set(FORMAL_AGENT_TASK_ERROR_CODES)
    if (Object.hasOwn(request, 'elapsedMs')) safeInteger(request.elapsedMs)
    const summaryInputLimitError = request.errorCode === 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED'
    const qaInputLimitError = request.errorCode === 'AGENT_QA_INPUT_LIMIT_EXCEEDED'
    const inputLimitError = summaryInputLimitError || qaInputLimitError
    if (!errors.has(request.errorCode) && !inputLimitError) fail('AGENT_REQUEST_INVALID')
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      const row = database.prepare('SELECT * FROM formal_agent_runs WHERE run_id = ?').get(attempt.runId)
      if (summaryInputLimitError && row?.recipe_id !== 'summary.minutes') fail('AGENT_REQUEST_INVALID')
      if (qaInputLimitError && (row?.recipe_id !== 'qa.answer' || !['2', '3'].includes(row?.recipe_version))) fail('AGENT_REQUEST_INVALID')
      const now = this.nowValue()
      this.assertActiveFormalAttempt(row, attempt, now, { allowPreviouslyRenewedLease: true })
      const budgetState = database.prepare('SELECT * FROM formal_agent_run_budget_state WHERE run_id=?').get(attempt.runId)
      let settlement = null
      if (budgetState) {
        if (Object.hasOwn(request, 'elapsedMs')) {
          settlement = settleActiveAttempt(database, { attemptIdentity: attempt, elapsedMs: request.elapsedMs, now })
        } else {
          settlement = interruptActiveAttempt(database, attempt.runId, now)
        }
      }
      const exhausted = settlement?.exhausted === true
      const terminal = inputLimitError || exhausted || Number(row.attempt_count) >= Number(row.max_attempts)
      const nextAttemptAt = terminal ? now : now + 1000
      const errorCode = exhausted ? 'AGENT_BUDGET_EXCEEDED' : request.errorCode
      const storedErrorCode = errorCode === SUMMARY_MEMORY_ERROR || inputLimitError && !exhausted ? 'AGENT_INTERNAL_FAILURE' : errorCode
      const summaryMemoryError = errorCode === SUMMARY_MEMORY_ERROR ? 1 : 0
      database.prepare(`
        UPDATE formal_agent_runs SET state = ?, next_attempt_at = ?, lease_owner = NULL,
          lease_expires_at = NULL, lease_renewed_from_expires_at=NULL, error_code = ?, summary_memory_error = ?, summary_input_limit_error = ?, qa_input_limit_error = ?, updated_at = ?
        WHERE run_id=? AND state='running' AND attempt_count=? AND lease_owner=? AND lease_expires_at=?
      `).run(
        terminal ? 'failed' : 'retry_wait', nextAttemptAt,
        terminal ? storedErrorCode : null,
        terminal ? summaryMemoryError : 0,
        terminal && summaryInputLimitError && !exhausted ? 1 : 0,
        terminal && qaInputLimitError && !exhausted ? 1 : 0,
        now, attempt.runId, attempt.attempt, attempt.owner, Number(row.lease_expires_at)
      )
      if (terminal && typeof row.session_summary_request_id === 'string') {
        const visibleError = inputLimitError && !exhausted
          ? request.errorCode
          : errorCode
        const interaction = database.prepare('SELECT interaction_id FROM formal_agent_interactions WHERE run_id=? AND terminal_reason IS NULL').get(attempt.runId)
        if (interaction) {
          database.prepare(`
            UPDATE formal_agent_interactions SET terminal_reason='failed',error_code=?,
              summary_memory_error=?,summary_input_limit_error=?,qa_input_limit_error=?,usage_json=NULL,
              duration_ms=?,result_json=NULL,result_digest=NULL,terminal_at=?
            WHERE interaction_id=? AND terminal_reason IS NULL
          `).run(storedErrorCode,
            summaryMemoryError, summaryInputLimitError && !exhausted ? 1 : 0,
            qaInputLimitError && !exhausted ? 1 : 0,
            request.elapsedMs ?? 0, now, interaction.interaction_id)
          database.prepare(`
            UPDATE formal_agent_tool_calls SET ended_offset_ms=started_offset_ms,status='cancelled',
              error_code='TOOL_CANCELLED',result_json=NULL,result_digest=NULL
            WHERE interaction_id=? AND status='started'
          `).run(interaction.interaction_id)
        }
        database.prepare(`
          UPDATE formal_agent_requests SET state='failed',phase='terminal',error_code=?,
            revision=revision+1,updated_at=?
          WHERE request_id=? AND state NOT IN ('succeeded','failed','cancelled')
        `).run(visibleError, now, row.session_summary_request_id)
      }
      database.exec('COMMIT')
      return {
        runId: row.run_id,
        state: terminal ? 'failed' : 'retry_wait',
        nextAttemptAt,
        errorCode: terminal ? (inputLimitError && !exhausted ? request.errorCode : storedErrorCode) : null
      }
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }
}

module.exports = {
  exactEntry,
  publicItem,
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
