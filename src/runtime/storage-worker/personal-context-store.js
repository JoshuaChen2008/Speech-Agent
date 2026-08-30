'use strict'

const { canonicalize, sha256Canonical } = require('./canonical-json')
const { rollbackQuietly } = require('./sqlite-store')
const { StorageError, assertExactKeys, isPlainObject } = require('./protocol')
const { FORMAL_AGENT_TASK_ERROR_CODES } = require('../../agent/contracts/personal-context-core')

const MAX_CANDIDATES = 256
const MAX_ITEMS = 20
const MAX_SCOPE_DIRECTORY_ITEMS = 50
const MAX_SOURCES_PER_ITEM = 8
const MAX_CANONICAL_BYTES = 65536
const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]*$/
const MEMORY_KINDS = new Set([
  'decision', 'conclusion', 'todo', 'term', 'preference', 'project_fact', 'experience'
])
const SCOPE_KINDS = new Set(['global', 'session', 'topic', 'project'])

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

  sessionSnapshot (source) {
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
        segment.t0_ms,
        segment.t1_ms,
        first_event.event_order AS first_event_order,
        first_event.text AS raw_text,
        updated_event.event_order AS updated_event_order,
        updated_event.kind AS updated_kind,
        segment.text AS current_text
      FROM segments AS segment
      JOIN caption_events AS first_event ON first_event.event_order = segment.first_event_order
      JOIN caption_events AS updated_event ON updated_event.event_order = segment.updated_event_order
      WHERE segment.session_id = ?
      ORDER BY first_event.event_order
    `).all(sessionId)
    if (rows.length === 0) fail('AGENT_INPUT_EMPTY')
    const maximumWatermark = Number(this.database.prepare(`
      SELECT MAX(event_order) AS watermark FROM caption_events WHERE session_id = ?
    `).get(sessionId).watermark)
    if (inputWatermark !== maximumWatermark) fail('AGENT_INPUT_CHANGED')
    if (source.transcriptVersion === 'refined' && rows.some((row) => row.updated_kind !== 'refined')) {
      fail('AGENT_INPUT_VERSION_UNAVAILABLE')
    }
    const events = rows.map((row) => ({
      eventOrder: Number(source.transcriptVersion === 'refined' ? row.updated_event_order : row.first_event_order),
      segmentId: row.segment_id,
      text: source.transcriptVersion === 'refined' ? row.current_text : row.raw_text
    }))
    const digestPayload = { sessionId, transcriptVersion: source.transcriptVersion, inputWatermark, events }
    if (sha256Canonical(digestPayload) !== source.inputDigest) fail('AGENT_INPUT_CHANGED')
    return {
      sessionId,
      transcriptVersion: source.transcriptVersion,
      inputWatermark,
      inputDigest: source.inputDigest,
      startedAt: Number(session.started_at),
      endedAt: Number(session.ended_at),
      fromEventOrder: Math.min(...events.map((event) => event.eventOrder)),
      throughEventOrder: Math.max(...events.map((event) => event.eventOrder)),
      segmentCount: events.length
    }
  }

  ingest (source) {
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
      this.database.prepare(`
        INSERT OR IGNORE INTO personal_context_scopes(
          scope_id, kind, canonical_key, label, session_id, origin, lifecycle, created_at, updated_at
        ) VALUES (?, 'session', ?, 'Session', ?, 'automatic', 'active', ?, ?)
      `).run(scopeId, `session:${snapshot.sessionId}`, snapshot.sessionId, now, now)
      if (!existing) this.database.prepare(`
        INSERT INTO formal_agent_runs(
          run_id, dedupe_key, client_idempotency_key, request_digest, recipe_id, recipe_version,
          scope_json, scope_digest, transcript_version, input_watermark_json, input_digest,
          requested_by, state, attempt_count, max_attempts, next_attempt_at,
          lease_owner, lease_expires_at, lease_renewed_from_expires_at, cancel_requested_at,
          error_code, result_digest, result_summary_json, created_at, updated_at
        ) VALUES (?, ?, NULL, ?, 'context.ingest.session', '1', ?, ?, ?, ?, ?,
          'automatic', 'succeeded', 1, 3, 0, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, ?)
      `).run(
        runId, dedupeKey, requestDigest,
        canonicalize({ kind: 'session', reference: snapshot.sessionId }),
        sha256Canonical({ kind: 'session', reference: snapshot.sessionId }),
        snapshot.transcriptVersion,
        canonicalize({ throughEventOrder: snapshot.inputWatermark }),
        snapshot.inputDigest,
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
      WHERE scope_id = ? AND kind = ? AND origin = 'automatic' AND lifecycle = 'active'
    `).get(entry.scopeReference, entry.scopeKind)
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
        SELECT * FROM personal_context_episodes
        WHERE session_id = ? AND lifecycle = 'active'
        ORDER BY updated_at DESC, episode_id ASC LIMIT ?
      `).all(reference, MAX_ITEMS + 1)
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
        SELECT * FROM personal_context_episodes
        WHERE session_id = ? AND lifecycle = 'active' AND from_event_order <= ?
        ORDER BY updated_at DESC, episode_id ASC LIMIT ?
      `).all(sessionId, throughEventOrder, MAX_ITEMS + 1)
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
        SELECT episode.* FROM personal_context_episodes AS episode
        JOIN sessions AS session ON session.session_id = episode.session_id
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
        episodeId: row.episode_id, sessionId: row.session_id,
        transcriptVersion: row.transcript_version, inputWatermark: Number(row.input_watermark),
        inputDigest: row.input_digest, summary: JSON.parse(row.summary_json)
      }
      if (request.scope.kind === 'selection' && Number(row.through_event_order) > reference.through_event_order) {
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
      SELECT COUNT(*) AS count FROM personal_context_episodes WHERE session_id = ?
    `).get(sessionId).count)
    const evidenceCount = Number(this.database.prepare(`
      SELECT COUNT(*) AS count FROM personal_context_evidence WHERE session_id = ?
    `).get(sessionId).count)
    const orphanItemIds = this.database.prepare(`
      SELECT DISTINCT item.memory_id
      FROM personal_context_items AS item
      JOIN personal_context_scopes AS scope ON scope.scope_id = item.scope_id
      LEFT JOIN personal_context_evidence AS own
        ON own.memory_id = item.memory_id AND own.session_id = ?
      WHERE (scope.session_id = ? OR own.evidence_id IS NOT NULL) AND NOT EXISTS (
          SELECT 1 FROM personal_context_evidence AS other
          WHERE other.memory_id = item.memory_id
            AND (other.session_id IS NULL OR other.session_id <> ?)
      )
      ORDER BY item.memory_id
    `).all(sessionId, sessionId, sessionId).map((row) => row.memory_id)
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
    this.database.prepare('DELETE FROM personal_context_evidence WHERE session_id = ?').run(sessionId)
    this.database.prepare('DELETE FROM personal_context_episodes WHERE session_id = ?').run(sessionId)
    if (plan.episodeCount > 0 || plan.evidenceCount > 0 || plan.orphanItemIds.length > 0) {
      this.advanceRevision({
        operation: 'delete-session-context', sessionId,
        deletedEpisodeCount: plan.episodeCount,
        deletedContextEvidenceCount: plan.evidenceCount,
        deletedOrphanContextItemCount: plan.orphanItemIds.length
      })
    }
  }

  deleteSessionData (input, legacyStore) {
    if (!legacyStore || typeof legacyStore.deleteSessionData !== 'function') fail('STORAGE_COMMAND_FAILED')
    return legacyStore.deleteSessionData(input, this)
  }

  claimNextFormalRun (request) {
    assertExactKeys(request, ['claimIdempotencyKey', 'owner', 'leaseMs'], 'AGENT_REQUEST_INVALID')
    identifier(request.claimIdempotencyKey)
    identifier(request.owner)
    safeInteger(request.leaseMs, 1)
    const requestDigest = sha256Canonical(request)
    const now = this.nowValue()
    const receiptResult = (receipt) => {
      if (receipt.run_id === null) return null
      const row = this.database.prepare('SELECT * FROM formal_agent_runs WHERE run_id = ?').get(receipt.run_id)
      if (!row) fail('STORAGE_COMMAND_FAILED')
      const scope = JSON.parse(row.scope_json)
      const watermark = JSON.parse(row.input_watermark_json)
      return {
        runId: row.run_id,
        recipeId: row.recipe_id,
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
        WHERE recipe_id = 'context.ingest.session' AND (
          (state IN ('queued', 'retry_wait') AND next_attempt_at <= ?) OR
          (state = 'running' AND lease_expires_at <= ?)
        )
        ORDER BY next_attempt_at, run_order LIMIT 1
      `).get(now, now)
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
      return receiptResult(receipt)
    } catch (error) {
      rollbackQuietly(this.database)
      throw error
    }
  }

  nextFormalRunAt () {
    const row = this.database.prepare(`
      SELECT MIN(ready_at) AS ready_at FROM (
        SELECT next_attempt_at AS ready_at FROM formal_agent_runs WHERE state IN ('queued', 'retry_wait')
        UNION ALL
        SELECT lease_expires_at AS ready_at FROM formal_agent_runs WHERE state = 'running'
      )
    `).get()
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
    if (!errors.has(request.errorCode)) fail('AGENT_REQUEST_INVALID')
    const row = this.database.prepare('SELECT * FROM formal_agent_runs WHERE run_id = ?').get(attempt.runId)
    if (!row || row.state !== 'running' || Number(row.attempt_count) !== attempt.attempt ||
        row.lease_owner !== attempt.owner || Number(row.lease_expires_at) !== attempt.leaseExpiresAt) {
      fail('AGENT_CONTEXT_OPERATION_FAILED')
    }
    const terminal = Number(row.attempt_count) >= Number(row.max_attempts)
    const now = this.nowValue()
    const nextAttemptAt = terminal ? now : now + 1000
    this.database.prepare(`
      UPDATE formal_agent_runs SET state = ?, next_attempt_at = ?, lease_owner = NULL,
        lease_expires_at = NULL, error_code = ?, updated_at = ? WHERE run_id = ?
    `).run(terminal ? 'failed' : 'retry_wait', nextAttemptAt, terminal ? request.errorCode : null, now, attempt.runId)
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
