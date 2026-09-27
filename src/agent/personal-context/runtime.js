'use strict'

const { createPersonalContextExecutionAdapter, createPersonalContextModule } = require('./index')
const { PersonalContextController } = require('./controller')
const { canonicalize } = require('../../runtime/storage-worker/canonical-json')
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

const INTERACTION_SIGNAL_KINDS = new Set(['prompt', 'edit', 'accept', 'reject', 'remember', 'forget'])
const MAX_PENDING_INTERACTION_SIGNALS = 64

function interactionPayload (signalKind, value) {
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw policyFailure()
  const keys = Object.keys(value).sort()
  if (keys.length !== 3 || keys.join(',') !== 'editText,prompt,result') throw policyFailure()
  const text = (input) => {
    if (typeof input !== 'string' || input.length < 1 || input.length > 4096 ||
        /[\u0000-\u001f\u007f]/u.test(input) || Buffer.byteLength(input, 'utf8') > 16384) throw policyFailure()
    return input
  }
  const prompt = value.prompt === null ? null : text(value.prompt)
  const editText = value.editText === null ? null : text(value.editText)
  const result = value.result
  if (result !== null && (!result || typeof result !== 'object' || Array.isArray(result))) throw policyFailure()
  if (result !== null && Buffer.byteLength(canonicalize(result), 'utf8') > 65536) throw policyFailure()
  if (signalKind === 'prompt') {
    if (prompt === null || editText !== null) throw policyFailure()
  } else {
    if (prompt !== null || result === null) throw policyFailure()
    if (signalKind === 'edit' || signalKind === 'remember') {
      if (editText === null) throw policyFailure()
    } else if (editText !== null) throw policyFailure()
  }
  return structuredClone({ prompt, editText, result })
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
    this.interactionPayloads = new Map()
    this.interactionWaiters = new Map()
    this.pendingInteractionPrepares = new Set()
    this.runner = new ContextIngestSessionRunner({
      personalContext: (options.modelAccess && (options.loop || options.loopFactory) && this.executionAdapter)
        ? this.executionAdapter
        : this.module,
      storage: this.gateway,
      modelAccess: options.modelAccess,
      interactions: options.interactions || {
        create: (request, signal) => this.gateway.createAgentInteraction(request, signal),
        terminalize: (request, signal) => this.gateway.terminalizeAgentInteraction(request, signal),
        startToolCall: (request, signal) => this.gateway.startAgentToolCall(request, signal),
        finishToolCall: (request, signal) => this.gateway.finishAgentToolCall(request, signal)
      },
      loop: options.loop,
      loopFactory: options.loopFactory,
      resolveModel: options.resolveModel,
      now: options.now,
      interactionPayloadProvider: (runId) => this.interactionPayloads.get(runId) || null,
      onSettled: (runId, terminalReason) => this.settleInteraction(runId, terminalReason)
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
        if (!allowed) {
          await this.invalidateInteractionPayloads()
          if (this.scheduler.activeRunId) this.scheduler.cancel(this.scheduler.activeRunId)
        }
        if (allowed && this.scheduler.started) this.scheduler.wake('settings')
      }
      return result
    } catch (error) {
      if (generation === this.generation && (generation === 0 || this.started)) {
        this.policyReady = false
        await this.scheduler.stop()
        await Promise.allSettled([...this.pendingInteractionPrepares])
        await this.invalidateInteractionPayloads()
        try { this.onDiagnostic({ code: 'AGENT_SCHEDULER_FAILED' }) } catch { /* observer isolation */ }
      }
      throw error
    }
  }

  isCurrent (generation) {
    return this.started && this.generation === generation
  }

  policyAllows (settings = this.config.get()) {
    return settings?.agentEnabled === true && settings?.memoryEnabled === true &&
      settings?.automaticProcessingSince !== null && settings?.memoryProcessingSince !== null
  }

  settleInteraction (runId, terminalReason, completed = true) {
    if (typeof runId !== 'string') return
    this.interactionPayloads.delete(runId)
    const waiter = this.interactionWaiters.get(runId)
    if (!waiter) return
    this.interactionWaiters.delete(runId)
    waiter.resolve({ completed, terminalReason })
  }

  async invalidateInteractionPayloads () {
    const runIds = [...new Set([
      ...this.interactionPayloads.keys(),
      ...this.interactionWaiters.keys()
    ])]
    await Promise.allSettled(runIds.map((runId) => this.cancelPrepared({
      runId, recipeId: 'context.ingest.interaction'
    })))
    for (const runId of runIds) this.settleInteraction(runId, 'cancelled', false)
  }

  async cancelPrepared (prepared) {
    const runId = prepared?.runId
    if (typeof runId !== 'string') return
    const cancel = prepared?.recipeId === 'context.ingest.interaction' &&
      typeof this.gateway.cancelPersonalContextInteractionIngest === 'function'
      ? this.gateway.cancelPersonalContextInteractionIngest
      : this.gateway.cancelPersonalContextSessionIngest
    if (typeof cancel !== 'function') {
      this.settleInteraction(runId, 'cancelled', false)
      return null
    }
    try {
      const result = await cancel.call(this.gateway, { runId })
      if (result?.state === 'cancelled') this.settleInteraction(runId, 'cancelled', false)
      return result
    } catch {
      this.settleInteraction(runId, 'cancelled', false)
      return null
    }
  }

  async recordInteractionSignal (request) {
    if (!this.started || !this.policyReady || !this.executionAdapter ||
        typeof this.executionAdapter.prepareInteractionIngest !== 'function') {
      return { accepted: false, replayed: false }
    }
    if (!INTERACTION_SIGNAL_KINDS.has(request?.signalKind)) return { accepted: false, replayed: false }
    if (!this.policyAllows(this.config.get())) return { accepted: false, replayed: false }
    const generation = this.generation
    const transient = interactionPayload(request.signalKind, request.transient)
    const prepareTask = (async () => {
      const prepareRequest = {
        interactionId: request.interactionId,
        signalKind: request.signalKind,
        payloadDigest: request.payloadDigest || null
      }
      if (request.signalIdempotencyKey !== undefined) prepareRequest.signalIdempotencyKey = request.signalIdempotencyKey
      const prepared = await this.runner.prepare({ sourceKind: 'interaction', ...prepareRequest })
      const terminalState = ['succeeded', 'failed', 'cancelled'].includes(prepared?.state)
      if (!this.isCurrent(generation) || !this.policyReady || !this.policyAllows(this.config.get())) {
        await this.cancelPrepared({ ...prepared, recipeId: 'context.ingest.interaction' })
        return { accepted: false, replayed: prepared?.replayed === true, prepared }
      }
      if (prepared?.replayed === true && terminalState) {
        return {
          accepted: true,
          replayed: true,
          prepared,
          completed: true,
          terminalReason: prepared.state
        }
      }
      if (transient !== null && !this.interactionPayloads.has(prepared.runId) &&
          this.interactionPayloads.size >= MAX_PENDING_INTERACTION_SIGNALS) {
        await this.cancelPrepared({ ...prepared, recipeId: 'context.ingest.interaction' })
        return { accepted: false, replayed: prepared?.replayed === true, prepared }
      }
      if (transient !== null) this.interactionPayloads.set(prepared.runId, transient)
      let completion = null
      if (request.awaitCompletion === true) {
        completion = new Promise((resolve) => this.interactionWaiters.set(prepared.runId, { resolve, generation }))
      }
      if (!this.isCurrent(generation) || !this.policyReady || !this.policyAllows(this.config.get())) {
        await this.cancelPrepared({ ...prepared, recipeId: 'context.ingest.interaction' })
        return { accepted: false, replayed: prepared?.replayed === true, prepared }
      }
      if (!this.scheduler.started) this.scheduler.start()
      if (!this.isCurrent(generation)) {
        await this.cancelPrepared({ ...prepared, recipeId: 'context.ingest.interaction' })
        return { accepted: false, replayed: prepared?.replayed === true, prepared }
      }
      this.scheduler.wake('interaction-signal')
      return { accepted: true, replayed: prepared?.replayed === true, prepared, completion }
    })()
    this.pendingInteractionPrepares.add(prepareTask)
    void prepareTask.then(
      () => this.pendingInteractionPrepares.delete(prepareTask),
      () => this.pendingInteractionPrepares.delete(prepareTask)
    )
    const preparedResult = await prepareTask
    if (preparedResult.accepted !== true || request.awaitCompletion !== true || !preparedResult.completion) {
      const { completion, ...result } = preparedResult
      return result
    }
    const outcome = await preparedResult.completion
    return {
      accepted: true,
      replayed: preparedResult.replayed,
      prepared: preparedResult.prepared,
      completed: outcome.completed === true,
      terminalReason: outcome.terminalReason
    }
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
    await Promise.allSettled([...this.pendingInteractionPrepares])
    const pendingPrepares = [...this.pendingReconciles]
      .filter((entry) => entry.prepareStarted && entry.promise)
      .map((entry) => entry.promise)
    await Promise.allSettled(pendingPrepares)
    await this.invalidateInteractionPayloads()
    for (const runId of [...this.interactionWaiters.keys()]) this.settleInteraction(runId, 'cancelled', false)
    for (const runId of [...this.interactionPayloads.keys()]) this.interactionPayloads.delete(runId)
  }
}

module.exports = { PersonalContextRuntime }
