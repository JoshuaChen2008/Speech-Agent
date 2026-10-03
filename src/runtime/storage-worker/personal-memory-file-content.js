'use strict'

// Bounded file snapshots are TEMP/derived data. A missing snapshot can never
// recover the body from a revision or the previous overview.
const caches = new WeakMap()
function fileCache (db) {
  let value = caches.get(db)
  if (!value) { value = { rootId: null, snapshots: new Map(), metadata: new Map(), healthy: false }; caches.set(db, value) }
  return value
}
function memoryReadable (db, row) {
  if (!row) return false
  const content = row.content_json ? JSON.parse(row.content_json) : null
  const cache = fileCache(db); const meta = cache.metadata.get(row.memory_id)
  if (content?.storage !== 'markdown' && !meta) return true
  const snapshot = cache.snapshots.get(row.memory_id)
  return Boolean(content?.storage === 'markdown' && cache.healthy && meta && meta.root_id === cache.rootId &&
    meta.state === 'ready' && snapshot?.entry && !snapshot.error && snapshot.contentHash === meta.content_hash &&
    content.contentHash === snapshot.contentHash)
}
function memoryContent (db, row) {
  const content = JSON.parse(row.content_json)
  if (content.storage !== 'markdown') return content
  const cache = fileCache(db); const snapshot = cache.snapshots.get(row.memory_id)
  // Display may preview an unconfirmed revision; all Agent callers must first
  // check memoryReadable. Never display the old SQLite body for a file item.
  return { ...(cache.metadata.get(row.memory_id)?.attributes_json ? JSON.parse(cache.metadata.get(row.memory_id).attributes_json) : {}),
    displayText: snapshot?.entry?.display_text || '个人记忆文件暂不可读' }
}
function refreshMetadata (db) {
  const cache = fileCache(db)
  cache.metadata = new Map(db.prepare('SELECT * FROM personal_memory_files').all().map(row => [row.memory_id, row]))
}
module.exports = { fileCache, memoryContent, memoryReadable, refreshMetadata }
