'use strict'

const { assertExactKeys, StorageError } = require('./protocol')
const { canonicalize, sha256Canonical } = require('./canonical-json')
const { id, digest, relative } = require('./personal-memory-file-store')
const fail = () => { throw new StorageError('AGENT_REQUEST_INVALID') }
const integer = (value, minimum = 0) => { if (!Number.isSafeInteger(value) || value < minimum) fail() }
const SOURCE_FIELDS = ['evidence_id', 'ingest_run_id', 'memory_id', 'source_kind', 'session_id', 'interaction_id', 'transcript_version', 'input_watermark', 'from_event_order', 'through_event_order', 'input_digest', 'recipe_id', 'recipe_version', 'created_at', 'memory_hash']
function validateGovernance (g) {
  assertExactKeys(g, ['schemaVersion', 'files', 'tombstones', 'suppressions', 'memories', 'sources'])
  if (g.schemaVersion !== 1) fail()
  for (const [key, limit] of [['files', 4096], ['tombstones', 4096], ['suppressions', 16384], ['memories', 4096], ['sources', 32768]]) if (!Array.isArray(g[key]) || g[key].length > limit) fail()
  for (const f of g.files) { assertExactKeys(f, ['memory_id', 'root_id', 'relative_name', 'content_hash', 'state']); id(f.memory_id); id(f.root_id); relative(f.relative_name); digest(f.content_hash); if (!['ready', 'pending', 'missing', 'invalid', 'conflict', 'writing', 'recovery'].includes(f.state)) fail() }
  for (const t of g.tombstones) { assertExactKeys(t, ['memory_id', 'content_hash']); id(t.memory_id); digest(t.content_hash) }
  for (const s of g.suppressions) { assertExactKeys(s, ['identity_hash', 'scope_id', 'source_digest']); digest(s.identity_hash); id(s.scope_id); digest(s.source_digest) }
  for (const m of g.memories) { assertExactKeys(m, ['memory_id', 'kind', 'scope_id', 'lifecycle', 'current_revision_id', 'item_revision']); id(m.memory_id); id(m.scope_id); id(m.current_revision_id); integer(m.item_revision, 1); if (!['decision', 'conclusion', 'todo', 'term', 'preference', 'project_fact', 'experience'].includes(m.kind) || !['active', 'forgotten', 'inactive', 'conflicted'].includes(m.lifecycle)) fail() }
  const unique = new Map()
  for (const s of g.sources) {
    assertExactKeys(s, SOURCE_FIELDS)
    for (const key of ['evidence_id', 'ingest_run_id', 'memory_id', 'recipe_version']) id(s[key])
    for (const key of ['input_digest', 'memory_hash']) digest(s[key])
    if (!['session', 'interaction'].includes(s.source_kind) || !['raw', 'refined'].includes(s.transcript_version) || s.recipe_id !== `context.ingest.${s.source_kind}`) fail()
    if (s.source_kind === 'session') { id(s.session_id); if (s.interaction_id !== null) fail() } else { id(s.interaction_id); if (s.session_id !== null) fail() }
    for (const key of ['input_watermark', 'from_event_order', 'through_event_order']) integer(s[key], 1)
    integer(s.created_at); if (s.created_at > 8640000000000000 || s.through_event_order < s.from_event_order || s.through_event_order > s.input_watermark) fail()
    unique.set(`${s.memory_id}:${s.evidence_id}`, s)
  }
  const counts = new Map()
  for (const s of unique.values()) { const n = (counts.get(s.memory_id) || 0) + 1; if (n > 8) fail(); counts.set(s.memory_id, n) }
  return g
}
function importGovernance (store, input) {
  assertExactKeys(input, ['type', 'governance'])
  const g = validateGovernance(input.governance); const db = store.db
  return store.transaction(() => {
    const now = store.context.nowValue()
    const put = (type, key, memoryId, contentHash, payload) => db.prepare('INSERT OR REPLACE INTO personal_memory_portable_records VALUES(?,?,?,?,?)').run(key, type, memoryId, contentHash, canonicalize(payload))
    const revoke = memoryId => {
      db.prepare("UPDATE personal_context_items SET lifecycle='forgotten' WHERE memory_id=?").run(memoryId)
      db.prepare('DELETE FROM personal_context_session_associations WHERE memory_id=?').run(memoryId)
      db.prepare('DELETE FROM personal_memory_index_documents WHERE memory_id=?').run(memoryId)
      db.prepare('DELETE FROM personal_memory_vectors WHERE memory_id=?').run(memoryId)
    }
    for (const t of g.tombstones) { db.prepare('INSERT OR IGNORE INTO personal_memory_file_tombstones VALUES (?,?,?,?)').run(t.memory_id, store.cache.rootId, t.content_hash, now); revoke(t.memory_id) }
    for (const s of g.suppressions) {
      if (db.prepare('SELECT scope_id FROM personal_context_scopes WHERE scope_id=?').get(s.scope_id)) db.prepare('INSERT OR IGNORE INTO personal_context_suppressions VALUES(?,?,?,?)').run(s.identity_hash, s.scope_id, s.source_digest, now)
      else put('suppression', `suppression.${sha256Canonical(s)}`, null, null, s)
    }
    const hashes = new Map(g.files.map(f => [f.memory_id, f.content_hash]))
    for (const m of g.memories) if (m.lifecycle === 'forgotten') { put('lifecycle', `lifecycle.${sha256Canonical(m.memory_id)}`, m.memory_id, hashes.get(m.memory_id) || null, m); revoke(m.memory_id) }
    for (const s of g.sources) put('source', `source.${sha256Canonical([s.memory_id, s.evidence_id])}`, s.memory_id, s.memory_hash, s)
    if (Number(db.prepare('SELECT count(*) n FROM personal_memory_portable_records').get().n) > 49152) fail()
    return { revision: store.context.advanceRevision({ operation: 'memory-file-import-governance', digest: sha256Canonical(g) }), sources: g.sources.length, revocations: g.tombstones.length }
  })
}
function portableMemorySources (context, row, limit) {
  const db = context.database; const hash = JSON.parse(row.content_json).contentHash
  return db.prepare("SELECT * FROM personal_memory_portable_records WHERE record_type='source' AND memory_id=? ORDER BY record_key LIMIT ?").all(row.memory_id, limit).map(record => {
    const s = JSON.parse(record.payload_json)
    const episode = record.content_hash === hash ? db.prepare(`SELECT * FROM personal_context_episodes WHERE lifecycle='active' AND source_kind=? AND input_digest=? AND transcript_version=? AND input_watermark=?
      AND ((?='session' AND session_id=?) OR (?='interaction' AND interaction_id=?)) LIMIT 1`).get(s.source_kind, s.input_digest, s.transcript_version, s.input_watermark, s.source_kind, s.session_id, s.source_kind, s.interaction_id) : null
    if (episode && s.from_event_order >= episode.from_event_order && s.through_event_order <= episode.through_event_order) return context.episodeSource({ ...episode, from_event_order: s.from_event_order, through_event_order: s.through_event_order })
    return { occurred_at: new Date(s.created_at).toISOString(), summary: record.content_hash === hash ? '已保留导入的来源引用；本机缺少对应来源记录。' : '已保留导入的来源引用；当前文件修订与来源记录不一致。', summary_kind: 'missing_summary', availability: 'missing', target: null }
  })
}
module.exports = { validateGovernance, importGovernance, portableMemorySources }
