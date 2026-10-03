'use strict'

// @ts-check

const { runDatabaseQualification } = require('./qualification')
const { FORMAL_AGENT_MIGRATIONS } = require('./schema')
const { SqliteSubtitleStore } = require('./subtitle-store')
const {
  OPERATIONS,
  CONTROL_MESSAGES,
  LEGACY_IMPORT_KEYS,
  PROTOCOL_VERSION,
  StorageError,
  assertExactKeys,
  assertIdempotencyKey,
  assertRequestEnvelope,
  makeCaptionEventId,
  makeCloseSessionKey,
  makeLegacyImportKey,
  makeOpenSessionKey,
  makeRefinementFaultKey,
  makeRecognitionStatusKey,
  publicError
} = require('./protocol')

class StorageWorkerService {
  constructor (options = {}) {
    this.storeFactory = options.storeFactory || ((storeOptions) => {
      return new SqliteSubtitleStore({ ...storeOptions, migrations: FORMAL_AGENT_MIGRATIONS })
    })
    this.agentExecutionStoreFactory = options.agentExecutionStoreFactory || ((subtitleStore, personalContextStore) => {
      const { AgentExecutionStore } = require('./agent-execution-store')
      return new AgentExecutionStore({ subtitleStore, personalContextStore })
    })
    this.personalContextStoreFactory = options.personalContextStoreFactory || ((subtitleStore) => {
      const { PersonalContextStore } = require('./personal-context-store')
      return new PersonalContextStore({ subtitleStore })
    })
    this.modelAccessStoreFactory = options.modelAccessStoreFactory || ((subtitleStore) => {
      const { ModelAccessStore } = require('./model-access-store')
      return new ModelAccessStore({ subtitleStore })
    })
    this.store = null
    this.agentExecutionStore = null
    this.personalContextStore = null
    this.modelAccessStore = null
    this.activeSessionInputReads = new Map()
    this.activeToolContextReads = new Map()
    this.shuttingDown = false
  }

  requireStore () {
    if (!this.store) throw new StorageError('NOT_INITIALIZED')
    return this.store
  }

  requireDeletionStore () {
    const store = this.requireStore()
    this.assertAgentAvailable()
    const { SessionDeletionStore } = require('./session-deletion-store')
    return new SessionDeletionStore({ subtitleStore: store, personalContextStore: this.requirePersonalContextStore() })
  }

  assertAgentAvailable () {
    const code = this.requireStore().database?.retirementFailure
    if (code) throw new StorageError(code)
  }

  requirePersonalContextStore () {
    this.assertAgentAvailable()
    const store = this.requireStore()
    if (!this.personalContextStore) this.personalContextStore = this.personalContextStoreFactory(store)
    return this.personalContextStore
  }

  requireAgentExecutionStore () {
    this.assertAgentAvailable()
    const store = this.requireStore()
    if (store.agentExecutionUnavailable === true) throw new StorageError('AGENT_EXECUTION_UNAVAILABLE')
    if (!this.agentExecutionStore) this.agentExecutionStore = this.agentExecutionStoreFactory(store, this.requirePersonalContextStore())
    return this.agentExecutionStore
  }

  requireModelAccessStore () {
    this.assertAgentAvailable()
    const store = this.requireStore()
    if (store.modelAccessUnavailable === true) throw new StorageError('MODEL_ACCESS_UNAVAILABLE')
    if (!this.modelAccessStore) this.modelAccessStore = this.modelAccessStoreFactory(store)
    return this.modelAccessStore
  }

  execute (request) {
    const { operation, payload, idempotencyKey } = request
    if (this.shuttingDown) throw new StorageError('SHUTTING_DOWN')
    if (operation === OPERATIONS.DB0_QUALIFY) {
      assertExactKeys(payload, ['databasePath'])
      if (this.store) throw new StorageError('ALREADY_INITIALIZED')
      return runDatabaseQualification(payload.databasePath)
    }
    if (operation === OPERATIONS.INITIALIZE) {
      assertExactKeys(payload, ['databasePath'])
      if (this.store) throw new StorageError('ALREADY_INITIALIZED')
      this.store = this.storeFactory({ databasePath: payload.databasePath })
      return { initialized: true, ...(this.store.database?.retirementFailure ? { retirementFailure: this.store.database.retirementFailure } : {}) }
    }
    if (operation === OPERATIONS.OPEN_SESSION) {
      assertExactKeys(payload, ['sessionId', 'sourceId', 'startedAt', 'refinementEnabled',
        ...(Object.hasOwn(payload, 'recognition') ? ['recognition'] : [])])
      assertIdempotencyKey(idempotencyKey, makeOpenSessionKey(payload.sessionId))
      return this.requireStore().openSession(payload)
    }
    if (operation === OPERATIONS.RECORD_RECOGNITION_STATUS) {
      assertExactKeys(payload, ['sessionId', 'actualProvider', 'fallbackCode', 'fallbackAtMs', 'faultCode', 'faultAtMs'])
      assertIdempotencyKey(idempotencyKey, makeRecognitionStatusKey(payload))
      return this.requireStore().recordRecognitionStatus(payload)
    }
    if (operation === OPERATIONS.RECORD_REFINEMENT_FAULT) {
      assertExactKeys(payload, ['sessionId', 'faultCode', 'faultAtMs'])
      assertIdempotencyKey(idempotencyKey, makeRefinementFaultKey(payload.sessionId, payload.faultCode))
      return this.requireStore().recordRefinementFault(payload)
    }
    if (operation === OPERATIONS.APPEND_CAPTION) {
      assertExactKeys(payload, ['event'])
      assertIdempotencyKey(idempotencyKey, makeCaptionEventId(payload.event || {}))
      return this.requireStore().appendCaption(payload.event)
    }
    if (operation === OPERATIONS.CLOSE_SESSION) {
      assertExactKeys(payload, ['sessionId', 'sourceId', 'endedAt', 'state'])
      assertIdempotencyKey(idempotencyKey, makeCloseSessionKey(payload.sessionId))
      return this.requireStore().closeSession(payload)
    }
    if (operation === OPERATIONS.RECOVER_STALE_SESSIONS) {
      assertExactKeys(payload, ['recoveredAt'])
      return this.requireStore().recoverStaleSessions(payload)
    }
    if (operation === OPERATIONS.IMPORT_LEGACY_JSONL) {
      assertExactKeys(payload, LEGACY_IMPORT_KEYS)
      assertIdempotencyKey(idempotencyKey, makeLegacyImportKey(payload.sourceSha256))
      return this.requireStore().importLegacyJsonl(payload)
    }
    if (operation === OPERATIONS.GET_SESSION) {
      assertExactKeys(payload, ['sessionId'])
      return this.requireStore().getSessionTranscript(payload)
    }
    if (operation === OPERATIONS.GET_SESSION_PAGE) {
      assertExactKeys(payload, ['sessionId', 'limit', 'cursor'])
      return this.requireStore().getSessionPage(payload)
    }
    if (operation === OPERATIONS.LIST_SESSIONS) {
      assertExactKeys(payload, ['limit', 'cursor'])
      return this.requireStore().listSessions(payload)
    }
    if (operation === OPERATIONS.GET_STATS) {
      assertExactKeys(payload, [])
      return this.requireStore().getStats()
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_INGEST) {
      assertExactKeys(payload, ['source'])
      return this.requirePersonalContextStore().ingest(payload.source)
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_RESOLVE) {
      assertExactKeys(payload, ['request'])
      if (payload.request?.schemaVersion === 2) {
        const { PersonalMemoryIndexStore } = require('./personal-memory-index-store')
        const request = payload.request
        if (!Object.hasOwn(request, 'vectorRanks')) assertExactKeys(request, ['schemaVersion', 'scope', 'query', 'semantic_keys', 'aliases'])
        return new PersonalMemoryIndexStore(this.requirePersonalContextStore()).resolve({ vectorRanks: [], degradation: 'embedding_disabled', ...request })
      }
      return this.requirePersonalContextStore().resolve(payload.request)
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_MANAGE) {
      assertExactKeys(payload, ['command'])
      return this.requirePersonalContextStore().manage(payload.command)
    }
    if (operation === OPERATIONS.PERSONAL_MEMORY_FILES) {
      assertExactKeys(payload, ['command'])
      const { PersonalMemoryFileStore } = require('./personal-memory-file-store')
      return new PersonalMemoryFileStore(this.requirePersonalContextStore()).operate(payload.command)
    }
    if (operation === OPERATIONS.PERSONAL_MEMORY_INDEX) {
      assertExactKeys(payload, ['command'])
      const { PersonalMemoryIndexStore } = require('./personal-memory-index-store')
      return new PersonalMemoryIndexStore(this.requirePersonalContextStore()).operate(payload.command)
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_DELETE_SESSION_DATA) {
      assertExactKeys(payload, ['sessionId', 'deletionIdempotencyKey'])
      return this.requireDeletionStore().deleteSessionData(payload)
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_PREPARE_SESSION_INGEST) {
      assertExactKeys(payload, ['request'])
      return this.requirePersonalContextStore().prepareSessionIngestRequest(payload.request)
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_APPLY_AUTOMATIC_POLICY) {
      assertExactKeys(payload, ['request'])
      return this.requirePersonalContextStore().applyAutomaticTaskPolicy(payload.request)
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_CANCEL_SESSION_INGEST) {
      assertExactKeys(payload, ['request'])
      return this.requirePersonalContextStore().cancelSessionIngest(payload.request)
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_DERIVE_SESSION_SOURCE) {
      assertExactKeys(payload, ['request'])
      return this.requirePersonalContextStore().deriveSessionSource(payload.request)
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_READ_SESSION_INPUT) {
      assertExactKeys(payload, ['source'])
      return this.readSessionInputRequest(request.requestId, payload.source)
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_READ_SESSION_RANGE_PAGE) {
      assertExactKeys(payload, ['request'])
      return this.requirePersonalContextStore().readSessionInputRangePage(payload.request)
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_READ_TOOL_CONTEXT) {
      assertExactKeys(payload, ['request'])
      return this.readToolContextRequest(request.requestId, payload.request)
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_COMMIT_SESSION_INGEST) {
      assertExactKeys(payload, ['request'])
      return this.requirePersonalContextStore().commitSessionIngest(payload.request)
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_SESSION_EXPERIENCES) {
      assertExactKeys(payload, ['request'])
      return this.requirePersonalContextStore().sessionExperiences(payload.request)
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_QUESTION_EVIDENCE) {
      assertExactKeys(payload, ['request'])
      return this.requirePersonalContextStore().questionEvidence(payload.request)
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_PREPARE_INTERACTION_INGEST) {
      assertExactKeys(payload, ['request'])
      return this.requirePersonalContextStore().prepareInteractionIngestRequest(payload.request)
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_READ_INTERACTION_INPUT) {
      assertExactKeys(payload, ['source', 'ephemeral'])
      return this.requirePersonalContextStore().readInteractionInput(payload.source, payload.ephemeral)
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_COMMIT_INTERACTION_INGEST) {
      assertExactKeys(payload, ['request'])
      return this.requirePersonalContextStore().commitInteractionIngest(payload.request)
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_CANCEL_INTERACTION_INGEST) {
      assertExactKeys(payload, ['request'])
      return this.requirePersonalContextStore().cancelInteractionIngest(payload.request)
    }
    if (operation === OPERATIONS.FORMAL_AGENT_CLAIM_RUN) {
      assertExactKeys(payload, ['request'])
      return this.requirePersonalContextStore().claimNextFormalRun(payload.request)
    }
    if (operation === OPERATIONS.FORMAL_AGENT_RENEW_RUN_LEASE) {
      assertExactKeys(payload, ['request'])
      return this.requirePersonalContextStore().renewFormalRunLease(payload.request)
    }
    if (operation === OPERATIONS.SUMMARY_INPUT_PLAN) {
      assertExactKeys(payload, ['request'])
      return this.requirePersonalContextStore().summaryInputPlan(payload.request)
    }
    if (operation === OPERATIONS.FORMAL_AGENT_RESERVE_MODEL_REQUEST) {
      assertExactKeys(payload, ['request'])
      return this.requirePersonalContextStore().reserveFormalAgentModelRequest(payload.request)
    }
    if (operation === OPERATIONS.FORMAL_AGENT_NEXT_RUN_AT) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          (Object.keys(payload).length !== 0 && !['requestedBy', 'automaticPolicy'].includes(Object.keys(payload).join(',')))) {
        throw new StorageError('AGENT_REQUEST_INVALID')
      }
      return this.requirePersonalContextStore().nextFormalRunAt(payload)
    }
    if (operation === OPERATIONS.FORMAL_AGENT_COMPLETE_RUN) {
      assertExactKeys(payload, ['request'])
      return this.requirePersonalContextStore().completeFormalRun(payload.request)
    }
    if (operation === OPERATIONS.FORMAL_AGENT_FAIL_RUN) {
      assertExactKeys(payload, ['request'])
      return this.requirePersonalContextStore().failFormalRun(payload.request)
    }
    if (operation === OPERATIONS.MODEL_ACCESS_CATALOG) {
      assertExactKeys(payload, [])
      return this.requireModelAccessStore().internalCatalog()
    }
    if (operation === OPERATIONS.MODEL_ACCESS_CONFIGURE) {
      assertExactKeys(payload, ['input'])
      return this.requireModelAccessStore().configure(payload.input)
    }
    if (operation === OPERATIONS.MODEL_ACCESS_BIND) {
      assertExactKeys(payload, ['request', 'availableSlotIds'])
      return this.requireModelAccessStore().bind(payload.request, payload.availableSlotIds)
    }
    if (operation === OPERATIONS.AGENT_CREATE_INTERACTION) {
      assertExactKeys(payload, ['request'])
      return this.requireAgentExecutionStore().createInteraction(payload.request)
    }
    if (operation === OPERATIONS.AGENT_CREATE_RUN) {
      assertExactKeys(payload, ['request'])
      return this.requireAgentExecutionStore().createRun(payload.request)
    }
    if (operation === OPERATIONS.AGENT_CANCEL_RUN) {
      assertExactKeys(payload, ['request'])
      return this.requireAgentExecutionStore().cancelRun(payload.request)
    }
    if (operation === OPERATIONS.AGENT_TERMINALIZE_INTERACTION) {
      assertExactKeys(payload, ['request'])
      return this.requireAgentExecutionStore().terminalizeInteraction(payload.request)
    }
    if (operation === OPERATIONS.AGENT_START_TOOL_CALL) {
      assertExactKeys(payload, ['request'])
      return this.requireAgentExecutionStore().startToolCall(payload.request)
    }
    if (operation === OPERATIONS.AGENT_FINISH_TOOL_CALL) {
      assertExactKeys(payload, ['request'])
      return this.requireAgentExecutionStore().finishToolCall(payload.request)
    }
    if (operation === OPERATIONS.AGENT_CREATE_PRESENTATION) {
      assertExactKeys(payload, ['request'])
      return this.requireAgentExecutionStore().createPresentation(payload.request)
    }
    if (operation === OPERATIONS.AGENT_MARK_PRESENTATION) {
      assertExactKeys(payload, ['request'])
      return this.requireAgentExecutionStore().markPresentation(payload.request)
    }
    if (operation === OPERATIONS.AGENT_LIST_INTERACTIONS) {
      assertExactKeys(payload, ['request'])
      return this.requireAgentExecutionStore().listInteractions(payload.request)
    }
    if (operation === OPERATIONS.AGENT_GET_INTERACTION) {
      assertExactKeys(payload, ['request'])
      return this.requireAgentExecutionStore().getInteraction(payload.request)
    }
    if (operation === OPERATIONS.SUMMARY_REQUEST_ACCEPT) {
      assertExactKeys(payload, ['request'])
      return this.requireAgentExecutionStore().acceptSessionSummaryRequest(payload.request)
    }
    if (operation === OPERATIONS.SUMMARY_REQUEST_GET) {
      assertExactKeys(payload, ['request'])
      return this.requireAgentExecutionStore().getSessionSummaryRequest(payload.request)
    }
    if (operation === OPERATIONS.SUMMARY_REQUEST_UPDATE) {
      assertExactKeys(payload, ['request'])
      return this.requireAgentExecutionStore().updateSessionSummaryRequest(payload.request)
    }
    if (operation === OPERATIONS.SUMMARY_REQUEST_CANCEL) {
      assertExactKeys(payload, ['request'])
      return this.requireAgentExecutionStore().cancelSessionSummaryRequest(payload.request)
    }
    if (operation === OPERATIONS.SUMMARY_REQUEST_RESUME) {
      assertExactKeys(payload, ['request'])
      return this.requireAgentExecutionStore().resumeSessionSummaryRequest(payload.request)
    }
    if (operation === OPERATIONS.SUMMARY_REQUEST_FAIL_UNRECOVERABLE) {
      assertExactKeys(payload, ['request'])
      return this.requireAgentExecutionStore().failUnrecoverableSessionSummaryRequest(payload.request)
    }
    if (operation === OPERATIONS.SUMMARY_REQUEST_RECOVER) {
      assertExactKeys(payload, [])
      return this.requireAgentExecutionStore().recoverSessionSummaryRequests()
    }
    if (operation === OPERATIONS.SUMMARY_REQUEST_LIST_RECOVERABLE) {
      assertExactKeys(payload, [])
      return this.requireAgentExecutionStore().listRecoverableSessionSummaryRequests()
    }
    if (operation === OPERATIONS.SHUTDOWN) {
      assertExactKeys(payload, [])
      if (this.store) {
        this.store.close()
        this.store = null
      }
      this.agentExecutionStore = null
      this.personalContextStore = null
      this.modelAccessStore = null
      this.shuttingDown = true
      return { stopped: true }
    }
    throw new StorageError('UNSUPPORTED_OPERATION')
  }

  handle (message) {
    let requestId = typeof message?.requestId === 'string' && message.requestId.length <= 128
      ? message.requestId
      : ''
    try {
      const request = assertRequestEnvelope(message)
      requestId = request.requestId
      const result = this.execute(request)
      const success = (value) => ({
        version: PROTOCOL_VERSION,
        type: 'storage:response',
        requestId,
        ok: true,
        result: value
      })
      if (result && typeof result.then === 'function') {
        return Promise.resolve(result).then(success, (error) => ({
          version: PROTOCOL_VERSION,
          type: 'storage:response',
          requestId,
          ok: false,
          error: publicError(error)
        }))
      }
      return success(result)
    } catch (error) {
      return {
        version: PROTOCOL_VERSION,
        type: 'storage:response',
        requestId,
        ok: false,
        error: publicError(error)
      }
    }
  }

  handleLeaseRenewalControl (message) {
    const requestId = typeof message?.requestId === 'string' && message.requestId.length <= 128
      ? message.requestId
      : ''
    try {
      assertExactKeys(message, ['version', 'type', 'requestId', 'request'], 'INVALID_REQUEST')
      if (message.version !== PROTOCOL_VERSION || message.type !== CONTROL_MESSAGES.RENEW_FORMAL_AGENT_RUN_LEASE ||
          typeof message.requestId !== 'string' || message.requestId.length < 1 || message.requestId.length > 128) {
        throw new StorageError('INVALID_REQUEST')
      }
    } catch (error) {
      return {
        version: PROTOCOL_VERSION,
        type: 'storage:response',
        requestId,
        ok: false,
        error: publicError(error)
      }
    }
    return this.handle({
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId,
      operation: OPERATIONS.FORMAL_AGENT_RENEW_RUN_LEASE,
      payload: { request: message.request }
    })
  }

  readSessionInputRequest (requestId, source) {
    const personalContextStore = this.requirePersonalContextStore()
    if (typeof personalContextStore.readSessionInputPaged !== 'function') {
      return personalContextStore.readSessionInput(source)
    }
    const activeRead = { cancelled: false }
    this.activeSessionInputReads.set(requestId, activeRead)
    return Promise.resolve()
      .then(() => personalContextStore.readSessionInputPaged(source, {
        isCancelled: () => activeRead.cancelled
      }))
      .finally(() => {
        if (this.activeSessionInputReads.get(requestId) === activeRead) {
          this.activeSessionInputReads.delete(requestId)
        }
      })
  }

  readToolContextRequest (requestId, input) {
    const personalContextStore = this.requirePersonalContextStore()
    const activeRead = { cancelled: false }
    this.activeToolContextReads.set(requestId, activeRead)
    const read = typeof personalContextStore.readToolContextPaged === 'function'
      ? personalContextStore.readToolContextPaged(input, { isCancelled: () => activeRead.cancelled })
      : Promise.resolve().then(() => personalContextStore.readToolContext(input))
    return Promise.resolve(read).finally(() => {
      if (this.activeToolContextReads.get(requestId) === activeRead) {
        this.activeToolContextReads.delete(requestId)
      }
    })
  }

  cancelPersonalContextReadControl (message) {
    try {
      assertExactKeys(message, ['version', 'type', 'requestId'], 'INVALID_REQUEST')
      if (message.version !== PROTOCOL_VERSION || message.type !== 'storage:cancel-personal-context-read' ||
          typeof message.requestId !== 'string' || message.requestId.length < 1 || message.requestId.length > 128) {
        return false
      }
      const activeRead = this.activeSessionInputReads.get(message.requestId) ||
        this.activeToolContextReads.get(message.requestId)
      if (!activeRead) return false
      activeRead.cancelled = true
      return true
    } catch {
      return false
    }
  }
}

module.exports = { StorageWorkerService }
