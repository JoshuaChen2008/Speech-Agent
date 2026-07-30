'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { PassThrough } = require('node:stream')
const test = require('node:test')

const {
  MANIFEST_VERSION,
  PRODUCTION_MODEL_MANIFEST,
  validateManifest
} = require('../../src/main/services/model-manifest')
const {
  DEFAULT_TAR_PATH,
  ModelManager
} = require('../../src/main/services/model-manager')
const {
  APPROVED_REALTIME_MODEL,
  APPROVED_REFINEMENT_MODEL,
  REFINEMENT_REQUIRED_FILES,
  REQUIRED_FILES
} = require('../../src/main/services/model-resolver')

function tempUserData (t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-manager-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function sha (buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function manifestFor (artifacts) {
  return {
    version: 7,
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      artifactKind: artifact.artifactKind || 'file',
      installId: artifact.installId || artifact.id,
      url: artifact.url || `https://github.com/owner/repo/releases/download/models/${artifact.id}`,
      bytes: artifact.body.length,
      sha256: artifact.sha256 || sha(artifact.body),
      fileName: artifact.fileName || `${artifact.id}.bin`,
      directoryName: artifact.directoryName,
      requiredFiles: artifact.requiredFiles || [artifact.fileName || `${artifact.id}.bin`],
      upstream: { project: 'owner/repo', release: 'models', asset: artifact.id }
    }))
  }
}

function response (body, options = {}) {
  return new Response(body, { status: options.status || 200, headers: options.headers || {} })
}

function managerFor (t, manifest, fetchImpl, extra = {}) {
  let id = 0
  return new ModelManager({
    userDataDir: tempUserData(t),
    manifest,
    fetchImpl,
    randomId: () => `test-${++id}`,
    ...extra
  })
}

function marker (manifest, artifact) {
  return {
    manifestVersion: manifest.version,
    artifactId: artifact.id,
    sha256: artifact.sha256,
    bytes: artifact.bytes
  }
}

function makeTarSpawn (configuration) {
  return (_command, args) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => setImmediate(() => child.emit('close', 1))
    setImmediate(() => {
      if (args[0] === '-tf') {
        child.stdout.end(`${configuration.listing.join('\n')}\n`)
        child.stderr.end()
        child.emit('close', 0)
        return
      }
      if (args[0] === '-tvf') {
        const verbose = configuration.verbose || configuration.listing.map((entry) => `${entry.endsWith('/') ? 'd' : '-'}rw-r--r-- owner/group 1 Jan 1 00:00 ${entry}`)
        child.stdout.end(`${verbose.join('\n')}\n`)
        child.stderr.end()
        child.emit('close', 0)
        return
      }
      if (args[0] === '-xf') {
        const destination = args[args.indexOf('-C') + 1]
        if (configuration.extract) configuration.extract(destination, args)
        child.stdout.end()
        child.stderr.end()
        child.emit('close', 0)
      }
    })
    return child
  }
}

test('production manifest pins the three approved immutable resources', () => {
  assert.equal(PRODUCTION_MODEL_MANIFEST.version, MANIFEST_VERSION)
  assert.ok(Object.isFrozen(PRODUCTION_MODEL_MANIFEST))
  assert.ok(Object.isFrozen(PRODUCTION_MODEL_MANIFEST.artifacts))
  assert.equal(PRODUCTION_MODEL_MANIFEST.artifacts.length, 3)

  const realtime = PRODUCTION_MODEL_MANIFEST.artifacts.find((item) => item.id === 'x-asr-160ms')
  assert.equal(realtime.bytes, 133898007)
  assert.equal(realtime.sha256, '8a6fca056e1a342546edd78be4d50274e2c01898e7b8ae8fc336f6410319c399')
  assert.equal(realtime.directoryName, APPROVED_REALTIME_MODEL.directoryName)
  assert.deepEqual(realtime.requiredFiles, REQUIRED_FILES)

  const refine = PRODUCTION_MODEL_MANIFEST.artifacts.find((item) => item.id === 'x-asr-offline')
  assert.equal(refine.bytes, 136396739)
  assert.equal(refine.sha256, '5d02c36d7b44e886b7c8f0d8e051f8713acab96c264bb6ef9e718be39a6a2224')
  assert.equal(refine.directoryName, APPROVED_REFINEMENT_MODEL.directoryName)
  assert.deepEqual(refine.requiredFiles, REFINEMENT_REQUIRED_FILES)

  const vad = PRODUCTION_MODEL_MANIFEST.artifacts.find((item) => item.id === 'silero-vad')
  assert.equal(vad.bytes, 643854)
  assert.equal(vad.sha256, '9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6')
  assert.equal(vad.fileName, 'silero_vad.onnx')
  assert.throws(() => { vad.bytes = 1 }, TypeError)
  if (process.platform === 'win32') {
    assert.equal(path.win32.basename(DEFAULT_TAR_PATH).toLowerCase(), 'tar.exe')
    assert.equal(path.win32.basename(path.win32.dirname(DEFAULT_TAR_PATH)).toLowerCase(), 'system32')
    assert.equal(path.win32.isAbsolute(DEFAULT_TAR_PATH), true)
  }
})

test('manifest validation fails closed for unsafe paths, hashes and protocols', () => {
  const good = manifestFor([{ id: 'tiny', body: Buffer.from('ok') }])
  assert.ok(Object.isFrozen(validateManifest(good)))
  for (const mutate of [
    (value) => { value.artifacts[0].installId = '../escape' },
    (value) => { value.artifacts[0].sha256 = '00' },
    (value) => { value.artifacts[0].url = 'http://github.com/file' },
    (value) => { value.artifacts[0].requiredFiles = ['../file'] }
  ]) {
    const invalid = structuredClone(good)
    mutate(invalid)
    assert.throws(() => validateManifest(invalid), /invalid model manifest/)
  }
})

test('status is clone-safe, frozen and does not expose URL, hash or local paths', async (t) => {
  const body = Buffer.from('safe payload')
  const manifest = manifestFor([{ id: 'tiny', body }])
  const manager = managerFor(t, manifest, async () => response(body))
  const status = await manager.initialize()
  assert.ok(Object.isFrozen(status))
  assert.ok(Object.isFrozen(status.resources))
  assert.doesNotThrow(() => structuredClone(status))
  const serialized = JSON.stringify(status)
  assert.doesNotMatch(serialized, /github\.com|sha256|\.part|model-manager-/)
  assert.equal(status.state, 'missing')
  assert.equal(status.canInstall, true)
})

test('a valid 206 response resumes the fixed part and hashes the complete stream', async (t) => {
  const body = Buffer.from('resume-this-download')
  const manifest = validateManifest(manifestFor([{ id: 'resume', body }]))
  const calls = []
  const manager = managerFor(t, manifest, async (_url, options) => {
    calls.push(options)
    const start = Number(options.headers.Range.match(/=(\d+)-/)[1])
    return response(body.subarray(start), {
      status: 206,
      headers: { 'content-range': `bytes ${start}-${body.length - 1}/${body.length}` }
    })
  })
  const part = path.join(manager.userDataDir, 'models', '.downloads', 'resume.part')
  fs.mkdirSync(path.dirname(part), { recursive: true })
  fs.writeFileSync(part, body.subarray(0, 7))
  const result = await manager.install()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].headers.Range, 'bytes=7-')
  assert.equal(result.state, 'ready')
  assert.equal(fs.readFileSync(path.join(manager.userDataDir, 'models', 'resume', 'resume.bin'), 'utf8'), body.toString())
})

test('a 200 response to Range safely truncates and downloads from byte zero', async (t) => {
  const body = Buffer.from('whole response wins')
  const manifest = validateManifest(manifestFor([{ id: 'restart', body }]))
  const manager = managerFor(t, manifest, async () => response(body))
  const part = path.join(manager.userDataDir, 'models', '.downloads', 'restart.part')
  fs.mkdirSync(path.dirname(part), { recursive: true })
  fs.writeFileSync(part, Buffer.from('stale'))
  await manager.install()
  assert.equal(fs.readFileSync(path.join(manager.userDataDir, 'models', 'restart', 'restart.bin'), 'utf8'), body.toString())
})

test('a complete valid part is verified locally without an invalid Range request', async (t) => {
  const body = Buffer.from('already complete')
  const manifest = validateManifest(manifestFor([{ id: 'complete', body }]))
  let fetches = 0
  const manager = managerFor(t, manifest, async () => { fetches++; return response(body, { status: 416 }) })
  const part = path.join(manager.userDataDir, 'models', '.downloads', 'complete.part')
  fs.mkdirSync(path.dirname(part), { recursive: true })
  fs.writeFileSync(part, body)
  await manager.install()
  assert.equal(fetches, 0)
  assert.equal(fs.readFileSync(path.join(manager.userDataDir, 'models', 'complete', 'complete.bin'), 'utf8'), body.toString())
})

test('bad hashes and overlong bodies fail closed and remove the poisoned part', async (t) => {
  for (const [id, expectedBody, delivered, code] of [
    ['bad-hash', Buffer.from('right'), Buffer.from('wrong'), 'DOWNLOAD_HASH_MISMATCH'],
    ['too-long', Buffer.from('short'), Buffer.from('longer'), 'DOWNLOAD_SIZE_MISMATCH']
  ]) {
    const manifest = manifestFor([{ id, body: expectedBody }])
    const manager = managerFor(t, manifest, async () => response(delivered))
    await assert.rejects(manager.install(), (error) => error.code === code && !error.message.includes('github'))
    assert.equal(fs.existsSync(path.join(manager.userDataDir, 'models', '.downloads', `${id}.part`)), false)
    assert.equal(manager.getStatus().state, 'error')
    assert.equal(manager.getStatus().resources[0].state, 'error')
    assert.equal(manager.getStatus().resources[0].downloadedBytes, 0)
  }
})

test('redirects are followed manually and every hop must use an approved HTTPS host', async (t) => {
  const body = Buffer.from('redirected')
  const manifest = manifestFor([{ id: 'redirect', body }])
  const seen = []
  const manager = managerFor(t, manifest, async (url, options) => {
    seen.push([url, options.redirect])
    if (seen.length === 1) return response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/asset' } })
    return response(body)
  })
  await manager.install()
  assert.deepEqual(seen.map((item) => item[1]), ['manual', 'manual'])

  const blocked = managerFor(t, manifest, async () => response(null, { status: 302, headers: { location: 'https://evil.example/asset' } }))
  await assert.rejects(blocked.install(), (error) => error.code === 'DOWNLOAD_HOST_BLOCKED')

  const insecure = structuredClone(manifest)
  insecure.artifacts[0].url = 'https://evil.example/file'
  const rejected = managerFor(t, insecure, async () => response(body))
  await assert.rejects(rejected.install(), (error) => error.code === 'DOWNLOAD_HOST_BLOCKED')

  const looping = managerFor(t, manifest, async () => response(null, { status: 302, headers: { location: 'https://github.com/again' } }))
  await assert.rejects(looping.install(), (error) => error.code === 'TOO_MANY_REDIRECTS')
})

test('archive traversal and a wrong top-level directory are rejected before extraction', async (t) => {
  const body = Buffer.from('fake archive')
  for (const listing of [['../escape'], ['wrong/file.bin'], ['C:\\escape']]) {
    const raw = manifestFor([{
      id: 'archive', body, artifactKind: 'archive', directoryName: 'approved', requiredFiles: ['model.bin']
    }])
    const manager = managerFor(t, raw, async () => response(body), {
      spawnImpl: makeTarSpawn({ listing, extract: () => assert.fail('unsafe archive was extracted') })
    })
    await assert.rejects(manager.install(), (error) => error.code === 'ARCHIVE_UNSAFE')
  }
})

test('archive extraction requires ordinary expected files inside the approved root', async (t) => {
  const body = Buffer.from('archive missing file')
  const raw = manifestFor([{
    id: 'archive-missing', body, artifactKind: 'archive', directoryName: 'approved', requiredFiles: ['model.bin']
  }])
  const manager = managerFor(t, raw, async () => response(body), {
    spawnImpl: makeTarSpawn({
      listing: ['approved/', 'approved/other.bin'],
      extract: (destination) => fs.mkdirSync(path.join(destination, 'approved'), { recursive: true })
    })
  })
  await assert.rejects(manager.install(), (error) => error.code === 'MODEL_FILES_MISSING')
})

test('archive link entries are rejected before extraction', async (t) => {
  const body = Buffer.from('fake link archive')
  const raw = manifestFor([{
    id: 'archive-link', body, artifactKind: 'archive', directoryName: 'approved', requiredFiles: ['model.bin']
  }])
  const manager = managerFor(t, raw, async () => response(body), {
    spawnImpl: makeTarSpawn({
      listing: ['approved/', 'approved/model.bin'],
      verbose: [
        'drwxr-xr-x owner/group 0 Jan 1 00:00 approved/',
        'lrwxrwxrwx owner/group 0 Jan 1 00:00 approved/model.bin -> ../../escape'
      ],
      extract: () => assert.fail('link archive was extracted')
    })
  })
  await assert.rejects(manager.install(), (error) => error.code === 'ARCHIVE_UNSAFE')
})

test('successful archive install writes a matching marker and initialize requires it', async (t) => {
  const body = Buffer.from('fake valid archive')
  const raw = manifestFor([{
    id: 'archive-ready', body, artifactKind: 'archive', installId: 'installed', directoryName: 'approved', requiredFiles: ['model.bin']
  }])
  const validated = validateManifest(raw)
  let fetches = 0
  let extractionArguments = null
  const manager = managerFor(t, validated, async () => { fetches++; return response(body) }, {
    spawnImpl: makeTarSpawn({
      listing: ['approved/', 'approved/model.bin'],
      extract: (destination, args) => {
        extractionArguments = args
        fs.mkdirSync(path.join(destination, 'approved'), { recursive: true })
        fs.writeFileSync(path.join(destination, 'approved', 'model.bin'), 'model')
      }
    })
  })
  await manager.install()
  assert.deepEqual(
    extractionArguments.slice(extractionArguments.indexOf('-C') + 2),
    ['approved/model.bin']
  )
  const target = path.join(manager.userDataDir, 'models', 'installed', 'approved')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(target, '.ready.json'), 'utf8')), marker(validated, validated.artifacts[0]))

  const second = new ModelManager({ userDataDir: manager.userDataDir, manifest: validated, fetchImpl: async () => { throw new Error('must not fetch') } })
  assert.equal((await second.initialize()).state, 'ready')
  assert.equal((await second.install()).state, 'ready')
  assert.equal(fetches, 1)

  fs.writeFileSync(path.join(target, '.ready.json'), JSON.stringify({
    ...marker(validated, validated.artifacts[0]),
    unexpected: true
  }))
  const markerWithExtraData = new ModelManager({
    userDataDir: manager.userDataDir,
    manifest: validated,
    fetchImpl: async () => response(body),
    spawnImpl: manager.spawnImpl
  })
  assert.equal((await markerWithExtraData.initialize()).state, 'missing')

  fs.rmSync(path.join(target, '.ready.json'))
  const withoutMarker = new ModelManager({ userDataDir: manager.userDataDir, manifest: validated, fetchImpl: async () => response(body), spawnImpl: manager.spawnImpl })
  assert.equal((await withoutMarker.initialize()).state, 'missing')
})

test('repeated initialize and concurrent install calls are idempotent', async (t) => {
  const body = Buffer.from('once only')
  const manifest = manifestFor([{ id: 'once', body }])
  let fetches = 0
  const manager = managerFor(t, manifest, async () => {
    fetches++
    await new Promise((resolve) => setImmediate(resolve))
    return response(body)
  })
  assert.equal((await manager.initialize()).state, 'missing')
  assert.equal((await manager.initialize()).state, 'missing')
  const one = manager.install()
  const two = manager.install()
  assert.equal(one, two)
  await one
  assert.equal(fetches, 1)
  await manager.install()
  assert.equal(fetches, 1)
})

test('shutdown aborts fetch, keeps a legal part and exposes only a safe terminal status', async (t) => {
  const body = Buffer.from('resume after restart')
  const manifest = validateManifest(manifestFor([{ id: 'abort-me', body }]))
  let fetchStarted
  const started = new Promise((resolve) => { fetchStarted = resolve })
  const manager = managerFor(t, manifest, async (_url, options) => {
    fetchStarted()
    return await new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('secret network failure')), { once: true }))
  })
  const part = path.join(manager.userDataDir, 'models', '.downloads', 'abort-me.part')
  fs.mkdirSync(path.dirname(part), { recursive: true })
  fs.writeFileSync(part, body.subarray(0, 4))
  const installing = manager.install()
  await started
  await manager.shutdown()
  await assert.rejects(installing, (error) => error.code === 'ABORTED' && error.message === '模型安装已停止')
  assert.equal(fs.statSync(part).size, 4)
  const status = manager.getStatus()
  assert.equal(status.state, 'missing')
  assert.equal(status.canInstall, false)
  assert.equal(JSON.stringify(status).includes('secret'), false)
  await manager.shutdown()
})

test('shutdown kills an active extractor, waits for it and removes owned staging', async (t) => {
  const body = Buffer.from('archive awaiting extraction')
  const raw = manifestFor([{
    id: 'abort-tar', body, artifactKind: 'archive', directoryName: 'approved', requiredFiles: ['model.bin']
  }])
  let listStarted
  const started = new Promise((resolve) => { listStarted = resolve })
  const spawnImpl = () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => setImmediate(() => child.emit('close', 1))
    setImmediate(listStarted)
    return child
  }
  const manager = managerFor(t, raw, async () => response(body), { spawnImpl })
  const installing = manager.install()
  await started
  await manager.shutdown()
  await assert.rejects(installing, (error) => error.code === 'ABORTED')
  assert.deepEqual(fs.readdirSync(path.join(manager.userDataDir, 'models', '.staging')), [])
})

test('bounded shutdown returns when a fetch ignores abort', async (t) => {
  const body = Buffer.from('fetch never settles')
  const manifest = manifestFor([{ id: 'hung-fetch', body }])
  let fetchStarted
  const started = new Promise((resolve) => { fetchStarted = resolve })
  const manager = managerFor(t, manifest, async () => {
    fetchStarted()
    return new Promise(() => {})
  })
  const installing = manager.install()
  installing.catch(() => {})
  await started

  assert.deepEqual(await manager.shutdownWithin(20), {
    graceful: false,
    reason: 'SHUTDOWN_TIMEOUT'
  })
  assert.equal(manager.getStatus().canInstall, false)
  assert.deepEqual(await manager.shutdownWithin(20), {
    graceful: false,
    reason: 'SHUTDOWN_TIMEOUT'
  })
  await assert.rejects(manager.install(), (error) => error.code === 'SHUTDOWN')
})

test('bounded shutdown survives an extractor that ignores kill and the next start removes stale staging', async (t) => {
  const body = Buffer.from('archive extractor never settles')
  const manifest = manifestFor([{
    id: 'hung-tar', body, artifactKind: 'archive', directoryName: 'approved', requiredFiles: ['model.bin']
  }])
  let tarStarted
  const started = new Promise((resolve) => { tarStarted = resolve })
  const spawnImpl = () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => {}
    setImmediate(tarStarted)
    return child
  }
  const manager = managerFor(t, manifest, async () => response(body), { spawnImpl })
  const installing = manager.install()
  installing.catch(() => {})
  await started

  assert.deepEqual(await manager.shutdownWithin(20), {
    graceful: false,
    reason: 'SHUTDOWN_TIMEOUT'
  })
  const stagingRoot = path.join(manager.userDataDir, 'models', '.staging')
  assert.ok(fs.readdirSync(stagingRoot).length > 0)

  const restarted = new ModelManager({
    userDataDir: manager.userDataDir,
    manifest,
    fetchImpl: async () => response(body),
    spawnImpl
  })
  await restarted.initialize()
  assert.deepEqual(fs.readdirSync(stagingRoot), [])
  await restarted.shutdown()
})
