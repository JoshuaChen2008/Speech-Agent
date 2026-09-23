'use strict'

// J20 storage slice: only Electron's process boundary is substituted. The real
// recorder, gateway, RPC host/service, SQLite and history projection collaborate.
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { NLS_PARAMETERS } = require('../../src/contracts/recognition')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { HistoryService, buildExport } = require('../../src/main/services/history-service')
const { StorageWorkerHost } = require('../../src/runtime/storage-worker/worker-host')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')
const { OPERATIONS } = require('../../src/runtime/storage-worker/protocol')

function processBoundary () {
  return { utilityProcess: { fork () {
    const child = new EventEmitter()
    const service = new StorageWorkerService()
    child.postMessage = request => setImmediate(() => {
      child.emit('message', service.handle(structuredClone(request)))
      if (request.operation === OPERATIONS.SHUTDOWN) setImmediate(() => child.emit('exit', 0))
    })
    child.kill = () => { service.store?.close(); setImmediate(() => child.emit('exit', 0)) }
    return child
  } } }
}

test('SEM-F21/J20 cloud fallback facts survive RPC FIFO, close and restart without changing first-pass text', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nls-storage-journey-'))
  const databasePath = path.join(directory, 'subtitle.sqlite3')
  let gateway
  const createGateway = () => new StorageGateway({ databasePath,
    hostFactory: options => new StorageWorkerHost({ ...options, electron: processBoundary() }) })
  t.after(async () => { await gateway.shutdown(); fs.rmSync(directory, { recursive: true, force: true }) })
  gateway = createGateway()
  const recorder = new SqliteSessionRecorder({ gateway, now: () => 1000 })
  const recognition = { strategy: 'cloud-primary', provider: 'nls', region: 'cn-shanghai', configRevision: 2,
    projectRef: 'a'.repeat(64), modelLabel: '用户声明的项目模型', parameters: NLS_PARAMETERS }
  await recorder.openSession({ sessionId: 'cloud', sourceId: 'mic', recognition, refinementEnabled: false })
  const fact = { sessionId: 'cloud', actualProvider: 'local', fallbackCode: 'NLS_CONNECTION_CLOSED',
    fallbackAtMs: 1000, faultCode: null, faultAtMs: null }
  const caption = { schemaVersion: 1, sessionId: 'cloud', sourceId: 'mic', segmentId: 'nls-1',
    sequence: 1, revision: 1, kind: 'final', t0: 0, t1: 1, text: '首次稳定转写', translation: null }
  const write = recorder.acceptCaption(caption)
  const fallback = recorder.recordRecognitionStatus(fact)
  const duplicate = recorder.recordRecognitionStatus(fact)
  await Promise.all([write, fallback])
  assert.equal((await duplicate).status, 'already_processed')
  await recorder.recordRecognitionStatus({ ...fact, fallbackCode: null, fallbackAtMs: null,
    faultCode: 'RECOGNITION_BUFFER_LIMIT', faultAtMs: 3000 })
  await recorder.recordRecognitionStatus({ ...fact, fallbackCode: null, fallbackAtMs: null })
  await recorder.closeSession({ sessionId: 'cloud', sourceId: 'mic', state: 'closed' })
  await gateway.shutdown()
  gateway = createGateway()
  const history = new HistoryService({ gateway, showSaveDialog: async () => ({ canceled: true }) })
  const page = await history.getSessionPage({ sessionId: 'cloud', limit: 10, cursor: null })
  assert.deepEqual(page.recognition.binding, recognition)
  assert.equal(page.recognition.actualProvider, 'local')
  assert.equal(page.recognition.fallbackAtMs, 1000)
  assert.equal(page.recognition.faultAtMs, 3000)
  assert.equal(page.items[0].text, caption.text)
  const transcript = await gateway.getSessionTranscript('cloud')
  for (const format of ['txt', 'md', 'srt']) assert.ok(buildExport(transcript, format, 'original').content.includes(caption.text))
  assert.equal((await gateway.getStats()).captionEvents, 1)
})
