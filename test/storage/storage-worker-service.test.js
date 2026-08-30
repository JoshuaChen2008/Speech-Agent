'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  OPERATIONS,
  PROTOCOL_VERSION,
  makeCaptionEventId,
  makeCloseSessionKey,
  makeLegacyImportKey,
  makeOpenSessionKey,
  makeRefinementFaultKey
} = require('../../src/runtime/storage-worker/protocol')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')
const { FORMAL_AGENT_MIGRATIONS } = require('../../src/runtime/storage-worker/schema')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')

function tempDatabase (t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-service-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'data', 'speech-agent.sqlite3')
}

function request (operation, payload = {}, overrides = {}) {
  return {
    version: PROTOCOL_VERSION,
    type: 'storage:request',
    requestId: `request-${operation}`,
    operation,
    payload,
    ...overrides
  }
}

function caption (overrides = {}) {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    sourceId: 'loopback',
    segmentId: 'segment-1',
    sequence: 1,
    revision: 1,
    kind: 'final',
    t0: 0,
    t1: 1,
    text: '协议字幕。',
    translation: null,
    ...overrides
  }
}

function legacyImport (overrides = {}) {
  const session = {
    sessionId: 'legacy-session-1',
    sourceId: 'loopback',
    startedAt: 1000,
    endedAt: 2000,
    state: 'closed'
  }
  const event = caption({
    sessionId: session.sessionId,
    sourceId: session.sourceId,
    segmentId: 'legacy-segment-1',
    text: '旧档案正文。'
  })
  return {
    sourceSha256: 'a'.repeat(64),
    sourceName: 'legacy-session.jsonl',
    importedAt: 3000,
    sourceRecordCount: 4,
    captionEventCount: 1,
    translatedEventCount: 1,
    corruptLineCount: 0,
    truncatedTail: false,
    session,
    captions: [event],
    ...overrides
  }
}

test('service composes protocol, real SQLite and subtitle semantics without SQL exposure', (t) => {
  const service = new StorageWorkerService()
  const databasePath = tempDatabase(t)
  let response = service.handle(request(OPERATIONS.INITIALIZE, { databasePath }))
  assert.equal(response.ok, true)

  const opened = {
    sessionId: 'session-1',
    sourceId: 'loopback',
    startedAt: 1000,
    refinementEnabled: true
  }
  response = service.handle(request(OPERATIONS.OPEN_SESSION, opened, {
    idempotencyKey: makeOpenSessionKey(opened.sessionId)
  }))
  assert.equal(response.result.status, 'committed')

  const final = caption()
  response = service.handle(request(OPERATIONS.APPEND_CAPTION, { event: final }, {
    idempotencyKey: makeCaptionEventId(final)
  }))
  assert.equal(response.result.status, 'committed')
  response = service.handle(request(OPERATIONS.APPEND_CAPTION, { event: final }, {
    idempotencyKey: makeCaptionEventId(final),
    requestId: 'different-transport-request'
  }))
  assert.equal(response.result.status, 'already_processed', 'requestId is correlation, not persistence identity')

  const fault = {
    sessionId: 'session-1',
    faultCode: 'REFINE_WORKER_EXITED',
    faultAtMs: 480
  }
  response = service.handle(request(OPERATIONS.RECORD_REFINEMENT_FAULT, fault, {
    idempotencyKey: makeRefinementFaultKey(fault.sessionId, fault.faultCode)
  }))
  assert.deepEqual(response.result, {
    status: 'committed', sessionId: 'session-1', faultCode: 'REFINE_WORKER_EXITED'
  })

  const queried = service.handle(request(OPERATIONS.GET_SESSION, { sessionId: 'session-1' }))
  assert.equal(queried.result.segments[0].text, '协议字幕。')
  assert.equal(service.handle(request(OPERATIONS.GET_SESSION_PAGE, {
    sessionId: 'session-1', limit: 50, cursor: null
  })).error.code, 'SESSION_ACTIVE')
  assert.equal(service.handle(request(OPERATIONS.GET_STATS)).result.captionEvents, 1)

  const closed = { sessionId: 'session-1', sourceId: 'loopback', endedAt: 2000, state: 'closed' }
  assert.equal(service.handle(request(OPERATIONS.CLOSE_SESSION, closed, {
    idempotencyKey: makeCloseSessionKey(closed.sessionId)
  })).result.status, 'committed')
  assert.deepEqual(service.handle(request(OPERATIONS.LIST_SESSIONS, {
    limit: 10, cursor: null
  })).result, {
    items: [{
      sessionId: 'session-1', mode: 'meeting', sourceId: 'loopback',
      startedAt: 1000, endedAt: 2000, state: 'closed', segmentCount: 1
    }],
    nextCursor: null
  })
  assert.deepEqual(service.handle(request(OPERATIONS.GET_SESSION_PAGE, {
    sessionId: 'session-1', limit: 50, cursor: null
  })).result, {
    session: {
      sessionId: 'session-1', mode: 'meeting', sourceId: 'loopback',
      startedAt: 1000, endedAt: 2000, state: 'closed'
    },
    totalCount: 1,
    refinement: {
      segmentCount: 1,
      refinedSegmentCount: 0,
      refinementResultStatus: 'known',
      refinementEnabled: true,
      refinementFaultCode: 'REFINE_WORKER_EXITED'
    },
    items: [{
      segmentId: 'segment-1', sourceId: 'loopback', text: '协议字幕。',
      refinedText: null, textRevision: 1, t0Ms: 0, t1Ms: 1000
    }],
    nextCursor: null
  })
  assert.equal(service.handle(request(OPERATIONS.SHUTDOWN)).ok, true)
  assert.equal(service.shuttingDown, true)
})

test('malformed, overprivileged and mismatched requests fail safely without poisoning the service', (t) => {
  const service = new StorageWorkerService()
  const databasePath = tempDatabase(t)
  const sentinel = 'SECRET_TRANSCRIPT_AND_C:\\private\\speech-agent.sqlite3'

  const invalidVersion = service.handle(request(OPERATIONS.GET_STATS, {}, {
    version: 99,
    requestId: 'bad-version'
  }))
  assert.equal(invalidVersion.requestId, 'bad-version')
  assert.equal(invalidVersion.error.code, 'INVALID_REQUEST')

  const extraSql = service.handle(request(OPERATIONS.INITIALIZE, {
    databasePath,
    sql: `DROP TABLE ${sentinel}`
  }, { requestId: 'extra-sql' }))
  assert.equal(extraSql.error.code, 'INVALID_REQUEST')
  assert.ok(!JSON.stringify(extraSql).includes(sentinel))

  assert.equal(service.handle(request(OPERATIONS.INITIALIZE, { databasePath })).ok, true)
  const opened = { sessionId: 'session-1', sourceId: 'loopback', startedAt: 1000 }
  const wrongKey = service.handle(request(OPERATIONS.OPEN_SESSION, opened, {
    idempotencyKey: 'caller-controlled-key'
  }))
  assert.equal(wrongKey.error.code, 'IDEMPOTENCY_KEY_MISMATCH')
  assert.equal(service.handle(request(OPERATIONS.GET_STATS)).result.sessions, 0)

  for (const invalidPayload of [
    { limit: 1, cursor: null, sql: `DROP TABLE sessions -- ${sentinel}` },
    { limit: 1, cursor: null, audioPath: sentinel },
    { limit: 0, cursor: null },
    { limit: 1, cursor: { startedAt: 1, sessionId: 's', sql: sentinel } }
  ]) {
    const rejectedList = service.handle(request(OPERATIONS.LIST_SESSIONS, invalidPayload))
    assert.equal(rejectedList.ok, false)
    assert.ok(['INVALID_REQUEST', 'INVALID_SESSION'].includes(rejectedList.error.code))
    assert.ok(!JSON.stringify(rejectedList).includes(sentinel))
  }

  for (const invalidPayload of [
    { sessionId: 'session-1', limit: 50, cursor: null, sql: sentinel },
    { sessionId: 'session-1', limit: 50, cursor: null, audioPath: sentinel },
    { sessionId: 'session-1', limit: 0, cursor: null },
    { sessionId: 'session-1', limit: 50, cursor: { t0Ms: 0, firstEventOrder: 1, id: sentinel } }
  ]) {
    const rejectedPage = service.handle(request(OPERATIONS.GET_SESSION_PAGE, invalidPayload))
    assert.equal(rejectedPage.ok, false)
    assert.ok(['INVALID_REQUEST', 'INVALID_SESSION'].includes(rejectedPage.error.code))
    assert.ok(!JSON.stringify(rejectedPage).includes(sentinel))
  }

  const overprivileged = service.handle(request(OPERATIONS.OPEN_SESSION, {
    ...opened,
    audioPath: sentinel,
    samples: [1, 2, 3]
  }, { idempotencyKey: makeOpenSessionKey(opened.sessionId) }))
  assert.equal(overprivileged.error.code, 'INVALID_REQUEST')
  assert.ok(!JSON.stringify(overprivileged).includes(sentinel))

  const validOpen = service.handle(request(OPERATIONS.OPEN_SESSION, opened, {
    idempotencyKey: makeOpenSessionKey(opened.sessionId)
  }))
  assert.equal(validOpen.ok, true, 'worker remains usable after invalid commands')
  for (const extra of [
    { audioPath: sentinel },
    { samples: [1, 2, 3] },
    { pcm: sentinel },
    { sql: `DROP TABLE caption_events -- ${sentinel}` }
  ]) {
    const eventWithExtraField = caption(extra)
    const rejected = service.handle(request(OPERATIONS.APPEND_CAPTION, { event: eventWithExtraField }, {
      idempotencyKey: makeCaptionEventId(eventWithExtraField)
    }))
    assert.equal(rejected.error.code, 'INVALID_CAPTION')
    assert.ok(!JSON.stringify(rejected).includes(sentinel))
  }
  const translated = caption({
    kind: 'translated', revision: 2, sequence: 2,
    translation: { language: 'en', text: sentinel, basedOnRevision: 1 }
  })
  const rejectedTranslation = service.handle(request(OPERATIONS.APPEND_CAPTION, { event: translated }, {
    idempotencyKey: makeCaptionEventId(translated)
  }))
  assert.equal(rejectedTranslation.error.code, 'UNSUPPORTED_CAPTION_KIND')
  assert.ok(!JSON.stringify(rejectedTranslation).includes(sentinel))
  assert.equal(service.handle(request(OPERATIONS.GET_STATS)).result.captionEvents, 0)
  service.handle(request(OPERATIONS.SHUTDOWN))
})

test('legacy import RPC is narrow, idempotent and cannot accept translation, audio, SQL or source paths', (t) => {
  const service = new StorageWorkerService()
  const databasePath = tempDatabase(t)
  const sentinel = 'SECRET_TRANSCRIPT_AND_C:\\private\\speech-agent.sqlite3'
  assert.equal(service.handle(request(OPERATIONS.INITIALIZE, { databasePath })).ok, true)

  const valid = legacyImport()
  const imported = service.handle(request(OPERATIONS.IMPORT_LEGACY_JSONL, valid, {
    idempotencyKey: makeLegacyImportKey(valid.sourceSha256)
  }))
  assert.equal(imported.ok, true)
  assert.equal(imported.result.status, 'imported')
  assert.equal(imported.result.captionEventCount, 1)
  assert.deepEqual(service.handle(request(OPERATIONS.GET_SESSION, {
    sessionId: valid.session.sessionId
  })).result.refinement, {
    segmentCount: 1,
    refinedSegmentCount: 0,
    refinementResultStatus: 'not_recorded',
    refinementEnabled: null,
    refinementFaultCode: null
  })
  const replay = service.handle(request(OPERATIONS.IMPORT_LEGACY_JSONL, {
    ...valid,
    importedAt: 4000
  }, {
    idempotencyKey: makeLegacyImportKey(valid.sourceSha256),
    requestId: 'legacy-replay'
  }))
  assert.equal(replay.result.status, 'already_processed')
  assert.equal(
    Number(service.store.database.prepare('SELECT event_count FROM legacy_imports').get().event_count),
    1,
    'legacy_imports.event_count is the imported final/refined fact count, not all JSONL records'
  )
  assert.deepEqual(service.handle(request(OPERATIONS.GET_STATS)).result, {
    sessions: 1,
    activeSessions: 0,
    captionEvents: 1,
    segments: 1,
    legacyImports: 1,
    journalMode: 'wal',
    integrity: 'ok'
  })

  for (const invalid of [
    legacyImport({ sourceSha256: 'b'.repeat(64), audioPath: sentinel }),
    legacyImport({ sourceSha256: 'c'.repeat(64), sql: `DROP TABLE ${sentinel}` }),
    legacyImport({ sourceSha256: 'd'.repeat(64), sourceName: sentinel }),
    legacyImport({
      sourceSha256: 'e'.repeat(64),
      captions: [caption({
        sessionId: 'legacy-session-1',
        sourceId: 'loopback',
        kind: 'translated',
        revision: 2,
        translation: { language: 'en', text: sentinel, basedOnRevision: 1 }
      })]
    }),
    legacyImport({
      sourceSha256: 'f'.repeat(64),
      captions: [caption({
        sessionId: 'legacy-session-1', sourceId: 'loopback', audioPath: sentinel
      })]
    })
  ]) {
    const response = service.handle(request(OPERATIONS.IMPORT_LEGACY_JSONL, invalid, {
      idempotencyKey: makeLegacyImportKey(invalid.sourceSha256)
    }))
    assert.equal(response.ok, false)
    assert.ok(!JSON.stringify(response).includes(sentinel))
  }
  assert.equal(service.handle(request(OPERATIONS.GET_STATS)).result.captionEvents, 1)
  service.handle(request(OPERATIONS.SHUTDOWN))
})

test('J15c fault RPC accepts only stable fault codes and never exposes free-text diagnostics', (t) => {
  const service = new StorageWorkerService()
  const databasePath = tempDatabase(t)
  assert.equal(service.handle(request(OPERATIONS.INITIALIZE, { databasePath })).ok, true)
  const opened = { sessionId: 'fault-contract', sourceId: 'loopback', startedAt: 1000, refinementEnabled: true }
  assert.equal(service.handle(request(OPERATIONS.OPEN_SESSION, opened, {
    idempotencyKey: makeOpenSessionKey(opened.sessionId)
  })).ok, true)
  const secret = 'raw stack and C:\\private\\capture.wav'
  const rejected = service.handle(request(OPERATIONS.RECORD_REFINEMENT_FAULT, {
    sessionId: opened.sessionId,
    faultCode: secret,
    faultAtMs: 1
  }, {
    idempotencyKey: makeRefinementFaultKey(opened.sessionId, secret)
  }))
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'INVALID_REFINEMENT_FAULT')
  assert.equal(JSON.stringify(rejected).includes(secret), false)
  service.handle(request(OPERATIONS.SHUTDOWN))
})

test('J15c storage service rejects refinement facts for a session frozen off', (t) => {
  const service = new StorageWorkerService()
  const databasePath = tempDatabase(t)
  assert.equal(service.handle(request(OPERATIONS.INITIALIZE, { databasePath })).ok, true)
  const opened = {
    sessionId: 'refinement-disabled',
    sourceId: 'loopback',
    startedAt: 1000,
    refinementEnabled: false
  }
  assert.equal(service.handle(request(OPERATIONS.OPEN_SESSION, opened, {
    idempotencyKey: makeOpenSessionKey(opened.sessionId)
  })).ok, true)

  const final = caption({ sessionId: opened.sessionId, text: '保留的原始版。' })
  assert.equal(service.handle(request(OPERATIONS.APPEND_CAPTION, { event: final }, {
    idempotencyKey: makeCaptionEventId(final),
    requestId: 'append-disabled-final'
  })).ok, true)
  const refined = caption({
    sessionId: opened.sessionId,
    sequence: 2,
    revision: 2,
    kind: 'refined',
    text: '不得写入的精修稿。'
  })
  const refinedResponse = service.handle(request(OPERATIONS.APPEND_CAPTION, { event: refined }, {
    idempotencyKey: makeCaptionEventId(refined),
    requestId: 'append-disabled-refined'
  }))
  assert.equal(refinedResponse.ok, false)
  assert.equal(refinedResponse.error.code, 'REFINEMENT_DISABLED')

  const fault = {
    sessionId: opened.sessionId,
    faultCode: 'REFINE_WORKER_EXITED',
    faultAtMs: 10
  }
  const faultResponse = service.handle(request(OPERATIONS.RECORD_REFINEMENT_FAULT, fault, {
    idempotencyKey: makeRefinementFaultKey(fault.sessionId, fault.faultCode),
    requestId: 'fault-disabled-refinement'
  }))
  assert.equal(faultResponse.ok, false)
  assert.equal(faultResponse.error.code, 'REFINEMENT_DISABLED')
  assert.equal(service.handle(request(OPERATIONS.GET_STATS)).result.captionEvents, 1)
  service.handle(request(OPERATIONS.SHUTDOWN))
})

test('stale recovery RPC is narrow and leaves immutable caption facts intact', (t) => {
  const service = new StorageWorkerService()
  const databasePath = tempDatabase(t)
  assert.equal(service.handle(request(OPERATIONS.INITIALIZE, { databasePath })).ok, true)
  const opened = { sessionId: 'stale-session', sourceId: 'mic', startedAt: 5000 }
  assert.equal(service.handle(request(OPERATIONS.OPEN_SESSION, opened, {
    idempotencyKey: makeOpenSessionKey(opened.sessionId)
  })).ok, true)
  const event = caption({
    sessionId: 'stale-session', sourceId: 'mic', sequence: 1, revision: 1
  })
  assert.equal(service.handle(request(OPERATIONS.APPEND_CAPTION, { event }, {
    idempotencyKey: makeCaptionEventId(event)
  })).ok, true)

  const rejected = service.handle(request(OPERATIONS.RECOVER_STALE_SESSIONS, {
    recoveredAt: 4000,
    audioPath: 'C:\\private\\capture.wav'
  }))
  assert.equal(rejected.error.code, 'INVALID_REQUEST')
  assert.equal(service.handle(request(OPERATIONS.GET_STATS)).result.activeSessions, 1)

  const recovered = service.handle(request(OPERATIONS.RECOVER_STALE_SESSIONS, {
    recoveredAt: 4000
  }))
  assert.deepEqual(recovered.result, { status: 'committed', recoveredSessionCount: 1 })
  const transcript = service.handle(request(OPERATIONS.GET_SESSION, { sessionId: 'stale-session' })).result
  assert.equal(transcript.session.state, 'interrupted')
  assert.equal(transcript.session.endedAt, 5000)
  assert.equal(transcript.segments[0].text, '协议字幕。')
  assert.deepEqual(service.handle(request(OPERATIONS.RECOVER_STALE_SESSIONS, {
    recoveredAt: 9000
  })).result, { status: 'none', recoveredSessionCount: 0 })
  service.handle(request(OPERATIONS.SHUTDOWN))
})

test('SEM-F00/SEM-F33/J25: model-access unavailable leaves subtitle operations independent', (t) => {
  const service = new StorageWorkerService({
    storeFactory: ({ databasePath }) => {
      const store = new SqliteSubtitleStore({ databasePath, migrations: FORMAL_AGENT_MIGRATIONS.slice(0, 5) })
      store.modelAccessUnavailable = true
      return store
    }
  })
  const databasePath = tempDatabase(t)
  assert.equal(service.handle(request(OPERATIONS.INITIALIZE, { databasePath })).ok, true)
  const unavailable = service.handle(request(OPERATIONS.MODEL_ACCESS_CATALOG))
  assert.equal(unavailable.ok, false)
  assert.equal(unavailable.error.code, 'MODEL_ACCESS_UNAVAILABLE')
  const opened = { sessionId: 'subtitle-without-model-access', sourceId: 'mic', startedAt: 1, refinementEnabled: false }
  assert.equal(service.handle(request(OPERATIONS.OPEN_SESSION, opened, {
    idempotencyKey: makeOpenSessionKey(opened.sessionId)
  })).ok, true)
  assert.equal(service.handle(request(OPERATIONS.GET_STATS)).result.activeSessions, 1)
  service.handle(request(OPERATIONS.SHUTDOWN))
})

test('SEM-F33/J25: model configuration revision conflict survives the real worker protocol', (t) => {
  const service = new StorageWorkerService()
  const databasePath = tempDatabase(t)
  assert.equal(service.handle(request(OPERATIONS.INITIALIZE, { databasePath })).ok, true)
  const response = service.handle(request(OPERATIONS.MODEL_ACCESS_CONFIGURE, {
    input: {
      command: {
        type: 'createProfile',
        expectedRevision: 99,
        profileId: 'profile.one',
        label: 'Profile One',
        httpsOrigin: 'https://example.test',
        basePath: '/'
      }
    }
  }))
  assert.equal(response.ok, false)
  assert.equal(response.error.code, 'MODEL_CONFIG_REVISION_CONFLICT')
  service.handle(request(OPERATIONS.SHUTDOWN))
})
