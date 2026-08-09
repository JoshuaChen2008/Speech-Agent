'use strict'

// @ts-check

const crypto = require('node:crypto')
const { canonicalize, sha256Canonical } = require('./canonical-json')
const { StorageError, assertExactKeys } = require('./protocol')
const { rollbackQuietly } = require('./sqlite-store')

const FORMAL_AGENT_TASKS = Object.freeze({
  'meeting-minutes': Object.freeze({
    pluginId: 'meeting-minutes',
    artifactKind: 'meeting-minutes',
    recipeVersion: 'meeting-minutes@1'
  }),
  'memory-extraction': Object.freeze({
    pluginId: 'memory-extraction',
    artifactKind: 'memory-candidates',
    recipeVersion: 'memory-extraction@1'
  }),
  'enhanced-transcript': Object.freeze({
    pluginId: 'enhanced-transcript',
    artifactKind: 'enhanced-transcript',
    recipeVersion: 'enhanced-transcript@1'
  })
})

const AUTOMATIC_TASK_KINDS = Object.freeze([
  'meeting-minutes',
  'memory-extraction',
  'enhanced-transcript'
])

const RETRYABLE_ERROR_CODES = Object.freeze([
  'AGENT_PROVIDER_RATE_LIMITED',
  'AGENT_PROVIDER_TIMEOUT',
  'AGENT_PROVIDER_UNAVAILABLE',
  'AGENT_WORKER_EXITED'
])

const TERMINAL_ERROR_CODES = Object.freeze([
  'AGENT_PROVIDER_AUTH_FAILED',
  'AGENT_OUTPUT_INVALID',
  'AGENT_PERMISSION_DENIED',
  'AGENT_REQUEST_INVALID',
  'AGENT_INTERNAL_FAILURE'
])

const ELIGIBILITY_CONTEXT_KEYS = Object.freeze([
  'agentEnabled',
  'memoryEnabled',
  'automaticProcessingSince',
  'memoryProcessingSince',
  'providerId',
  'providerKind',
  'model',
  'cloudDisclosureAccepted',
  'credentialAvailable',
  'localModelReady'
])

function exactObject (value, keys, code = 'AGENT_REQUEST_INVALID') {
  assertExactKeys(value, keys, code)
  if (Object.keys(value).length !== keys.length) throw new StorageError(code)
  return value
}

function boundedString (value, min = 1, max = 160, code = 'AGENT_REQUEST_INVALID') {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw new StorageError(code)
  return value
}

function timestamp (value, code = 'AGENT_REQUEST_INVALID') {
  if (!Number.isSafeInteger(value) || value < 0) throw new StorageError(code)
  return value
}

function sha256Value (value, code = 'AGENT_REQUEST_INVALID') {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new StorageError(code)
  return value
}

function inputReference (value) {
  exactObject(value, ['sessionId', 'inputWatermark', 'transcriptVersion', 'inputDigest'])
  const sessionId = boundedString(value.sessionId)
  if (!Number.isSafeInteger(value.inputWatermark) || value.inputWatermark < 1 ||
      !['original', 'refined'].includes(value.transcriptVersion)) {
    throw new StorageError('AGENT_REQUEST_INVALID')
  }
  return {
    sessionId,
    inputWatermark: value.inputWatermark,
    transcriptVersion: value.transcriptVersion,
    inputDigest: sha256Value(value.inputDigest)
  }
}

function eligibilityContext (value) {
  exactObject(value, ELIGIBILITY_CONTEXT_KEYS)
  if (typeof value.agentEnabled !== 'boolean' || typeof value.memoryEnabled !== 'boolean' ||
      (value.automaticProcessingSince !== null &&
       (!Number.isSafeInteger(value.automaticProcessingSince) || value.automaticProcessingSince < 0)) ||
      (value.memoryProcessingSince !== null &&
       (!Number.isSafeInteger(value.memoryProcessingSince) || value.memoryProcessingSince < 0)) ||
      (value.providerId !== null && (typeof value.providerId !== 'string' || value.providerId.length < 1 || value.providerId.length > 160)) ||
      (value.model !== null && (typeof value.model !== 'string' || value.model.length < 1 || value.model.length > 160)) ||
      ![null, 'cloud', 'local'].includes(value.providerKind) ||
      typeof value.cloudDisclosureAccepted !== 'boolean' ||
      typeof value.credentialAvailable !== 'boolean' ||
      typeof value.localModelReady !== 'boolean') {
    throw new StorageError('AGENT_REQUEST_INVALID')
  }
  if ((value.automaticProcessingSince !== null) !== value.agentEnabled ||
      (value.memoryProcessingSince !== null) !== (value.agentEnabled && value.memoryEnabled)) {
    throw new StorageError('AGENT_REQUEST_INVALID')
  }
  return {
    agentEnabled: value.agentEnabled,
    memoryEnabled: value.memoryEnabled,
    automaticProcessingSince: value.automaticProcessingSince,
    memoryProcessingSince: value.memoryProcessingSince,
    providerId: value.providerId,
    providerKind: value.providerKind,
    model: value.model,
    cloudDisclosureAccepted: value.cloudDisclosureAccepted,
    credentialAvailable: value.credentialAvailable,
    localModelReady: value.localModelReady
  }
}

function providerSnapshot (context) {
  if (!context.providerId || !context.providerKind || !context.model) return null
  return {
    providerId: context.providerId,
    providerKind: context.providerKind,
    model: context.model
  }
}

function taskDefinition (taskKind) {
  const task = FORMAL_AGENT_TASKS[taskKind]
  if (!task) throw new StorageError('AGENT_REQUEST_INVALID')
  return task
}

function availableTaskKinds (value) {
  if (!Array.isArray(value) || value.length > AUTOMATIC_TASK_KINDS.length ||
      value.some((taskKind) => !Object.hasOwn(FORMAL_AGENT_TASKS, taskKind)) ||
      new Set(value).size !== value.length) {
    throw new StorageError('AGENT_REQUEST_INVALID')
  }
  return [...value].sort()
}

function leaseValue (value) {
  exactObject(value, ['owner', 'expiresAt'], 'AGENT_JOB_STATE_CONFLICT')
  return {
    owner: boundedString(value.owner, 1, 160, 'AGENT_JOB_STATE_CONFLICT'),
    expiresAt: timestamp(value.expiresAt, 'AGENT_JOB_STATE_CONFLICT')
  }
}

function rowJob (row) {
  if (!row) return null
  return {
    jobId: row.job_id,
    runId: row.run_id,
    taskKind: row.plugin_id,
    state: row.state,
    sessionId: row.session_id,
    inputRef: {
      sessionId: row.session_id,
      inputWatermark: Number(row.input_watermark),
      transcriptVersion: row.transcript_version,
      inputDigest: row.input_digest
    },
    recipeVersion: row.recipe_version,
    providerId: row.provider,
    providerKind: row.provider_kind,
    model: row.model,
    attemptCount: Number(row.attempt_count),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: Number(row.next_attempt_at),
    lease: row.lease_owner === null
      ? null
      : { owner: row.lease_owner, expiresAt: Number(row.lease_expires_at) },
    cancelRequestedAt: row.cancel_requested_at === null ? null : Number(row.cancel_requested_at),
    errorCode: row.error_code,
    requestedBy: row.requested_by,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  }
}

function publicJob (row) {
  const job = rowJob(row)
  if (!job) return null
  const { lease, cancelRequestedAt, ...visible } = job
  return { ...visible, cancelRequested: cancelRequestedAt !== null }
}

function rowArtifact (row) {
  if (!row) return null
  return {
    artifactId: row.artifact_id,
    runId: row.run_id,
    sessionId: row.session_id,
    pluginId: row.plugin_id,
    type: row.type,
    content: JSON.parse(row.content_json),
    contentDigest: row.content_digest,
    inputRef: {
      sessionId: row.session_id,
      inputWatermark: Number(row.input_through_event_order),
      transcriptVersion: row.transcript_version,
      inputDigest: row.input_digest
    },
    recipeVersion: row.recipe_version,
    providerId: row.provider,
    model: row.model,
    supersedesArtifactId: row.supersedes_artifact_id,
    createdAt: Number(row.created_at)
  }
}

function resultSummary (row) {
  try {
    const value = JSON.parse(row.result_summary_json)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid summary')
    return value
  } catch {
    throw new StorageError('STORAGE_COMMAND_FAILED')
  }
}

function boundedText (value, max, allowEmpty = false, code = 'AGENT_OUTPUT_INVALID') {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && value.length === 0)) {
    throw new StorageError(code)
  }
  return value
}

function eventRange (value, validEventOrders) {
  exactObject(value, ['fromEventOrder', 'throughEventOrder'], 'AGENT_OUTPUT_INVALID')
  if (!Number.isSafeInteger(value.fromEventOrder) || value.fromEventOrder < 1 ||
      !Number.isSafeInteger(value.throughEventOrder) || value.throughEventOrder < value.fromEventOrder ||
      !validEventOrders.has(value.fromEventOrder) || !validEventOrders.has(value.throughEventOrder)) {
    throw new StorageError('AGENT_OUTPUT_INVALID')
  }
  return {
    fromEventOrder: value.fromEventOrder,
    throughEventOrder: value.throughEventOrder
  }
}

function evidenceRanges (value, validEventOrders) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) {
    throw new StorageError('AGENT_OUTPUT_INVALID')
  }
  return value.map((range) => eventRange(range, validEventOrders))
}

function evidenceItem (value, validEventOrders, actionItem = false) {
  exactObject(
    value,
    actionItem ? ['text', 'owner', 'due', 'evidence'] : ['text', 'evidence'],
    'AGENT_OUTPUT_INVALID'
  )
  const result = {
    text: boundedText(value.text, 4000),
    evidence: evidenceRanges(value.evidence, validEventOrders)
  }
  if (actionItem) {
    if (value.owner !== null) throw new StorageError('AGENT_OUTPUT_INVALID')
    if (value.due !== null) boundedText(value.due, 400)
    result.owner = value.owner
    result.due = value.due
  }
  return result
}

function artifactValue (value, taskKind, validEventOrders) {
  exactObject(value, ['type', 'content'], 'AGENT_OUTPUT_INVALID')
  if (value.type !== taskKind || !value.content || typeof value.content !== 'object' || Array.isArray(value.content)) {
    throw new StorageError('AGENT_OUTPUT_INVALID')
  }
  if (taskKind === 'meeting-minutes') {
    exactObject(value.content, ['overview', 'conclusions', 'actionItems', 'risks'], 'AGENT_OUTPUT_INVALID')
    for (const key of ['conclusions', 'actionItems', 'risks']) {
      if (!Array.isArray(value.content[key]) || value.content[key].length > 500) {
        throw new StorageError('AGENT_OUTPUT_INVALID')
      }
    }
    return {
      type: value.type,
      content: {
        overview: boundedText(value.content.overview, 20000, true),
        conclusions: value.content.conclusions.map((item) => evidenceItem(item, validEventOrders)),
        actionItems: value.content.actionItems.map((item) => evidenceItem(item, validEventOrders, true)),
        risks: value.content.risks.map((item) => evidenceItem(item, validEventOrders))
      }
    }
  }
  if (taskKind === 'enhanced-transcript') {
    exactObject(value.content, ['paragraphs'], 'AGENT_OUTPUT_INVALID')
    if (!Array.isArray(value.content.paragraphs) || value.content.paragraphs.length < 1 ||
        value.content.paragraphs.length > 1000) {
      throw new StorageError('AGENT_OUTPUT_INVALID')
    }
    return {
      type: value.type,
      content: {
        paragraphs: value.content.paragraphs.map((item) => evidenceItem(item, validEventOrders))
      }
    }
  }
  throw new StorageError('AGENT_OUTPUT_INVALID')
}

const MEMORY_KINDS = Object.freeze([
  'decision', 'conclusion', 'action-item', 'term', 'preference', 'project-fact', 'experience'
])
const MEMORY_SCOPE_KINDS = Object.freeze(['global', 'session', 'topic', 'project'])
const MEMORY_BANDS = Object.freeze(['low', 'medium', 'high'])
const MEMORY_QUERY_CANDIDATE_LIMIT = 256

function memoryQuery (value) {
  exactObject(value, ['scopeRefs', 'kinds', 'semanticKeys', 'maxItems', 'maxSerializedBytes'])
  if (!Array.isArray(value.scopeRefs) || value.scopeRefs.length < 1 || value.scopeRefs.length > 16 ||
      !Array.isArray(value.kinds) || value.kinds.length < 1 || value.kinds.length > MEMORY_KINDS.length ||
      !Array.isArray(value.semanticKeys) || value.semanticKeys.length > 64 ||
      !Number.isSafeInteger(value.maxItems) || value.maxItems < 1 || value.maxItems > 20 ||
      !Number.isSafeInteger(value.maxSerializedBytes) ||
      value.maxSerializedBytes < 256 || value.maxSerializedBytes > 65536) {
    throw new StorageError('AGENT_REQUEST_INVALID')
  }
  const scopeRefs = value.scopeRefs.map((scope) => {
    exactObject(scope, ['kind', 'canonicalKey'])
    if (!MEMORY_SCOPE_KINDS.includes(scope.kind)) throw new StorageError('AGENT_REQUEST_INVALID')
    return {
      kind: scope.kind,
      canonicalKey: boundedText(scope.canonicalKey, 240, false, 'AGENT_REQUEST_INVALID')
    }
  })
  if (new Set(scopeRefs.map((scope) => `${scope.kind}\u0000${scope.canonicalKey}`)).size !== scopeRefs.length ||
      value.kinds.some((kind) => !MEMORY_KINDS.includes(kind)) ||
      new Set(value.kinds).size !== value.kinds.length) {
    throw new StorageError('AGENT_REQUEST_INVALID')
  }
  const semanticKeys = value.semanticKeys.map((key) =>
    boundedText(key, 240, false, 'AGENT_REQUEST_INVALID')
  )
  if (new Set(semanticKeys).size !== semanticKeys.length) {
    throw new StorageError('AGENT_REQUEST_INVALID')
  }
  return {
    scopeRefs,
    kinds: [...value.kinds],
    semanticKeys,
    maxItems: value.maxItems,
    maxSerializedBytes: value.maxSerializedBytes
  }
}

function memoryDormantReason (context) {
  if (!context) throw new StorageError('AGENT_REQUEST_INVALID')
  if (!context.agentEnabled) return 'agent_disabled'
  if (!context.memoryEnabled) return 'memory_disabled'
  const configuration = providerSnapshot(context)
  if (!configuration) return 'provider_not_configured'
  if (configuration.providerKind === 'cloud') {
    if (!context.cloudDisclosureAccepted) return 'cloud_disclosure_required'
    if (!context.credentialAvailable) return 'credential_unavailable'
  } else if (!context.localModelReady) {
    return 'local_model_not_ready'
  }
  return null
}

function memoryCandidate (value, validEventOrders, sessionId) {
  exactObject(value, [
    'kind', 'semanticKey', 'scope', 'origin', 'content', 'evidence', 'confidenceBand', 'salienceBand'
  ], 'AGENT_OUTPUT_INVALID')
  exactObject(value.scope, ['kind', 'canonicalKey', 'label'], 'AGENT_OUTPUT_INVALID')
  if (!MEMORY_KINDS.includes(value.kind) || !MEMORY_SCOPE_KINDS.includes(value.scope.kind) ||
      !['explicit', 'automatic'].includes(value.origin) ||
      !MEMORY_BANDS.includes(value.confidenceBand) || !MEMORY_BANDS.includes(value.salienceBand) ||
      !value.content || typeof value.content !== 'object' || Array.isArray(value.content)) {
    throw new StorageError('AGENT_OUTPUT_INVALID')
  }
  const semanticKey = boundedText(value.semanticKey, 240)
  const canonicalKey = boundedText(value.scope.canonicalKey, 240)
  const label = boundedText(value.scope.label, 400)
  if (value.scope.kind === 'session' && canonicalKey !== sessionId) throw new StorageError('AGENT_OUTPUT_INVALID')
  let contentJson
  try {
    contentJson = canonicalize(value.content)
  } catch {
    throw new StorageError('AGENT_OUTPUT_INVALID')
  }
  if (Buffer.byteLength(contentJson, 'utf8') > 16384) throw new StorageError('AGENT_OUTPUT_INVALID')
  return {
    kind: value.kind,
    semanticKey,
    scope: { kind: value.scope.kind, canonicalKey, label },
    origin: value.origin,
    content: value.content,
    contentJson,
    evidence: evidenceRanges(value.evidence, validEventOrders),
    confidenceBand: value.confidenceBand,
    salienceBand: value.salienceBand
  }
}

function sameInputReference (left, right) {
  return left.sessionId === right.sessionId &&
    left.inputWatermark === right.inputWatermark &&
    left.transcriptVersion === right.transcriptVersion &&
    left.inputDigest === right.inputDigest
}

function userRequestIdentity ({ inputRef, taskKind, eligibilityContext: context }) {
  const ref = inputReference(inputRef)
  const task = taskDefinition(taskKind)
  const validatedContext = eligibilityContext(context)
  return {
    requestedBy: 'user',
    inputRef: ref,
    taskKind,
    pluginId: task.pluginId,
    artifactKind: task.artifactKind,
    recipeVersion: task.recipeVersion,
    providerId: validatedContext.providerId,
    providerKind: validatedContext.providerKind,
    model: validatedContext.model
  }
}

function makeUserRequestDigest (value) {
  return sha256Canonical(userRequestIdentity(value))
}

function deleteMemoryGraph (database, memoryId) {
  const deletedEvidenceCount = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM memory_evidence WHERE memory_id = ?
  `).get(memoryId).count)
  const deletedRevisionCount = Number(database.prepare(`
    SELECT COUNT(*) AS count FROM memory_revisions WHERE memory_id = ?
  `).get(memoryId).count)

  /* Both revision pointers use composite foreign keys that include memory_id.
     Clear only the nullable pointer columns before deleting revisions so
     ON DELETE SET NULL never attempts to null the non-null identity column. */
  database.prepare(`
    UPDATE memory_items SET current_revision_id = NULL WHERE memory_id = ?
  `).run(memoryId)
  database.prepare(`
    UPDATE memory_revisions SET previous_revision_id = NULL WHERE memory_id = ?
  `).run(memoryId)
  database.prepare('DELETE FROM memory_evidence WHERE memory_id = ?').run(memoryId)
  database.prepare('DELETE FROM memory_revisions WHERE memory_id = ?').run(memoryId)
  const deleted = database.prepare('DELETE FROM memory_items WHERE memory_id = ?').run(memoryId)
  if (Number(deleted.changes) !== 1) throw new StorageError('AGENT_REQUEST_INVALID')
  return { deletedEvidenceCount, deletedRevisionCount }
}

class FormalAgentStore {
  constructor (options = {}) {
    if (!options.subtitleStore || !options.subtitleStore.database) {
      throw new TypeError('subtitleStore with an open database is required')
    }
    this.subtitleStore = options.subtitleStore
    this.database = options.subtitleStore.database
    this.now = typeof options.now === 'function'
      ? options.now
      : (typeof options.subtitleStore.now === 'function' ? options.subtitleStore.now : () => Date.now())
    this.idFactory = typeof options.idFactory === 'function' ? options.idFactory : () => crypto.randomUUID()
    /* 策略 generation 故意不持久化。worker replacement 后必须由受信任主进程
       重新应用；在此之前 claim fail closed，避免用陈旧凭据/开关领取任务。 */
    this.currentPolicy = null
  }

  assertOpen () {
    if (typeof this.subtitleStore.assertOpen === 'function') this.subtitleStore.assertOpen()
  }

  nowValue () {
    return timestamp(this.now(), 'STORAGE_COMMAND_FAILED')
  }

  nextId () {
    return boundedString(this.idFactory(), 1, 160)
  }

  sessionFact (sessionId) {
    const id = boundedString(sessionId)
    const row = this.database.prepare(`
      SELECT session_id, state, ended_at
      FROM sessions WHERE session_id = ?
    `).get(id)
    if (!row) throw new StorageError('AGENT_SESSION_NOT_FOUND')
    return row
  }

  readInput (input) {
    this.assertOpen()
    exactObject(input, ['sessionId', 'transcriptVersion'])
    const sessionId = boundedString(input.sessionId)
    if (!['original', 'refined'].includes(input.transcriptVersion)) {
      throw new StorageError('AGENT_REQUEST_INVALID')
    }
    const session = this.sessionFact(sessionId)
    if (!['closed', 'interrupted'].includes(session.state) || session.ended_at === null) {
      throw new StorageError('AGENT_SESSION_NOT_TERMINAL')
    }
    const rows = this.database.prepare(`
      SELECT
        segments.segment_id,
        segments.source_id,
        segments.first_event_order,
        origin.text AS original_text,
        origin.t0_ms AS original_t0_ms,
        origin.t1_ms AS original_t1_ms,
        (
          SELECT refined.text FROM caption_events AS refined
          WHERE refined.session_id = segments.session_id
            AND refined.source_id = segments.source_id
            AND refined.segment_id = segments.segment_id
            AND refined.kind = 'refined'
          ORDER BY refined.revision DESC, refined.event_order DESC LIMIT 1
        ) AS refined_text,
        (
          SELECT refined.event_order FROM caption_events AS refined
          WHERE refined.session_id = segments.session_id
            AND refined.source_id = segments.source_id
            AND refined.segment_id = segments.segment_id
            AND refined.kind = 'refined'
          ORDER BY refined.revision DESC, refined.event_order DESC LIMIT 1
        ) AS refined_event_order,
        (
          SELECT refined.t0_ms FROM caption_events AS refined
          WHERE refined.session_id = segments.session_id
            AND refined.source_id = segments.source_id
            AND refined.segment_id = segments.segment_id
            AND refined.kind = 'refined'
          ORDER BY refined.revision DESC, refined.event_order DESC LIMIT 1
        ) AS refined_t0_ms,
        (
          SELECT refined.t1_ms FROM caption_events AS refined
          WHERE refined.session_id = segments.session_id
            AND refined.source_id = segments.source_id
            AND refined.segment_id = segments.segment_id
            AND refined.kind = 'refined'
          ORDER BY refined.revision DESC, refined.event_order DESC LIMIT 1
        ) AS refined_t1_ms
      FROM segments
      JOIN caption_events AS origin
        ON origin.event_order = segments.first_event_order AND origin.kind = 'final'
      WHERE segments.session_id = ?
      ORDER BY segments.first_event_order
    `).all(sessionId)
    if (rows.length === 0) throw new StorageError('AGENT_INPUT_EMPTY')
    if (input.transcriptVersion === 'refined' && rows.some((row) => row.refined_event_order === null)) {
      throw new StorageError('AGENT_INPUT_VERSION_UNAVAILABLE')
    }
    const items = rows.map((row) => {
      const refined = input.transcriptVersion === 'refined'
      return {
        segmentId: row.segment_id,
        sourceId: row.source_id,
        eventOrder: Number(refined ? row.refined_event_order : row.first_event_order),
        t0Ms: Number(refined ? row.refined_t0_ms : row.original_t0_ms),
        t1Ms: Number(refined ? row.refined_t1_ms : row.original_t1_ms),
        text: refined ? row.refined_text : row.original_text
      }
    }).sort((left, right) => left.eventOrder - right.eventOrder)
    const inputWatermark = Math.max(...items.map((item) => item.eventOrder))
    const digestPayload = { sessionId, inputWatermark, transcriptVersion: input.transcriptVersion, items }
    const ref = {
      sessionId,
      inputWatermark,
      transcriptVersion: input.transcriptVersion,
      inputDigest: sha256Canonical(digestPayload)
    }
    return { inputRef: ref, items }
  }

  readInputSnapshot (input) {
    this.assertOpen()
    exactObject(input, ['inputRef'])
    const expected = inputReference(input.inputRef)
    const snapshot = this.readInput({
      sessionId: expected.sessionId,
      transcriptVersion: expected.transcriptVersion
    })
    if (!sameInputReference(snapshot.inputRef, expected)) {
      throw new StorageError('AGENT_INPUT_CHANGED')
    }
    return snapshot
  }

  evaluateEligibility (input) {
    this.assertOpen()
    exactObject(input, ['sessionId', 'requestedBy', 'eligibilityContext'])
    const sessionId = boundedString(input.sessionId)
    if (!['automatic', 'user'].includes(input.requestedBy)) throw new StorageError('AGENT_REQUEST_INVALID')
    const context = eligibilityContext(input.eligibilityContext)
    const session = this.sessionFact(sessionId)
    const result = (eligibility, inputRef = null) => ({ eligibility, inputRef })

    if (!['closed', 'interrupted'].includes(session.state) || session.ended_at === null) {
      return result('session_not_terminal')
    }
    const segmentCount = Number(this.database.prepare(
      'SELECT COUNT(*) AS count FROM segments WHERE session_id = ?'
    ).get(sessionId).count)
    if (segmentCount === 0) return result('no_committed_transcript')

    if (input.requestedBy === 'automatic') {
      if (context.automaticProcessingSince === null) {
        if (context.agentEnabled) throw new StorageError('AGENT_REQUEST_INVALID')
      } else if (Number(session.ended_at) < context.automaticProcessingSince) {
        return result('outside_automatic_window')
      }
    }
    if (!context.agentEnabled) return result('agent_disabled')
    const configuration = providerSnapshot(context)
    if (!configuration) return result('provider_not_configured')
    if (configuration.providerKind === 'cloud') {
      if (!context.cloudDisclosureAccepted) return result('cloud_disclosure_required')
      if (!context.credentialAvailable) return result('credential_unavailable')
    } else if (!context.localModelReady) {
      return result('local_model_not_ready')
    }
    return result('ready', this.readInput({ sessionId, transcriptVersion: 'original' }).inputRef)
  }

  getJob (runId) {
    const id = boundedString(runId)
    const job = rowJob(this.database.prepare('SELECT * FROM agent_jobs WHERE run_id = ?').get(id))
    if (!job) throw new StorageError('AGENT_JOB_NOT_FOUND')
    return job
  }

  listJobs (sessionId = null) {
    const rows = sessionId === null
      ? this.database.prepare('SELECT * FROM agent_jobs ORDER BY job_order').all()
      : this.database.prepare('SELECT * FROM agent_jobs WHERE session_id = ? ORDER BY job_order').all(boundedString(sessionId))
    return rows.map(rowJob)
  }

  reconcileTerminalSession (input) {
    this.assertOpen()
    exactObject(input, ['sessionId', 'requestedBy', 'eligibilityContext'])
    if (input.requestedBy !== 'automatic') throw new StorageError('AGENT_REQUEST_INVALID')
    const context = eligibilityContext(input.eligibilityContext)
    const evaluation = this.evaluateEligibility({
      sessionId: input.sessionId,
      requestedBy: 'automatic',
      eligibilityContext: context
    })
    if (evaluation.eligibility !== 'ready') return { ...evaluation, jobs: [] }
    const configuration = providerSnapshot(context)
    if (!configuration) throw new StorageError('AGENT_REQUEST_INVALID')
    const inputRef = evaluation.inputRef
    const now = this.nowValue()
    const database = this.database
    const jobs = []
    database.exec('BEGIN IMMEDIATE')
    try {
      const session = this.sessionFact(inputRef.sessionId)
      const memoryEligible = context.memoryEnabled && context.memoryProcessingSince !== null &&
        Number(session.ended_at) >= context.memoryProcessingSince
      const taskKinds = memoryEligible
        ? AUTOMATIC_TASK_KINDS
        : AUTOMATIC_TASK_KINDS.filter((taskKind) => taskKind !== 'memory-extraction')
      for (const taskKind of taskKinds) {
        const task = taskDefinition(taskKind)
        const identity = {
          sessionId: inputRef.sessionId,
          pluginId: task.pluginId,
          artifactKind: task.artifactKind,
          transcriptVersion: inputRef.transcriptVersion,
          inputWatermark: inputRef.inputWatermark,
          inputDigest: inputRef.inputDigest,
          recipeVersion: task.recipeVersion
        }
        const dedupeKey = sha256Canonical(identity)
        const requestDigest = sha256Canonical({
          ...identity,
          providerId: configuration.providerId,
          providerKind: configuration.providerKind,
          model: configuration.model
        })
        const inserted = database.prepare(`
          INSERT INTO agent_jobs(
            job_id, run_id, dedupe_key, client_idempotency_key, request_digest,
            session_id, plugin_id, artifact_kind, transcript_version,
            input_watermark, input_digest, recipe_version,
            provider, provider_kind, model, state, attempt_count, max_attempts,
            next_attempt_at, lease_owner, lease_expires_at, cancel_requested_at,
            error_code, requested_by, created_at, updated_at
          ) VALUES (
            ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'queued', 0, 3, ?, NULL, NULL, NULL, NULL, 'automatic', ?, ?
          )
          ON CONFLICT(dedupe_key) DO NOTHING
        `).run(
          this.nextId(), this.nextId(), dedupeKey, requestDigest,
          inputRef.sessionId, task.pluginId, task.artifactKind,
          inputRef.transcriptVersion, inputRef.inputWatermark, inputRef.inputDigest,
          task.recipeVersion, configuration.providerId, configuration.providerKind,
          configuration.model, now, now, now
        )
        const row = database.prepare('SELECT * FROM agent_jobs WHERE dedupe_key = ?').get(dedupeKey)
        jobs.push({ status: Number(inserted.changes) === 1 ? 'created' : 'already_processed', job: rowJob(row) })
      }
      database.exec('COMMIT')
      return { eligibility: 'ready', inputRef, jobs }
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }

  requestJob (input) {
    this.assertOpen()
    exactObject(input, ['inputRef', 'taskKind', 'clientIdempotencyKey', 'requestDigest', 'eligibilityContext'])
    const ref = inputReference(input.inputRef)
    const task = taskDefinition(input.taskKind)
    const clientIdempotencyKey = boundedString(input.clientIdempotencyKey)
    const requestDigest = sha256Value(input.requestDigest)
    const context = eligibilityContext(input.eligibilityContext)
    const expectedDigest = makeUserRequestDigest({ inputRef: ref, taskKind: input.taskKind, eligibilityContext: context })
    if (requestDigest !== expectedDigest) throw new StorageError('AGENT_REQUEST_INVALID')

    const prior = this.database.prepare(
      'SELECT * FROM agent_jobs WHERE client_idempotency_key = ?'
    ).get(clientIdempotencyKey)
    if (prior) {
      if (prior.request_digest !== requestDigest) throw new StorageError('AGENT_REQUEST_INVALID')
      return { status: 'already_processed', eligibility: 'ready', job: rowJob(prior) }
    }

    const evaluation = this.evaluateEligibility({
      sessionId: ref.sessionId,
      requestedBy: 'user',
      eligibilityContext: context
    })
    if (evaluation.eligibility !== 'ready') return { status: 'not_eligible', ...evaluation, job: null }
    if (input.taskKind === 'memory-extraction' && !context.memoryEnabled) {
      throw new StorageError('AGENT_REQUEST_INVALID')
    }
    const snapshot = this.readInput({ sessionId: ref.sessionId, transcriptVersion: ref.transcriptVersion })
    if (!sameInputReference(snapshot.inputRef, ref)) throw new StorageError('AGENT_INPUT_CHANGED')
    const configuration = providerSnapshot(context)
    if (!configuration) throw new StorageError('AGENT_REQUEST_INVALID')
    const now = this.nowValue()
    const dedupeKey = sha256Canonical({ requestedBy: 'user', clientIdempotencyKey, requestDigest })
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      const replay = database.prepare(
        'SELECT * FROM agent_jobs WHERE client_idempotency_key = ?'
      ).get(clientIdempotencyKey)
      if (replay) {
        if (replay.request_digest !== requestDigest) throw new StorageError('AGENT_REQUEST_INVALID')
        database.exec('COMMIT')
        return { status: 'already_processed', eligibility: 'ready', job: rowJob(replay) }
      }
      database.prepare(`
        INSERT INTO agent_jobs(
          job_id, run_id, dedupe_key, client_idempotency_key, request_digest,
          session_id, plugin_id, artifact_kind, transcript_version,
          input_watermark, input_digest, recipe_version,
          provider, provider_kind, model, state, attempt_count, max_attempts,
          next_attempt_at, lease_owner, lease_expires_at, cancel_requested_at,
          error_code, requested_by, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'queued', 0, 3, ?, NULL, NULL, NULL, NULL, 'user', ?, ?
        )
      `).run(
        this.nextId(), this.nextId(), dedupeKey, clientIdempotencyKey, requestDigest,
        ref.sessionId, task.pluginId, task.artifactKind, ref.transcriptVersion,
        ref.inputWatermark, ref.inputDigest, task.recipeVersion,
        configuration.providerId, configuration.providerKind, configuration.model,
        now, now, now
      )
      const row = database.prepare('SELECT * FROM agent_jobs WHERE client_idempotency_key = ?').get(clientIdempotencyKey)
      database.exec('COMMIT')
      return { status: 'created', eligibility: 'ready', job: rowJob(row) }
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }

  recoverExpired (now) {
    const database = this.database
    database.prepare(`
      UPDATE agent_jobs
      SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
          lease_renewed_from_expires_at = NULL,
          error_code = NULL, updated_at = ?
      WHERE state = 'running' AND lease_expires_at <= ? AND cancel_requested_at IS NOT NULL
    `).run(now, now)
    database.prepare(`
      UPDATE agent_jobs
      SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
          lease_renewed_from_expires_at = NULL,
          error_code = 'AGENT_WORKER_EXITED', updated_at = ?
      WHERE state = 'running' AND lease_expires_at <= ?
        AND cancel_requested_at IS NULL AND attempt_count >= max_attempts
    `).run(now, now)
    database.prepare(`
      UPDATE agent_jobs
      SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL,
          lease_renewed_from_expires_at = NULL,
          error_code = 'AGENT_WORKER_EXITED', updated_at = ?
      WHERE state = 'running' AND lease_expires_at <= ?
        AND cancel_requested_at IS NULL AND attempt_count < max_attempts
    `).run(now, now)
    database.prepare(`
      UPDATE agent_jobs
      SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
          lease_renewed_from_expires_at = NULL,
          error_code = NULL, updated_at = ?
      WHERE state IN ('queued', 'retry_wait') AND cancel_requested_at IS NOT NULL
    `).run(now)
  }

  claimNextJob (input) {
    this.assertOpen()
    exactObject(input, ['claimIdempotencyKey', 'owner', 'leaseMs', 'localWorkAllowed', 'availableTaskKinds'])
    const claimIdempotencyKey = boundedString(input.claimIdempotencyKey)
    const owner = boundedString(input.owner)
    const taskKinds = availableTaskKinds(input.availableTaskKinds)
    if (!Number.isSafeInteger(input.leaseMs) || input.leaseMs < 1000 || input.leaseMs > 120000 ||
        typeof input.localWorkAllowed !== 'boolean') {
      throw new StorageError('AGENT_REQUEST_INVALID')
    }
    const requestDigest = sha256Canonical({
      owner,
      leaseMs: input.leaseMs,
      localWorkAllowed: input.localWorkAllowed,
      availableTaskKinds: taskKinds
    })
    const now = this.nowValue()
    const expiresAt = now + input.leaseMs
    if (!Number.isSafeInteger(expiresAt)) throw new StorageError('AGENT_REQUEST_INVALID')
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      this.recoverExpired(now)
      const receipt = database.prepare(`
        SELECT * FROM agent_claim_receipts WHERE claim_idempotency_key = ?
      `).get(claimIdempotencyKey)
      if (receipt) {
        if (receipt.request_digest !== requestDigest) throw new StorageError('AGENT_REQUEST_INVALID')
        if (receipt.run_id === null) {
          database.exec('COMMIT')
          return null
        }
        const replay = database.prepare('SELECT * FROM agent_jobs WHERE run_id = ?').get(receipt.run_id)
        const matches = replay && replay.state === 'running' &&
          replay.lease_owner === receipt.lease_owner &&
          Number(replay.lease_expires_at) === Number(receipt.lease_expires_at)
        database.exec('COMMIT')
        return matches ? rowJob(replay) : null
      }

      const context = this.currentPolicy
      const configuration = context ? providerSnapshot(context) : null
      const providerReady = !!(context?.agentEnabled && configuration && (
        (configuration.providerKind === 'cloud' && context.cloudDisclosureAccepted && context.credentialAvailable) ||
        (configuration.providerKind === 'local' && context.localModelReady)
      ))
      if (!providerReady || taskKinds.length === 0) {
        database.prepare(`
          INSERT INTO agent_claim_receipts(
            claim_idempotency_key, request_digest, run_id, lease_owner, lease_expires_at, created_at
          ) VALUES (?, ?, NULL, NULL, NULL, ?)
        `).run(claimIdempotencyKey, requestDigest, now)
        database.exec('COMMIT')
        return null
      }
      const taskPlaceholders = taskKinds.map(() => '?').join(', ')
      const row = database.prepare(`
        SELECT agent_jobs.* FROM agent_jobs
        JOIN sessions ON sessions.session_id = agent_jobs.session_id
        WHERE agent_jobs.state IN ('queued', 'retry_wait')
          AND agent_jobs.next_attempt_at <= ?
          AND agent_jobs.cancel_requested_at IS NULL
          AND agent_jobs.attempt_count < agent_jobs.max_attempts
          AND agent_jobs.provider = ?
          AND agent_jobs.provider_kind = ?
          AND agent_jobs.model = ?
          AND agent_jobs.plugin_id IN (${taskPlaceholders})
          AND (? = 1 OR agent_jobs.provider_kind = 'cloud')
          AND (
            agent_jobs.requested_by = 'user' OR sessions.ended_at >= ?
          )
          AND (
            agent_jobs.plugin_id <> 'memory-extraction' OR
            (? = 1 AND (
              agent_jobs.requested_by = 'user' OR sessions.ended_at >= ?
            ))
          )
        ORDER BY agent_jobs.next_attempt_at, agent_jobs.job_order
        LIMIT 1
      `).get(
        now,
        configuration.providerId,
        configuration.providerKind,
        configuration.model,
        ...taskKinds,
        input.localWorkAllowed ? 1 : 0,
        context.automaticProcessingSince,
        context.memoryEnabled ? 1 : 0,
        context.memoryProcessingSince ?? Number.MAX_SAFE_INTEGER
      )
      if (!row) {
        database.prepare(`
          INSERT INTO agent_claim_receipts(
            claim_idempotency_key, request_digest, run_id, lease_owner, lease_expires_at, created_at
          ) VALUES (?, ?, NULL, NULL, NULL, ?)
        `).run(claimIdempotencyKey, requestDigest, now)
        database.exec('COMMIT')
        return null
      }
      const changed = database.prepare(`
        UPDATE agent_jobs
        SET state = 'running', attempt_count = attempt_count + 1,
            lease_owner = ?, lease_expires_at = ?, lease_renewed_from_expires_at = NULL,
            error_code = NULL, updated_at = ?
        WHERE job_id = ? AND state IN ('queued', 'retry_wait') AND cancel_requested_at IS NULL
      `).run(owner, expiresAt, now, row.job_id)
      if (Number(changed.changes) !== 1) throw new StorageError('AGENT_JOB_STATE_CONFLICT')
      const claimed = database.prepare('SELECT * FROM agent_jobs WHERE job_id = ?').get(row.job_id)
      database.prepare(`
        INSERT INTO agent_claim_receipts(
          claim_idempotency_key, request_digest, run_id, lease_owner, lease_expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(claimIdempotencyKey, requestDigest, claimed.run_id, owner, expiresAt, now)
      database.exec('COMMIT')
      return rowJob(claimed)
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }

  requireLease (runId, lease, options = {}) {
    const id = boundedString(runId, 1, 160, 'AGENT_JOB_STATE_CONFLICT')
    const expected = leaseValue(lease)
    const now = options.now === undefined ? this.nowValue() : options.now
    const row = this.database.prepare('SELECT * FROM agent_jobs WHERE run_id = ?').get(id)
    const hasCancel = row?.cancel_requested_at !== null
    const cancelMatches = options.cancel === true ? hasCancel : options.cancel === false ? !hasCancel : true
    if (!row || row.state !== 'running' || row.lease_owner !== expected.owner ||
        Number(row.lease_expires_at) !== expected.expiresAt || expected.expiresAt <= now || !cancelMatches) {
      throw new StorageError('AGENT_JOB_STATE_CONFLICT')
    }
    return row
  }

  renewJobLease (input) {
    this.assertOpen()
    exactObject(input, ['runId', 'lease', 'newExpiresAt'])
    const lease = leaseValue(input.lease)
    const newExpiresAt = timestamp(input.newExpiresAt)
    const now = this.nowValue()
    if (newExpiresAt <= now || newExpiresAt <= lease.expiresAt || newExpiresAt > now + 120000) {
      throw new StorageError('AGENT_REQUEST_INVALID')
    }
    const current = this.database.prepare('SELECT * FROM agent_jobs WHERE run_id = ?').get(
      boundedString(input.runId, 1, 160, 'AGENT_JOB_STATE_CONFLICT')
    )
    if (current?.state === 'running' && current.cancel_requested_at === null &&
        current.lease_owner === lease.owner && Number(current.lease_expires_at) === newExpiresAt &&
        current.lease_renewed_from_expires_at !== null &&
        Number(current.lease_renewed_from_expires_at) === lease.expiresAt) {
      return rowJob(current)
    }
    const row = this.requireLease(input.runId, lease, { now, cancel: false })
    const changed = this.database.prepare(`
      UPDATE agent_jobs
      SET lease_expires_at = ?, lease_renewed_from_expires_at = ?, updated_at = ?
      WHERE job_id = ? AND state = 'running' AND lease_owner = ? AND lease_expires_at = ?
        AND cancel_requested_at IS NULL
    `).run(newExpiresAt, lease.expiresAt, now, row.job_id, lease.owner, lease.expiresAt)
    if (Number(changed.changes) !== 1) throw new StorageError('AGENT_JOB_STATE_CONFLICT')
    return this.getJob(input.runId)
  }

  markJobRetry (input) {
    this.assertOpen()
    exactObject(input, ['runId', 'lease', 'errorCode', 'nextAttemptAt'])
    if (!RETRYABLE_ERROR_CODES.includes(input.errorCode)) throw new StorageError('AGENT_REQUEST_INVALID')
    const nextAttemptAt = timestamp(input.nextAttemptAt)
    const lease = leaseValue(input.lease)
    const current = this.database.prepare('SELECT * FROM agent_jobs WHERE run_id = ?').get(
      boundedString(input.runId, 1, 160, 'AGENT_JOB_STATE_CONFLICT')
    )
    const replayState = current && Number(current.attempt_count) >= Number(current.max_attempts)
      ? 'failed'
      : 'retry_wait'
    if (current?.state === replayState && current.error_code === input.errorCode &&
        Number(current.next_attempt_at) === nextAttemptAt && current.lease_owner === null) {
      return rowJob(current)
    }
    const now = this.nowValue()
    if (nextAttemptAt < now) throw new StorageError('AGENT_REQUEST_INVALID')
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.requireLease(input.runId, lease, { now, cancel: false })
      const terminal = Number(row.attempt_count) >= Number(row.max_attempts)
      const changed = database.prepare(`
        UPDATE agent_jobs
        SET state = ?, next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL,
            lease_renewed_from_expires_at = NULL,
            error_code = ?, updated_at = ?
        WHERE job_id = ? AND state = 'running' AND lease_owner = ? AND lease_expires_at = ?
          AND cancel_requested_at IS NULL
      `).run(
        terminal ? 'failed' : 'retry_wait', nextAttemptAt,
        input.errorCode, now, row.job_id, lease.owner, lease.expiresAt
      )
      if (Number(changed.changes) !== 1) throw new StorageError('AGENT_JOB_STATE_CONFLICT')
      const updated = database.prepare('SELECT * FROM agent_jobs WHERE job_id = ?').get(row.job_id)
      database.exec('COMMIT')
      return rowJob(updated)
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }

  markJobFailed (input) {
    this.assertOpen()
    exactObject(input, ['runId', 'lease', 'errorCode'])
    if (!TERMINAL_ERROR_CODES.includes(input.errorCode)) throw new StorageError('AGENT_REQUEST_INVALID')
    const lease = leaseValue(input.lease)
    const current = this.database.prepare('SELECT * FROM agent_jobs WHERE run_id = ?').get(
      boundedString(input.runId, 1, 160, 'AGENT_JOB_STATE_CONFLICT')
    )
    if (current?.state === 'failed' && current.error_code === input.errorCode && current.lease_owner === null) {
      return rowJob(current)
    }
    const now = this.nowValue()
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.requireLease(input.runId, lease, { now, cancel: false })
      const changed = database.prepare(`
        UPDATE agent_jobs
        SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL,
            lease_renewed_from_expires_at = NULL,
            error_code = ?, updated_at = ?
        WHERE job_id = ? AND state = 'running' AND lease_owner = ? AND lease_expires_at = ?
          AND cancel_requested_at IS NULL
      `).run(input.errorCode, now, row.job_id, lease.owner, lease.expiresAt)
      if (Number(changed.changes) !== 1) throw new StorageError('AGENT_JOB_STATE_CONFLICT')
      const updated = database.prepare('SELECT * FROM agent_jobs WHERE job_id = ?').get(row.job_id)
      database.exec('COMMIT')
      return rowJob(updated)
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }

  requestCancel (input) {
    this.assertOpen()
    exactObject(input, ['runId'])
    const runId = boundedString(input.runId)
    const now = this.nowValue()
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      const row = database.prepare('SELECT * FROM agent_jobs WHERE run_id = ?').get(runId)
      if (!row) throw new StorageError('AGENT_JOB_NOT_FOUND')
      if (['queued', 'retry_wait', 'running'].includes(row.state)) {
        database.prepare(`
          UPDATE agent_jobs
          SET cancel_requested_at = ?, updated_at = ?
          WHERE run_id = ? AND cancel_requested_at IS NULL
        `).run(now, now, runId)
        database.prepare(`
          UPDATE agent_jobs
          SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
              lease_renewed_from_expires_at = NULL,
              error_code = NULL, updated_at = ?
          WHERE run_id = ? AND state IN ('queued', 'retry_wait')
        `).run(now, runId)
      }
      const updated = database.prepare('SELECT * FROM agent_jobs WHERE run_id = ?').get(runId)
      database.exec('COMMIT')
      return rowJob(updated)
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }

  markJobCancelled (input) {
    this.assertOpen()
    exactObject(input, ['runId', 'lease'])
    const lease = leaseValue(input.lease)
    const current = this.database.prepare('SELECT * FROM agent_jobs WHERE run_id = ?').get(
      boundedString(input.runId, 1, 160, 'AGENT_JOB_STATE_CONFLICT')
    )
    if (current?.state === 'cancelled' && current.error_code === null &&
        current.cancel_requested_at !== null && current.lease_owner === null) {
      return rowJob(current)
    }
    const now = this.nowValue()
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      const row = this.requireLease(input.runId, lease, { now, cancel: true })
      const changed = database.prepare(`
        UPDATE agent_jobs
        SET state = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
            lease_renewed_from_expires_at = NULL,
            error_code = NULL, updated_at = ?
        WHERE job_id = ? AND state = 'running' AND lease_owner = ? AND lease_expires_at = ?
          AND cancel_requested_at IS NOT NULL
      `).run(now, row.job_id, lease.owner, lease.expiresAt)
      if (Number(changed.changes) !== 1) throw new StorageError('AGENT_JOB_STATE_CONFLICT')
      const updated = database.prepare('SELECT * FROM agent_jobs WHERE job_id = ?').get(row.job_id)
      database.exec('COMMIT')
      return rowJob(updated)
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }

  applyTaskPolicy (input) {
    this.assertOpen()
    exactObject(input, ['eligibilityContext'])
    const context = eligibilityContext(input.eligibilityContext)
    const now = this.nowValue()
    const scope = !context.agentEnabled
      ? '1 = 1'
      : (!context.memoryEnabled ? "plugin_id = 'memory-extraction'" : '0 = 1')
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      const running = database.prepare(`
        UPDATE agent_jobs
        SET cancel_requested_at = ?, updated_at = ?
        WHERE state = 'running' AND cancel_requested_at IS NULL AND ${scope}
      `).run(now, now)
      const queued = database.prepare(`
        UPDATE agent_jobs
        SET state = 'cancelled', cancel_requested_at = COALESCE(cancel_requested_at, ?),
            lease_owner = NULL, lease_expires_at = NULL,
            lease_renewed_from_expires_at = NULL, error_code = NULL, updated_at = ?
        WHERE state IN ('queued', 'retry_wait') AND ${scope}
      `).run(now, now)
      database.exec('COMMIT')
      this.currentPolicy = structuredClone(context)
      return {
        queuedCancelled: Number(queued.changes),
        runningCancellationRequested: Number(running.changes)
      }
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }

  commitArtifact (input) {
    this.assertOpen()
    exactObject(input, ['runId', 'lease', 'artifact'])
    const runId = boundedString(input.runId)
    const lease = leaseValue(input.lease)
    let requestDigest
    try {
      requestDigest = sha256Canonical(input.artifact)
    } catch {
      throw new StorageError('AGENT_OUTPUT_INVALID')
    }
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      const job = database.prepare('SELECT * FROM agent_jobs WHERE run_id = ?').get(runId)
      if (!job) throw new StorageError('AGENT_JOB_NOT_FOUND')
      const prior = database.prepare('SELECT * FROM agent_artifacts WHERE run_id = ?').get(runId)
      if (job.state === 'succeeded') {
        if (job.result_digest !== requestDigest || !prior) throw new StorageError('AGENT_OUTPUT_INVALID')
        database.exec('COMMIT')
        return rowArtifact(prior)
      }
      if (!['meeting-minutes', 'enhanced-transcript'].includes(job.plugin_id)) {
        throw new StorageError('AGENT_OUTPUT_INVALID')
      }
      const now = this.nowValue()
      this.requireLease(runId, lease, { now, cancel: false })
      const snapshot = this.readInput({
        sessionId: job.session_id,
        transcriptVersion: job.transcript_version
      })
      if (!sameInputReference(snapshot.inputRef, rowJob(job).inputRef)) {
        throw new StorageError('AGENT_INPUT_CHANGED')
      }
      const validEventOrders = new Set(snapshot.items.map((item) => item.eventOrder))
      const artifact = artifactValue(input.artifact, job.plugin_id, validEventOrders)
      const contentJson = canonicalize(artifact.content)
      const contentDigest = sha256Canonical(artifact.content)
      const superseded = database.prepare(`
        SELECT artifact_id FROM agent_artifacts
        WHERE session_id = ? AND plugin_id = ? AND type = ? AND run_id <> ?
        ORDER BY created_at DESC, artifact_id DESC LIMIT 1
      `).get(job.session_id, job.plugin_id, artifact.type, runId)
      const artifactId = this.nextId()
      database.prepare(`
        INSERT INTO agent_artifacts(
          artifact_id, run_id, session_id, plugin_id, type, content_json, content_digest,
          transcript_version, input_through_event_order, input_digest, recipe_version,
          provider, model, supersedes_artifact_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        artifactId, runId, job.session_id, job.plugin_id, artifact.type, contentJson, contentDigest,
        job.transcript_version, job.input_watermark, job.input_digest, job.recipe_version,
        job.provider, job.model, superseded?.artifact_id ?? null, now
      )
      const summaryJson = canonicalize({ artifactId })
      const changed = database.prepare(`
        UPDATE agent_jobs
        SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
            lease_renewed_from_expires_at = NULL,
            error_code = NULL, result_digest = ?, result_summary_json = ?, updated_at = ?
        WHERE run_id = ? AND state = 'running' AND lease_owner = ? AND lease_expires_at = ?
          AND cancel_requested_at IS NULL
      `).run(requestDigest, summaryJson, now, runId, lease.owner, lease.expiresAt)
      if (Number(changed.changes) !== 1) throw new StorageError('AGENT_JOB_STATE_CONFLICT')
      const stored = database.prepare('SELECT * FROM agent_artifacts WHERE artifact_id = ?').get(artifactId)
      database.exec('COMMIT')
      return rowArtifact(stored)
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }

  commitMemoryCandidates (input) {
    this.assertOpen()
    exactObject(input, ['runId', 'lease', 'candidates'])
    const runId = boundedString(input.runId)
    const lease = leaseValue(input.lease)
    if (!Array.isArray(input.candidates) || input.candidates.length > 200) {
      throw new StorageError('AGENT_OUTPUT_INVALID')
    }
    let requestDigest
    try {
      requestDigest = sha256Canonical(input.candidates)
    } catch {
      throw new StorageError('AGENT_OUTPUT_INVALID')
    }
    const database = this.database
    database.exec('BEGIN IMMEDIATE')
    try {
      const job = database.prepare('SELECT * FROM agent_jobs WHERE run_id = ?').get(runId)
      if (!job) throw new StorageError('AGENT_JOB_NOT_FOUND')
      if (job.state === 'succeeded') {
        if (job.plugin_id !== 'memory-extraction' || job.result_digest !== requestDigest) {
          throw new StorageError('AGENT_OUTPUT_INVALID')
        }
        const summary = resultSummary(job)
        database.exec('COMMIT')
        return { runId, state: 'succeeded', ...summary }
      }
      if (job.plugin_id !== 'memory-extraction') throw new StorageError('AGENT_OUTPUT_INVALID')
      const now = this.nowValue()
      this.requireLease(runId, lease, { now, cancel: false })
      const snapshot = this.readInput({
        sessionId: job.session_id,
        transcriptVersion: job.transcript_version
      })
      if (!sameInputReference(snapshot.inputRef, rowJob(job).inputRef)) {
        throw new StorageError('AGENT_INPUT_CHANGED')
      }
      const validEventOrders = new Set(snapshot.items.map((item) => item.eventOrder))
      const candidates = input.candidates.map((candidate) =>
        memoryCandidate(candidate, validEventOrders, job.session_id)
      )
      const touchedMemoryIds = new Set()
      let acceptedCandidateCount = 0
      let discardedCandidateCount = 0
      let evidenceCount = 0
      let revisionCount = 0

      for (const candidate of candidates) {
        const filtered = candidate.salienceBand === 'low' ||
          (candidate.origin === 'automatic' && candidate.confidenceBand === 'low') ||
          (candidate.kind === 'preference' && candidate.scope.kind === 'global')
        if (filtered) {
          discardedCandidateCount += 1
          continue
        }
        const scopeId = `scope-${sha256Canonical({
          kind: candidate.scope.kind,
          canonicalKey: candidate.scope.canonicalKey
        })}`
        database.prepare(`
          INSERT INTO memory_scopes(
            scope_id, kind, canonical_key, label, session_id, origin, lifecycle, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'automatic', 'active', ?, ?)
          ON CONFLICT(kind, canonical_key) DO NOTHING
        `).run(
          scopeId, candidate.scope.kind, candidate.scope.canonicalKey, candidate.scope.label,
          candidate.scope.kind === 'session' ? job.session_id : null, now, now
        )
        const scope = database.prepare(`
          SELECT * FROM memory_scopes WHERE kind = ? AND canonical_key = ?
        `).get(candidate.scope.kind, candidate.scope.canonicalKey)
        if (!scope || (candidate.scope.kind === 'session' && scope.session_id !== job.session_id)) {
          throw new StorageError('AGENT_OUTPUT_INVALID')
        }
        const identityHash = sha256Canonical({
          scopeId: scope.scope_id,
          kind: candidate.kind,
          semanticKey: candidate.semanticKey
        })
        const suppressed = database.prepare(`
          SELECT 1 FROM memory_suppressions WHERE identity_hash = ? AND source_digest = ?
        `).get(identityHash, job.input_digest)
        if (suppressed) {
          discardedCandidateCount += 1
          continue
        }

        let memory = database.prepare(`
          SELECT * FROM memory_items WHERE scope_id = ? AND kind = ? AND semantic_key = ?
        `).get(scope.scope_id, candidate.kind, candidate.semanticKey)
        if (memory && memory.content_json !== candidate.contentJson &&
            memory.origin === 'explicit' && candidate.origin === 'automatic') {
          discardedCandidateCount += 1
          continue
        }
        let memoryId = memory?.memory_id
        if (!memory) {
          memoryId = this.nextId()
          database.prepare(`
            INSERT INTO memory_items(
              memory_id, scope_id, kind, semantic_key, content_json, origin,
              confidence_band, salience_band, lifecycle, current_revision_id,
              created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)
          `).run(
            memoryId, scope.scope_id, candidate.kind, candidate.semanticKey, candidate.contentJson,
            candidate.origin, candidate.confidenceBand, candidate.salienceBand, now, now
          )
          const revisionId = this.nextId()
          database.prepare(`
            INSERT INTO memory_revisions(
              revision_id, memory_id, operation, content_json, previous_revision_id, run_id, created_at
            ) VALUES (?, ?, 'create', ?, NULL, ?, ?)
          `).run(revisionId, memoryId, candidate.contentJson, runId, now)
          database.prepare(`
            UPDATE memory_items SET current_revision_id = ? WHERE memory_id = ?
          `).run(revisionId, memoryId)
          revisionCount += 1
          memory = database.prepare('SELECT * FROM memory_items WHERE memory_id = ?').get(memoryId)
        } else if (memory.content_json !== candidate.contentJson) {
          const revisionId = this.nextId()
          const lifecycle = memory.origin === 'automatic' && candidate.origin === 'automatic'
            ? 'conflicted'
            : 'active'
          database.prepare(`
            INSERT INTO memory_revisions(
              revision_id, memory_id, operation, content_json, previous_revision_id, run_id, created_at
            ) VALUES (?, ?, 'replace', ?, ?, ?, ?)
          `).run(revisionId, memoryId, candidate.contentJson, memory.current_revision_id, runId, now)
          database.prepare(`
            UPDATE memory_items
            SET content_json = ?, origin = ?, confidence_band = ?, salience_band = ?,
                lifecycle = ?, current_revision_id = ?, updated_at = ?
            WHERE memory_id = ?
          `).run(
            candidate.contentJson, candidate.origin, candidate.confidenceBand,
            candidate.salienceBand, lifecycle, revisionId, now, memoryId
          )
          revisionCount += 1
        }

        for (const range of candidate.evidence) {
          const inserted = database.prepare(`
            INSERT INTO memory_evidence(
              evidence_id, run_id, memory_id, session_id, transcript_version,
              input_watermark, from_event_order, through_event_order, input_digest,
              plugin_id, recipe_version, provider, model, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'memory-extraction', 'memory-extraction@1', ?, ?, ?)
            ON CONFLICT(memory_id, session_id, transcript_version, from_event_order, through_event_order, input_digest)
            DO NOTHING
          `).run(
            this.nextId(), runId, memoryId, job.session_id, job.transcript_version,
            job.input_watermark, range.fromEventOrder, range.throughEventOrder, job.input_digest,
            job.provider, job.model, now
          )
          evidenceCount += Number(inserted.changes)
        }
        acceptedCandidateCount += 1
        touchedMemoryIds.add(memoryId)
      }

      const summary = {
        acceptedCandidateCount,
        discardedCandidateCount,
        memoryItemCount: touchedMemoryIds.size,
        evidenceCount,
        revisionCount
      }
      const summaryJson = canonicalize(summary)
      const changed = database.prepare(`
        UPDATE agent_jobs
        SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL,
            lease_renewed_from_expires_at = NULL,
            error_code = NULL, result_digest = ?, result_summary_json = ?, updated_at = ?
        WHERE run_id = ? AND state = 'running' AND lease_owner = ? AND lease_expires_at = ?
          AND cancel_requested_at IS NULL
      `).run(requestDigest, summaryJson, now, runId, lease.owner, lease.expiresAt)
      if (Number(changed.changes) !== 1) throw new StorageError('AGENT_JOB_STATE_CONFLICT')
      database.exec('COMMIT')
      return { runId, state: 'succeeded', ...summary }
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }

  readMemoryContext (input) {
    this.assertOpen()
    const query = memoryQuery(input)
    const reason = memoryDormantReason(this.currentPolicy)
    if (reason !== null) {
      return {
        availability: 'dormant',
        reason,
        items: [],
        itemCount: 0,
        serializedBytes: 0,
        hasMore: false
      }
    }

    const scopePredicate = query.scopeRefs
      .map(() => '(scope.kind = ? AND scope.canonical_key = ?)')
      .join(' OR ')
    const kindPredicate = query.kinds.map(() => '?').join(', ')
    const semanticPredicate = query.semanticKeys.length === 0
      ? ''
      : `AND item.semantic_key IN (${query.semanticKeys.map(() => '?').join(', ')})`
    const scopeParameters = query.scopeRefs.flatMap((scope) => [scope.kind, scope.canonicalKey])
    const rows = this.database.prepare(`
      SELECT
        item.memory_id,
        item.kind,
        item.semantic_key,
        item.content_json,
        item.origin,
        item.confidence_band,
        item.salience_band,
        item.current_revision_id,
        item.updated_at,
        scope.kind AS scope_kind,
        scope.canonical_key,
        scope.label,
        revision.memory_id AS revision_memory_id,
        revision.content_json AS revision_content_json,
        (
          SELECT COUNT(*) FROM memory_evidence AS evidence
          WHERE evidence.memory_id = item.memory_id
        ) AS evidence_count
      FROM memory_items AS item
      JOIN memory_scopes AS scope ON scope.scope_id = item.scope_id
      LEFT JOIN memory_revisions AS revision
        ON revision.revision_id = item.current_revision_id
       AND revision.memory_id = item.memory_id
      WHERE scope.lifecycle = 'active'
        AND item.lifecycle = 'active'
        AND (${scopePredicate})
        AND item.kind IN (${kindPredicate})
        ${semanticPredicate}
      ORDER BY
        CASE item.origin WHEN 'explicit' THEN 0 ELSE 1 END,
        CASE item.salience_band WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        CASE item.confidence_band WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
        evidence_count DESC,
        item.updated_at DESC,
        item.memory_id ASC
      LIMIT ?
    `).all(
      ...scopeParameters,
      ...query.kinds,
      ...query.semanticKeys,
      MEMORY_QUERY_CANDIDATE_LIMIT
    )

    /* 命中读取上限时保守报告 hasMore；不为精确探测第 257 条而读取其正文。 */
    let hasMore = rows.length === MEMORY_QUERY_CANDIDATE_LIMIT
    let serializedBytes = 0
    const items = []
    for (const row of rows) {
      if (items.length >= query.maxItems) {
        hasMore = true
        break
      }
      if (row.current_revision_id === null || row.revision_memory_id !== row.memory_id ||
          row.revision_content_json !== row.content_json) {
        throw new StorageError('STORAGE_COMMAND_FAILED')
      }
      let content
      try {
        content = JSON.parse(row.content_json)
        if (!content || typeof content !== 'object' || Array.isArray(content) ||
            canonicalize(content) !== row.content_json) {
          throw new Error('invalid memory projection')
        }
      } catch {
        throw new StorageError('STORAGE_COMMAND_FAILED')
      }
      const evidence = this.database.prepare(`
        SELECT
          session_id,
          transcript_version,
          input_watermark,
          from_event_order,
          through_event_order,
          input_digest
        FROM memory_evidence
        WHERE memory_id = ?
        ORDER BY created_at DESC, evidence_id DESC
        LIMIT 8
      `).all(row.memory_id).map((source) => ({
        sessionId: source.session_id,
        transcriptVersion: source.transcript_version,
        inputWatermark: Number(source.input_watermark),
        fromEventOrder: Number(source.from_event_order),
        throughEventOrder: Number(source.through_event_order),
        inputDigest: source.input_digest
      }))
      const item = {
        memoryId: row.memory_id,
        scope: {
          kind: row.scope_kind,
          canonicalKey: row.canonical_key,
          label: row.label
        },
        kind: row.kind,
        semanticKey: row.semantic_key,
        content,
        origin: row.origin,
        confidenceBand: row.confidence_band,
        salienceBand: row.salience_band,
        revisionId: row.current_revision_id,
        updatedAt: Number(row.updated_at),
        evidenceCount: Number(row.evidence_count),
        evidence
      }
      const itemBytes = Buffer.byteLength(canonicalize(item), 'utf8')
      if (serializedBytes + itemBytes > query.maxSerializedBytes) {
        hasMore = true
        continue
      }
      items.push(item)
      serializedBytes += itemBytes
    }
    return {
      availability: 'ready',
      reason: null,
      items,
      itemCount: items.length,
      serializedBytes,
      hasMore
    }
  }

  deleteMemoryItem (input) {
    this.assertOpen()
    exactObject(input, ['memoryId', 'deletionIdempotencyKey'])
    const memoryId = boundedString(input.memoryId)
    const deletionIdempotencyKey = boundedString(input.deletionIdempotencyKey)
    const requestDigest = sha256Canonical({ memoryId })
    const database = this.database
    const deletionResult = (row) => ({
      memoryId: row.memory_id,
      suppressedSourceCount: Number(row.suppressed_source_count),
      deletedEvidenceCount: Number(row.deleted_evidence_count),
      deletedRevisionCount: Number(row.deleted_revision_count),
      deletedAt: Number(row.deleted_at)
    })
    database.exec('BEGIN IMMEDIATE')
    try {
      const prior = database.prepare(`
        SELECT * FROM memory_deletion_receipts WHERE deletion_idempotency_key = ?
      `).get(deletionIdempotencyKey)
      if (prior) {
        if (prior.request_digest !== requestDigest || prior.memory_id !== memoryId) {
          throw new StorageError('AGENT_REQUEST_INVALID')
        }
        database.exec('COMMIT')
        return deletionResult(prior)
      }

      const memory = database.prepare(`
        SELECT memory_id, scope_id, kind, semantic_key
        FROM memory_items WHERE memory_id = ?
      `).get(memoryId)
      if (!memory) throw new StorageError('AGENT_REQUEST_INVALID')
      const sourceDigests = database.prepare(`
        SELECT DISTINCT input_digest
        FROM memory_evidence WHERE memory_id = ?
        ORDER BY input_digest
      `).all(memoryId).map((row) => row.input_digest)
      const identityHash = sha256Canonical({
        scopeId: memory.scope_id,
        kind: memory.kind,
        semanticKey: memory.semantic_key
      })
      const deletedAt = this.nowValue()
      for (const sourceDigest of sourceDigests) {
        database.prepare(`
          INSERT INTO memory_suppressions(identity_hash, scope_id, source_digest, created_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(identity_hash, source_digest) DO NOTHING
        `).run(identityHash, memory.scope_id, sourceDigest, deletedAt)
      }
      const { deletedEvidenceCount, deletedRevisionCount } = deleteMemoryGraph(database, memoryId)
      database.prepare(`
        INSERT INTO memory_deletion_receipts(
          deletion_idempotency_key, request_digest, memory_id, suppressed_source_count,
          deleted_evidence_count, deleted_revision_count, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        deletionIdempotencyKey,
        requestDigest,
        memoryId,
        sourceDigests.length,
        deletedEvidenceCount,
        deletedRevisionCount,
        deletedAt
      )
      const receipt = database.prepare(`
        SELECT * FROM memory_deletion_receipts WHERE deletion_idempotency_key = ?
      `).get(deletionIdempotencyKey)
      database.exec('COMMIT')
      return deletionResult(receipt)
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }

  deleteSessionData (input) {
    this.assertOpen()
    exactObject(input, ['sessionId', 'deletionIdempotencyKey'])
    const sessionId = boundedString(input.sessionId)
    const deletionIdempotencyKey = boundedString(input.deletionIdempotencyKey)
    const requestDigest = sha256Canonical({ sessionId })
    const database = this.database
    const deletionResult = (row) => ({
      sessionId: row.session_id,
      deletedJobCount: Number(row.deleted_job_count),
      deletedArtifactCount: Number(row.deleted_artifact_count),
      deletedDebugThreadCount: Number(row.deleted_debug_thread_count),
      deletedMemoryEvidenceCount: Number(row.deleted_memory_evidence_count),
      deletedOrphanMemoryCount: Number(row.deleted_orphan_memory_count),
      deletedAt: Number(row.deleted_at)
    })
    database.exec('BEGIN IMMEDIATE')
    try {
      const priorByKey = database.prepare(`
        SELECT * FROM session_deletion_tombstones WHERE deletion_idempotency_key = ?
      `).get(deletionIdempotencyKey)
      if (priorByKey) {
        if (priorByKey.session_id !== sessionId || priorByKey.request_digest !== requestDigest) {
          throw new StorageError('AGENT_REQUEST_INVALID')
        }
        database.exec('COMMIT')
        return deletionResult(priorByKey)
      }
      if (database.prepare(`
        SELECT 1 FROM session_deletion_tombstones WHERE session_id = ?
      `).get(sessionId)) {
        throw new StorageError('AGENT_REQUEST_INVALID')
      }
      const session = database.prepare('SELECT * FROM sessions WHERE session_id = ?').get(sessionId)
      if (!session) throw new StorageError('AGENT_SESSION_NOT_FOUND')
      if (!['closed', 'interrupted'].includes(session.state) || session.ended_at === null) {
        throw new StorageError('AGENT_SESSION_NOT_TERMINAL')
      }
      const scalar = (sql) => Number(database.prepare(sql).get(sessionId).count)
      const deletedJobCount = scalar('SELECT COUNT(*) AS count FROM agent_jobs WHERE session_id = ?')
      const deletedArtifactCount = scalar('SELECT COUNT(*) AS count FROM agent_artifacts WHERE session_id = ?')
      const deletedDebugThreadCount = scalar('SELECT COUNT(*) AS count FROM agent_debug_threads WHERE selected_session_id = ?')
      const deletedMemoryEvidenceCount = scalar('SELECT COUNT(*) AS count FROM memory_evidence WHERE session_id = ?')
      const orphanRows = database.prepare(`
        SELECT DISTINCT item.memory_id
        FROM memory_items AS item
        JOIN memory_scopes AS scope ON scope.scope_id = item.scope_id
        LEFT JOIN memory_evidence AS own
          ON own.memory_id = item.memory_id AND own.session_id = ?
        WHERE scope.session_id = ? OR (
          item.origin = 'automatic' AND own.evidence_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM memory_evidence AS other
            WHERE other.memory_id = item.memory_id AND other.session_id <> ?
          )
        )
      `).all(sessionId, sessionId, sessionId)
      const deletedOrphanMemoryCount = orphanRows.length
      const now = this.nowValue()
      database.prepare(`
        INSERT INTO session_deletion_tombstones(
          session_id, deletion_idempotency_key, request_digest,
          deleted_job_count, deleted_artifact_count, deleted_debug_thread_count,
          deleted_memory_evidence_count, deleted_orphan_memory_count, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId, deletionIdempotencyKey, requestDigest,
        deletedJobCount, deletedArtifactCount, deletedDebugThreadCount,
        deletedMemoryEvidenceCount, deletedOrphanMemoryCount, now
      )
      for (const row of orphanRows) {
        deleteMemoryGraph(database, row.memory_id)
      }
      database.prepare('DELETE FROM memory_evidence WHERE session_id = ?').run(sessionId)
      database.prepare('DELETE FROM memory_scopes WHERE session_id = ?').run(sessionId)
      database.prepare('DELETE FROM agent_debug_threads WHERE selected_session_id = ?').run(sessionId)
      database.prepare('DELETE FROM agent_jobs WHERE session_id = ?').run(sessionId)
      database.prepare('DELETE FROM recognition_session_configs WHERE session_id = ?').run(sessionId)
      database.prepare('DELETE FROM refinement_session_results WHERE session_id = ?').run(sessionId)
      database.prepare('DELETE FROM segments WHERE session_id = ?').run(sessionId)
      database.prepare('DELETE FROM caption_events WHERE session_id = ?').run(sessionId)
      database.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId)
      const tombstone = database.prepare(`
        SELECT * FROM session_deletion_tombstones WHERE session_id = ?
      `).get(sessionId)
      database.exec('COMMIT')
      return deletionResult(tombstone)
    } catch (error) {
      rollbackQuietly(database)
      throw error
    }
  }

  getSessionDetail (input) {
    this.assertOpen()
    exactObject(input, ['sessionId', 'eligibilityContext'])
    const evaluation = this.evaluateEligibility({
      sessionId: input.sessionId,
      requestedBy: 'user',
      eligibilityContext: input.eligibilityContext
    })
    const sessionId = boundedString(input.sessionId)
    const artifacts = this.database.prepare(`
      SELECT artifact_id, run_id, session_id, plugin_id, type, content_json, content_digest,
             transcript_version, input_through_event_order, input_digest,
             recipe_version, provider, model, supersedes_artifact_id, created_at
      FROM agent_artifacts WHERE session_id = ?
      ORDER BY created_at DESC, artifact_id DESC
    `).all(sessionId).map(rowArtifact)
    return {
      ...evaluation,
      jobs: this.database.prepare(`
        SELECT * FROM agent_jobs WHERE session_id = ? ORDER BY job_order
      `).all(sessionId).map(publicJob),
      artifacts
    }
  }
}

module.exports = {
  AUTOMATIC_TASK_KINDS,
  ELIGIBILITY_CONTEXT_KEYS,
  FORMAL_AGENT_TASKS,
  FormalAgentStore,
  RETRYABLE_ERROR_CODES,
  TERMINAL_ERROR_CODES,
  eligibilityContext,
  inputReference,
  makeUserRequestDigest,
  publicJob,
  rowArtifact,
  rowJob
}
