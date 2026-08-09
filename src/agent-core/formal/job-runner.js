'use strict'

const { AgentCoreError } = require('../errors')
const {
  RETRYABLE_ERROR_CODES,
  TERMINAL_ERROR_CODES,
  boundedString,
  runtimeError
} = require('./contracts')
const { ArtifactWriter, MemoryCandidateSink } = require('./storage-ports')

const DEFAULT_RETRY_DELAYS_MS = Object.freeze([2000, 10000])

class LeaseKeeper {
  constructor ({ storage, job, leaseMs, now, controller }) {
    this.storage = storage
    this.runId = job.runId
    this.lease = { ...job.lease }
    this.leaseMs = leaseMs
    this.now = now
    this.controller = controller
    this.timer = null
    this.inFlight = null
    this.failure = null
    this.stopped = false
  }

  start () {
    this.schedule()
  }

  schedule () {
    if (this.stopped || this.failure) return
    const delay = Math.max(250, Math.floor(this.leaseMs / 2))
    this.timer = setTimeout(() => {
      this.timer = null
      this.inFlight = this.renew().finally(() => { this.inFlight = null })
    }, delay)
  }

  async renew () {
    try {
      const newExpiresAt = Math.max(this.now() + this.leaseMs, this.lease.expiresAt + 1)
      const job = await this.storage.renewAgentJobLease({
        runId: this.runId,
        lease: this.lease,
        newExpiresAt
      })
      this.lease = { ...job.lease }
      this.schedule()
    } catch (error) {
      this.failure = error
      this.controller.abort()
    }
  }

  async stop () {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.inFlight) await this.inFlight
    return { lease: { ...this.lease }, failure: this.failure }
  }
}

class AgentJobRunner {
  constructor ({
    storage,
    pluginHost,
    owner = 'formal-agent-runner',
    leaseMs = 60000,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    now = () => Date.now()
  } = {}) {
    const requiredStorageMethods = [
      'claimNextAgentJob', 'renewAgentJobLease', 'markAgentJobRetry', 'markAgentJobFailed',
      'requestAgentCancel', 'markAgentJobCancelled', 'commitAgentArtifact',
      'commitAgentMemoryCandidates'
    ]
    if (!storage || requiredStorageMethods.some((method) => typeof storage[method] !== 'function') ||
        !pluginHost || typeof pluginHost.availableTaskKinds !== 'function' ||
        typeof pluginHost.executeJob !== 'function' || typeof pluginHost.assertJobAvailable !== 'function' ||
        typeof now !== 'function' ||
        !Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 120000 ||
        !Array.isArray(retryDelaysMs) || retryDelaysMs.length < 1 || retryDelaysMs.length > 10 ||
        retryDelaysMs.some((delay) => !Number.isSafeInteger(delay) || delay < 0 || delay > 120000)) {
      throw new AgentCoreError('AGENT_REQUEST_INVALID')
    }
    this.storage = storage
    this.pluginHost = pluginHost
    this.owner = boundedString(owner)
    this.leaseMs = leaseMs
    this.retryDelaysMs = [...retryDelaysMs]
    this.now = now
    this.writer = new ArtifactWriter(storage)
    this.memorySink = new MemoryCandidateSink(storage)
    this.runs = new Map()
    this.cancelRequested = new Set()
  }

  async runNext ({ claimIdempotencyKey, localWorkAllowed }) {
    const claimKey = boundedString(claimIdempotencyKey)
    if (typeof localWorkAllowed !== 'boolean') throw new AgentCoreError('AGENT_REQUEST_INVALID')
    const availableTaskKinds = this.pluginHost.availableTaskKinds()
    const job = await this.storage.claimNextAgentJob({
      claimIdempotencyKey: claimKey,
      owner: this.owner,
      leaseMs: this.leaseMs,
      localWorkAllowed,
      availableTaskKinds
    })
    if (!job) return null
    if (!availableTaskKinds.includes(job.taskKind)) throw new AgentCoreError('AGENT_PERMISSION_DENIED')

    const controller = new AbortController()
    const keeper = new LeaseKeeper({
      storage: this.storage,
      job,
      leaseMs: this.leaseMs,
      now: this.now,
      controller
    })
    this.runs.set(job.runId, { controller, keeper })
    keeper.start()
    let keeperState = null
    try {
      const pluginResult = await this.pluginHost.executeJob(job, { signal: controller.signal })
      keeperState = await keeper.stop()
      if (keeperState.failure) throw keeperState.failure
      this.pluginHost.assertJobAvailable(job)
      if (pluginResult.kind === 'artifact') {
        const committed = await this.writer.commit(job.runId, keeperState.lease, pluginResult.value)
        return { runId: job.runId, jobState: 'succeeded', artifact: committed, memory: null }
      }
      if (pluginResult.kind === 'memory-candidates') {
        const committed = await this.memorySink.commit(job.runId, keeperState.lease, pluginResult.value)
        return { runId: job.runId, jobState: 'succeeded', artifact: null, memory: committed }
      }
      throw new AgentCoreError('AGENT_INTERNAL_FAILURE')
    } catch (rawError) {
      if (!keeperState) keeperState = await keeper.stop()
      const error = runtimeError(keeperState.failure || rawError)
      if (this.cancelRequested.has(job.runId) && controller.signal.aborted) {
        const cancelled = await this.storage.markAgentJobCancelled({
          runId: job.runId,
          lease: keeperState.lease
        })
        return { runId: job.runId, jobState: cancelled.state, artifact: null }
      }
      if (error.code === 'AGENT_JOB_STATE_CONFLICT') throw error
      if (RETRYABLE_ERROR_CODES.includes(error.code) || error.retryable) {
        const delay = this.retryDelaysMs[Math.min(job.attemptCount - 1, this.retryDelaysMs.length - 1)]
        const retried = await this.storage.markAgentJobRetry({
          runId: job.runId,
          lease: keeperState.lease,
          errorCode: RETRYABLE_ERROR_CODES.includes(error.code) ? error.code : 'AGENT_PROVIDER_UNAVAILABLE',
          nextAttemptAt: this.now() + delay
        })
        return { runId: job.runId, jobState: retried.state, artifact: null }
      }
      const errorCode = error.code === 'AGENT_INPUT_CHANGED'
        ? 'AGENT_REQUEST_INVALID'
        : TERMINAL_ERROR_CODES.includes(error.code) ? error.code : 'AGENT_INTERNAL_FAILURE'
      const failed = await this.storage.markAgentJobFailed({
        runId: job.runId,
        lease: keeperState.lease,
        errorCode
      })
      return { runId: job.runId, jobState: failed.state, artifact: null }
    } finally {
      this.runs.delete(job.runId)
      this.cancelRequested.delete(job.runId)
    }
  }

  async cancel (runId) {
    const id = boundedString(runId)
    this.cancelRequested.add(id)
    try {
      const job = await this.storage.requestAgentCancel({ runId: id })
      if (job.state === 'running') this.runs.get(id)?.controller.abort()
      else this.cancelRequested.delete(id)
      return job
    } catch (error) {
      this.cancelRequested.delete(id)
      throw error
    }
  }
}

module.exports = { AgentJobRunner, DEFAULT_RETRY_DELAYS_MS, LeaseKeeper }
