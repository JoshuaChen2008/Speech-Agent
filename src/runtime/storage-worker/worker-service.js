'use strict'

// @ts-check

const { runDatabaseQualification } = require('./qualification')
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
  publicError
} = require('./protocol')

class StorageWorkerService {
  constructor (options = {}) {
    this.storeFactory = options.storeFactory || ((storeOptions) => new SqliteSubtitleStore(storeOptions))
    this.store = null
    this.shuttingDown = false
  }

  requireStore () {
    if (!this.store) throw new StorageError('NOT_INITIALIZED')
    return this.store
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
      assertExactKeys(payload, ['sessionId', 'sourceId', 'startedAt'])
      assertIdempotencyKey(idempotencyKey, makeOpenSessionKey(payload.sessionId))
      return this.requireStore().openSession(payload)
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
    if (operation === OPERATIONS.GET_STATS) {
      assertExactKeys(payload, [])
      return this.requireStore().getStats()
    }
    if (operation === OPERATIONS.SHUTDOWN) {
      assertExactKeys(payload, [])
      if (this.store) {
        this.store.close()
        this.store = null
      }
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
