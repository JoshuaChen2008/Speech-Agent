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
    this.getAutomaticPolicy = typeof options.getAutomaticPolicy === 'function' ? options.getAutomaticPolicy : null
    this.leaseMs = Number.isSafeInteger(options.leaseMs) && options.leaseMs > 0 ? options.leaseMs : 30000
    this.leaseRenewEveryMs = Number.isSafeInteger(options.leaseRenewEveryMs) && options.leaseRenewEveryMs > 0
      ? options.leaseRenewEveryMs
      : Math.max(1, Math.floor(this.leaseMs / 3))
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
    this.leaseTimer = null
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

  wake (reason) {
    if (!this.started || this.stopped) return false
    if (reason === 'settings') this.pendingClaim = null
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
    if (this.activeController) this.abortController(this.activeController, 'AGENT_SCHEDULER_STOPPED')
    this.activeController = null
    this.activeRunId = null
    this.cancelLeaseTimer()
    this.cancelTimer()
  }

  cancel (runId) {
    if (typeof runId !== 'string' || runId.length === 0) return false
    if (this.activeRunId !== runId || !this.activeController) return false
    this.abortController(this.activeController, 'AGENT_CANCELLED')
    return true
  }

  abortController (controller, code) {
    if (!controller || controller.signal.aborted) return false
    const reason = new Error(code)
    reason.code = code
    controller.abort(reason)
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
      else if (this.getAutomaticPolicy) {
        const policy = this.getAutomaticPolicy()
        if (policy && typeof policy === 'object' && !Array.isArray(policy)) identity.automaticPolicy = structuredClone(policy)
      }
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
          if (!job.attemptIdentity || typeof this.storage.renewFormalAgentRun !== 'function') {
            this.diagnostic()
            continue
          }
          const controller = new AbortController()
          this.activeController = controller
          this.activeRunId = typeof job.runId === 'string' ? job.runId : job.attemptIdentity?.runId || null
          this.armLeaseRenewal(job, controller, generation)
          try {
            await this.runner.run({ ...job, signal: controller.signal })
          } catch {
            this.diagnostic()
          } finally {
            if (this.activeController === controller) this.cancelLeaseTimer()
            if (this.activeController === controller) this.activeController = null
            if (this.activeController === null) this.activeRunId = null
          }
          continue
        }
        let nextAt
        try {
          let nextRequest
          if (this.requestedBy === 'automatic' && this.getAutomaticPolicy) {
            const policy = this.getAutomaticPolicy()
            nextRequest = policy ? { automaticPolicy: structuredClone(policy) } : undefined
          } else if (this.requestedBy !== 'automatic') {
            nextRequest = { requestedBy: this.requestedBy }
          }
          nextAt = await this.storage.nextFormalAgentRunAt(nextRequest)
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

  armLeaseRenewal (job, controller, generation) {
    this.cancelLeaseTimer()
    const attempt = job?.attemptIdentity
    if (!attempt || controller.signal.aborted) return
    try {
      this.leaseTimer = this.setTimer(() => {
        this.leaseTimer = null
        void this.renewLease(job, controller, generation)
      }, this.leaseRenewEveryMs)
    } catch {
      this.leaseLost(controller)
    }
  }

  async renewLease (job, controller, generation) {
    if (!this.active(generation) || this.activeController !== controller || controller.signal.aborted) return
    const attempt = job?.attemptIdentity
    if (!attempt || typeof this.storage.renewFormalAgentRun !== 'function') {
      this.leaseLost(controller)
      return
    }
    try {
      const renewed = await this.storage.renewFormalAgentRun({
        attemptIdentity: { ...attempt },
        leaseMs: this.leaseMs
      })
      if (!this.active(generation) || this.activeController !== controller || controller.signal.aborted) return
      const next = renewed?.attemptIdentity
      if (!next || next.runId !== attempt.runId || next.attempt !== attempt.attempt || next.owner !== attempt.owner ||
          !Number.isSafeInteger(next.leaseExpiresAt) || next.leaseExpiresAt <= attempt.leaseExpiresAt) {
        this.leaseLost(controller)
        return
      }
      attempt.leaseExpiresAt = next.leaseExpiresAt
      this.armLeaseRenewal(job, controller, generation)
    } catch {
      this.leaseLost(controller)
    }
  }

  leaseLost (controller) {
    if (controller !== this.activeController || controller.signal.aborted) return
    this.cancelLeaseTimer()
    this.diagnostic()
    this.abortController(controller, 'AGENT_LEASE_LOST')
  }

  cancelLeaseTimer () {
    if (this.leaseTimer === null) return
    this.clearTimer(this.leaseTimer)
    this.leaseTimer = null
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
