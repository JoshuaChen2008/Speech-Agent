'use strict'

const { canonicalize, sha256Canonical } = require('./canonical-json')
const { StorageError, assertExactKeys } = require('./protocol')
const { rollbackQuietly } = require('./sqlite-store')
const { fileCache, memoryContent, memoryReadable, refreshMetadata } = require('./personal-memory-file-content')
const { POLICY, validateEntry } = require('../../agent/personal-context/memory-file-format')
const fail = code => { throw new StorageError(code || 'AGENT_REQUEST_INVALID') }
const id = value => { if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value)) fail(); return value }
const digest = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(); return value }
const relative = value => { if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\') || value.includes(':') || value.includes('\0') || value.split('/').some(p => !p || p === '.' || p === '..')) fail(); return value }

class PersonalMemoryFileStore {
  constructor (context) {
    this.context = context; this.db = context.database; this.cache = fileCache(this.db)
    this.cache.rootId = this.db.prepare('SELECT root_id FROM personal_memory_roots WHERE active=1').get()?.root_id || null
    refreshMetadata(this.db)
  }
  transaction (fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try { const result = fn(); this.db.exec('COMMIT'); refreshMetadata(this.db); return result } catch (error) { rollbackQuietly(this.db); refreshMetadata(this.db); throw error }
  }
  operate (input) {
    const type = input?.type
    if (type === 'content_page' || type === 'content_snapshot') return require('./personal-memory-sharing-store').readMemoryContent(this.context, input)
    if (type === 'revision') { assertExactKeys(input, ['type']); return { revision: this.context.contentRevision() } }
    if (type === 'read_policy') {
      assertExactKeys(input, ['type', 'request'])
      const request = input.request || {}
      const runId = request.runId || request.attemptIdentity?.runId || request.ingestRunId
      const run = runId ? this.db.prepare('SELECT recipe_id,recipe_version,scope_json,summary_use_memory FROM formal_agent_runs WHERE run_id=?').get(runId) : null
      return { allowed: request.summaryUseMemory !== false && !(run?.recipe_id === 'summary.minutes' && run.summary_use_memory === 0), scope: run ? JSON.parse(run.scope_json) : null, recipeVersion: run?.recipe_version || null }
    }
    if (type === 'propose') {
      assertExactKeys(input, ['type', 'command'])
      const command = input.command
      assertExactKeys(command, command.type === 'update' ? ['type', 'expected_revision', 'item_id', 'item_revision', 'entry'] : ['type', 'expected_revision', 'entry'])
      if (!['remember', 'update'].includes(command.type)) fail()
      this.context.assertRevision(command.expected_revision)
      const { exactEntry } = require('./personal-context-store'); const entry = exactEntry(command.entry)
      const scopeId = entry.scopeKind === 'global' ? `scope.${sha256Canonical({ kind: 'global', reference: null }).slice(0, 48)}`
        : this.db.prepare("SELECT scope_id FROM personal_context_scopes WHERE kind=? AND origin='automatic' AND lifecycle='active' AND (scope_id=? OR session_id=?)").get(entry.scopeKind, entry.scopeReference, entry.scopeReference)?.scope_id
      if (!scopeId) fail()
      const current = command.type === 'update' ? this.context.memoryRow(command.item_id) : this.db.prepare('SELECT * FROM personal_context_items WHERE scope_id=? AND kind=? AND semantic_key=?').get(scopeId, entry.kind, entry.semanticKey)
      if (command.type === 'update' && (!current || Number(current.item_revision) !== command.item_revision) || command.type === 'remember' && current?.lifecycle === 'active') fail('AGENT_CONTEXT_REVISION_CONFLICT')
      return { memoryId: current?.memory_id || `memory.${sha256Canonical({ scopeId, kind: entry.kind, semanticKey: entry.semanticKey }).slice(0, 44)}`, itemRevision: Number(current?.item_revision || 0) }
    }
    if (type === 'bind_root') {
      assertExactKeys(input, ['type', 'rootId']); id(input.rootId)
      const changed = this.cache.rootId !== input.rootId
      return this.transaction(() => {
        this.db.prepare('UPDATE personal_memory_roots SET active=0').run()
        this.db.prepare('INSERT INTO personal_memory_roots(root_id,active) VALUES (?,1) ON CONFLICT(root_id) DO UPDATE SET active=1').run(input.rootId)
        this.cache.rootId = input.rootId; this.cache.healthy = false; this.cache.snapshots.clear()
        if (changed) this.db.prepare('DELETE FROM personal_memory_index_documents').run()
        return { revision: changed ? this.context.advanceRevision({ operation: 'memory-file-root', rootId: input.rootId }) : this.context.contentRevision() }
      })
    }
    if (type === 'invalidate') {
      assertExactKeys(input, ['type']); this.cache.healthy = false; this.cache.snapshots.clear()
      return { invalidated: true }
    }
    if (type === 'snapshot') return this.snapshot(input)
    if (type === 'manifest') {
      assertExactKeys(input, ['type'])
      return { rootId: this.cache.rootId, revision: this.context.contentRevision(), files: this.db.prepare('SELECT * FROM personal_memory_files').all(),
        operations: this.db.prepare("SELECT * FROM personal_memory_file_operations WHERE phase IN ('prepared','recovery') ORDER BY created_at LIMIT 16").all(),
        cleanup: this.db.prepare('SELECT * FROM personal_memory_file_cleanup WHERE root_id=? ORDER BY memory_id LIMIT 64').all(this.cache.rootId),
        tombstones: this.db.prepare('SELECT memory_id,root_id,content_hash FROM personal_memory_file_tombstones').all(),
        forgotten: this.db.prepare("SELECT memory_id FROM personal_memory_portable_records WHERE record_type='lifecycle'").all().map(row => row.memory_id) }
    }
    if (type === 'cleanup_settle') {
      assertExactKeys(input, ['type', 'memoryId', 'byteHash', 'removed', 'conflict']); id(input.memoryId); digest(input.byteHash)
      if (typeof input.removed !== 'boolean' || typeof input.conflict !== 'boolean') fail()
      return this.transaction(() => {
        if (input.removed) this.db.prepare('DELETE FROM personal_memory_file_cleanup WHERE memory_id=? AND byte_hash=?').run(input.memoryId, input.byteHash)
        else if (input.conflict) this.db.prepare("UPDATE personal_memory_file_cleanup SET state='conflict' WHERE memory_id=? AND byte_hash=?").run(input.memoryId, input.byteHash)
        return { settled: true }
      })
    }
    if (type === 'legacy_page') {
      assertExactKeys(input, ['type', 'after']); if (input.after !== null) id(input.after)
      const rows = this.db.prepare(`SELECT item.*,scope.kind AS scope_kind,scope.label AS scope_label,scope.session_id
        FROM personal_context_items AS item JOIN personal_context_scopes AS scope ON scope.scope_id=item.scope_id
        WHERE item.origin='explicit' AND json_extract(item.content_json,'$.storage') IS NOT 'markdown'
          AND item.memory_id>? ORDER BY item.memory_id LIMIT 64`).all(input.after || '')
      return { revision: this.context.contentRevision(), items: rows.map(row => ({ memoryId: row.memory_id, itemRevision: Number(row.item_revision),
        entry: { display_text: memoryContent(this.db, row).displayText, kind: row.kind, scope: { kind: row.scope_kind, reference: row.scope_kind === 'global' ? null : row.scope_kind === 'session' ? row.session_id : row.scope_id } } })) }
    }
    if (type === 'prepare') return this.prepare(input)
    if (type === 'commit') return this.commit(input)
    if (type === 'settle') {
      assertExactKeys(input, ['type', 'operationId', 'phase']); id(input.operationId)
      if (!['aborted', 'recovery'].includes(input.phase)) fail()
      return this.transaction(() => {
        const op = this.db.prepare('SELECT * FROM personal_memory_file_operations WHERE operation_id=?').get(input.operationId)
        if (!op || op.phase === 'committed') fail('AGENT_CONTEXT_REVISION_CONFLICT')
        this.db.prepare('UPDATE personal_memory_file_operations SET phase=? WHERE operation_id=?').run(input.phase, input.operationId)
        this.db.prepare('UPDATE personal_memory_files SET state=? WHERE memory_id=?').run(input.phase === 'recovery' ? 'recovery' : 'pending', op.memory_id)
        if (input.phase === 'aborted' && this.context.memoryRow(op.memory_id) && JSON.parse(this.context.memoryRow(op.memory_id).content_json).storage !== 'markdown')
          this.db.prepare('DELETE FROM personal_memory_files WHERE memory_id=?').run(op.memory_id)
        return { revision: this.context.advanceRevision({ operation: 'memory-file-settle', operationId: input.operationId, phase: input.phase }) }
      })
    }
    if (type === 'export_governance') {
      assertExactKeys(input, ['type'])
      const exported = { schemaVersion: 1, files: this.db.prepare('SELECT memory_id,root_id,relative_name,content_hash,state FROM personal_memory_files ORDER BY memory_id').all(),
        tombstones: this.db.prepare('SELECT memory_id,content_hash FROM personal_memory_file_tombstones ORDER BY memory_id').all(),
        suppressions: [...this.db.prepare('SELECT identity_hash,scope_id,source_digest FROM personal_context_suppressions ORDER BY identity_hash,source_digest').all(),
          ...this.db.prepare("SELECT payload_json FROM personal_memory_portable_records WHERE record_type='suppression' ORDER BY record_key").all().map(row => JSON.parse(row.payload_json))],
        memories: this.db.prepare(`SELECT item.memory_id,item.kind,item.scope_id,item.lifecycle,item.current_revision_id,item.item_revision
          FROM personal_context_items item JOIN personal_memory_files f ON f.memory_id=item.memory_id ORDER BY item.memory_id`).all(),
        sources: [...this.db.prepare(`SELECT evidence.*,f.content_hash AS memory_hash FROM personal_context_evidence evidence JOIN personal_memory_files f ON f.memory_id=evidence.memory_id ORDER BY evidence.evidence_id`).all(),
          ...this.db.prepare("SELECT payload_json FROM personal_memory_portable_records WHERE record_type='source' ORDER BY record_key").all().map(row => JSON.parse(row.payload_json))] }
      const present = new Set(exported.memories.map(m => m.memory_id))
      for (const row of this.db.prepare("SELECT payload_json FROM personal_memory_portable_records WHERE record_type='lifecycle' ORDER BY record_key").all()) {
        const memory = JSON.parse(row.payload_json)
        if (memory.memory_id && !present.has(memory.memory_id)) exported.memories.push(memory)
      }
      exported.sources = [...new Map(exported.sources.map(s => [`${s.memory_id}:${s.evidence_id}`, s])).values()]
      exported.suppressions = [...new Map(exported.suppressions.map(s => [sha256Canonical(s), s])).values()]
      require('./personal-memory-portability').validateGovernance(exported)
      return exported
    }
    if (type === 'import_revocations') return this.importRevocations(input)
    fail()
  }
  snapshot (input) {
    assertExactKeys(input, ['type', 'rootId', 'files', 'start', 'complete', 'healthy', 'seenIds'])
    if (input.rootId !== this.cache.rootId || !Array.isArray(input.files) || input.files.length > 64 || !Array.isArray(input.seenIds) || input.seenIds.length > 4096) fail()
    if (input.start) { this.cache.snapshots.clear(); this.cache.healthy = false }
    if (!input.healthy) { this.cache.snapshots.clear(); this.cache.healthy = false; return { revision: this.context.contentRevision() } }
    let changed = false
    const result = this.transaction(() => {
      for (const file of input.files) {
        relative(file.relative)
        if (file.id !== null) id(file.id)
        const meta = [...this.cache.metadata.values()].find(row => row.memory_id === file.id || row.root_id === input.rootId && row.relative_name === file.relative)
        if (file.entry) {
          validateEntry(file.entry); digest(file.contentHash); digest(file.byteHash)
          if (sha256Canonical({ policy: POLICY, ...file.entry }) !== file.contentHash) fail()
        }
        if (file.id) this.cache.snapshots.set(file.id, file)
        if (!meta) continue
        let state = file.error || !file.entry || file.id !== meta.memory_id ? (file.error === 'MEMORY_FILE_DUPLICATE_ID' ? 'conflict' : 'invalid')
          : file.contentHash === meta.content_hash ? 'ready' : 'pending'
        if (['writing', 'recovery'].includes(meta.state)) state = meta.state
        if (state !== meta.state || (file.entry && file.byteHash !== meta.byte_hash && state === 'pending')) changed = true
        this.db.prepare('UPDATE personal_memory_files SET root_id=?,relative_name=?,byte_hash=?,state=?,missing_since=NULL WHERE memory_id=?')
          .run(input.rootId, file.id === meta.memory_id ? file.relative : meta.relative_name, file.byteHash || meta.byte_hash, state, meta.memory_id)
        if (state !== 'ready') {
          this.db.prepare('DELETE FROM personal_context_session_associations WHERE memory_id=?').run(meta.memory_id)
          this.db.prepare('DELETE FROM personal_memory_index_documents WHERE memory_id=?').run(meta.memory_id)
          this.db.prepare('DELETE FROM personal_memory_vectors WHERE memory_id=?').run(meta.memory_id)
        }
      }
      if (input.complete) {
        const seen = new Set(input.seenIds)
        for (const meta of this.db.prepare('SELECT * FROM personal_memory_files WHERE root_id=?').all(input.rootId)) {
          if (seen.has(meta.memory_id) || ['writing', 'recovery'].includes(meta.state)) continue
          if (meta.state !== 'missing') changed = true
          this.db.prepare("UPDATE personal_memory_files SET state='missing',missing_since=COALESCE(missing_since,?) WHERE memory_id=?").run(this.context.nowValue(), meta.memory_id)
          this.db.prepare('DELETE FROM personal_context_session_associations WHERE memory_id=?').run(meta.memory_id)
          this.db.prepare('DELETE FROM personal_memory_index_documents WHERE memory_id=?').run(meta.memory_id)
          this.db.prepare('DELETE FROM personal_memory_vectors WHERE memory_id=?').run(meta.memory_id)
        }
        this.cache.healthy = true
      }
      if (changed) this.context.advanceRevision({ operation: 'memory-file-observation', rootId: input.rootId })
      return { revision: this.context.contentRevision() }
    })
    // Only two healthy full reconciliations separated by a save/rename grace
    // interval can interpret a missing ID as external deletion.
    if (input.complete) for (const meta of this.db.prepare("SELECT * FROM personal_memory_files WHERE root_id=? AND state='missing' AND missing_since<=?").all(input.rootId, this.context.nowValue() - 2000)) {
      const row = this.context.memoryRow(meta.memory_id)
      if (row) this.context.manageDelete({ type: 'delete', expected_revision: this.context.contentRevision(), item_id: row.memory_id,
        item_revision: Number(row.item_revision), deletion_idempotency_key: `file-missing.${sha256Canonical({ id: row.memory_id, hash: meta.content_hash }).slice(0, 44)}` })
    }
    refreshMetadata(this.db)
    return { ...result, revision: this.context.contentRevision() }
  }
  prepare (input) {
    assertExactKeys(input, ['type', 'operationId', 'operation', 'rootId', 'memoryId', 'relative', 'oldHash', 'targetHash', 'contentHash', 'entry', 'expectedRevision', 'itemRevision', 'restore', 'supersedes'])
    id(input.operationId); id(input.memoryId); relative(input.relative); digest(input.oldHash); digest(input.targetHash); digest(input.contentHash)
    validateEntry(input.entry)
    if (input.rootId !== this.cache.rootId || sha256Canonical({ policy: POLICY, ...input.entry }) !== input.contentHash || !['remember', 'update', 'migrate', 'confirm'].includes(input.operation)) fail()
    const existingOp = this.db.prepare('SELECT * FROM personal_memory_file_operations WHERE operation_id=?').get(input.operationId)
    if (existingOp) {
      if (existingOp.target_hash !== input.targetHash || existingOp.memory_id !== input.memoryId) fail()
      return { prepared: existingOp.phase === 'prepared', operation: existingOp }
    }
    if (Number(this.db.prepare("SELECT count(*) n FROM personal_memory_file_operations WHERE phase IN ('prepared','recovery')").get().n) >= 16) fail('AGENT_CONTEXT_OPERATION_FAILED')
    this.context.assertRevision(input.expectedRevision)
    const current = this.context.memoryRow(input.memoryId)
    if ((current && Number(current.item_revision) !== input.itemRevision) || (!current && input.itemRevision !== 0)) fail('AGENT_CONTEXT_REVISION_CONFLICT')
    if (input.operation === 'migrate' && (!current || current.origin !== 'explicit' || JSON.parse(current.content_json).storage === 'markdown')) fail()
      const tombstone = this.db.prepare('SELECT * FROM personal_memory_file_tombstones WHERE memory_id=?').get(input.memoryId)
    if (tombstone && !input.restore) fail('AGENT_CONTEXT_OPERATION_FAILED')
    if (input.operation === 'confirm' && !input.restore && (current?.lifecycle === 'forgotten' || this.db.prepare("SELECT 1 FROM personal_memory_portable_records WHERE record_type='lifecycle' AND memory_id=?").get(input.memoryId))) fail('AGENT_CONTEXT_OPERATION_FAILED')
    return this.transaction(() => {
      const { exactEntry } = require('./personal-context-store'); const entry = exactEntry(input.entry)
      if (input.supersedes) {
        id(input.supersedes)
        const previous = this.db.prepare("SELECT * FROM personal_memory_file_operations WHERE operation_id=? AND phase IN ('prepared','recovery')").get(input.supersedes)
        if (!previous || previous.root_id !== input.rootId || previous.memory_id !== input.memoryId || previous.relative_name !== input.relative) fail('AGENT_CONTEXT_REVISION_CONFLICT')
        this.db.prepare("UPDATE personal_memory_file_operations SET phase='aborted' WHERE operation_id=?").run(input.supersedes)
      }
      this.db.prepare("DELETE FROM personal_memory_file_operations WHERE operation_id IN (SELECT operation_id FROM personal_memory_file_operations WHERE phase IN ('committed','aborted') ORDER BY created_at DESC,operation_id LIMIT -1 OFFSET 1024)").run()
      const scopeId = this.context.scopeIdentity(entry, this.context.nowValue())
      const collision = this.db.prepare('SELECT memory_id FROM personal_context_items WHERE scope_id=? AND kind=? AND semantic_key=? AND memory_id<>?').get(scopeId, entry.kind, entry.semanticKey, input.memoryId)
      if (collision) fail('AGENT_CONTEXT_REVISION_CONFLICT')
      this.db.prepare(`INSERT INTO personal_memory_file_operations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'prepared',?)`)
        .run(input.operationId, input.rootId, input.memoryId, input.relative, input.operation, input.oldHash, input.targetHash, input.contentHash, entry.kind, canonicalize(input.entry.scope), input.itemRevision, current?.current_revision_id || null, this.context.nowValue())
      this.db.prepare("UPDATE personal_memory_files SET state='writing' WHERE memory_id=?").run(input.memoryId)
      if (current && !this.db.prepare('SELECT memory_id FROM personal_memory_files WHERE memory_id=?').get(input.memoryId))
        this.db.prepare("INSERT INTO personal_memory_files(memory_id,root_id,relative_name,content_hash,byte_hash,state,attributes_json) VALUES(?,?,?,?,?,'writing','{}')").run(input.memoryId, input.rootId, input.relative, input.contentHash, input.oldHash)
      this.context.advanceRevision({ operation: 'memory-file-prepare', memoryId: input.memoryId, operationId: input.operationId })
      refreshMetadata(this.db)
      return { prepared: true }
    })
  }
  commit (input) {
    assertExactKeys(input, ['type', 'operationId', 'file']); id(input.operationId)
    const op = this.db.prepare('SELECT * FROM personal_memory_file_operations WHERE operation_id=?').get(input.operationId)
    if (!op || op.root_id !== this.cache.rootId) fail('AGENT_CONTEXT_REVISION_CONFLICT')
    if (op.phase === 'committed') return { revision: this.context.contentRevision(), replayed: true, memoryId: op.memory_id }
    if (op.phase !== 'prepared') fail('AGENT_CONTEXT_OPERATION_FAILED')
    const file = input.file
    if (!file || file.id !== op.memory_id || file.byteHash !== op.target_hash || file.contentHash !== op.content_hash || sha256Canonical({ policy: POLICY, ...file.entry }) !== file.contentHash) fail('AGENT_INPUT_CHANGED')
    const { exactEntry } = require('./personal-context-store'); const entry = exactEntry(file.entry)
    const current = this.context.memoryRow(op.memory_id)
    if ((current && (Number(current.item_revision) !== Number(op.item_revision) || current.current_revision_id !== op.previous_revision)) || (!current && op.item_revision !== 0)) fail('AGENT_CONTEXT_REVISION_CONFLICT')
    if (entry.kind !== op.kind || canonicalize(file.entry.scope) !== op.scope_json) fail('AGENT_INPUT_CHANGED')
    const snapshot = { ...file, relative: op.relative_name, error: null }
    const previousContent = current ? memoryContent(this.db, current) : {}
    const sameBody = current && (op.operation === 'migrate' || JSON.parse(current.content_json).contentHash === file.contentHash)
    this.cache.snapshots.set(file.id, snapshot)
    return this.transaction(() => {
      const now = this.context.nowValue(); const scopeId = this.context.scopeIdentity(entry, now)
      const migrated = op.operation === 'migrate'
      const itemRevision = migrated ? Number(current.item_revision) : Number(op.item_revision) + 1
      const revisionId = migrated ? current.current_revision_id : `revision-${sha256Canonical({ memoryId: op.memory_id, itemRevision, hash: file.contentHash }).slice(0, 44)}`
      const pointer = canonicalize({ storage: 'markdown', fileId: op.memory_id, contentHash: file.contentHash, policy: POLICY })
      const attributes = { ...previousContent }; delete attributes.displayText
      if (!sameBody) for (const key of Object.keys(attributes)) delete attributes[key]
      if (!current) this.db.prepare(`INSERT INTO personal_context_items(memory_id,scope_id,kind,semantic_key,content_json,origin,confidence_band,salience_band,lifecycle,current_revision_id,item_revision,created_at,updated_at)
        VALUES (?,?,?,?,?,'explicit','high','high','active',NULL,?,?,?)`).run(op.memory_id, scopeId, entry.kind, entry.semanticKey, pointer, itemRevision, now, now)
      if (!migrated) this.db.prepare(`INSERT INTO personal_context_revisions(revision_id,memory_id,operation,content_json,previous_revision_id,run_id,created_at)
        VALUES (?,?,?, ?,?,NULL,?)`).run(revisionId, op.memory_id, current ? 'user-correct' : 'create', pointer, current?.current_revision_id || null, now)
      this.db.prepare("UPDATE personal_context_items SET scope_id=?,kind=?,semantic_key=?,content_json=?,origin='explicit',lifecycle=?,current_revision_id=?,item_revision=?,updated_at=? WHERE memory_id=?")
        .run(scopeId, entry.kind, entry.semanticKey, pointer, migrated ? current.lifecycle : 'active', revisionId, itemRevision, now, op.memory_id)
      // No prior body remains available as a second authority.
      this.db.prepare('UPDATE personal_context_revisions SET content_json=NULL WHERE memory_id=?').run(op.memory_id)
      this.db.prepare('UPDATE personal_context_revisions SET content_json=? WHERE revision_id=?').run(pointer, revisionId)
      this.db.prepare(`INSERT INTO personal_memory_files(memory_id,root_id,relative_name,content_hash,byte_hash,state,missing_since,attributes_json)
        VALUES (?,?,?,?,?,'ready',NULL,?) ON CONFLICT(memory_id) DO UPDATE SET root_id=excluded.root_id,relative_name=excluded.relative_name,
        content_hash=excluded.content_hash,byte_hash=excluded.byte_hash,state='ready',missing_since=NULL,attributes_json=excluded.attributes_json`)
        .run(op.memory_id, op.root_id, op.relative_name, file.contentHash, file.byteHash, canonicalize(attributes))
      if (!migrated) this.db.prepare('DELETE FROM personal_context_session_associations WHERE memory_id=?').run(op.memory_id)
      this.db.prepare('DELETE FROM personal_memory_vectors WHERE memory_id=?').run(op.memory_id)
      this.db.prepare('DELETE FROM personal_memory_file_tombstones WHERE memory_id=?').run(op.memory_id)
      this.db.prepare('DELETE FROM personal_memory_file_cleanup WHERE memory_id=?').run(op.memory_id)
      if (!migrated) this.db.prepare("DELETE FROM personal_memory_portable_records WHERE memory_id=? AND record_type='lifecycle'").run(op.memory_id)
      this.db.prepare("UPDATE personal_memory_file_operations SET phase='committed' WHERE operation_id=?").run(op.operation_id)
      refreshMetadata(this.db); this.cache.healthy = true
      const revision = this.context.advanceRevision({ operation: `memory-file-${op.operation}`, memoryId: op.memory_id, itemRevision })
      return { revision, replayed: false, memoryId: op.memory_id }
    })
  }
  importRevocations (input) { return require('./personal-memory-portability').importGovernance(this, input) }

}
module.exports = { PersonalMemoryFileStore, id, digest, relative }
