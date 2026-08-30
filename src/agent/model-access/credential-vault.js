'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const SLOT_PATTERN = /^slot\.[a-f0-9]{32}$/
const GENERATION_PATTERN = /^generation\.[a-f0-9]{32}$/
const OPERATION_PATTERN = /^operation\.[a-f0-9]{32}$/
const JOURNAL_NAME = 'journal.v1.json'

class CredentialVault {
  constructor (options = {}) {
    if (typeof options.directory !== 'string' || !path.isAbsolute(options.directory)) throw new TypeError('vault directory is required')
    if (!options.safeStorage) throw new TypeError('safeStorage is required')
    this.directory = path.resolve(options.directory)
    this.safeStorage = options.safeStorage
    this.fs = options.fs || fs
    this.session = new Map()
    this.cleanupPendingFiles()
  }

  file (slotId, generation) {
    if (!SLOT_PATTERN.test(slotId) || !GENERATION_PATTERN.test(generation)) throw new TypeError('vault identity is invalid')
    return path.join(this.directory, `${slotId}.${generation}.bin`)
  }

  journalFile () { return path.join(this.directory, JOURNAL_NAME) }

  quarantineFile (slotId, generation, operationId) {
    if (!OPERATION_PATTERN.test(operationId)) throw new TypeError('vault operation identity is invalid')
    return path.join(this.directory, `${slotId}.${generation}.quarantine.${operationId}`)
  }

  cleanupPendingFiles () {
    if (!this.fs.existsSync(this.directory)) return
    for (const name of this.fs.readdirSync(this.directory)) {
      if (name.endsWith('.pending')) {
        try { this.fs.rmSync(path.join(this.directory, name), { force: true }) } catch {}
      }
    }
  }

  writeJournal (record) {
    this.fs.mkdirSync(this.directory, { recursive: true })
    const target = this.journalFile()
    if (this.fs.existsSync(target)) throw new Error('credential transaction already active')
    const temporary = `${target}.pending`
    try {
      this.fs.writeFileSync(temporary, JSON.stringify({ version: 1, ...record }), { flag: 'wx' })
      this.fs.renameSync(temporary, target)
    } catch (error) {
      try { this.fs.rmSync(temporary, { force: true }) } catch {}
      throw error
    }
  }

  readJournal () {
    const target = this.journalFile()
    if (!this.fs.existsSync(target)) return null
    const value = JSON.parse(this.fs.readFileSync(target, 'utf8'))
    if (value?.version !== 1 || !['set', 'clear'].includes(value.operation) ||
        !SLOT_PATTERN.test(value.slotId) || !OPERATION_PATTERN.test(value.operationId)) {
      throw new Error('credential recovery journal is invalid')
    }
    for (const key of ['oldGeneration', 'newGeneration']) {
      if (value[key] !== null && value[key] !== undefined && !GENERATION_PATTERN.test(value[key])) {
        throw new Error('credential recovery generation is invalid')
      }
    }
    return value
  }

  clearJournal () { this.fs.rmSync(this.journalFile(), { force: true }) }

  prepareSet (slotId, credential, previous = { persistence: 'absent', generation: null }) {
    if (!SLOT_PATTERN.test(slotId)) throw new TypeError('vault identity is invalid')
    if (typeof credential !== 'string' || credential !== credential.trim() || credential.length === 0 || Buffer.byteLength(credential) > 4096) {
      throw new TypeError('credential is invalid')
    }
    const snapshot = this.snapshot(slotId, previous.persistence, previous.generation)
    if (this.safeStorage.isEncryptionAvailable() !== true) {
      this.clearSession(slotId)
      this.session.set(slotId, Buffer.from(credential, 'utf8'))
      return { kind: 'session', slotId, snapshot, state: Object.freeze({ scope: 'session_only', generation: null }) }
    }

    const generation = `generation.${crypto.randomBytes(16).toString('hex')}`
    const operationId = `operation.${crypto.randomBytes(16).toString('hex')}`
    const target = this.file(slotId, generation)
    const temporary = `${target}.pending`
    this.fs.mkdirSync(this.directory, { recursive: true })
    const encrypted = this.safeStorage.encryptString(credential)
    if (!Buffer.isBuffer(encrypted) || encrypted.length === 0) throw new Error('credential encryption failed')
    try {
      this.fs.writeFileSync(temporary, encrypted, { flag: 'wx' })
      this.fs.renameSync(temporary, target)
      this.writeJournal({ operation: 'set', operationId, slotId, oldGeneration: previous.generation || null, newGeneration: generation, phase: 'prepared' })
    } catch (error) {
      try { this.fs.rmSync(temporary, { force: true }) } catch {}
      try { this.fs.rmSync(target, { force: true }) } catch {}
      throw error
    }
    return { kind: 'persistent', slotId, snapshot, operationId, state: Object.freeze({ scope: 'persistent', generation }) }
  }

  commitSet (token) {
    if (!token) return
    if (token.kind === 'session') {
      this.releaseSnapshot(token.snapshot)
      return
    }
    let cleaned = true
    try {
      const oldGeneration = token.snapshot?.scope === 'persistent' ? token.snapshot.generation : null
      if (oldGeneration && oldGeneration !== token.state.generation) this.fs.rmSync(this.file(token.slotId, oldGeneration), { force: true })
      this.clearSession(token.slotId)
    } catch { cleaned = false }
    this.releaseSnapshot(token.snapshot)
    if (cleaned) {
      try { this.clearJournal() } catch { /* recovery finishes committed cleanup */ }
    }
  }

  rollbackSet (token) {
    if (!token) return
    if (token.kind === 'persistent') this.fs.rmSync(this.file(token.slotId, token.state.generation), { force: true })
    this.clearSession(token.slotId)
    if (token.snapshot?.scope === 'session_only') this.session.set(token.slotId, Buffer.from(token.snapshot.value))
    this.releaseSnapshot(token.snapshot)
    if (token.kind === 'persistent') this.clearJournal()
  }

  set (slotId, credential) {
    const token = this.prepareSet(slotId, credential)
    this.commitSet(token)
    return token.state
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

  releaseSnapshot (snapshot) {
    if (Buffer.isBuffer(snapshot?.value)) snapshot.value.fill(0)
  }

  prepareClear (slotId, persistence, generation) {
    const snapshot = this.snapshot(slotId, persistence, generation)
    const token = { kind: snapshot.scope, slotId, snapshot, quarantine: null, operationId: null }
    this.clearSession(slotId)
    if (snapshot.scope === 'persistent') {
      const operationId = `operation.${crypto.randomBytes(16).toString('hex')}`
      const source = this.file(slotId, snapshot.generation)
      const quarantine = this.quarantineFile(slotId, snapshot.generation, operationId)
      this.writeJournal({ operation: 'clear', operationId, slotId, oldGeneration: snapshot.generation, newGeneration: null, phase: 'prepared' })
      try { this.fs.renameSync(source, quarantine) } catch (error) { this.clearJournal(); throw error }
      token.operationId = operationId
      token.quarantine = quarantine
    }
    return token
  }

  commitClear (token) {
    if (!token) return
    let cleaned = true
    if (token.quarantine) {
      try { this.fs.rmSync(token.quarantine, { force: true }) } catch { cleaned = false }
    }
    this.releaseSnapshot(token.snapshot)
    if (token.kind === 'persistent' && cleaned) {
      try { this.clearJournal() } catch { /* recovery finishes committed cleanup */ }
    }
  }

  rollbackClear (token) {
    if (!token) return
    if (token.quarantine && this.fs.existsSync(token.quarantine)) {
      this.fs.renameSync(token.quarantine, this.file(token.slotId, token.snapshot.generation))
    } else if (token.snapshot?.scope === 'session_only') {
      this.session.set(token.slotId, Buffer.from(token.snapshot.value))
    }
    this.releaseSnapshot(token.snapshot)
    if (token.kind === 'persistent') this.clearJournal()
  }

  recover (profiles = []) {
    const committed = new Map()
    for (const profile of profiles) {
      if (SLOT_PATTERN.test(profile?.credential_slot_id) && profile.credential_persistence === 'persistent' && GENERATION_PATTERN.test(profile.credential_generation)) {
        committed.set(profile.credential_slot_id, profile.credential_generation)
      }
    }
    const journal = this.readJournal()
    if (journal) {
      const committedGeneration = committed.get(journal.slotId) || null
      if (journal.operation === 'set') {
        const discarded = committedGeneration === journal.newGeneration ? journal.oldGeneration : journal.newGeneration
        if (discarded) this.fs.rmSync(this.file(journal.slotId, discarded), { force: true })
      } else {
        const source = this.file(journal.slotId, journal.oldGeneration)
        const quarantine = this.quarantineFile(journal.slotId, journal.oldGeneration, journal.operationId)
        if (committedGeneration === journal.oldGeneration) {
          if (this.fs.existsSync(quarantine) && !this.fs.existsSync(source)) this.fs.renameSync(quarantine, source)
          else this.fs.rmSync(quarantine, { force: true })
        } else {
          this.fs.rmSync(source, { force: true })
          this.fs.rmSync(quarantine, { force: true })
        }
      }
      this.clearJournal()
    }
    if (!this.fs.existsSync(this.directory)) return
    for (const name of this.fs.readdirSync(this.directory)) {
      const match = /^(slot\.[a-f0-9]{32})\.(generation\.[a-f0-9]{32})\.bin$/.exec(name)
      if (match && committed.get(match[1]) !== match[2]) this.fs.rmSync(path.join(this.directory, name), { force: true })
      const quarantined = /^(slot\.[a-f0-9]{32})\.(generation\.[a-f0-9]{32})\.quarantine\.(operation\.[a-f0-9]{32})$/.exec(name)
      if (quarantined) {
        const source = this.file(quarantined[1], quarantined[2])
        if (committed.get(quarantined[1]) === quarantined[2] && !this.fs.existsSync(source)) this.fs.renameSync(path.join(this.directory, name), source)
        else this.fs.rmSync(path.join(this.directory, name), { force: true })
      }
    }
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
