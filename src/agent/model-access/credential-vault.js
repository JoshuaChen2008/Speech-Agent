'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

class CredentialVault {
  constructor (options = {}) {
    if (typeof options.directory !== 'string' || !path.isAbsolute(options.directory)) throw new TypeError('vault directory is required')
    if (!options.safeStorage) throw new TypeError('safeStorage is required')
    this.directory = path.resolve(options.directory)
    this.safeStorage = options.safeStorage
    this.fs = options.fs || fs
    this.session = new Map()
  }

  file (slotId, generation) {
    if (!/^slot\.[a-f0-9]{32}$/.test(slotId) || !/^generation\.[a-f0-9]{32}$/.test(generation)) throw new TypeError('vault identity is invalid')
    return path.join(this.directory, `${slotId}.${generation}.bin`)
  }

  set (slotId, credential) {
    if (typeof credential !== 'string' || credential !== credential.trim() || credential.length === 0 || Buffer.byteLength(credential) > 4096) {
      throw new TypeError('credential is invalid')
    }
    this.clear(slotId)
    if (this.safeStorage.isEncryptionAvailable() !== true) {
      const value = Buffer.from(credential, 'utf8')
      this.session.set(slotId, value)
      return Object.freeze({ scope: 'session_only', generation: null })
    }
    const generation = `generation.${crypto.randomBytes(16).toString('hex')}`
    const target = this.file(slotId, generation)
    const temporary = `${target}.pending`
    this.fs.mkdirSync(this.directory, { recursive: true })
    const encrypted = this.safeStorage.encryptString(credential)
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error('credential encryption failed')
    try {
      this.fs.writeFileSync(temporary, encrypted, { flag: 'wx' })
      this.fs.renameSync(temporary, target)
    } catch (error) {
      try { this.fs.rmSync(temporary, { force: true }) } catch {}
      throw error
    }
    return Object.freeze({ scope: 'persistent', generation })
  }

  state (slotId, persistence, generation) {
    const session = this.session.get(slotId)
    if (session?.some((byte) => byte !== 0)) return Object.freeze({ present: true, scope: 'session_only' })
    if (persistence === 'persistent' && generation && this.fs.existsSync(this.file(slotId, generation))) {
      return Object.freeze({ present: true, scope: 'persistent' })
    }
    return Object.freeze({ present: false, scope: 'absent' })
  }

  async borrow (slotId, persistence, generation, consume) {
    if (typeof consume !== 'function') throw new TypeError('credential consumer is required')
    let copy
    const session = this.session.get(slotId)
    if (session?.some((byte) => byte !== 0)) copy = Buffer.from(session)
    else if (persistence === 'persistent' && generation) {
      const encrypted = this.fs.readFileSync(this.file(slotId, generation))
      copy = Buffer.from(this.safeStorage.decryptString(encrypted), 'utf8')
    } else throw new Error('credential unavailable')
    try { return await consume(copy) } finally { copy.fill(0) }
  }

  snapshot (slotId, persistence, generation) {
    const session = this.session.get(slotId)
    if (session) return { scope: 'session_only', value: Buffer.from(session) }
    if (persistence === 'persistent' && generation) {
      const file = this.file(slotId, generation)
      if (this.fs.existsSync(file)) return { scope: 'persistent', generation, value: this.fs.readFileSync(file) }
    }
    return { scope: 'absent' }
  }

  restore (slotId, snapshot) {
    this.clear(slotId)
    if (snapshot.scope === 'session_only') this.session.set(slotId, Buffer.from(snapshot.value))
    if (snapshot.scope === 'persistent') {
      this.fs.mkdirSync(this.directory, { recursive: true })
      this.fs.writeFileSync(this.file(slotId, snapshot.generation), snapshot.value)
    }
  }

  clearSession (slotId) {
    const value = this.session.get(slotId)
    if (value) value.fill(0)
    this.session.delete(slotId)
  }

  clear (slotId) {
    this.clearSession(slotId)
    if (!this.fs.existsSync(this.directory)) return
    for (const name of this.fs.readdirSync(this.directory)) {
      if (name.startsWith(`${slotId}.`)) this.fs.rmSync(path.join(this.directory, name), { force: true })
    }
  }

  sessionSlotIds () {
    return [...this.session.entries()].filter(([, value]) => value.some((byte) => byte !== 0)).map(([slot]) => slot)
  }

  close () {
    for (const slotId of [...this.session.keys()]) this.clearSession(slotId)
  }
}

module.exports = { CredentialVault }
