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
  makeOpenSessionKey
} = require('../../src/runtime/storage-worker/protocol')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')

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

test('service composes protocol, real SQLite and subtitle semantics without SQL exposure', (t) => {
  const service = new StorageWorkerService()
  const databasePath = tempDatabase(t)
  let response = service.handle(request(OPERATIONS.INITIALIZE, { databasePath }))
  assert.equal(response.ok, true)

  const opened = { sessionId: 'session-1', sourceId: 'loopback', startedAt: 1000 }
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

  const queried = service.handle(request(OPERATIONS.GET_SESSION, { sessionId: 'session-1' }))
  assert.equal(queried.result.segments[0].text, '协议字幕。')
  assert.equal(service.handle(request(OPERATIONS.GET_STATS)).result.captionEvents, 1)

  const closed = { sessionId: 'session-1', sourceId: 'loopback', endedAt: 2000, state: 'closed' }
  assert.equal(service.handle(request(OPERATIONS.CLOSE_SESSION, closed, {
    idempotencyKey: makeCloseSessionKey(closed.sessionId)
  })).result.status, 'committed')
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
