'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const { parentPort } = require('node:worker_threads')
const { parseFile, renderFile, hash, fault } = require('./memory-file-format')
let root = null; let rootStamp = null; let recovery = null; let native = null
const held = new Map()
function addon () {
  if (process.platform !== 'win32') fault('MEMORY_FILE_NATIVE_UNAVAILABLE')
  if (!native) { try { native = require('../../native/memory-file/memory_file_native.node') } catch { fault('MEMORY_FILE_NATIVE_UNAVAILABLE') } }
  return native
}
function locate (relative) {
  if (!root || typeof relative !== 'string' || relative.includes('\0') || relative.includes('\\') || relative.includes(':') || path.isAbsolute(relative) || relative.split('/').some(p => !p || p === '.' || p === '..')) fault()
  const target = path.resolve(root, relative)
  if (!target.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)) fault()
  return target
}
async function healthy () {
  if (!root) fault('MEMORY_FILE_ROOT_UNAVAILABLE')
  const stat = await fs.stat(root)
  if (!stat.isDirectory() || `${stat.dev}:${stat.ino}` !== rootStamp || await fs.realpath(root) !== root) fault('MEMORY_FILE_ROOT_UNAVAILABLE')
}
async function stable (relative) {
  const target = locate(relative); const before = await fs.lstat(target)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fault()
  if (before.size > 65536) fault('MEMORY_FILE_TOO_LARGE')
  if (await fs.realpath(target) !== target) fault()
  const a = await fs.readFile(target); const b = await fs.readFile(target); const after = await fs.lstat(target)
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || !a.equals(b)) fault('MEMORY_FILE_UNSTABLE')
  return parseFile(a)
}
async function scan () {
  await healthy()
  const files = []; const dirs = ['']; let bytes = 0; let visited = 0
  while (dirs.length) {
    if (++visited > 4096) fault('MEMORY_FILE_SCAN_LIMIT')
    const dir = dirs.shift()
    const directory = dir ? locate(dir) : root
    const info = await fs.lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(directory) !== directory) fault('MEMORY_FILE_INVALID')
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue
      const relative = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.isDirectory()) { if (dirs.length + files.length >= 4096) fault('MEMORY_FILE_SCAN_LIMIT'); dirs.push(relative); continue }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
      if (files.length >= 4096) fault('MEMORY_FILE_SCAN_LIMIT')
      try {
        const parsed = await stable(relative)
        bytes += Buffer.byteLength(parsed.raw)
        if (bytes > 8 * 1024 * 1024) fault('MEMORY_FILE_SCAN_LIMIT')
        const { raw, header, ...snapshot } = parsed
        files.push({ relative, ...snapshot, error: parsed.entry ? null : 'MEMORY_FILE_METADATA_REQUIRED' })
      } catch (error) {
        if (error.code === 'MEMORY_FILE_SCAN_LIMIT') throw error
        files.push({ relative, id: null, entry: null, error: /^MEMORY_FILE_/.test(error.code || '') ? error.code : 'MEMORY_FILE_READ_FAILED' })
      }
    }
  }
  await healthy(); return { files, healthy: true }
}
async function stage (name, bytes) {
  const handle = await fs.open(path.join(recovery, name), 'wx')
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
}
async function execute (input) {
  if (input.type === 'configure') {
    for (const record of held.values()) { try { addon().close(record.handle) } catch {} }
    held.clear()
    root = await fs.realpath(input.rootPath)
    const stat = await fs.stat(root); if (!stat.isDirectory()) fault()
    rootStamp = `${stat.dev}:${stat.ino}`
    recovery = path.resolve(input.recoveryPath)
    if (recovery.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)) fault()
    await fs.mkdir(recovery, { recursive: true })
    return { nativeAvailable: process.platform === 'win32' && (() => { try { addon(); return true } catch { return false } })() }
  }
  if (input.type === 'scan') return scan()
  if (input.type === 'read') { await healthy(); return stable(input.relative) }
  if (input.type === 'hold_read') {
    await healthy()
    if (!/^[a-z0-9._-]{1,128}$/i.test(input.operationId) || held.size >= 4 || held.has(input.operationId)) fault()
    const target = locate(input.relative)
    try { await fs.lstat(target) } catch (e) { if (e.code === 'ENOENT') return { id: null, entry: null, byteHash: null, missing: true }; throw e }
    const handle = addon().open(target, root, false, false)
    try {
      const bytes = addon().read(handle)
      let parsed; try { parsed = parseFile(bytes) } catch { parsed = { id: null, entry: null, error: 'MEMORY_FILE_INVALID' } }
      held.set(input.operationId, { handle, confirmOnly: true })
      return { ...parsed, byteHash: hash(bytes) }
    } catch (e) { addon().close(handle); throw e }
  }
  if (input.type === 'prepare') {
    await healthy()
    if (!/^[a-z0-9._-]{1,128}$/i.test(input.operationId) || held.size >= 4) fault()
    const api = addon(); let created = input.create === true; let handle
    try { handle = api.open(locate(input.relative), root, created, !input.confirmOnly) }
    catch (error) {
      if (!created || error.code !== 'MEMORY_FILE_CONFLICT') throw error
      // An interrupted creation may leave an empty placeholder. Reopen it
      // exclusively and verify emptiness before retrying; preserve other bytes.
      created = false; handle = api.open(locate(input.relative), root, false, !input.confirmOnly)
    }
    try {
      const old = api.read(handle)
      if (input.create && !created && old.length !== 0) fault('MEMORY_FILE_CONFLICT')
      if (input.expectedHash !== null && hash(old) !== input.expectedHash) fault('MEMORY_FILE_CONFLICT')
      let previous = null
      try { previous = old.length ? parseFile(old) : null } catch (error) { if (!input.recovery) throw error }
      if (previous?.id && previous.id !== input.memoryId) fault('MEMORY_FILE_CONFLICT')
      const next = input.confirmOnly ? old : input.replacementBytes ? Buffer.from(input.replacementBytes) : renderFile(input.memoryId, input.entry, previous)
      const parsed = parseFile(next)
      if (parsed.id !== input.memoryId || !parsed.entry) fault()
      if (!input.confirmOnly) {
        await stage(`${input.operationId}.old`, old)
        await stage(`${input.operationId}.new`, next)
      }
      held.set(input.operationId, { handle, next, created, confirmOnly: Boolean(input.confirmOnly) })
      return { byteHash: hash(next), oldHash: hash(old), contentHash: parsed.contentHash, entry: parsed.entry }
    } catch (error) {
      if (created) { try { api.remove(handle) } catch {} }
      api.close(handle)
      for (const suffix of ['old', 'new']) await fs.rm(path.join(recovery, `${input.operationId}.${suffix}`), { force: true })
      throw error
    }
  }
  if (input.type === 'write') {
    const record = held.get(input.operationId); if (!record) fault()
    if (!record.confirmOnly) addon().write(record.handle, record.next)
    if (hash(addon().read(record.handle)) !== hash(record.next)) fault('MEMORY_FILE_WRITE_FAILED')
    return { written: true }
  }
  if (input.type === 'release') {
    const record = held.get(input.operationId)
    if (record) {
      if (input.abort && record.created) { try { addon().remove(record.handle) } catch {} }
      addon().close(record.handle); held.delete(input.operationId)
    }
    if (input.clean) for (const suffix of ['old', 'new']) await fs.rm(path.join(recovery, `${input.operationId}.${suffix}`), { force: true })
    return { released: true }
  }
  if (input.type === 'remove') {
    await healthy(); const api = addon(); const target = locate(input.relative)
    try { await fs.lstat(target) } catch (e) { if (e.code === 'ENOENT') return { removed: true }; throw e }
    const handle = api.open(target, root, false)
    try { if (hash(api.read(handle)) !== input.expectedHash) fault('MEMORY_FILE_CONFLICT'); api.remove(handle); return { removed: true } } finally { api.close(handle) }
  }
  if (input.type === 'recover_bytes') {
    if (!/^[a-z0-9._-]{1,128}$/i.test(input.operationId) || !['old', 'new'].includes(input.version)) fault()
    return parseFile(await fs.readFile(path.join(recovery, `${input.operationId}.${input.version}`)))
  }
  if (input.type === 'clean_orphans') {
    if (!Array.isArray(input.retain) || input.retain.length > 16) fault()
    const retain = new Set(input.retain); const names = await fs.readdir(recovery)
    if (names.length > 4096) fault('MEMORY_FILE_SCAN_LIMIT')
    for (const name of names) {
      const match = /^(fileop\.[a-z0-9]{32})\.(old|new)$/i.exec(name)
      if (match && !retain.has(match[1])) await fs.rm(path.join(recovery, name), { force: true })
    }
    return { cleaned: true }
  }
  if (input.type === 'vector_rank') {
    if (!Array.isArray(input.rows) || input.rows.length > 64 || !Array.isArray(input.query) || input.query.length > 4096 || !input.query.length || !input.query.every(Number.isFinite) || !Array.isArray(input.previous) || input.previous.length > 64) fault()
    const ranks = [...input.previous]
    for (const row of input.rows) {
      const bytes = Buffer.from(row.vector)
      if (row.dimensions !== input.query.length || bytes.length !== row.dimensions * 4) fault()
      let score = 0
      for (let i = 0; i < input.query.length; i++) score += bytes.readFloatLE(i * 4) * input.query[i]
      if (!Number.isFinite(score)) fault()
      if (score > 0) ranks.push({ memoryId: row.memoryId, score })
    }
    return ranks.sort((a, b) => b.score - a.score || a.memoryId.localeCompare(b.memoryId)).slice(0, 64)
  }
  fault()
}
let tail = Promise.resolve()
parentPort.on('message', ({ id, input }) => {
  tail = tail.then(async () => {
    try { parentPort.postMessage({ id, result: await execute(input) }) } catch (error) {
      parentPort.postMessage({ id, error: /^MEMORY_FILE_/.test(error.code || '') ? error.code : 'MEMORY_FILE_IO_FAILED' })
    }
  })
})
