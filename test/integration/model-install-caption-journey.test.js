'use strict'

/*
 * Deterministic user journey for the local subtitle resource boundary:
 * trusted/resumable model installation -> idle runtime activation -> live
 * caption -> terminal SQLite history. Physical capture/ASR is the only fake;
 * archives, ModelManager, SessionCoordinator and persistence are production
 * components.
 */

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const { HistoryService } = require('../../src/main/services/history-service')
const {
  DEFAULT_TAR_PATH,
  ModelManager
} = require('../../src/main/services/model-manager')
const { PRODUCTION_MODEL_MANIFEST } = require('../../src/main/services/model-manifest')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { StorageGateway } = require('../../src/main/services/storage-gateway')
const { FakeRuntimeAdapter } = require('../../src/main/session/fake-runtime-adapter')
const { SessionCoordinator } = require('../../src/main/session/session-coordinator')
const { resolveRuntimeOptions } = require('../../src/main/runtime-options')
const {
  OPERATIONS,
  PROTOCOL_VERSION,
  StorageError,
  makeCaptionEventId,
  makeCloseSessionKey,
  makeOpenSessionKey
} = require('../../src/runtime/storage-worker/protocol')
const { SqliteSubtitleStore } = require('../../src/runtime/storage-worker/subtitle-store')
const { StorageWorkerService } = require('../../src/runtime/storage-worker/worker-service')

const NO_MODEL = resolveRuntimeOptions({})
const SYSTEM_TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
const STATUS_KEYS = [
  'canInstall',
  'currentArtifactId',
  'downloadedBytes',
  'error',
  'progress',
  'resources',
  'schemaVersion',
  'state',
  'totalBytes'
]
const RESOURCE_STATUS_KEYS = ['downloadedBytes', 'id', 'progress', 'state', 'totalBytes']

function sha256 (value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function runSystemTar (args) {
  const result = spawnSync(SYSTEM_TAR, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr || `tar exited with ${result.status}`)
  return result.stdout
}

function makeFixtureManifest (root) {
  const fixtureRoot = path.join(root, 'fixture-models')
  const archiveRoot = path.join(root, 'fixture-downloads')
  fs.mkdirSync(fixtureRoot, { recursive: true })
  fs.mkdirSync(archiveRoot, { recursive: true })
  const payloadByUrlPath = new Map()
  const expectedFileContents = new Map()

  const artifacts = PRODUCTION_MODEL_MANIFEST.artifacts.map((productionArtifact) => {
    const urlPath = new URL(productionArtifact.url).pathname
    let payload
    if (productionArtifact.artifactKind === 'archive') {
      const sourceParent = path.join(fixtureRoot, productionArtifact.id)
      const sourceRoot = path.join(sourceParent, productionArtifact.directoryName)
      fs.mkdirSync(sourceRoot, { recursive: true })
      for (const requiredFile of productionArtifact.requiredFiles) {
        const content = Buffer.from(`fixture:${productionArtifact.id}:${requiredFile}\n`, 'utf8')
        fs.writeFileSync(path.join(sourceRoot, requiredFile), content)
        expectedFileContents.set(`${productionArtifact.id}/${requiredFile}`, content)
      }
      const archivePath = path.join(archiveRoot, `${productionArtifact.id}.tar`)
      runSystemTar(['-cf', archivePath, '-C', sourceParent, productionArtifact.directoryName])
      const listing = runSystemTar(['-tf', archivePath])
      assert.match(listing, new RegExp(`(?:^|\\r?\\n)${productionArtifact.directoryName}/`))
      payload = fs.readFileSync(archivePath)
    } else {
      payload = Buffer.from('deterministic silero VAD fixture\n', 'utf8')
      expectedFileContents.set(`${productionArtifact.id}/${productionArtifact.fileName}`, payload)
    }
    payloadByUrlPath.set(urlPath, payload)
    return {
      ...productionArtifact,
      bytes: payload.length,
      sha256: sha256(payload)
    }
  })

  assert.deepEqual(artifacts.map(({ id }) => id), ['x-asr-160ms', 'x-asr-offline', 'silero-vad'])
  return {
    manifest: { version: PRODUCTION_MODEL_MANIFEST.version, artifacts },
    payloadByUrlPath,
    expectedFileContents
  }
}

async function startFixtureServer (payloadByUrlPath, requests) {
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url, 'http://127.0.0.1').pathname
    const payload = payloadByUrlPath.get(pathname)
    const range = request.headers.range || null
    requests.push({ pathname, range })
    response.setHeader('Accept-Ranges', 'bytes')
    response.setHeader('Connection', 'close')
    if (!payload) {
      response.writeHead(404).end()
      return
    }
    if (range !== null) {
      const match = /^bytes=(\d+)-$/.exec(range)
      const offset = match ? Number(match[1]) : -1
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= payload.length) {
        response.writeHead(416).end()
        return
      }
      const body = payload.subarray(offset)
      response.writeHead(206, {
        'Content-Length': body.length,
        'Content-Range': `bytes ${offset}-${payload.length - 1}/${payload.length}`,
        'Content-Type': 'application/octet-stream'
      })
      response.end(body)
      return
    }
    response.writeHead(200, {
      'Content-Length': payload.length,
      'Content-Type': 'application/octet-stream'
    })
    response.end(payload)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return server
}

async function closeFixtureServer (server) {
  if (!server) return
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

function serviceBackedHost (service, databasePath, operations) {
  let sequence = 0
  let started = false

  function call (operation, payload, idempotencyKey) {
    operations.push(operation)
    const response = service.handle({
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId: `model-caption-${++sequence}`,
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

function createGateway (databasePath, operations) {
  const service = new StorageWorkerService({
    storeFactory: (options) => new SqliteSubtitleStore(options)
  })
  const gateway = new StorageGateway({
    databasePath,
    hostFactory: () => serviceBackedHost(service, databasePath, operations),
    maxRestarts: 0
  })
  return gateway
}

function assertPublicStatus (status, forbiddenValues) {
  assert.deepEqual(Object.keys(status).sort(), [...STATUS_KEYS].sort())
  assert.equal(Object.isFrozen(status), true)
  assert.ok(Array.isArray(status.resources))
  for (const resource of status.resources) {
    assert.deepEqual(Object.keys(resource).sort(), [...RESOURCE_STATUS_KEYS].sort())
    assert.equal(Object.isFrozen(resource), true)
  }
  if (status.error !== null) {
    assert.deepEqual(Object.keys(status.error).sort(), ['code', 'message'])
  }
  const serialized = JSON.stringify(status)
  assert.doesNotMatch(serialized, /https?:|github\.com|\.part|\.staging/i)
  for (const forbidden of forbiddenValues) assert.equal(serialized.includes(forbidden), false)
}

function markerFor (manifest, artifact) {
  return {
    manifestVersion: manifest.version,
    artifactId: artifact.id,
    sha256: artifact.sha256,
    bytes: artifact.bytes
  }
}

function targetFor (userDataDir, artifact) {
  return artifact.artifactKind === 'archive'
    ? path.join(userDataDir, 'models', artifact.installId, artifact.directoryName)
    : path.join(userDataDir, 'models', artifact.installId)
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

test('CI journey: resumed model install activates captions and produces terminal text-only history', {
  skip: process.platform !== 'win32' ? 'Windows system tar is the product archive boundary' : false,
  timeout: 60000
}, async (t) => {
  assert.equal(fs.existsSync(SYSTEM_TAR), true, 'Windows system tar must be available')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-install-caption-'))
  const userDataDir = path.join(root, 'userData')
  const databasePath = path.join(userDataDir, 'data', 'speech-agent.sqlite3')
  const requests = []
  const operations = []
  const observedStatuses = []
  const observedCaptions = []
  let manager
  let coordinator
  let gateway
  let server

  t.after(async () => {
    await coordinator?.dispose().catch(() => {})
    await manager?.shutdown().catch(() => {})
    await gateway?.shutdown().catch(() => gateway?.terminate())
    await closeFixtureServer(server)
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  const fixtures = makeFixtureManifest(root)
  server = await startFixtureServer(fixtures.payloadByUrlPath, requests)
  const serverAddress = server.address()
  assert.ok(serverAddress && typeof serverAddress === 'object')

  const firstArtifact = fixtures.manifest.artifacts[0]
  const firstPayload = fixtures.payloadByUrlPath.get(new URL(firstArtifact.url).pathname)
  const resumeOffset = Math.max(1, Math.floor(firstPayload.length / 3))
  const downloadsRoot = path.join(userDataDir, 'models', '.downloads')
  fs.mkdirSync(downloadsRoot, { recursive: true })
  fs.writeFileSync(path.join(downloadsRoot, `${firstArtifact.id}.part`), firstPayload.subarray(0, resumeOffset))

  const originalFetchUrls = []
  const fetchImpl = (url, options = {}) => {
    const original = new URL(url)
    originalFetchUrls.push(original.toString())
    const loopbackUrl = `http://127.0.0.1:${serverAddress.port}${original.pathname}`
    return fetch(loopbackUrl, {
      method: options.method,
      headers: options.headers,
      redirect: options.redirect,
      signal: options.signal
    })
  }
  manager = new ModelManager({
    userDataDir,
    manifest: fixtures.manifest,
    fetchImpl,
    randomId: (() => {
      let value = 0
      return () => `journey-${++value}`
    })()
  })
  assert.equal(manager.tarPath, DEFAULT_TAR_PATH, 'J14 must exercise the production tar executable selection')
  manager.onStatus((status) => observedStatuses.push(status))

  gateway = createGateway(databasePath, operations)
  await gateway.start()
  let clock = 1780000000000
  const recorder = new SqliteSessionRecorder({ gateway, now: () => clock })
  const initialAdapter = new FakeRuntimeAdapter({ autoEmit: false })
  const installedAdapter = new FakeRuntimeAdapter({ autoEmit: false })
  coordinator = new SessionCoordinator({
    adapter: initialAdapter,
    adapterFactory: () => new FakeRuntimeAdapter({ autoEmit: false }),
    persistenceSink: recorder,
    runtimeOptions: NO_MODEL,
    configuration: {
      onboardingCompleted: true,
      onboardingPreset: 'dictation',
      mic: true,
      loopback: false
    },
    idFactory: () => 'installed-model-caption-session'
  })
  coordinator.onCaption((event) => observedCaptions.push(event))

  assert.equal(coordinator.getSnapshot().phase, 'unavailable')
  assert.equal(coordinator.getSnapshot().capabilities.limitations[0].code, 'MODEL_NOT_READY')
  const initialized = await manager.initialize()
  assert.equal(initialized.state, 'missing')
  assert.equal(initialized.resources[0].downloadedBytes, resumeOffset)

  const ready = await manager.install()
  assert.equal(ready.state, 'ready')
  assert.equal(ready.progress, 1)
  assert.equal(ready.canInstall, false)
  assert.equal(ready.resources.every((resource) => resource.state === 'ready' && resource.progress === 1), true)
  assert.ok(observedStatuses.some(({ state }) => state === 'downloading'))
  assert.ok(observedStatuses.some(({ state }) => state === 'verifying'))
  assert.equal(observedStatuses.at(-1).state, 'ready')

  const resumeRequests = requests.filter(({ pathname, range }) =>
    pathname === new URL(firstArtifact.url).pathname && range !== null)
  assert.deepEqual(resumeRequests, [{
    pathname: new URL(firstArtifact.url).pathname,
    range: `bytes=${resumeOffset}-`
  }], 'the retained .part is continued with one valid Range request')
  assert.equal(originalFetchUrls.length, fixtures.manifest.artifacts.length)
  assert.equal(originalFetchUrls.every((url) => {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.hostname === 'github.com'
  }), true, 'the manifest-facing fetch boundary only receives fixed-domain HTTPS URLs')

  const forbiddenStatusValues = [root, userDataDir, ...fixtures.manifest.artifacts.map(({ sha256 }) => sha256)]
  for (const status of [initialized, ready, ...observedStatuses]) {
    assertPublicStatus(status, forbiddenStatusValues)
  }

  for (const artifact of fixtures.manifest.artifacts) {
    const target = targetFor(userDataDir, artifact)
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(target, '.ready.json'), 'utf8')),
      markerFor(fixtures.manifest, artifact)
    )
    for (const requiredFile of artifact.requiredFiles) {
      const installed = fs.readFileSync(path.join(target, requiredFile))
      assert.deepEqual(installed, fixtures.expectedFileContents.get(`${artifact.id}/${requiredFile}`))
    }
    assert.equal(fs.existsSync(path.join(downloadsRoot, `${artifact.id}.part`)), false)
  }
  assert.deepEqual(fs.readdirSync(path.join(userDataDir, 'models', '.staging')), [])

  const activated = coordinator.replaceRuntime({
    adapterFactory: () => installedAdapter,
    runtimeOptions: {
      modelOverride: {
        id: firstArtifact.id,
        profile: 'balanced',
        developmentOnly: false
      },
      refinementAvailable: true
    }
  })
  assert.equal(activated.phase, 'idle')
  assert.equal(activated.model.state, 'ready')
  assert.equal(activated.model.profile, 'balanced')
  assert.equal(activated.capabilities.canStart, true)
  assert.equal(initialAdapter.context, null)

  assert.equal((await coordinator.command('start')).ok, true)
  const listening = coordinator.getSnapshot()
  assert.equal(listening.phase, 'listening')
  assert.equal(listening.sessionId, 'installed-model-caption-session')
  assert.deepEqual(installedAdapter.context.sourceIds, ['mic'])
  assert.throws(() => coordinator.replaceRuntime({
    adapterFactory: () => new FakeRuntimeAdapter({ autoEmit: false }),
    runtimeOptions: {
      modelOverride: { id: firstArtifact.id, profile: 'balanced', developmentOnly: false },
      refinementAvailable: true
    }
  }), (error) => error.code === 'SESSION_ACTIVE')
  assert.equal(coordinator.getSnapshot().revision, listening.revision)

  const finalCaption = {
    schemaVersion: 1,
    sessionId: listening.sessionId,
    sourceId: 'mic',
    segmentId: 'fixture-segment-1',
    sequence: 1,
    revision: 1,
    kind: 'final',
    t0: 0,
    t1: 1.25,
    text: '模型安装后，实时字幕与历史记录联动正常。',
    translation: null
  }
  installedAdapter.emitCaption(finalCaption)
  assert.deepEqual(observedCaptions, [finalCaption])
  await gateway.flush()
  const history = new HistoryService({
    gateway,
    showSaveDialog: async () => ({ canceled: true })
  })
  assert.deepEqual(await history.listSessions({ limit: 10, cursor: null }), {
    items: [],
    nextCursor: null
  }, 'an active capture is not reviewable as terminal history')

  clock += 2400
  assert.equal((await coordinator.command('stop')).ok, true)
  await gateway.flush()
  assert.equal(coordinator.getSnapshot().phase, 'idle')
  const listed = await history.listSessions({ limit: 10, cursor: null })
  assert.deepEqual(listed.items.map(({ sessionId, state }) => [sessionId, state]), [
    ['installed-model-caption-session', 'closed']
  ])
  const detail = await history.getSessionPage({
    sessionId: 'installed-model-caption-session',
    limit: 50,
    cursor: null
  })
  assert.equal(detail.session.sourceId, 'mic')
  assert.equal(detail.session.state, 'closed')
  assert.equal(detail.totalCount, 1)
  assert.deepEqual(detail.items.map(({ sourceId, text, t0Ms, t1Ms }) => ({ sourceId, text, t0Ms, t1Ms })), [{
    sourceId: 'mic',
    text: finalCaption.text,
    t0Ms: 0,
    t1Ms: 1250
  }])
  assert.equal(Object.hasOwn(detail.session, 'audioPath'), false)
  assert.equal(Object.hasOwn(detail.items[0], 'audioPath'), false)
  assert.ok(operations.includes(OPERATIONS.LIST_SESSIONS))
  assert.ok(operations.includes(OPERATIONS.GET_SESSION_PAGE))
  assert.deepEqual(audioFilesUnder(root), [], 'installation and subtitle history never persist raw audio')
})
