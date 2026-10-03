'use strict'

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { MemoryFileClient } = require('./memory-file-client')
const { hash, validateEntry } = require('./memory-file-format')
const { sha256Canonical } = require('../../runtime/storage-worker/canonical-json')
const fail = code => { throw Object.assign(new Error(code), { code }) }
const FILE_OPERATIONS = new Set(['personalContextManage', 'personalContextResolve', 'readPersonalContextToolContext', 'readPersonalContextSessionInput', 'preparePersonalContextSessionIngest',
  'commitPersonalContextSessionIngest', 'personalContextSessionExperiences', 'personalContextQuestionEvidence', 'commitPersonalContextInteractionIngest', 'completeFormalAgentRun', 'createAgentRun', 'terminalizeAgentInteraction'])
class PersonalMemoryFileRuntime {
  constructor ({ gateway, directory, getConfig, modelAccess, onChanged = () => {} }) {
    this.gateway = gateway; this.directory = directory; this.getConfig = getConfig; this.modelAccess = modelAccess; this.onChanged = onChanged
    this.client = new MemoryFileClient(); this.root = null; this.documents = new Map(); this.nativeAvailable = false
    this.tail = Promise.resolve(); this.scanPromise = null; this.watcher = null; this.timer = null; this.closed = false
    this.indexController = null; this.indexTask = null; this.indexState = { state: 'idle', processed: 0, reason: null }
    this.queryCache = new Map(); this.lastPolicy = `${this.active()}`
    this.gateway.personalMemoryRuntime = this
    this.sharing = new (require('./memory-sharing').MemorySharing)(this)
  }
  handles (method) { return FILE_OPERATIONS.has(method) && !this.closed }
  async initialize () {
    let saved
    try {
      saved = JSON.parse(await fsp.readFile(path.join(this.directory, 'memory-root.v1.json'), 'utf8'))
      if (saved.schemaVersion !== 1 || !path.isAbsolute(saved.rootPath) || !/^root\.[a-f0-9]{44}$/.test(saved.rootId) || typeof saved.writeEnabled !== 'boolean') return this
      await this.bind(saved.rootPath, saved.writeEnabled, false, this.active())
    } catch (e) {
      if (!saved && e.code === 'ENOENT') {
        try { const defaultRoot = path.join(this.directory, 'notes'); await fsp.mkdir(defaultRoot, { recursive: true }); await this.bind(defaultRoot, true, true, this.active()) } catch {}
      } else if (saved?.schemaVersion === 1 && path.isAbsolute(saved.rootPath || '')) this.root = { ...saved, error: 'MEMORY_FILE_ROOT_UNAVAILABLE' }
    }
    return this
  }
  assertRoot (id) { if (!this.root || id !== this.root.rootId) fail('MEMORY_FILE_CONFLICT') }
  serial (fn) { const p = this.tail.then(fn, fn); this.tail = p.catch(() => {}); return p }
  async bind (rootPath, writeEnabled = true, persist = true, observe = true) {
    if (this.closed) fail('MEMORY_FILE_UNAVAILABLE')
    const real = await fsp.realpath(rootPath); const stat = await fsp.stat(real)
    if (!stat.isDirectory()) fail('MEMORY_FILE_ROOT_UNAVAILABLE')
    const rootId = `root.${hash(`${stat.dev}:${stat.ino}`).slice(0, 44)}`
    this.cancelIndex(); this.watcher?.close(); clearTimeout(this.timer)
    const result = await this.client.call({ type: 'configure', rootPath: real, recoveryPath: path.join(this.directory, 'memory-recovery') })
    await this.gateway.personalMemoryFiles({ type: 'bind_root', rootId })
    this.root = { schemaVersion: 1, rootPath: real, rootId, writeEnabled }; this.nativeAvailable = result.nativeAvailable
    if (persist) await this.saveRoot()
    this.needsRecovery = true
    if (observe) await this.ensureScan()
    try {
      this.watcher = fs.watch(real, { recursive: true }, () => {
        if (this.closed) return
        void this.gateway.personalMemoryFiles({ type: 'invalidate' }).catch(() => {})
        clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          if (this.active()) void this.serial(async () => { await this.ensureScan(); await this.refreshIndex(); this.scheduleIndex() }).catch(() => {})
          this.changed()
        }, 250)
      })
      this.watcher.on('error', () => { void this.gateway.personalMemoryFiles({ type: 'invalidate' }).catch(() => {}); this.changed() })
    } catch { /* read/commit reconciliation is authoritative */ }
    this.changed(); return this.status()
  }
  active () { const c = this.getConfig(); return c.agentEnabled === true && c.memoryEnabled === true }
  async saveRoot () {
    await fsp.mkdir(this.directory, { recursive: true })
    const target = path.join(this.directory, 'memory-root.v1.json'); const temp = `${target}.${crypto.randomUUID()}.tmp`
    try { const handle = await fsp.open(temp, 'wx'); try { await handle.writeFile(JSON.stringify(this.root)); await handle.sync() } finally { await handle.close() }; await fsp.rename(temp, target) }
    finally { await fsp.rm(temp, { force: true }) }
  }
  async ensureScan () {
    if (!this.root || this.closed) return
    if (this.scanPromise) return this.scanPromise
    this.scanPromise = this.scan()
    try { return await this.scanPromise } finally { this.scanPromise = null }
  }
  async scan () {
    const rootId = this.root.rootId
    if (this.needsRecovery) {
      await this.recover()
      const unresolved = await this.gateway.personalMemoryFiles({ type: 'manifest' })
      await this.client.call({ type: 'clean_orphans', retain: unresolved.operations.map(op => op.operation_id) })
      this.needsRecovery = false
    }
    let scan
    try { scan = await this.client.call({ type: 'scan' }) } catch (e) {
      const changed = !this.root.error
      this.root.error = /^MEMORY_FILE_/.test(e.code) ? e.code : 'MEMORY_FILE_ROOT_UNAVAILABLE'
      await this.gateway.personalMemoryFiles({ type: 'invalidate' }); this.documents.clear(); if (changed) this.changed(); return
    }
    if (this.closed || rootId !== this.root.rootId) return
    const recoveredRoot = Boolean(this.root.error)
    delete this.root.error
    const manifest = await this.gateway.personalMemoryFiles({ type: 'manifest' })
    const ids = new Map()
    for (const file of scan.files) if (file.id) ids.set(file.id, (ids.get(file.id) || 0) + 1)
    const files = scan.files.map(file => ({ ...file, ...(file.id && ids.get(file.id) > 1 ? { error: 'MEMORY_FILE_DUPLICATE_ID' } : {}) }))
    this.documents = new Map(files.map(file => [`file.${hash(`${rootId}:${file.relative}`).slice(0, 44)}`, file]))
    const seen = new Set(files.flatMap(file => file.id ? [file.id] : manifest.files.filter(meta => meta.root_id === rootId && meta.relative_name === file.relative).map(meta => meta.memory_id)))
    let observedRevision = manifest.revision
    for (let offset = 0; offset < Math.max(1, files.length); offset += 64) {
      if (this.closed) return
      const observation = await this.gateway.personalMemoryFiles({ type: 'snapshot', rootId, files: files.slice(offset, offset + 64), start: offset === 0,
        complete: offset + 64 >= files.length, healthy: true, seenIds: offset + 64 >= files.length ? [...seen] : [] })
      observedRevision = observation.revision
      await new Promise(resolve => setImmediate(resolve))
    }
    if (recoveredRoot || observedRevision !== manifest.revision) this.changed()
  }
  async dispatch (method, payload, options, proceed) {
    if (this.ready) await this.ready
    if (options.signal?.aborted) fail('AGENT_CANCELLED')
    if (!this.root) { if (method === 'personalContextManage' && payload.type === 'remember') fail('MEMORY_FILE_ROOT_UNAVAILABLE'); return proceed(payload) }
    const managing = method === 'personalContextManage'
    const policy = managing || this.active() ? await this.gateway.personalMemoryFiles({ type: 'read_policy', request: payload }) : { allowed: false }
    if (policy.allowed && (managing || this.active()) && !(managing && ['forget', 'delete'].includes(payload.type))) await this.ensureScan()
    if (options.signal?.aborted) fail('AGENT_CANCELLED')
    if (managing && ['remember', 'update'].includes(payload.type)) {
      return this.serial(async () => {
        await this.ensureScan()
        const manifest = await this.gateway.personalMemoryFiles({ type: 'manifest' })
        const meta = manifest.files.find(file => file.memory_id === payload.item_id)
        if (payload.type === 'update' && !meta) {
          const page = await this.gateway.enqueue('personalContextManage', { type: 'view_item', item_id: payload.item_id }, { memoryPrepared: true })
          if (page.rows[0].origin === 'explicit') return proceed(payload)
        }
        const proposed = await this.gateway.personalMemoryFiles({ type: 'propose', command: payload })
        await this.save({ operation: payload.type, memoryId: proposed.memoryId, itemRevision: proposed.itemRevision, entry: payload.entry,
        relative: meta?.relative_name || `${proposed.memoryId}.md`, expectedHash: meta?.byte_hash || null, create: !meta, expectedRevision: payload.expected_revision, restore: false })
        const page = await this.gateway.enqueue('personalContextManage', { type: 'view_item', item_id: proposed.memoryId }, { memoryPrepared: true })
        return { revision: page.revision, item: page.rows[0] }
      })
    }
    if (method === 'personalContextResolve' && payload.schemaVersion === 2) {
      if (this.active() && policy.allowed) await this.refreshIndex()
      const enriched = await this.query(payload, options.signal)
      return proceed(enriched)
    }
    if (method === 'readPersonalContextToolContext' && payload.schemaVersion === 2) {
      if (policy.recipeVersion !== '5' || typeof payload.query !== 'string') fail('AGENT_REQUEST_INVALID')
      let memoryIds = []
      if (this.active() && policy.allowed) {
        await this.refreshIndex()
        const enriched = await this.query({ schemaVersion: 2, scope: policy.scope, query: payload.query, semantic_keys: [], aliases: [] }, options.signal)
        const bundle = await this.gateway.enqueue('personalContextResolve', enriched, { memoryPrepared: true, signal: options.signal })
        memoryIds = bundle.personalMemories.map(item => item.memoryId)
      }
      return proceed({ ...payload, memoryIds })
    }
    if (managing && ['forget', 'delete'].includes(payload.type)) return this.serial(async () => {
      const result = await proceed(payload)
      if (payload.type === 'delete') await this.cleanup()
      this.changed(); return result
    })
    const result = await proceed(payload)
    return result
  }
  async cleanup () {
    const manifest = await this.gateway.personalMemoryFiles({ type: 'manifest' }); let removed = 0
    if (!this.root?.writeEnabled || this.root.error) return { removed }
    for (const file of manifest.cleanup) {
      if (file.root_id !== this.root.rootId || file.state === 'conflict') continue
      try {
        await this.client.call({ type: 'remove', relative: file.relative_name, expectedHash: file.byte_hash })
        await this.gateway.personalMemoryFiles({ type: 'cleanup_settle', memoryId: file.memory_id, byteHash: file.byte_hash, removed: true, conflict: false }); removed++
      } catch (e) {
        if (e.code === 'MEMORY_FILE_CONFLICT') await this.gateway.personalMemoryFiles({ type: 'cleanup_settle', memoryId: file.memory_id, byteHash: file.byte_hash, removed: false, conflict: true })
      }
    }
    return { removed }
  }
  async save (input) {
    if (!this.root || this.root.error) fail('MEMORY_FILE_ROOT_UNAVAILABLE')
    if (!input.confirmOnly && !this.root.writeEnabled) fail('MEMORY_FILE_WRITE_DISABLED')
    validateEntry(input.entry)
    const operationId = `fileop.${crypto.randomUUID().replaceAll('-', '')}`
    let prepared = false; let writeStarted = false
    try {
      const staged = await this.client.call({ type: 'prepare', operationId, memoryId: input.memoryId, entry: input.entry, relative: input.relative,
        expectedHash: input.expectedHash, create: input.create, confirmOnly: input.confirmOnly, replacementBytes: input.replacementBytes, recovery: input.recovery })
      await this.gateway.personalMemoryFiles({ type: 'prepare', operationId, operation: input.operation, rootId: this.root.rootId,
        memoryId: input.memoryId, relative: input.relative, oldHash: staged.oldHash, targetHash: staged.byteHash, contentHash: staged.contentHash,
        entry: staged.entry, expectedRevision: input.expectedRevision, itemRevision: input.itemRevision, restore: input.restore === true,
        ...(input.supersedes ? { supersedes: input.supersedes } : {}) })
      prepared = true
      writeStarted = true; await this.client.call({ type: 'write', operationId })
      const result = await this.gateway.personalMemoryFiles({ type: 'commit', operationId,
        file: { id: input.memoryId, byteHash: staged.byteHash, contentHash: staged.contentHash, entry: staged.entry } })
      await this.client.call({ type: 'release', operationId, clean: true })
      this.changed(); await this.ensureScan(); await this.refreshIndex(); this.scheduleIndex(); return result
    } catch (error) {
      try { await this.client.call({ type: 'release', operationId, abort: !prepared, clean: !prepared }) } catch {}
      if (prepared) { try { await this.gateway.personalMemoryFiles({ type: 'settle', operationId, phase: writeStarted ? 'recovery' : 'aborted' }) } catch {} }
      this.changed(); throw error
    }
  }
  async confirm ({ rootId, fileId, expectedHash, restore, entry }) {
    return this.serial(async () => {
      if (rootId) this.assertRoot(rootId)
      await this.ensureScan()
      const file = this.documents.get(fileId)
      if (!file || file.error && file.error !== 'MEMORY_FILE_METADATA_REQUIRED' || file.byteHash !== expectedHash) fail('MEMORY_FILE_CONFLICT')
      const manifest = await this.gateway.personalMemoryFiles({ type: 'manifest' })
      const memoryId = file.id || `memory.${crypto.randomUUID().replaceAll('-', '')}`
      let itemRevision = 0
      try { const page = await this.gateway.enqueue('personalContextManage', { type: 'view_item', item_id: memoryId }, { memoryPrepared: true }); itemRevision = page.rows[0].item_revision } catch (e) { if (e.code !== 'AGENT_CONTEXT_NOT_FOUND') throw e }
      return this.save({ operation: 'confirm', memoryId, itemRevision, entry: file.entry || entry, relative: file.relative,
        expectedHash, create: false, expectedRevision: manifest.revision, restore, confirmOnly: Boolean(file.entry) })
    })
  }
  async migrate (memoryIds, rootId = this.root?.rootId) {
    return this.serial(async () => {
      this.assertRoot(rootId)
      if (!this.root) fail('MEMORY_FILE_ROOT_UNAVAILABLE')
      const selected = new Set(memoryIds); let after = null; let migrated = 0
      do {
        const page = await this.gateway.personalMemoryFiles({ type: 'legacy_page', after })
        for (const item of page.items) if (selected.has(item.memoryId)) {
          const revision = (await this.gateway.personalMemoryFiles({ type: 'manifest' })).revision
          await this.save({ operation: 'migrate', memoryId: item.memoryId, itemRevision: item.itemRevision, entry: item.entry,
            relative: `${item.memoryId}.md`, expectedHash: null, create: true, expectedRevision: revision, restore: false }); migrated++
        }
        after = page.items.at(-1)?.memoryId || null
        if (page.items.length < 64) break
      } while (after && migrated < selected.size)
      return { migrated }
    })
  }
  async recover () {
    const manifest = await this.gateway.personalMemoryFiles({ type: 'manifest' })
    for (const op of manifest.operations) {
      if (op.root_id !== this.root.rootId || op.phase === 'recovery') continue
      let clean = false
      try {
        const file = await this.client.call({ type: 'hold_read', operationId: op.operation_id, relative: op.relative_name })
        if (file.byteHash === op.target_hash) {
          await this.gateway.personalMemoryFiles({ type: 'commit', operationId: op.operation_id, file })
          clean = true
        } else { clean = file.byteHash === op.old_hash; await this.gateway.personalMemoryFiles({ type: 'settle', operationId: op.operation_id, phase: clean ? 'aborted' : 'recovery' }) }
      } catch { await this.gateway.personalMemoryFiles({ type: 'settle', operationId: op.operation_id, phase: 'recovery' }) }
      finally { await this.client.call({ type: 'release', operationId: op.operation_id, clean }) }
    }
  }
  async recoveryReview (operationId) {
    const manifest = await this.gateway.personalMemoryFiles({ type: 'manifest' }); const op = manifest.operations.find(op => op.operation_id === operationId && op.root_id === this.root?.rootId)
    if (!op) fail('MEMORY_FILE_NOT_FOUND')
    let current
    try { current = await this.client.call({ type: 'hold_read', operationId, relative: op.relative_name }) } finally { await this.client.call({ type: 'release', operationId }) }
    const versions = { current: current.entry || null, old: null, new: null }
    for (const version of ['old', 'new']) { try { versions[version] = (await this.client.call({ type: 'recover_bytes', operationId, version })).entry } catch {} }
    return { operationId, expectedHash: current.byteHash, versions }
  }
  async recoveryRestore ({ rootId, operationId, expectedHash, version }) {
    return this.serial(async () => {
      this.assertRoot(rootId)
      const manifest = await this.gateway.personalMemoryFiles({ type: 'manifest' }); const op = manifest.operations.find(op => op.operation_id === operationId && op.root_id === rootId)
      if (!op) fail('MEMORY_FILE_NOT_FOUND')
      let chosen
      if (version === 'current') {
        try { chosen = await this.client.call({ type: 'hold_read', operationId, relative: op.relative_name }); if (chosen.byteHash !== expectedHash) fail('MEMORY_FILE_CONFLICT') }
        finally { await this.client.call({ type: 'release', operationId }) }
      } else chosen = await this.client.call({ type: 'recover_bytes', operationId, version })
      if (!chosen.entry || chosen.id !== op.memory_id) fail('MEMORY_FILE_INVALID')
      const revision = (await this.gateway.personalMemoryFiles({ type: 'manifest' })).revision
      const result = await this.save({ operation: 'confirm', memoryId: op.memory_id, itemRevision: Number(op.item_revision), entry: chosen.entry, relative: op.relative_name,
        expectedHash, create: expectedHash === null, expectedRevision: revision, restore: false, supersedes: operationId, confirmOnly: version === 'current', replacementBytes: version === 'current' ? undefined : Buffer.from(chosen.raw), recovery: true })
      await this.client.call({ type: 'release', operationId, clean: true }); return result
    })
  }
  async refreshIndex () {
    let after = null
    do {
      if (this.closed) return
      const page = await this.gateway.personalMemoryIndex({ type: 'refresh_page', after }); after = page.after
      if (!page.hasMore) break
      await new Promise(resolve => setImmediate(resolve))
    } while (after)
  }
  async query (request, signal) {
    const base = { ...request, vectorRanks: [], degradation: 'embedding_disabled' }
    if (!this.active()) return { ...base, degradation: 'memory_disabled' }
    const access = this.modelAccess?.embeddingAccess
    const config = await access?.catalog(); if (!config?.enabled || !config.disclosureAccepted || !config.credentialPresent) return base
    const status = await this.gateway.personalMemoryIndex({ type: 'status' })
    const generation = status.generation
    if (!generation) return { ...base, degradation: 'index_not_ready' }
    const binding = JSON.parse(generation.binding_json)
    if (binding.configRevision !== config.revision) return { ...base, degradation: 'index_not_ready' }
    try {
      const cacheKey = sha256Canonical({ query: request.query, configRevision: config.revision }); const cached = this.queryCache.get(cacheKey)
      let response = cached && cached.expires > Date.now() ? cached.value : null
      if (!response) {
        const queryBinding = await this.modelAccess.bind({ kind: 'embedding', jobId: `query.${crypto.randomUUID().replaceAll('-', '')}`, inputDigest: sha256Canonical(request.query) })
        response = await access.run(queryBinding, [request.query], { signal, timeoutMs: 3000 })
        this.queryCache.set(cacheKey, { value: response, expires: Date.now() + 120000 })
        if (this.queryCache.size > 64) this.queryCache.delete(this.queryCache.keys().next().value)
      }
      if (response.dimensions !== Number(generation.dimensions) || response.modelId !== binding.responseModel) return { ...base, degradation: 'model_mismatch' }
      let after = null; let ranks = []
      do {
        if (signal?.aborted || !this.active()) fail('AGENT_CANCELLED')
        const page = await this.gateway.personalMemoryIndex({ type: 'vector_page', scope: request.scope, generationId: generation.generation_id, after })
        ranks = await this.client.call({ type: 'vector_rank', query: response.vectors[0], rows: page.items, previous: ranks }); after = page.after
        if (!page.hasMore) break
      } while (after)
      await this.ensureScan()
      if (!this.active()) return { ...base, degradation: 'memory_disabled' }
      return { ...base, vectorRanks: ranks.map(item => item.memoryId), degradation: null }
    } catch (e) { if (signal?.aborted) throw e; return { ...base, degradation: 'embedding_unavailable' } }
  }
  scheduleIndex (full = false) {
    if (this.closed || !this.root || !this.active()) return
    if (this.indexTask) { this.indexAgain = true; return }
    this.indexController = new AbortController()
    this.indexTask = this.buildIndex(full, this.indexController.signal).catch(async e => {
      if (this.buildingGeneration) await this.gateway.personalMemoryIndex({ type: 'generation_cancel', generationId: this.buildingGeneration }).catch(() => {})
      this.indexState = { ...this.indexState, state: e.code === 'AGENT_CANCELLED' ? 'cancelled' : 'failed', reason: /^EMBEDDING_/.test(e.code || '') ? e.code : 'index_failed' }; this.changed()
    }).finally(() => { this.indexTask = null; this.indexController = null; this.buildingGeneration = null; if (this.indexAgain) { this.indexAgain = false; this.scheduleIndex() } })
  }
  async buildIndex (full, signal) {
    const rootId = this.root?.rootId
    if (signal.aborted || !this.active() || this.closed || !rootId) fail('AGENT_CANCELLED')
    const access = this.modelAccess?.embeddingAccess; const config = await access?.catalog()
    if (!config?.enabled || !config.disclosureAccepted || !config.credentialPresent) return
    await this.ensureScan(); await this.refreshIndex()
    const status = await this.gateway.personalMemoryIndex({ type: 'status' })
    const existing = status.generation; const oldBinding = existing ? JSON.parse(existing.binding_json) : null
    const generationId = !full && oldBinding?.configRevision === config.revision ? existing.generation_id : `index.${crypto.randomUUID().replaceAll('-', '')}`
    const newGeneration = generationId !== existing?.generation_id
    const binding = await this.modelAccess.bind({ kind: 'embedding', jobId: generationId, inputDigest: sha256Canonical({ rootId: this.root.rootId, configRevision: config.revision, policy: 'whole-item@1' }) })
    this.buildingGeneration = newGeneration ? generationId : null
    if (newGeneration) await this.gateway.personalMemoryIndex({ type: 'generation_start', generationId, binding })
    this.indexState = { state: 'indexing', processed: 0, reason: null }; this.changed()
    let after = null
    do {
      if (signal.aborted || !this.active() || this.closed || rootId !== this.root?.rootId) fail('AGENT_CANCELLED')
      const page = await this.gateway.personalMemoryIndex({ type: 'embedding_page', after, generationId })
      if (page.items.length) {
        let result; let last
        for (let attempt = 0; attempt < 3; attempt++) {
          try { result = await access.run(binding, page.items.map(item => item.text), { signal, timeoutMs: 30000 }); break } catch (e) {
            last = e
            if (signal.aborted || !['EMBEDDING_TIMEOUT', 'EMBEDDING_RATE_LIMITED', 'EMBEDDING_UNAVAILABLE'].includes(e.code)) throw e
          }
        }
        if (!result) throw last
        if (signal.aborted || !this.active() || this.closed || rootId !== this.root?.rootId) fail('AGENT_CANCELLED')
        await this.ensureScan()
        if (rootId !== this.root?.rootId) fail('AGENT_CANCELLED')
        await this.gateway.personalMemoryIndex({ type: 'vectors_put', generationId, modelId: result.modelId,
          items: page.items.map((item, index) => ({ memoryId: item.memoryId, revisionId: item.revisionId, contentHash: item.contentHash, vector: result.vectors[index] })) })
        this.indexState.processed += page.items.length; this.changed()
      }
      after = page.after; if (!page.hasMore) break
    } while (after)
    if (signal.aborted || this.closed || !this.active() || rootId !== this.root?.rootId) fail('AGENT_CANCELLED')
    if (newGeneration) await this.gateway.personalMemoryIndex({ type: 'generation_publish', generationId })
    this.indexState = { ...this.indexState, state: 'ready', reason: null }; this.changed()
  }
  cancelIndex () {
    this.indexAgain = false; this.queryCache.clear(); this.indexController?.abort(); this.modelAccess?.embeddingAccess?.cancel()
    if (this.buildingGeneration) { const generationId = this.buildingGeneration; this.buildingGeneration = null; void this.gateway.personalMemoryIndex({ type: 'generation_cancel', generationId }).catch(() => {}) }
  }
  policyChanged () { const value = `${this.active()}`; if (value === this.lastPolicy) return; this.lastPolicy = value; this.cancelIndex(); if (this.active()) this.scheduleIndex(); else void this.sharing.stop() }
  async status () {
    const index = await this.gateway.personalMemoryIndex({ type: 'status' })
    const manifest = await this.gateway.personalMemoryFiles({ type: 'manifest' })
    const legacy = await this.gateway.personalMemoryFiles({ type: 'legacy_page', after: null })
    return { root: { selected: Boolean(this.root), rootId: this.root?.rootId || null, displayName: this.root ? path.basename(this.root.rootPath) : '', writeEnabled: Boolean(this.root?.writeEnabled), nativeAvailable: this.nativeAvailable, reason: this.root?.error || null },
      index: { documents: index.documents, vectors: index.vectors, ftsAvailable: index.ftsAvailable, ...this.indexState },
      embedding: await this.modelAccess?.embeddingAccess?.catalog() || null, revision: manifest.revision,
      legacy: legacy.items.slice(0, 20), cleanup: manifest.cleanup.filter(op => op.root_id === this.root?.rootId).map(op => ({ memoryId: op.memory_id, state: op.state })),
      recovery: manifest.operations.map(op => ({ operationId: op.operation_id, memoryId: op.memory_id })) }
  }
  async list (after = null, memoryIds = null) {
    await this.ensureScan(); const manifest = await this.gateway.personalMemoryFiles({ type: 'manifest' })
    const fileMap = new Map(manifest.files.map(file => [file.memory_id, file])); const tombstones = new Set(manifest.tombstones.map(item => item.memory_id))
    const all = [...this.documents].sort(([a], [b]) => a.localeCompare(b)).filter(([key, file]) => (after === null || key > after) && (!memoryIds || memoryIds.has(file.id)))
    const items = []
    for (const [fileId, file] of all.slice(0, 50)) {
      const candidate = fileMap.get(file.id); const meta = candidate?.root_id === this.root?.rootId ? candidate : null
      let lifecycle = null
      if (meta) { const row = await this.gateway.enqueue('personalContextManage', { type: 'view_item', item_id: file.id }, { memoryPrepared: true }); lifecycle = row.rows[0].lifecycle }
      items.push({ fileId, memoryId: file.id, name: file.relative, byteHash: file.byteHash || null, contentHash: file.contentHash || null,
        state: file.error ? file.error === 'MEMORY_FILE_METADATA_REQUIRED' ? 'metadata_required' : file.error === 'MEMORY_FILE_DUPLICATE_ID' ? 'conflict' : 'invalid' : tombstones.has(file.id) ? 'suppressed' : lifecycle === 'forgotten' || manifest.forgotten.includes(file.id) ? 'forgotten' : meta?.state || 'new',
        entry: file.entry || (file.body && Buffer.byteLength(file.body) <= 2048 ? { display_text: file.body, kind: 'project_fact', scope: { kind: 'global', reference: null } } : null) })
    }
    return { items, hasMore: all.length > 50, nextCursor: all.length > 50 ? items.at(-1).fileId : null }
  }
  async setWrite (enabled) { if (!this.root) fail('MEMORY_FILE_ROOT_UNAVAILABLE'); this.root.writeEnabled = enabled; await this.saveRoot(); this.changed() }
  async search (query) {
    await this.ensureScan(); await this.refreshIndex()
    const ids = new Set(await this.gateway.personalMemoryIndex({ type: 'manage_search', scope: { kind: 'global', reference: null }, query }))
    const files = await this.list(null, ids); return { ...files, reason: this.active() ? 'keyword' : 'memory_disabled_keyword' }
  }
  async openFile (fileId, openPath) {
    await this.ensureScan(); const file = this.documents.get(fileId); if (!file) fail('MEMORY_FILE_NOT_FOUND')
    const target = path.resolve(this.root.rootPath, file.relative)
    const real = await fsp.realpath(target)
    if (real !== target || !real.toLowerCase().startsWith(`${this.root.rootPath.toLowerCase()}${path.sep}`)) fail('MEMORY_FILE_INVALID')
    const message = await openPath(real); if (message) fail('MEMORY_FILE_OPEN_FAILED')
  }
  changed () { try { this.onChanged() } catch {} }
  async close () {
    this.closed = true; this.cancelIndex(); this.watcher?.close(); clearTimeout(this.timer)
    await this.sharing.stop()
    if (this.gateway.personalMemoryRuntime === this) this.gateway.personalMemoryRuntime = null
    await Promise.allSettled([this.indexTask, this.tail, this.scanPromise].filter(Boolean))
    await this.client.close()
  }
}
module.exports = { PersonalMemoryFileRuntime }
