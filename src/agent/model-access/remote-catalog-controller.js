'use strict'

const { DEEPSEEK_TEMPLATE_SUGGESTION } = require('./catalog')

class RemoteModelCatalogPullController {
  constructor (options = {}) {
    if (!options.runtime || !options.gateway || !options.vault || !options.adapter) throw new TypeError('runtime, gateway, vault and adapter are required')
    this.runtime = options.runtime
    this.gateway = options.gateway
    this.vault = options.vault
    this.adapter = options.adapter
  }

  async pull (request) {
    if (!request || Object.keys(request).sort().join(',') !== 'expectedRevision,profileId' ||
        !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 || typeof request.profileId !== 'string') {
      return this.result('invalid_request')
    }
    let internal
    try { internal = await this.gateway.modelAccessCatalog() } catch { return this.result('remote_unavailable') }
    if (request.expectedRevision !== internal.revision) return this.result('revision_conflict')
    const profile = internal.profiles.find((item) => item.profile_id === request.profileId)
    if (!profile) return this.result('invalid_request')
    const state = this.vault.state(profile.credential_slot_id, profile.credential_persistence, profile.credential_generation)
    if (!state.present) return this.result('credential_unavailable')
    try {
      const suggestions = await this.vault.borrow(
        profile.credential_slot_id, profile.credential_persistence, profile.credential_generation,
        (credential) => this.adapter.listModels({
          connection: { httpsOrigin: profile.https_origin, basePath: profile.base_path }, credential
        })
      )
      const merged = suggestions.map((suggestion) => profile.template_id === 'deepseek-openai-template@1' && suggestion.modelId === DEEPSEEK_TEMPLATE_SUGGESTION.modelId
        ? { ...suggestion, capabilitySuggestion: DEEPSEEK_TEMPLATE_SUGGESTION.capabilitySuggestion }
        : suggestion)
      return this.result('success', merged)
    } catch (error) {
      if (error?.code === 'REDIRECT_REJECTED') return this.result('redirect_rejected')
      if (error?.code === 'AUTH_REJECTED') {
        await this.runtime.configure({
          type: 'clearCredential',
          expectedRevision: internal.revision,
          profileId: profile.profile_id
        })
        return this.result('credential_unavailable')
      }
      return this.result('remote_unavailable')
    }
  }

  result (status, suggestions = []) { return Object.freeze({ status, suggestions }) }
}

module.exports = { RemoteModelCatalogPullController }
