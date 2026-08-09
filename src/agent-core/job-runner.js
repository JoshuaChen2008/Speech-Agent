'use strict'

const { AgentCoreError, asAgentCoreError } = require('./errors')
const { parseReferenceOutput } = require('./reference-output')

const RETRY_DELAYS_MS = Object.freeze([2000, 10000])

class AgentJobRunner {
  constructor ({ store, pluginHost, modelGateway, adapter, owner = 'agent-mvp-runner', apiKeyResolver = async () => undefined, onEvent = () => {} }) {
    this.store = store
    this.pluginHost = pluginHost
    this.modelGateway = modelGateway
    this.adapter = adapter
    this.owner = owner
    this.apiKeyResolver = apiKeyResolver
    this.onEvent = onEvent
    this.controllers = new Map()
  }

  async runNext (providerConfiguration) {
    const job = this.store.claimNext(this.owner, 60000)
    if (!job) return null
    const controller = new AbortController()
    this.controllers.set(job.runId, controller)
    try {
      const recipe = this.pluginHost.getRecipe('reference-output-v1')
      this.pluginHost.assertPermission(recipe.id, 'transcript.read')
      this.pluginHost.assertPermission(recipe.id, 'model.invoke')
      this.pluginHost.assertPermission(recipe.id, 'artifact.write')
      const input = this.store.readInput({ sessionId: job.sessionId, transcriptVersion: job.inputRef.transcriptVersion })
      if (input.inputRef.inputWatermark !== job.inputRef.inputWatermark || input.inputRef.inputDigest !== job.inputRef.inputDigest) {
        throw new AgentCoreError('AGENT_INPUT_CHANGED')
      }
      const resolvedModel = await this.modelGateway.resolve({
        provider: job.provider,
        configuration: providerConfiguration,
        apiKey: await this.apiKeyResolver(job.provider)
      })
      let readCount = 0
      const tools = [{
        name: 'read_selected_transcript',
        label: '读取已选择转写',
        description: '读取本任务已冻结的终态会话转写快照。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        execute: async () => {
          this.pluginHost.assertTool(recipe.id, 'read_selected_transcript')
          readCount += 1
          if (readCount > 1) throw new AgentCoreError('AGENT_PERMISSION_DENIED')
          return { content: [{ type: 'text', text: JSON.stringify(input.items) }], details: { segmentCount: input.items.length } }
        }
      }]
      const result = await this.adapter.run({
        resolvedModel,
        systemPrompt: 'You are an isolated reference-output generator. Call read_selected_transcript exactly once, then return only JSON with keys title and bullets. Do not reveal hidden reasoning.',
        prompt: 'Generate the reference structured output for the selected terminal session.',
        tools,
        maxTurns: recipe.maxTurns,
        timeoutMs: recipe.timeoutMs,
        signal: controller.signal,
        onEvent: (event) => this.onEvent({ runId: job.runId, ...event })
      })
      if (readCount !== 1) throw new AgentCoreError('AGENT_PERMISSION_DENIED')
      const artifact = this.store.commitArtifact(job.runId, job.lease, parseReferenceOutput(result.text))
      return { job: this.store.getJob(job.runId), artifact }
    } catch (rawError) {
      const error = asAgentCoreError(rawError)
      if (error.code === 'AGENT_CANCELLED') return { job: this.store.markCancelled(job.runId, job.lease), artifact: null }
      if (error.retryable) {
        const current = this.store.getJob(job.runId)
        const delay = RETRY_DELAYS_MS[Math.min(current.attemptCount - 1, RETRY_DELAYS_MS.length - 1)]
        return { job: this.store.markRetry(job.runId, job.lease, error.code, delay), artifact: null }
      }
      const allowed = ['AGENT_PROVIDER_AUTH_FAILED', 'AGENT_OUTPUT_INVALID', 'AGENT_PERMISSION_DENIED', 'AGENT_REQUEST_INVALID']
      return { job: this.store.markFailed(job.runId, job.lease, allowed.includes(error.code) ? error.code : 'AGENT_INTERNAL_FAILURE'), artifact: null }
    } finally {
      this.controllers.delete(job.runId)
    }
  }

  cancel (runId) {
    const job = this.store.requestCancel(runId)
    this.controllers.get(runId)?.abort()
    return job
  }
}

module.exports = { AgentJobRunner, RETRY_DELAYS_MS }
