'use strict'

const { AgentCoreError } = require('../agent-core/errors')
const {
  AgentProviderBootstrap,
  PROVIDER_CONFIG_KEYS,
  validateAgentProviderConfigCatalog
} = require('./provider-bootstrap')

const ADAPTER_KEYS = Object.freeze([
  'providerId',
  'providerKind',
  'apiStyle',
  'openModel'
])
const REGISTRY_IDENTITY_KEYS = Object.freeze([
  'runId', 'providerId', 'providerKind', 'model', 'recipeVersion'
])
const MODEL_REQUEST_KEYS = Object.freeze(['operation', 'input'])
const MODEL_HANDLE_KEYS = Object.freeze(['model', 'streamFn'])

function invalidRequest () {
  return new AgentCoreError('AGENT_REQUEST_INVALID')
}

function providerUnavailable () {
  return new AgentCoreError('AGENT_PROVIDER_UNAVAILABLE', { retryable: true })
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

function adapterDescriptor (value) {
  exactObject(value, ADAPTER_KEYS)
  if (typeof value.providerId !== 'string' || value.providerId.length < 1 || value.providerId.length > 160 ||
      !['cloud', 'local'].includes(value.providerKind) ||
      typeof value.apiStyle !== 'string' || value.apiStyle.length < 1 || value.apiStyle.length > 160 ||
      typeof value.openModel !== 'function') {
    throw invalidRequest()
  }
  return Object.freeze({
    providerId: value.providerId,
    providerKind: value.providerKind,
    apiStyle: value.apiStyle,
    openModel: value.openModel
  })
}

function configurationSnapshot (bootstrap) {
  const raw = bootstrap.getProviderConfig()
  if (raw === null) return null
  exactObject(raw, PROVIDER_CONFIG_KEYS)
  try {
    return validateAgentProviderConfigCatalog({
      schemaVersion: 1,
      providers: [{ ...raw }]
    }).providers[0]
  } catch {
    throw invalidRequest()
  }
}

function registryIdentity (value) {
  exactObject(value, REGISTRY_IDENTITY_KEYS)
  if (typeof value.runId !== 'string' || value.runId.length < 1 || value.runId.length > 160 ||
      typeof value.providerId !== 'string' || value.providerId.length < 1 || value.providerId.length > 160 ||
      !['cloud', 'local'].includes(value.providerKind) ||
      typeof value.model !== 'string' || value.model.length < 1 || value.model.length > 160 ||
      typeof value.recipeVersion !== 'string' || value.recipeVersion.length < 1 || value.recipeVersion.length > 160) {
    throw invalidRequest()
  }
  return value
}

function modelRequest (value) {
  exactObject(value, MODEL_REQUEST_KEYS)
  if (typeof value.operation !== 'string' || value.operation.length < 1 || value.operation.length > 160 ||
      !value.input || typeof value.input !== 'object' || Array.isArray(value.input)) {
    throw invalidRequest()
  }
  try {
    return Object.freeze({
      operation: value.operation,
      input: structuredClone(value.input)
    })
  } catch {
    throw invalidRequest()
  }
}

function modelHandle (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Reflect.ownKeys(value).length !== MODEL_HANDLE_KEYS.length ||
      MODEL_HANDLE_KEYS.some((key) => !Object.hasOwn(value, key)) ||
      !value.model || typeof value.streamFn !== 'function') {
    throw providerUnavailable()
  }
  return Object.freeze({
    model: value.model,
    streamFn: value.streamFn
  })
}

function callerSignal (value) {
  if (value === undefined) return value
  if (!value || typeof value !== 'object' || typeof value.aborted !== 'boolean' ||
      typeof value.addEventListener !== 'function' || typeof value.removeEventListener !== 'function') {
    throw invalidRequest()
  }
  return value
}

function cancellationError (signal) {
  if (signal.reason instanceof AgentCoreError) return signal.reason
  return new AgentCoreError('AGENT_CANCELLED')
}

function waitForOperation (operation, signal) {
  if (signal.aborted) return Promise.reject(cancellationError(signal))
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (callback, value) => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback(value)
    }
    const onAbort = () => finish(reject, cancellationError(signal))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(operation).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error)
    )
  })
}

function operationControl (signal, timeoutMs) {
  const controller = new AbortController()
  const cancel = () => {
    if (!controller.signal.aborted) controller.abort(new AgentCoreError('AGENT_CANCELLED'))
  }
  if (signal?.aborted) cancel()
  else signal?.addEventListener('abort', cancel, { once: true })
  const timer = setTimeout(() => {
    if (!controller.signal.aborted) {
      controller.abort(new AgentCoreError('AGENT_PROVIDER_TIMEOUT', { retryable: true }))
    }
  }, timeoutMs)
  timer.unref?.()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
    }
  }
}

class AgentModelProviderRegistry {
  #bootstrap
  #configuration
  #adapter

  constructor ({ bootstrap, adapters } = {}) {
    if (!(bootstrap instanceof AgentProviderBootstrap) ||
        !Array.isArray(adapters) || adapters.length < 1 || adapters.length > 16) {
      throw invalidRequest()
    }
    const registered = adapters.map(adapterDescriptor)
    const identities = new Set()
    for (const adapter of registered) {
      const key = `${adapter.providerKind}\u0000${adapter.providerId}\u0000${adapter.apiStyle}`
      if (identities.has(key)) throw invalidRequest()
      identities.add(key)
    }
    this.#bootstrap = bootstrap
    this.#configuration = configurationSnapshot(bootstrap)
    this.#adapter = this.#configuration
      ? registered.find((adapter) =>
          adapter.providerId === this.#configuration.providerId &&
          adapter.providerKind === this.#configuration.providerKind &&
          adapter.apiStyle === this.#configuration.apiStyle
        ) ?? null
      : null
  }

  async resolve (rawIdentity) {
    const identity = registryIdentity(rawIdentity)
    const configuration = this.#configuration
    const adapter = this.#adapter
    if (!configuration || !adapter ||
        identity.providerId !== configuration.providerId ||
        identity.providerKind !== configuration.providerKind ||
        identity.model !== configuration.model) {
      throw providerUnavailable()
    }

    const withModel = async (rawRequest, rawSignal, consumeModel) => {
      const request = modelRequest(rawRequest)
      const signal = callerSignal(rawSignal)
      if (typeof consumeModel !== 'function') throw invalidRequest()
      const control = operationControl(signal, configuration.timeoutMs)
      try {
        return await this.#bootstrap.withCredential(async (credential) => {
          const operation = Promise.resolve()
            .then(() => {
              if (control.signal.aborted) throw cancellationError(control.signal)
              return adapter.openModel({
                configuration,
                request,
                credential,
                signal: control.signal
              })
            })
            .then((resolvedModel) => {
              if (control.signal.aborted) throw cancellationError(control.signal)
              return consumeModel(modelHandle(resolvedModel), control.signal)
            })
          return waitForOperation(operation, control.signal)
        })
      } catch (error) {
        if (error?.code === 'AGENT_PROVIDER_AUTH_FAILED') this.#bootstrap.invalidateCredential()
        throw error
      } finally {
        control.dispose()
      }
    }

    return Object.freeze({
      providerId: configuration.providerId,
      providerKind: configuration.providerKind,
      model: configuration.model,
      maxChunkInputBytes: configuration.maxChunkInputBytes,
      maxResultBytes: configuration.maxResultBytes,
      timeoutMs: configuration.timeoutMs,
      withModel
    })
  }

  dispose () {
    this.#bootstrap.dispose()
  }
}

module.exports = {
  ADAPTER_KEYS,
  AgentModelProviderRegistry,
  MODEL_HANDLE_KEYS,
  MODEL_REQUEST_KEYS,
  REGISTRY_IDENTITY_KEYS,
  adapterDescriptor,
  modelHandle,
  modelRequest,
  registryIdentity
}
