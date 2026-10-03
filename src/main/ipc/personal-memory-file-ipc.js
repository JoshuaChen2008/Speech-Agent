'use strict'

const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const CHANNELS = require('./channels')
const contract = require('../../agent/contracts/personal-memory-file-ui')
function registerPersonalMemoryFileIpc ({ ipcMain, authorize, getRuntime, dialog, shell, clipboard, getWindow }) {
  ipcMain.handle(CHANNELS.PERSONAL_MEMORY_FILES, async (event, request) => {
    try { authorize(event, CHANNELS.PERSONAL_MEMORY_FILES) } catch { return contract.response(null, 'AGENT_CONTEXT_PERMISSION_DENIED') }
    try { contract.assertRequest(request) } catch { return contract.response(null, 'MEMORY_FILE_REQUEST_INVALID') }
    const runtime = getRuntime(); if (!runtime) return contract.response(null, 'MEMORY_FILE_UNAVAILABLE')
    const c = request.command
    try {
      if (c.rootId) runtime.assertRoot(c.rootId)
      let result
      switch (c.type) {
        case 'contentList': result = await runtime.sharing.list(c.scope, c.after); break
        case 'contentPreview': result = await runtime.sharing.snapshot(c.memoryIds); break
        case 'contentCopy': result = await runtime.sharing.copy(c, clipboard); break
        case 'contentExport': result = await runtime.sharing.export(c, dialog, getWindow(event.sender)); break
        case 'mcpStart': result = await runtime.sharing.start(c); break
        case 'mcpStop': result = await runtime.sharing.stop(); break
        case 'mcpStatus': result = runtime.sharing.status(); break
        case 'mcpCopyConfig': result = runtime.sharing.copyConfig(clipboard); break
        case 'status': result = await runtime.status(); break
        case 'list': result = await runtime.list(c.after); break
        case 'chooseRoot': {
          const picked = await dialog.showOpenDialog(getWindow(event.sender), { title: '选择个人记忆目录', properties: ['openDirectory', 'createDirectory'] })
          result = picked.canceled ? { cancelled: true } : await runtime.serial(() => runtime.bind(picked.filePaths[0])); break
        }
        case 'setWrite': await runtime.serial(() => { runtime.assertRoot(c.rootId); return runtime.setWrite(c.enabled) }); result = { updated: true }; break
        case 'confirm': result = await runtime.confirm(c); break
        case 'migrate': result = await runtime.migrate(c.memoryIds, c.rootId); break
        case 'openFile': await runtime.openFile(c.fileId, value => shell.openPath(value)); result = { opened: true }; break
        case 'rebuild': await runtime.ensureScan(); await runtime.gateway.personalMemoryIndex({ type: 'rebuild_lexical' }); await runtime.refreshIndex(); runtime.scheduleIndex(true); result = { requested: true }; break
        case 'cancelIndex': runtime.cancelIndex(); result = { cancelled: true }; break
        case 'retryCleanup': result = await runtime.serial(() => { runtime.assertRoot(c.rootId); return runtime.cleanup() }); break
        case 'search': result = await runtime.search(c.query); break
        case 'configureEmbedding': result = await runtime.modelAccess.embeddingAccess.configure(c.command); runtime.cancelIndex(); runtime.scheduleIndex(); break
        case 'recoveryReview': result = await runtime.recoveryReview(c.operationId); break
        case 'recoveryRestore': result = await runtime.recoveryRestore(c); break
        case 'exportGovernance': {
          const picked = await dialog.showSaveDialog(getWindow(event.sender), { title: '导出个人记忆来源与撤销记录', defaultPath: 'personal-memory-governance.v1.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
          if (picked.canceled || !picked.filePath) { result = { cancelled: true }; break }
          const parent = (await fs.realpath(path.dirname(picked.filePath))).toLowerCase().split(/[\\/]/)
          if (parent.includes('.artifacts') || parent.some((part, index) => part === 'docs' && parent[index + 1] === 'validation')) {
            throw Object.assign(new Error('MEMORY_FILE_EXPORT_LOCATION_REJECTED'), { code: 'MEMORY_FILE_EXPORT_LOCATION_REJECTED' })
          }
          const governance = await runtime.gateway.personalMemoryFiles({ type: 'export_governance' })
          const serialized = JSON.stringify(governance)
          if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw Object.assign(new Error('MEMORY_FILE_EXPORT_LIMIT'), { code: 'MEMORY_FILE_EXPORT_LIMIT' })
          const temp = `${picked.filePath}.${crypto.randomUUID()}.memory-export.tmp`
          let owned = false
          try { const handle = await fs.open(temp, 'wx'); owned = true; try { await handle.writeFile(serialized); await handle.sync() } finally { await handle.close() }; await fs.rename(temp, picked.filePath) } finally { if (owned) await fs.rm(temp, { force: true }) }
          result = { exported: true }; break
        }
        case 'importGovernance': {
          const picked = await dialog.showOpenDialog(getWindow(event.sender), { title: '导入个人记忆来源与撤销记录', properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] })
          if (picked.canceled) { result = { cancelled: true }; break }
          const file = await fs.open(picked.filePaths[0], 'r')
          let governance
          try {
            const limit = 4 * 1024 * 1024
            if ((await file.stat()).size > limit) throw new Error()
            const bytes = Buffer.alloc(limit + 1); let length = 0
            while (length < bytes.length) { const read = await file.read(bytes, length, bytes.length - length, null); if (!read.bytesRead) break; length += read.bytesRead }
            if (length > limit) throw new Error()
            governance = JSON.parse(bytes.subarray(0, length).toString('utf8'))
          } finally { await file.close() }
          result = await runtime.gateway.personalMemoryFiles({ type: 'import_revocations', governance }); await runtime.ensureScan(); runtime.changed(); break
        }
      }
      return contract.response(result)
    } catch (e) { return contract.response(null, /^(MEMORY_FILE_|AGENT_|MODEL_|EMBEDDING_)[A-Z0-9_]+$/.test(e.code || '') ? e.code : 'MEMORY_FILE_OPERATION_FAILED') }
  })
  return () => ipcMain.removeHandler(CHANNELS.PERSONAL_MEMORY_FILES)
}
module.exports = { registerPersonalMemoryFileIpc }
