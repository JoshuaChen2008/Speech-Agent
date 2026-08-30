'use strict'

const { assertConfigureCommand, assertRunRequest } = require('../contracts/model-access-core')
const { publicCatalog } = require('./catalog')

class ModelAccessRuntime {
  constructor (options = {}) {
    if (!options.gateway || !options.vault) throw new TypeError('gateway and vault are required')
    this.gateway = options.gateway
    this.vault = options.vault
    this.onChanged = typeof options.onChanged === 'function' ? options.onChanged : () => {}
    this.tail = Promise.resolve()
  }

  serial (operation) {
    const next = this.tail.then(operation, operation)
    this.tail = next.catch(() => {})
    return next
  }

  async internal () { return this.gateway.modelAccessCatalog() }

  async catalog () {
    try { return { ok: true, snapshot: publicCatalog(await this.internal(), this.vault), error: null } } catch {
      return { ok: false, snapshot: null, error: { code: 'MODEL_ACCESS_UNAVAILABLE' } }
    }
  }

  configure (rawCommand) {
    return this.serial(async () => {
      let command
      try { command = assertConfigureCommand(rawCommand) } catch { return this.failure('MODEL_CONFIG_INVALID') }
      try {
        let result
        if (command.type === 'setCredential') {
          const internal = await this.internal()
          const profile = internal.profiles.find((item) => item.profile_id === command.profileId)
          if (!profile) return this.failure('MODEL_CONFIG_INVALID')
          const previous = this.vault.snapshot(profile.credential_slot_id, profile.credential_persistence, profile.credential_generation)
          let state
          try {
            state = this.vault.set(profile.credential_slot_id, command.credential)
            result = await this.gateway.modelAccessConfigure({
              command: { type: command.type, expectedRevision: command.expectedRevision, profileId: command.profileId },
              credentialState: state
            })
          } catch (error) {
            this.vault.restore(profile.credential_slot_id, previous)
            throw error
          }
        } else {
          const internal = ['clearCredential', 'deleteProfile'].includes(command.type) ? await this.internal() : null
          const profile = internal?.profiles.find((item) => item.profile_id === command.profileId)
          result = await this.gateway.modelAccessConfigure({ command })
          if (result.retiredSlotId) this.vault.clear(result.retiredSlotId)
          else if (profile && command.type === 'deleteProfile') this.vault.clear(profile.credential_slot_id)
        }
        try { this.onChanged({ revision: result.revision }) } catch {}
        return { ok: true, revision: result.revision, error: null }
      } catch (error) {
        return this.failure(error?.code === 'MODEL_CONFIG_REVISION_CONFLICT' ? error.code : 'MODEL_CONFIG_INVALID')
      }
    })
  }

  async bind (runRequest) {
    try {
      assertRunRequest(runRequest)
      return await this.gateway.modelAccessBind(runRequest, this.vault.sessionSlotIds())
    } catch (error) {
      const wrapped = new Error('Agent request is invalid')
      wrapped.code = error?.code === 'AGENT_PROVIDER_AUTH_FAILED' ? error.code : 'AGENT_REQUEST_INVALID'
      throw wrapped
    }
  }

  failure (code) {
    return { ok: false, revision: null, error: { code, nextAction: code === 'MODEL_CONFIG_REVISION_CONFLICT' ? 'reload' : 'correct_input' } }
  }

  close () { this.vault.close() }
}

module.exports = { ModelAccessRuntime }
