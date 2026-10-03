'use strict'

const { assertExactKeys, StorageError } = require('./protocol')
const { fileCache, memoryContent, memoryReadable } = require('./personal-memory-file-content')
const { sha256Canonical } = require('./canonical-json')
const fail = () => { throw new StorageError('AGENT_CONTEXT_OPERATION_FAILED') }
function project (store, row) {
  return { memoryId: row.memory_id, revision: Number(row.item_revision), kind: row.kind,
    text: memoryContent(store.database, row).displayText,
    scope: { kind: row.scope_kind, reference: row.scope_kind === 'global' ? null : row.scope_id, label: row.scope_label },
    sources: store.memorySources(row).map(source => ({ occurredAt: source.occurred_at, kind: source.summary_kind,
      availability: source.availability, target: source.target })) }
}
function readMemoryContent (store, input) {
  const { assertSharingSelection, assertSharingScope } = require('../../agent/contracts/personal-memory-sharing')
  const db = store.database
  const base = `SELECT item.*, scope.kind AS scope_kind, scope.label AS scope_label
    FROM personal_context_items item JOIN personal_context_scopes scope ON scope.scope_id=item.scope_id
    WHERE item.origin='explicit' AND item.lifecycle='active' AND scope.lifecycle='active'`
  if (input.type === 'content_page') {
    assertExactKeys(input, ['type', 'scope', 'after']); assertSharingScope(input.scope)
    if (input.after !== null && (typeof input.after !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(input.after))) fail()
    const clauses = input.scope ? ' AND scope.kind=? AND (? IS NULL OR scope.scope_id=?)' : ''
    const params = input.scope ? [input.scope.kind, input.scope.reference, input.scope.reference] : []
    const items = []
    for (const row of db.prepare(`${base}${clauses} AND item.memory_id>? ORDER BY item.memory_id`).iterate(...params, input.after || '')) {
      if (!memoryReadable(db, row)) continue
      items.push(project(store, row)); if (items.length === 21) break
    }
    const hasMore = items.length > 20; items.length = Math.min(items.length, 20)
    if (Buffer.byteLength(JSON.stringify(items)) > 65536) fail()
    return { items, nextCursor: hasMore ? items.at(-1).memoryId : null }
  }
  assertExactKeys(input, ['type', 'memoryIds']); assertSharingSelection(input.memoryIds)
  const items = [...input.memoryIds].sort().map(memoryId => {
    const row = db.prepare(`${base} AND item.memory_id=?`).get(memoryId)
    if (!row || !memoryReadable(db, row)) fail()
    return project(store, row)
  })
  const snapshot = { schemaVersion: 1, kind: 'personal-memory-content', items }
  if (Buffer.byteLength(JSON.stringify(snapshot)) > 64000) fail()
  return { ...snapshot, digest: sha256Canonical({ ...snapshot, rootId: fileCache(db).rootId }) }
}
module.exports = { readMemoryContent }
