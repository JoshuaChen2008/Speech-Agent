'use strict'

require('../ui/dom-bootstrap')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { EventEmitter } = require('node:events')
const test = require('node:test')
const React = require('react')
const { act } = React
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')
const { loadRendererModule } = require('../ui/load-renderer-module')
const { RecognitionSettings } = require('../../src/main/recognition/recognition-settings')
const { registerRecognitionIpc } = require('../../src/main/ipc/recognition-ipc')
const { isRoleAllowed } = require('../../src/main/ipc/access-policy')

// Substitute Electron transport only; the production preload, exact IPC,
// credential vault, settings service and React pane remain real.
function preloadBridge (handlers) {
  let shell
  const ipcRenderer = new EventEmitter()
  ipcRenderer.send = () => {}
  ipcRenderer.invoke = async (channel, request) => {
    const response = await handlers.get(channel)({ role: 'settings' }, request === undefined ? undefined : structuredClone(request))
    return structuredClone(response)
  }
  const electron = { ipcRenderer, contextBridge: { exposeInMainWorld: (name, value) => { if (name === 'shell') shell = value } } }
  const filenames = ['../../src/preload/settings', '../../src/preload/shared'].map(name => require.resolve(name))
  const previousCache = filenames.map(filename => require.cache[filename])
  const originalLoad = Module._load
  try {
    for (const filename of filenames) delete require.cache[filename]
    Module._load = function (request, parent, isMain) { return request === 'electron' ? electron : originalLoad.call(this, request, parent, isMain) }
    require('../../src/preload/settings')
  } finally {
    Module._load = originalLoad
    filenames.forEach((filename, index) => { if (previousCache[index]) require.cache[filename] = previousCache[index]; else delete require.cache[filename] })
  }
  return shell
}

test('SEM-F14/F21/F25 J20 settings pane uses real preload and IPC for disclosure, credentials, active exclusion and Token-only validation', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nls-settings-renderer-'))
  let active = false
  let tokenRequests = 0
  let settings = new RecognitionSettings({ directory, isActive: () => active, tokenRequest: async credential => {
    tokenRequests++
    assert.deepEqual(credential, { accessKeyId: 'synthetic-id', accessKeySecret: 'synthetic-secret' })
    return { Token: { Id: 'synthetic-token', ExpireTime: Math.floor(Date.now() / 1000) + 3600 } }
  } })
  const handlers = new Map()
  registerRecognitionIpc({ ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    authorize: (event, channel) => { assert.equal(isRoleAllowed(channel, event.role), true) }, getSettings: () => settings })
  const shell = preloadBridge(handlers)
  const { RecognitionSettingsPane } = await loadRendererModule(path.resolve('src/settings/recognition-settings-pane.tsx'))
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://settings.test/' })
  const keys = ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'IS_REACT_ACT_ENVIRONMENT']
  const previous = Object.fromEntries(keys.map(key => [key, global[key]]))
  Object.assign(global, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement, Event: dom.window.Event, MouseEvent: dom.window.MouseEvent,
    IS_REACT_ACT_ENVIRONMENT: true })
  const root = createRoot(document.getElementById('root'))
  t.after(async () => {
    await act(async () => root.unmount()); dom.window.close(); settings.close()
    for (const [key, value] of Object.entries(previous)) value === undefined ? delete global[key] : (global[key] = value)
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const render = () => act(async () => root.render(React.createElement(RecognitionSettingsPane, { shell, active })))
  const input = async (id, value) => act(async () => {
    const element = document.getElementById(id)
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(element, value)
    element.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
  const button = label => [...document.querySelectorAll('button')].find(element => element.textContent === label)
  const click = element => act(async () => element.click())
  const status = () => document.querySelector('[role="status"]').textContent
  await render()
  assert.equal(document.getElementById('recognitionStrategy').value, 'local-only')
  assert.equal(settings.freeze().strategy, 'local-only')
  assert.match(document.body.textContent, /本次会话不使用精修，即使断连后转为本地也一样。精修开关不变/)
  assert.match(document.body.textContent, /供应商处理和留存以其服务政策为准/)
  assert.equal(button('验证已保存凭据').disabled, true)
  await act(async () => {
    const select = document.getElementById('recognitionStrategy')
    select.value = 'cloud-primary'; select.dispatchEvent(new window.Event('change', { bubbles: true }))
  })
  await input('nlsAppKey', 'synthetic-project')
  await input('nlsModelLabel', '用户声明的模型说明')
  await input('nlsAccessKeyId', 'synthetic-id')
  await input('nlsAccessKeySecret', 'synthetic-secret')
  await click(button('保存识别设置'))
  assert.match(status(), /确认音频上传说明/)
  assert.match(status(), /凭据输入已清空，请重新输入后保存/)
  assert.equal(settings.getPublic().revision, 0)
  for (const id of ['nlsAccessKeyId', 'nlsAccessKeySecret']) assert.equal(document.getElementById(id).value, '')
  await click(document.querySelector('input[type="checkbox"]'))
  await input('nlsAccessKeyId', 'synthetic-id')
  await input('nlsAccessKeySecret', 'synthetic-secret')
  await click(button('保存识别设置'))
  assert.match(status(), /识别设置已保存/)
  assert.equal(settings.freeze().strategy, 'cloud-primary')
  assert.equal(settings.getPublic().credential.scope, 'session_only')
  assert.match(document.body.textContent, /AccessKey 仅在本次运行中保留/)
  for (const id of ['nlsAccessKeyId', 'nlsAccessKeySecret']) assert.equal(document.getElementById(id).value, '')
  assert.equal(JSON.stringify(await shell.getRecognitionSettings()).includes('synthetic-secret'), false)
  assert.equal(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8').includes('synthetic-secret'), false)
  assert.equal(tokenRequests, 0, 'saving does not perform a paid recognition request or Token verification')
  await click(button('验证已保存凭据'))
  assert.equal(tokenRequests, 1)
  assert.equal(status(), '已获取访问 Token；还未验证 AppKey、项目模型和识别效果。')
  active = true; await render()
  assert.equal([...document.querySelectorAll('input,select,button')].every(element => element.disabled), true)
  await click(button('保存识别设置'))
  assert.equal(settings.getPublic().revision, 1)
  active = false; await render()
  await click(button('清除凭据'))
  assert.equal(settings.getPublic().credential.present, false)
  assert.equal(button('验证已保存凭据').disabled, true)
  settings.close()
  fs.writeFileSync(path.join(directory, 'settings.json'), '{broken')
  settings = new RecognitionSettings({ directory, isActive: () => active })
  await act(async () => root.render(React.createElement(RecognitionSettingsPane, { shell, active, key: 'recovery' })))
  assert.match(document.querySelector('[role="alert"]').textContent, /识别设置损坏/)
  assert.throws(() => settings.freeze(), { code: 'NLS_SETTINGS_UNAVAILABLE' })
  await click(button('保存识别设置'))
  assert.equal(settings.freeze().strategy, 'local-only')
  assert.equal(document.querySelector('[role="alert"]'), null)
})
