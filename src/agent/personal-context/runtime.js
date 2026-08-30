'use strict'

const { createPersonalContextModule } = require('./index')
const { PersonalContextController } = require('./controller')
const {
  ContextIngestSessionRunner,
  FormalAgentJobScheduler,
  S1TerminalSessionReconciler
} = require('../execution-host')

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
      updateAgentSettings: (request) => this.config.updateAgentSettings(request),
      onChanged: this.onChanged
    })
    this.runner = new ContextIngestSessionRunner({ personalContext: this.module, storage: this.gateway })
    this.scheduler = new FormalAgentJobScheduler({
      storage: this.gateway,
      runner: this.runner,
      onDiagnostic: this.onDiagnostic
    })
    this.reconciler = new S1TerminalSessionReconciler()
    this.unsubscribe = null
    this.started = false
  }

  start (recorder) {
    if (this.started) return false
    if (!recorder || typeof recorder.onTerminalCommitted !== 'function') throw new TypeError('recorder terminal seam is required')
    this.unsubscribe = recorder.onTerminalCommitted((notice) => {
      void this.reconciler.reconcile(notice).then((result) => {
        /* S1 has no model-access fact and therefore cannot enter ready. Keep
           the scheduler detached until a later slice supplies that fact. */
        if (result.eligibility !== 'ready') return
        if (!this.scheduler.started) this.scheduler.start()
        this.scheduler.wake('terminal-session')
      }).catch(() => {
        try { this.onDiagnostic({ code: 'AGENT_SCHEDULER_FAILED' }) } catch { /* observer isolation */ }
      })
    })
    this.started = true
    return true
  }

  getOverview (request) {
    return this.controller.getOverview(request)
  }

  manage (request) {
    return this.controller.manage(request)
  }

  async stop () {
    if (this.unsubscribe) {
      try { this.unsubscribe() } catch { /* listener cleanup is best effort */ }
      this.unsubscribe = null
    }
    await this.scheduler.stop()
    this.started = false
  }
}

module.exports = { PersonalContextRuntime }
