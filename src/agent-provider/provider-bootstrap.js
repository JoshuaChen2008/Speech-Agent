'use strict'

const { AgentCoreError } = require('../agent-core/errors')

const CREDENTIAL_ENV_NAME = 'DEEPSEEK_API_KEY'
const CONFIGURATION_SOURCE = 'trusted_config_table'
const MAX_CREDENTIAL_BYTES = 4096
const INVOCATION_BOOTSTRAP = Symbol('agent-provider-invocation-bootstrap')
const PROVIDER_CONFIG_KEYS = Object.freeze([
  'providerId',
  'providerKind',
  'apiStyle',
  'baseUrl',
  'model',
  'maxChunkInputBytes',
  'maxResultBytes',
  'timeoutMs'
])

const DEFAULT_AGENT_PROVIDER_CONFIG_CATALOG = Object.freeze({
  schemaVersion: 1,
  providers: Object.freeze([
    Object.freeze({
      providerId: 'deepseek',
      providerKind: 'cloud',
      apiStyle: 'openai-chat-completions',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-v4-flash',
      maxChunkInputBytes: 65536,
      maxResultBytes: 16384,
      timeoutMs: 60000
    })
  ])
})

function invalidRequest () {
  return new AgentCoreError('AGENT_REQUEST_INVALID')
}

function exactObject (value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidRequest()
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw invalidRequest()
  }
  return value
}

function validateAgentProviderConfigCatalog (value) {
  exactObject(value, ['schemaVersion', 'providers'])
  if (value.schemaVersion !== 1 || !Array.isArray(value.providers) || value.providers.length !== 1) {
    throw invalidRequest()
  }
  const provider = exactObject(value.providers[0], PROVIDER_CONFIG_KEYS)
  if (provider.providerId !== 'deepseek' || provider.providerKind !== 'cloud' ||
      provider.apiStyle !== 'openai-chat-completions' || provider.baseUrl !== 'https://api.deepseek.com' ||
      typeof provider.model !== 'string' || provider.model.trim().length < 1 || provider.model.length > 160 ||
      !Number.isSafeInteger(provider.maxChunkInputBytes) || provider.maxChunkInputBytes < 256 ||
      provider.maxChunkInputBytes > 16 * 1024 * 1024 ||
      !Number.isSafeInteger(provider.maxResultBytes) || provider.maxResultBytes < 128 ||
      provider.maxResultBytes > 1024 * 1024 ||
      !Number.isSafeInteger(provider.timeoutMs) || provider.timeoutMs < 1 || provider.timeoutMs > 120000) {
    throw invalidRequest()
  }
  return Object.freeze({
    schemaVersion: 1,
    providers: Object.freeze([Object.freeze({
      providerId: provider.providerId,
      providerKind: provider.providerKind,
      apiStyle: provider.apiStyle,
      baseUrl: provider.baseUrl,
      model: provider.model,
      maxChunkInputBytes: provider.maxChunkInputBytes,
      maxResultBytes: provider.maxResultBytes,
      timeoutMs: provider.timeoutMs
    })])
  })
}

function isCredentialEnvironmentKey (key) {
  return typeof key === 'string' && key.toUpperCase() === CREDENTIAL_ENV_NAME
}

function consumeStartupCredential (environment) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) throw invalidRequest()
  const keys = Object.keys(environment).filter(isCredentialEnvironmentKey)
  const rawValues = []
  let readFailed = false
  for (const key of keys) {
    try {
      rawValues.push(environment[key])
    } catch {
      readFailed = true
    }
  }
  let deletionFailed = false
  for (const key of keys) {
    try {
      if (!delete environment[key]) deletionFailed = true
    } catch {
      deletionFailed = true
    }
  }
  try {
    if (Object.keys(environment).some(isCredentialEnvironmentKey)) deletionFailed = true
  } catch {
    deletionFailed = true
  }
  if (deletionFailed) throw invalidRequest()
  return {
    matchCount: keys.length,
    rawValue: keys.length === 1 && !readFailed ? rawValues[0] : undefined,
    readFailed
  }
}

function sanitizedChildEnvironment (environment) {
  const entries = []
  for (const [key, value] of Object.entries(environment)) {
    if (!isCredentialEnvironmentKey(key) && typeof value === 'string') entries.push([key, value])
  }
  return Object.freeze(Object.fromEntries(entries))
}

function classifyCredential (consumed) {
  if (consumed.matchCount === 0) return Object.freeze({ state: 'missing', rawValue: null })
  const rawValue = consumed.rawValue
  if (consumed.matchCount !== 1 || consumed.readFailed || typeof rawValue !== 'string' ||
      rawValue.length > MAX_CREDENTIAL_BYTES || rawValue.trim().length < 1 ||
      Buffer.byteLength(rawValue, 'utf8') > MAX_CREDENTIAL_BYTES) {
    return Object.freeze({ state: 'invalid', rawValue: null })
  }
  return Object.freeze({ state: 'startup_environment', rawValue })
}

function frozenProviderConfig (provider) {
  return provider ? Object.freeze({ ...provider }) : null
}

class AgentProviderBootstrap {
  #providerConfig
  #childEnvironment
  #credential
  #credentialState
  #borrowedCredentials
  #scope

  constructor (options = {}) {
    const invocation = options?.[INVOCATION_BOOTSTRAP]
    if (invocation) {
      this.#scope = 'invocation'
      this.#providerConfig = invocation.providerConfig
      this.#childEnvironment = null
      this.#credential = invocation.credential
      this.#credentialState = 'invocation'
      this.#borrowedCredentials = new Set()
      return
    }

    const {
      environment = process.env,
      configCatalog = DEFAULT_AGENT_PROVIDER_CONFIG_CATALOG
    } = options
    this.#scope = 'startup'
    const consumed = consumeStartupCredential(environment)
    this.#childEnvironment = sanitizedChildEnvironment(environment)
    const classifiedCredential = classifyCredential(consumed)
    this.#credentialState = classifiedCredential.state
    this.#borrowedCredentials = new Set()

    let validatedCatalog = null
    try {
      validatedCatalog = validateAgentProviderConfigCatalog(configCatalog)
    } catch {
      validatedCatalog = null
    }
    this.#providerConfig = validatedCatalog?.providers[0] ?? null
    this.#credential = this.#providerConfig && classifiedCredential.state === 'startup_environment'
      ? Buffer.from(classifiedCredential.rawValue, 'utf8')
      : null
  }

  static fromInvocation (input = {}) {
    exactObject(input, ['providerConfig', 'credential'])
    const { providerConfig, credential } = input
    let validatedProvider
    try {
      validatedProvider = validateAgentProviderConfigCatalog({
        schemaVersion: 1,
        providers: [{ ...providerConfig }]
      }).providers[0]
    } catch {
      throw invalidRequest()
    }
    if (!Buffer.isBuffer(credential) || credential.length < 1 ||
        credential.length > MAX_CREDENTIAL_BYTES || !credential.some((byte) => byte !== 0)) {
      throw invalidRequest()
    }
    const ownedCredential = Buffer.from(credential)
    try {
      return new AgentProviderBootstrap({
        [INVOCATION_BOOTSTRAP]: {
          providerConfig: validatedProvider,
          credential: ownedCredential
        }
      })
    } catch (error) {
      ownedCredential.fill(0)
      throw error
    }
  }

  getProviderConfig () {
    return frozenProviderConfig(this.#providerConfig)
  }

  getPublicState () {
    if (this.#scope !== 'startup') throw invalidRequest()
    const provider = this.#providerConfig
      ? Object.freeze({
          providerId: this.#providerConfig.providerId,
          providerKind: this.#providerConfig.providerKind,
          model: this.#providerConfig.model
        })
      : null
    return Object.freeze({
      provider,
      configurationSource: CONFIGURATION_SOURCE,
      credentialState: this.#credentialState
    })
  }

  getEligibilityProviderFacts () {
    if (this.#scope !== 'startup') throw invalidRequest()
    if (!this.#providerConfig) {
      return Object.freeze({
        providerId: null,
        providerKind: null,
        model: null,
        credentialAvailable: false
      })
    }
    return Object.freeze({
      providerId: this.#providerConfig.providerId,
      providerKind: this.#providerConfig.providerKind,
      model: this.#providerConfig.model,
      credentialAvailable: this.#credentialState === 'startup_environment' && this.#credential !== null
    })
  }

  getChildEnvironment () {
    if (this.#scope !== 'startup') throw invalidRequest()
    return Object.freeze({ ...this.#childEnvironment })
  }

  async withCredential (callback) {
    if (typeof callback !== 'function') throw invalidRequest()
    if (!['startup_environment', 'invocation'].includes(this.#credentialState) || this.#credential === null) {
      throw new AgentCoreError('AGENT_PROVIDER_AUTH_FAILED')
    }
    const borrowedCredential = Buffer.from(this.#credential)
    this.#borrowedCredentials.add(borrowedCredential)
    try {
      return await callback(borrowedCredential)
    } finally {
      borrowedCredential.fill(0)
      this.#borrowedCredentials.delete(borrowedCredential)
    }
  }

  invalidateCredential () {
    if (this.#credential !== null) {
      this.#credential.fill(0)
      this.#credential = null
    }
    for (const borrowedCredential of this.#borrowedCredentials) borrowedCredential.fill(0)
    if (['startup_environment', 'invocation'].includes(this.#credentialState)) this.#credentialState = 'invalid'
  }

  dispose () {
    this.invalidateCredential()
  }
}

module.exports = {
  AgentProviderBootstrap,
  CONFIGURATION_SOURCE,
  CREDENTIAL_ENV_NAME,
  DEFAULT_AGENT_PROVIDER_CONFIG_CATALOG,
  MAX_CREDENTIAL_BYTES,
  PROVIDER_CONFIG_KEYS,
  validateAgentProviderConfigCatalog
}
