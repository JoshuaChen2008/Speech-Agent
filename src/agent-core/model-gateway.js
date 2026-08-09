'use strict'

const { providerConfiguration } = require('./contracts')
const { AgentCoreError } = require('./errors')

function openAiModel (configuration) {
  const config = providerConfiguration(configuration)
  return Object.freeze({
    id: config.model,
    name: config.model,
    api: 'openai-completions',
    provider: 'openai-compatible',
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 32768,
    maxTokens: 4096,
    compat: { supportsStore: false, supportsDeveloperRole: false }
  })
}

class ModelGateway {
  constructor (options = {}) {
    this.testResponses = Array.isArray(options.testResponses) ? [...options.testResponses] : []
    this.testCore = null
  }

  async resolve ({ provider, configuration, apiKey }) {
    if (provider === 'openai-compatible') {
      if (typeof apiKey !== 'string' || apiKey.length < 1) throw new AgentCoreError('AGENT_PROVIDER_AUTH_FAILED')
      const module = await import('@earendil-works/pi-ai/api/openai-completions')
      return {
        model: openAiModel(configuration),
        apiKey,
        streamFn: (model, context, options = {}) => module.streamSimple(model, context, {
          ...options, apiKey, timeoutMs: options.timeoutMs ?? 30000, maxRetries: 0, maxRetryDelayMs: 0
        })
      }
    }
    if (provider === 'deterministic-test') {
      const faux = await import('@earendil-works/pi-ai/providers/faux')
      if (!this.testCore) {
        this.testCore = faux.createFauxCore({ provider: 'deterministic-test', api: 'agent-mvp-test', models: [{ id: 'fixture-model' }] })
        this.testCore.setResponses(this.testResponses.map((response) => typeof response === 'string' ? faux.fauxAssistantMessage(response) : response))
      }
      return { model: this.testCore.getModel(), apiKey: undefined, streamFn: this.testCore.streamSimple, faux }
    }
    throw new AgentCoreError('AGENT_PROVIDER_INVALID')
  }
}

module.exports = { ModelGateway, openAiModel }
