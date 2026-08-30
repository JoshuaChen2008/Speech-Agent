'use strict'

const { MODEL_PURPOSES } = require('../contracts/model-access-core')
const { providerKindForOrigin } = require('./connection')

const DEEPSEEK_TEMPLATE_SUGGESTION = Object.freeze({
  templateVersion: 1,
  source: 'official_docs',
  sourceSnapshotDate: '2026-08-30',
  modelId: 'deepseek-v4-flash',
  capabilitySuggestion: Object.freeze({
    maxInputTokens: null,
    maxOutputTokens: null,
    supportsToolCalling: true,
    supportsStructuredOutput: true,
    supportsStreaming: true,
    usageReporting: true
  })
})

function publicCatalog (internal, vault) {
  const profiles = internal.profiles.map((profile) => ({
    profileId: profile.profile_id,
    label: profile.label,
    profileRevision: Number(profile.profile_revision),
    catalogRevision: Number(profile.catalog_revision),
    httpsOrigin: profile.https_origin,
    basePath: profile.base_path,
    templateId: profile.template_id,
    templateSuggestion: profile.template_id === 'deepseek-openai-template@1' ? DEEPSEEK_TEMPLATE_SUGGESTION : null,
    models: profile.models,
    credential: vault.state(profile.credential_slot_id, profile.credential_persistence, profile.credential_generation)
  }))
  const byId = new Map(internal.profiles.map((profile) => [profile.profile_id, profile]))
  const readinessByPurpose = {}
  for (const purpose of MODEL_PURPOSES) {
    const direct = internal.assignments[purpose]
    const selected = direct.profile_id ? direct : purpose === 'default' ? null : internal.assignments.default
    const assignmentMode = selected?.profile_id ? (direct.profile_id ? 'direct' : 'fallback_default') : 'unconfigured'
    const profile = selected?.profile_id ? byId.get(selected.profile_id) : null
    const model = profile?.models.find((item) => item.modelId === selected.model_id) || null
    const credential = profile ? vault.state(profile.credential_slot_id, profile.credential_persistence, profile.credential_generation) : { present: false, scope: 'absent' }
    const configured = !!profile && !!model
    const base = !configured ? 'provider_not_configured' : !credential.present ? 'credential_unavailable' : 'ready'
    readinessByPurpose[purpose] = {
      assignmentMode,
      providerKind: profile ? providerKindForOrigin(profile.https_origin) : null,
      target: configured ? { profileId: profile.profile_id, modelId: model.modelId } : null,
      singleShot: base,
      agentLoop: base === 'ready' && model.capabilities.supportsToolCalling !== true ? 'provider_not_configured' : base
    }
  }
  return Object.freeze({ revision: internal.revision, profiles, readinessByPurpose })
}

module.exports = { DEEPSEEK_TEMPLATE_SUGGESTION, publicCatalog }
