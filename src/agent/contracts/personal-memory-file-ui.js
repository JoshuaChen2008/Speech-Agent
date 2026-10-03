'use strict'

const CONTRACT_ID = 'speech-agent.personal-memory.files'
const CONTRACT_VERSION = '1.0.0'
const { assertExactKeys } = require('../../runtime/storage-worker/protocol')
const { validateEntry } = require('../personal-context/memory-file-format')
const fail = () => { throw new TypeError('MEMORY_FILE_REQUEST_INVALID') }
const id = value => { if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value)) fail() }
const hash = value => { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail() }
const TYPES = Object.freeze({ status: [], list: ['after'], chooseRoot: [], setWrite: ['rootId', 'enabled'], confirm: ['rootId', 'fileId', 'expectedHash', 'restore', 'entry'],
  migrate: ['rootId', 'memoryIds'], rebuild: ['rootId'], cancelIndex: [], openFile: ['fileId'], exportGovernance: [], importGovernance: ['rootId'],
  recoveryReview: ['operationId'], recoveryRestore: ['rootId', 'operationId', 'expectedHash', 'version'], retryCleanup: ['rootId'], search: ['query'], configureEmbedding: ['command'] })
function assertRequest (request) {
  assertExactKeys(request, ['contractId', 'contractVersion', 'command'])
  if (request.contractId !== CONTRACT_ID || request.contractVersion !== CONTRACT_VERSION) fail()
  const c = request.command
  if (c && /^(content|mcp)/.test(c.type)) { require('./personal-memory-sharing').assertSharingCommand(c); return request }
  if (!c || !Object.hasOwn(TYPES, c.type)) fail()
  assertExactKeys(c, ['type', ...TYPES[c.type]])
  if (Object.hasOwn(c, 'rootId')) id(c.rootId)
  if (Object.hasOwn(c, 'fileId')) id(c.fileId)
  if (Object.hasOwn(c, 'operationId')) id(c.operationId)
  if (Object.hasOwn(c, 'expectedHash') && !(c.type === 'recoveryRestore' && c.expectedHash === null)) hash(c.expectedHash)
  if (Object.hasOwn(c, 'enabled') && typeof c.enabled !== 'boolean') fail()
  if (c.type === 'list' && c.after !== null) id(c.after)
  if (c.type === 'confirm') { if (typeof c.restore !== 'boolean') fail(); if (c.entry !== null) { assertExactKeys(c.entry, ['display_text', 'kind', 'scope']); assertExactKeys(c.entry.scope, ['kind', 'reference']); validateEntry(c.entry) } }
  if (c.type === 'migrate' && (!Array.isArray(c.memoryIds) || !c.memoryIds.length || c.memoryIds.length > 64 || new Set(c.memoryIds).size !== c.memoryIds.length)) fail()
  if (c.type === 'migrate') c.memoryIds.forEach(id)
  if (c.type === 'recoveryRestore' && !['old', 'new', 'current'].includes(c.version)) fail()
  if (c.type === 'search' && (typeof c.query !== 'string' || !c.query.trim() || Buffer.byteLength(c.query) > 4096)) fail()
  if (c.type === 'configureEmbedding') {
    const e = c.command
    const fields = { configureEmbedding: ['expectedRevision', 'httpsOrigin', 'basePath', 'modelId', 'enabled', 'disclosureAccepted'], setEmbeddingCredential: ['expectedRevision', 'credential'], clearEmbeddingCredential: ['expectedRevision'] }
    if (!e || !Object.hasOwn(fields, e.type)) fail()
    assertExactKeys(e, ['type', ...fields[e.type]])
    if (!Number.isSafeInteger(e.expectedRevision) || e.expectedRevision < 0) fail()
    if (e.type === 'configureEmbedding' && (typeof e.httpsOrigin !== 'string' || e.httpsOrigin.length > 2048 || typeof e.basePath !== 'string' || e.basePath.length > 512 || typeof e.modelId !== 'string' || !e.modelId || Buffer.byteLength(e.modelId) > 160 || typeof e.enabled !== 'boolean' || typeof e.disclosureAccepted !== 'boolean')) fail()
    if (e.type === 'setEmbeddingCredential' && (typeof e.credential !== 'string' || !e.credential || Buffer.byteLength(e.credential) > 4096 || /[\r\n\0]/.test(e.credential))) fail()
  }
  return request
}
function assertResponse (response) {
  assertExactKeys(response, ['contractId', 'contractVersion', 'ok', 'result', 'error'])
  if (response.contractId !== CONTRACT_ID || response.contractVersion !== CONTRACT_VERSION || typeof response.ok !== 'boolean') fail()
  if (response.ok ? response.error !== null || !response.result || typeof response.result !== 'object' : response.result !== null || !/^(MEMORY_FILE_|AGENT_|MODEL_|EMBEDDING_)[A-Z0-9_]+$/.test(response.error?.code || '')) fail()
  if (!response.ok) assertExactKeys(response.error, ['code'])
  // Public responses have bounded structure and never carry private locations,
  // credential slots, provider errors or the recovery journal itself.
  let nodes = 0
  function visit (value, depth = 0) {
    if (++nodes > 16384 || depth > 12) fail()
    if (typeof value === 'string' && Buffer.byteLength(value) > 8192) fail()
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { if (value.length > 4096) fail(); value.forEach(v => visit(v, depth + 1)); return }
    for (const [key, v] of Object.entries(value)) { if (['rootPath', 'absolutePath', 'credential', 'slotId', 'credential_slot_id', 'binding_json', 'raw'].includes(key)) fail(); visit(v, depth + 1) }
  }
  visit(response)
  return response
}
function response (result, code = null) {
  return assertResponse({ contractId: CONTRACT_ID, contractVersion: CONTRACT_VERSION, ok: code === null, result: code === null ? result : null, error: code === null ? null : { code } })
}
module.exports = { CONTRACT_ID, CONTRACT_VERSION, assertRequest, assertResponse, response }
