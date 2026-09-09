'use strict'

const { createPersonalContextExecutionAdapter, createPersonalContextModule } = require('./index')
const { PersonalContextController } = require('./controller')
const {
  ContextIngestSessionRunner,
  FormalAgentJobScheduler,
  S1TerminalSessionReconciler
} = require('../execution-host')

function policyFailure () {
  const error = new Error('AGENT_CONTEXT_OPERATION_FAILED')
  error.code = 'AGENT_CONTEXT_OPERATION_FAILED'
  return error
}

class PersonalContextRuntime {
  constructor (options = {}) {
    if (!options.gateway || !options.config) throw new TypeError('gateway and config are required')
    this.gateway = options.gateway
    this.config = options.config
    this.onChanged = typeof options.onChanged === 'function' ? options.onChanged : () => {}
    this.onDiagnostic = typeof options.onDiagnostic === 'function' ? options.onDiagnostic : () => {}
    this.module = createPersonalContextModule({ storage: this.gateway })
    this.controller = new PersonalContextController({
      module: this.module,
      readScopeDirectory: (command) => this.gateway.personalContextManage(command),
      getConfig: () => this.config.get(),
      updateAgentSettings: (request) => this.updateAgentSettings(request),
      onChanged: this.onChanged
    })
    this.executionAdapter = null
    if (options.executionAdapter) this.executionAdapter = options.executionAdapter
    else if (typeof this.gateway.preparePersonalContextSessionIngest === 'function') {
      this.executionAdapter = createPersonalContextExecutionAdapter({ storage: this.gateway })
    }
    this.runner = new ContextIngestSessionRunner({
      personalContext: (options.modelAccess && (options.loop || options.loopFactory) && this.executionAdapter)
        ? this.executionAdapter
        : this.module,
      storage: this.gateway,
      modelAccess: options.modelAccess,
      interactions: options.interactions || {
        create: (request) => this.gateway.createAgentInteraction(request),
        terminalize: (request) => this.gateway.terminalizeAgentInteraction(request),
        startToolCall: (request) => this.gateway.startAgentToolCall(request),
        finishToolCall: (request) => this.gateway.finishAgentToolCall(request)
      },
      loop: options.loop,
      loopFactory: options.loopFactory,
      resolveModel: options.resolveModel,
      now: options.now
    })
    this.scheduler = new FormalAgentJobScheduler({
      storage: this.gateway,
      runner: this.runner,
      getAutomaticPolicy: typeof this.gateway.applyPersonalContextAutomaticPolicy === 'function'
        ? () => {
            const settings = this.config.get()
            return {
              agentEnabled: settings.agentEnabled,
              automaticProcessingSince: settings.automaticProcessingSince,
              memoryEnabled: settings.memoryEnabled,
              memoryProcessingSince: settings.memoryProcessingSince
            }
          }
        : null,
      onDiagnostic: this.onDiagnostic
    })
    this.reconciler = new S1TerminalSessionReconciler({ getEligibility: options.getAutomaticEligibility })
    this.unsubscribe = null
    this.started = false
    this.generation = 0
    this.pendingReconciles = new Set()
    this.policyReady = typeof this.gateway.applyPersonalContextAutomaticPolicy !== 'function'
    this.policyPromise = Promise.resolve()
  }

  async updateAgentSettings (request) {
    const generation = ++this.generation
    const updated = this.config.updateAgentSettings(request)
    const policyPromise = this.refreshAutomaticPolicy(updated, generation)
    this.policyPromise = policyPromise.catch(() => false)
    try {
      await policyPromise
    } catch {
      throw policyFailure()
    }
    return updated
  }

  async refreshAutomaticPolicy (settings, generation) {
    const apply = this.gateway.applyPersonalContextAutomaticPolicy
    if (typeof apply !== 'function') {
      this.policyReady = true
      return null
    }
    this.policyReady = false
    try {
      const result = await apply.call(this.gateway, {
        agentEnabled: settings.agentEnabled,
        automaticProcessingSince: settings.automaticProcessingSince,
        memoryEnabled: settings.memoryEnabled,
        memoryProcessingSince: settings.memoryProcessingSince
      })
      if (generation === this.generation && (generation === 0 || this.started)) {
        this.policyReady = true
        const allowed = settings.agentEnabled === true && settings.memoryEnabled === true &&
          settings.automaticProcessingSince !== null && settings.memoryProcessingSince !== null
        if (!allowed && this.scheduler.activeRunId) this.scheduler.cancel(this.scheduler.activeRunId)
        if (allowed && this.scheduler.started) this.scheduler.wake('settings')
      }
      return result
    } catch (error) {
      if (generation === this.generation && (generation === 0 || this.started)) {
        this.policyReady = false
        void this.scheduler.stop()
        try { this.onDiagnostic({ code: 'AGENT_SCHEDULER_FAILED' }) } catch { /* observer isolation */ }
      }
      throw error
    }
  }

  isCurrent (generation) {
    return this.started && this.generation === generation
  }

  async cancelPrepared (prepared) {
    const runId = prepared?.runId
    if (typeof runId !== 'string' || typeof this.gateway.cancelPersonalContextSessionIngest !== 'function') return
    try { await this.gateway.cancelPersonalContextSessionIngest({ runId }) } catch { /* best effort cleanup */ }
  }

  start (recorder) {
    if (this.started) return false
    if (!recorder || typeof recorder.onTerminalCommitted !== 'function') throw new TypeError('recorder terminal seam is required')
    this.started = true
    const generation = ++this.generation
    this.policyPromise = this.refreshAutomaticPolicy(this.config.get(), generation).catch(() => false)
    this.unsubscribe = recorder.onTerminalCommitted((notice) => {
      const generation = this.generation
      const entry = { prepareStarted: false, promise: null }
      const task = (async () => {
        await this.policyPromise
        if (!this.isCurrent(generation) || !this.policyReady) return
        const result = await this.reconciler.reconcile(notice)
        if (!this.isCurrent(generation) ||
            result.eligibility !== 'ready' || !this.executionAdapter) return
        entry.prepareStarted = true
        const prepared = await this.runner.prepare({ sessionId: notice.sessionId, transcriptVersion: 'raw' })
        if (!this.isCurrent(generation)) {
          await this.cancelPrepared(prepared)
          return
        }
        if (!this.scheduler.started) this.scheduler.start()
        if (!this.isCurrent(generation)) return
        this.scheduler.wake('terminal-session')
      })()
      entry.promise = task
      this.pendingReconciles.add(entry)
      const cleanup = () => this.pendingReconciles.delete(entry)
      void task.then(cleanup, (error) => {
        cleanup()
        if (this.isCurrent(generation)) {
          try { this.onDiagnostic({ code: 'AGENT_SCHEDULER_FAILED' }) } catch { /* observer isolation */ }
        }
        return error
      })
    })
    return true
  }

  getOverview (request) {
    return this.controller.getOverview(request)
  }

  manage (request) {
    return this.controller.manage(request)
  }

  async stop () {
    this.generation += 1
    this.started = false
    if (this.unsubscribe) {
      try { this.unsubscribe() } catch { /* listener cleanup is best effort */ }
      this.unsubscribe = null
    }
    await this.scheduler.stop()
    const pendingPrepares = [...this.pendingReconciles]
      .filter((entry) => entry.prepareStarted && entry.promise)
      .map((entry) => entry.promise)
    await Promise.allSettled(pendingPrepares)
  }
}

module.exports = { PersonalContextRuntime }
