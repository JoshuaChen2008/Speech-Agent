'use strict'

const { AgentCoreError } = require('../../agent-core/errors')
const { AgentInputPlanner } = require('../../agent-core/formal/input-planner')
const { ModelGateway } = require('../../agent-core/formal/model-gateway')
const { AgentPluginHost } = require('../../agent-core/formal/plugin-host')
const {
  inputReference,
  sameInputReference,
  transcriptSnapshot
} = require('../../agent-core/formal/contracts')
const { AgentModelProviderRegistry } = require('../../agent-provider/model-provider-registry')
const { AgentProviderBootstrap } = require('../../agent-provider/provider-bootstrap')
const {
  TASK_KINDS,
  cancelPayload,
  clearCredentialBytes,
  executeJobPayload,
  initializePayload,
  pluginResultForJob,
  shutdownPayload
} = require('./protocol')

function credentialEnvironmentKey (key) {
  return typeof key === 'string' && key.toUpperCase() === 'DEEPSEEK_API_KEY'
}

function assertSanitizedEnvironment (environment) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment) ||
      Object.keys(environment).some(credentialEnvironmentKey)) {
    throw new AgentCoreError('AGENT_WORKER_EXITED', { retryable: true })
  }
}

function unavailableDeepseekAdapter () {
  return Object.freeze({
    providerId: 'deepseek',
    providerKind: 'cloud',
    apiStyle: 'openai-chat-completions',
    openModel: async () => {
      throw new AgentCoreError('AGENT_PROVIDER_UNAVAILABLE', { retryable: true })
    }
  })
}

class FrozenTranscriptReader {
  constructor (snapshot) {
    this.snapshot = transcriptSnapshot(snapshot)
  }

  readSnapshot (rawInputRef) {
    const requested = inputReference(rawInputRef)
    if (!sameInputReference(requested, this.snapshot.inputRef)) {
      throw new AgentCoreError('AGENT_INPUT_CHANGED')
    }
    return structuredClone(this.snapshot)
  }
}

class AgentUtilityService {
  constructor ({ adapters = [unavailableDeepseekAdapter()], environment = process.env } = {}) {
    assertSanitizedEnvironment(environment)
    if (!Array.isArray(adapters) || adapters.length < 1 || adapters.length > 16) {
      throw new AgentCoreError('AGENT_REQUEST_INVALID')
    }
    this.adapters = [...adapters]
    this.environment = environment
    this.initialized = false
    this.shuttingDown = false
    this.current = null
  }

  initialize (rawPayload) {
    initializePayload(rawPayload)
    assertSanitizedEnvironment(this.environment)
    if (this.initialized || this.shuttingDown) throw new AgentCoreError('AGENT_REQUEST_INVALID')
    this.initialized = true
    return { availableTaskKinds: [...TASK_KINDS] }
  }

  async executeJob (rawPayload) {
    let payload
    try {
      if (!this.initialized || this.shuttingDown || this.current) {
        throw new AgentCoreError('AGENT_REQUEST_INVALID')
      }
      assertSanitizedEnvironment(this.environment)
      payload = executeJobPayload(rawPayload)
    } finally {
      clearCredentialBytes(rawPayload?.credentialBytes)
    }

    const controller = new AbortController()
    const execution = { runId: payload.job.runId, controller }
    this.current = execution
    let bootstrap = null
    let providerRegistry = null
    try {
      bootstrap = AgentProviderBootstrap.fromInvocation({
        providerConfig: payload.providerConfig,
        credential: payload.credentialBytes
      })
      payload.credentialBytes.fill(0)
      providerRegistry = new AgentModelProviderRegistry({
        bootstrap,
        adapters: this.adapters
      })
      const modelGateway = new ModelGateway({ providerRegistry })
      const pluginHost = new AgentPluginHost({
        transcriptReader: new FrozenTranscriptReader(payload.snapshot),
        inputPlanner: new AgentInputPlanner(),
        modelGateway
      })
      const result = await pluginHost.executeJob(payload.job, { signal: controller.signal })
      return pluginResultForJob(result, payload.job, payload.snapshot)
    } finally {
      payload.credentialBytes.fill(0)
      if (providerRegistry) providerRegistry.dispose()
      else if (bootstrap) bootstrap.dispose()
      if (this.current === execution) this.current = null
    }
  }

  cancel (rawPayload) {
    const { runId } = cancelPayload(rawPayload)
    const current = this.current
    const cancelled = current?.runId === runId
    if (cancelled && !current.controller.signal.aborted) {
      current.controller.abort(new AgentCoreError('AGENT_CANCELLED'))
    }
    return { runId, cancelled }
  }

  shutdown (rawPayload) {
    shutdownPayload(rawPayload)
    if (!this.initialized || this.shuttingDown || this.current) {
      throw new AgentCoreError('AGENT_REQUEST_INVALID')
    }
    this.shuttingDown = true
    return { accepted: true }
  }
}

module.exports = {
  AgentUtilityService,
  FrozenTranscriptReader,
  assertSanitizedEnvironment,
  credentialEnvironmentKey,
  unavailableDeepseekAdapter
}
