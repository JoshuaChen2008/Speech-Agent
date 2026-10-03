'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { fixture, configureEmbedding } = require('./helpers/personal-memory-file-fixture')
const { SqliteSessionRecorder } = require('../../src/main/services/sqlite-session-recorder')
const { parseFile, renderFile } = require('../../src/agent/personal-context/memory-file-format')
const { sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')

test('SEM-F42/SEM-T04/J22/J24-RETRIEVAL: keyword and vector candidates share session and date boundaries before ranking', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t, { fetchImpl: async (_url, options) => new Response(JSON.stringify({ model: 'synthetic-vector',
    data: JSON.parse(options.body).input.map((_text, index) => ({ index, embedding: [1, 0] })) })) })
  const global = (await f.remember('范围标记：全局')).item.memory_id
  const sessionIds = ['session.before', 'session.inside']; const scoped = []
  for (let i = 0; i < sessionIds.length; i++) {
    let clock = (i + 1) * 1000
    const sessionId = sessionIds[i]
    const recorder = new SqliteSessionRecorder({ gateway: f.gateway, now: () => clock })
    await recorder.openSession({ sessionId, sourceId: 'mic', refinementEnabled: false })
    await recorder.acceptCaption({ schemaVersion: 1, sessionId, sourceId: 'mic', segmentId: `segment.${i}`, sequence: 1, revision: 1, kind: 'final', t0: 0, t1: 1, text: '用于确定范围的合成讨论', translation: null })
    clock = 5000
    await recorder.closeSession({ sessionId, sourceId: 'mic', state: 'closed' })
    await f.gateway.personalContextIngest(await f.gateway.derivePersonalContextSessionSource({ sessionId, transcriptVersion: 'raw' }))
    const entry = { display_text: `范围标记：会话 ${i}`, kind: 'project_fact', scope: { kind: 'session', reference: sessionId } }
    scoped.push((await f.gateway.personalContextManage({ type: 'remember', expected_revision: await f.revision(), entry })).item.memory_id)
  }
  await configureEmbedding(f)
  if (f.runtime.indexTask) await f.runtime.indexTask
  await f.runtime.buildIndex(true, new AbortController().signal)
  for (const [scope, expected] of [[{ kind: 'global', reference: null }, [global]], [{ kind: 'session', reference: sessionIds[0] }, [global, scoped[0]]],
    [{ kind: 'date_range', reference: 'date.2000.3000' }, [global, scoped[1]]]]) {
    const bundle = await f.gateway.personalContextResolve({ schemaVersion: 2, scope, query: '范围标记', semantic_keys: [], aliases: [] })
    assert.equal(bundle.retrieval.mode, 'hybrid')
    assert.deepEqual(bundle.personalMemories.map(row => row.memoryId).sort(), expected.sort())
  }
  const file = path.join(f.runtime.root.rootPath, `${scoped[1]}.md`)
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('会话 1', '待确认'))
  const afterEdit = await f.gateway.personalContextResolve({ schemaVersion: 2, scope: { kind: 'date_range', reference: 'date.2000.3000' }, query: '范围标记', semantic_keys: [], aliases: [] })
  assert.deepEqual(afterEdit.personalMemories.map(row => row.memoryId), [global])
})

test('SEM-F41/J21/J28-FILES: MD authority, external revision confirmation, forget and backup suppression cross real modules', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t)
  const added = await f.remember('项目使用 SQLite 保存来源与撤销')
  const id = added.item.memory_id
  const file = path.join(f.runtime.root.rootPath, `${id}.md`)
  assert.match(fs.readFileSync(file, 'utf8'), /SQLite/)
  const raw = f.service.store.database.prepare('SELECT content_json FROM personal_context_items WHERE memory_id=?').get(id).content_json
  assert.equal(JSON.parse(raw).storage, 'markdown'); assert.equal(raw.includes('保存来源'), false)
  assert.equal((await f.resolve('SQLite')).personalMemories[0].memoryId, id)
  const original = parseFile(fs.readFileSync(file))
  const changed = renderFile(id, { ...original.entry, display_text: '项目改用 Postgres 保存来源' }, original)
  fs.writeFileSync(file, changed)
  assert.equal((await f.resolve('Postgres')).personalMemories.length, 0)
  assert.equal((await f.resolve('SQLite')).personalMemories.length, 0)
  const pending = (await f.runtime.list()).items.find(row => row.memoryId === id)
  assert.equal(pending.state, 'pending')
  await f.runtime.confirm({ fileId: pending.fileId, expectedHash: pending.byteHash, restore: false, entry: null })
  assert.equal((await f.resolve('Postgres')).personalMemories[0].displayText, '项目改用 Postgres 保存来源')
  let item = (await f.gateway.personalContextManage({ type: 'view_item', item_id: id })).rows[0]
  await f.gateway.personalContextManage({ type: 'forget', expected_revision: await f.revision(), item_id: id, item_revision: item.item_revision })
  assert.ok(fs.existsSync(file)); assert.equal((await f.resolve('Postgres')).personalMemories.length, 0)
  const forgotten = (await f.runtime.list()).items.find(row => row.memoryId === id)
  await f.runtime.confirm({ fileId: forgotten.fileId, expectedHash: forgotten.byteHash, restore: true, entry: null })
  item = (await f.gateway.personalContextManage({ type: 'view_item', item_id: id })).rows[0]
  await f.gateway.personalContextManage({ type: 'delete', expected_revision: await f.revision(), item_id: id, item_revision: item.item_revision, deletion_idempotency_key: 'delete.backup' })
  fs.writeFileSync(file, changed)
  assert.equal((await f.resolve('Postgres')).personalMemories.length, 0)
  const backup = (await f.runtime.list()).items.find(row => row.memoryId === id)
  assert.equal(backup.state, 'suppressed')
  await assert.rejects(f.runtime.confirm({ fileId: backup.fileId, expectedHash: backup.byteHash, restore: false, entry: null }))
  await f.runtime.confirm({ fileId: backup.fileId, expectedHash: backup.byteHash, restore: true, entry: null })
  assert.equal((await f.resolve('Postgres')).personalMemories.length, 1)
})

test('SEM-F41/SEM-T04/J28-FILES: harmless metadata edit, duplicate ID, stale confirmation, custom root relocation and root loss', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); const item = (await f.remember('中文短词：猫，JS，项目甲')).item
  const file = path.join(f.runtime.root.rootPath, `${item.memory_id}.md`)
  const raw = fs.readFileSync(file, 'utf8'); const revision = await f.revision()
  fs.writeFileSync(file, raw.replace('---\n', '---\n# external comment\n'))
  assert.equal((await f.resolve('猫')).personalMemories.length, 1); assert.equal(await f.revision(), revision)
  assert.equal((await f.resolve('JS')).personalMemories.length, 1)
  fs.copyFileSync(file, path.join(f.runtime.root.rootPath, 'copy.md'))
  assert.equal((await f.resolve('猫')).personalMemories.length, 0)
  assert.ok((await f.runtime.list()).items.every(row => row.state === 'conflict'))
  fs.rmSync(path.join(f.runtime.root.rootPath, 'copy.md'))
  const pending = (await f.runtime.list()).items[0]
  fs.writeFileSync(file, raw.replace('猫', '狗'))
  await assert.rejects(f.runtime.confirm({ fileId: pending.fileId, expectedHash: pending.byteHash, restore: false, entry: null }), { code: 'MEMORY_FILE_CONFLICT' })
  const updated = (await f.runtime.list()).items[0]
  await f.runtime.confirm({ fileId: updated.fileId, expectedHash: updated.byteHash, restore: false, entry: null })
  const custom = path.join(f.directory, 'custom'); fs.mkdirSync(custom); fs.copyFileSync(file, path.join(custom, 'renamed.md'))
  await f.runtime.bind(custom, false)
  assert.equal((await f.resolve('狗')).personalMemories[0].memoryId, item.memory_id)
  await assert.rejects(f.remember('禁止应用写入'), { code: 'MEMORY_FILE_WRITE_DISABLED' })
  const moved = `${custom}-offline`; fs.renameSync(custom, moved)
  assert.equal((await f.resolve('狗')).personalMemories.length, 0)
  assert.equal((await f.gateway.personalMemoryFiles({ type: 'manifest' })).tombstones.length, 0)
  fs.renameSync(moved, custom)
  assert.equal((await f.resolve('狗')).personalMemories.length, 1)
})

async function stagedUpdate (f, id, text, operationId) {
  const item = (await f.gateway.personalContextManage({ type: 'view_item', item_id: id })).rows[0]
  const meta = (await f.gateway.personalMemoryFiles({ type: 'manifest' })).files.find(row => row.memory_id === id)
  const entry = { display_text: text, kind: item.kind, scope: { kind: 'global', reference: null } }
  const staged = await f.runtime.client.call({ type: 'prepare', operationId, memoryId: id, entry, relative: meta.relative_name, expectedHash: meta.byte_hash, create: false })
  await f.gateway.personalMemoryFiles({ type: 'prepare', operationId, operation: 'update', rootId: f.runtime.root.rootId, memoryId: id, relative: meta.relative_name,
    oldHash: staged.oldHash, targetHash: staged.byteHash, contentHash: staged.contentHash, entry, expectedRevision: await f.revision(), itemRevision: item.item_revision, restore: false })
  return { staged, meta }
}

test('SEM-F41/SEM-T04/DB7/J28-FILES: crash recovery recognizes target, old and partial bytes without database body fallback', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); const id = (await f.remember('恢复前的明确内容')).item.memory_id
  const op = 'fileop.11111111111111111111111111111111'
  await stagedUpdate(f, id, '恢复后的明确内容', op)
  await f.runtime.client.call({ type: 'write', operationId: op }); await f.runtime.client.close()
  await f.runtime.recover(); await f.runtime.ensureScan(); await f.runtime.refreshIndex()
  assert.equal((await f.resolve('恢复后')).personalMemories[0].displayText, '恢复后的明确内容')
  const oldOp = 'fileop.22222222222222222222222222222222'
  await stagedUpdate(f, id, '尚未写入的内容', oldOp); await f.runtime.client.close(); await f.runtime.recover()
  assert.equal((await f.resolve('恢复后')).personalMemories.length, 1)
  const partialOp = 'fileop.33333333333333333333333333333333'
  const { meta } = await stagedUpdate(f, id, '等待核对的目标内容', partialOp); await f.runtime.client.close()
  fs.writeFileSync(path.join(f.runtime.root.rootPath, meta.relative_name), '---\nid: memory.')
  await f.runtime.recover(); assert.equal((await f.resolve('恢复后')).personalMemories.length, 0)
  const review = await f.runtime.recoveryReview(partialOp)
  assert.equal(review.versions.current, null); assert.equal(review.versions.old.display_text, '恢复后的明确内容')
  await f.runtime.recoveryRestore({ rootId: f.runtime.root.rootId, operationId: partialOp, expectedHash: review.expectedHash, version: 'old' })
  assert.equal((await f.resolve('恢复后')).personalMemories.length, 1)
  assert.equal((await f.gateway.personalMemoryFiles({ type: 'manifest' })).operations.length, 0)
  const missingOp = 'fileop.44444444444444444444444444444444'
  await stagedUpdate(f, id, '缺失文件恢复的目标内容', missingOp); await f.runtime.client.close()
  fs.rmSync(path.join(f.runtime.root.rootPath, meta.relative_name))
  await f.runtime.recover()
  const missing = await f.runtime.recoveryReview(missingOp)
  assert.equal(missing.expectedHash, null)
  await f.runtime.recoveryRestore({ rootId: f.runtime.root.rootId, operationId: missingOp, expectedHash: null, version: 'new' })
  assert.equal((await f.resolve('缺失文件恢复')).personalMemories.length, 1)
})

test('SEM-F41/DB1/J21/J28-FILES: selected legacy migration preserves revisions and forgotten state; portable metadata cannot confirm files', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t)
  f.gateway.personalMemoryRuntime = null
  const a = await f.gateway.personalContextManage({ type: 'remember', expected_revision: await f.revision(), entry: { display_text: '原有条目的正文', kind: 'project_fact', scope: { kind: 'global', reference: null } } })
  const b = await f.gateway.personalContextManage({ type: 'remember', expected_revision: await f.revision(), entry: { display_text: '原有已忘记内容', kind: 'project_fact', scope: { kind: 'global', reference: null } } })
  await f.gateway.personalContextManage({ type: 'forget', expected_revision: await f.revision(), item_id: b.item.memory_id, item_revision: b.item.item_revision })
  const recorder = new SqliteSessionRecorder({ gateway: f.gateway, now: () => 1000 })
  await recorder.openSession({ sessionId: 'session.migration', sourceId: 'mic', refinementEnabled: false })
  await recorder.acceptCaption({ schemaVersion: 1, sessionId: 'session.migration', sourceId: 'mic', segmentId: 'segment.migration', sequence: 1, revision: 1, kind: 'final', t0: 0, t1: 1, text: '原有条目的正文', translation: null })
  await recorder.closeSession({ sessionId: 'session.migration', sourceId: 'mic', state: 'closed' })
  await f.gateway.personalContextIngest(await f.gateway.derivePersonalContextSessionSource({ sessionId: 'session.migration', transcriptVersion: 'raw' }))
  const db = f.service.store.database
  const episode = db.prepare("SELECT episode_id FROM personal_context_episodes WHERE session_id='session.migration'").get()
  const originalRevision = db.prepare('SELECT current_revision_id FROM personal_context_items WHERE memory_id=?').get(a.item.memory_id).current_revision_id
  // Historical v28 association fixture, before the file authority switch.
  db.prepare('INSERT INTO personal_context_session_associations VALUES(?,?,?,?,?,?,?,?)').run('association.migration', episode.episode_id, a.item.memory_id,
    originalRevision, '[]', '已有明确记忆的会话关联', JSON.stringify({ sessionId: 'session.migration', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 1 }), 1000)
  f.gateway.personalMemoryRuntime = f.runtime
  const interrupted = 'fileop.55555555555555555555555555555555'
  const entry = { display_text: '原有条目的正文', kind: 'project_fact', scope: { kind: 'global', reference: null } }
  const staged = await f.runtime.client.call({ type: 'prepare', operationId: interrupted, memoryId: a.item.memory_id, entry, relative: `${a.item.memory_id}.md`, expectedHash: null, create: true })
  await f.gateway.personalMemoryFiles({ type: 'prepare', operationId: interrupted, operation: 'migrate', rootId: f.runtime.root.rootId, memoryId: a.item.memory_id,
    relative: `${a.item.memory_id}.md`, oldHash: staged.oldHash, targetHash: staged.byteHash, contentHash: staged.contentHash, entry, expectedRevision: await f.revision(), itemRevision: a.item.item_revision, restore: false })
  await f.runtime.client.close(); await f.runtime.recover()
  await f.runtime.migrate([a.item.memory_id, b.item.memory_id])
  const row = (await f.gateway.personalContextManage({ type: 'view_item', item_id: a.item.memory_id })).rows[0]
  assert.equal(row.item_revision, a.item.item_revision)
  assert.equal(db.prepare("SELECT count(*) n FROM personal_context_session_associations WHERE association_id='association.migration'").get().n, 1)
  assert.equal((await f.runtime.list()).items.find(item => item.memoryId === b.item.memory_id).state, 'forgotten')
  const g = await f.gateway.personalMemoryFiles({ type: 'export_governance' })
  const source = { evidence_id: 'evidence.portable', ingest_run_id: 'run.portable', memory_id: a.item.memory_id, source_kind: 'session', session_id: 'session.missing', interaction_id: null, transcript_version: 'raw', input_watermark: 1, from_event_order: 1, through_event_order: 1, input_digest: sha256Canonical('missing source'), recipe_id: 'context.ingest.session', recipe_version: '2', created_at: 1000, memory_hash: g.files.find(file => file.memory_id === a.item.memory_id).content_hash }
  g.sources.push(source)
  await f.gateway.personalMemoryFiles({ type: 'import_revocations', governance: g })
  const projected = (await f.gateway.personalContextManage({ type: 'view_item', item_id: a.item.memory_id })).rows[0]
  assert.ok(projected.sources.some(source => source.availability === 'missing' && source.target === null))
  const exported = await f.gateway.personalMemoryFiles({ type: 'export_governance' })
  assert.ok(exported.sources.some(source => source.evidence_id === 'evidence.portable'))
  assert.equal(JSON.stringify(exported).includes('原有条目的正文'), false)
  const other = await fixture(t); fs.copyFileSync(path.join(f.runtime.root.rootPath, `${a.item.memory_id}.md`), path.join(other.runtime.root.rootPath, 'imported.md'))
  await other.gateway.personalMemoryFiles({ type: 'import_revocations', governance: exported })
  assert.equal((await other.resolve('正文')).personalMemories.length, 0)
  const incoming = (await other.runtime.list()).items[0]
  await other.runtime.confirm({ fileId: incoming.fileId, expectedHash: incoming.byteHash, entry: null, restore: false })
  assert.equal((await other.resolve('正文')).personalMemories.length, 1)
})

test('SEM-F42/SEM-T04/J22/J24-RETRIEVAL: independent consent, validated batch order, query fallback, cancellation and late file revision', { skip: process.platform !== 'win32' }, async t => {
  let requests = 0; let hold = null
  const f = await fixture(t, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://embedding.example/v1/embeddings'); assert.equal(options.redirect, 'manual')
    requests++; if (hold) await hold.promise
    const input = JSON.parse(options.body).input
    return new Response(JSON.stringify({ model: 'synthetic-vector', data: input.map((text, index) => ({ index, embedding: text.includes('延迟') || text.includes('响应') ? [1, 0] : [0, 1] })).reverse() }))
  } })
  await f.remember('产品要求低延迟')
  const configure = async command => f.embeddingAccess.configure({ ...command, expectedRevision: (await f.embeddingAccess.catalog()).revision })
  await assert.rejects(configure({ type: 'configureEmbedding', httpsOrigin: 'https://embedding.example', basePath: '/v1', modelId: 'synthetic-vector', enabled: true, disclosureAccepted: false }))
  assert.equal(requests, 0)
  await configure({ type: 'configureEmbedding', httpsOrigin: 'https://embedding.example', basePath: '/v1', modelId: 'synthetic-vector', enabled: false, disclosureAccepted: false })
  await configure({ type: 'setEmbeddingCredential', credential: 'synthetic-independent-key' })
  assert.equal((await f.resolve('快速响应')).retrieval.reason, 'embedding_disabled'); assert.equal(requests, 0)
  await configure({ type: 'configureEmbedding', httpsOrigin: 'https://embedding.example', basePath: '/v1', modelId: 'synthetic-vector', enabled: true, disclosureAccepted: true })
  await f.runtime.buildIndex(true, new AbortController().signal)
  const answer = await f.resolve('快速响应'); assert.equal(answer.retrieval.mode, 'hybrid'); assert.equal(answer.personalMemories[0].displayText, '产品要求低延迟')
  const before = requests; await f.resolve('快速响应'); assert.equal(requests, before)
  const governanceBeforeRebuild = await f.gateway.personalMemoryFiles({ type: 'export_governance' })
  await f.gateway.personalMemoryIndex({ type: 'rebuild_lexical' }); await f.runtime.refreshIndex(); await f.runtime.buildIndex(true, new AbortController().signal)
  assert.deepEqual(await f.gateway.personalMemoryFiles({ type: 'export_governance' }), governanceBeforeRebuild)
  assert.equal((await f.resolve('低延迟')).personalMemories.length, 1)
  const afterRebuild = requests
  let release; const promise = new Promise(resolve => { release = resolve }); hold = { promise }
  const job = f.runtime.buildIndex(true, new AbortController().signal)
  while (requests === afterRebuild) await new Promise(resolve => setImmediate(resolve))
  const file = (await f.runtime.list()).items[0]; const target = path.join(f.runtime.root.rootPath, file.name)
  fs.writeFileSync(target, fs.readFileSync(target, 'utf8').replace('低延迟', '高吞吐'))
  release(); await assert.rejects(job, { code: 'AGENT_INPUT_CHANGED' }); hold = null
  assert.equal((await f.resolve('快速响应')).personalMemories.length, 0)
  f.config.memoryEnabled = false
  const asleep = await f.resolve('高吞吐'); assert.equal(asleep.retrieval.mode, 'disabled'); assert.equal(asleep.personalMemories.length, 0)
})
