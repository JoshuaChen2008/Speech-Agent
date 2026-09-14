'use strict'
const { sha256Canonical } = require('./canonical-json')
const { StorageError, assertExactKeys } = require('./protocol')
const { rollbackQuietly } = require('./sqlite-store')
function exactObject (value, keys) {
  assertExactKeys(value, keys, 'AGENT_REQUEST_INVALID')
  if (Object.keys(value).length !== keys.length) throw new StorageError('AGENT_REQUEST_INVALID')
}
function boundedString (value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160) throw new StorageError('AGENT_REQUEST_INVALID')
  return value
}
class SessionDeletionStore {
  constructor ({ subtitleStore, personalContextStore, now = subtitleStore.now || (() => Date.now()) }) {
    this.subtitleStore = subtitleStore
    this.database = subtitleStore.database
    this.personalContextStore = personalContextStore
    this.now = now
  }
  nowValue () {
    const value = this.now()
    if (!Number.isSafeInteger(value) || value < 0) throw new StorageError('STORAGE_COMMAND_FAILED')
    return value
  }
  deleteSessionData (input) {
    this.subtitleStore.assertOpen()
    if (this.database.retirementFailure) throw new StorageError(this.database.retirementFailure)
    const personalContextStore = this.personalContextStore
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
      deletedInteractionCount: Number(row.deleted_interaction_count),
      deletedToolCallCount: Number(row.deleted_tool_call_count),
      deletedReportPresentationCount: Number(row.deleted_report_presentation_count || 0),
      deletedEpisodeCount: Number(row.deleted_episode_count),
      deletedContextEvidenceCount: Number(row.deleted_context_evidence_count),
      deletedOrphanContextItemCount: Number(row.deleted_orphan_context_item_count),
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
      const deletedJobCount = 0
      const deletedArtifactCount = 0
      const deletedDebugThreadCount = 0
      const deletedMemoryEvidenceCount = 0
      /* Formal v7 rows are linked to a session either directly through their
         frozen session scope or through an interaction-signal episode whose
         scope owns the session.  Gather both sets before context deletion so
         the tombstone counts describe the rows actually removed. */
      const formalRunIds = new Set()
      for (const row of database.prepare('SELECT run_id, scope_json FROM formal_agent_runs').all()) {
        let scope
        try { scope = JSON.parse(row.scope_json) } catch { throw new StorageError('STORAGE_COMMAND_FAILED') }
        if (scope?.kind === 'session' && scope.reference === sessionId) formalRunIds.add(row.run_id)
      }
      if (personalContextStore) {
        for (const row of database.prepare(`
          SELECT DISTINCT episode.ingest_run_id
          FROM personal_context_episodes AS episode
          JOIN personal_context_scopes AS scope ON scope.scope_id = episode.scope_id
          WHERE episode.source_kind = 'interaction' AND scope.kind = 'session' AND scope.session_id = ?
        `).all(sessionId)) formalRunIds.add(row.ingest_run_id)
      }
      const formalInteractionRows = []
      for (const row of database.prepare('SELECT interaction_id, run_id, scope_json FROM formal_agent_interactions').all()) {
        let scope
        try { scope = JSON.parse(row.scope_json) } catch { throw new StorageError('STORAGE_COMMAND_FAILED') }
        if (formalRunIds.has(row.run_id) || (scope?.kind === 'session' && scope.reference === sessionId)) {
          formalInteractionRows.push(row)
          formalRunIds.add(row.run_id)
        }
      }
      const formalInteractionIds = formalInteractionRows.map((row) => row.interaction_id)
      const deletedInteractionCount = formalInteractionIds.length
      const deletedToolCallCount = formalInteractionIds.length === 0
        ? 0
        : Number(database.prepare(`
          SELECT COUNT(*) AS count FROM formal_agent_tool_calls
          WHERE interaction_id IN (${formalInteractionIds.map(() => '?').join(',')})
        `).get(...formalInteractionIds).count)
      const deletedReportPresentationCount = Number(database.prepare(
        'SELECT COUNT(*) AS count FROM formal_agent_report_presentations WHERE session_id = ?'
      ).get(sessionId).count)
      const contextDeletion = personalContextStore
        ? personalContextStore.planSessionDeletion(sessionId)
        : { episodeCount: 0, evidenceCount: 0, orphanItemIds: [] }
      const deletedEpisodeCount = contextDeletion.episodeCount
      const deletedContextEvidenceCount = contextDeletion.evidenceCount
      const deletedOrphanMemoryCount = 0
      const deletedOrphanContextItemCount = contextDeletion.orphanItemIds.length
      const now = this.nowValue()
      database.prepare(`
        INSERT INTO session_deletion_tombstones(
          session_id, deletion_idempotency_key, request_digest,
          deleted_job_count, deleted_artifact_count, deleted_debug_thread_count,
          deleted_memory_evidence_count, deleted_orphan_memory_count,
          deleted_interaction_count, deleted_tool_call_count, deleted_episode_count,
          deleted_context_evidence_count, deleted_orphan_context_item_count,
          deleted_report_presentation_count, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sessionId, deletionIdempotencyKey, requestDigest,
        deletedJobCount, deletedArtifactCount, deletedDebugThreadCount,
        deletedMemoryEvidenceCount, deletedOrphanMemoryCount,
        deletedInteractionCount, deletedToolCallCount, deletedEpisodeCount,
        deletedContextEvidenceCount, deletedOrphanContextItemCount,
        deletedReportPresentationCount, now
      )
      if (personalContextStore) personalContextStore.applySessionDeletion(sessionId, contextDeletion, now)
      if (formalInteractionIds.length > 0) {
        database.prepare(`
          DELETE FROM formal_agent_tool_calls
          WHERE interaction_id IN (${formalInteractionIds.map(() => '?').join(',')})
        `).run(...formalInteractionIds)
        database.prepare(`
          DELETE FROM formal_agent_interactions
          WHERE interaction_id IN (${formalInteractionIds.map(() => '?').join(',')})
        `).run(...formalInteractionIds)
      }
      const formalRunIdList = [...formalRunIds]
      if (formalRunIdList.length > 0) {
        database.prepare(`
          DELETE FROM formal_agent_run_claim_receipts
          WHERE run_id IN (${formalRunIdList.map(() => '?').join(',')})
        `).run(...formalRunIdList)
        database.prepare(`
          DELETE FROM formal_agent_runs
          WHERE run_id IN (${formalRunIdList.map(() => '?').join(',')})
        `).run(...formalRunIdList)
      }
      database.prepare('DELETE FROM formal_agent_report_presentations WHERE session_id = ?').run(sessionId)
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

}
module.exports = { SessionDeletionStore }
