'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const test = require('node:test')

const { PRODUCTION_MODEL_MANIFEST } = require('../../src/main/services/model-manifest')
const {
  SYSTEM_TAR,
  closeFixtureModelServer,
  createFixtureModelBundle,
  seedInterruptedModelDownload,
  startFixtureModelServer
} = require('../../scripts/model-ui-fixture-support')

const WINDOWS_TAR_SKIP = process.platform !== 'win32'
  ? 'fixture archives intentionally use the Windows product tar boundary'
  : !fs.existsSync(SYSTEM_TAR)
      ? 'Windows System32 tar is unavailable'
      : false

function temporaryDirectory (t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-ui-fixture-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return directory
}

function sha256 (buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex')
}

function listArchive (archivePath) {
  const result = spawnSync(SYSTEM_TAR, ['-tf', archivePath], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024
  })
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, result.stderr || `tar exited with ${result.status}`)
  return result.stdout.replace(/\\/g, '/').split(/\r?\n/).filter(Boolean)
}

test('model UI fixtures retain the production manifest identity and make Windows-tar archives with only required model files', {
  skip: WINDOWS_TAR_SKIP
}, (t) => {
  const root = temporaryDirectory(t)
  const bundle = createFixtureModelBundle(root)

  assert.equal(bundle.manifest.version, PRODUCTION_MODEL_MANIFEST.version)
  assert.deepEqual(
    bundle.manifest.artifacts.map((artifact) => artifact.id),
    PRODUCTION_MODEL_MANIFEST.artifacts.map((artifact) => artifact.id)
  )

  for (const production of PRODUCTION_MODEL_MANIFEST.artifacts) {
    const fixture = bundle.manifest.artifacts.find((artifact) => artifact.id === production.id)
    assert.ok(fixture, `missing fixture artifact ${production.id}`)
    assert.equal(fixture.url, production.url)
    assert.equal(fixture.installId, production.installId)
    assert.equal(fixture.artifactKind, production.artifactKind)
    assert.deepEqual(fixture.requiredFiles, production.requiredFiles)
    const payload = bundle.payloadByPath.get(new URL(production.url).pathname)
    assert.ok(Buffer.isBuffer(payload), `missing fixture payload ${production.id}`)
    assert.equal(fixture.bytes, payload.length)
    assert.equal(fixture.sha256, sha256(payload))

    if (production.artifactKind === 'archive') {
      assert.equal(fixture.directoryName, production.directoryName)
      const archivePath = path.join(root, 'fixture-model-downloads', `${production.id}.tar`)
      const entries = listArchive(archivePath)
      assert.deepEqual(
        entries.sort(),
        [
          `${production.directoryName}/`,
          ...production.requiredFiles.map((name) => `${production.directoryName}/${name}`)
        ].sort()
      )
    } else {
      assert.equal(fixture.fileName, production.fileName)
      assert.equal(payload.equals(Buffer.from('deterministic silero VAD UI fixture\n', 'utf8')), true)
    }
  }
})

test('model UI fixture server is loopback-only and serves complete and resumable byte ranges without external network access', {
  skip: WINDOWS_TAR_SKIP
}, async (t) => {
  const root = temporaryDirectory(t)
  const bundle = createFixtureModelBundle(root)
  const transport = await startFixtureModelServer(bundle.payloadByPath)
  t.after(async () => closeFixtureModelServer(transport.server))

  const artifact = bundle.manifest.artifacts[0]
  const pathname = new URL(artifact.url).pathname
  const payload = bundle.payloadByPath.get(pathname)
  assert.ok(payload)
  const full = await fetch(`http://127.0.0.1:${transport.port}${pathname}`)
  assert.equal(full.status, 200)
  assert.equal(full.headers.get('accept-ranges'), 'bytes')
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), payload)

  const offset = Math.max(1, Math.floor(payload.length / 2))
  const resumed = await fetch(`http://127.0.0.1:${transport.port}${pathname}`, {
    headers: { Range: `bytes=${offset}-` }
  })
  assert.equal(resumed.status, 206)
  assert.equal(resumed.headers.get('content-range'), `bytes ${offset}-${payload.length - 1}/${payload.length}`)
  assert.deepEqual(Buffer.from(await resumed.arrayBuffer()), payload.subarray(offset))

  const malformed = await fetch(`http://127.0.0.1:${transport.port}${pathname}`, {
    headers: { Range: 'bytes=not-a-number-' }
  })
  assert.equal(malformed.status, 416)
  assert.deepEqual(transport.requests, [
    { pathname, range: null },
    { pathname, range: `bytes=${offset}-` },
    { pathname, range: 'bytes=not-a-number-' }
  ])
})

test('model UI fixture seed creates exactly one resumable part under isolated userData', {
  skip: WINDOWS_TAR_SKIP
}, (t) => {
  const root = temporaryDirectory(t)
  const userDataDir = path.join(root, 'user-data')
  const bundle = createFixtureModelBundle(root)
  const seeded = seedInterruptedModelDownload(userDataDir, bundle)
  const artifact = bundle.manifest.artifacts[0]
  const payload = bundle.payloadByPath.get(new URL(artifact.url).pathname)
  const partPath = path.join(userDataDir, 'models', '.downloads', `${artifact.id}.part`)

  assert.equal(seeded.artifactId, artifact.id)
  assert.equal(seeded.resumeBytes, Math.max(1, Math.floor(payload.length / 3)))
  assert.deepEqual(fs.readFileSync(partPath), payload.subarray(0, seeded.resumeBytes))
  assert.deepEqual(
    fs.readdirSync(path.join(userDataDir, 'models', '.downloads')),
    [`${artifact.id}.part`]
  )
  assert.equal(fs.existsSync(path.join(userDataDir, 'models', '.staging')), false)
})
