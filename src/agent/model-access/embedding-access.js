'use strict'

const crypto = require('node:crypto')
const { canonicalizeConnection, joinEndpoint } = require('./connection')
const { canonicalize } = require('../../runtime/storage-worker/canonical-json')
const { assertExactKeys } = require('../../runtime/storage-worker/protocol')
const error = code => Object.assign(new Error(code), { code })
const EMBEDDING_COMMANDS = new Set(['configureEmbedding', 'setEmbeddingCredential', 'clearEmbeddingCredential'])
function checkedResponse (data, count) {
  if (!data || !Array.isArray(data.data) || data.data.length !== count || typeof data.model !== 'string' || !data.model || data.model.length > 160) throw error('EMBEDDING_RESPONSE_INVALID')
  const results = Array(count); let dimensions = null
  for (const row of data.data) {
    if (!Number.isInteger(row.index) || row.index < 0 || row.index >= count || results[row.index] || !Array.isArray(row.embedding) || row.embedding.length < 1 || row.embedding.length > 4096 || !row.embedding.every(Number.isFinite)) throw error('EMBEDDING_RESPONSE_INVALID')
    const norm = Math.hypot(...row.embedding)
    if (!Number.isFinite(norm) || norm < 1e-12 || dimensions !== null && dimensions !== row.embedding.length) throw error('EMBEDDING_RESPONSE_INVALID')
    dimensions = row.embedding.length; results[row.index] = row.embedding.map(value => value / norm)
  }
  return { vectors: results, modelId: data.model, dimensions }
}
async function bodyJson (response) {
  if (!response.body?.getReader) throw error('EMBEDDING_RESPONSE_INVALID')
  const reader = response.body.getReader(); const chunks = []; let size = 0
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break
      size += value.length; if (size > 4 * 1024 * 1024) throw error('EMBEDDING_RESPONSE_INVALID')
      chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch (e) { if (e.code) throw e; throw error('EMBEDDING_RESPONSE_INVALID') } finally { try { await reader.cancel() } catch {} }
}
class EmbeddingAccessRuntime {
  constructor ({ gateway, vault, fetchImpl = globalThis.fetch, onChanged = () => {} }) {
    this.gateway = gateway; this.vault = vault; this.fetch = fetchImpl; this.onChanged = onChanged
    this.controllers = new Set(); this.tail = Promise.resolve()
  }
  async internal () { return this.gateway.personalMemoryIndex({ type: 'embedding_catalog' }) }
  async initialize () {
    const c = await this.internal()
    this.vault.recover(c ? [{ credential_slot_id: c.credential_slot_id, credential_persistence: c.credential_persistence, credential_generation: c.credential_generation }] : [])
    return this
  }
  async catalog () {
    const c = await this.internal(); const credential = c ? this.vault.state(c.credential_slot_id, c.credential_persistence, c.credential_generation) : { present: false, scope: 'absent' }
    return { revision: Number(c?.revision || 0), configured: Boolean(c?.https_origin && c.model_id), httpsOrigin: c?.https_origin || '', basePath: c?.base_path || '/v1', modelId: c?.model_id || '',
      enabled: Boolean(c?.enabled), disclosureAccepted: Boolean(c?.disclosure_accepted), credentialPresent: credential.present, credentialScope: credential.scope }
  }
  configure (command) {
    const next = this.tail.then(() => this.change(command)); this.tail = next.catch(() => {}); return next
  }
  async change (command) {
    if (!EMBEDDING_COMMANDS.has(command?.type)) throw error('MODEL_CONFIG_INVALID')
    assertExactKeys(command, command.type === 'configureEmbedding' ? ['type', 'expectedRevision', 'httpsOrigin', 'basePath', 'modelId', 'enabled', 'disclosureAccepted'] : command.type === 'setEmbeddingCredential' ? ['type', 'expectedRevision', 'credential'] : ['type', 'expectedRevision'])
    const old = await this.internal()
    if (command.expectedRevision !== Number(old?.revision || 0)) throw error('MODEL_CONFIG_REVISION_CONFLICT')
    const config = { httpsOrigin: old?.https_origin || null, basePath: old?.base_path || null, modelId: old?.model_id || null, enabled: Boolean(old?.enabled), disclosureAccepted: Boolean(old?.disclosure_accepted),
      slotId: old?.credential_slot_id || `slot.${crypto.randomBytes(16).toString('hex')}`, persistence: old?.credential_persistence || 'absent', generation: old?.credential_generation || null }
    let token = null
    try {
      if (command.type === 'configureEmbedding') {
        const connection = canonicalizeConnection(command.httpsOrigin, command.basePath)
        if (typeof command.modelId !== 'string' || !command.modelId || Buffer.byteLength(command.modelId) > 160 || typeof command.enabled !== 'boolean' || typeof command.disclosureAccepted !== 'boolean' || command.enabled && !command.disclosureAccepted) throw error('MODEL_CONFIG_INVALID')
        Object.assign(config, connection, { modelId: command.modelId, enabled: command.enabled, disclosureAccepted: command.disclosureAccepted })
      } else if (command.type === 'setEmbeddingCredential') {
        if (typeof command.credential !== 'string' || command.credential !== command.credential.trim() || !command.credential || Buffer.byteLength(command.credential) > 4096 || /[\r\n\0]/.test(command.credential)) throw error('MODEL_CONFIG_INVALID')
        token = this.vault.prepareSet(config.slotId, command.credential, { persistence: config.persistence, generation: config.generation })
        config.persistence = token.state.scope; config.generation = token.state.generation
      } else {
        token = this.vault.prepareClear(config.slotId, config.persistence, config.generation); config.persistence = 'absent'; config.generation = null; config.enabled = false
      }
      const result = await this.gateway.personalMemoryIndex({ type: 'embedding_configure', expectedRevision: command.expectedRevision, config })
      if (token) { if (command.type === 'setEmbeddingCredential') this.vault.commitSet(token); else this.vault.commitClear(token) }
      this.cancel(); this.onChanged(); return result
    } catch (e) {
      if (token) {
        // A lost ACK is resolved against the persisted generation before any
        // rollback can discard a committed credential.
        let latest; try { latest = await this.internal() } catch {}
        const committed = latest?.revision > command.expectedRevision && (command.type === 'setEmbeddingCredential' ? latest.credential_generation === config.generation : latest.credential_persistence === 'absent')
        if (committed) { if (command.type === 'setEmbeddingCredential') this.vault.commitSet(token); else this.vault.commitClear(token); this.cancel(); this.onChanged(); return { revision: Number(latest.revision) } }
        if (latest) { if (command.type === 'setEmbeddingCredential') this.vault.rollbackSet(token); else this.vault.rollbackClear(token) }
      }
      throw error(e.code || 'MODEL_CONFIG_INVALID')
    }
  }
  async bind (request) {
    assertExactKeys(request, ['kind', 'jobId', 'inputDigest'])
    if (request.kind !== 'embedding') throw error('MODEL_CONFIG_INVALID')
    const c = await this.internal()
    if (!c?.enabled || !c.disclosure_accepted || !c.model_id || !c.https_origin) throw error('EMBEDDING_DISABLED')
    const state = this.vault.state(c.credential_slot_id, c.credential_persistence, c.credential_generation)
    if (!state.present) throw error('AGENT_CREDENTIAL_UNAVAILABLE')
    const binding = { kind: 'embedding', configRevision: Number(c.revision), modelId: c.model_id, httpsOrigin: c.https_origin, basePath: c.base_path, slotId: c.credential_slot_id, policy: 'embedding-float@1' }
    return this.gateway.personalMemoryIndex({ type: 'embedding_bind', jobId: request.jobId, inputDigest: request.inputDigest, binding })
  }
  async run (binding, texts, { signal, timeoutMs = 30000 } = {}) {
    if (!Array.isArray(texts) || !texts.length || texts.length > 16 || texts.some(text => typeof text !== 'string' || !text.trim()) || Buffer.byteLength(texts.join('')) > 32768 || ![3000, 30000].includes(timeoutMs)) throw error('MODEL_CONFIG_INVALID')
    const c = await this.internal()
    if (!c?.enabled || !c.disclosure_accepted || Number(c.revision) !== binding.configRevision || c.credential_slot_id !== binding.slotId || c.model_id !== binding.modelId) throw error('EMBEDDING_DISABLED')
    const connection = canonicalizeConnection(binding.httpsOrigin, binding.basePath)
    const controller = new AbortController(); this.controllers.add(controller)
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    let timer; let onAbort
    const deadline = new Promise((resolve, reject) => {
      onAbort = () => reject(error('AGENT_CANCELLED'))
      controller.signal.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => { reject(error('EMBEDDING_TIMEOUT')); controller.abort() }, timeoutMs)
      if (controller.signal.aborted) onAbort()
    })
    try {
      const result = await this.vault.borrow(c.credential_slot_id, c.credential_persistence, c.credential_generation, async credential => Promise.race([
        Promise.resolve().then(async () => {
          if (controller.signal.aborted) throw error('AGENT_CANCELLED')
          const response = await this.fetch(joinEndpoint(connection, '/embeddings'), { method: 'POST', redirect: 'manual', signal: controller.signal,
            headers: { authorization: `Bearer ${credential.toString('utf8')}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: binding.modelId, input: texts, encoding_format: 'float' }) })
          if (response.status >= 300 && response.status < 400 || response.url && new URL(response.url).origin !== connection.httpsOrigin) throw error('EMBEDDING_REDIRECT_REJECTED')
          if ([401, 403].includes(response.status)) throw error('EMBEDDING_AUTH_FAILED')
          if (response.status === 429) throw error('EMBEDDING_RATE_LIMITED')
          if (!response.ok) throw error('EMBEDDING_UNAVAILABLE')
          return checkedResponse(await bodyJson(response), texts.length)
        }), deadline
      ]))
      if (result.modelId !== binding.modelId) throw error('EMBEDDING_MODEL_MISMATCH')
      const latest = await this.internal()
      if (controller.signal.aborted || signal?.aborted) throw error('AGENT_CANCELLED')
      if (Number(latest?.revision) !== binding.configRevision || !latest.enabled || !latest.disclosure_accepted) throw error('EMBEDDING_DISABLED')
      return result
    } catch (e) {
      if (e.code === 'EMBEDDING_AUTH_FAILED') {
        const latest = await this.internal()
        if (Number(latest?.revision) === binding.configRevision) await this.configure({ type: 'clearEmbeddingCredential', expectedRevision: binding.configRevision })
      }
      throw error(e.code || (controller.signal.aborted ? 'AGENT_CANCELLED' : 'EMBEDDING_UNAVAILABLE'))
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.signal.removeEventListener('abort', onAbort); this.controllers.delete(controller) }
  }
  cancel () { for (const controller of this.controllers) controller.abort() }
  close () { this.cancel(); this.vault.close() }
}
module.exports = { EmbeddingAccessRuntime, EMBEDDING_COMMANDS, checkedResponse }
