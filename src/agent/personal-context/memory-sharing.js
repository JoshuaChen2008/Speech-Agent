'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { assertSharingSelection, assertSharingScope } = require('../contracts/personal-memory-sharing')
const fail = code => { throw Object.assign(new Error(code), { code }) }
function serialize (snapshot, format) {
  if (format === 'json') return `${JSON.stringify(snapshot, null, 2)}\n`
  if (format !== 'markdown') fail('MEMORY_FILE_SHARING_INVALID')
  return '# 个人记忆\n\n仅包含用户选定的已确认个人记忆。外部副本不会随应用内撤销自动删除。\n\n' + snapshot.items.map(item =>
    `## ${item.kind} · ${item.scope.label}\n\n${item.text}\n\n- 记忆：${item.memoryId}\n- 修订：${item.revision}\n- 范围：${item.scope.kind}${item.scope.reference ? ` / ${item.scope.reference}` : ''}\n- 来源身份：${JSON.stringify(item.sources)}\n`).join('\n')
}
class MemorySharing {
  constructor (runtime) { this.runtime = runtime; this.mcp = null; this.generation = 0 }
  assertActive () { if (this.runtime.closed || !this.runtime.active()) fail('MEMORY_FILE_SHARING_DISABLED') }
  async list (scope, after) {
    assertSharingScope(scope); this.assertActive()
    return this.runtime.serial(async () => { await this.runtime.ensureScan(); this.assertActive(); return this.runtime.gateway.personalMemoryFiles({ type: 'content_page', scope, after }) })
  }
  async snapshot (memoryIds, digest = null) {
    assertSharingSelection(memoryIds); this.assertActive()
    const result = await this.runtime.serial(async () => {
      await this.runtime.ensureScan(); this.assertActive()
      return this.runtime.gateway.personalMemoryFiles({ type: 'content_snapshot', memoryIds })
    })
    this.assertActive()
    if (digest !== null && result.digest !== digest) fail('MEMORY_FILE_SHARING_CHANGED')
    return result
  }
  async copy (command, clipboard) {
    const snapshot = await this.snapshot(command.memoryIds, command.digest)
    const text = serialize(snapshot, command.format)
    if (Buffer.byteLength(text) > 65536) fail('MEMORY_FILE_EXPORT_LIMIT')
    clipboard.writeText(text); return { copied: true }
  }
  async export (command, dialog, window) {
    const extension = command.format === 'json' ? 'json' : 'md'
    const picked = await dialog.showSaveDialog(window, { title: '导出选中的个人记忆', defaultPath: `personal-memory.${extension}`, filters: [{ name: command.format === 'json' ? 'JSON' : 'Markdown', extensions: [extension] }] })
    if (picked.canceled || !picked.filePath) return { cancelled: true }
    const parent = (await fs.realpath(path.dirname(picked.filePath))).toLowerCase().split(/[\\/]/)
    if (parent.includes('.artifacts') || parent.some((part, index) => part === 'docs' && parent[index + 1] === 'validation')) fail('MEMORY_FILE_EXPORT_LOCATION_REJECTED')
    const snapshot = await this.snapshot(command.memoryIds, command.digest)
    const text = serialize(snapshot, command.format)
    if (Buffer.byteLength(text) > 65536) fail('MEMORY_FILE_EXPORT_LIMIT')
    const temp = `${picked.filePath}.${crypto.randomUUID()}.memory-export.tmp`
    let owned = false
    try {
      const file = await fs.open(temp, 'wx'); owned = true
      try { await file.writeFile(text, 'utf8'); await file.sync() } finally { await file.close() }
      await this.snapshot(command.memoryIds, command.digest)
      await fs.rename(temp, picked.filePath)
      return { exported: true, count: snapshot.items.length }
    } finally { if (owned) await fs.rm(temp, { force: true }) }
  }
  async start (command) {
    const generation = ++this.generation
    await this.snapshot(command.memoryIds, command.digest)
    if (generation !== this.generation) fail('MEMORY_FILE_SHARING_DISABLED')
    const previous = this.mcp; this.mcp = null
    if (previous) await previous.stop()
    if (generation !== this.generation) fail('MEMORY_FILE_SHARING_DISABLED')
    const { MemoryMcpServer } = require('./memory-mcp-server')
    const server = new MemoryMcpServer(this, [...command.memoryIds], command.digest)
    this.mcp = server
    try { await server.start(); if (generation !== this.generation) fail('MEMORY_FILE_SHARING_DISABLED'); return this.status() } catch (error) { if (this.mcp === server) this.mcp = null; await server.stop(); throw error }
  }
  status () { return this.mcp?.status() || { running: false, url: null, count: 0 } }
  async stop () { ++this.generation; const server = this.mcp; this.mcp = null; if (server) await server.stop(); return this.status() }
  copyConfig (clipboard) {
    this.assertActive()
    if (!this.mcp?.status().running) fail('MEMORY_FILE_SHARING_DISABLED')
    clipboard.writeText(JSON.stringify({ mcpServers: { 'speech-agent-memory': { url: this.mcp.url, headers: { Authorization: `Bearer ${this.mcp.secret}` } } } }, null, 2))
    return { copied: true }
  }
}
module.exports = { MemorySharing, serialize }
