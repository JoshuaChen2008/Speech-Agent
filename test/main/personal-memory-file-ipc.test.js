'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { registerPersonalMemoryFileIpc } = require('../../src/main/ipc/personal-memory-file-ipc')
const { assertRequest, assertResponse, CONTRACT_ID, CONTRACT_VERSION } = require('../../src/agent/contracts/personal-memory-file-ui')
const { fixture } = require('../integration/helpers/personal-memory-file-fixture')
const header = { contractId: CONTRACT_ID, contractVersion: CONTRACT_VERSION }
test('SEM-F41/SEM-T04/J21: memory settings reject paths and extra fields before dialogs; only main owns the selected root', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); let handler; let authorized = true; let picks = 0
  registerPersonalMemoryFileIpc({ ipcMain: { handle: (_c, cb) => { handler = cb } }, authorize: () => { if (!authorized) throw Error() }, getRuntime: () => f.runtime,
    getWindow: () => null, dialog: { showOpenDialog: async () => { picks++; return { canceled: true, filePaths: [] } },
      showSaveDialog: async () => ({ canceled: false, filePath: path.join(f.directory, 'docs/validation/governance.json') }) }, shell: {} })
  authorized = false
  const denied = await handler({}, { ...header, command: { type: 'chooseRoot' } })
  assert.equal(denied.error.code, 'AGENT_CONTEXT_PERMISSION_DENIED'); assert.equal(picks, 0)
  authorized = true
  const rejected = await handler({}, { ...header, command: { type: 'chooseRoot', rootPath: f.directory } })
  assert.equal(rejected.error.code, 'MEMORY_FILE_REQUEST_INVALID'); assert.equal(picks, 0)
  const cancelled = await handler({}, { ...header, command: { type: 'chooseRoot' } })
  assert.deepEqual(cancelled.result, { cancelled: true }); assert.equal(picks, 1)
  const publicStatus = await handler({}, { ...header, command: { type: 'status' } })
  assert.equal(publicStatus.ok, true); assert.equal(JSON.stringify(publicStatus).includes(f.directory), false)
  fs.mkdirSync(path.join(f.directory, 'docs/validation'), { recursive: true })
  const forbiddenExport = await handler({}, { ...header, command: { type: 'exportGovernance' } })
  assert.equal(forbiddenExport.error.code, 'MEMORY_FILE_EXPORT_LOCATION_REJECTED')
  assert.equal(fs.existsSync(path.join(f.directory, 'docs/validation/governance.json')), false)
  for (const command of [{ type: 'confirm', rootId: 'root.x', fileId: 'file.x', expectedHash: '0'.repeat(64), restore: true, entry: null, path: f.directory }, { type: 'migrate', rootId: 'root.x', memoryIds: ['memory.a', 'memory.a'] }, { type: 'configureEmbedding', command: { type: 'setEmbeddingCredential', expectedRevision: 0, credential: 'key\nnew' } }]) assert.throws(() => assertRequest({ ...header, command }))
  for (const response of [{ ...header, ok: false, result: null, error: { code: 'MEMORY_FILE_INVALID', message: 'private' } }, { ...header, ok: true, result: { slotId: 'private' }, error: null }, { ...header, ok: true, result: { rootPath: 'private' }, error: null }]) assert.throws(() => assertResponse(response))
})
