'use strict'

const crypto = require('node:crypto')
const { canonicalize } = require('./canonical-json')
const { rollbackQuietly } = require('./sqlite-store')
const {
  MODEL_PURPOSES,
  assertCapabilities,
  assertConfigureCommand,
  assertRunRequest
} = require('../../agent/contracts/model-access-core')
const { deriveBudget } = require('../../agent/contracts/budget-axes')
const { canonicalizeConnection, providerKindForOrigin } = require('../../agent/model-access/connection')

class ModelAccessStoreError extends Error {
  constructor (code) {
    super(code)
    this.name = 'ModelAccessStoreError'
    this.code = code
  }
}

function fail (code = 'MODEL_CONFIG_INVALID') { throw new ModelAccessStoreError(code) }
function slotId () { return `slot.${crypto.randomBytes(16).toString('hex')}` }

class ModelAccessStore {
  constructor (options = {}) {
    if (!options.subtitleStore?.database) throw new TypeError('subtitleStore is required')
    this.database = options.subtitleStore.database
    this.now = typeof options.now === 'function' ? options.now : () => Date.now()
  }

  revision () {
    const rows = this.database.prepare('SELECT configuration_revision FROM agent_model_purpose_assignments').all()
    if (rows.length !== 4 || new Set(rows.map((row) => Number(row.configuration_revision))).size !== 1) fail()
    return Number(rows[0].configuration_revision)
  }

  internalCatalog () {
    const profiles = this.database.prepare('SELECT * FROM agent_model_profiles ORDER BY profile_id').all().map((profile) => ({
      ...profile,
      models: this.database.prepare('SELECT model_id, capability_json FROM agent_model_profile_models WHERE profile_id = ? ORDER BY model_id').all(profile.profile_id).map((model) => ({
        modelId: model.model_id,
        capabilities: JSON.parse(model.capability_json)
      }))
    }))
    const assignments = Object.fromEntries(this.database.prepare('SELECT * FROM agent_model_purpose_assignments').all().map((row) => [row.purpose, row]))
    return { revision: this.revision(), profiles, assignments }
  }

  configure (input) {
    const rawCommand = input.command
    const command = rawCommand?.type === 'setCredential' && !Object.hasOwn(rawCommand, 'credential')
      ? (() => {
          if (!rawCommand || Object.keys(rawCommand).sort().join(',') !== 'expectedRevision,profileId,type' ||
              rawCommand.type !== 'setCredential') fail()
          assertConfigureCommand({ ...rawCommand, credential: 'main-owned-redacted' })
          return rawCommand
        })()
      : assertConfigureCommand(rawCommand)
    const current = this.revision()
    if (command.expectedRevision !== current) fail('MODEL_CONFIG_REVISION_CONFLICT')
    const now = this.now()
    if (!Number.isSafeInteger(now) || now < 0) fail()
    this.database.exec('BEGIN IMMEDIATE')
    try {
      let result = null
      const profile = command.profileId ? this.database.prepare('SELECT * FROM agent_model_profiles WHERE profile_id = ?').get(command.profileId) : null
      if (command.type === 'createProfile') {
        if (profile) fail()
        const connection = canonicalizeConnection(command.httpsOrigin, command.basePath)
        const newSlot = slotId()
        this.database.prepare(`INSERT INTO agent_model_profiles(
          profile_id, profile_revision, label, template_id, adapter_id, api_style, https_origin,
          base_path, catalog_revision, credential_slot_id, credential_generation,
          credential_persistence, created_at, updated_at
        ) VALUES (?, 1, ?, NULL, 'openai-compatible', 'chat-completions', ?, ?, 0, ?, NULL, 'absent', ?, ?)`)
          .run(command.profileId, command.label, connection.httpsOrigin, connection.basePath, newSlot, now, now)
        result = { slotId: newSlot }
      } else if (command.type === 'updateProfile') {
        if (!profile) fail()
        const connection = canonicalizeConnection(command.httpsOrigin, command.basePath)
        this.database.prepare(`UPDATE agent_model_profiles SET label=?, https_origin=?, base_path=?,
          profile_revision=profile_revision+1, updated_at=? WHERE profile_id=?`)
          .run(command.label, connection.httpsOrigin, connection.basePath, now, command.profileId)
      } else if (command.type === 'deleteProfile') {
        if (!profile) fail()
        this.database.prepare('UPDATE agent_model_purpose_assignments SET profile_id=NULL, model_id=NULL, assigned_profile_revision=NULL, updated_at=? WHERE profile_id=?').run(now, command.profileId)
        this.database.prepare('DELETE FROM agent_model_profiles WHERE profile_id=?').run(command.profileId)
        result = { retiredSlotId: profile.credential_slot_id }
      } else if (['addModel', 'updateModel'].includes(command.type)) {
        if (!profile) fail()
        const encoded = canonicalize(assertCapabilities(command.capabilities))
        const existing = this.database.prepare('SELECT 1 FROM agent_model_profile_models WHERE profile_id=? AND model_id=?').get(command.profileId, command.modelId)
        if ((command.type === 'addModel') === !!existing) fail()
        if (command.type === 'addModel') this.database.prepare('INSERT INTO agent_model_profile_models(profile_id,model_id,capability_json,created_at,updated_at) VALUES(?,?,?,?,?)').run(command.profileId, command.modelId, encoded, now, now)
        else this.database.prepare('UPDATE agent_model_profile_models SET capability_json=?,updated_at=? WHERE profile_id=? AND model_id=?').run(encoded, now, command.profileId, command.modelId)
        this.database.prepare('UPDATE agent_model_profiles SET profile_revision=profile_revision+1,catalog_revision=catalog_revision+1,updated_at=? WHERE profile_id=?').run(now, command.profileId)
      } else if (command.type === 'removeModel') {
        if (!profile || !this.database.prepare('SELECT 1 FROM agent_model_profile_models WHERE profile_id=? AND model_id=?').get(command.profileId, command.modelId)) fail()
        this.database.prepare('UPDATE agent_model_purpose_assignments SET profile_id=NULL,model_id=NULL,assigned_profile_revision=NULL,updated_at=? WHERE profile_id=? AND model_id=?').run(now, command.profileId, command.modelId)
        this.database.prepare('DELETE FROM agent_model_profile_models WHERE profile_id=? AND model_id=?').run(command.profileId, command.modelId)
        this.database.prepare('UPDATE agent_model_profiles SET profile_revision=profile_revision+1,catalog_revision=catalog_revision+1,updated_at=? WHERE profile_id=?').run(now, command.profileId)
      } else if (command.type === 'setCredential') {
        if (!profile || !input.credentialState || !['persistent', 'session_only'].includes(input.credentialState.scope)) fail()
        const generation = input.credentialState.scope === 'persistent' ? input.credentialState.generation : null
        this.database.prepare(`UPDATE agent_model_profiles SET profile_revision=profile_revision+1,
          credential_generation=?,credential_persistence=?,updated_at=? WHERE profile_id=?`)
          .run(generation, input.credentialState.scope === 'persistent' ? 'persistent' : 'absent', now, command.profileId)
      } else if (command.type === 'clearCredential') {
        if (!profile) fail()
        const newSlot = slotId()
        this.database.prepare(`UPDATE agent_model_profiles SET profile_revision=profile_revision+1,
          credential_slot_id=?,credential_generation=NULL,credential_persistence='absent',updated_at=? WHERE profile_id=?`)
          .run(newSlot, now, command.profileId)
        result = { retiredSlotId: profile.credential_slot_id, slotId: newSlot }
      } else if (command.type === 'assignPurpose') {
        if (command.target) {
          const target = this.database.prepare(`SELECT profile_revision FROM agent_model_profiles p
            JOIN agent_model_profile_models m ON m.profile_id=p.profile_id
            WHERE p.profile_id=? AND m.model_id=?`).get(command.target.profileId, command.target.modelId)
          if (!target) fail()
          this.database.prepare(`UPDATE agent_model_purpose_assignments SET profile_id=?,model_id=?,
            assigned_profile_revision=?,updated_at=? WHERE purpose=?`)
            .run(command.target.profileId, command.target.modelId, target.profile_revision, now, command.purpose)
        } else this.database.prepare('UPDATE agent_model_purpose_assignments SET profile_id=NULL,model_id=NULL,assigned_profile_revision=NULL,updated_at=? WHERE purpose=?').run(now, command.purpose)
      }
      this.database.prepare('UPDATE agent_model_purpose_assignments SET configuration_revision=?,updated_at=?').run(current + 1, now)
      this.database.exec('COMMIT')
      return { revision: current + 1, ...result }
    } catch (error) {
      rollbackQuietly(this.database)
      if (error instanceof ModelAccessStoreError) throw error
      fail()
    }
  }

  resolveAssignment (purpose) {
    const assignments = this.internalCatalog().assignments
    const direct = assignments[purpose]
    const selected = direct.profile_id ? direct : purpose === 'default' ? null : assignments.default
    if (!selected?.profile_id) return { assignmentMode: 'unconfigured', purpose, profile: null, model: null }
    const profile = this.database.prepare('SELECT * FROM agent_model_profiles WHERE profile_id=?').get(selected.profile_id)
    const model = this.database.prepare('SELECT * FROM agent_model_profile_models WHERE profile_id=? AND model_id=?').get(selected.profile_id, selected.model_id)
    if (!profile || !model) return { assignmentMode: 'unconfigured', purpose, profile: null, model: null }
    return { assignmentMode: direct.profile_id ? 'direct' : 'fallback_default', purpose, profile, model }
  }

  bind (request, availableSlotIds = []) {
    assertRunRequest(request)
    this.database.exec('BEGIN IMMEDIATE')
    try {
      const existing = this.database.prepare('SELECT * FROM agent_model_run_bindings WHERE run_id=?').get(request.runId)
      if (existing) {
        const run = this.database.prepare('SELECT recipe_id,recipe_version FROM formal_agent_runs WHERE run_id=?').get(request.runId)
        if (!run || run.recipe_id !== request.recipeId || run.recipe_version !== request.recipeVersion || existing.execution_form !== request.executionForm) fail('AGENT_REQUEST_INVALID')
        this.database.exec('COMMIT')
        return this.bindingProjection(existing)
      }
      const run = this.database.prepare('SELECT recipe_id,recipe_version,requested_by FROM formal_agent_runs WHERE run_id=?').get(request.runId)
      if (!run || run.recipe_id !== request.recipeId || run.recipe_version !== request.recipeVersion || request.recipeId !== 'context.ingest.session' || request.recipeVersion !== '1') fail('AGENT_REQUEST_INVALID')
      const resolved = this.resolveAssignment('information_extraction')
      if (!resolved.profile || !resolved.model) fail('AGENT_REQUEST_INVALID')
      const capabilities = JSON.parse(resolved.model.capability_json)
      if (request.executionForm === 'agent_loop' && capabilities.supportsToolCalling !== true) fail('AGENT_REQUEST_INVALID')
      const credentialPresent = availableSlotIds.includes(resolved.profile.credential_slot_id)
      if (!credentialPresent) fail('AGENT_REQUEST_INVALID')
      const budget = deriveBudget(capabilities, request.executionForm, run.requested_by)
      const now = this.now()
      this.database.prepare(`INSERT INTO agent_model_run_bindings(
        run_id,execution_form,purpose,assignment_mode,profile_id,profile_revision,adapter_id,
        api_style,https_origin,base_path,model_id,capability_json,budget_json,provider_kind,
        credential_slot_id,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        request.runId, request.executionForm, resolved.purpose, resolved.assignmentMode,
        resolved.profile.profile_id, resolved.profile.profile_revision, resolved.profile.adapter_id,
        resolved.profile.api_style, resolved.profile.https_origin, resolved.profile.base_path,
        resolved.model.model_id, resolved.model.capability_json, canonicalize(budget),
        providerKindForOrigin(resolved.profile.https_origin), resolved.profile.credential_slot_id, now
      )
      const row = this.database.prepare('SELECT * FROM agent_model_run_bindings WHERE run_id=?').get(request.runId)
      this.database.exec('COMMIT')
      return this.bindingProjection(row)
    } catch (error) {
      rollbackQuietly(this.database)
      if (error instanceof ModelAccessStoreError) throw error
      fail('AGENT_REQUEST_INVALID')
    }
  }

  bindingProjection (row) {
    return Object.freeze({
      runId: row.run_id, executionForm: row.execution_form, purpose: row.purpose,
      assignmentMode: row.assignment_mode, profileId: row.profile_id,
      profileRevision: Number(row.profile_revision), adapterId: row.adapter_id,
      apiStyle: row.api_style, httpsOrigin: row.https_origin, basePath: row.base_path,
      modelId: row.model_id, capabilities: JSON.parse(row.capability_json),
      budget: JSON.parse(row.budget_json), providerKind: row.provider_kind,
      credentialSlotId: row.credential_slot_id, createdAt: Number(row.created_at)
    })
  }
}

module.exports = { ModelAccessStore, ModelAccessStoreError }
