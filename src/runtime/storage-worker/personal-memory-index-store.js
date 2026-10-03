'use strict'

const { canonicalize, sha256Canonical } = require('./canonical-json')
const { StorageError, assertExactKeys } = require('./protocol')
const { rollbackQuietly } = require('./sqlite-store')
const { memoryContent, memoryReadable } = require('./personal-memory-file-content')
const { POLICY } = require('../../agent/personal-context/memory-file-format')
const { id, digest } = require('./personal-memory-file-store')
const { canonicalizeConnection } = require('../../agent/model-access/connection')
const ftsState = new WeakMap()
const fail = code => { throw new StorageError(code || 'AGENT_REQUEST_INVALID') }
function normalizedVector (values) {
  if ((!Array.isArray(values) && !(values instanceof Float32Array)) || values.length < 1 || values.length > 4096 || !Array.from(values).every(Number.isFinite)) fail()
  const norm = Math.hypot(...values); if (!Number.isFinite(norm) || norm < 1e-12) fail()
  const bytes = Buffer.alloc(values.length * 4)
  values.forEach((value, i) => bytes.writeFloatLE(value / norm, i * 4))
  return bytes
}
function normalizeScope (scope) {
  if (scope?.kind === 'date_range' && typeof scope.reference === 'string') {
    const match = /^date\.(\d+)\.(\d+)$/.exec(scope.reference)
    if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= Number(match[1])) fail()
    return { kind: 'date_range', reference: { from: Number(match[1]), through: Number(match[2]) - 1 } }
  }
  return scope
}
function scopeFilter (scope) {
  scope = normalizeScope(scope)
  if (!scope || !['global', 'session', 'selection', 'project', 'date_range'].includes(scope.kind)) fail()
  assertExactKeys(scope, ['kind', 'reference'])
  if (scope.kind === 'global') { if (scope.reference !== null) fail(); return { sql: "scope.kind='global'", args: [] } }
  if (scope.kind === 'project') { id(scope.reference); return { sql: "(scope.kind='global' OR (scope.kind='project' AND (scope.scope_id=? OR scope.canonical_key=?)))", args: [scope.reference, `project:${scope.reference}`] } }
  if (scope.kind === 'date_range') {
    assertExactKeys(scope.reference, ['from', 'through'])
    const { from, through } = scope.reference
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(through) || from < 0 || through < from) fail()
    return { sql: "(scope.kind='global' OR (scope.kind='session' AND EXISTS(SELECT 1 FROM sessions s WHERE s.session_id=scope.session_id AND s.started_at>=? AND s.started_at<=?)))", args: [from, through] }
  }
  const session = scope.kind === 'selection' ? scope.reference?.session_id : scope.reference; id(session)
  let watermark = Number.MAX_SAFE_INTEGER
  if (scope.kind === 'selection') {
    assertExactKeys(scope.reference, ['session_id', 'through_event_order'])
    watermark = scope.reference.through_event_order
    if (!Number.isSafeInteger(watermark) || watermark < 1) fail()
  }
  return { sql: `(scope.kind='global' OR (scope.kind='session' AND scope.session_id=?) OR EXISTS(
    SELECT 1 FROM personal_context_session_associations a JOIN personal_context_episodes e ON e.episode_id=a.episode_id
    WHERE a.memory_id=item.memory_id AND a.revision_id=item.current_revision_id AND e.lifecycle='active' AND e.session_id=? AND e.through_event_order<=?))`, args: [session, session, watermark] }
}
const JOIN = ` FROM personal_memory_index_documents doc JOIN personal_context_items item ON item.memory_id=doc.memory_id
  JOIN personal_context_scopes scope ON scope.scope_id=item.scope_id JOIN personal_memory_files file ON file.memory_id=item.memory_id
  JOIN personal_memory_roots root ON root.root_id=file.root_id AND root.active=1 `
const LIVE = "item.lifecycle='active' AND item.origin='explicit' AND scope.lifecycle='active' AND file.state='ready' AND file.content_hash=doc.content_hash AND item.current_revision_id=doc.revision_id"
class PersonalMemoryIndexStore {
  constructor (context) { this.context = context; this.db = context.database }
  tx (fn) { this.db.exec('BEGIN IMMEDIATE'); try { const r = fn(); this.db.exec('COMMIT'); return r } catch (e) { rollbackQuietly(this.db); throw e } }
  enabled () { const p = this.context.automaticPolicy; return !p || Boolean(p.agentEnabled && p.memoryEnabled) }
  fts () {
    if (ftsState.has(this.db)) return ftsState.get(this.db)
    try {
      this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS personal_memory_fts USING fts5(text,content='personal_memory_index_documents',content_rowid='rowid',tokenize='trigram');
        CREATE TRIGGER IF NOT EXISTS personal_memory_fts_insert AFTER INSERT ON personal_memory_index_documents BEGIN INSERT INTO personal_memory_fts(rowid,text) VALUES(new.rowid,new.text); END;
        CREATE TRIGGER IF NOT EXISTS personal_memory_fts_delete AFTER DELETE ON personal_memory_index_documents BEGIN INSERT INTO personal_memory_fts(personal_memory_fts,rowid,text) VALUES('delete',old.rowid,old.text); END;
        CREATE TRIGGER IF NOT EXISTS personal_memory_fts_update AFTER UPDATE ON personal_memory_index_documents BEGIN
          INSERT INTO personal_memory_fts(personal_memory_fts,rowid,text) VALUES('delete',old.rowid,old.text); INSERT INTO personal_memory_fts(rowid,text) VALUES(new.rowid,new.text); END;
        INSERT INTO personal_memory_fts(personal_memory_fts) VALUES('rebuild');`)
      ftsState.set(this.db, true)
    } catch { ftsState.set(this.db, false) }
    return ftsState.get(this.db)
  }
  operate (input) {
    if (input?.type === 'rebuild_lexical') {
      assertExactKeys(input, ['type'])
      this.tx(() => {
        this.db.exec('DROP TRIGGER IF EXISTS personal_memory_fts_insert; DROP TRIGGER IF EXISTS personal_memory_fts_delete; DROP TRIGGER IF EXISTS personal_memory_fts_update; DROP TABLE IF EXISTS personal_memory_fts; DELETE FROM personal_memory_index_documents;')
      })
      ftsState.delete(this.db); return { ftsAvailable: this.fts() }
    }
    if (input?.type === 'refresh_page') {
      assertExactKeys(input, ['type', 'after']); if (input.after !== null) id(input.after)
      this.fts()
      const rows = this.db.prepare('SELECT item.* FROM personal_context_items item JOIN personal_memory_files file ON file.memory_id=item.memory_id WHERE item.memory_id>? ORDER BY item.memory_id LIMIT 64').all(input.after || '')
      this.tx(() => {
        for (const row of rows) {
          if (row.lifecycle !== 'active' || row.origin !== 'explicit' || !memoryReadable(this.db, row)) { this.db.prepare('DELETE FROM personal_memory_index_documents WHERE memory_id=?').run(row.memory_id); continue }
          const contentHash = JSON.parse(row.content_json).contentHash
          this.db.prepare(`INSERT INTO personal_memory_index_documents(memory_id,revision_id,content_hash,policy,text) VALUES(?,?,?,?,?)
            ON CONFLICT(memory_id) DO UPDATE SET revision_id=excluded.revision_id,content_hash=excluded.content_hash,policy=excluded.policy,text=excluded.text
            WHERE revision_id<>excluded.revision_id OR content_hash<>excluded.content_hash OR policy<>excluded.policy`)
            .run(row.memory_id, row.current_revision_id, contentHash, POLICY, memoryContent(this.db, row).displayText)
        }
      })
      return { after: rows.at(-1)?.memory_id || input.after, hasMore: rows.length === 64 }
    }
    if (input?.type === 'embedding_catalog') { assertExactKeys(input, ['type']); return this.db.prepare('SELECT * FROM agent_embedding_config WHERE singleton_key=1').get() || null }
    if (input?.type === 'embedding_configure') return this.configure(input)
    if (input?.type === 'embedding_bind') {
      assertExactKeys(input, ['type', 'jobId', 'inputDigest', 'binding']); id(input.jobId); digest(input.inputDigest)
      const old = this.db.prepare('SELECT * FROM agent_embedding_bindings WHERE job_id=?').get(input.jobId)
      if (old) { if (old.input_digest !== input.inputDigest || old.binding_json !== canonicalize(input.binding)) fail('AGENT_INPUT_CHANGED'); return JSON.parse(old.binding_json) }
      this.db.prepare('INSERT INTO agent_embedding_bindings VALUES (?,?,?)').run(input.jobId, input.inputDigest, canonicalize(input.binding))
      this.db.prepare("DELETE FROM agent_embedding_bindings WHERE job_id IN (SELECT job_id FROM agent_embedding_bindings WHERE job_id LIKE 'query.%' ORDER BY rowid DESC LIMIT -1 OFFSET 1024)").run()
      return input.binding
    }
    if (input?.type === 'generation_start') {
      assertExactKeys(input, ['type', 'generationId', 'binding']); id(input.generationId)
      return this.tx(() => {
        this.db.prepare("UPDATE personal_memory_index_generations SET state='cancelled' WHERE state='building'").run()
        this.db.prepare("INSERT INTO personal_memory_index_generations VALUES (?,?,NULL,'building')").run(input.generationId, canonicalize(input.binding))
        return { started: true }
      })
    }
    if (input?.type === 'generation_cancel') {
      assertExactKeys(input, ['type', 'generationId']); id(input.generationId)
      this.db.prepare("UPDATE personal_memory_index_generations SET state='cancelled' WHERE generation_id=? AND state='building'").run(input.generationId)
      this.db.prepare("DELETE FROM personal_memory_vectors WHERE generation_id IN (SELECT generation_id FROM personal_memory_index_generations WHERE state='cancelled')").run()
      return { cancelled: true }
    }
    if (input?.type === 'embedding_page') {
      assertExactKeys(input, ['type', 'after', 'generationId']); if (input.after !== null) id(input.after); id(input.generationId)
      const rows = this.db.prepare(`SELECT item.*,doc.content_hash AS indexed_hash ${JOIN} WHERE ${LIVE} AND item.memory_id>?
        AND NOT EXISTS(SELECT 1 FROM personal_memory_vectors v WHERE v.generation_id=? AND v.memory_id=item.memory_id AND v.content_hash=doc.content_hash AND v.revision_id=doc.revision_id)
        ORDER BY item.memory_id LIMIT 16`).all(input.after || '', input.generationId).filter(row => memoryReadable(this.db, row))
      return { items: this.enabled() ? rows.map(row => ({ memoryId: row.memory_id, revisionId: row.current_revision_id, contentHash: row.indexed_hash, text: memoryContent(this.db, row).displayText })) : [],
        after: rows.at(-1)?.memory_id || input.after, hasMore: rows.length === 16 }
    }
    if (input?.type === 'vectors_put') return this.putVectors(input)
    if (input?.type === 'generation_publish') {
      assertExactKeys(input, ['type', 'generationId']); id(input.generationId)
      return this.tx(() => {
        const gen = this.db.prepare("SELECT * FROM personal_memory_index_generations WHERE generation_id=? AND state='building'").get(input.generationId)
        const config = this.db.prepare('SELECT * FROM agent_embedding_config WHERE singleton_key=1').get()
        if (!gen || !config?.enabled || !config.disclosure_accepted || Number(config.revision) !== JSON.parse(gen.binding_json).configRevision || !this.enabled()) fail('AGENT_INPUT_CHANGED')
        const uncovered = Number(this.db.prepare(`SELECT count(*) n ${JOIN} WHERE ${LIVE} AND NOT EXISTS(SELECT 1 FROM personal_memory_vectors v WHERE v.generation_id=? AND v.memory_id=doc.memory_id AND v.revision_id=doc.revision_id AND v.content_hash=doc.content_hash)`).get(input.generationId).n)
        if (uncovered) fail('AGENT_INPUT_CHANGED')
        this.db.prepare("UPDATE personal_memory_index_generations SET state='retired' WHERE state='active'").run()
        this.db.prepare("UPDATE personal_memory_index_generations SET state='active' WHERE generation_id=?").run(input.generationId)
        this.db.prepare("DELETE FROM personal_memory_index_generations WHERE state IN ('retired','cancelled')").run()
        return { published: true }
      })
    }
    if (input?.type === 'status') {
      assertExactKeys(input, ['type'])
      return { documents: Number(this.db.prepare('SELECT count(*) n FROM personal_memory_index_documents').get().n),
        vectors: Number(this.db.prepare("SELECT count(*) n FROM personal_memory_vectors v JOIN personal_memory_index_generations g ON g.generation_id=v.generation_id WHERE g.state='active'").get().n),
        generation: this.db.prepare("SELECT * FROM personal_memory_index_generations WHERE state='active'").get() || null, ftsAvailable: this.fts() }
    }
    if (input?.type === 'vector_page') return this.vectorPage(input)
    if (input?.type === 'lexical') { assertExactKeys(input, ['type', 'scope', 'query']); return this.lexical(input.scope, input.query) }
    if (input?.type === 'manage_search') { assertExactKeys(input, ['type', 'scope', 'query']); return this.lexical(input.scope, input.query, true) }
    if (input?.type === 'resolve') return this.resolve(input.request)
    fail()
  }
  configure (input) {
    assertExactKeys(input, ['type', 'expectedRevision', 'config'])
    const c = input.config
    assertExactKeys(c, ['httpsOrigin', 'basePath', 'modelId', 'enabled', 'disclosureAccepted', 'slotId', 'persistence', 'generation'])
    if (c.httpsOrigin !== null) canonicalizeConnection(c.httpsOrigin, c.basePath)
    if (c.modelId !== null && (typeof c.modelId !== 'string' || !c.modelId || Buffer.byteLength(c.modelId) > 160)) fail()
    if (typeof c.enabled !== 'boolean' || typeof c.disclosureAccepted !== 'boolean' || c.enabled && (!c.disclosureAccepted || !c.modelId || !c.httpsOrigin)) fail()
    if (!/^slot\.[a-f0-9]{32}$/.test(c.slotId) || !['absent', 'persistent', 'session_only'].includes(c.persistence)) fail()
    if (c.generation !== null && !/^generation\.[a-f0-9]{32}$/.test(c.generation)) fail()
    return this.tx(() => {
      const old = this.db.prepare('SELECT * FROM agent_embedding_config WHERE singleton_key=1').get()
      if (input.expectedRevision !== Number(old?.revision || 0)) fail('MODEL_CONFIG_REVISION_CONFLICT')
      this.db.prepare(`INSERT INTO agent_embedding_config VALUES(1,?,?,?,?,?,?,?,?,?) ON CONFLICT(singleton_key) DO UPDATE SET
        revision=excluded.revision,https_origin=excluded.https_origin,base_path=excluded.base_path,model_id=excluded.model_id,enabled=excluded.enabled,
        disclosure_accepted=excluded.disclosure_accepted,credential_slot_id=excluded.credential_slot_id,credential_persistence=excluded.credential_persistence,credential_generation=excluded.credential_generation`)
        .run(input.expectedRevision + 1, c.httpsOrigin, c.basePath, c.modelId, Number(c.enabled), Number(c.disclosureAccepted), c.slotId, c.persistence, c.generation)
      this.db.prepare("UPDATE personal_memory_index_generations SET state='cancelled' WHERE state='building'").run()
      // Existing active vectors are still derived data, but no query may use a
      // configuration with a different revision/model or withdrawn disclosure.
      return { revision: input.expectedRevision + 1 }
    })
  }
  putVectors (input) {
    assertExactKeys(input, ['type', 'generationId', 'modelId', 'items']); id(input.generationId)
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 16) fail()
    const gen = this.db.prepare("SELECT * FROM personal_memory_index_generations WHERE generation_id=? AND state IN ('building','active')").get(input.generationId)
    const config = this.db.prepare('SELECT * FROM agent_embedding_config WHERE singleton_key=1').get()
    if (!gen || !config?.enabled || !config.disclosure_accepted || Number(config.revision) !== JSON.parse(gen.binding_json).configRevision || !this.enabled()) fail('AGENT_INPUT_CHANGED')
    const seen = new Set(); let dimension = gen.dimensions
    const entries = input.items.map(item => {
      assertExactKeys(item, ['memoryId', 'revisionId', 'contentHash', 'vector']); id(item.memoryId); id(item.revisionId); digest(item.contentHash)
      if (seen.has(item.memoryId)) fail(); seen.add(item.memoryId)
      const row = this.context.memoryRow(item.memoryId)
      if (!row || row.lifecycle !== 'active' || row.origin !== 'explicit' || !memoryReadable(this.db, row) || row.current_revision_id !== item.revisionId || JSON.parse(row.content_json).contentHash !== item.contentHash) fail('AGENT_INPUT_CHANGED')
      const bytes = normalizedVector(item.vector)
      if (dimension !== null && Number(dimension) !== bytes.length / 4) fail('AGENT_INPUT_CHANGED')
      dimension = bytes.length / 4
      return { ...item, bytes }
    })
    return this.tx(() => {
      const binding = JSON.parse(gen.binding_json)
      if (binding.responseModel && binding.responseModel !== input.modelId) fail('AGENT_INPUT_CHANGED')
      binding.responseModel = input.modelId
      this.db.prepare('UPDATE personal_memory_index_generations SET dimensions=?,binding_json=? WHERE generation_id=?').run(dimension, canonicalize(binding), input.generationId)
      for (const item of entries) this.db.prepare('INSERT OR REPLACE INTO personal_memory_vectors VALUES(?,?,?,?,?,?)').run(input.generationId, item.memoryId, item.revisionId, item.contentHash, dimension, item.bytes)
      return { stored: entries.length }
    })
  }
  lexical (scope, query, managing = false) {
    if (typeof query !== 'string' || !query.trim() || Buffer.byteLength(query) > 4096) fail()
    const filter = scopeFilter(scope); if (!managing && !this.enabled()) return []
    const terms = require('./question-retrieval-store').queryKeys(query)
    const long = terms.filter(t => Array.from(t).length >= 3)
    const scores = new Map()
    if (long.length && this.fts()) {
      const match = long.map(t => `"${t.replaceAll('"', '""')}"`).join(' OR ')
      const rows = this.db.prepare(`SELECT item.*,bm25(personal_memory_fts) AS score ${JOIN}
        JOIN personal_memory_fts ON personal_memory_fts.rowid=doc.rowid WHERE ${LIVE} AND ${filter.sql} AND personal_memory_fts MATCH ? ORDER BY score,item.memory_id LIMIT 64`).all(...filter.args, match)
      rows.forEach((row, rank) => { if (memoryReadable(this.db, row)) scores.set(row.memory_id, { row, score: 1 / (60 + rank + 1) }) })
    }
    // trigram MATCH cannot find one/two-character Chinese terms. The bounded
    // supplement is filtered by the same live revision and scope first.
    const short = terms.filter(t => Array.from(t).length < 3)
    const supplement = !this.fts() ? terms : short
    if (supplement.length) {
      const rows = this.db.prepare(`SELECT item.* ${JOIN} WHERE ${LIVE} AND ${filter.sql} AND (${supplement.map(() => 'instr(lower(doc.text),?)>0').join(' OR ')}) ORDER BY item.memory_id LIMIT 64`).all(...filter.args, ...supplement)
      rows.forEach((row, rank) => { if (memoryReadable(this.db, row)) scores.set(row.memory_id, { row, score: Math.max(scores.get(row.memory_id)?.score || 0, 1 / (60 + rank + 1)) }) })
    }
    const result = [...scores.values()].sort((a, b) => b.score - a.score || a.row.memory_id.localeCompare(b.row.memory_id)).slice(0, 64).map(value => value.row.memory_id)
    if (terms.length) {
      const legacy = this.db.prepare(`SELECT item.* FROM personal_context_items item JOIN personal_context_scopes scope ON scope.scope_id=item.scope_id
        WHERE item.origin='explicit' AND item.lifecycle='active' AND scope.lifecycle='active' AND json_extract(item.content_json,'$.storage') IS NOT 'markdown'
          AND ${filter.sql} AND (${terms.map(() => "instr(lower(json_extract(item.content_json,'$.displayText')),?)>0").join(' OR ')}) ORDER BY item.memory_id LIMIT 64`).all(...filter.args, ...terms)
      for (const row of legacy) if (memoryReadable(this.db, row) && !result.includes(row.memory_id)) result.push(row.memory_id)
    }
    return result.slice(0, 64)
  }
  vectorPage (input) {
    assertExactKeys(input, ['type', 'scope', 'generationId', 'after']); id(input.generationId); if (input.after !== null) id(input.after)
    const filter = scopeFilter(input.scope)
    const rows = this.enabled() ? this.db.prepare(`SELECT item.*,v.vector,v.dimensions ${JOIN} JOIN personal_memory_vectors v ON v.memory_id=doc.memory_id AND v.revision_id=doc.revision_id AND v.content_hash=doc.content_hash
      WHERE ${LIVE} AND ${filter.sql} AND v.generation_id=? AND item.memory_id>? ORDER BY item.memory_id LIMIT 64`).all(...filter.args, input.generationId, input.after || '') : []
    return { items: rows.filter(row => memoryReadable(this.db, row)).map(row => ({ memoryId: row.memory_id, dimensions: Number(row.dimensions), vector: row.vector })), after: rows.at(-1)?.memory_id || input.after, hasMore: rows.length === 64 }
  }
  resolve (request) {
    assertExactKeys(request, ['schemaVersion', 'scope', 'query', 'semantic_keys', 'aliases', 'vectorRanks', 'degradation'])
    if (request.schemaVersion !== 2 || !Array.isArray(request.vectorRanks) || request.vectorRanks.length > 64) fail()
    for (const key of ['semantic_keys', 'aliases']) if (!Array.isArray(request[key]) || request[key].length > 32 || request[key].some(value => typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 2048)) fail()
    const lexical = this.lexical(request.scope, request.query)
    const base = request.scope.kind === 'global' ? { eligibility: 'no_committed_transcript', episodes: [], personalMemories: [], omissions: [], excludedScopes: [], hasMore: false, revision: this.context.contentRevision() }
      : this.context.resolve({ scope: normalizeScope(request.scope), semantic_keys: request.semantic_keys, aliases: request.aliases })
    if (!this.enabled() || request.degradation === 'memory_disabled') return { ...base, personalMemories: [], retrieval: { mode: 'disabled', reason: 'memory_disabled' } }
    const scores = new Map()
    const filter = scopeFilter(request.scope)
    const terms = [...new Set([...request.semantic_keys, ...request.aliases].map(value => value.normalize('NFKC').trim().toLocaleLowerCase('und')))]
    const exact = terms.length ? this.db.prepare(`SELECT item.* FROM personal_context_items item JOIN personal_context_scopes scope ON scope.scope_id=item.scope_id
      WHERE item.origin='explicit' AND item.lifecycle='active' AND scope.lifecycle='active' AND ${filter.sql}
      AND item.semantic_key IN (${terms.map(() => '?').join(',')}) ORDER BY item.memory_id LIMIT 64`).all(...filter.args, ...terms).filter(row => memoryReadable(this.db, row)).map(row => row.memory_id) : []
    const keyword = [...new Set([...exact, ...lexical])].slice(0, 64)
    for (const ranks of [keyword, request.vectorRanks]) ranks.forEach((key, rank) => { id(key); scores.set(key, (scores.get(key) || 0) + 1 / (60 + rank + 1)) })
    const validRows = key => this.db.prepare(`SELECT item.*,scope.kind scope_kind,CASE WHEN scope.kind='global' THEN NULL WHEN scope.kind='session' THEN scope.session_id ELSE scope.scope_id END scope_reference ${JOIN} WHERE ${LIVE} AND ${filter.sql} AND item.memory_id=?`).get(...filter.args, key)
      || this.db.prepare(`SELECT item.*,scope.kind scope_kind,CASE WHEN scope.kind='global' THEN NULL WHEN scope.kind='session' THEN scope.session_id ELSE scope.scope_id END scope_reference
        FROM personal_context_items item JOIN personal_context_scopes scope ON scope.scope_id=item.scope_id WHERE item.origin='explicit' AND item.lifecycle='active' AND scope.lifecycle='active'
        AND json_extract(item.content_json,'$.storage') IS NOT 'markdown' AND ${filter.sql} AND item.memory_id=?`).get(...filter.args, key)
    const preferences = this.db.prepare(`SELECT item.* FROM personal_context_items item JOIN personal_context_scopes scope ON scope.scope_id=item.scope_id
      WHERE item.origin='explicit' AND item.lifecycle='active' AND scope.lifecycle='active' AND ${filter.sql} AND item.kind='preference' ORDER BY item.memory_id LIMIT 4`).all(...filter.args).filter(row => memoryReadable(this.db, row)).map(row => row.memory_id)
    const ranking = [...new Set([...preferences, ...[...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(value => value[0])])]
    const memories = []; let bytes = Buffer.byteLength(canonicalize({ ...base, personalMemories: [] })); let omitted = ranking.length > 20
    for (const key of ranking) {
      const row = validRows(key); if (!row || !memoryReadable(this.db, row)) continue
      const sources = this.db.prepare('SELECT input_digest FROM personal_context_evidence WHERE memory_id=? ORDER BY evidence_id').all(key)
      const sourceCount = this.db.prepare("SELECT count(*) n FROM (SELECT evidence_id FROM personal_context_evidence WHERE memory_id=? UNION SELECT json_extract(payload_json,'$.evidence_id') FROM personal_memory_portable_records WHERE memory_id=? AND record_type='source')").get(key, key).n
      if (sourceCount > 8 || memories.length >= 20) { omitted = true; continue }
      const value = { memoryId: key, semanticKey: row.semantic_key, displayText: memoryContent(this.db, row).displayText, kind: row.kind,
        scope: { kind: row.scope_kind, reference: row.scope_reference }, sourceDigests: sources.map(row => row.input_digest) }
      const size = Buffer.byteLength(canonicalize(value)); if (bytes + size > 65000) { omitted = true; continue }
      bytes += size; memories.push(value)
    }
    // Candidates remain in their old low-weight partition; no embeddings or
    // file confirmation are synthesized for them.
    for (const item of base.personalMemories) {
      const row = this.context.memoryRow(item.memoryId)
      if (row?.origin !== 'inferred' || memories.length >= 20 || !request.semantic_keys.length && !request.aliases.length && !require('./question-retrieval-store').queryKeys(request.query).some(term => item.displayText.normalize('NFKC').toLocaleLowerCase('und').includes(term))) continue
      const size = Buffer.byteLength(canonicalize(item)); if (bytes + size > 65000) { omitted = true; continue }
      bytes += size; memories.push(item)
    }
    return { ...base, eligibility: memories.length || base.episodes.length ? 'ready' : 'no_committed_transcript', personalMemories: memories,
      hasMore: base.hasMore || omitted, omissions: [...new Set([...base.omissions, ...(omitted ? ['budget'] : [])])],
      retrieval: { mode: request.degradation === null ? 'hybrid' : 'lexical', reason: request.degradation } }
  }
}
module.exports = { PersonalMemoryIndexStore, normalizedVector, scopeFilter, normalizeScope }
