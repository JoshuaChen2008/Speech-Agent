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
  const html = read('src/settings/settings-view.tsx')
  const paneStart = html.indexOf('data-pane="resources"')
  const paneEnd = html.indexOf('data-pane="about"', paneStart)
  const pane = html.slice(paneStart, paneEnd)

  assert.ok(paneStart >= 0)
  assert.match(html, /\['resources', '模型资源'\]/)
  const resourceCopy = html.slice(html.indexOf('const RESOURCE_COPY'), html.indexOf('] as const', html.indexOf('const RESOURCE_COPY')))
  assert.deepEqual(
    [...resourceCopy.matchAll(/\['([^']+)', '[^']+', '[^']+'\]/g)].map((match) => match[1]),
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
  const html = read('src/settings/settings-view.tsx')
  const script = html

  assert.doesNotMatch(html, /显示双语译文|data-toggle="bilingual"/)
  assert.doesNotMatch(script, /setToggle\('bilingual'|next\.bilingual|data-toggle/)
  assert.match(html, /不包含 Agent、翻译或大语言模型/)
})

test('SEM-F23/J18: settings production entry mounts a React TypeScript view on an opaque Mica fallback', () => {
  const html = read('src/settings/settings.html')
  const entry = read('src/settings/entry.tsx')
  const view = read('src/settings/settings-view.tsx')
  const styles = read('src/settings/settings.css')
  const tokens = read('src/ui/shared/tokens.css')
  const main = read('src/main.js')

  assert.match(html, /id="root"/)
  assert.match(html, /src="\.\/entry\.tsx"/)
  assert.match(entry, /createRoot\(root\)\.render\(<SettingsView \/>\)/)
  assert.match(view, /useState<Dict \| null>/)
  assert.match(view, /onClick=\{\(\) => void install\('core'\)\}/)
  assert.doesNotMatch(view, /settings-markup|dangerouslySetInnerHTML=\{\{ __html: template\.innerHTML/)
  assert.match(main, /function openSettingsWindow[\s\S]*backgroundMaterial: 'mica'[\s\S]*backgroundColor: '#202020'/)
  assert.match(tokens, /--surface-settings: rgb\(32, 32, 32\)/)
  assert.match(tokens, /--surface-settings: rgb\(243, 243, 243\)/)
  assert.doesNotMatch(styles, /backdrop-filter|backgroundMaterial:'acrylic'/)
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
  const script = read('src/settings/settings-view.tsx')

  assert.match(script, /\['missing', 'downloading', 'verifying', 'ready', 'error'\]/)
  assert.match(script, /\['downloading', 'verifying'\]\.includes\(core\.state\)/)
  assert.match(script, /runtime\?\.sessionId != null/)
  assert.match(script, /shell\.installRefinementModel\(\)/)
  assert.match(script, /shell\.cancelModelInstall\(\)/)
  assert.match(script, /shell\.setRefinementPreference\(enabled\)/)
  assert.match(script, /models\?\.core \?\? fallbackGroup\(\)/)
  assert.match(script, /models\?\.refinement \?\? fallbackGroup\(\)/)
  assert.match(script, /kind === 'refinement' && group\.downloadedBytes > 0/)
  assert.match(script, /sessionActive \|\| anyBusy/)
  assert.match(script, /shell\.installModelResources\(\)/)
  assert.match(script, /shell\.onNavigate/)
  assert.match(script, /safeModelErrorMessage\(group\.error\)/)
  assert.doesNotMatch(script, /(?:next|modelStatus)\.error\.message/)
})

test('toolbar forwards the model-manager next action without running a runtime command', () => {
  const toolbar = read('src/toolbar/toolbar.ts')

  assert.match(toolbar, /'open-model-manager': \(\) => bridge\.action\('open-model-manager'\)/)
  assert.doesNotMatch(toolbar, /runCommand\('open-model-manager'\)/)
})

test('toolbar accepts the first live runtime snapshot independently of preview fixture revision', () => {
  const toolbar = read('src/toolbar/toolbar.ts')

  assert.match(toolbar, /let runtimeSnapshotAccepted = false/)
  assert.match(toolbar,
    /if \(runtimeSnapshotAccepted && snapshot && next\.revision < snapshot\.revision\) return/)
  assert.match(toolbar, /runtimeSnapshotAccepted = true\s+snapshot = next/)
})
