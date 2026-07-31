'use strict'

// @ts-check

/* Deterministic external-boundary support for the real Electron model UI
   journey. It creates tiny, structurally valid resources while preserving the
   production artifact ids, fixed HTTPS URLs, archive roots and required-file
   allowlists. The renderer never receives this manifest or the loopback URL. */

const crypto = require('node:crypto')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { PRODUCTION_MODEL_MANIFEST } = require('../src/main/services/model-manifest')

const SYSTEM_TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')

function sha256 (value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function runSystemTar (args) {
  const result = spawnSync(SYSTEM_TAR, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 2 * 1024 * 1024
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(result.stderr || `tar exited with ${result.status}`)
  return result.stdout
}

function createFixtureModelBundle (root) {
  if (process.platform !== 'win32' || !fs.statSync(SYSTEM_TAR).isFile()) {
    throw new Error('the model UI fixture requires Windows System32 tar')
  }
  const sourceRoot = path.join(root, 'fixture-model-sources')
  const downloadRoot = path.join(root, 'fixture-model-downloads')
  fs.mkdirSync(sourceRoot, { recursive: true })
  fs.mkdirSync(downloadRoot, { recursive: true })
  const payloadByPath = new Map()

  const artifacts = PRODUCTION_MODEL_MANIFEST.artifacts.map((productionArtifact) => {
    let payload
    if (productionArtifact.artifactKind === 'archive') {
      const parent = path.join(sourceRoot, productionArtifact.id)
      const archiveRoot = path.join(parent, productionArtifact.directoryName)
      fs.mkdirSync(archiveRoot, { recursive: true })
      for (const requiredFile of productionArtifact.requiredFiles) {
        fs.writeFileSync(
          path.join(archiveRoot, requiredFile),
          `ui-model-fixture:${productionArtifact.id}:${requiredFile}\n`
        )
      }
      const archivePath = path.join(downloadRoot, `${productionArtifact.id}.tar`)
      runSystemTar(['-cf', archivePath, '-C', parent, productionArtifact.directoryName])
      const listing = runSystemTar(['-tf', archivePath])
      if (!listing.replace(/\\/g, '/').includes(`${productionArtifact.directoryName}/`)) {
        throw new Error(`fixture archive root is missing: ${productionArtifact.id}`)
      }
      payload = fs.readFileSync(archivePath)
    } else {
      payload = Buffer.from('deterministic silero VAD UI fixture\n', 'utf8')
    }
    payloadByPath.set(new URL(productionArtifact.url).pathname, payload)
    return Object.freeze({
      ...productionArtifact,
      bytes: payload.length,
      sha256: sha256(payload)
    })
  })

  return Object.freeze({
    manifest: Object.freeze({ version: PRODUCTION_MODEL_MANIFEST.version, artifacts: Object.freeze(artifacts) }),
    payloadByPath
  })
}

function startFixtureModelServer (payloadByPath) {
  if (!(payloadByPath instanceof Map)) throw new TypeError('payloadByPath must be a Map')
  const requests = []
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname
    const payload = payloadByPath.get(pathname)
    const range = typeof request.headers.range === 'string' ? request.headers.range : null
    requests.push(Object.freeze({ pathname, range }))
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
        response.writeHead(416, { 'Content-Range': `bytes */${payload.length}` }).end()
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

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('fixture server address is unavailable'))
        return
      }
      resolve(Object.freeze({ server, port: address.port, requests }))
    })
  })
}

async function closeFixtureModelServer (server) {
  if (!server) return
  server.closeAllConnections?.()
  await new Promise((resolve) => server.close(resolve))
}

function seedInterruptedModelDownload (userDataDir, bundle) {
  const artifact = bundle.manifest.artifacts[0]
  const payload = bundle.payloadByPath.get(new URL(artifact.url).pathname)
  if (!payload || payload.length < 3) throw new Error('first fixture artifact is too small')
  const resumeBytes = Math.max(1, Math.floor(payload.length / 3))
  const downloadRoot = path.join(userDataDir, 'models', '.downloads')
  fs.mkdirSync(downloadRoot, { recursive: true })
  fs.writeFileSync(path.join(downloadRoot, `${artifact.id}.part`), payload.subarray(0, resumeBytes))
  return Object.freeze({ artifactId: artifact.id, resumeBytes })
}

module.exports = {
  SYSTEM_TAR,
  closeFixtureModelServer,
  createFixtureModelBundle,
  seedInterruptedModelDownload,
  startFixtureModelServer
}
