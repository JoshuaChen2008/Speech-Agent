'use strict'

// J20: production settings/provider/router/coordinator/worker/SQLite/reducer.
// Only network, Electron process/MessagePort and capture-device boundaries are
// controlled. The null local recognizer proves transport, never ASR quality.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createRequire } = require('node:module')
const { EventEmitter } = require('node:events')
const { RecognitionSettings } = require('../../src/main/recognition/recognition-settings')
const { NlsRealtimeProvider } = require('../../src/runtime/recognition/nls-realtime-provider')
const { RecognitionRuntimeAdapter } = require('../../src/runtime/recognition/recognition-runtime-adapter')
const { SessionCoordinator } = require('../../src/main/session/session-coordinator')
const { resolveRuntimeOptions, DEV_MODEL_VALUE } = require('../../src/main/runtime-options')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { HistoryService } = require('../../src/main/services/history-service')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')
const { OPERATIONS } = require('../../src/runtime/storage-worker/protocol')

const turn = () => new Promise(resolve => setImmediate(resolve))
async function until (predicate) {
  const deadline = Date.now() + 3000
  while (!predicate()) { if (Date.now() > deadline) assert.fail('boundary did not settle'); await new Promise(resolve => setTimeout(resolve, 5)) }
}

function boundaries () {
  const sockets = []; const captures = []; const children = []
  let rejectOpen = false
  let storageUnavailable = false
  class Socket extends EventEmitter {
    constructor () { super(); this.bufferedAmount = 0; this.bytes = 0; this.commands = []; sockets.push(this); setImmediate(() => this.emit('open')) }
    send (data, options, callback) {
      if (typeof options === 'function') callback = options
      if (typeof data === 'string') {
        const message = JSON.parse(data); this.taskId = message.header.task_id; this.commands.push(message.header.name)
        if (message.header.name === 'StartTranscription') {
          setImmediate(() => rejectOpen ? this.emit('error', new Error('network')) : this.result('TranscriptionStarted'))
        } else if (message.header.name === 'StopTranscription' && !this.withholdCompletion) {
          setImmediate(() => {
            if (this.bytes && !this.finalSent && !this.omitFinal) this.result('SentenceEnd', { index: 1, begin_time: 0, time: this.bytes / 32, result: '首次稳定转写' })
            this.result('TranscriptionCompleted')
          })
        }
      } else this.bytes += data.byteLength
      callback?.()
    }
    result (name, payload) {
      if (name === 'SentenceEnd') this.finalSent = true
      this.emit('message', Buffer.from(JSON.stringify({ header: { task_id: this.taskId, namespace: 'SpeechTranscriber', status: 20000000, name }, payload })), false)
    }
    ping () { this.emit('pong') }
    close () { this.closed = true; this.emit('close') }
    terminate () { this.close() }
  }
  function MessageChannelMain () {
    const a = new EventEmitter(); const b = new EventEmitter()
    for (const [port, peer] of [[a, b], [b, a]]) {
      port.postMessage = data => setImmediate(() => { if (!peer.closed) peer.emit('message', { data: structuredClone(data) }) })
      port.start = () => {}; port.close = () => { port.closed = true; port.removeAllListeners() }
    }
    this.port1 = a; this.port2 = b
  }
  const electron = {
    MessageChannelMain,
    utilityProcess: { fork (workerPath) {
      const child = new EventEmitter(); children.push(child)
      if (workerPath.includes('storage-worker')) {
        const service = new StorageWorkerService()
        child.storage = true
        child.postMessage = request => setImmediate(() => {
          if (storageUnavailable && request.operation === OPERATIONS.APPEND_CAPTION) {
            child.emit('exit', 1)
            service.store?.close()
            return
          }
          child.emit('message', service.handle(structuredClone(request)))
          if (request.operation === OPERATIONS.SHUTDOWN) setImmediate(() => child.emit('exit', 0))
        })
        child.kill = () => { service.store?.close(); setImmediate(() => child.emit('exit', 0)) }
      } else {
        const parentPort = new EventEmitter(); const timers = new Set()
        parentPort.postMessage = data => setImmediate(() => child.emit('message', structuredClone(data)))
        const processBoundary = { parentPort, exit: code => { for (const timer of timers) clearInterval(timer); setImmediate(() => child.emit('exit', code)) } }
        child.postMessage = (data, ports = []) => setImmediate(() => parentPort.emit('message', { data: structuredClone(data), ports }))
        child.kill = () => processBoundary.exit(0)
        const execute = new Function('require', 'process', 'setInterval', fs.readFileSync(workerPath, 'utf8'))
        execute(createRequire(workerPath), processBoundary, (...args) => { const timer = setInterval(...args); timers.add(timer); return timer })
      }
      return child
    } },
    ipcMain: { handle () {}, on () {}, removeHandler () {}, removeListener () {} },
    session: { fromPartition: () => ({ setPermissionCheckHandler () {}, setPermissionRequestHandler () {}, setDisplayMediaRequestHandler () {} }) },
    desktopCapturer: { getSources: async () => [] }, screen: { getPrimaryDisplay: () => ({ id: 1 }) },
    BrowserWindow: function () {
      const capture = { sequence: 0, port: null, stopped: false }; captures.push(capture)
      const win = Object.assign(new EventEmitter(), {
        destroyed: false,
        webContents: { mainFrame: 'main', setWindowOpenHandler () {}, on () {},
          postMessage (channel, payload, ports) { if (ports?.length) capture.port = ports[0] },
          async executeJavaScript (script) {
            if (script.startsWith('globalThis.startAudioCapture(')) {
              const invocation = JSON.parse(script.slice('globalThis.startAudioCapture('.length, -1))
              capture.sourceId = invocation.sourceIds[0]
              capture.port.postMessage({ type: 'ready', sessionId: invocation.sessionId, sourceIds: invocation.sourceIds })
              return { started: true }
            }
            if (script === 'globalThis.stopAudioCapture()') { capture.stopped = true; capture.port?.postMessage({ type: 'end' }); return { stopped: true, metrics: capture.stopMetrics || {} } }
            throw new Error('unexpected capture invocation')
          } },
        async loadFile () {}, isVisible: () => false, isDestroyed: () => win.destroyed,
        destroy: () => { win.destroyed = true }
      })
      capture.feed = () => {
        const sequence = capture.sequence++
        capture.port.postMessage({ type: 'frame', sourceId: capture.sourceId, sequence,
          timestampSeconds: sequence / 10, sampleCount: 1600, samples: new Float32Array(1600) })
      }
      return win
    }
  }
  return { electron, Socket, sockets, captures, children, rejectOpen: () => { rejectOpen = true },
    setStorageUnavailable: value => { storageUnavailable = value } }
}

async function fixture (t, sourceId = 'mic') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nls-runtime-'))
  const b = boundaries()
  let coordinator
  const settings = new RecognitionSettings({ directory: path.join(directory, 'settings'), isActive: () => !!coordinator?.getSnapshot().sessionId,
    tokenRequest: async () => ({ Token: { Id: 'external-token-fixture', ExpireTime: Math.floor(Date.now() / 1000) + 3600 } }) })
  settings.update({ expectedRevision: 0, strategy: 'cloud-primary', appKey: 'fixture-project', modelLabel: '用户说明', cloudDisclosureAccepted: true,
    credential: { accessKeyId: 'fixture-id', accessKeySecret: 'fixture-secret' } })
  const gateway = new StorageGateway({ databasePath: path.join(directory, 'subtitle.sqlite3'), electron: b.electron, maxRestarts: 1 })
  // Gateway owns a real worker host; its only injected boundary is Electron.
  const { StorageWorkerHost } = require('../../src/runtime/storage-worker/worker-host')
  gateway.hostFactory = options => new StorageWorkerHost({ ...options, electron: b.electron })
  const recorder = new SqliteSessionRecorder({ gateway })
  const adapter = new RecognitionRuntimeAdapter({ electron: b.electron, recognitionSettings: settings,
    providerFactory: options => new NlsRealtimeProvider({ ...options, WebSocket: b.Socket, timeoutMs: 300 }) })
  coordinator = new SessionCoordinator({ adapter, recognitionSettings: settings, persistenceSink: recorder,
    runtimeOptions: resolveRuntimeOptions({ LIVE_SUBTITLE_DEV_MODEL: DEV_MODEL_VALUE }),
    configuration: { onboardingCompleted: true, onboardingPreset: sourceId === 'mic' ? 'dictation' : 'meeting', mic: sourceId === 'mic', loopback: sourceId === 'loopback' } })
  t.after(async () => { await coordinator.dispose(); await gateway.shutdown(); settings.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  return { ...b, coordinator, adapter, settings, gateway, history: new HistoryService({ gateway, showSaveDialog: async () => ({ canceled: true }) }) }
}

test('SEM-F12/J20 closed handoff port stops capture with a durable failure', async t => {
  const f = await fixture(t)
  assert.equal((await f.coordinator.command('start')).ok, true)
  const sessionId = f.coordinator.getSnapshot().sessionId
  f.adapter.cloudPort.postMessage = () => { throw new Error('closed external port') }
  assert.doesNotThrow(() => f.sockets[0].emit('error', new Error('network')))
  await until(() => f.coordinator.getSnapshot().phase === 'error' && f.captures[0].stopped)
  assert.equal((await f.coordinator.command('stop')).ok, true)
  await f.coordinator.persistenceSink.flush()
  const result = await f.history.getSessionPage({ sessionId, limit: 20, cursor: null })
  assert.equal(result.recognition.actualProvider, 'nls')
  assert.equal(result.recognition.faultCode, 'RECOGNITION_FALLBACK_FAILED')
  assert.equal(f.adapter.router.pendingFallback, null)
})

test('SEM-F21/DB1/J20 missing recognition status persistence rejects cloud start', async t => {
  const f = await fixture(t)
  f.coordinator.persistenceSink.recordRecognitionStatus = undefined
  const result = await f.coordinator.command('start')
  assert.equal(result.ok, false)
  assert.equal(f.sockets.length, 0)
  assert.equal(f.captures.length, 0)
  assert.equal(f.coordinator.getSnapshot().sessionId, null)
})

for (const source of ['mic', 'loopback']) test(`SEM-F06/F21/J20 ${source} cloud pause/resume waits for stable text and persists one session`, async t => {
  const f = await fixture(t, source)
  assert.equal((await f.coordinator.command('start')).ok, true)
  const sessionId = f.coordinator.getSnapshot().sessionId
  f.captures.at(-1).feed(); f.captures.at(-1).feed()
  await until(() => f.sockets[0].bytes === 6400)
  f.sockets[0].result('SentenceBegin', { index: 1, time: 0 })
  f.sockets[0].result('TranscriptionResultChanged', { index: 1, time: 100, result: '临时字幕' })
  await turn()
  assert.equal((await f.coordinator.command('pause')).ok, true)
  assert.equal(f.coordinator.getSnapshot().phase, 'paused')
  assert.equal(f.sockets[0].commands.filter(x => x === 'StopTranscription').length, 1)
  assert.equal((await f.gateway.getStats()).captionEvents, 1)
  assert.throws(() => f.settings.update({ expectedRevision: 1, strategy: 'local-only',
    appKey: '', modelLabel: '', cloudDisclosureAccepted: false }), /NLS_SESSION_ACTIVE/)
  assert.equal((await f.coordinator.command('resume')).ok, true)
  assert.equal(f.coordinator.getSnapshot().sessionId, sessionId)
  f.captures.at(-1).feed()
  await until(() => f.sockets[1].bytes === 3200)
  assert.equal((await f.coordinator.command('stop')).ok, true)
  const page = await f.history.getSessionPage({ sessionId, limit: 20, cursor: null })
  assert.equal(page.items.length, 2)
  assert.equal(page.recognition.actualProvider, 'nls')
  assert.equal(page.refinement.refinementEnabled, false)
  assert.ok(page.items[1].t0Ms > page.items[0].t0Ms)
  assert.notEqual(f.sockets[0].taskId, f.sockets[1].taskId)
  assert.equal(Number.isFinite(f.adapter.getLastRunDiagnostics().recognition.eventLoopP99Ms), true)
})

test('SEM-F12/F21/J20 network loss closes cloud generation and retry/resume never reconnect in that session', async t => {
  const f = await fixture(t)
  assert.equal((await f.coordinator.command('start')).ok, true)
  const sessionId = f.coordinator.getSnapshot().sessionId
  f.captures.at(-1).feed()
  await until(() => f.sockets[0].bytes === 3200)
  f.sockets[0].result('SentenceEnd', { index: 1, begin_time: 0, time: 100, result: '保留原文' })
  f.sockets[0].close()
  await until(() => f.coordinator.getSnapshot().recognition.actualProvider === 'local')
  f.captures.at(-1).feed()
  assert.equal((await f.coordinator.command('pause')).ok, true)
  assert.equal((await f.coordinator.command('resume')).ok, true)
  f.captures.at(-1).feed()
  assert.equal((await f.coordinator.command('stop')).ok, true)
  assert.equal(f.sockets.length, 1)
  const page = await f.history.getSessionPage({ sessionId, limit: 20, cursor: null })
  assert.equal(page.items.length, 1)
  assert.equal(page.recognition.fallbackCode, 'NLS_CONNECTION_CLOSED')
  assert.equal(page.recognition.actualProvider, 'local')
})

test('SEM-F12/J20 startup network failure does not open capture or silently switch to local', async t => {
  const f = await fixture(t); f.rejectOpen()
  const result = await f.coordinator.command('start')
  assert.equal(result.ok, false)
  assert.equal(f.captures.length, 0)
  assert.equal(f.coordinator.getSnapshot().phase, 'error')
  assert.equal(f.coordinator.getSnapshot().recognition.actualProvider, 'nls')
})

test('SEM-F12/J20 audio gap releases capture, persists fault, and explicit retry stays local', async t => {
  const f = await fixture(t)
  assert.equal((await f.coordinator.command('start')).ok, true)
  const sessionId = f.coordinator.getSnapshot().sessionId
  f.captures.at(-1).sequence = 1
  f.captures.at(-1).feed()
  await until(() => f.coordinator.getSnapshot().phase === 'error')
  assert.equal(f.captures[0].stopped, true)
  assert.equal(f.coordinator.getSnapshot().lastError.code, 'RECOGNITION_AUDIO_GAP')
  assert.equal((await f.coordinator.command('retry')).ok, true)
  assert.equal(f.sockets.length, 1)
  f.captures.at(-1).feed()
  assert.equal((await f.coordinator.command('stop')).ok, true)
  const page = await f.history.getSessionPage({ sessionId, limit: 20, cursor: null })
  assert.equal(page.recognition.faultCode, 'RECOGNITION_AUDIO_GAP')
  assert.equal(page.recognition.actualProvider, 'local')
  assert.equal(page.items.length, 0)
})

test('SEM-F06/J20 stop timeout preserves accepted final and never promotes partial', async t => {
  const f = await fixture(t)
  assert.equal((await f.coordinator.command('start')).ok, true)
  const sessionId = f.coordinator.getSnapshot().sessionId
  f.captures.at(-1).feed(); f.captures.at(-1).feed()
  await until(() => f.sockets[0].bytes === 6400)
  const socket = f.sockets[0]
  socket.result('SentenceEnd', { index: 1, begin_time: 0, time: 100, result: '保留原文' })
  socket.result('SentenceBegin', { index: 2, time: 100 })
  socket.result('TranscriptionResultChanged', { index: 2, time: 200, result: '仅临时字幕' })
  socket.withholdCompletion = true
  const result = await f.coordinator.command('stop')
  assert.equal(result.ok, false)
  assert.equal(f.coordinator.getSnapshot().lastError.code, 'NLS_STOP_TIMEOUT')
  assert.equal((await f.coordinator.command('stop')).ok, true)
  const page = await f.history.getSessionPage({ sessionId, limit: 20, cursor: null })
  assert.equal(page.items.length, 1)
  assert.equal(page.items[0].text, '保留原文')
  assert.equal(page.recognition.faultCode, 'NLS_STOP_TIMEOUT')
  assert.equal(socket.commands.filter(x => x === 'StopTranscription').length, 1)
})

test('SEM-F12/J20 tail discarded by capture cannot be reported as successful cloud stop', async t => {
  const f = await fixture(t)
  assert.equal((await f.coordinator.command('start')).ok, true)
  f.captures[0].stopMetrics = { mic: { discardedAtStop: 1 } }
  const result = await f.coordinator.command('stop')
  assert.equal(result.ok, false)
  assert.equal(f.coordinator.getSnapshot().recognition.faultCode, 'RECOGNITION_AUDIO_GAP')
  assert.equal(f.captures[0].stopped, true)
})

test('SEM-F07/J20 storage loss during cloud pause is reported as storage failure', async t => {
  const f = await fixture(t)
  assert.equal((await f.coordinator.command('start')).ok, true)
  f.captures[0].feed()
  await until(() => f.sockets[0].bytes === 3200)
  f.setStorageUnavailable(true)
  const result = await f.coordinator.command('pause')
  assert.equal(result.ok, false)
  assert.equal(f.coordinator.getSnapshot().lastError.scope, 'storage')
  assert.equal(f.captures[0].stopped, true)
  f.setStorageUnavailable(false)
  const retry = await f.coordinator.command('retry')
  assert.equal(retry.ok, true, retry.code)
  assert.equal((await f.coordinator.command('stop')).ok, true)
})

test('SEM-F04/J20 completion without SentenceEnd rejects stop and removes the abandoned partial', async t => {
  const f = await fixture(t)
  assert.equal((await f.coordinator.command('start')).ok, true)
  f.captures[0].feed()
  await until(() => f.sockets[0].bytes === 3200)
  const socket = f.sockets[0]
  socket.result('SentenceBegin', { index: 1, time: 0 })
  socket.result('TranscriptionResultChanged', { index: 1, time: 100, result: '尚未稳定' })
  socket.omitFinal = true
  const result = await f.coordinator.command('stop')
  assert.equal(result.ok, false)
  assert.equal(f.coordinator.getSnapshot().recognition.faultCode, 'NLS_INVALID_RESPONSE')
  assert.equal((await f.gateway.getStats()).captionEvents, 0)
})
