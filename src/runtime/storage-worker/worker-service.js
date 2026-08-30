'use strict'

// @ts-check

const { runDatabaseQualification } = require('./qualification')
const { FORMAL_AGENT_MIGRATIONS } = require('./schema')
const { SqliteSubtitleStore } = require('./subtitle-store')
const {
  OPERATIONS,
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
  publicError
} = require('./protocol')

class StorageWorkerService {
  constructor (options = {}) {
    this.storeFactory = options.storeFactory || ((storeOptions) => {
      try {
        return new SqliteSubtitleStore({ ...storeOptions, migrations: FORMAL_AGENT_MIGRATIONS })
      } catch (modelAccessMigrationError) {
        /* v6 is an optional Agent capability boundary. Reopen against the
           byte-stable v1-v5 catalog; checksum drift or an earlier failure will
           fail again, while an isolated v6 failure leaves subtitles usable. */
        const fallback = new SqliteSubtitleStore({
          ...storeOptions,
          migrations: FORMAL_AGENT_MIGRATIONS.slice(0, 5)
        })
        fallback.modelAccessUnavailable = true
        return fallback
      }
    })
    this.agentStoreFactory = options.agentStoreFactory || ((subtitleStore) => {
      /* 保持字幕系统对 Agent 运行时代码的物理惰性：只有正式 Agent 操作到达时
         才加载生命周期实现；字幕 open/append/close/history 不依赖该模块。 */
      const { FormalAgentStore } = require('./formal-agent-store')
      return new FormalAgentStore({ subtitleStore })
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
    this.agentStore = null
    this.personalContextStore = null
    this.modelAccessStore = null
    this.shuttingDown = false
  }

  requireStore () {
    if (!this.store) throw new StorageError('NOT_INITIALIZED')
    return this.store
  }

  requireAgentStore () {
    const store = this.requireStore()
    if (!this.agentStore) this.agentStore = this.agentStoreFactory(store)
    return this.agentStore
  }

  requirePersonalContextStore () {
    const store = this.requireStore()
    if (!this.personalContextStore) this.personalContextStore = this.personalContextStoreFactory(store)
    return this.personalContextStore
  }

  requireModelAccessStore () {
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
      return { initialized: true }
    }
    if (operation === OPERATIONS.OPEN_SESSION) {
      assertExactKeys(payload, ['sessionId', 'sourceId', 'startedAt', 'refinementEnabled'])
      assertIdempotencyKey(idempotencyKey, makeOpenSessionKey(payload.sessionId))
      return this.requireStore().openSession(payload)
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
    if (operation === OPERATIONS.AGENT_EVALUATE_ELIGIBILITY) {
      assertExactKeys(payload, ['sessionId', 'requestedBy', 'eligibilityContext'])
      return this.requireAgentStore().evaluateEligibility(payload)
    }
    if (operation === OPERATIONS.AGENT_RECONCILE_TERMINAL_SESSION) {
      assertExactKeys(payload, ['sessionId', 'requestedBy', 'eligibilityContext'])
      return this.requireAgentStore().reconcileTerminalSession(payload)
    }
    if (operation === OPERATIONS.AGENT_READ_INPUT_SNAPSHOT) {
      assertExactKeys(payload, ['inputRef'])
      return this.requireAgentStore().readInputSnapshot(payload)
    }
    if (operation === OPERATIONS.AGENT_REQUEST_JOB) {
      assertExactKeys(payload, ['inputRef', 'taskKind', 'clientIdempotencyKey', 'requestDigest', 'eligibilityContext'])
      return this.requireAgentStore().requestJob(payload)
    }
    if (operation === OPERATIONS.AGENT_CLAIM_NEXT_JOB) {
      assertExactKeys(payload, ['claimIdempotencyKey', 'owner', 'leaseMs', 'localWorkAllowed', 'availableTaskKinds'])
      return this.requireAgentStore().claimNextJob(payload)
    }
    if (operation === OPERATIONS.AGENT_RENEW_JOB_LEASE) {
      assertExactKeys(payload, ['runId', 'lease', 'newExpiresAt'])
      return this.requireAgentStore().renewJobLease(payload)
    }
    if (operation === OPERATIONS.AGENT_MARK_JOB_RETRY) {
      assertExactKeys(payload, ['runId', 'lease', 'errorCode', 'nextAttemptAt'])
      return this.requireAgentStore().markJobRetry(payload)
    }
    if (operation === OPERATIONS.AGENT_MARK_JOB_FAILED) {
      assertExactKeys(payload, ['runId', 'lease', 'errorCode'])
      return this.requireAgentStore().markJobFailed(payload)
    }
    if (operation === OPERATIONS.AGENT_REQUEST_CANCEL) {
      assertExactKeys(payload, ['runId'])
      return this.requireAgentStore().requestCancel(payload)
    }
    if (operation === OPERATIONS.AGENT_MARK_JOB_CANCELLED) {
      assertExactKeys(payload, ['runId', 'lease'])
      return this.requireAgentStore().markJobCancelled(payload)
    }
    if (operation === OPERATIONS.AGENT_COMMIT_ARTIFACT) {
      assertExactKeys(payload, ['runId', 'lease', 'artifact'])
      return this.requireAgentStore().commitArtifact(payload)
    }
    if (operation === OPERATIONS.AGENT_COMMIT_MEMORY_CANDIDATES) {
      assertExactKeys(payload, ['runId', 'lease', 'candidates'])
      return this.requireAgentStore().commitMemoryCandidates(payload)
    }
    if (operation === OPERATIONS.AGENT_READ_MEMORY_CONTEXT) {
      assertExactKeys(payload, ['scopeRefs', 'kinds', 'semanticKeys', 'maxItems', 'maxSerializedBytes'])
      return this.requireAgentStore().readMemoryContext(payload)
    }
    if (operation === OPERATIONS.AGENT_DELETE_MEMORY_ITEM) {
      assertExactKeys(payload, ['memoryId', 'deletionIdempotencyKey'])
      return this.requireAgentStore().deleteMemoryItem(payload)
    }
    if (operation === OPERATIONS.AGENT_APPLY_TASK_POLICY) {
      assertExactKeys(payload, ['eligibilityContext'])
      return this.requireAgentStore().applyTaskPolicy(payload)
    }
    if (operation === OPERATIONS.AGENT_GET_SESSION_DETAIL) {
      assertExactKeys(payload, ['sessionId', 'eligibilityContext'])
      return this.requireAgentStore().getSessionDetail(payload)
    }
    if (operation === OPERATIONS.AGENT_DELETE_SESSION_DATA) {
      assertExactKeys(payload, ['sessionId', 'deletionIdempotencyKey'])
      return this.requireAgentStore().deleteSessionData(payload)
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_INGEST) {
      assertExactKeys(payload, ['source'])
      return this.requirePersonalContextStore().ingest(payload.source)
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_RESOLVE) {
      assertExactKeys(payload, ['request'])
      return this.requirePersonalContextStore().resolve(payload.request)
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_MANAGE) {
      assertExactKeys(payload, ['command'])
      return this.requirePersonalContextStore().manage(payload.command)
    }
    if (operation === OPERATIONS.PERSONAL_CONTEXT_DELETE_SESSION_DATA) {
      assertExactKeys(payload, ['sessionId', 'deletionIdempotencyKey'])
      return this.requirePersonalContextStore().deleteSessionData(payload, this.requireAgentStore())
    }
    if (operation === OPERATIONS.FORMAL_AGENT_CLAIM_RUN) {
      assertExactKeys(payload, ['request'])
      return this.requirePersonalContextStore().claimNextFormalRun(payload.request)
    }
    if (operation === OPERATIONS.FORMAL_AGENT_NEXT_RUN_AT) {
      assertExactKeys(payload, [])
      return this.requirePersonalContextStore().nextFormalRunAt()
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
      assertExactKeys(payload, ['request', 'sessionSlotIds'])
      return this.requireModelAccessStore().bind(payload.request, payload.sessionSlotIds)
    }
    if (operation === OPERATIONS.SHUTDOWN) {
      assertExactKeys(payload, [])
      if (this.store) {
        this.store.close()
        this.store = null
      }
      this.agentStore = null
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
      return {
        version: PROTOCOL_VERSION,
        type: 'storage:response',
        requestId,
        ok: true,
        result
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
  }
}

module.exports = { StorageWorkerService }
