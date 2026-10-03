'use strict'

const { canonicalize, sha256Canonical } = require('./canonical-json')
const { StorageError, assertExactKeys } = require('./protocol')
const { rollbackQuietly } = require('./sqlite-store')
const { validateRecipeOutput } = require('../../agent/contracts/recipes')
const { memoryContent, memoryReadable } = require('./personal-memory-file-content')
const EMPTY_CURSOR = { memory: '', episode: '', done: false }
const refKey = (value) => canonicalize(value)
function fail (code) { throw new StorageError(code) }

// A bounded projection beside the existing context facts. This owns no model,
// scheduler or independent storage; formal runs supply all execution identity.
class PersonalMemoryOverviewStore {
  constructor (context) { this.context = context; this.database = context.database }

  memory (ref) {
    const row = this.database.prepare(`SELECT item.*,scope.kind AS scope_kind,scope.label AS scope_label FROM personal_context_items AS item
      JOIN personal_context_scopes AS scope ON scope.scope_id=item.scope_id WHERE item.memory_id=? AND scope.lifecycle='active'`).get(ref.memoryId)
    if (!row || !memoryReadable(this.database, row) || row.lifecycle !== 'active' || row.current_revision_id !== ref.revisionId) return null
    return { memoryRef: ref, kind: row.kind, origin: row.origin, scope: row.scope_label, displayText: memoryContent(this.database, row).displayText }
  }

  episode (ref) {
    const row = this.database.prepare("SELECT * FROM personal_context_episodes WHERE episode_id=? AND input_digest=? AND lifecycle='active'").get(ref.episodeId, ref.inputDigest)
    if (!row) return null
    const associations = this.context.sessionAssociations(row.session_id).filter((item) => item.sourceRef.sessionId === row.session_id)
    if (associations.length === 0) return null
    const summary = JSON.parse(row.summary_json)
    return { episodeRef: ref, title: summary.title, bullets: summary.bullets, associations }
  }

  validSection (section) {
    return section.memoryRefs.every((ref) => this.memory(ref)) && section.episodeRefs.every((ref) => this.episode(ref)) &&
      (section.category !== 'facts' || section.memoryRefs.every((ref) => this.memory(ref)?.origin === 'explicit'))
  }

  safeProjection (json) {
    if (!json) return null
    const projection = JSON.parse(json)
    const sections = projection.sections.filter((section) => this.validSection(section))
    return { ...projection, sections, revoked: projection.revoked === true || sections.length !== projection.sections.length }
  }

  invalidate () {
    for (const row of this.database.prepare('SELECT scope_key,current_json,previous_json FROM personal_context_overviews').all()) {
      const current = this.safeProjection(row.current_json); const previous = this.safeProjection(row.previous_json)
      this.database.prepare('UPDATE personal_context_overviews SET current_json=?,previous_json=? WHERE scope_key=?')
        .run(current ? canonicalize(current) : null, previous ? canonicalize(previous) : null, row.scope_key)
    }
  }

  view (scopeKey = 'global') {
    const row = this.database.prepare('SELECT overview.*,run.state AS run_state FROM personal_context_overviews AS overview LEFT JOIN formal_agent_runs AS run ON run.run_id=overview.run_id WHERE scope_key=?').get(scopeKey)
    const current = this.safeProjection(row?.current_json); const previous = this.safeProjection(row?.previous_json)
    const state = !row ? 'empty' : ['queued', 'running', 'retry_wait'].includes(row.run_state) ? 'updating' : row.run_state === 'failed' ? 'failed' : current?.revoked || (current && current.input_revision !== this.context.contentRevision()) ? 'stale' : current ? 'ready' : 'empty'
    if (current && this.context.automaticPolicy?.agentEnabled && this.context.automaticPolicy?.memoryEnabled) {
      const todos = this.database.prepare(`SELECT item.memory_id,item.current_revision_id,item.content_json FROM personal_context_items AS item
        JOIN personal_context_scopes AS scope ON scope.scope_id=item.scope_id WHERE item.kind='todo' AND item.origin='explicit'
          AND item.lifecycle='active' AND scope.lifecycle='active' AND (?='global' OR item.scope_id=?) ORDER BY item.updated_at DESC LIMIT 13`).all(scopeKey, scopeKey)
      const ongoing = todos.flatMap(item => {
        if (!memoryReadable(this.database, item)) return []
        const text = memoryContent(this.database, item).displayText
        const date = /\b(\d{4})-(\d{2})-(\d{2})\b/u.exec(text)
        const due = date ? new Date(Number(date[1]), Number(date[2]) - 1, Number(date[3])) : null
        const validDate = due && due.getFullYear() === Number(date[1]) && due.getMonth() === Number(date[2]) - 1 && due.getDate() === Number(date[3])
        if (validDate && this.context.nowValue() >= new Date(due.getFullYear(), due.getMonth(), due.getDate() + 1).getTime()) return []
        return [{ category: 'changes', title: '进行中的事项', text: Array.from(`${text}${validDate ? '' : '（截止时间未确认）'}`).slice(0, 600).join(''),
          memoryRefs: [{ memoryId: item.memory_id, revisionId: item.current_revision_id }], episodeRefs: [] }]
      })
      if (ongoing.length) {
        current.sections = [...current.sections.filter(section => section.title !== '进行中的事项'), ...ongoing].slice(-12)
        if (todos.length === 13 || ongoing.length > 12) current.coverage.omissions = ['budget']
      }
    }
    const sectionSources = (current?.sections || []).map((section) => {
      const sources = section.memoryRefs.flatMap((ref) => {
        const row = this.context.memoryRow(ref.memoryId)
        return row ? this.context.memorySources(row) : []
      })
      for (const ref of section.episodeRefs) {
        const row = this.database.prepare('SELECT * FROM personal_context_episodes WHERE episode_id=?').get(ref.episodeId)
        if (row) sources.push(this.context.episodeSource(row))
      }
      return sources.slice(0, 4).map((source) => ({ ...source, summary: Array.from(source.summary).slice(0, 160).join('') }))
    })
    return { scope_key: scopeKey, state, current, previous, section_sources: sectionSources, revision: this.context.contentRevision() }
  }

  batch (scope, cursor, scopeKey = 'global') {
    const memories = []; const episodes = []
    let bytes = 0; let memoryCursor = cursor.memory; let episodeCursor = cursor.episode
    const omissions = []
    const rows = this.database.prepare(`SELECT item.*,scope.kind AS scope_kind,scope.label AS scope_label FROM personal_context_items AS item
      JOIN personal_context_scopes AS scope ON scope.scope_id=item.scope_id
      WHERE item.lifecycle='active' AND scope.lifecycle='active' AND scope.kind<>'session' AND item.memory_id>?
        AND (?='global' OR item.scope_id=?) AND (item.origin='explicit' OR NOT EXISTS(
          SELECT 1 FROM personal_context_candidate_consumptions AS receipt WHERE receipt.scope_key=?
            AND receipt.memory_id=item.memory_id AND receipt.revision_id=item.current_revision_id))
        ORDER BY item.memory_id LIMIT 129`).all(cursor.memory, scope.kind, scope.reference, scopeKey)
    for (const row of rows.slice(0, 128)) {
      const item = this.memory({ memoryId: row.memory_id, revisionId: row.current_revision_id })
      if (!item) { memoryCursor = row.memory_id; continue }
      const size = Buffer.byteLength(canonicalize(item), 'utf8')
      if (size > 10000) { memoryCursor = row.memory_id; omissions.push('budget'); continue }
      if (bytes + size > 10000) break
      bytes += size; memories.push(item); memoryCursor = row.memory_id
    }
    const episodeRows = this.database.prepare(`SELECT DISTINCT episode.episode_id,episode.input_digest FROM personal_context_episodes AS episode
      JOIN personal_context_session_associations AS association ON association.episode_id=episode.episode_id
      JOIN personal_context_items AS memory ON memory.memory_id=association.memory_id
      WHERE episode.lifecycle='active' AND memory.lifecycle='active' AND memory.origin='explicit' AND memory.current_revision_id=association.revision_id
        AND episode.episode_id>? AND (?='global' OR memory.scope_id=?) ORDER BY episode.episode_id LIMIT 65`).all(cursor.episode, scope.kind, scope.reference)
    for (const row of episodeRows.slice(0, 64)) {
      const item = this.episode({ episodeId: row.episode_id, inputDigest: row.input_digest })
      if (!item) { episodeCursor = row.episode_id; continue }
      const size = Buffer.byteLength(canonicalize(item), 'utf8')
      if (size > 12000) { episodeCursor = row.episode_id; omissions.push('budget'); continue }
      if (bytes + size > 12000) break
      bytes += size; episodes.push(item); episodeCursor = row.episode_id
    }
    const hasMore = rows.some((row) => row.memory_id > memoryCursor) || episodeRows.some((row) => row.episode_id > episodeCursor)
    return { schemaVersion: 1, scope, memories, episodes,
      coverage: { memories: memories.length, episodes: episodes.length, hasMore, omissions: [...new Set(omissions)] },
      cursor: { memory: memoryCursor, episode: episodeCursor, done: !hasMore } }
  }

  prepare (retryFailed = false) {
    const database = this.database; const now = this.context.nowValue(); const revision = this.context.contentRevision()
    const scopes = [{ scopeKey: 'global', kind: 'global', reference: null }, ...database.prepare("SELECT scope_id,kind FROM personal_context_scopes WHERE kind IN ('project','topic') AND lifecycle='active' ORDER BY scope_id LIMIT 50").all().map((row) => ({ scopeKey: row.scope_id, kind: row.kind, reference: row.scope_id }))]
    let preparedCount = 0; let hasMore = false
    database.exec('BEGIN IMMEDIATE')
    try {
      for (const { scopeKey, ...scope } of scopes) {
        const old = database.prepare('SELECT overview.*,run.state AS run_state FROM personal_context_overviews AS overview LEFT JOIN formal_agent_runs AS run ON run.run_id=overview.run_id WHERE scope_key=?').get(scopeKey)
        if (old && ['queued', 'running', 'retry_wait'].includes(old.run_state)) continue
        const cursor = old && Number(old.target_revision) === revision ? JSON.parse(old.cursor_json) : { ...EMPTY_CURSOR }
        if (cursor.done || (!retryFailed && old?.run_state === 'failed' && Number(old.target_revision) === revision)) continue
        const retryOf = old?.run_state === 'cancelled' || (retryFailed && old?.run_state === 'failed') ? old.run_id : null
        const batch = this.batch(scope, cursor, scopeKey)
        const batchId = `batch.${sha256Canonical({ scopeKey, revision, retryOf, refs: batch.memories.map(item => item.memoryRef), cursor: batch.cursor }).slice(0, 44)}`
        batch.batchId = batchId; batch.inputRevision = revision
        const inputDigest = sha256Canonical(batch)
        const refs = { scope, memoryRefs: batch.memories.map((item) => item.memoryRef), episodeRefs: batch.episodes.map((item) => item.episodeRef), coverage: batch.coverage, cursor: batch.cursor, batchId, inputRevision: revision }
        const runId = `run.overview.${sha256Canonical({ scopeKey, revision, inputDigest, retryOf }).slice(0, 40)}`
        database.prepare(`INSERT INTO personal_context_overviews(scope_key,scope_json,target_revision,cursor_json,current_json,previous_json,run_id,updated_at)
          VALUES (?,?,?,?,NULL,NULL,NULL,?) ON CONFLICT(scope_key) DO UPDATE SET target_revision=excluded.target_revision,cursor_json=excluded.cursor_json,updated_at=excluded.updated_at`).run(scopeKey, canonicalize(scope), revision, canonicalize(cursor), now)
        if (batch.memories.length + batch.episodes.length === 0) {
          const current = this.safeProjection(old?.current_json)
          const sameRevision = current?.input_revision === revision
          const projection = { input_revision: revision, input_digest: inputDigest, updated_at: new Date(now).toISOString(), sections: sameRevision ? current.sections : [],
            coverage: { memories: sameRevision ? current.coverage.memories : 0, episodes: sameRevision ? current.coverage.episodes : 0, has_more: batch.coverage.hasMore,
              omissions: [...new Set([...(sameRevision ? current.coverage.omissions : []), ...batch.coverage.omissions])] } }
          database.prepare('UPDATE personal_context_overviews SET current_json=?,previous_json=?,cursor_json=?,run_id=NULL WHERE scope_key=?')
            .run(canonicalize(projection), sameRevision ? old.previous_json : current ? canonicalize(current) : null, canonicalize(batch.cursor), scopeKey)
          hasMore ||= batch.coverage.hasMore
          continue
        }
        database.prepare(`INSERT OR IGNORE INTO formal_agent_runs
          (run_id,dedupe_key,request_digest,recipe_id,recipe_version,scope_json,scope_digest,transcript_version,input_watermark_json,input_digest,personal_context_revision,requested_by,state,max_attempts,next_attempt_at,created_at,updated_at,retry_policy_version)
          VALUES (?,?,?,'context.synthesize','2',?,?,'raw',?,?,?,'automatic','queued',3,?,?,?,'agent-retry@1')`)
          .run(runId, sha256Canonical({ scopeKey, revision, inputDigest, retryOf }), inputDigest, canonicalize(scope), sha256Canonical(scope), canonicalize({ throughEventOrder: 1 }), inputDigest, revision, now, now, now)
        database.prepare('INSERT OR IGNORE INTO personal_context_overview_jobs(run_id,scope_key,expected_revision,input_digest,refs_json) VALUES (?,?,?,?,?)').run(runId, scopeKey, revision, inputDigest, canonicalize(refs))
        database.prepare('INSERT OR IGNORE INTO personal_context_candidate_batches(batch_id,run_id,scope_key,input_revision,refs_json) VALUES(?,?,?,?,?)')
          .run(batchId, runId, scopeKey, revision, canonicalize(batch.memories.filter(item => item.origin !== 'explicit').map(item => item.memoryRef)))
        database.prepare('UPDATE personal_context_overviews SET run_id=? WHERE scope_key=?').run(runId, scopeKey)
        preparedCount += 1
      }
      database.exec('COMMIT'); return { preparedCount, hasMore }
    } catch (error) { rollbackQuietly(database); throw error }
  }

  read (runId) {
    const job = this.database.prepare('SELECT * FROM personal_context_overview_jobs WHERE run_id=?').get(runId)
    if (!job) fail('AGENT_REQUEST_INVALID')
    const refs = JSON.parse(job.refs_json)
    if (!refs.batchId && Number(job.expected_revision) !== this.context.contentRevision()) fail('AGENT_REQUEST_INVALID')
    const memories = refs.memoryRefs.map((ref) => this.memory(ref)); const episodes = refs.episodeRefs.map((ref) => this.episode(ref))
    if (memories.some((item) => !item) || episodes.some((item) => !item)) fail('AGENT_REQUEST_INVALID')
    const input = { schemaVersion: 1, scope: refs.scope, memories, episodes, coverage: refs.coverage, cursor: refs.cursor,
      ...(refs.batchId ? { batchId: refs.batchId, inputRevision: refs.inputRevision } : {}) }
    if (sha256Canonical(input) !== job.input_digest) fail('AGENT_REQUEST_INVALID')
    return input
  }

  commit (command) {
    assertExactKeys(command, ['type', 'action', 'runId', 'attemptIdentity', 'output'], 'AGENT_REQUEST_INVALID')
    try { validateRecipeOutput('context.synthesize', '2', command.output) } catch { fail('AGENT_OUTPUT_INVALID') }
    const database = this.database; database.exec('BEGIN IMMEDIATE')
    try {
      const run = database.prepare('SELECT * FROM formal_agent_runs WHERE run_id=?').get(command.runId)
      const attempt = this.context.ingestAttempt(command.attemptIdentity)
      if (attempt.runId !== command.runId || run?.recipe_id !== 'context.synthesize') fail('AGENT_REQUEST_INVALID')
      const job = database.prepare('SELECT * FROM personal_context_overview_jobs WHERE run_id=?').get(command.runId)
      const refs = job ? JSON.parse(job.refs_json) : null
      const outputDigest = sha256Canonical(command.output)
      if (refs?.committedDigest && run.state === 'succeeded') {
        if (refs.committedDigest !== outputDigest) fail('AGENT_OUTPUT_INVALID')
        this.read(command.runId)
        database.exec('COMMIT'); return { revision: Number(job.expected_revision), sectionCount: refs.sectionCount, replayed: true }
      }
      this.context.assertActiveFormalAttempt(run, command.attemptIdentity, this.context.nowValue(), { allowPreviouslyRenewedLease: true })
      const input = this.read(command.runId)
      if (refs.committedDigest) {
        if (refs.committedDigest !== outputDigest) fail('AGENT_OUTPUT_INVALID')
        database.exec('COMMIT'); return { revision: Number(job.expected_revision), sectionCount: refs.sectionCount, replayed: true }
      }
      const memoryKeys = new Set(input.memories.map((item) => refKey(item.memoryRef))); const episodeKeys = new Set(input.episodes.map((item) => refKey(item.episodeRef)))
      for (const section of command.output.sections) {
        if (section.memoryRefs.some((ref) => !memoryKeys.has(refKey(ref))) || section.episodeRefs.some((ref) => !episodeKeys.has(refKey(ref))) || !this.validSection(section)) fail('AGENT_OUTPUT_INVALID')
      }
      const old = database.prepare('SELECT * FROM personal_context_overviews WHERE scope_key=?').get(job.scope_key)
      const current = this.safeProjection(old.current_json)
      const sameRevision = current?.input_revision === Number(job.expected_revision)
      const allSections = [...(sameRevision || refs.batchId ? current?.sections || [] : []), ...command.output.sections]
        .filter((section, index, all) => !all.slice(index + 1).some(next => next.category === section.category && refKey(next.memoryRefs) === refKey(section.memoryRefs) && refKey(next.episodeRefs) === refKey(section.episodeRefs)))
      const sections = allSections.slice(-12)
      while (Buffer.byteLength(canonicalize({ schemaVersion: 1, sections }), 'utf8') > 16384) sections.shift()
      const projection = { input_revision: Number(job.expected_revision), input_digest: job.input_digest, updated_at: new Date(this.context.nowValue()).toISOString(), sections,
        coverage: { memories: (sameRevision ? current.coverage.memories : 0) + input.memories.length, episodes: (sameRevision ? current.coverage.episodes : 0) + input.episodes.length,
          has_more: input.coverage.hasMore, omissions: [...new Set([...(sameRevision ? current.coverage.omissions : []), ...input.coverage.omissions, ...(allSections.length > sections.length ? ['budget'] : [])])] } }
      database.prepare('UPDATE personal_context_overviews SET current_json=?,previous_json=?,cursor_json=?,updated_at=? WHERE scope_key=?')
        .run(canonicalize(projection), sameRevision ? old.previous_json : current ? canonicalize(current) : null, canonicalize(input.cursor), this.context.nowValue(), job.scope_key)
      database.prepare('UPDATE personal_context_overview_jobs SET refs_json=? WHERE run_id=?').run(canonicalize({ ...refs, committedDigest: outputDigest, sectionCount: sections.length }), command.runId)
      if (refs.batchId) {
        const batch = database.prepare('SELECT * FROM personal_context_candidate_batches WHERE batch_id=? AND run_id=?').get(refs.batchId, command.runId)
        if (!batch || Number(batch.input_revision) !== Number(job.expected_revision)) fail('AGENT_REQUEST_INVALID')
        const insert = database.prepare('INSERT OR IGNORE INTO personal_context_candidate_consumptions(scope_key,memory_id,revision_id,batch_id) VALUES(?,?,?,?)')
        for (const ref of JSON.parse(batch.refs_json)) {
          if (!this.memory(ref)) fail('AGENT_REQUEST_INVALID')
          insert.run(batch.scope_key, ref.memoryId, ref.revisionId, refs.batchId)
        }
        database.prepare('UPDATE personal_context_candidate_batches SET consumed_at=? WHERE batch_id=?').run(this.context.nowValue(), refs.batchId)
      }
      database.exec('COMMIT'); return { revision: Number(job.expected_revision), sectionCount: sections.length }
    } catch (error) { rollbackQuietly(database); throw error }
  }

  manage (command) {
    if (command.action === 'prepare') { assertExactKeys(command, ['type', 'action'], 'AGENT_REQUEST_INVALID'); return this.prepare() }
    if (command.action === 'read') { assertExactKeys(command, ['type', 'action', 'runId'], 'AGENT_REQUEST_INVALID'); return this.read(command.runId) }
    if (command.action === 'commit') return this.commit(command)
    if (command.action === 'view') { assertExactKeys(command, ['type', 'action', 'scopeKey'], 'AGENT_REQUEST_INVALID'); return this.view(command.scopeKey) }
    fail('AGENT_REQUEST_INVALID')
  }
}

module.exports = { PersonalMemoryOverviewStore }
