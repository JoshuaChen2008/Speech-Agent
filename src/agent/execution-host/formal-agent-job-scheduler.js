'use strict'

const crypto = require('node:crypto')

const DIAGNOSTIC = Object.freeze({ code: 'AGENT_SCHEDULER_FAILED' })

class FormalAgentJobScheduler {
  constructor (options = {}) {
    if (!options.storage || typeof options.storage.claimNextFormalAgentRun !== 'function' ||
        typeof options.storage.nextFormalAgentRunAt !== 'function') {
      throw new TypeError('formal Agent storage adapter is required')
    }
    if (!options.runner || typeof options.runner.run !== 'function') throw new TypeError('runner is required')
    this.storage = options.storage
    this.runner = options.runner
    this.requestedBy = options.requestedBy === undefined ? 'automatic' : options.requestedBy
    if (!['automatic', 'user'].includes(this.requestedBy)) throw new TypeError('requestedBy is invalid')
    this.owner = typeof options.owner === 'string' && options.owner.length > 0 ? options.owner : `scheduler.${crypto.randomUUID()}`
    this.leaseMs = Number.isSafeInteger(options.leaseMs) && options.leaseMs > 0 ? options.leaseMs : 30000
    this.retryMs = Number.isSafeInteger(options.retryMs) && options.retryMs > 0 ? options.retryMs : 1000
    this.now = typeof options.now === 'function' ? options.now : Date.now
    this.setTimer = typeof options.setTimer === 'function' ? options.setTimer : setTimeout
    this.clearTimer = typeof options.clearTimer === 'function' ? options.clearTimer : clearTimeout
    this.queue = typeof options.queueMicrotask === 'function' ? options.queueMicrotask : queueMicrotask
    this.onDiagnostic = typeof options.onDiagnostic === 'function' ? options.onDiagnostic : () => {}
    this.started = false
    this.stopped = false
    this.generation = 0
    this.wakeEpoch = 0
    this.draining = false
    this.queued = false
    this.timer = null
    this.pendingClaim = null
    this.activeController = null
    this.activeRunId = null
    this.claimSequence = 0
  }

  start () {
    if (this.started) return false
    this.started = true
    this.stopped = false
    this.generation += 1
    this.wake('start')
    return true
  }

  wake (_reason) {
    if (!this.started || this.stopped) return false
    this.wakeEpoch += 1
    this.cancelTimer()
    this.scheduleDrain(this.generation)
    return true
  }

  async stop () {
    if (this.stopped) return
    this.stopped = true
    this.generation += 1
    this.wakeEpoch += 1
    this.pendingClaim = null
    if (this.activeController) this.activeController.abort()
    this.activeController = null
    this.activeRunId = null
    this.cancelTimer()
  }

  cancel (runId) {
    if (typeof runId !== 'string' || runId.length === 0) return false
    if (this.activeRunId !== runId || !this.activeController) return false
    this.activeController.abort()
    return true
  }

  scheduleDrain (generation) {
    if (this.queued || this.draining) return
    this.queued = true
    this.queue(() => {
      this.queued = false
      if (!this.active(generation)) return
      void this.drain(generation)
    })
  }

  active (generation) {
    return this.started && !this.stopped && this.generation === generation
  }

  nextClaimIdentity () {
    if (!this.pendingClaim) {
      this.claimSequence += 1
      const identity = {
        claimIdempotencyKey: `${this.owner}.${this.claimSequence}`,
        owner: this.owner,
        leaseMs: this.leaseMs
      }
      /* Preserve the original automatic claim shape for the S1 scheduler.
         User work is filtered in storage with an explicit requestor so the
         two schedulers cannot wake each other into a spin loop. */
      if (this.requestedBy !== 'automatic') identity.requestedBy = this.requestedBy
      this.pendingClaim = Object.freeze(identity)
    }
    return this.pendingClaim
  }

  async drain (generation) {
    if (this.draining || !this.active(generation)) return
    this.draining = true
    try {
      while (this.active(generation)) {
        const observedEpoch = this.wakeEpoch
        let job
        try {
          job = await this.storage.claimNextFormalAgentRun(this.nextClaimIdentity())
          this.pendingClaim = null
        } catch {
          this.diagnostic()
          this.arm(this.retryMs, generation)
          return
        }
        if (!this.active(generation)) return
        if (job) {
          const controller = new AbortController()
          this.activeController = controller
          this.activeRunId = typeof job.runId === 'string' ? job.runId : job.attemptIdentity?.runId || null
          try {
            await this.runner.run({ ...job, signal: controller.signal })
          } catch {
            this.diagnostic()
          } finally {
            if (this.activeController === controller) this.activeController = null
            if (this.activeController === null) this.activeRunId = null
          }
          continue
        }
        let nextAt
        try {
          nextAt = await this.storage.nextFormalAgentRunAt(
            this.requestedBy === 'automatic' ? undefined : { requestedBy: this.requestedBy }
          )
        } catch {
          this.diagnostic()
          this.arm(this.retryMs, generation)
          return
        }
        if (!this.active(generation)) return
        if (observedEpoch !== this.wakeEpoch) continue
        if (nextAt !== null) {
          const delay = Math.max(0, nextAt - this.now())
          this.arm(delay, generation)
        }
        return
      }
    } finally {
      this.draining = false
      if (this.active(generation) && this.queued) this.scheduleDrain(generation)
    }
  }

  arm (delay, generation) {
    this.cancelTimer()
    this.timer = this.setTimer(() => {
      this.timer = null
      if (!this.active(generation)) return
      this.wake('timer')
    }, delay)
  }

  cancelTimer () {
    if (this.timer === null) return
    this.clearTimer(this.timer)
    this.timer = null
  }

  diagnostic () {
    try { this.onDiagnostic(DIAGNOSTIC) } catch { /* diagnostics are observational */ }
  }
}

module.exports = { DIAGNOSTIC, FormalAgentJobScheduler }
