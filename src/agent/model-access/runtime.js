'use strict'

const { assertConfigureCommand, assertRunRequest } = require('../contracts/model-access-core')
const { publicCatalog } = require('./catalog')
const { OpenAiCompatibleAdapter } = require('./openai-compatible-adapter')
const { publicPresetCatalog, strategyForModel, REQUEST_STRATEGIES } = require('./preset-registry')

function freezeBinding (binding) {
  const snapshot = { ...binding }
  for (const key of ['capabilities', 'budget']) {
    if (snapshot[key] && typeof snapshot[key] === 'object' && !Array.isArray(snapshot[key])) {
      snapshot[key] = Object.freeze({ ...snapshot[key] })
    }
  }
  return Object.freeze(snapshot)
}

class ModelAccessRuntime {
  constructor (options = {}) {
    if (!options.gateway || !options.vault) throw new TypeError('gateway and vault are required')
    this.gateway = options.gateway
    this.vault = options.vault
    this.adapter = options.adapter || new OpenAiCompatibleAdapter()
    if (!this.adapter || typeof this.adapter.run !== 'function') throw new TypeError('model loop adapter is required')
    this.onChanged = typeof options.onChanged === 'function' ? options.onChanged : () => {}
    this.tail = Promise.resolve()
    this.testControllers = new Map()
    this.testTerminals = new Set()
    this.testTerminalOrder = []
    this.maxTestTerminalIds = 256
  }

  rememberTestTerminal (testId) {
    if (this.testTerminals.has(testId)) return
    this.testTerminals.add(testId)
    this.testTerminalOrder.push(testId)
    while (this.testTerminalOrder.length > this.maxTestTerminalIds) this.testTerminals.delete(this.testTerminalOrder.shift())
  }

  serial (operation) {
    const next = this.tail.then(operation, operation)
    this.tail = next.catch(() => {})
    return next
  }

  async internal () { return this.gateway.modelAccessCatalog() }

  async settleUnknownCredentialWrite (command, token, operation) {
    let internal
    try { internal = await this.internal() } catch { return null }
    const profile = internal.profiles.find((item) => item.profile_id === command.profileId)
    const committed = operation === 'set'
      ? Boolean(profile && profile.credential_persistence === token.state.scope &&
          profile.credential_generation === token.state.generation)
      : command.type === 'deleteProfile'
        ? !profile
        : Boolean(profile && profile.credential_persistence === 'absent' && profile.credential_generation === null)
    if (committed) {
      if (operation === 'set') this.vault.commitSet(token)
      else this.vault.commitClear(token)
      return { revision: internal.revision }
    }
    if (operation === 'set') this.vault.rollbackSet(token)
    else this.vault.rollbackClear(token)
    return false
  }

  async initialize () {
    const internal = await this.internal()
    this.vault.recover(internal.profiles)
    return this
  }

  async catalog () {
    try { return { ok: true, snapshot: publicCatalog(await this.internal(), this.vault), error: null } } catch {
      return { ok: false, snapshot: null, error: { code: 'MODEL_ACCESS_UNAVAILABLE' } }
    }
  }

  async presetCatalog () { return publicPresetCatalog() }

  async testSavedModel (request) {
    const testId = request?.testId
    const resultFor = (status) => ({ ok: status === 'success', status, nextAction: status === 'revision_conflict' ? 'reload' : status === 'credential_unavailable' || status === 'auth_failed' ? 'set_credential' : status === 'response_invalid' ? 'check_model' : status === 'cancelled' ? 'none' : status === 'success' ? 'none' : status === 'invalid_request' || status === 'redirect_rejected' ? 'edit_connection' : 'retry' })
    if (typeof testId !== 'string' || this.testTerminals.has(testId) || this.testControllers.has(testId)) return resultFor('invalid_request')
    const controller = new AbortController()
    const record = { controller, state: 'pending' }
    this.testControllers.set(testId, record)
    const finish = (status) => {
      this.rememberTestTerminal(testId)
      return resultFor(status)
    }
    let internal
    try { internal = await this.internal() } catch {
      this.testControllers.delete(testId)
      return finish(record.state === 'pending' ? 'remote_unavailable' : 'cancelled')
    }
    if (record.state !== 'pending') { this.testControllers.delete(testId); return finish('cancelled') }
    if (request.expectedRevision !== internal.revision) { this.testControllers.delete(testId); return finish('revision_conflict') }
    const profile = internal.profiles.find((item) => item?.profile_id === request.profileId)
    const model = profile?.models?.find((item) => item.modelId === request.modelId)
    if (!profile || !model) { this.testControllers.delete(testId); return finish('invalid_request') }
    let state
    try { state = this.vault.state(profile.credential_slot_id, profile.credential_persistence, profile.credential_generation) } catch {
      this.testControllers.delete(testId)
      return finish(record.state === 'pending' ? 'remote_unavailable' : 'cancelled')
    }
    if (!state.present) { this.testControllers.delete(testId); return finish('credential_unavailable') }
    try {
      const capabilities = { ...model.capabilities, maxOutputTokens: Math.min(model.capabilities.maxOutputTokens, 256) }
      const requestStrategy = model.request_strategy || strategyForModel({ profileId: profile.profile_id, httpsOrigin: profile.https_origin, basePath: profile.base_path, modelId: model.modelId })
      if (!REQUEST_STRATEGIES.includes(requestStrategy)) return finish('invalid_request')
      await this.vault.borrow(profile.credential_slot_id, profile.credential_persistence, profile.credential_generation,
        (credential) => this.adapter.run({
          connection: { httpsOrigin: profile.https_origin, basePath: profile.base_path },
          credential,
          resolvedModel: { modelId: model.modelId, capabilities },
          requestStrategy,
          systemPrompt: 'Return a short JSON object confirming that this model endpoint is reachable.',
          prompt: 'Reply with a JSON object containing only {"ok":true}.',
          maxTurns: 1,
          timeoutMs: 30 * 1000,
          signal: controller.signal,
          testMode: true
        }))
      if (record.state !== 'pending') return finish('cancelled')
      let latest
      try { latest = await this.internal() } catch { return finish(record.state === 'pending' ? 'remote_unavailable' : 'cancelled') }
      if (record.state !== 'pending') return finish('cancelled')
      if (latest.revision !== request.expectedRevision) return finish('revision_conflict')
      record.state = 'success'
      return finish('success')
    } catch (error) {
      if (record.state !== 'pending' || controller.signal.aborted || error?.code === 'AGENT_CANCELLED') return finish('cancelled')
      const status = error?.code === 'AGENT_REQUEST_INVALID' ? 'invalid_request'
        : error?.code === 'AGENT_CREDENTIAL_UNAVAILABLE' ? 'credential_unavailable'
          : error?.code === 'AGENT_OUTPUT_INVALID' ? 'response_invalid'
            : error?.code === 'AGENT_PROVIDER_AUTH_FAILED' || error?.code === 'AUTH_REJECTED' ? 'auth_failed'
              : error?.code === 'AGENT_PROVIDER_TIMEOUT' ? 'timeout'
                : error?.code === 'AGENT_PROVIDER_RATE_LIMITED' ? 'rate_limited'
                  : error?.code === 'REDIRECT_REJECTED' ? 'redirect_rejected' : 'remote_unavailable'
      return finish(status)
    } finally { if (this.testControllers.get(testId) === record) this.testControllers.delete(testId) }
  }

  async cancelSavedModel (testId) {
    const record = this.testControllers.get(testId)
    if (record && record.state === 'pending') {
      record.state = 'cancelled'
      this.rememberTestTerminal(testId)
      record.controller.abort()
    }
    return { ok: false, status: 'cancelled', nextAction: 'none' }
  }

  cancelAllModelTests () {
    for (const [testId, record] of this.testControllers) {
      if (record.state === 'pending') {
        record.state = 'cancelled'
        this.rememberTestTerminal(testId)
        try { record.controller.abort() } catch {}
      }
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
          if (command.expectedRevision !== internal.revision) return this.failure('MODEL_CONFIG_REVISION_CONFLICT')
          const profile = internal.profiles.find((item) => item.profile_id === command.profileId)
          if (!profile) return this.failure('MODEL_CONFIG_INVALID')
          let setToken = null
          try {
            setToken = this.vault.prepareSet(profile.credential_slot_id, command.credential, {
              persistence: profile.credential_persistence,
              generation: profile.credential_generation
            })
            result = await this.gateway.modelAccessConfigure({
              command: { type: command.type, expectedRevision: command.expectedRevision, profileId: command.profileId },
              credentialState: setToken.state
            })
            this.vault.commitSet(setToken)
          } catch (error) {
            const settled = await this.settleUnknownCredentialWrite(command, setToken, 'set')
            if (settled) result = settled
            else if (settled === false) throw error
            else throw error
          }
        } else {
          const internal = ['clearCredential', 'deleteProfile'].includes(command.type) ? await this.internal() : null
          if (internal && command.expectedRevision !== internal.revision) return this.failure('MODEL_CONFIG_REVISION_CONFLICT')
          const profile = internal?.profiles.find((item) => item.profile_id === command.profileId)
          let clearToken = null
          if (profile) clearToken = this.vault.prepareClear(
            profile.credential_slot_id, profile.credential_persistence, profile.credential_generation
          )
          try {
            result = await this.gateway.modelAccessConfigure({ command })
            this.vault.commitClear(clearToken)
          } catch (error) {
            const settled = await this.settleUnknownCredentialWrite(command, clearToken, 'clear')
            if (settled) result = settled
            else if (settled === false) throw error
            else throw error
          }
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
      const internal = await this.internal()
      const availableSlotIds = internal.profiles.filter((profile) => this.vault.state(
        profile.credential_slot_id, profile.credential_persistence, profile.credential_generation
      ).present).map((profile) => profile.credential_slot_id)
      return await this.gateway.modelAccessBind(runRequest, availableSlotIds)
    } catch (error) {
      const wrapped = new Error('Agent request is invalid')
      wrapped.code = error?.code === 'AGENT_PROVIDER_AUTH_FAILED' ? error.code : 'AGENT_REQUEST_INVALID'
      throw wrapped
    }
  }

  async runWithBinding (binding, request = {}) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
        typeof binding.profileId !== 'string' || typeof binding.credentialSlotId !== 'string' ||
        typeof binding.httpsOrigin !== 'string' || typeof binding.basePath !== 'string' ||
        typeof binding.modelId !== 'string') {
      const error = new Error('Agent request is invalid')
      error.code = 'AGENT_REQUEST_INVALID'
      throw error
    }
    const internal = await this.internal()
    const profile = internal.profiles.find((item) => item?.profile_id === binding.profileId)
    if (!profile) throw this.vault.bindingAuthFailure()
    const safeRequest = request && typeof request === 'object' && !Array.isArray(request)
      ? { ...request }
      : {}
    delete safeRequest.connection
    delete safeRequest.credential
    const requestStrategy = binding.requestStrategy || strategyForModel({ profileId: binding.profileId, httpsOrigin: binding.httpsOrigin, basePath: binding.basePath, modelId: binding.modelId })
    if (!REQUEST_STRATEGIES.includes(requestStrategy)) {
      const error = new Error('Agent request is invalid')
      error.code = 'AGENT_REQUEST_INVALID'
      throw error
    }
    const resolvedModel = { ...binding }
    delete resolvedModel.requestStrategy
    return this.vault.borrowForBinding(binding, internal.profiles, async (credential) => {
      try {
        return await this.adapter.run({
          ...safeRequest,
          connection: { httpsOrigin: binding.httpsOrigin, basePath: binding.basePath },
          credential,
          requestStrategy,
          resolvedModel: Object.freeze(resolvedModel)
        })
      } catch (error) {
        if (error?.code === 'AGENT_PROVIDER_AUTH_FAILED' || error?.code === 'AUTH_REJECTED') {
          try {
            await this.invalidateCredential(binding.profileId, {
              credentialSlotId: binding.credentialSlotId,
              profileRevision: binding.profileRevision
            })
          } catch {}
        }
        throw error
      }
    })
  }

  createLoopAdapter (binding) {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw new TypeError('binding is required')
    const frozenBinding = freezeBinding(binding)
    return Object.freeze({ run: (request) => this.runWithBinding(frozenBinding, request) })
  }

  invalidateCredential (profileId, guard = null) {
    return this.serial(async () => {
      try {
        const internal = await this.internal()
        const profile = internal.profiles.find((item) => item.profile_id === profileId)
        if (!profile) return false
        if (guard?.credentialSlotId && profile.credential_slot_id !== guard.credentialSlotId) return false
        if (Number.isSafeInteger(guard?.profileRevision) && profile.profile_revision !== guard.profileRevision) return false
        const clearToken = this.vault.prepareClear(
          profile.credential_slot_id, profile.credential_persistence, profile.credential_generation
        )
        let result
        try {
          result = await this.gateway.modelAccessConfigure({
            command: { type: 'clearCredential', expectedRevision: internal.revision, profileId }
          })
          this.vault.commitClear(clearToken)
        } catch (error) {
          const command = { type: 'clearCredential', expectedRevision: internal.revision, profileId }
          const settled = await this.settleUnknownCredentialWrite(command, clearToken, 'clear')
          if (settled) result = settled
          else if (settled === false) throw error
          else throw error
        }
        try { this.onChanged({ revision: result.revision }) } catch {}
        return true
      } catch { return false }
    })
  }

  failure (code) {
    return { ok: false, revision: null, error: { code, nextAction: code === 'MODEL_CONFIG_REVISION_CONFLICT' ? 'reload' : 'correct_input' } }
  }

  close () { this.cancelAllModelTests(); this.vault.close() }
}

module.exports = { ModelAccessRuntime }
