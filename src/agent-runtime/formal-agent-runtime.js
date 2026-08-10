'use strict'

// @ts-check

const MAX_RECOVERY_SESSION_IDS = 256
const ELIGIBILITY_PROVIDER_FACT_KEYS = Object.freeze([
  'providerId',
  'providerKind',
  'model',
  'credentialAvailable'
])
const AGENT_SETTINGS_UPDATE_KEYS = Object.freeze([
  'expectedRevision',
  'agentEnabled',
  'memoryEnabled',
  'cloudDisclosureAccepted'
])

class FormalAgentRuntimeError extends Error {
  constructor (code) {
    super(code)
    this.name = 'FormalAgentRuntimeError'
    this.code = code
  }
}

function runtimeError (code) {
  return new FormalAgentRuntimeError(code)
}

function exactObject (value, keys, code = 'AGENT_RUNTIME_REQUEST_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw runtimeError(code)
  const actual = Reflect.ownKeys(value)
  const expected = [...keys].sort()
  if (actual.some((key) => typeof key !== 'string')) throw runtimeError(code)
  actual.sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw runtimeError(code)
  }
  return value
}

function sessionId (value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160) {
    throw runtimeError('AGENT_RUNTIME_REQUEST_INVALID')
  }
  return value
}

function recoverySessionIds (value) {
  if (!Array.isArray(value) || value.length > MAX_RECOVERY_SESSION_IDS) {
    throw runtimeError('AGENT_RUNTIME_REQUEST_INVALID')
  }
  const result = value.map(sessionId)
  if (new Set(result).size !== result.length) throw runtimeError('AGENT_RUNTIME_REQUEST_INVALID')
  return result
}

function agentSettingsUpdate (value) {
  exactObject(value, AGENT_SETTINGS_UPDATE_KEYS)
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0 ||
      typeof value.agentEnabled !== 'boolean' || typeof value.memoryEnabled !== 'boolean' ||
      typeof value.cloudDisclosureAccepted !== 'boolean') {
    throw runtimeError('AGENT_RUNTIME_REQUEST_INVALID')
  }
  return Object.freeze({
    expectedRevision: value.expectedRevision,
    agentEnabled: value.agentEnabled,
    memoryEnabled: value.memoryEnabled,
    cloudDisclosureAccepted: value.cloudDisclosureAccepted
  })
}

function validOptionalTimestamp (value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0)
}

function selectAgentSettings (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.agentEnabled !== 'boolean' || typeof value.memoryEnabled !== 'boolean' ||
      !validOptionalTimestamp(value.automaticProcessingSince) ||
      !validOptionalTimestamp(value.memoryProcessingSince) ||
      typeof value.cloudDisclosureAccepted !== 'boolean' ||
      !Number.isSafeInteger(value.agentSettingsRevision) || value.agentSettingsRevision < 0 ||
      (value.automaticProcessingSince !== null) !== value.agentEnabled ||
      (value.memoryProcessingSince !== null) !== (value.agentEnabled && value.memoryEnabled)) {
    throw runtimeError('AGENT_RUNTIME_CONFIGURATION_INVALID')
  }
  return Object.freeze({
    agentEnabled: value.agentEnabled,
    automaticProcessingSince: value.automaticProcessingSince,
    memoryEnabled: value.memoryEnabled,
    memoryProcessingSince: value.memoryProcessingSince,
    cloudDisclosureAccepted: value.cloudDisclosureAccepted,
    agentSettingsRevision: value.agentSettingsRevision
  })
}

function selectProviderFacts (value) {
  exactObject(value, ELIGIBILITY_PROVIDER_FACT_KEYS, 'AGENT_RUNTIME_CONFIGURATION_INVALID')
  const configured = value.providerId !== null || value.providerKind !== null || value.model !== null
  if (typeof value.credentialAvailable !== 'boolean' ||
      (configured && (
        typeof value.providerId !== 'string' || value.providerId.length < 1 || value.providerId.length > 160 ||
        !['cloud', 'local'].includes(value.providerKind) ||
        typeof value.model !== 'string' || value.model.length < 1 || value.model.length > 160
      )) ||
      (!configured && (
        value.providerId !== null || value.providerKind !== null || value.model !== null ||
        value.credentialAvailable !== false
      ))) {
    throw runtimeError('AGENT_RUNTIME_CONFIGURATION_INVALID')
  }
  return Object.freeze({
    providerId: configured ? value.providerId : null,
    providerKind: configured ? value.providerKind : null,
    model: configured ? value.model : null,
    credentialAvailable: configured && value.credentialAvailable
  })
}

function buildAgentEligibilityContext ({ settings, providerFacts, localModelReady }) {
  const selectedSettings = selectAgentSettings(settings)
  const selectedProviderFacts = selectProviderFacts(providerFacts)
  if (typeof localModelReady !== 'boolean') {
    throw runtimeError('AGENT_RUNTIME_CONFIGURATION_INVALID')
  }
  return Object.freeze({
    agentEnabled: selectedSettings.agentEnabled,
    memoryEnabled: selectedSettings.memoryEnabled,
    automaticProcessingSince: selectedSettings.automaticProcessingSince,
    memoryProcessingSince: selectedSettings.memoryProcessingSince,
    providerId: selectedProviderFacts.providerId,
    providerKind: selectedProviderFacts.providerKind,
    model: selectedProviderFacts.model,
    cloudDisclosureAccepted: selectedSettings.cloudDisclosureAccepted,
    credentialAvailable: selectedProviderFacts.credentialAvailable,
    localModelReady
  })
}

function reconciliationKey (sessionIdValue, context) {
  return `${sessionIdValue}\u0000${JSON.stringify(context)}`
}

class FormalAgentRuntime {
  #storage
  #configStore
  #providerBootstrap
  #getLocalModelReady
  #onDiagnostic
  #controlTail
  #reconciliations
  #accepting
  #taskPolicyReady
  #taskPolicyRevision

  constructor (options = {}) {
    const storage = options.storage
    const configStore = options.configStore
    const providerBootstrap = options.providerBootstrap
    if (!storage || typeof storage.applyAgentTaskPolicy !== 'function' ||
        typeof storage.reconcileTerminalAgentSession !== 'function' ||
        typeof storage.isAgentTaskPolicyReady !== 'function') {
      throw new TypeError('formal Agent storage port is required')
    }
    if (!configStore || typeof configStore.get !== 'function' ||
        typeof configStore.updateAgentSettings !== 'function') {
      throw new TypeError('ConfigStore v2 is required')
    }
    if (!providerBootstrap || typeof providerBootstrap.getEligibilityProviderFacts !== 'function') {
      throw new TypeError('AgentProviderBootstrap is required')
    }
    if (options.getLocalModelReady !== undefined && typeof options.getLocalModelReady !== 'function') {
      throw new TypeError('getLocalModelReady must be a function')
    }
    if (options.onDiagnostic !== undefined && typeof options.onDiagnostic !== 'function') {
      throw new TypeError('onDiagnostic must be a function')
    }
    this.#storage = storage
    this.#configStore = configStore
    this.#providerBootstrap = providerBootstrap
    this.#getLocalModelReady = options.getLocalModelReady || (() => false)
    this.#onDiagnostic = options.onDiagnostic || (() => {})
    this.#controlTail = Promise.resolve()
    this.#reconciliations = new Map()
    this.#accepting = true
    this.#taskPolicyReady = false
    this.#taskPolicyRevision = null
  }

  #assertAccepting () {
    if (!this.#accepting) throw runtimeError('AGENT_RUNTIME_CLOSED')
  }

  #reportDiagnostic (code) {
    try {
      this.#onDiagnostic(Object.freeze({ code }))
    } catch {
      // Observer failures stay isolated from subtitles and Agent recovery.
    }
  }

  #enqueueControl (operation) {
    const pending = this.#controlTail.then(operation, operation)
    this.#controlTail = pending.catch(() => {})
    return pending
  }

  #contextFromSettings (settings) {
    return buildAgentEligibilityContext({
      settings,
      providerFacts: this.#providerBootstrap.getEligibilityProviderFacts(),
      localModelReady: this.#getLocalModelReady()
    })
  }

  getEligibilityContext () {
    this.#assertAccepting()
    return this.#contextFromSettings(this.#configStore.get())
  }

  isTaskPolicyReady () {
    if (!this.#accepting || !this.#taskPolicyReady) return false
    try {
      return this.#storage.isAgentTaskPolicyReady() === true
    } catch {
      return false
    }
  }

  getTaskPolicyRevision () {
    return this.isTaskPolicyReady() ? this.#taskPolicyRevision : null
  }

  async #applyTaskPolicy (settings) {
    this.#taskPolicyReady = false
    this.#taskPolicyRevision = null
    try {
      const selectedSettings = selectAgentSettings(settings)
      const context = this.#contextFromSettings(selectedSettings)
      const result = await this.#storage.applyAgentTaskPolicy({ eligibilityContext: context })
      if (this.#storage.isAgentTaskPolicyReady() !== true) {
        throw runtimeError('AGENT_TASK_POLICY_APPLY_FAILED')
      }
      this.#taskPolicyReady = true
      this.#taskPolicyRevision = selectedSettings.agentSettingsRevision
      return Object.freeze({ context, result })
    } catch (error) {
      this.#reportDiagnostic('AGENT_TASK_POLICY_APPLY_FAILED')
      throw error
    }
  }

  updateAgentSettings (request) {
    const selectedRequest = agentSettingsUpdate(request)
    return this.#enqueueControl(async () => {
      this.#assertAccepting()
      const settings = this.#configStore.updateAgentSettings(selectedRequest)
      const applied = await this.#applyTaskPolicy(settings)
      return Object.freeze({
        settings: Object.freeze({ ...settings }),
        taskPolicy: applied.result
      })
    })
  }

  #startReconciliation (sessionIdValue, context) {
    const key = reconciliationKey(sessionIdValue, context)
    const existing = this.#reconciliations.get(key)
    if (existing) return { coalesced: true, promise: existing }
    const pending = Promise.resolve().then(() => this.#storage.reconcileTerminalAgentSession({
      sessionId: sessionIdValue,
      requestedBy: 'automatic',
      eligibilityContext: context
    }))
    let tracked
    tracked = pending.finally(() => {
      if (this.#reconciliations.get(key) === tracked) this.#reconciliations.delete(key)
    })
    this.#reconciliations.set(key, tracked)
    return { coalesced: false, promise: tracked }
  }

  notifyMeetingStopped (input) {
    exactObject(input, ['sessionId'])
    if (!this.#accepting) return Object.freeze({ accepted: false, coalesced: false })
    if (!this.isTaskPolicyReady()) {
      this.#reportDiagnostic('AGENT_RECONCILE_FAILED')
      return Object.freeze({ accepted: false, coalesced: false })
    }
    let started
    try {
      started = this.#startReconciliation(sessionId(input.sessionId), this.getEligibilityContext())
    } catch {
      this.#reportDiagnostic('AGENT_RECONCILE_FAILED')
      return Object.freeze({ accepted: false, coalesced: false })
    }
    if (!started.coalesced) {
      void started.promise.catch(() => this.#reportDiagnostic('AGENT_RECONCILE_FAILED'))
    }
    return Object.freeze({ accepted: true, coalesced: started.coalesced })
  }

  recoverTerminalSessions (input) {
    exactObject(input, ['sessionIds'])
    const selectedSessionIds = recoverySessionIds(input.sessionIds)
    return this.#enqueueControl(async () => {
      this.#assertAccepting()
      const settings = this.#configStore.get()
      const applied = await this.#applyTaskPolicy(settings)
      const sessions = []
      for (const selectedSessionId of selectedSessionIds) {
        try {
          const started = this.#startReconciliation(selectedSessionId, applied.context)
          const result = await started.promise
          const jobs = Array.isArray(result.jobs) ? result.jobs : []
          sessions.push(Object.freeze({
            sessionId: selectedSessionId,
            status: 'reconciled',
            eligibility: result.eligibility,
            jobCount: jobs.length,
            createdJobCount: jobs.filter((entry) => entry?.status === 'created').length,
            alreadyProcessedJobCount: jobs.filter((entry) => entry?.status === 'already_processed').length
          }))
        } catch {
          this.#reportDiagnostic('AGENT_RECONCILE_FAILED')
          sessions.push(Object.freeze({
            sessionId: selectedSessionId,
            status: 'deferred',
            eligibility: null,
            jobCount: 0,
            createdJobCount: 0,
            alreadyProcessedJobCount: 0
          }))
        }
      }
      return Object.freeze({
        taskPolicy: applied.result,
        sessions: Object.freeze(sessions)
      })
    })
  }

  async whenIdle () {
    while (this.#reconciliations.size > 0) {
      await Promise.allSettled([...this.#reconciliations.values()])
    }
  }

  dispose () {
    this.#accepting = false
    this.#taskPolicyReady = false
    this.#taskPolicyRevision = null
  }
}

class MeetingStoppedPersistenceSink {
  constructor (options = {}) {
    const subtitleSink = options.subtitleSink
    const agentRuntime = options.agentRuntime
    if (!subtitleSink || typeof subtitleSink.openSession !== 'function' ||
        typeof subtitleSink.acceptCaption !== 'function' ||
        typeof subtitleSink.closeSession !== 'function' ||
        typeof subtitleSink.retry !== 'function' || typeof subtitleSink.flush !== 'function') {
      throw new TypeError('subtitle persistence sink is required')
    }
    if (!agentRuntime || typeof agentRuntime.notifyMeetingStopped !== 'function') {
      throw new TypeError('FormalAgentRuntime is required')
    }
    this.subtitleSink = subtitleSink
    this.agentRuntime = agentRuntime
  }

  #notifyAfter (operation, sessionIdValue) {
    void Promise.resolve(operation).then(
      () => {
        setImmediate(() => {
          try {
            this.agentRuntime.notifyMeetingStopped({ sessionId: sessionIdValue })
          } catch {
            // A best-effort Agent notification never changes subtitle durability.
          }
        })
      },
      () => {}
    ).catch(() => {})
    return operation
  }

  openSession (input) {
    return this.subtitleSink.openSession(input)
  }

  acceptCaption (event) {
    return this.subtitleSink.acceptCaption(event)
  }

  recordRefinementFault (input) {
    if (typeof this.subtitleSink.recordRefinementFault !== 'function') return false
    return this.subtitleSink.recordRefinementFault(input)
  }

  closeSession (input) {
    const operation = this.subtitleSink.closeSession(input)
    const selectedSessionId = typeof input?.sessionId === 'string' &&
      input.sessionId.length > 0 && input.sessionId.length <= 160
      ? input.sessionId
      : null
    return selectedSessionId === null ? operation : this.#notifyAfter(operation, selectedSessionId)
  }

  retry () {
    let terminalSessionId = null
    if (typeof this.subtitleSink.getActiveSession === 'function') {
      const active = this.subtitleSink.getActiveSession()
      const candidate = active?.closePayload?.sessionId
      if (typeof candidate === 'string' && candidate.length > 0 && candidate.length <= 160) {
        terminalSessionId = candidate
      }
    }
    const operation = this.subtitleSink.retry()
    return terminalSessionId === null ? operation : this.#notifyAfter(operation, terminalSessionId)
  }

  flush () {
    return this.subtitleSink.flush()
  }

  getActiveSession () {
    return typeof this.subtitleSink.getActiveSession === 'function'
      ? this.subtitleSink.getActiveSession()
      : null
  }
}

module.exports = {
  MAX_RECOVERY_SESSION_IDS,
  FormalAgentRuntime,
  FormalAgentRuntimeError,
  MeetingStoppedPersistenceSink,
  buildAgentEligibilityContext
}
