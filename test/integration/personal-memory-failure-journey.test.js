'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { fixture, configureEmbedding } = require('./helpers/personal-memory-file-fixture')
const { PersonalMemoryFileRuntime } = require('../../src/agent/personal-context/memory-file-runtime')
const { renderFile } = require('../../src/agent/personal-context/memory-file-format')
const { sha256Canonical } = require('../../src/runtime/storage-worker/canonical-json')

test('SEM-F41/SEM-T04/J28-FILES/DB7: disabled startup reads no file bodies; revoked cleanup survives lock failure and refuses changed bytes', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t)
  const first = (await f.remember('文件清理竞争的合成内容')).item
  const op = 'fileop.55555555555555555555555555555555'
  await f.runtime.client.call({ type: 'hold_read', operationId: op, relative: `${first.memory_id}.md` })
  await f.gateway.personalContextManage({ type: 'delete', expected_revision: await f.revision(), item_id: first.memory_id, item_revision: first.item_revision, deletion_idempotency_key: 'delete.locked' })
  assert.equal((await f.runtime.status()).cleanup[0].state, 'pending')
  assert.equal((await f.resolve('清理')).personalMemories.length, 0)
  await f.runtime.client.call({ type: 'release', operationId: op })
  const target = path.join(f.runtime.root.rootPath, `${first.memory_id}.md`)
  fs.writeFileSync(target, renderFile(first.memory_id, { display_text: '外部编辑器保留的新正文', kind: 'project_fact', scope: { kind: 'global', reference: null } }))
  await f.runtime.cleanup()
  assert.equal((await f.runtime.status()).cleanup[0].state, 'conflict'); assert.equal(fs.existsSync(target), true)
  assert.equal((await f.resolve('新正文')).personalMemories.length, 0)
  await f.runtime.close()
  f.config.memoryEnabled = false
  const sleeping = new PersonalMemoryFileRuntime({ gateway: f.gateway, directory: path.join(f.directory, 'private'), getConfig: () => f.config, modelAccess: f.modelAccess })
  t.after(() => sleeping.close())
  const calls = []; const call = sleeping.client.call.bind(sleeping.client)
  sleeping.client.call = input => { calls.push(input.type); return call(input) }
  await sleeping.initialize(); await f.resolve('新正文')
  assert.equal(calls.includes('scan'), false); assert.equal(calls.includes('hold_read'), false)
  assert.equal(calls.includes('vector_rank'), false)
  // A manual management action may still inspect files while reading is asleep.
  assert.equal((await sleeping.list()).items[0].state, 'suppressed')
})

test('SEM-F42/SEM-T04/J12/J24-RETRIEVAL: a non-cooperative provider cannot hold caption FIFO, cancellation or query deadline', { skip: process.platform !== 'win32', timeout: 12000 }, async t => {
  let hanging = false; let requests = 0
  const f = await fixture(t, { fetchImpl: async (_url, options) => {
    requests++
    if (hanging) return new Promise(() => {})
    return new Response(JSON.stringify({ model: 'synthetic-vector', data: JSON.parse(options.body).input.map((_v, index) => ({ index, embedding: [1, 0] })) }))
  } })
  await f.remember('字幕独立性关键词'); await configureEmbedding(f)
  await f.runtime.buildIndex(true, new AbortController().signal)
  const baseline = requests; hanging = true; f.runtime.scheduleIndex(true)
  const deadline = Date.now() + 3000
  while (requests === baseline && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.ok(requests > baseline)
  const started = performance.now()
  const sessionId = 'session.memory.independence'
  await f.gateway.openSession({ sessionId, sourceId: 'mic', startedAt: 1000, refinementEnabled: false })
  await f.gateway.appendCaption({ schemaVersion: 1, sessionId, sourceId: 'mic', segmentId: 'segment.independent', sequence: 1, revision: 1, kind: 'final', t0: 0, t1: 10, text: '字幕存储的合成文本', translation: null })
  await f.gateway.closeSession({ sessionId, sourceId: 'mic', endedAt: 2000, state: 'closed' })
  assert.equal((await f.gateway.getSessionTranscript(sessionId)).segments[0].text, '字幕存储的合成文本')
  assert.ok(performance.now() - started < 1500)
  f.runtime.cancelIndex(); await f.runtime.indexTask
  assert.equal(f.runtime.indexState.state, 'cancelled')
  const queryStart = performance.now(); const result = await f.resolve('字幕独立性')
  assert.equal(result.retrieval.mode, 'lexical'); assert.equal(result.retrieval.reason, 'embedding_unavailable')
  assert.ok(performance.now() - queryStart < 4500); assert.equal(result.personalMemories.length, 1)
  const binding = await f.embeddingAccess.bind({ kind: 'embedding', jobId: 'query.abort', inputDigest: sha256Canonical('synthetic') })
  const controller = new AbortController(); const request = f.embeddingAccess.run(binding, ['synthetic'], { signal: controller.signal })
  controller.abort(); await assert.rejects(request, { code: 'AGENT_CANCELLED' })
})

test('SEM-F42/SEM-T04/J24-RETRIEVAL: malformed batch, redirect, throttling and auth failure keep governance intact', { skip: process.platform !== 'win32' }, async t => {
  let mode = 'missing'
  const f = await fixture(t, { fetchImpl: async () => {
    if (mode === 'redirect') return new Response(null, { status: 302, headers: { location: 'https://other.example' } })
    if (mode === 'rate') return new Response(null, { status: 429 })
    if (mode === 'auth') return new Response(null, { status: 401 })
    return new Response(JSON.stringify({ model: 'synthetic-vector', data: mode === 'zero' ? [{ index: 0, embedding: [0, 0] }] : mode === 'duplicate' ? [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [1, 0] }] : [] }))
  } })
  const id = (await f.remember('错误恢复检索关键词')).item.memory_id; await configureEmbedding(f)
  const before = await f.gateway.personalMemoryFiles({ type: 'export_governance' })
  for (const [next, code, count] of [['missing', 'EMBEDDING_RESPONSE_INVALID', 1], ['zero', 'EMBEDDING_RESPONSE_INVALID', 1], ['duplicate', 'EMBEDDING_RESPONSE_INVALID', 2], ['redirect', 'EMBEDDING_REDIRECT_REJECTED', 1], ['rate', 'EMBEDDING_RATE_LIMITED', 1], ['auth', 'EMBEDDING_AUTH_FAILED', 1]]) {
    mode = next
    const binding = await f.embeddingAccess.bind({ kind: 'embedding', jobId: `query.${next}`, inputDigest: sha256Canonical(next) })
    await assert.rejects(f.embeddingAccess.run(binding, Array(count).fill('synthetic')), { code })
  }
  assert.equal((await f.embeddingAccess.catalog()).credentialPresent, false)
  assert.deepEqual(await f.gateway.personalMemoryFiles({ type: 'export_governance' }), before)
  assert.equal((await f.resolve('关键词')).personalMemories[0].memoryId, id)
})
