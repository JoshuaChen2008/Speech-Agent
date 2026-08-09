'use strict'

const crypto = require('node:crypto')
const path = require('node:path')
const { RpcUtilityHost } = require('./rpc-utility-host')
const { OPERATIONS: STORAGE } = require('./storage-service')
const { OPERATIONS: AGENT } = require('./agent-service')

const RETRYABLE = new Set(['AGENT_PROVIDER_RATE_LIMITED', 'AGENT_PROVIDER_TIMEOUT', 'AGENT_PROVIDER_UNAVAILABLE', 'AGENT_WORKER_EXITED'])
const TERMINAL = new Set(['AGENT_PROVIDER_AUTH_FAILED', 'AGENT_OUTPUT_INVALID', 'AGENT_PERMISSION_DENIED', 'AGENT_REQUEST_INVALID'])

class AgentMvpRuntimeHost {
  constructor ({ electron, databasePath, providerSnapshot, onChanged = () => {}, onEvent = () => {} }) {
    this.databasePath = databasePath; this.providerSnapshot = providerSnapshot; this.onChanged = onChanged; this.onEvent = onEvent
    this.storage = new RpcUtilityHost({ electron, workerPath: path.join(__dirname, 'storage-worker.js'), serviceName: 'Agent MVP Storage' })
    this.agent = new RpcUtilityHost({ electron, workerPath: path.join(__dirname, 'agent-worker.js'), serviceName: 'Agent MVP Loop', onEvent: (event) => this.onEvent(event), timeoutMs: 40000 })
    this.running = null; this.draining = false; this.drainPromise = Promise.resolve(); this.threads = new Map(); this.previews = new Map(); this.stopping = false; this.wakeTimer = null
  }

  async start () {
    this.storage.start(); this.agent.start()
    await this.storage.request(STORAGE.INITIALIZE, { databasePath: this.databasePath })
    await this.notify()
    this.drain().catch(() => {})
  }

  async snapshot () {
    const [sessions, jobs, artifacts] = await Promise.all([
      this.storage.request(STORAGE.LIST_SESSIONS, {}), this.storage.request(STORAGE.LIST_JOBS, {}), this.storage.request(STORAGE.LIST_ARTIFACTS, {})
    ])
    return { sessions, jobs, artifacts, runningRunId: this.running?.runId || null }
  }

  async notify () { this.onChanged(await this.snapshot()) }

  async createFixture (sourceId) {
    const result = await this.storage.request(STORAGE.CREATE_FIXTURE, { sourceId }); await this.notify(); return result
  }

  async threadFor (inputRef) {
    const existing = this.threads.get(inputRef.sessionId)
    if (existing) return existing
    const thread = await this.storage.request(STORAGE.GET_OR_CREATE_THREAD, { inputRef })
    this.threads.set(inputRef.sessionId, thread.threadId); return thread.threadId
  }

  async chat ({ sessionId, prompt }) {
    const input = await this.storage.request(STORAGE.READ_INPUT, { sessionId, transcriptVersion: 'original' })
    const threadId = await this.threadFor(input.inputRef)
    const provider = await this.providerSnapshot()
    await this.storage.request(STORAGE.APPEND_MESSAGE, { threadId, role: 'user', content: { text: prompt }, provider: null, model: null })
    const runId = `chat-${crypto.randomUUID()}`
    const result = await this.agent.request(AGENT.CHAT, { runId, input, provider, prompt })
    await this.storage.request(STORAGE.APPEND_MESSAGE, { threadId, role: 'assistant', content: { text: result.text }, provider: provider.provider, model: provider.configuration.model })
    await this.notify()
    return { threadId, messages: await this.storage.request(STORAGE.LIST_MESSAGES, { threadId }) }
  }

  async preview ({ sessionId }) {
    const input = await this.storage.request(STORAGE.READ_INPUT, { sessionId, transcriptVersion: 'original' })
    const provider = await this.providerSnapshot(); const threadId = await this.threadFor(input.inputRef)
    const previewId = `preview-${crypto.randomUUID()}`
    const preview = { previewId, recipeId: 'reference-output-v1', inputRef: input.inputRef, cloudDisclosure: provider.provider === 'openai-compatible' }
    await this.storage.request(STORAGE.APPEND_MESSAGE, { threadId, role: 'tool_preview', content: preview, provider: provider.provider, model: provider.configuration.model })
    this.previews.set(previewId, { preview, threadId, provider })
    return preview
  }

  async confirm ({ previewId, decision }) {
    const record = this.previews.get(previewId)
    if (!record) throw Object.assign(new Error('invalid preview'), { code: 'AGENT_REQUEST_INVALID' })
    await this.storage.request(STORAGE.APPEND_MESSAGE, { threadId: record.threadId, role: 'tool_confirmation', content: { previewId, decision }, provider: null, model: null })
    this.previews.delete(previewId)
    if (decision === 'rejected') return { decision }
    const created = await this.storage.request(STORAGE.CREATE_JOB, {
      inputRef: record.preview.inputRef, provider: record.provider.provider, model: record.provider.configuration.model, clientIdempotencyKey: previewId
    })
    this.drain().catch(() => {})
    await this.notify()
    return { decision, runId: created.job.runId }
  }

  drain () {
    if (this.draining) return this.drainPromise
    if (this.stopping) return Promise.resolve()
    this.draining = true
    this.drainPromise = this.performDrain().finally(async () => {
      this.draining = false
      if (!this.stopping) await this.scheduleWake()
    })
    return this.drainPromise
  }

  async performDrain () {
    while (!this.stopping) {
      const job = await this.storage.request(STORAGE.CLAIM, { owner: 'agent-mvp-runtime', leaseMs: 60000 })
      if (!job) break
      this.running = job
      if (this.stopping) {
        await this.storage.request(STORAGE.CANCEL_REQUEST, { runId: job.runId })
        await this.storage.request(STORAGE.CANCEL_COMMIT, { runId: job.runId, lease: job.lease })
        this.running = null
        break
      }
      await this.notify()
      try {
        const input = await this.storage.request(STORAGE.READ_INPUT, { sessionId: job.sessionId, transcriptVersion: job.inputRef.transcriptVersion })
        const provider = await this.providerSnapshot(job)
        const result = await this.agent.request(AGENT.RUN_REFERENCE, { runId: job.runId, input, provider })
        const artifact = await this.storage.request(STORAGE.COMMIT, { runId: job.runId, lease: job.lease, content: result.content })
        await this.storage.request(STORAGE.APPEND_MESSAGE, { threadId: await this.threadFor(job.inputRef), role: 'tool_result', content: { runId: job.runId, state: 'succeeded', artifactId: artifact.artifactId }, provider: null, model: null })
      } catch (error) {
        if (error.code === 'AGENT_CANCELLED') await this.storage.request(STORAGE.CANCEL_COMMIT, { runId: job.runId, lease: job.lease })
        else if (RETRYABLE.has(error.code)) await this.storage.request(STORAGE.RETRY, { runId: job.runId, lease: job.lease, errorCode: error.code, delayMs: job.attemptCount === 1 ? 2000 : 10000 })
        else await this.storage.request(STORAGE.FAIL, {
          runId: job.runId, lease: job.lease,
          errorCode: error.code === 'AGENT_INPUT_CHANGED' ? 'AGENT_REQUEST_INVALID' : TERMINAL.has(error.code) ? error.code : 'AGENT_INTERNAL_FAILURE'
        })
      } finally { this.running = null; await this.notify() }
    }
  }

  async scheduleWake () {
    if (this.wakeTimer) { clearTimeout(this.wakeTimer); this.wakeTimer = null }
    const jobs = await this.storage.request(STORAGE.LIST_JOBS, {})
    const wakeTimes = jobs.flatMap((job) => {
      if (job.state === 'retry_wait') return [job.nextAttemptAt]
      if (job.state === 'running' && job.lease) return [job.lease.expiresAt]
      if (job.state === 'queued' && job.cancelRequestedAt !== null) return [Date.now()]
      return []
    })
    if (wakeTimes.length === 0) return
    const delay = Math.max(0, Math.min(...wakeTimes) - Date.now() + 10)
    this.wakeTimer = setTimeout(() => { this.wakeTimer = null; this.drain().catch(() => {}) }, Math.min(delay, 120000))
  }

  async cancel (runId) {
    const job = await this.storage.request(STORAGE.CANCEL_REQUEST, { runId })
    if (this.running?.runId === runId) await this.agent.request(AGENT.CANCEL, { runId })
    else this.drain().catch(() => {})
    await this.notify(); return job
  }

  async messages (sessionId) {
    const input = await this.storage.request(STORAGE.READ_INPUT, { sessionId, transcriptVersion: 'original' })
    const threadId = await this.threadFor(input.inputRef)
    return { threadId, messages: await this.storage.request(STORAGE.LIST_MESSAGES, { threadId }) }
  }

  async stop () {
    this.stopping = true
    if (this.wakeTimer) { clearTimeout(this.wakeTimer); this.wakeTimer = null }
    if (this.running) { await this.storage.request(STORAGE.CANCEL_REQUEST, { runId: this.running.runId }).catch(() => {}); await this.agent.request(AGENT.CANCEL, { runId: this.running.runId }).catch(() => {}) }
    await this.drainPromise.catch(() => {})
    await this.agent.stop(AGENT.SHUTDOWN); await this.storage.stop(STORAGE.SHUTDOWN)
  }
}

module.exports = { AgentMvpRuntimeHost }
