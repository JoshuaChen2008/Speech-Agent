'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { RecognitionSettings } = require('../../src/main/recognition/recognition-settings')
const { registerRecognitionIpc } = require('../../src/main/ipc/recognition-ipc')
const CHANNELS = require('../../src/main/ipc/channels')
const { isRoleAllowed } = require('../../src/main/ipc/access-policy')

test('SEM-F14/F25 J20 real settings IPC and preload enforce exact requests and secret-free responses', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nls-ipc-'))
  const settings = new RecognitionSettings({ directory, tokenRequest: async () => ({ Token: { Id: 'private-token', ExpireTime: Math.floor(Date.now() / 1000) + 3600 } }) })
  t.after(() => { settings.close(); fs.rmSync(directory, { recursive: true, force: true }) })
  const handlers = new Map()
  registerRecognitionIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) }, authorize: () => {}, getSettings: () => settings })
  let exposed; let responseOverride
  const preload = path.resolve('src/preload/settings.js')
  const nativeRequire = createRequire(preload)
  const ipcRenderer = { invoke: async (channel, request) => responseOverride || handlers.get(channel)({}, request) }
  const localRequire = specifier => specifier === 'electron'
    ? { contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api } } }
    : specifier === './shared' ? { createWindowInteractionBridge: () => ({}), ipcRenderer, subscribe: () => {} } : nativeRequire(specifier)
  vm.runInNewContext(`(function(require) {${fs.readFileSync(preload, 'utf8')}\n})`)(localRequire)
  const request = { expectedRevision: 0, strategy: 'cloud-primary', appKey: 'synthetic-project', modelLabel: '', cloudDisclosureAccepted: true, credential: { accessKeyId: 'synthetic-id', accessKeySecret: 'private-secret' } }
  const saved = await exposed.updateRecognitionSettings(request)
  assert.equal(saved.ok, true)
  assert.equal((await exposed.getRecognitionSettings()).value.revision, 1)
  assert.deepEqual(await exposed.verifyRecognitionCredentials(), { ok: true, value: { verified: true, scope: 'token-only' } })
  assert.equal(JSON.stringify(saved).includes('private-secret'), false)
  assert.throws(() => exposed.updateRecognitionSettings({ ...request, rawToken: 'private' }), { code: 'NLS_INVALID_SETTINGS' })
  assert.equal((await handlers.get(CHANNELS.RECOGNITION_UPDATE)({}, { ...request, rawToken: 'private' })).code, 'NLS_INVALID_SETTINGS')
  for (const malformed of [{ ...saved, rawToken: 'private' }, { ok: true, value: { ...saved.value, secret: 'private' } }, { ok: false, code: 'RAW_ERROR', stack: 'private' }]) {
    responseOverride = malformed
    await assert.rejects(exposed.getRecognitionSettings(), { code: 'NLS_INVALID_SETTINGS' })
  }
  for (const channel of [CHANNELS.RECOGNITION_GET, CHANNELS.RECOGNITION_UPDATE, CHANNELS.RECOGNITION_VERIFY]) {
    assert.equal(isRoleAllowed(channel, 'settings'), true)
    for (const role of ['caption', 'toolbar', 'history', 'agent']) assert.equal(isRoleAllowed(channel, role), false)
  }
})

test('SEM-F14/F25 J20 IPC sanitizes unavailable settings and rejects injected response fields', async () => {
  for (const getSettings of [() => { throw new Error('private path') }, () => ({ getPublic: () => ({ token: 'private' }) })]) {
    const handlers = new Map()
    registerRecognitionIpc({ ipcMain: { handle: (c, h) => handlers.set(c, h) }, authorize: () => {}, getSettings })
    const response = await handlers.get(CHANNELS.RECOGNITION_GET)({})
    assert.equal(response.ok, false)
    assert.equal(JSON.stringify(response).includes('private'), false)
  }
})
