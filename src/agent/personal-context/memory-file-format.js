'use strict'

const crypto = require('node:crypto')
const YAML = require('yaml')
const { canonicalize } = require('../../runtime/storage-worker/canonical-json')
const KINDS = ['decision', 'conclusion', 'todo', 'term', 'preference', 'project_fact', 'experience']
const POLICY = 'memory-file@1'
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
function fault (code = 'MEMORY_FILE_INVALID') { throw Object.assign(new Error(code), { code }) }
function validateEntry (entry) {
  if (!entry || !KINDS.includes(entry.kind) || typeof entry.display_text !== 'string' || !entry.display_text.trim() || Buffer.byteLength(entry.display_text) > 2048 || entry.display_text.includes('\0')) fault()
  const scope = entry.scope
  if (!scope || !['global', 'session', 'topic', 'project'].includes(scope.kind) || (scope.kind === 'global' ? scope.reference !== null : typeof scope.reference !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,159}$/i.test(scope.reference))) fault()
  return entry
}
function parseFile (bytes) {
  if (bytes.length > 65536) fault('MEMORY_FILE_TOO_LARGE')
  const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  if (raw.includes('\0')) fault()
  const match = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (!match) return { raw, byteHash: hash(bytes), entry: null, id: null, policy: POLICY, header: null, body: raw.trim() }
  const header = YAML.parseDocument(match[1], { uniqueKeys: true, schema: 'core', maxAliasCount: 0 })
  if (header.errors.length || !YAML.isMap(header.contents)) fault()
  let data
  try { data = header.toJS({ maxAliasCount: 0 }) } catch { fault() }
  if (typeof data.id !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(data.id)) fault()
  const body = raw.slice(match[0].length).trim()
  const entry = validateEntry({ display_text: body, kind: data.kind, scope: data.scope })
  const contentHash = hash(canonicalize({ policy: POLICY, ...entry }))
  return { raw, byteHash: hash(bytes), contentHash, entry, id: data.id, policy: POLICY, header: match[1], body }
}
function renderFile (id, entry, previous = null) {
  validateEntry(entry)
  if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(id)) fault()
  const eol = previous?.raw.includes('\r\n') ? '\r\n' : '\n'
  let header = previous?.header
  const fields = { id, kind: entry.kind, scope: entry.scope }
  if (header !== null && header !== undefined) {
    const doc = YAML.parseDocument(header)
    const edits = []
    for (const [key, value] of Object.entries(fields)) {
      const pair = doc.contents.items.find(pair => pair.key?.value === key)
      if (!pair?.value?.range) fault()
      const encoded = key === 'scope' ? JSON.stringify(value) : JSON.stringify(value)
      if (canonicalize(pair.value.toJSON()) === canonicalize(value)) continue
      edits.push({ start: pair.value.range[0], end: pair.value.range[1], text: encoded })
    }
    for (const edit of edits.sort((a, b) => b.start - a.start)) header = header.slice(0, edit.start) + edit.text + header.slice(edit.end)
  } else header = `id: ${JSON.stringify(id)}${eol}kind: ${entry.kind}${eol}scope: ${JSON.stringify(entry.scope)}`
  // Keep all bytes when no consumed field changed, including custom metadata.
  if (previous?.entry && canonicalize(previous.entry) === canonicalize(entry)) return Buffer.from(previous.raw)
  return Buffer.from(`${previous?.raw.startsWith('\uFEFF') ? '\uFEFF' : ''}---${eol}${header}${eol}---${eol}${entry.display_text}${eol}`)
}
module.exports = { POLICY, KINDS, hash, fault, parseFile, renderFile, validateEntry }
