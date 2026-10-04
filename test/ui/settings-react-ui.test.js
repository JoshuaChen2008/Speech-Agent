'use strict'

require('./dom-bootstrap')

const assert = require('node:assert/strict')
const path = require('node:path')
const test = require('node:test')
const React = require('react')
const { act } = React
const { createRoot } = require('react-dom/client')
const { JSDOM } = require('jsdom')
const { loadRendererModule } = require('./load-renderer-module')

const root = path.resolve(__dirname, '..', '..')

async function loadSettingsView () {
  const filename = path.join(root, 'src', 'settings', 'settings-view.tsx')
  const exports = await loadRendererModule(filename)
  return exports.SettingsView
}

function deferred () {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise })
  return { promise, reject, resolve }
}

async function flush (delay = 0) {
  await act(async () => {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
  })
}

function click (element) { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) }

async function createHarness (overrides = {}) {
  const SettingsView = await loadSettingsView()
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://settings.test/' })
  const globalKeys = ['window', 'document', 'HTMLElement', 'Event', 'MouseEvent']
  const previous = Object.fromEntries(globalKeys.map((key) => [key, global[key]]))
  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent
  })
  global.IS_REACT_ACT_ENVIRONMENT = true

  const authority = {
    theme: 'dark', systemDark: true, fontSize: 30, opacity: 0.86, toolbarOpacity: 0.82,
    barColor: null, radius: 10, latency: 160, loopback: true, mic: false,
    refinementEnabled: false, onboardingCompleted: true,
    captionLockShortcutEnabled: true, captionLockShortcut: ['Control', 'Alt', 'KeyL'], captionLockShortcutStatus: 'active', ...overrides
  }
  const configRequests = []
  const presetRequests = []
  const recordingRequests = []
  dom.window.ManualWindowDrag = {
    bindManualWindowDrag: () => ({ end () {} }),
    isInteractiveDragEvent: () => false
  }
  dom.window.shell = {
    closeSettings () {}, dragStart () {}, dragEnd () {},
    onConfig: () => () => {}, onSnapshot: () => () => {}, onModelStatus: () => () => {}, onNavigate: () => () => {},
    getConfig: async () => structuredClone(authority),
    getSnapshot: async () => ({ revision: 1, sessionId: null, capabilities: { availableProfiles: ['fast'], limitations: [] } }),
    getModelStatus: async () => ({
      schemaVersion: 1,
      core: { state: 'missing', progress: 0, downloadedBytes: 0, totalBytes: 1, error: null },
      refinement: { state: 'missing', progress: 0, downloadedBytes: 0, totalBytes: 1, error: null },
      resources: [], canInstall: true, canInstallRefinement: true, canCancelInstall: false
    }),
    setConfig (patch) { const request = deferred(); configRequests.push({ patch, request }); return request.promise },
    setCaptionLockShortcutRecording: async (request) => { recordingRequests.push(request); return { ok: true } },
    selectPreset (preset) { const request = deferred(); presetRequests.push({ preset, request }); return request.promise },
    installModelResources: async () => ({ ok: false }),
    installRefinementModel: async () => ({ ok: false }),
    cancelModelInstall: async () => ({ ok: false }),
    setRefinementPreference: async () => ({ ok: false })
  }

  const reactRoot = createRoot(dom.window.document.getElementById('root'))
  await act(async () => reactRoot.render(React.createElement(SettingsView)))
  await flush()
  return {
    authority, configRequests, dom, presetRequests, recordingRequests,
    async dispose () {
      await act(async () => reactRoot.unmount())
      dom.window.close()
      for (const [key, value] of Object.entries(previous)) value === undefined ? delete global[key] : (global[key] = value)
      delete global.IS_REACT_ACT_ENVIRONMENT
    }
  }
}

test('SEM-F23/J18: appearance previews immediately, then failed persistence restores the authoritative config', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  const light = document.querySelector('[data-seg="theme"] [data-val="light"]')
  await act(async () => click(light))
  await flush()
  assert.equal(document.documentElement.dataset.theme, 'light')
  assert.equal(light.classList.contains('on'), true)
  assert.equal(harness.configRequests.length, 0, 'preview must not wait on persistence')

  await flush(140)
  assert.equal(harness.configRequests.length, 1)
  assert.deepEqual(harness.configRequests[0].patch, { theme: 'light' })
  await act(async () => harness.configRequests[0].request.resolve({ ok: false, message: '设置未保存' }))
  await flush()
  assert.equal(document.documentElement.dataset.theme, 'dark')
  assert.equal(document.querySelector('[data-seg="theme"] [data-val="dark"]').classList.contains('on'), true)
  assert.equal(document.getElementById('settingsStatus').textContent, '设置未保存')
})

test('SEM-F23/J18: source command exposes pending feedback and rolls back after an authoritative rejection', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  await act(async () => click(document.querySelector('.nav-item[data-pane="audio"]')))
  await flush()
  await act(async () => click(document.querySelector('[data-source="mic"]')))
  await flush()
  assert.equal(harness.presetRequests.length, 1)
  assert.equal(harness.presetRequests[0].preset, 'dictation')
  assert.equal(document.getElementById('settingsStatus').textContent, '正在切换监听模式…')
  assert.equal(document.querySelector('[data-source="mic"]').disabled, true)
  assert.equal(document.querySelector('[data-source="loopback"]').disabled, true)

  await act(async () => harness.presetRequests[0].request.resolve({ ok: false, message: '监听模式未保存' }))
  await flush()
  assert.equal(document.getElementById('settingsStatus').textContent, '监听模式未保存')
  assert.equal(document.querySelector('[data-source="loopback"]').getAttribute('aria-checked'), 'true')
  assert.equal(document.querySelector('[data-source="mic"]').getAttribute('aria-checked'), 'false')
  assert.equal(document.querySelector('[data-source="mic"]').disabled, false)
})

test('S5-UX/J21/J25: 设置导航新增我的记忆与 助手模型类别，使用展示名称且保留既有顺序', async (t) => {
  const harness = await createHarness(); t.after(() => harness.dispose())
  const labels = [...document.querySelectorAll('.nav-item')].map((item) => item.textContent)
  assert.deepEqual(labels, ['显示与字幕', '快捷键', '音频来源', '语音识别', '模型资源', '我的记忆', '助手模型', '关于'])
  assert.equal(document.querySelector('.nav-item[data-pane="agentContext"]') !== null, true)
  assert.equal(document.querySelector('.nav-item[data-pane="agentModel"]') !== null, true)
})

function shortcutKey (code, type, extra = {}) {
  document.getElementById('captionShortcutInput').dispatchEvent(new window.KeyboardEvent(type, { bubbles: true, cancelable: true, code, key: code === 'Escape' ? 'Escape' : code, ...extra }))
}
async function openShortcutRecorder () {
  await act(async () => click(document.querySelector('.nav-item[data-pane="shortcuts"]')))
  await flush()
  await act(async () => click(document.getElementById('captionShortcutRecord')))
  await flush()
}

test('SEM-F22/F23/J17-SHORTCUT: right Alt and AltGr record a draft, then save explicitly and return keyboard focus', async (t) => {
  const h = await createHarness(); t.after(() => h.dispose()); await openShortcutRecorder()
  assert.equal(document.activeElement.id, 'captionShortcutInput')
  await act(async () => {
    shortcutKey('ControlLeft', 'keydown'); shortcutKey('AltRight', 'keydown', { ctrlKey: true, altKey: true })
    assert.equal(document.getElementById('captionShortcutSave').disabled, true)
    shortcutKey('AltRight', 'keyup'); shortcutKey('ControlLeft', 'keyup')
  })
  await flush()
  assert.equal(document.getElementById('captionShortcutInput').value, '右 Alt')
  assert.equal(document.getElementById('captionShortcutSave').disabled, false)
  assert.equal(h.configRequests.length, 0)
  await act(async () => { shortcutKey('AltRight', 'keydown', { ctrlKey: true, altKey: true }); shortcutKey('AltRight', 'keyup') })
  await flush()
  assert.equal(document.getElementById('captionShortcutInput').value, '右 Alt')
  await act(async () => click(document.getElementById('captionShortcutSave')))
  assert.deepEqual(h.configRequests[0].patch, { captionLockShortcut: ['AltRight'] })
  await act(async () => { Object.assign(h.authority, h.configRequests[0].patch); h.configRequests[0].request.resolve({ ok: true }) })
  await flush()
  assert.equal(document.getElementById('captionShortcutInput'), null)
  assert.equal(document.getElementById('captionShortcutCurrent').textContent, '右 Alt')
  assert.equal(document.activeElement.id, 'captionShortcutRecord')
  assert.deepEqual(h.recordingRequests.map(r => r.recording), [true, false])
})

test('SEM-F22/SEM-T04/J17-SHORTCUT: saving rejection retains the current shortcut and the editable draft', async (t) => {
  const h = await createHarness(); t.after(() => h.dispose()); await openShortcutRecorder()
  await act(async () => {
    shortcutKey('ControlRight', 'keydown'); shortcutKey('KeyK', 'keydown'); shortcutKey('KeyK', 'keyup'); shortcutKey('ControlRight', 'keyup')
  })
  await act(async () => click(document.getElementById('captionShortcutSave')))
  await act(async () => h.configRequests[0].request.resolve({ ok: false, message: '设置未保存' })); await flush()
  assert.equal(document.getElementById('captionShortcutCurrent').textContent, 'Ctrl+Alt+L')
  assert.equal(document.getElementById('captionShortcutInput').value, '右 Ctrl+K')
  assert.equal(document.getElementById('captionShortcutError').textContent, '设置未保存')
  await act(async () => click(document.getElementById('captionShortcutCancel'))); await flush()
  assert.equal(document.getElementById('captionShortcutInput'), null)
  assert.equal(h.recordingRequests.at(-1).recording, false)
})

test('SEM-F22/SEM-T04/J17-SHORTCUT: Escape, blur, navigation and a late recording reply restore the shortcut without saving', async (t) => {
  const h = await createHarness(); t.after(() => h.dispose()); await openShortcutRecorder()
  await act(async () => shortcutKey('Escape', 'keydown')); await flush()
  assert.equal(document.activeElement.id, 'captionShortcutRecord')
  await act(async () => click(document.getElementById('captionShortcutRecord'))); await flush()
  await act(async () => window.dispatchEvent(new window.Event('blur'))); await flush()
  assert.equal(document.getElementById('captionShortcutInput'), null)
  await act(async () => click(document.getElementById('captionShortcutRecord'))); await flush()
  await act(async () => click(document.querySelector('.nav-item[data-pane="display"]'))); await flush()
  assert.equal(h.recordingRequests.at(-1).recording, false)
  await act(async () => click(document.querySelector('.nav-item[data-pane="shortcuts"]'))); await flush()
  const reply = deferred()
  window.shell.setCaptionLockShortcutRecording = request => request.recording ? reply.promise : Promise.resolve({ ok: true })
  await act(async () => click(document.getElementById('captionShortcutRecord')))
  await act(async () => window.dispatchEvent(new window.Event('blur')))
  await act(async () => reply.resolve({ ok: true })); await flush()
  assert.equal(document.getElementById('captionShortcutInput'), null)
  assert.equal(h.configRequests.length, 0)
})

test('SEM-F22/J17-SHORTCUT: disabling retains the recorded key; restoring defaults explicitly re-enables Ctrl+Alt+L', async (t) => {
  const h = await createHarness({ captionLockShortcut: ['AltRight'] }); t.after(() => h.dispose())
  await act(async () => click(document.querySelector('.nav-item[data-pane="shortcuts"]'))); await flush()
  await act(async () => click(document.getElementById('captionShortcutEnabled')))
  assert.deepEqual(h.configRequests[0].patch, { captionLockShortcutEnabled: false })
  await act(async () => { h.authority.captionLockShortcutEnabled = false; h.configRequests[0].request.resolve({ ok: true }) }); await flush()
  assert.equal(document.getElementById('captionShortcutEnabled').checked, false)
  assert.equal(document.getElementById('captionShortcutCurrent').textContent, '右 Alt')
  await act(async () => click(document.getElementById('captionShortcutReset')))
  assert.deepEqual(h.configRequests[1].patch, { captionLockShortcut: ['Control', 'Alt', 'KeyL'], captionLockShortcutEnabled: true })
  await act(async () => { Object.assign(h.authority, h.configRequests[1].patch); h.configRequests[1].request.resolve({ ok: true }) }); await flush()
  assert.equal(document.getElementById('captionShortcutEnabled').checked, true)
  assert.equal(document.getElementById('captionShortcutCurrent').textContent, 'Ctrl+Alt+L')
})
