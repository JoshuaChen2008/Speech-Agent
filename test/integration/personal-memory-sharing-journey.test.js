'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { fixture } = require('./helpers/personal-memory-file-fixture')
const { registerPersonalMemoryFileIpc } = require('../../src/main/ipc/personal-memory-file-ipc')
const contract = require('../../src/agent/contracts/personal-memory-file-ui')
const { MemorySharing } = require('../../src/agent/personal-context/memory-sharing')

async function connection (f) {
  const first = (await f.remember('已确认的项目事实，支持中文关键词查询')).item.memory_id
  const other = (await f.remember('这条记忆没有授权给外部客户端')).item.memory_id
  const preview = await f.runtime.sharing.snapshot([first])
  const status = await f.runtime.sharing.start({ memoryIds: [first], digest: preview.digest })
  let config
  f.runtime.sharing.copyConfig({ writeText: value => { config = JSON.parse(value).mcpServers['speech-agent-memory'] } })
  const headers = { ...config.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }
  const request = async (method, params = {}, id = 1, extraHeaders = {}) => fetch(status.url, { method: 'POST', headers: { ...headers, ...extraHeaders }, body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }) })
  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } })
  assert.equal((await init.json()).result.protocolVersion, '2025-06-18')
  headers['mcp-session-id'] = init.headers.get('mcp-session-id')
  assert.ok(headers['mcp-session-id'])
  const initialized = await fetch(status.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
  assert.equal(initialized.status, 202)
  const call = async (name, args = {}) => (await request('tools/call', { name, arguments: args })).json()
  return { first, other, preview, status, headers, request, call }
}

test('SEM-F43/J28-EXPORT: real settings IPC, files and SQLite preserve selection, preview identity and atomic export', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t)
  const memoryId = (await f.remember('用户明确选择的内容，Markdown 与 JSON 一致')).item.memory_id
  const candidate = (await f.remember('合成候选不可导出')).item.memory_id
  f.service.store.database.prepare("UPDATE personal_context_items SET origin='inferred' WHERE memory_id=?").run(candidate)
  let handler; let clipboard = ''; let cancelled = false; let beforeSave = async () => {}
  let target = path.join(f.directory, 'selected.json')
  const dispose = registerPersonalMemoryFileIpc({ ipcMain: { handle: (_name, fn) => { handler = fn }, removeHandler: () => {} }, authorize: () => {},
    getRuntime: () => f.runtime, getWindow: () => null, shell: {}, clipboard: { writeText: value => { clipboard = value } },
    dialog: { showSaveDialog: async () => { await beforeSave(); return { canceled: cancelled, filePath: target } } } })
  t.after(dispose)
  const call = command => handler({ sender: {} }, { contractId: contract.CONTRACT_ID, contractVersion: contract.CONTRACT_VERSION, command })
  const page = await call({ type: 'contentList', scope: { kind: 'global', reference: null }, after: null })
  assert.equal(page.ok, true); assert.deepEqual(page.result.items.map(i => i.memoryId), [memoryId])
  assert.deepEqual((await call({ type: 'contentList', scope: { kind: 'project', reference: 'project.unselected' }, after: null })).result.items, [])
  assert.equal((await call({ type: 'contentPreview', memoryIds: Array.from({ length: 21 }, (_, i) => `memory.limit${i}`) })).ok, false)
  assert.equal((await call({ type: 'contentPreview', memoryIds: [candidate] })).ok, false)
  const preview = (await call({ type: 'contentPreview', memoryIds: [memoryId] })).result
  const command = { memoryIds: [memoryId], digest: preview.digest, format: 'json' }
  assert.equal((await call({ type: 'contentCopy', ...command })).result.copied, true)
  assert.deepEqual(JSON.parse(clipboard), preview)
  assert.equal((await call({ type: 'contentExport', ...command })).result.exported, true)
  assert.equal(fs.readFileSync(target, 'utf8'), clipboard)
  assert.equal((await call({ type: 'contentCopy', ...command, format: 'markdown' })).ok, true)
  assert.ok(clipboard.includes(preview.items[0].text))
  assert.equal(JSON.stringify(preview).includes(f.directory), false)
  assert.ok(preview.items[0].sources.every(source => !('summary' in source)))
  cancelled = true; const original = fs.readFileSync(target, 'utf8')
  assert.equal((await call({ type: 'contentExport', ...command })).result.cancelled, true)
  assert.equal(fs.readFileSync(target, 'utf8'), original); cancelled = false
  target = path.join(f.directory, 'existing-directory'); fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, 'keep.txt'), 'keep')
  assert.equal((await call({ type: 'contentExport', ...command })).ok, false)
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'keep')
  assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.memory-export.tmp')), false)
  target = path.join(f.directory, '.artifacts', 'private.json'); fs.mkdirSync(path.dirname(target))
  assert.equal((await call({ type: 'contentExport', ...command })).error.code, 'MEMORY_FILE_EXPORT_LOCATION_REJECTED')
  target = path.join(f.directory, 'selected.json')
  beforeSave = async () => { const item = (await f.gateway.personalContextManage({ type: 'view_item', item_id: memoryId })).rows[0]; await f.gateway.personalContextManage({ type: 'forget', expected_revision: await f.revision(), item_id: memoryId, item_revision: item.item_revision }) }
  assert.equal((await call({ type: 'contentExport', ...command })).ok, false)
  assert.equal(fs.readFileSync(target, 'utf8'), original)
  assert.equal(fs.readdirSync(f.directory).some(name => name.endsWith('.memory-export.tmp')), false)
  assert.equal((await call({ type: 'contentCopy', ...command, path: target })).ok, false)
})

test('SEM-F44/J28-MCP/J12: real HTTP exposes only authorized immutable content and rejects untrusted requests', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); const c = await connection(f)
  assert.equal((await c.request('tools/list', {}, 1, { Authorization: 'Bearer wrong' })).status, 401)
  assert.equal((await c.request('tools/list', {}, 1, { Origin: 'https://untrusted.example' })).status, 403)
  const hostStatus = await new Promise((resolve, reject) => {
    const req = require('node:http').request(c.status.url, { method: 'POST', headers: { ...c.headers, Host: 'untrusted.example' } }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject); req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }))
  })
  assert.equal(hostStatus, 403)
  assert.equal((await c.request('tools/list', {}, 1, { 'mcp-protocol-version': 'unknown' })).status, 400)
  const listed = await (await c.request('tools/list')).json()
  assert.deepEqual(listed.result.tools.map(t => t.name), ['list_memories', 'read_memory', 'search_memories'])
  assert.ok(listed.result.tools.every(t => t.annotations.readOnlyHint))
  assert.equal((await c.call('forget_memory', { memoryId: c.first })).error.code, -32602)
  assert.equal((await c.call('read_memory', { memoryId: c.other })).error.code, -32602)
  assert.equal((await c.call('read_memory', { memoryId: c.first, path: 'private' })).error.code, -32602)
  const read = await c.call('read_memory', { memoryId: c.first })
  assert.equal(read.result.isError, false); assert.deepEqual(JSON.parse(read.result.content[0].text).items, c.preview.items)
  assert.equal(JSON.parse((await c.call('search_memories', { query: '中文' })).result.content[0].text).items.length, 1)
  assert.equal(JSON.parse((await c.call('search_memories', { query: '没有授权' })).result.content[0].text).items.length, 0)
  assert.equal((await fetch(c.status.url, { headers: c.headers })).status, 405)
  const oversized = await fetch(c.status.url, { method: 'POST', headers: c.headers, body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'ping', params: { value: 'x'.repeat(9000) } }) })
  assert.equal(oversized.status, 413)
  const location = path.join(f.runtime.root.rootPath, `${c.first}.md`)
  fs.writeFileSync(location, fs.readFileSync(location, 'utf8').replace('项目事实', '未确认修改'))
  const revoked = await c.call('read_memory', { memoryId: c.first })
  assert.equal(revoked.result.isError, true); assert.equal(JSON.stringify(revoked).includes('未确认修改'), false)
  await f.runtime.sharing.stop(); assert.equal(f.runtime.sharing.status().running, false)
  await assert.rejects(fetch(c.status.url, { headers: c.headers }))
  assert.equal(new MemorySharing(f.runtime).status().running, false)
  // Agent read failure leaves the real subtitle writer and history operational.
  await f.gateway.openSession({ sessionId: 'sharing.independence', sourceId: 'mic', startedAt: 1, refinementEnabled: false })
  await f.gateway.closeSession({ sessionId: 'sharing.independence', sourceId: 'mic', endedAt: 2, state: 'closed' })
})

test('SEM-F43/F44/J28-MCP: suspension rejects export, revokes token and reauthorization changes identity', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); const c = await connection(f)
  await f.runtime.sharing.start({ memoryIds: [c.first], digest: c.preview.digest })
  let fresh
  f.runtime.sharing.copyConfig({ writeText: value => { fresh = JSON.parse(value).mcpServers['speech-agent-memory'] } })
  assert.notEqual(fresh.headers.Authorization, c.headers.Authorization)
  f.config.memoryEnabled = false; f.runtime.policyChanged()
  await assert.rejects(f.runtime.sharing.snapshot([c.first]), { code: 'MEMORY_FILE_SHARING_DISABLED' })
  assert.equal(f.runtime.sharing.status().running, false)
})

test('SEM-F44/J28-MCP: stop during authorization cannot reopen sharing', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t)
  const memoryId = (await f.remember('并发撤销合成内容')).item.memory_id
  const preview = await f.runtime.sharing.snapshot([memoryId])
  const pending = f.runtime.sharing.start({ memoryIds: [memoryId], digest: preview.digest })
  await f.runtime.sharing.stop()
  await assert.rejects(pending, { code: 'MEMORY_FILE_SHARING_DISABLED' })
  assert.equal(f.runtime.sharing.status().running, false)
})
