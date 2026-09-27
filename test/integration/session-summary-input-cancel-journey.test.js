'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const { EventEmitter } = require('node:events')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
const test = require('node:test')
const vm = require('node:vm')

const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { PersonalContextStore } = require('../../src/runtime/storage-worker/personal-context-store')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')

function createUtilityChild (service) {
  const child = new EventEmitter()
  const parentPort = new EventEmitter()
  let exited = false
  const exit = (code) => {
    if (exited) return
    exited = true
    setImmediate(() => child.emit('exit', code))
  }
  parentPort.postMessage = (message) => {
    if (!exited) setImmediate(() => child.emit('message', structuredClone(message)))
  }
  child.postMessage = (message) => {
    if (exited) throw new Error('utility child has exited')
    parentPort.emit('message', { data: message })
  }
  child.kill = () => exit(0)

  const entry = fs.readFileSync(path.join(__dirname, '../../src/runtime/storage-worker/storage-worker.js'), 'utf8')
  const serviceModule = {
    StorageWorkerService: class TestStorageWorkerService {
      constructor () { return service }
    }
  }
  const localRequire = (specifier) => {
    if (specifier === './worker-service') return serviceModule
    throw new Error(`unexpected storage worker dependency: ${specifier}`)
  }
  const wrapper = `(function (require, process, setImmediate) {\n${entry}\n})`
  vm.runInNewContext(wrapper, {})(localRequire, { parentPort, exit }, setImmediate)
  return child
}

function tick () {
  return new Promise((resolve) => setImmediate(resolve))
}

async function waitFor (predicate) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await tick()
  }
  throw new Error('storage worker did not begin the paginated session input read')
}

test('SEM-F38/J30-CANCEL real SQLite session and tool context reads yield and cancel without retiring storage', { timeout: 30000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-input-cancel-'))
  const databasePath = path.join(root, 'speech-agent.sqlite3')
  let reportFirstPage
  const firstPageRead = new Promise((resolve) => { reportFirstPage = resolve })
  const service = new StorageWorkerService({
    personalContextStoreFactory: (subtitleStore) => {
      const store = new PersonalContextStore({ subtitleStore })
      const readRows = store.getSessionInputRows.bind(store)
      store.getSessionInputRows = (...args) => {
        const rows = readRows(...args)
        if (rows.length > 0) reportFirstPage(rows.length)
        return rows
      }
      return store
    }
  })
  const gateway = new StorageGateway({
    databasePath,
    requestTimeoutMs: 5000,
    electron: {
      utilityProcess: {
        fork: () => createUtilityChild(service)
      }
    }
  })
  t.after(async () => {
    await gateway.shutdown().catch(() => gateway.terminate())
    fs.rmSync(root, { recursive: true, force: true })
  })

  const sessionId = 'session.input-cancel'
  await gateway.openSession({
    sessionId,
    sourceId: 'mic',
    startedAt: 1770000000000,
    refinementEnabled: false
  })
  for (let index = 0; index < 260; index += 1) {
    await gateway.appendCaption({
      schemaVersion: 1,
      sessionId,
      sourceId: 'mic',
      segmentId: `segment.${index}`,
      sequence: index + 1,
      revision: 1,
      kind: 'final',
      t0: index,
      t1: index + 1,
      text: `合成会话片段 ${index}`,
      translation: null
    })
  }
  await gateway.closeSession({ sessionId, sourceId: 'mic', endedAt: 1770000001000, state: 'closed' })
  const source = await gateway.derivePersonalContextSessionSource({ sessionId, transcriptVersion: 'raw' })
  const storageHost = gateway.host

  const controller = new AbortController()
  const read = gateway.readPersonalContextSessionInput(source, controller.signal)
  const firstPageCount = await firstPageRead
  assert.equal(firstPageCount, 128, 'cancellation begins after the first keyset page has been fetched')
  await waitFor(() => service.activeSessionInputReads.size === 1)
  const cancelledAt = performance.now()
  controller.abort()

  await assert.rejects(read, (error) => error?.code === 'AGENT_CANCELLED')
  const stats = await gateway.getStats()
  const cancellationMs = performance.now() - cancelledAt
  assert.ok(cancellationMs < 5000, `worker cancellation and subsequent storage command took ${cancellationMs}ms`)
  assert.equal(stats.sessions, 1)
  assert.equal(stats.captionEvents, 260)
  assert.equal(service.activeSessionInputReads.size, 0)
  assert.equal(gateway.faulted, false)
  assert.strictEqual(gateway.host, storageHost)
  assert.equal(storageHost.state, 'ready')

  const completeInput = await gateway.readPersonalContextSessionInput(source)
  assert.equal(completeInput.segmentCount, 260)
  assert.equal(completeInput.events[0].eventOrder > 0, true)
  assert.equal(completeInput.events.at(-1).segmentId, 'segment.259')

  const contextRun = await gateway.personalContextIngest(source)
  const remembered = await gateway.personalContextManage({
    type: 'remember',
    expected_revision: service.personalContextStore.contentRevision(),
    entry: {
      display_text: 'Synthetic context entry',
      kind: 'term',
      scope: { kind: 'global', reference: null }
    }
  })
  const toolRun = await gateway.createAgentRun({
    runId: 'run.tool-context-cancel',
    recipeId: 'qa.answer',
    recipeVersion: '1',
    scope: { kind: 'session', reference: sessionId },
    transcriptVersion: source.transcriptVersion,
    inputWatermark: { throughEventOrder: source.inputWatermark },
    inputDigest: source.inputDigest,
    requestedBy: 'user',
    clientIdempotencyKey: 'tool-context-cancel'
  })
  const database = service.personalContextStore.database
  const fromEventOrder = Number(database.prepare(`
    SELECT MIN(event_order) AS value FROM caption_events
    WHERE session_id = ? AND kind = 'final'
  `).get(sessionId).value)
  database.prepare(`
    INSERT INTO personal_context_evidence(
      evidence_id, ingest_run_id, memory_id, source_kind, session_id, interaction_id,
      transcript_version, input_watermark, from_event_order, through_event_order,
      input_digest, recipe_id, recipe_version, created_at
    ) VALUES (?, ?, ?, 'session', ?, NULL, 'raw', ?, ?, ?, ?, 'context.ingest.session', '1', ?)
  `).run(
    'evidence.tool-context-cancel', contextRun.runId, remembered.item.memory_id,
    sessionId, source.inputWatermark, fromEventOrder, source.inputWatermark,
    source.inputDigest, 1770000002000
  )
  let reportSourcePage
  const sourcePageRead = new Promise((resolve) => { reportSourcePage = resolve })
  const personalContextStore = service.personalContextStore
  const readSourceRows = personalContextStore.getToolContextSourceRows.bind(personalContextStore)
  let sourcePageReported = false
  personalContextStore.getToolContextSourceRows = (...args) => {
    const rows = readSourceRows(...args)
    if (!sourcePageReported && rows.length > 0) {
      sourcePageReported = true
      reportSourcePage(rows.length)
    }
    return rows
  }
  const toolController = new AbortController()
  const toolRead = gateway.readPersonalContextToolContext({ runId: toolRun.runId }, toolController.signal)
  const firstSourcePageCount = await sourcePageRead
  assert.equal(firstSourcePageCount, 128, 'tool context cancellation begins after the first source keyset page')
  const toolCancellationAt = performance.now()
  toolController.abort()
  await assert.rejects(toolRead, (error) => error?.code === 'AGENT_CANCELLED')
  const statsAfterToolCancel = await gateway.getStats()
  assert.ok(performance.now() - toolCancellationAt < 5000, 'tool context cancellation and the next SQLite command remain bounded')
  assert.equal(statsAfterToolCancel.sessions, 1)
  assert.equal(statsAfterToolCancel.captionEvents, 260)
  assert.equal(service.activeToolContextReads.size, 0)
  assert.equal(gateway.faulted, false)
  assert.strictEqual(gateway.host, storageHost)
  assert.equal(storageHost.state, 'ready')
})
