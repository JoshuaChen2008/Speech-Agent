'use strict'

// @ts-check

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const { spawn } = require('node:child_process')
const {
  PRODUCTION_MODEL_MANIFEST,
  deepFreeze,
  validateManifest
} = require('./model-manifest')

const STATUS_SCHEMA_VERSION = 1
const MAX_REDIRECTS = 5
const MAX_TAR_LIST_BYTES = 2 * 1024 * 1024
const DEFAULT_MODEL_SHUTDOWN_TIMEOUT_MS = 5000
const DEFAULT_TAR_PATH = process.platform === 'win32'
  ? path.win32.join(
      typeof process.env.SystemRoot === 'string' && path.win32.isAbsolute(process.env.SystemRoot)
        ? process.env.SystemRoot
        : 'C:\\Windows',
      'System32',
      'tar.exe'
    )
  : 'tar'
const DEFAULT_ALLOWED_HOSTS = Object.freeze([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com'
])

const SAFE_MESSAGES = Object.freeze({
  ABORTED: '模型安装已停止',
  ARCHIVE_UNSAFE: '模型归档不安全',
  DOWNLOAD_FAILED: '模型下载失败',
  DOWNLOAD_HASH_MISMATCH: '模型校验失败',
  DOWNLOAD_HOST_BLOCKED: '下载来源不受信任',
  DOWNLOAD_SIZE_MISMATCH: '下载大小不符',
  INSTALL_FAILED: '模型安装失败',
  INVALID_MANIFEST: '模型清单无效',
  MODEL_FILES_MISSING: '模型文件不完整',
  SHUTDOWN: '模型管理器已关闭',
  TOO_MANY_REDIRECTS: '下载重定向过多'
})

class ModelManagerError extends Error {
  constructor (code) {
    super(SAFE_MESSAGES[code] || SAFE_MESSAGES.INSTALL_FAILED)
    this.name = 'ModelManagerError'
    this.code = SAFE_MESSAGES[code] ? code : 'INSTALL_FAILED'
  }
}

function safeError (code) {
  return new ModelManagerError(code)
}

function cloneAndFreeze (value) {
  const clone = typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value))
  return deepFreeze(clone)
}

function isWithin (parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)
}

function markerFor (manifest, artifact) {
  return {
    manifestVersion: manifest.version,
    artifactId: artifact.id,
    sha256: artifact.sha256,
    bytes: artifact.bytes
  }
}

async function * responseChunks (body) {
  if (!body) throw safeError('DOWNLOAD_FAILED')
  if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) yield Buffer.from(chunk)
    return
  }
  if (typeof body.getReader === 'function') {
    const reader = body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) return
        yield Buffer.from(value)
      }
    } finally {
      reader.releaseLock()
    }
  } else {
    throw safeError('DOWNLOAD_FAILED')
  }
}

class ModelManager {
  constructor (options) {
    if (!options || typeof options.userDataDir !== 'string' || options.userDataDir.length === 0) throw new TypeError('userDataDir is required')
    try {
      this.manifest = validateManifest(options.manifest || PRODUCTION_MODEL_MANIFEST)
    } catch {
      throw safeError('INVALID_MANIFEST')
    }
    this.userDataDir = path.resolve(options.userDataDir)
    this.modelsRoot = path.join(this.userDataDir, 'models')
    this.downloadsRoot = path.join(this.modelsRoot, '.downloads')
    this.stagingRoot = path.join(this.modelsRoot, '.staging')
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    if (typeof this.fetchImpl !== 'function') throw new TypeError('fetch is unavailable')
    this.allowedHosts = new Set((options.allowedHosts || DEFAULT_ALLOWED_HOSTS).map((host) => String(host).toLowerCase()))
    if (this.allowedHosts.size === 0 || [...this.allowedHosts].some((host) => !/^[a-z0-9.-]+$/.test(host))) throw safeError('INVALID_MANIFEST')
    this.tarPath = options.tarPath || DEFAULT_TAR_PATH
    this.spawnImpl = options.spawnImpl || spawn
    this.now = options.now || (() => Date.now())
    this.randomId = options.randomId || (() => crypto.randomBytes(12).toString('hex'))
    this.externalReady = options.externalReady || null
    this.listeners = new Set()
    this.activeAbortController = null
    this.activeChild = null
    this.activeStaging = new Set()
    this.installPromise = null
    this.initializePromise = null
    this.shutdownPromise = null
    this.forcedShutdownReason = null
    this.initialized = false
    this.closed = false
    this.resourceState = new Map(this.manifest.artifacts.map((artifact) => [artifact.id, {
      state: 'missing',
      downloadedBytes: 0,
      totalBytes: artifact.bytes
    }]))
    this.status = this._makeStatus('missing', null, null)
  }

  async initialize () {
    if (this.closed) throw safeError('SHUTDOWN')
    if (this.initializePromise) return this.initializePromise
    if (this.initialized) return this.getStatus()
    this.initializePromise = this._initialize().finally(() => { this.initializePromise = null })
    return this.initializePromise
  }

  async _initialize () {
    await fsp.mkdir(this.downloadsRoot, { recursive: true })
    await fsp.mkdir(this.stagingRoot, { recursive: true })
    await this._assertManagedDirectory(this.modelsRoot, this.userDataDir)
    await this._assertManagedDirectory(this.downloadsRoot, this.modelsRoot)
    await this._assertManagedDirectory(this.stagingRoot, this.modelsRoot)
    await this._cleanupStaleStaging()
    for (const artifact of this.manifest.artifacts) {
      let ready = await this._isArtifactReady(artifact)
      if (!ready && this.externalReady) {
        try {
          ready = typeof this.externalReady === 'function'
            ? Boolean(await this.externalReady(artifact.id))
            : Boolean(this.externalReady)
        } catch { ready = false }
      }
      const part = this._partPath(artifact)
      let downloadedBytes = 0
      try {
        const stat = await fsp.lstat(part)
        if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= artifact.bytes) downloadedBytes = stat.size
      } catch { /* absent */ }
      this.resourceState.set(artifact.id, {
        state: ready ? 'ready' : 'missing',
        downloadedBytes: ready ? artifact.bytes : downloadedBytes,
        totalBytes: artifact.bytes
      })
    }
    this.initialized = true
    this._publish(this._allReady() ? 'ready' : 'missing', null, null)
    return this.getStatus()
  }

  getStatus () {
    return cloneAndFreeze(this.status)
  }

  onStatus (callback) {
    if (typeof callback !== 'function') throw new TypeError('status callback must be a function')
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  install () {
    if (this.closed) return Promise.reject(safeError('SHUTDOWN'))
    if (this.installPromise) return this.installPromise
    this.installPromise = this._install().finally(() => { this.installPromise = null })
    return this.installPromise
  }

  async _install () {
    try {
      if (!this.initialized) await this.initialize()
      for (const artifact of this.manifest.artifacts) {
        if (this.closed) throw safeError('ABORTED')
        if ((this.resourceState.get(artifact.id) || {}).state === 'ready' && (await this._isArtifactReady(artifact) || await this._isExternalReady(artifact.id))) continue
        await this._installArtifact(artifact)
      }
      this._publish('ready', null, null)
      return this.getStatus()
    } catch (error) {
      const normalized = error instanceof ModelManagerError
        ? error
        : safeError(this.closed ? 'ABORTED' : 'INSTALL_FAILED')
      const currentArtifactId = this.status.currentArtifactId
      if (currentArtifactId) await this._recordResourceError(currentArtifactId, normalized.code === 'ABORTED' ? 'missing' : 'error')
      if (!this.closed || normalized.code !== 'ABORTED') this._publish('error', null, normalized)
      throw normalized
    }
  }

  async _installArtifact (artifact) {
    this._setResource(artifact, 'downloading')
    this._publish('downloading', artifact.id, null)
    const archive = await this._download(artifact)
    this._setResource(artifact, 'verifying', artifact.bytes)
    this._publish('verifying', artifact.id, null)

    const staging = this._newStagingPath(artifact)
    this.activeStaging.add(staging)
    await fsp.mkdir(staging, { recursive: false })
    try {
      let stagedRoot
      if (artifact.artifactKind === 'archive') {
        await this._inspectArchive(archive, artifact)
        /* Upstream release archives may contain example WAV files and other
           non-runtime material. Product userData is audio-free by contract,
           so extract only the immutable allowlisted model files after the
           whole archive has passed path/type inspection. */
        const selectedEntries = artifact.requiredFiles.map((name) => `${artifact.directoryName}/${name}`)
        await this._runTar(['-xf', archive, '-C', staging, ...selectedEntries])
        stagedRoot = path.join(staging, artifact.directoryName)
      } else {
        stagedRoot = path.join(staging, artifact.installId)
        await fsp.mkdir(stagedRoot, { recursive: false })
        await fsp.copyFile(archive, path.join(stagedRoot, artifact.fileName), fs.constants.COPYFILE_EXCL)
      }
      this._throwIfClosed()
      await this._validateExpectedFiles(stagedRoot, artifact.requiredFiles, staging)
      this._throwIfClosed()
      await fsp.writeFile(path.join(stagedRoot, '.ready.json'), `${JSON.stringify(markerFor(this.manifest, artifact))}\n`, { flag: 'wx' })
      this._throwIfClosed()
      await this._replaceArtifact(stagedRoot, this._targetPath(artifact), staging)
      await this._safeRemove(archive, 'download')
      this._setResource(artifact, 'ready', artifact.bytes)
      this._publish(this._allReady() ? 'ready' : 'downloading', null, null)
    } finally {
      this.activeStaging.delete(staging)
      await this._safeRemove(staging, 'staging').catch(() => {})
    }
  }

  async _download (artifact) {
    const part = this._partPath(artifact)
    let offset = 0
    try {
      const stat = await fsp.lstat(part)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > artifact.bytes) {
        await this._safeRemove(part, 'download')
      } else {
        offset = stat.size
      }
    } catch { /* absent */ }

    if (offset === artifact.bytes) {
      const digest = await this._hashFile(part, artifact.bytes)
      if (digest === artifact.sha256) return part
      await this._safeRemove(part, 'download')
      offset = 0
    }
    this._setResource(artifact, 'downloading', offset)
    this._publish('downloading', artifact.id, null)

    const controller = new AbortController()
    this.activeAbortController = controller
    let response
    try {
      response = await this._fetchFollowingRedirects(artifact.url, offset, controller.signal)
      if (offset > 0 && response.status === 200) offset = 0
      else if (response.status === 206) {
        const contentRange = response.headers && response.headers.get && response.headers.get('content-range')
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange || '')
        if (!match || Number(match[1]) !== offset || Number(match[2]) < offset || Number(match[3]) !== artifact.bytes) throw safeError('DOWNLOAD_SIZE_MISMATCH')
      } else if (response.status !== 200) {
        throw safeError('DOWNLOAD_FAILED')
      }

      const hash = crypto.createHash('sha256')
      if (offset > 0) {
        let hashed = 0
        for await (const chunk of fs.createReadStream(part)) {
          hashed += chunk.length
          if (hashed > offset) throw safeError('DOWNLOAD_SIZE_MISMATCH')
          hash.update(chunk)
        }
        if (hashed !== offset) throw safeError('DOWNLOAD_SIZE_MISMATCH')
      }
      const handle = await fsp.open(part, offset === 0 ? 'w' : 'a')
      let downloaded = offset
      try {
        for await (const chunk of responseChunks(response.body)) {
          if (controller.signal.aborted) throw safeError('ABORTED')
          downloaded += chunk.length
          if (downloaded > artifact.bytes) throw safeError('DOWNLOAD_SIZE_MISMATCH')
          let written = 0
          while (written < chunk.length) {
            const result = await handle.write(chunk, written, chunk.length - written)
            if (!result || result.bytesWritten < 1) throw safeError('DOWNLOAD_FAILED')
            written += result.bytesWritten
          }
          hash.update(chunk)
          this._setResource(artifact, 'downloading', downloaded)
          this._publish('downloading', artifact.id, null)
        }
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (downloaded !== artifact.bytes) throw safeError('DOWNLOAD_SIZE_MISMATCH')
      if (hash.digest('hex') !== artifact.sha256) throw safeError('DOWNLOAD_HASH_MISMATCH')
      return part
    } catch (error) {
      const normalized = error instanceof ModelManagerError
        ? error
        : safeError(controller.signal.aborted ? 'ABORTED' : 'DOWNLOAD_FAILED')
      if (normalized.code === 'DOWNLOAD_HASH_MISMATCH' || normalized.code === 'DOWNLOAD_SIZE_MISMATCH') {
        await this._safeRemove(part, 'download').catch(() => {})
      }
      throw normalized
    } finally {
      if (this.activeAbortController === controller) this.activeAbortController = null
    }
  }

  async _fetchFollowingRedirects (initialUrl, offset, signal) {
    let current = initialUrl
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
      const parsed = this._validateDownloadUrl(current)
      let response
      try {
        response = await this.fetchImpl(parsed.toString(), {
          method: 'GET',
          redirect: 'manual',
          headers: offset > 0 ? { Range: `bytes=${offset}-` } : {},
          signal
        })
      } catch {
        throw safeError(signal.aborted ? 'ABORTED' : 'DOWNLOAD_FAILED')
      }
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      if (redirects === MAX_REDIRECTS) throw safeError('TOO_MANY_REDIRECTS')
      const location = response.headers && response.headers.get && response.headers.get('location')
      if (!location) throw safeError('DOWNLOAD_FAILED')
      try { current = new URL(location, parsed).toString() } catch { throw safeError('DOWNLOAD_HOST_BLOCKED') }
      if (response.body && typeof response.body.cancel === 'function') await response.body.cancel().catch(() => {})
    }
    throw safeError('TOO_MANY_REDIRECTS')
  }

  _validateDownloadUrl (raw) {
    let parsed
    try { parsed = new URL(raw) } catch { throw safeError('DOWNLOAD_HOST_BLOCKED') }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443') || !this.allowedHosts.has(parsed.hostname.toLowerCase())) {
      throw safeError('DOWNLOAD_HOST_BLOCKED')
    }
    return parsed
  }

  _throwIfClosed () {
    if (this.closed) throw safeError('ABORTED')
  }

  async _inspectArchive (archive, artifact) {
    const listing = await this._runTar(['-tf', archive])
    const entries = listing.split(/\r?\n/).filter(Boolean)
    if (entries.length === 0) throw safeError('ARCHIVE_UNSAFE')
    for (const rawEntry of entries) {
      if (rawEntry.includes('\0') || rawEntry.startsWith('/') || rawEntry.startsWith('\\')) throw safeError('ARCHIVE_UNSAFE')
      let entry = rawEntry.replace(/\\/g, '/')
      while (entry.startsWith('./')) entry = entry.slice(2)
      const segments = entry.split('/').filter((segment) => segment.length > 0)
      if (segments.length === 0 || segments.includes('..') || segments.some((segment) => segment.includes(':')) || /^[a-zA-Z]:/.test(entry) || segments[0] !== artifact.directoryName) throw safeError('ARCHIVE_UNSAFE')
    }
    const verbose = await this._runTar(['-tvf', archive])
    const verboseEntries = verbose.split(/\r?\n/).filter(Boolean)
    if (verboseEntries.length !== entries.length) throw safeError('ARCHIVE_UNSAFE')
    for (const line of verboseEntries) {
      const type = line[0]
      if ((type !== '-' && type !== 'd') || /\slink to\s|\s->\s/i.test(line)) throw safeError('ARCHIVE_UNSAFE')
    }
  }

  async _hashFile (file, expectedBytes) {
    const hash = crypto.createHash('sha256')
    let bytes = 0
    try {
      for await (const chunk of fs.createReadStream(file)) {
        bytes += chunk.length
        if (bytes > expectedBytes) throw safeError('DOWNLOAD_SIZE_MISMATCH')
        hash.update(chunk)
      }
    } catch (error) {
      if (error instanceof ModelManagerError) throw error
      throw safeError('DOWNLOAD_FAILED')
    }
    if (bytes !== expectedBytes) throw safeError('DOWNLOAD_SIZE_MISMATCH')
    return hash.digest('hex')
  }

  _runTar (args) {
    if (this.closed) return Promise.reject(safeError('ABORTED'))
    return new Promise((resolve, reject) => {
      let child
      try {
        child = this.spawnImpl(this.tarPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch {
        reject(safeError('INSTALL_FAILED'))
        return
      }
      this.activeChild = child
      let output = ''
      let outputBytes = 0
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        if (this.activeChild === child) this.activeChild = null
        error ? reject(error) : resolve(value)
      }
      if (child.stdout && typeof child.stdout.on === 'function') child.stdout.on('data', (chunk) => {
        outputBytes += chunk.length
        if (outputBytes > MAX_TAR_LIST_BYTES) {
          try { child.kill() } catch {}
          finish(safeError('ARCHIVE_UNSAFE'))
        } else output += chunk.toString('utf8')
      })
      if (child.stderr && typeof child.stderr.resume === 'function') child.stderr.resume()
      child.once('error', () => finish(safeError(this.closed ? 'ABORTED' : 'INSTALL_FAILED')))
      child.once('close', (code) => finish(code === 0 ? null : safeError(this.closed ? 'ABORTED' : 'INSTALL_FAILED'), output))
    })
  }

  async _validateExpectedFiles (root, requiredFiles, staging) {
    let rootStat
    try { rootStat = await fsp.lstat(root) } catch { throw safeError('MODEL_FILES_MISSING') }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw safeError('MODEL_FILES_MISSING')
    const stagingReal = await fsp.realpath(staging)
    const rootReal = await fsp.realpath(root)
    if (!isWithin(stagingReal, rootReal)) throw safeError('ARCHIVE_UNSAFE')
    for (const name of requiredFiles) {
      const candidate = path.join(root, name)
      let stat
      try { stat = await fsp.lstat(candidate) } catch { throw safeError('MODEL_FILES_MISSING') }
      if (!stat.isFile() || stat.isSymbolicLink()) throw safeError('MODEL_FILES_MISSING')
      const real = await fsp.realpath(candidate)
      if (!isWithin(rootReal, real)) throw safeError('ARCHIVE_UNSAFE')
    }
  }

  async _isArtifactReady (artifact) {
    const target = this._targetPath(artifact)
    try {
      const targetStat = await fsp.lstat(target)
      if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) return false
      const targetReal = await fsp.realpath(target)
      const modelsReal = await fsp.realpath(this.modelsRoot)
      if (!isWithin(modelsReal, targetReal)) return false
      const markerPath = path.join(target, '.ready.json')
      const markerStat = await fsp.lstat(markerPath)
      if (!markerStat.isFile() || markerStat.isSymbolicLink() || !isWithin(targetReal, await fsp.realpath(markerPath))) return false
      const marker = JSON.parse(await fsp.readFile(markerPath, 'utf8'))
      const expected = markerFor(this.manifest, artifact)
      const markerKeys = Object.keys(marker).sort()
      if (markerKeys.join(',') !== 'artifactId,bytes,manifestVersion,sha256') return false
      if (marker.manifestVersion !== expected.manifestVersion || marker.artifactId !== expected.artifactId || marker.sha256 !== expected.sha256 || marker.bytes !== expected.bytes) return false
      for (const name of artifact.requiredFiles) {
        const candidate = path.join(target, name)
        const stat = await fsp.lstat(candidate)
        if (!stat.isFile() || stat.isSymbolicLink()) return false
        const real = await fsp.realpath(candidate)
        if (!isWithin(targetReal, real)) return false
      }
      return true
    } catch { return false }
  }

  async _isExternalReady (artifactId) {
    if (!this.externalReady) return false
    try {
      return typeof this.externalReady === 'function'
        ? Boolean(await this.externalReady(artifactId))
        : Boolean(this.externalReady)
    } catch { return false }
  }

  async _recordResourceError (artifactId, state) {
    const artifact = this.manifest.artifacts.find((candidate) => candidate.id === artifactId)
    if (!artifact) return
    let downloadedBytes = 0
    try {
      const stat = await fsp.lstat(this._partPath(artifact))
      if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= artifact.bytes) downloadedBytes = stat.size
    } catch { /* absent or invalid */ }
    this._setResource(artifact, state, downloadedBytes)
  }

  async _cleanupStaleStaging () {
    let entries
    try {
      entries = await fsp.readdir(this.stagingRoot, { withFileTypes: true })
    } catch {
      throw safeError('INSTALL_FAILED')
    }
    for (const entry of entries) {
      const target = path.join(this.stagingRoot, entry.name)
      if (!isWithin(this.stagingRoot, target)) throw safeError('INSTALL_FAILED')
      await this._safeRemove(target, 'staging').catch(() => {})
    }
  }

  async _replaceArtifact (source, target, staging) {
    this._assertArtifactTarget(target)
    if (!isWithin(this.stagingRoot, staging) || !isWithin(staging, source)) throw safeError('INSTALL_FAILED')
    await fsp.mkdir(path.dirname(target), { recursive: true })
    await this._assertManagedDirectory(path.dirname(target), this.modelsRoot)
    const backup = path.join(staging, `.previous-${this._validatedRandomId()}`)
    if (!isWithin(staging, backup)) throw safeError('INSTALL_FAILED')
    let movedOld = false
    try {
      try {
        await fsp.rename(target, backup)
        movedOld = true
      } catch (error) {
        if (!error || error.code !== 'ENOENT') throw error
      }
      await fsp.rename(source, target)
    } catch {
      if (movedOld) await fsp.rename(backup, target).catch(() => {})
      throw safeError('INSTALL_FAILED')
    }
    if (movedOld) await this._safeRemove(backup, 'staging')
  }

  _targetPath (artifact) {
    const target = artifact.artifactKind === 'archive'
      ? path.join(this.modelsRoot, artifact.installId, artifact.directoryName)
      : path.join(this.modelsRoot, artifact.installId)
    this._assertArtifactTarget(target)
    return target
  }

  _assertArtifactTarget (target) {
    const accepted = this.manifest.artifacts.some((artifact) => {
      const exact = artifact.artifactKind === 'archive'
        ? path.join(this.modelsRoot, artifact.installId, artifact.directoryName)
        : path.join(this.modelsRoot, artifact.installId)
      return path.resolve(exact) === path.resolve(target)
    })
    if (!accepted) throw safeError('INSTALL_FAILED')
  }

  _partPath (artifact) {
    const result = path.join(this.downloadsRoot, `${artifact.id}.part`)
    if (!isWithin(this.downloadsRoot, result)) throw safeError('INVALID_MANIFEST')
    return result
  }

  _validatedRandomId () {
    const value = String(this.randomId())
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw safeError('INSTALL_FAILED')
    return value
  }

  _newStagingPath (artifact) {
    const result = path.join(this.stagingRoot, `${artifact.id}-${this._validatedRandomId()}`)
    if (!isWithin(this.stagingRoot, result)) throw safeError('INSTALL_FAILED')
    return result
  }

  async _safeRemove (target, kind) {
    const parent = kind === 'download' ? this.downloadsRoot : this.stagingRoot
    if (!isWithin(parent, target)) throw safeError('INSTALL_FAILED')
    await this._assertManagedDirectory(parent, this.modelsRoot)
    await fsp.rm(target, { recursive: kind === 'staging', force: true })
  }

  async _assertManagedDirectory (directory, parent) {
    let stat
    try { stat = await fsp.lstat(directory) } catch { throw safeError('INSTALL_FAILED') }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw safeError('INSTALL_FAILED')
    const directoryReal = await fsp.realpath(directory)
    const parentReal = await fsp.realpath(parent)
    if (path.resolve(directory) !== path.resolve(parent) && !isWithin(parentReal, directoryReal)) throw safeError('INSTALL_FAILED')
  }

  _setResource (artifact, state, downloadedBytes) {
    const previous = this.resourceState.get(artifact.id) || { downloadedBytes: 0 }
    this.resourceState.set(artifact.id, {
      state,
      downloadedBytes: downloadedBytes === undefined ? previous.downloadedBytes : downloadedBytes,
      totalBytes: artifact.bytes
    })
  }

  _allReady () {
    return this.manifest.artifacts.every((artifact) => (this.resourceState.get(artifact.id) || {}).state === 'ready')
  }

  _makeStatus (state, currentArtifactId, error) {
    const resources = this.manifest.artifacts.map((artifact) => {
      const resource = this.resourceState.get(artifact.id) || { state: 'missing', downloadedBytes: 0, totalBytes: artifact.bytes }
      return {
        id: artifact.id,
        state: resource.state,
        progress: resource.totalBytes === 0 ? 0 : resource.downloadedBytes / resource.totalBytes,
        downloadedBytes: resource.downloadedBytes,
        totalBytes: resource.totalBytes
      }
    })
    const downloadedBytes = resources.reduce((sum, resource) => sum + resource.downloadedBytes, 0)
    const totalBytes = resources.reduce((sum, resource) => sum + resource.totalBytes, 0)
    return cloneAndFreeze({
      schemaVersion: STATUS_SCHEMA_VERSION,
      state,
      progress: totalBytes === 0 ? 0 : downloadedBytes / totalBytes,
      downloadedBytes,
      totalBytes,
      currentArtifactId,
      resources,
      error: error ? { code: error.code, message: error.message } : null,
      canInstall: !this.closed && state !== 'ready' && state !== 'downloading' && state !== 'verifying'
    })
  }

  _publish (state, currentArtifactId, error) {
    this.status = this._makeStatus(state, currentArtifactId, error)
    for (const listener of this.listeners) {
      try { listener(this.getStatus()) } catch { /* observers cannot break installation */ }
    }
  }

  shutdown () {
    if (this.forcedShutdownReason) return Promise.resolve()
    if (this.shutdownPromise) return this.shutdownPromise
    this.shutdownPromise = this._shutdown()
    return this.shutdownPromise
  }

  async _shutdown () {
    this.closed = true
    if (this.activeAbortController) this.activeAbortController.abort()
    if (this.activeChild) {
      try { this.activeChild.kill() } catch {}
    }
    const pendingInitialize = this.initializePromise
    const pendingInstall = this.installPromise
    if (pendingInitialize) await pendingInitialize.catch(() => {})
    if (pendingInstall) await pendingInstall.catch(() => {})
    const staging = [...this.activeStaging]
    await Promise.all(staging.map((target) => this._safeRemove(target, 'staging').catch(() => {})))
    this._forceClosedStatus()
  }

  async shutdownWithin (timeoutMs = DEFAULT_MODEL_SHUTDOWN_TIMEOUT_MS) {
    if (this.forcedShutdownReason) {
      return Object.freeze({ graceful: false, reason: this.forcedShutdownReason })
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('positive shutdown timeout is required')
    let timer = null
    let timedOut = false
    const deadline = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true
        reject(safeError('SHUTDOWN'))
      }, timeoutMs)
    })
    try {
      await Promise.race([this.shutdown(), deadline])
      return Object.freeze({ graceful: true, reason: null })
    } catch {
      this.forcedShutdownReason = timedOut ? 'SHUTDOWN_TIMEOUT' : 'SHUTDOWN_FAILED'
      this._forceClosedStatus()
      return Object.freeze({ graceful: false, reason: this.forcedShutdownReason })
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  _forceClosedStatus () {
    this.closed = true
    if (this.activeAbortController) this.activeAbortController.abort()
    if (this.activeChild) {
      try { this.activeChild.kill() } catch {}
    }
    this._publish(this._allReady() ? 'ready' : 'missing', null, null)
    this.listeners.clear()
  }
}

module.exports = {
  DEFAULT_MODEL_SHUTDOWN_TIMEOUT_MS,
  DEFAULT_ALLOWED_HOSTS,
  DEFAULT_TAR_PATH,
  ModelManager,
  ModelManagerError,
  STATUS_SCHEMA_VERSION
}
