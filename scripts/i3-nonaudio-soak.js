'use strict'

// @ts-check

/*
 * I3 non-audio prequalification.
 *
 * This is deliberately not an I3 audio acceptance runner.  It feeds a
 * deterministic, two-hour *virtual* caption timeline into the production
 * Coordinator -> SQLite -> HistoryService composition.  The virtual clock is
 * explicit in the report so a fast run can never be confused with a real
 * two-hour microphone or loopback session.
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')

const { HistoryService } = require('../src/main/services/history-service')
const { computeProductPayloadIdentity } = require('../src/main/services/product-payload-identity')
const { SqliteSessionRecorder } = require('../src/main/services/sqlite-session-recorder')
const { StorageGateway } = require('../src/main/services/storage-gateway')
const { FakeRuntimeAdapter } = require('../src/main/session/fake-runtime-adapter')
const { SessionCoordinator } = require('../src/main/session/session-coordinator')
const { DEV_MODEL_VALUE, resolveRuntimeOptions } = require('../src/main/runtime-options')
const {
  OPERATIONS,
  PROTOCOL_VERSION,
  StorageError,
  makeCaptionEventId,
  makeCloseSessionKey,
  makeOpenSessionKey
} = require('../src/runtime/storage-worker/protocol')
const { SqliteSubtitleStore } = require('../src/runtime/storage-worker/subtitle-store')
const { StorageWorkerService } = require('../src/runtime/storage-worker/worker-service')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const DEV_RUNTIME = resolveRuntimeOptions({ LIVE_SUBTITLE_DEV_MODEL: DEV_MODEL_VALUE })
const PAGE_SIZE = 50
const MIN_SEGMENTS = 3000
const MIN_VIRTUAL_DURATION_MS = 2 * 60 * 60 * 1000
const DEFAULT_SEGMENT_COUNT = 3600
const DEFAULT_BATCH_SIZE = 100
const REFINE_EVERY = 9
const SESSION_START_MS = 1777900000000
const LIMITS = Object.freeze({
  maxCpuPercent: 800,
  maxDomNodes: PAGE_SIZE,
  maxHeapUsedBytes: 768 * 1024 * 1024,
  maxQueryP95Ms: 500,
  maxQueueDepth: 512,
  maxRssBytes: 1024 * 1024 * 1024,
  maxWalBytes: 64 * 1024 * 1024
})
const PROVENANCE_FILES = Object.freeze({
  historyRendererSha256: 'src/history/history.js',
  historyServiceSha256: 'src/main/services/history-service.js',
  runnerSha256: 'scripts/i3-nonaudio-soak.js',
  sessionCoordinatorSha256: 'src/main/session/session-coordinator.js',
  sqliteSessionRecorderSha256: 'src/main/services/sqlite-session-recorder.js',
  sqliteSubtitleStoreSha256: 'src/runtime/storage-worker/subtitle-store.js',
  strictEvidenceParserSha256: 'scripts/strict-evidence-json.js',
  storageGatewaySha256: 'src/main/services/storage-gateway.js',
  storageWorkerServiceSha256: 'src/runtime/storage-worker/worker-service.js',
  verifierSha256: 'scripts/verify-i3-nonaudio-report.js'
})

function exactKeys (value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has unexpected keys`)
  }
  return value
}

function allowedKeys (value, allowed, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  const allowlist = new Set(allowed)
  if (Object.keys(value).some((key) => !allowlist.has(key))) {
    throw new TypeError(`${label} has unexpected keys`)
  }
  return value
}

function positiveInteger (value, label, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new RangeError(`${label} must be an integer >= ${minimum}`)
  }
  return value
}

function sha256 (value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function canonicalTextProvenanceDigest (value) {
  if (!Buffer.isBuffer(value)) throw new TypeError('text provenance input must be a Buffer')
  const decoded = value.toString('utf8')
  if (!Buffer.from(decoded, 'utf8').equals(value)) {
    throw new Error('text provenance input must be valid UTF-8')
  }
  return sha256(Buffer.from(decoded.replace(/\r\n/g, '\n'), 'utf8'))
}

function currentProvenance () {
  return {
    ...Object.fromEntries(Object.entries(PROVENANCE_FILES).map(([name, relativePath]) => [
      name,
      canonicalTextProvenanceDigest(fs.readFileSync(path.join(PROJECT_ROOT, relativePath)))
    ])),
    productPayloadSha256: computeProductPayloadIdentity(path.join(PROJECT_ROOT, 'src')).sha256
  }
}

function percentile95 (values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('at least one query sample is required')
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.ceil(sorted.length * 0.95) - 1]
}

function durationMs (started) {
  return Number(process.hrtime.bigint() - started) / 1e6
}

function rounded (value, decimals = 3) {
  const multiplier = 10 ** decimals
  return Math.round(value * multiplier) / multiplier
}

function audioFilesUnder (directory) {
  const found = []
  const visit = (current) => {
    if (!fs.existsSync(current)) return
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (/\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)$/i.test(entry.name)) found.push(target)
    }
  }
  visit(directory)
  return found
}

function serviceBackedHost (service, databasePath) {
  let sequence = 0
  let started = false

  function call (operation, payload, idempotencyKey) {
    const response = service.handle({
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId: `i3-nonaudio-${++sequence}`,
      operation,
      payload,
      ...(idempotencyKey ? { idempotencyKey } : {})
    })
    if (!response.ok) throw new StorageError(response.error.code)
    return response.result
  }

  return {
    async start () {
      if (started) return
      call(OPERATIONS.INITIALIZE, { databasePath })
      started = true
    },
    async openSession (input) {
      return call(OPERATIONS.OPEN_SESSION, input, makeOpenSessionKey(input.sessionId))
    },
    async appendCaption (event) {
      return call(OPERATIONS.APPEND_CAPTION, { event }, makeCaptionEventId(event))
    },
    async closeSession (input) {
      return call(OPERATIONS.CLOSE_SESSION, input, makeCloseSessionKey(input.sessionId))
    },
    async getSessionTranscript (sessionId) {
      return call(OPERATIONS.GET_SESSION, { sessionId })
    },
    async getSessionPage (input) {
      return call(OPERATIONS.GET_SESSION_PAGE, input)
    },
    async listSessions (input) {
      return call(OPERATIONS.LIST_SESSIONS, input)
    },
    async getStats () {
      return call(OPERATIONS.GET_STATS, {})
    },
    async shutdown () {
      if (!service.shuttingDown) call(OPERATIONS.SHUTDOWN, {})
    },
    async terminateAndWait () {
      if (!service.shuttingDown) call(OPERATIONS.SHUTDOWN, {})
      return 0
    }
  }
}

function createGateway (databasePath) {
  const service = new StorageWorkerService({
    storeFactory: (options) => new SqliteSubtitleStore(options)
  })
  const gateway = new StorageGateway({
    databasePath,
    hostFactory: () => serviceBackedHost(service, databasePath),
    maxQueue: LIMITS.maxQueueDepth,
    maxRestarts: 0
  })
  return { gateway, service }
}

function caption (sessionId, index, sequence, intervalMs, refined = false) {
  const ordinal = String(index + 1).padStart(4, '0')
  const text = `${refined ? 'refined' : 'final'} fixture subtitle ${ordinal}`
  return {
    schemaVersion: 1,
    sessionId,
    sourceId: 'mic',
    segmentId: `i3-segment-${ordinal}`,
    sequence,
    revision: refined ? 2 : 1,
    kind: refined ? 'refined' : 'final',
    t0: (index * intervalMs) / 1000,
    t1: ((index + 1) * intervalMs) / 1000,
    text,
    translation: null
  }
}

class FakeElement {
  constructor (tagName = 'div') {
    this.tagName = String(tagName).toUpperCase()
    this.attributes = new Map()
    this.children = []
    this.dataset = {}
    this.disabled = false
    this.hidden = false
    this.listeners = new Map()
    this.classList = { add () {}, remove () {} }
    this._textContent = ''
  }

  get textContent () { return this._textContent }

  set textContent (value) {
    this._textContent = String(value)
    this.children = []
  }

  appendChild (child) {
    this.children.push(child)
    return child
  }

  setAttribute (name, value) { this.attributes.set(name, String(value)) }

  getAttribute (name) { return this.attributes.get(name) ?? null }

  addEventListener (name, callback) {
    if (!this.listeners.has(name)) this.listeners.set(name, [])
    this.listeners.get(name).push(callback)
  }

  click () {
    for (const callback of this.listeners.get('click') || []) callback({ target: this })
  }

  closest () { return null }

  setPointerCapture () {}
}

function nextTurn () {
  return new Promise((resolve) => setImmediate(resolve))
}

async function waitFor (probe, label) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const value = probe()
    if (value) return value
    await nextTurn()
  }
  throw new Error(`timed out waiting for ${label}`)
}

function historyRendererSource () {
  return fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'history', 'history.js'), 'utf8')
}

async function exerciseBoundedHistoryDom ({ history, sessionId, segmentCount, pageSamples }) {
  const ids = [
    'titlebar', 'close', 'refresh', 'globalStatus', 'sessionCount', 'sessionList',
    'loadMore', 'emptyState', 'sessionDetail', 'detailSource', 'detailTitle',
    'detailMeta', 'detailRefinement', 'exportStatus', 'previousPage', 'nextPage', 'retryPage',
    'rangeStatus', 'timeline'
  ]
  const elements = new Map(ids.map((id) => [id, new FakeElement(id.includes('Page') ? 'button' : 'div')]))
  elements.get('sessionDetail').hidden = true
  elements.get('loadMore').hidden = true
  elements.get('retryPage').hidden = true
  const timeline = elements.get('timeline')
  let maxNodes = 0
  const originalAppend = timeline.appendChild.bind(timeline)
  timeline.appendChild = (node) => {
    const result = originalAppend(node)
    maxNodes = Math.max(maxNodes, timeline.children.length)
    return result
  }
  const exportButtons = ['txt', 'md', 'srt'].map((format) => {
    const button = new FakeElement('button')
    button.dataset.export = format
    return button
  })
  const collected = []
  const historyApi = {
    dragEnd () {},
    dragStart () {},
    close () {},
    onConfig () {},
    async getConfig () { return { theme: 'dark', systemDark: true } },
    async listSessions (limit, cursor) {
      return { ok: true, value: await history.listSessions({ limit, cursor }) }
    },
    async getSessionPage (requestedSessionId, limit, cursor) {
      const started = process.hrtime.bigint()
      const page = await history.getSessionPage({ sessionId: requestedSessionId, limit, cursor })
      pageSamples.push(durationMs(started))
      collected.push(...page.items)
      return { ok: true, value: page }
    },
    async exportSession () { return { ok: true, value: { status: 'cancelled' } } }
  }
  const document = {
    documentElement: new FakeElement('html'),
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => elements.get(id),
    querySelectorAll: (selector) => selector === '[data-export]' ? exportButtons : []
  }
  document.documentElement.dataset = {}
  const window = { addEventListener () {}, historyApi }
  vm.runInNewContext(historyRendererSource(), { Date, Intl, console, document, window })

  const sessionCard = await waitFor(() => elements.get('sessionList').children[0]?.children[0] || null,
    'history session list')
  sessionCard.click()
  const expectedPageCount = Math.ceil(segmentCount / PAGE_SIZE)
  for (let pageIndex = 0; pageIndex < expectedPageCount; pageIndex += 1) {
    const expectedItemCount = Math.min(PAGE_SIZE, segmentCount - pageIndex * PAGE_SIZE)
    await waitFor(() => (
      timeline.getAttribute('aria-busy') === 'false' && timeline.children.length === expectedItemCount
    ), `history DOM page ${pageIndex + 1}`)
    if (pageIndex + 1 < expectedPageCount) {
      if (elements.get('nextPage').disabled) throw new Error('history DOM ended before all fixture pages were loaded')
      elements.get('nextPage').click()
    }
  }
  if (!elements.get('nextPage').disabled || elements.get('previousPage').disabled) {
    throw new Error('history DOM pagination controls did not reach the terminal page')
  }
  if (collected.length !== segmentCount || new Set(collected.map((item) => item.segmentId)).size !== segmentCount) {
    throw new Error('history DOM pagination lost or duplicated fixture segments')
  }
  return { historyPageCount: expectedPageCount, maxNodes, collected }
}

function walMetrics (service, databasePath) {
  const database = service.store?.database
  if (!database) throw new Error('storage service did not retain an open SQLite database for WAL inspection')
  const walCheckpoint = database.prepare('PRAGMA wal_checkpoint(NOOP)').get()
  const journalMode = String(database.prepare('PRAGMA journal_mode').get().journal_mode || '').toLowerCase()
  const pageCount = Number(database.prepare('PRAGMA page_count').get().page_count)
  const integrity = String(database.prepare('PRAGMA integrity_check').get().integrity_check)
  let walBytes = 0
  try { walBytes = fs.statSync(`${databasePath}-wal`).size } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return {
    checkpointedWalFrames: Number(walCheckpoint.checkpointed || 0),
    integrity,
    journalMode,
    pageCount,
    walBytes,
    walFrames: Number(walCheckpoint.log || 0)
  }
}

function exportSummary (content, recordCount) {
  return {
    bytes: Buffer.byteLength(content, 'utf8'),
    recordCount,
    sha256: sha256(content)
  }
}

function assertReportSafe (report) {
  const rendered = JSON.stringify(report)
  if (/fixture subtitle|[A-Za-z]:[\\/]|(?:^|[^:])\/Users\//.test(rendered)) {
    throw new Error('I3 non-audio report must not contain transcript text or absolute paths')
  }
}

async function runI3NonAudioSoak (options = {}) {
  allowedKeys(options, ['batchSize', 'keepArtifacts', 'rootDirectory', 'segmentCount'], 'options')
  const segmentCount = positiveInteger(options.segmentCount === undefined ? DEFAULT_SEGMENT_COUNT : options.segmentCount,
    'segmentCount', MIN_SEGMENTS)
  const batchSize = positiveInteger(options.batchSize === undefined ? DEFAULT_BATCH_SIZE : options.batchSize,
    'batchSize')
  const virtualDurationMs = MIN_VIRTUAL_DURATION_MS
  if (virtualDurationMs % segmentCount !== 0) throw new Error('fixture timeline cannot evenly cover the virtual duration')
  const intervalMs = virtualDurationMs / segmentCount
  const refinedSegmentCount = Math.ceil(segmentCount / REFINE_EVERY)
  const captionEventCount = segmentCount + refinedSegmentCount
  const ownsRoot = options.rootDirectory === undefined
  const root = ownsRoot
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'i3-nonaudio-soak-'))
    : path.resolve(options.rootDirectory)
  const databasePath = path.join(root, 'data', 'speech-agent.sqlite3')
  const exportDirectory = path.join(root, 'exports')
  const exportPaths = ['txt', 'md', 'srt'].map((extension) => path.join(exportDirectory, `i3-nonaudio.${extension}`))
  const started = process.hrtime.bigint()
  const cpuBefore = process.cpuUsage()
  let maxRssBytes = 0
  let maxHeapUsedBytes = 0
  let maxQueueDepth = 0
  const sampleProcess = (gateway) => {
    const usage = process.memoryUsage()
    maxRssBytes = Math.max(maxRssBytes, usage.rss)
    maxHeapUsedBytes = Math.max(maxHeapUsedBytes, usage.heapUsed)
    maxQueueDepth = Math.max(maxQueueDepth, gateway.queue.length)
  }
  const primary = createGateway(databasePath)
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  let clock = SESSION_START_MS
  const recorder = new SqliteSessionRecorder({ gateway: primary.gateway, now: () => clock })
  const coordinator = new SessionCoordinator({
    adapter,
    persistenceSink: recorder,
    runtimeOptions: { ...DEV_RUNTIME, refinementAvailable: true },
    configuration: {
      onboardingCompleted: true,
      onboardingPreset: 'dictation',
      mic: true,
      loopback: false,
      refinementEnabled: true
    },
    idFactory: () => 'i3-nonaudio-accelerated-session'
  })
  let recovered = null
  let report
  try {
    fs.mkdirSync(exportDirectory, { recursive: true })
    await primary.gateway.start()
    const startedSession = await coordinator.command('start')
    if (!startedSession.ok) throw new Error('fixture session could not start')
    const sessionId = coordinator.getSnapshot().sessionId
    if (sessionId !== 'i3-nonaudio-accelerated-session') throw new Error('fixture session identity changed')
    let sequence = 0
    for (let startIndex = 0; startIndex < segmentCount; startIndex += batchSize) {
      const endIndex = Math.min(segmentCount, startIndex + batchSize)
      for (let index = startIndex; index < endIndex; index += 1) {
        adapter.emitCaption(caption(sessionId, index, ++sequence, intervalMs))
        if (index % REFINE_EVERY === 0) {
          adapter.emitCaption(caption(sessionId, index, ++sequence, intervalMs, true))
        }
      }
      sampleProcess(primary.gateway)
      await primary.gateway.flush()
      sampleProcess(primary.gateway)
    }
    if (sequence !== captionEventCount) throw new Error('fixture caption event count is not deterministic')
    clock = SESSION_START_MS + virtualDurationMs
    const stoppedSession = await coordinator.command('stop')
    if (!stoppedSession.ok) throw new Error('fixture session could not stop')
    await primary.gateway.flush()
    sampleProcess(primary.gateway)
    const wal = walMetrics(primary.service, databasePath)
    if (wal.integrity !== 'ok') throw new Error('SQLite integrity check failed after fixture ingestion')
    await coordinator.dispose()
    await primary.gateway.shutdown()

    // A new gateway/service is a real database reopen at the product storage
    // boundary.  It proves that committed final/refined projections survive
    // more than the in-memory coordinator lifetime.
    recovered = createGateway(databasePath)
    await recovered.gateway.start()
    const pageSamples = []
    const chosenPaths = [...exportPaths]
    const history = new HistoryService({
      gateway: recovered.gateway,
      showSaveDialog: async () => ({ canceled: false, filePath: chosenPaths.shift() })
    })
    const dom = await exerciseBoundedHistoryDom({
      history,
      sessionId,
      segmentCount,
      pageSamples
    })
    const fullTranscript = await recovered.gateway.getSessionTranscript(sessionId)
    if (fullTranscript.segments.length !== segmentCount) throw new Error('reopened transcript projection is incomplete')
    /* 版本隔离（SEM-F04）：重开后默认正文恒为首次 final，精修稿以独立版本并存。
       因此「恢复了多少精修」要数 refinedText，而不是数被覆盖成 revision 2 的投影。 */
    const recoveredRefinedSegmentCount = fullTranscript.segments
      .filter((segment) => typeof segment.refinedText === 'string' && segment.refinedText.length > 0).length
    if (recoveredRefinedSegmentCount !== refinedSegmentCount) {
      throw new Error('reopened refined projection count is incomplete')
    }
    for (const index of [0, REFINE_EVERY, segmentCount - 1]) {
      const segment = fullTranscript.segments[index]
      if (!segment) throw new Error('reopened projection unexpectedly lacks a checked segment')
      const shouldBeRefined = index % REFINE_EVERY === 0
      const refinedMatches = shouldBeRefined
        ? typeof segment.refinedText === 'string' && segment.refinedText.startsWith('refined fixture subtitle ')
        : segment.refinedText === null
      if (segment.textRevision !== 1 ||
          !segment.text.startsWith('final fixture subtitle ') || !refinedMatches) {
        throw new Error('reopened original/refined versions differ from the deterministic fixture')
      }
    }
    for (const format of ['txt', 'md', 'srt']) {
      const result = await history.exportSession({ sessionId, format })
      if (result.status !== 'saved' || result.format !== format) throw new Error(`complete ${format} export was not saved`)
    }
    const txt = fs.readFileSync(exportPaths[0], 'utf8')
    const markdown = fs.readFileSync(exportPaths[1], 'utf8')
    const srt = fs.readFileSync(exportPaths[2], 'utf8')
    const exports = {
      markdown: exportSummary(markdown, (markdown.match(/^- /gm) || []).length),
      srt: exportSummary(srt, (srt.match(/^\d+$/gm) || []).length),
      text: exportSummary(txt, txt.trimEnd().split('\n').length)
    }
    if (Object.values(exports).some((entry) => entry.recordCount !== segmentCount)) {
      throw new Error('complete export did not preserve all fixture segments')
    }
    /* 完整导出默认取原始版（SEM-F11）：即使第 1 段有精修稿，导出的也必须是首次 final。 */
    if (!txt.includes('final fixture subtitle 0001') || txt.includes('refined fixture subtitle 0001')) {
      throw new Error('text export did not default to the first-pass original version')
    }
    sampleProcess(recovered.gateway)
    const cpu = process.cpuUsage(cpuBefore)
    const wallDurationMs = durationMs(started)
    const cpuPercent = ((cpu.user + cpu.system) / 1000) / wallDurationMs * 100
    const pageQueryP95Ms = percentile95(pageSamples)
    const checks = {
      acceleratedTimelineCoversTwoHours: virtualDurationMs >= MIN_VIRTUAL_DURATION_MS && intervalMs * segmentCount === virtualDurationMs,
      captionsCommitted: fullTranscript.segments.length === segmentCount,
      cpuBounded: cpuPercent <= LIMITS.maxCpuPercent,
      exportsComplete: Object.values(exports).every((entry) => entry.recordCount === segmentCount),
      historyDomBounded: dom.maxNodes <= LIMITS.maxDomNodes,
      historyPaginationComplete: dom.collected.length === segmentCount &&
        new Set(dom.collected.map((item) => item.segmentId)).size === segmentCount,
      memoryBounded: maxRssBytes <= LIMITS.maxRssBytes && maxHeapUsedBytes <= LIMITS.maxHeapUsedBytes,
      noAudioArtifacts: audioFilesUnder(root).length === 0,
      queryP95Bounded: pageQueryP95Ms <= LIMITS.maxQueryP95Ms,
      queueBounded: maxQueueDepth <= LIMITS.maxQueueDepth,
      refinedProjectionRecovered: recoveredRefinedSegmentCount === refinedSegmentCount,
      thousandsOfSegments: segmentCount >= MIN_SEGMENTS,
      walBounded: wal.walBytes <= LIMITS.maxWalBytes,
      walMode: wal.journalMode === 'wal'
    }
    const result = Object.values(checks).every((value) => value === true) ? 'pass' : 'fail'
    report = {
      boundaries: {
        deterministicCaptionFixture: true,
        electronBrowserWindow: false,
        fakeRuntimeAdapter: true,
        inProcessStorageHost: true,
        loopbackAccess: false,
        microphoneAccess: false,
        qualification: 'deterministic-nonaudio-prequalification-only',
        realTwoHourAudioSoak: false,
        speakerPlayback: false,
        historyRendererVmHarness: true,
        usesHistoryRendererScript: true
      },
      checks,
      exports,
      fixture: {
        captionEventCount,
        clockSemantics: 'accelerated-virtual-caption-time',
        fixtureId: 'i3-nonaudio-deterministic-v1',
        refinedSegmentCount,
        segmentCount,
        segmentIntervalMs: intervalMs,
        timelineEndMs: virtualDurationMs,
        virtualDurationMs
      },
      gateStatus: 'partial',
      generatedAt: new Date().toISOString(),
      kind: 'i3-nonaudio-soak',
      limits: LIMITS,
      metrics: {
        captionEventCount,
        checkpointedWalFrames: wal.checkpointedWalFrames,
        cpuPercent: rounded(cpuPercent),
        cpuSystemMs: rounded(cpu.system / 1000),
        cpuUserMs: rounded(cpu.user / 1000),
        exportCount: 3,
        historyDomMaxNodes: dom.maxNodes,
        historyPageCount: dom.historyPageCount,
        maxHeapUsedBytes,
        maxQueueDepth,
        maxRssBytes,
        pageCount: wal.pageCount,
        pageQueryCount: pageSamples.length,
        pageQueryP95Ms: rounded(pageQueryP95Ms),
        recoveredRefinedSegmentCount,
        segmentCount,
        walBytes: wal.walBytes,
        walFrames: wal.walFrames,
        journalMode: wal.journalMode,
        wallDurationMs: rounded(wallDurationMs)
      },
      privacy: {
        persistedAudio: false,
        reportContainsAbsolutePath: false,
        reportContainsTranscriptText: false
      },
      provenance: currentProvenance(),
      result,
      schemaVersion: 1
    }
    assertReportSafe(report)
    await recovered.gateway.shutdown()
    recovered = null
    if (result !== 'pass') throw new Error('I3 non-audio soak exceeded a bounded-resource threshold')
    return report
  } finally {
    await coordinator.dispose().catch(() => {})
    if (recovered) await recovered.gateway.shutdown().catch(() => recovered.gateway.terminate())
    await primary.gateway.shutdown().catch(() => primary.gateway.terminate())
    if (ownsRoot && options.keepArtifacts !== true) fs.rmSync(root, { recursive: true, force: true })
  }
}

function parseArguments (argv) {
  const options = {}
  let reportPath = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const next = argv[index + 1]
    if (argument === '--report' && typeof next === 'string') {
      reportPath = path.resolve(next)
      index += 1
    } else if (argument === '--segments' && typeof next === 'string') {
      options.segmentCount = Number(next)
      index += 1
    } else if (argument === '--batch-size' && typeof next === 'string') {
      options.batchSize = Number(next)
      index += 1
    } else if (argument === '--keep-artifacts') {
      options.keepArtifacts = true
    } else {
      throw new Error('usage: node scripts/i3-nonaudio-soak.js [--segments N] [--batch-size N] [--keep-artifacts] --report <report.json>')
    }
  }
  if (!reportPath) throw new Error('a --report path is required')
  return { options, reportPath }
}

if (require.main === module) {
  const { options, reportPath } = parseArguments(process.argv.slice(2))
  runI3NonAudioSoak(options).then((report) => {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true })
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    process.stdout.write(JSON.stringify({
      gateStatus: report.gateStatus,
      result: report.result,
      segmentCount: report.fixture.segmentCount,
      virtualDurationMs: report.fixture.virtualDurationMs
    }) + '\n')
  }).catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`)
    process.exitCode = 1
  })
}

module.exports = {
  DEFAULT_SEGMENT_COUNT,
  LIMITS,
  MIN_SEGMENTS,
  MIN_VIRTUAL_DURATION_MS,
  PAGE_SIZE,
  PROVENANCE_FILES,
  canonicalTextProvenanceDigest,
  currentProvenance,
  parseArguments,
  runI3NonAudioSoak
}
