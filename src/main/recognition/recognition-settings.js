'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { CredentialVault } = require('../security/credential-vault')
const { assertUpdateRequest } = require('../../contracts/recognition-settings')

const { NLS_PARAMETERS: PARAMETERS } = require('../../contracts/recognition')
function failure (code) { return Object.assign(new Error(code), { code }) }
function exact (value, keys) { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw failure('NLS_INVALID_SETTINGS') }
function text (value, max, empty = false) { return typeof value === 'string' && value === value.trim() && (empty || value.length > 0) && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) }

async function requestToken (credential) {
  const RPCClient = require('@alicloud/pop-core')
  const client = new RPCClient({ ...credential, endpoint: 'https://nls-meta.cn-shanghai.aliyuncs.com', apiVersion: '2019-02-28' })
  const deadline = setTimeout(() => client.keepAliveAgent.destroy(), 5000)
  try {
    // httpx uses native HTTPS and never follows redirects. POST keeps signed credentials out of URLs.
    return await client.request('CreateToken', {}, { method: 'POST', timeout: 5000, followRedirect: false })
  } finally { clearTimeout(deadline); client.keepAliveAgent.destroy() }
}

class RecognitionSettings {
  constructor ({ directory, safeStorage, isActive = () => false, tokenRequest = requestToken, now = Date.now } = {}) {
    if (!path.isAbsolute(directory || '')) throw failure('NLS_INVALID_SETTINGS')
    this.directory = directory
    this.file = path.join(directory, 'settings.json')
    this.isActive = isActive
    this.tokenRequest = tokenRequest
    this.now = now
    this.generation = 0
    this.cached = null
    this.pending = null
    this.safeStorage = safeStorage || { isEncryptionAvailable: () => false }
    this.loadError = null
    this.vault = null
    this.state = { revision: 0, strategy: 'local-only', appKey: '', modelLabel: '', cloudDisclosureAccepted: false, slot: `slot.${crypto.randomBytes(16).toString('hex')}`, persistence: 'absent', credentialGeneration: null }
    const defaults = this.state
    try {
    if (fs.existsSync(this.file)) this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    const s = this.state
    if (!Number.isSafeInteger(s.revision) || s.revision < 0 || !['local-only', 'cloud-primary'].includes(s.strategy) || !text(s.appKey, 256, true) || !text(s.modelLabel, 160, true) || typeof s.cloudDisclosureAccepted !== 'boolean' || !/^slot\.[a-f0-9]{32}$/.test(s.slot) || !['absent', 'persistent', 'session_only'].includes(s.persistence) || (s.credentialGeneration !== null && !/^generation\.[a-f0-9]{32}$/.test(s.credentialGeneration))) throw failure('NLS_SETTINGS_UNAVAILABLE')
    if (s.credentialDirectory !== undefined && !/^credentials(?:-[a-f0-9]{32})?$/.test(s.credentialDirectory)) throw failure('NLS_SETTINGS_UNAVAILABLE')
    this.vault = new CredentialVault({ directory: path.join(directory, s.credentialDirectory || 'credentials'), safeStorage: this.safeStorage })
    this.vault.recover([{ credential_slot_id: s.slot, credential_persistence: s.persistence, credential_generation: s.credentialGeneration }])
    } catch {
      this.vault?.close(); this.vault = null
      this.state = defaults
      this.loadError = 'NLS_SETTINGS_UNAVAILABLE'
    }
  }

  getPublic () {
    const { revision, strategy, appKey, modelLabel, cloudDisclosureAccepted } = this.state
    return Object.freeze({ revision, strategy, appKey, modelLabel, cloudDisclosureAccepted, region: 'cn-shanghai', loadError: this.loadError, credential: this.vault ? this.vault.state(this.state.slot, this.state.persistence, this.state.credentialGeneration) : { present: false, scope: 'absent' } })
  }

  update (request) {
    assertUpdateRequest(request)
    if (this.loadError === 'NLS_CREDENTIAL_CLEANUP_REQUIRED') throw failure(this.loadError)
    exact(request, ['expectedRevision', 'strategy', 'appKey', 'modelLabel', 'cloudDisclosureAccepted', 'credential', 'clearCredential'])
    if (this.isActive()) throw failure('NLS_SESSION_ACTIVE')
    if (request.expectedRevision !== this.state.revision) throw failure('NLS_SETTINGS_CONFLICT')
    if (!['local-only', 'cloud-primary'].includes(request.strategy) || !text(request.appKey, 256, true) || !text(request.modelLabel, 160, true) || typeof request.cloudDisclosureAccepted !== 'boolean' || (request.clearCredential !== undefined && typeof request.clearCredential !== 'boolean')) throw failure('NLS_INVALID_SETTINGS')
    if (request.credential && request.clearCredential) throw failure('NLS_INVALID_SETTINGS')
    if (request.credential) {
      exact(request.credential, ['accessKeyId', 'accessKeySecret'])
      if (!text(request.credential.accessKeyId, 256) || !text(request.credential.accessKeySecret, 1024)) throw failure('NLS_INVALID_SETTINGS')
    }
    if (request.strategy === 'cloud-primary' && (!request.appKey || !request.cloudDisclosureAccepted)) throw failure('NLS_DISCLOSURE_REQUIRED')
    let transaction
    const next = { ...this.state, revision: this.state.revision + 1, strategy: request.strategy, appKey: request.appKey, modelLabel: request.modelLabel, cloudDisclosureAccepted: request.cloudDisclosureAccepted }
    const recovering = this.loadError !== null
    try {
      if (recovering) {
        next.credentialDirectory = `credentials-${crypto.randomBytes(16).toString('hex')}`
        this.vault = new CredentialVault({ directory: path.join(this.directory, next.credentialDirectory), safeStorage: this.safeStorage })
        // Explicit recovery preserves the unreadable source and leaves its vault untouched.
        if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.recovery-${crypto.randomBytes(16).toString('hex')}`)
      }
      if (request.credential) {
        transaction = this.vault.prepareSet(next.slot, JSON.stringify(request.credential), { persistence: next.persistence, generation: next.credentialGeneration })
        next.persistence = transaction.state.scope
        next.credentialGeneration = transaction.state.generation
      } else if (request.clearCredential) {
        transaction = this.vault.prepareClear(next.slot, next.persistence, next.credentialGeneration)
        next.persistence = 'absent'; next.credentialGeneration = null
      }
      fs.mkdirSync(this.directory, { recursive: true })
      fs.writeFileSync(`${this.file}.pending`, JSON.stringify(next))
      fs.renameSync(`${this.file}.pending`, this.file)
    } catch {
      if (transaction) { if (request.credential) this.vault.rollbackSet(transaction); else this.vault.rollbackClear(transaction) }
      if (recovering) { this.vault?.close(); this.vault = null }
      throw failure('NLS_SETTINGS_UNAVAILABLE')
    }
    this.state = next
    this.loadError = null
    const cleaned = !transaction || (request.credential ? this.vault.commitSet(transaction) : this.vault.commitClear(transaction))
    this.generation++; this.cached = null; this.pending = null
    if (!cleaned) { this.loadError = 'NLS_CREDENTIAL_CLEANUP_REQUIRED'; throw failure(this.loadError) }
    return this.getPublic()
  }

  getAppKey () { return this.state.appKey }
  freeze () {
    if (this.loadError) throw failure(this.loadError)
    if (this.state.strategy === 'cloud-primary' && (!this.state.cloudDisclosureAccepted || !this.state.appKey || !this.getPublic().credential.present)) throw failure('NLS_CONFIGURATION_REQUIRED')
    const cloud = this.state.strategy === 'cloud-primary'
    return Object.freeze({ strategy: this.state.strategy, provider: cloud ? 'nls' : 'local', region: cloud ? 'cn-shanghai' : null, configRevision: this.state.revision, projectRef: cloud ? crypto.createHash('sha256').update(this.state.appKey).digest('hex') : null, modelLabel: cloud ? this.state.modelLabel : '', parameters: cloud ? PARAMETERS : null })
  }

  async getToken ({ signal } = {}) {
    if (this.loadError) throw failure(this.loadError)
    if (signal?.aborted) throw failure('NLS_CANCELLED')
    const generation = this.generation
    if (this.cached && this.cached.expireTime * 1000 > this.now() + 300000) return this.cached.token
    if (!this.pending) {
      const state = { ...this.state }
      const pending = this.vault.borrow(state.slot, state.persistence, state.credentialGeneration, async bytes => {
        for (let attempt = 0; attempt < 2; attempt++) {
          let timer
          try {
            const response = await Promise.race([this.tokenRequest(JSON.parse(bytes.toString('utf8'))), new Promise((resolve, reject) => { timer = setTimeout(() => reject(failure('NLS_TOKEN_TIMEOUT')), 5000) })])
            if (!text(response?.Token?.Id, 4096) || !Number.isSafeInteger(response?.Token?.ExpireTime) || response.Token.ExpireTime * 1000 <= this.now() + 300000) throw failure('NLS_TOKEN_INVALID')
            if (generation !== this.generation) throw failure('NLS_CONFIGURATION_CHANGED')
            this.cached = { token: response.Token.Id, expireTime: response.Token.ExpireTime }
            return this.cached.token
          } catch (error) {
            if (['InvalidTimeStamp.Expired', 'InvalidTimeStamp.Format', 'SignatureNonceUsed', 'RequestTimeTooSkewed'].includes(error?.code)) throw failure('NLS_CLOCK_INVALID')
            const transient = ['ETIMEDOUT', 'ECONNRESET', 'EAI_AGAIN', 'ECONNREFUSED', 'NLS_TOKEN_TIMEOUT'].includes(error?.code)
            if (attempt === 0 && transient && generation === this.generation) continue
            throw failure(error?.code === 'NLS_CONFIGURATION_CHANGED' ? error.code : transient ? 'NLS_TOKEN_UNAVAILABLE' : 'NLS_AUTH_FAILED')
          } finally { clearTimeout(timer) }
        }
      }).catch(error => { throw failure(error?.code?.startsWith('NLS_') ? error.code : 'NLS_AUTH_FAILED') })
      this.pending = pending
      pending.finally(() => { if (this.pending === pending) this.pending = null }).catch(() => {})
    }
    let onAbort
    const cancelled = signal && new Promise((resolve, reject) => {
      onAbort = () => reject(failure('NLS_CANCELLED'))
      signal.addEventListener('abort', onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    let result
    try { result = await (cancelled ? Promise.race([this.pending, cancelled]) : this.pending) } finally { signal?.removeEventListener('abort', onAbort) }
    if (signal?.aborted) throw failure('NLS_CANCELLED')
    if (generation !== this.generation) throw failure('NLS_CONFIGURATION_CHANGED')
    return result
  }

  async verifyCredentials (options) { await this.getToken(options); return { verified: true, scope: 'token-only' } }
  close () { this.generation++; this.cached = null; this.vault?.close() }
}

module.exports = { RecognitionSettings, PARAMETERS }
