'use strict'

const crypto = require('node:crypto')
const { SqliteSubtitleStore } = require('../../runtime/storage-worker/subtitle-store')
const { rollbackQuietly } = require('../../runtime/storage-worker/sqlite-store')
const { sha256Canonical, canonicalize } = require('../canonical-json')
const { AgentCoreError } = require('../errors')
const { PROVIDER_IDS, inputReference, boundedString } = require('../contracts')
const { referenceOutput } = require('../reference-output')
const { AGENT_MVP_MIGRATIONS } = require('./schema')

const uuid = () => crypto.randomUUID()
const RETRYABLE_ERROR_CODES = Object.freeze(['AGENT_PROVIDER_RATE_LIMITED', 'AGENT_PROVIDER_TIMEOUT', 'AGENT_PROVIDER_UNAVAILABLE', 'AGENT_WORKER_EXITED'])
const TERMINAL_ERROR_CODES = Object.freeze(['AGENT_PROVIDER_AUTH_FAILED', 'AGENT_OUTPUT_INVALID', 'AGENT_PERMISSION_DENIED', 'AGENT_REQUEST_INVALID', 'AGENT_INTERNAL_FAILURE'])

function providerValue (value) {
  if (!PROVIDER_IDS.includes(value)) throw new AgentCoreError('AGENT_REQUEST_INVALID')
  return value
}

function rowJob (row) {
  if (!row) return null
  return {
    jobId: row.job_id, runId: row.run_id, state: row.state, sessionId: row.session_id,
    inputRef: { sessionId: row.session_id, inputWatermark: Number(row.input_watermark), transcriptVersion: row.transcript_version, inputDigest: row.input_digest },
    recipeVersion: row.recipe_version, provider: row.provider, model: row.model,
    attemptCount: Number(row.attempt_count), maxAttempts: Number(row.max_attempts),
    nextAttemptAt: Number(row.next_attempt_at),
    lease: row.lease_owner === null ? null : { owner: row.lease_owner, expiresAt: Number(row.lease_expires_at) },
    cancelRequestedAt: row.cancel_requested_at === null ? null : Number(row.cancel_requested_at),
    errorCode: row.error_code, requestedBy: row.requested_by, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at)
  }
}

function debugMessageContent (role, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentCoreError('AGENT_REQUEST_INVALID')
  const keys = Object.keys(value).sort().join(',')
  if (['user', 'assistant'].includes(role)) {
    if (keys !== 'text' || typeof value.text !== 'string' || value.text.length < 1 || value.text.length > 20000) throw new AgentCoreError('AGENT_REQUEST_INVALID')
    return { text: value.text }
  }
  if (role === 'tool_preview') {
    if (keys !== 'cloudDisclosure,inputRef,recipeId,runId' || typeof value.runId !== 'string' || value.recipeId !== 'reference-output-v1' || typeof value.cloudDisclosure !== 'boolean') throw new AgentCoreError('AGENT_REQUEST_INVALID')
    return { runId: value.runId, recipeId: value.recipeId, inputRef: inputReference(value.inputRef), cloudDisclosure: value.cloudDisclosure }
  }
  if (role === 'tool_confirmation') {
    if (keys !== 'decision,runId' || typeof value.runId !== 'string' || !['accepted', 'rejected'].includes(value.decision)) throw new AgentCoreError('AGENT_REQUEST_INVALID')
    return { runId: value.runId, decision: value.decision }
  }
  if (role === 'tool_result') {
    if (keys !== 'artifactId,runId,state' || typeof value.runId !== 'string' ||
        !['succeeded', 'failed', 'cancelled'].includes(value.state) || (value.artifactId !== null && typeof value.artifactId !== 'string')) throw new AgentCoreError('AGENT_REQUEST_INVALID')
    return { runId: value.runId, state: value.state, artifactId: value.artifactId }
  }
  if (role === 'status') {
    if (keys !== 'code' || !['CHAT_STARTED', 'CHAT_CANCELLED', 'PROVIDER_UNAVAILABLE'].includes(value.code)) throw new AgentCoreError('AGENT_REQUEST_INVALID')
    return { code: value.code }
  }
  throw new AgentCoreError('AGENT_REQUEST_INVALID')
}

class AgentMvpStore {
  constructor (options) {
    if (!options || typeof options.databasePath !== 'string') throw new TypeError('databasePath is required')
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
    this.subtitleStore = new SqliteSubtitleStore({ ...options, now: this.now, migrations: AGENT_MVP_MIGRATIONS })
    this.database = this.subtitleStore.database
  }

  createFixtureSession ({ sessionId = `fixture-${uuid()}`, sourceId = 'loopback', captions }) {
    if (!Array.isArray(captions) || captions.length < 1 || captions.some((text) => typeof text !== 'string' || text.length < 1)) {
      throw new AgentCoreError('AGENT_FIXTURE_INVALID')
    }
    const startedAt = this.now()
    this.subtitleStore.openSession({ sessionId, sourceId, startedAt, refinementEnabled: false })
    captions.forEach((text, index) => this.subtitleStore.appendCaption({
      schemaVersion: 1, sessionId, sourceId,
      segmentId: `segment-${index + 1}`, sequence: index + 1, revision: 1,
      kind: 'final', t0: index, t1: index + 1, text, translation: null
    }))
    this.subtitleStore.closeSession({ sessionId, sourceId, endedAt: Math.max(this.now(), startedAt), state: 'closed' })
    return this.readInput({ sessionId, transcriptVersion: 'original' })
  }

  listTerminalSessions () {
    return this.database.prepare(`SELECT session_id, source_id, started_at, ended_at, state FROM sessions
      WHERE state IN ('closed','interrupted') AND ended_at IS NOT NULL ORDER BY started_at DESC, session_id DESC`).all().map((row) => ({
      sessionId: row.session_id, sourceId: row.source_id, startedAt: Number(row.started_at), endedAt: Number(row.ended_at), state: row.state
    }))
  }

  readInput ({ sessionId, transcriptVersion }) {
    boundedString(sessionId, 1, 160)
    if (!['original', 'refined'].includes(transcriptVersion)) throw new AgentCoreError('AGENT_REQUEST_INVALID')
    const session = this.database.prepare(`SELECT state, ended_at FROM sessions WHERE session_id = ?`).get(sessionId)
    if (!session) throw new AgentCoreError('AGENT_SESSION_NOT_FOUND')
    if (!['closed', 'interrupted'].includes(session.state) || session.ended_at === null) throw new AgentCoreError('AGENT_SESSION_NOT_TERMINAL')
    const rows = this.database.prepare(`
      SELECT s.segment_id, s.source_id, s.first_event_order,
             origin.text AS original_text,
             (SELECT refined.text FROM caption_events refined
              WHERE refined.session_id=s.session_id AND refined.source_id=s.source_id
                AND refined.segment_id=s.segment_id AND refined.kind='refined'
              ORDER BY refined.revision DESC, refined.event_order DESC LIMIT 1) AS refined_text,
             (SELECT refined.event_order FROM caption_events refined
              WHERE refined.session_id=s.session_id AND refined.source_id=s.source_id
                AND refined.segment_id=s.segment_id AND refined.kind='refined'
              ORDER BY refined.revision DESC, refined.event_order DESC LIMIT 1) AS refined_event_order
      FROM segments s JOIN caption_events origin ON origin.event_order=s.first_event_order
      WHERE s.session_id=? ORDER BY origin.t0_ms, s.first_event_order
    `).all(sessionId)
    if (rows.length < 1) throw new AgentCoreError('AGENT_INPUT_EMPTY')
    if (transcriptVersion === 'refined' && rows.some((row) => row.refined_text === null)) throw new AgentCoreError('AGENT_INPUT_VERSION_UNAVAILABLE')
    const items = rows.map((row) => ({ segmentId: row.segment_id, sourceId: row.source_id, text: transcriptVersion === 'original' ? row.original_text : row.refined_text }))
    const inputWatermark = Math.max(...rows.map((row) => Number(transcriptVersion === 'original' ? row.first_event_order : row.refined_event_order)))
    const digestPayload = { sessionId, inputWatermark, transcriptVersion, items }
    const inputDigest = sha256Canonical(digestPayload)
    return { inputRef: inputReference({ sessionId, inputWatermark, transcriptVersion, inputDigest }), items }
  }

  createUserJob ({ inputRef, provider, model, clientIdempotencyKey }) {
    const ref = inputReference(inputRef)
    providerValue(provider)
    boundedString(model, 1, 160)
    boundedString(clientIdempotencyKey, 1, 160)
    const snapshot = this.readInput({ sessionId: ref.sessionId, transcriptVersion: ref.transcriptVersion })
    if (snapshot.inputRef.inputWatermark !== ref.inputWatermark || snapshot.inputRef.inputDigest !== ref.inputDigest) {
      throw new AgentCoreError('AGENT_INPUT_CHANGED')
    }
    const request = { inputRef: ref, pluginId: 'reference-structured-output', artifactKind: 'reference-output', recipeVersion: '1', provider, model }
    const requestDigest = sha256Canonical(request)
    const db = this.database; const now = this.now(); const runId = uuid(); const jobId = uuid()
    db.exec('BEGIN IMMEDIATE')
    try {
      const prior = db.prepare('SELECT * FROM agent_jobs WHERE client_idempotency_key=?').get(clientIdempotencyKey)
      if (prior) {
        if (prior.request_digest !== requestDigest) throw new AgentCoreError('AGENT_REQUEST_INVALID')
        db.exec('COMMIT')
        return { status: 'already_processed', job: rowJob(prior) }
      }
      db.prepare(`INSERT INTO agent_jobs(job_id,run_id,dedupe_key,client_idempotency_key,request_digest,session_id,plugin_id,artifact_kind,transcript_version,input_watermark,input_digest,recipe_version,provider,model,state,attempt_count,max_attempts,next_attempt_at,lease_owner,lease_expires_at,cancel_requested_at,error_code,requested_by,created_at,updated_at)
        VALUES(?,?,NULL,?,?,?,'reference-structured-output','reference-output',?,?,?,'1',?,?,'queued',0,3,?,NULL,NULL,NULL,NULL,'user',?,?)`).run(
        jobId, runId, clientIdempotencyKey, requestDigest, ref.sessionId, ref.transcriptVersion, ref.inputWatermark, ref.inputDigest, provider, model, now, now, now)
      db.exec('COMMIT')
      return { status: 'created', job: this.getJob(runId) }
    } catch (error) { rollbackQuietly(db); throw error }
  }

  reconcileAutomaticJobs ({ provider, model }) {
    providerValue(provider)
    boundedString(model, 1, 160)
    const results = []
    for (const session of this.listTerminalSessions()) {
      const { inputRef } = this.readInput({ sessionId: session.sessionId, transcriptVersion: 'original' })
      const identity = {
        sessionId: inputRef.sessionId,
        pluginId: 'reference-structured-output',
        artifactKind: 'reference-output',
        transcriptVersion: inputRef.transcriptVersion,
        inputWatermark: inputRef.inputWatermark,
        inputDigest: inputRef.inputDigest,
        recipeVersion: '1'
      }
      const dedupeKey = sha256Canonical(identity)
      const requestDigest = sha256Canonical({ ...identity, provider, model })
      const now = this.now(); const runId = uuid(); const jobId = uuid(); const db = this.database
      db.exec('BEGIN IMMEDIATE')
      try {
        const inserted = db.prepare(`INSERT INTO agent_jobs(job_id,run_id,dedupe_key,client_idempotency_key,request_digest,session_id,plugin_id,artifact_kind,transcript_version,input_watermark,input_digest,recipe_version,provider,model,state,attempt_count,max_attempts,next_attempt_at,lease_owner,lease_expires_at,cancel_requested_at,error_code,requested_by,created_at,updated_at)
          VALUES(?,?,?,NULL,?,?,'reference-structured-output','reference-output',?,?,?,'1',?,?,'queued',0,3,?,NULL,NULL,NULL,NULL,'automatic',?,?)
          ON CONFLICT(dedupe_key) DO NOTHING`).run(
          jobId, runId, dedupeKey, requestDigest, inputRef.sessionId, inputRef.transcriptVersion, inputRef.inputWatermark, inputRef.inputDigest, provider, model, now, now, now)
        const row = db.prepare('SELECT * FROM agent_jobs WHERE dedupe_key=?').get(dedupeKey)
        db.exec('COMMIT')
        results.push({ status: Number(inserted.changes) === 1 ? 'created' : 'already_processed', job: rowJob(row) })
      } catch (error) { rollbackQuietly(db); throw error }
    }
    return results
  }

  getJob (runId) {
    boundedString(runId, 1, 160)
    const job = rowJob(this.database.prepare('SELECT * FROM agent_jobs WHERE run_id=?').get(runId))
    if (!job) throw new AgentCoreError('AGENT_JOB_NOT_FOUND')
    return job
  }

  listJobs () { return this.database.prepare('SELECT * FROM agent_jobs ORDER BY created_at DESC, job_id DESC').all().map(rowJob) }

  claimNext (owner, leaseMs = 30000) {
    boundedString(owner, 1, 160)
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 120000) throw new AgentCoreError('AGENT_REQUEST_INVALID')
    const now = this.now(); const db = this.database
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(`UPDATE agent_jobs SET state='cancelled',lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,updated_at=?
        WHERE state='running' AND lease_expires_at<=? AND cancel_requested_at IS NOT NULL`).run(now, now)
      db.prepare(`UPDATE agent_jobs SET state='failed',lease_owner=NULL,lease_expires_at=NULL,error_code='AGENT_WORKER_EXITED',updated_at=?
        WHERE state='running' AND lease_expires_at<=? AND cancel_requested_at IS NULL AND attempt_count>=max_attempts`).run(now, now)
      db.prepare(`UPDATE agent_jobs SET state='queued',lease_owner=NULL,lease_expires_at=NULL,error_code='AGENT_WORKER_EXITED',updated_at=?
        WHERE state='running' AND lease_expires_at<=? AND cancel_requested_at IS NULL AND attempt_count<max_attempts`).run(now, now)
      db.prepare(`UPDATE agent_jobs SET state='cancelled',lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,updated_at=?
        WHERE state IN ('queued','retry_wait') AND cancel_requested_at IS NOT NULL`).run(now)
      const row = db.prepare(`SELECT * FROM agent_jobs WHERE state IN ('queued','retry_wait') AND next_attempt_at<=? AND cancel_requested_at IS NULL AND attempt_count<max_attempts ORDER BY created_at,job_id LIMIT 1`).get(now)
      if (!row) { db.exec('COMMIT'); return null }
      db.prepare(`UPDATE agent_jobs SET state='running',attempt_count=attempt_count+1,lease_owner=?,lease_expires_at=?,error_code=NULL,updated_at=? WHERE job_id=?`).run(owner, now + leaseMs, now, row.job_id)
      db.exec('COMMIT')
      return this.getJob(row.run_id)
    } catch (error) { rollbackQuietly(db); throw error }
  }

  requestCancel (runId) {
    boundedString(runId, 1, 160)
    const now = this.now(); const db = this.database
    db.exec('BEGIN IMMEDIATE')
    try {
      db.prepare(`UPDATE agent_jobs SET cancel_requested_at=COALESCE(cancel_requested_at,?),updated_at=?
        WHERE run_id=? AND state IN ('queued','retry_wait','running')`).run(now, now, runId)
      const row = db.prepare('SELECT * FROM agent_jobs WHERE run_id=?').get(runId)
      if (!row) throw new AgentCoreError('AGENT_JOB_NOT_FOUND')
      db.exec('COMMIT')
      return rowJob(row)
    } catch (error) { rollbackQuietly(db); throw error }
  }

  requireLease (runId, lease, options = {}) {
    if (!lease || typeof lease !== 'object' || Array.isArray(lease) || Object.keys(lease).sort().join(',') !== 'expiresAt,owner' ||
        typeof lease.owner !== 'string' || !Number.isSafeInteger(lease.expiresAt)) throw new AgentCoreError('AGENT_JOB_STATE_CONFLICT')
    const row = this.database.prepare('SELECT * FROM agent_jobs WHERE run_id=?').get(runId)
    const now = options.now ?? this.now()
    if (!row || row.state !== 'running' || row.lease_owner !== lease.owner || Number(row.lease_expires_at) !== lease.expiresAt ||
        Number(row.lease_expires_at) <= now || (options.requireCancel ? row.cancel_requested_at === null : row.cancel_requested_at !== null)) {
      throw new AgentCoreError('AGENT_JOB_STATE_CONFLICT')
    }
    return row
  }

  markRetry (runId, lease, errorCode, delayMs) {
    if (!RETRYABLE_ERROR_CODES.includes(errorCode) || !Number.isSafeInteger(delayMs) || delayMs < 0) throw new AgentCoreError('AGENT_REQUEST_INVALID')
    const now = this.now(); const db = this.database
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.requireLease(runId, lease, { now })
      const terminal = Number(row.attempt_count) >= Number(row.max_attempts)
      const changed = db.prepare(`UPDATE agent_jobs SET state=?,next_attempt_at=?,lease_owner=NULL,lease_expires_at=NULL,error_code=?,updated_at=?
        WHERE run_id=? AND state='running' AND lease_owner=? AND lease_expires_at=? AND cancel_requested_at IS NULL`).run(
        terminal ? 'failed' : 'retry_wait', now + (terminal ? 0 : delayMs), errorCode, now, runId, lease.owner, lease.expiresAt)
      if (Number(changed.changes) !== 1) throw new AgentCoreError('AGENT_JOB_STATE_CONFLICT')
      db.exec('COMMIT'); return this.getJob(runId)
    } catch (error) { rollbackQuietly(db); throw error }
  }

  markFailed (runId, lease, errorCode) {
    if (!TERMINAL_ERROR_CODES.includes(errorCode)) throw new AgentCoreError('AGENT_REQUEST_INVALID')
    const now = this.now(); const db = this.database
    db.exec('BEGIN IMMEDIATE')
    try {
      this.requireLease(runId, lease, { now })
      const changed = db.prepare(`UPDATE agent_jobs SET state='failed',lease_owner=NULL,lease_expires_at=NULL,error_code=?,updated_at=?
        WHERE run_id=? AND state='running' AND lease_owner=? AND lease_expires_at=? AND cancel_requested_at IS NULL`).run(errorCode, now, runId, lease.owner, lease.expiresAt)
      if (Number(changed.changes) !== 1) throw new AgentCoreError('AGENT_JOB_STATE_CONFLICT')
      db.exec('COMMIT'); return this.getJob(runId)
    } catch (error) { rollbackQuietly(db); throw error }
  }

  markCancelled (runId, lease) {
    const now = this.now(); const db = this.database
    db.exec('BEGIN IMMEDIATE')
    try {
      this.requireLease(runId, lease, { now, requireCancel: true })
      const changed = db.prepare(`UPDATE agent_jobs SET state='cancelled',lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,updated_at=?
        WHERE run_id=? AND state='running' AND lease_owner=? AND lease_expires_at=? AND cancel_requested_at IS NOT NULL`).run(now, runId, lease.owner, lease.expiresAt)
      if (Number(changed.changes) !== 1) throw new AgentCoreError('AGENT_JOB_STATE_CONFLICT')
      db.exec('COMMIT'); return this.getJob(runId)
    } catch (error) { rollbackQuietly(db); throw error }
  }

  commitArtifact (runId, lease, content) {
    const value = referenceOutput(content); const now = this.now(); const db = this.database
    const contentJson = canonicalize(value); const contentDigest = sha256Canonical(value)
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = this.requireLease(runId, lease, { now })
      const job = rowJob(row)
      const currentInput = this.readInput({ sessionId: job.sessionId, transcriptVersion: job.inputRef.transcriptVersion })
      if (currentInput.inputRef.inputWatermark !== job.inputRef.inputWatermark || currentInput.inputRef.inputDigest !== job.inputRef.inputDigest ||
          job.recipeVersion !== '1' || row.plugin_id !== 'reference-structured-output' || row.artifact_kind !== 'reference-output') {
        throw new AgentCoreError('AGENT_REQUEST_INVALID')
      }
      const prior = db.prepare('SELECT * FROM agent_artifacts WHERE run_id=?').get(runId)
      if (prior && prior.content_digest !== contentDigest) throw new AgentCoreError('AGENT_ARTIFACT_CONFLICT')
      if (!prior) db.prepare(`INSERT INTO agent_artifacts(artifact_id,run_id,session_id,plugin_id,type,content_json,content_digest,transcript_version,input_watermark,input_digest,recipe_version,provider,model,supersedes_artifact_id,created_at)
        VALUES(?,?,?,'reference-structured-output','reference-output',?,?,?,?,?,?,?, ?,NULL,?)`).run(
        uuid(), runId, job.sessionId, contentJson, contentDigest, job.inputRef.transcriptVersion, job.inputRef.inputWatermark, job.inputRef.inputDigest, job.recipeVersion, job.provider, job.model, now)
      const changed = db.prepare(`UPDATE agent_jobs SET state='succeeded',lease_owner=NULL,lease_expires_at=NULL,error_code=NULL,updated_at=?
        WHERE run_id=? AND state='running' AND lease_owner=? AND lease_expires_at=? AND cancel_requested_at IS NULL`).run(now, runId, lease.owner, lease.expiresAt)
      if (Number(changed.changes) !== 1) throw new AgentCoreError('AGENT_JOB_STATE_CONFLICT')
      db.exec('COMMIT')
      return this.getArtifact(runId)
    } catch (error) { rollbackQuietly(db); throw error }
  }

  getArtifact (runId) {
    const row = this.database.prepare('SELECT * FROM agent_artifacts WHERE run_id=?').get(runId)
    if (!row) return null
    return { artifactId: row.artifact_id, runId: row.run_id, sessionId: row.session_id, type: row.type, content: JSON.parse(row.content_json), contentDigest: row.content_digest, createdAt: Number(row.created_at) }
  }

  createDebugThread (inputRef) {
    const ref = inputReference(inputRef)
    const snapshot = this.readInput({ sessionId: ref.sessionId, transcriptVersion: ref.transcriptVersion })
    if (snapshot.inputRef.inputWatermark !== ref.inputWatermark || snapshot.inputRef.inputDigest !== ref.inputDigest) throw new AgentCoreError('AGENT_INPUT_CHANGED')
    const threadId = uuid()
    this.database.prepare(`INSERT INTO agent_debug_threads(thread_id,session_id,transcript_version,input_watermark,input_digest,created_at) VALUES(?,?,?,?,?,?)`).run(
      threadId, ref.sessionId, ref.transcriptVersion, ref.inputWatermark, ref.inputDigest, this.now())
    return { threadId, inputRef: ref }
  }

  appendDebugMessage ({ threadId, role, content, provider = null, model = null }) {
    boundedString(threadId, 1, 160)
    if (!['user', 'assistant', 'tool_preview', 'tool_confirmation', 'tool_result', 'status'].includes(role)) throw new AgentCoreError('AGENT_REQUEST_INVALID')
    if ((provider !== null && (typeof provider !== 'string' || provider.length > 80)) ||
        (model !== null && (typeof model !== 'string' || model.length > 160))) throw new AgentCoreError('AGENT_REQUEST_INVALID')
    const contentJson = canonicalize(debugMessageContent(role, content))
    const messageId = uuid()
    this.database.prepare(`INSERT INTO agent_debug_messages(message_id,thread_id,role,content_json,provider,model,created_at) VALUES(?,?,?,?,?,?,?)`).run(
      messageId, threadId, role, contentJson, provider, model, this.now())
    return { messageId, threadId, role, content: JSON.parse(contentJson), provider, model }
  }

  listDebugMessages (threadId) {
    boundedString(threadId, 1, 160)
    return this.database.prepare(`SELECT message_id,thread_id,role,content_json,provider,model,created_at FROM agent_debug_messages WHERE thread_id=? ORDER BY message_order`).all(threadId).map((row) => ({
      messageId: row.message_id, threadId: row.thread_id, role: row.role, content: JSON.parse(row.content_json), provider: row.provider, model: row.model, createdAt: Number(row.created_at)
    }))
  }

  close () { this.subtitleStore.close() }
}

module.exports = { AgentMvpStore, RETRYABLE_ERROR_CODES, TERMINAL_ERROR_CODES, debugMessageContent, providerValue, rowJob }
