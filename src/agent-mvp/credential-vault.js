'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { AgentCoreError } = require('../agent-core/errors')

class CredentialVault {
  constructor ({ safeStorage, credentialPath }) {
    this.safeStorage = safeStorage; this.credentialPath = path.resolve(credentialPath); this.sessionCredential = null
  }

  canPersist () { return Boolean(this.safeStorage?.isEncryptionAvailable?.()) }

  set (credential) {
    if (typeof credential !== 'string' || credential.length < 1 || credential.length > 4096) throw new AgentCoreError('AGENT_REQUEST_INVALID')
    this.sessionCredential = credential
    if (!this.canPersist()) return { hasCredential: true, credentialPersisted: false }
    const encrypted = this.safeStorage.encryptString(credential)
    fs.mkdirSync(path.dirname(this.credentialPath), { recursive: true })
    const temporary = `${this.credentialPath}.tmp`
    fs.writeFileSync(temporary, encrypted.toString('base64'), { encoding: 'ascii', flag: 'w' })
    fs.renameSync(temporary, this.credentialPath)
    return { hasCredential: true, credentialPersisted: true }
  }

  get () {
    if (this.sessionCredential) return this.sessionCredential
    if (!this.canPersist() || !fs.existsSync(this.credentialPath)) return null
    try {
      const encrypted = Buffer.from(fs.readFileSync(this.credentialPath, 'ascii'), 'base64')
      this.sessionCredential = this.safeStorage.decryptString(encrypted)
      return this.sessionCredential
    } catch { return null }
  }

  status () { return { hasCredential: this.get() !== null, credentialPersisted: this.get() !== null && this.canPersist() && fs.existsSync(this.credentialPath) } }
}

module.exports = { CredentialVault }
