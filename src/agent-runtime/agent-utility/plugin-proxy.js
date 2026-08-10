'use strict'

const { AgentCoreError } = require('../../agent-core/errors')
const {
  claimedJob,
  sameInputReference,
  transcriptSnapshot
} = require('../../agent-core/formal/contracts')
const { TranscriptReader } = require('../../agent-core/formal/storage-ports')
const { AgentProviderBootstrap } = require('../../agent-provider/provider-bootstrap')
const { AgentUtilityWorkerHost } = require('./worker-host')
const { pluginResultForJob, providerConfiguration } = require('./protocol')

class AgentUtilityPluginProxy {
  constructor ({ storage, workerHost, providerBootstrap } = {}) {
    if (!(workerHost instanceof AgentUtilityWorkerHost) ||
        !(providerBootstrap instanceof AgentProviderBootstrap)) {
      throw new AgentCoreError('AGENT_REQUEST_INVALID')
    }
    this.transcriptReader = new TranscriptReader(storage)
    this.workerHost = workerHost
    this.providerBootstrap = providerBootstrap
    this.disposed = false
    this.removeFailureObserver = workerHost.observeGenerationFailure(() => {
      this.providerBootstrap.invalidateCredential()
    })
  }

  availableTaskKinds () {
    if (this.disposed || !this.providerBootstrap.getEligibilityProviderFacts().credentialAvailable) return []
    return this.workerHost.availableTaskKinds()
  }

  assertJobAvailable (rawJob) {
    const job = claimedJob(rawJob)
    const configuration = this.providerBootstrap.getProviderConfig()
    if (!configuration || !this.availableTaskKinds().includes(job.taskKind)) {
      if (!this.providerBootstrap.getEligibilityProviderFacts().credentialAvailable) {
        throw new AgentCoreError('AGENT_PROVIDER_AUTH_FAILED')
      }
      throw new AgentCoreError('AGENT_WORKER_EXITED', { retryable: true })
    }
    providerConfiguration(configuration, job)
    return job
  }

  async executeJob (rawJob, options = {}) {
    const job = this.assertJobAvailable(rawJob)
    const snapshot = transcriptSnapshot(await this.transcriptReader.readSnapshot(job.inputRef))
    if (!sameInputReference(job.inputRef, snapshot.inputRef)) {
      throw new AgentCoreError('AGENT_INPUT_CHANGED')
    }
    const providerConfig = providerConfiguration(this.providerBootstrap.getProviderConfig(), job)
    try {
      const result = await this.providerBootstrap.withCredential((credentialBytes) =>
        this.workerHost.executeJob({ job, snapshot, providerConfig, credentialBytes }, options)
      )
      return pluginResultForJob(result, job, snapshot)
    } catch (error) {
      if (['AGENT_PROVIDER_AUTH_FAILED', 'AGENT_WORKER_EXITED'].includes(error?.code)) {
        this.providerBootstrap.invalidateCredential()
      }
      if (error?.code === 'AGENT_PROVIDER_AUTH_FAILED') {
        await this.workerHost.terminateAndWait().catch(() => {})
      }
      throw error
    }
  }

  dispose () {
    if (this.disposed) return
    this.disposed = true
    this.removeFailureObserver()
  }
}

module.exports = { AgentUtilityPluginProxy }
