'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const root = path.resolve(__dirname, '..', '..')

function read (relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

test('settings expose separate core and optional refinement resource controls without resource internals', () => {
  const html = read('src/settings/settings.html')
  const paneStart = html.indexOf('<section class="pane" data-pane="resources">')
  const paneEnd = html.indexOf('<!-- 关于 -->', paneStart)
  const pane = html.slice(paneStart, paneEnd)

  assert.ok(paneStart >= 0)
  assert.match(html, /class="nav-item" data-pane="resources">模型资源/)
  assert.deepEqual(
    [...pane.matchAll(/data-resource-id="([^"]+)"/g)].map((match) => match[1]),
    ['zipformer-bilingual-zh-en-2023-02-20', 'x-asr-160ms', 'silero-vad', 'x-asr-offline']
  )
  assert.equal((pane.match(/id="modelInstallButton"/g) || []).length, 1)
  assert.equal((pane.match(/id="refinementInstallButton"/g) || []).length, 1)
  assert.equal((pane.match(/id="refinementCancelButton"/g) || []).length, 1)
  assert.equal((pane.match(/id="refinementPreferenceToggle"/g) || []).length, 1)
  assert.match(pane, /核心字幕模型资源包/)
  assert.match(pane, /临时字幕识别器/)
  assert.match(pane, /权威识别器/)
  assert.match(pane, /临时字幕不会进入历史或导出/)
  assert.match(pane, /精修模型资源/)
  assert.match(pane, /只影响未来新会话/)
  assert.match(pane, /只服务于本地字幕识别，不包含 Agent、翻译或大语言模型/)
  assert.doesNotMatch(pane.replace(/<input id="refinementPreferenceToggle"[^>]*>/, ''), /<(?:input|textarea|select)\b/i)
  assert.doesNotMatch(pane, /https?:\/\//i)
})

test('MVP settings do not advertise the deferred translation capability', () => {
  const html = read('src/settings/settings.html')
  const script = read('src/settings/settings.js')

  assert.doesNotMatch(html, /显示双语译文|data-toggle="bilingual"/)
  assert.doesNotMatch(script, /setToggle\('bilingual'|next\.bilingual|data-toggle/)
  assert.match(html, /不包含 Agent、翻译或大语言模型/)
})

test('settings preload grants only fixed model actions and a boolean-only refinement preference', () => {
  const preload = read('src/preload/settings.js')

  assert.match(preload, /getModelStatus: \(\) => ipcRenderer\.invoke\(CHANNELS\.MODEL_STATUS_GET\)/)
  assert.match(preload, /installModelResources: \(\) => ipcRenderer\.invoke\(CHANNELS\.MODEL_INSTALL\)/)
  assert.match(preload, /installRefinementModel: \(\) => ipcRenderer\.invoke\(CHANNELS\.MODEL_INSTALL_REFINEMENT\)/)
  assert.match(preload, /cancelModelInstall: \(\) => ipcRenderer\.invoke\(CHANNELS\.MODEL_CANCEL_INSTALL\)/)
  assert.match(preload, /setRefinementPreference: \(enabled\) => ipcRenderer\.invoke\(CHANNELS\.REFINEMENT_PREFERENCE_SET, enabled === true\)/)
  assert.match(preload, /onModelStatus: \(callback\) => subscribe\(CHANNELS\.MODEL_STATUS_CHANGED, callback\)/)
  assert.match(preload, /onNavigate: \(callback\) => subscribe\(CHANNELS\.SETTINGS_NAVIGATE, callback\)/)
  assert.doesNotMatch(preload, /MODEL_INSTALL\s*,/)
  assert.doesNotMatch(preload, /MODEL_INSTALL_REFINEMENT\s*,/)
  assert.doesNotMatch(preload, /MODEL_CANCEL_INSTALL\s*,/)
  assert.doesNotMatch(preload, /downloadUrl|sha256|filePath|archive|extract/i)
})

test('resource renderer follows the public state contract and keeps errors path-safe', () => {
  const script = read('src/settings/settings.js')

  assert.match(script, /\['missing', 'downloading', 'verifying', 'ready', 'error'\]/)
  assert.match(script, /group\.state === 'downloading' \|\| group\.state === 'verifying'/)
  assert.match(script, /runtimeSnapshot !== null && runtimeSnapshot\.sessionId !== null/)
  assert.match(script, /window\.shell\.installRefinementModel\(\)/)
  assert.match(script, /window\.shell\.cancelModelInstall\(\)/)
  assert.match(script, /window\.shell\.setRefinementPreference\(enabled\)/)
  assert.match(script, /modelGroup\('core'\)/)
  assert.match(script, /modelGroup\('refinement'\)/)
  assert.match(script, /refinement\.downloadedBytes > 0/)
  assert.match(script, /sessionActive \|\| anyBusy/)
  assert.match(script, /window\.shell\.installModelResources\(\)/)
  assert.match(script, /window\.shell\.onNavigate\(\(pane\) => activatePane/)
  assert.match(script, /error\.textContent = group\.error === null \? '' : safeModelErrorMessage\(group\.error\)/)
  assert.doesNotMatch(script, /(?:next|modelStatus)\.error\.message/)
})

test('toolbar forwards the model-manager next action without running a runtime command', () => {
  const toolbar = read('src/toolbar/toolbar.js')

  assert.match(toolbar, /'open-model-manager': \(\) => bridge\.action\('open-model-manager'\)/)
  assert.doesNotMatch(toolbar, /runCommand\('open-model-manager'\)/)
})

test('toolbar accepts the first live runtime snapshot independently of preview fixture revision', () => {
  const toolbar = read('src/toolbar/toolbar.js')

  assert.match(toolbar, /let runtimeSnapshotAccepted = false/)
  assert.match(toolbar,
    /if \(runtimeSnapshotAccepted && snapshot && next\.revision < snapshot\.revision\) return/)
  assert.match(toolbar, /runtimeSnapshotAccepted = true\s+snapshot = next/)
})
