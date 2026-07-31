'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const MAIN_PATH = path.resolve(__dirname, '../../src/main.js')

test('product composition initializes ModelManager before the SQLite application runtime', () => {
  const source = fs.readFileSync(MAIN_PATH, 'utf8')
  const managerIndex = source.indexOf('modelManager = new ModelManager({')
  const initializeIndex = source.indexOf('await modelManager.initialize()', managerIndex)
  const runtimeIndex = source.indexOf('applicationRuntime = new SubtitleApplicationRuntime({', initializeIndex)
  assert.ok(managerIndex >= 0 && initializeIndex > managerIndex && runtimeIndex > initializeIndex)
  assert.match(source, /const externalModelsAllowed = allowsExternalModelResources\(process\.env, \{ packaged: app\.isPackaged \}\)/)
  assert.match(source, /\.\.\.\(externalModelsAllowed\s*\? \{ externalReady:/s)
  assert.match(source, /externalReady:\s*\(artifactId\) => isExternalArtifactReady\(artifactId\)/)
  assert.match(source, /createApprovedRuntimeDefinition\(\{\s*userDataDir: app\.getPath\('userData'\),\s*allowExternal: allowsExternalModelResources\(process\.env, \{ packaged: app\.isPackaged \}\)/s)
  assert.match(source, /await modelManager\.initialize\(\)\s*if \(quitRequested\) return false/s)
  assert.match(source, /await applicationRuntime\.start\(\)\s*if \(quitRequested\) return false/s)
})

test('settings-only model IPC accepts no renderer-controlled install parameters', () => {
  const source = fs.readFileSync(MAIN_PATH, 'utf8')
  assert.match(source, /ipcMain\.handle\(CHANNELS\.MODEL_STATUS_GET, \(event\) => \{\s*requireSender\(event, CHANNELS\.MODEL_STATUS_GET\)/s)
  assert.match(source, /ipcMain\.handle\(CHANNELS\.MODEL_INSTALL, \(event\) => \{\s*requireSender\(event, CHANNELS\.MODEL_INSTALL\)\s*return installModelResources\(\)/s)
  assert.doesNotMatch(source, /ipcMain\.handle\(CHANNELS\.MODEL_INSTALL, \(event,\s*[^)]/)
  assert.match(source, /activateApprovedRuntime\(\{\s*coordinator,\s*userDataDir: app\.getPath\('userData'\),\s*allowExternal: allowsExternalModelResources\(process\.env, \{ packaged: app\.isPackaged \}\),\s*\.\.\.runtimeEvidenceOptions\s*\}\)/s)
})

test('quit and native-crash diagnostics are wired at the product composition root', () => {
  const source = fs.readFileSync(MAIN_PATH, 'utf8')
  const managerShutdown = source.indexOf('shutdownTasks.push(modelManager.shutdownWithin')
  const storageShutdown = source.indexOf('shutdownTasks.push(applicationRuntime.shutdownWithin', managerShutdown)
  assert.ok(managerShutdown >= 0 && storageShutdown > managerShutdown)
  assert.match(source, /shutdownTasks\.push\(modelManager\.shutdownWithin/)
  assert.match(source, /shutdownTasks\.push\(applicationRuntime\.shutdownWithin/)
  assert.match(source, /await Promise\.allSettled\(shutdownTasks\)/)
  assert.doesNotMatch(source, /await modelManager\.shutdownWithin/)
  assert.doesNotMatch(source, /await applicationRuntime\.shutdownWithin/)
  assert.match(source, /webContents\.on\('render-process-gone'/)
  assert.match(source, /app\.on\('child-process-gone'/)
  assert.match(source, /createMainEvidenceBridge\(\)/)
  assert.match(source, /exitEvidence\.recordRenderProcessGone\(win\.webContents, details\)/)
  assert.match(source, /exitEvidence\.recordChildProcessGone\(details\)/)
  assert.match(source, /exitEvidence\.recordPreloadError\(win\.webContents\)/)
  assert.match(source, /exitEvidence\.recordUnresponsive\(win\.webContents\)/)
  for (const stage of ['main-started', 'app-ready', 'bootstrap-complete', 'quit-requested', 'will-quit']) {
    assert.ok(source.includes(`markLifecycle('${stage}')`), `missing ${stage} evidence`)
  }
  assert.match(source, /registerAudioHostWebContents/)
  assert.match(source, /onAudioHostRenderProcessGone/)
  assert.match(source, /onAudioHostPreloadError/)
  assert.match(source, /onAudioHostUnresponsive/)
  assert.match(source, /onRealtimeUtilityFatal/)
  assert.match(source, /onRefineUtilityFatal/)
  assert.match(source, /onStorageUtilityFatal/)
  assert.match(source, /service=\$\{service\}.+type=\$\{type\}.+reason=\$\{reason\}/)
  assert.match(source, /diagnosticLabel\(details\.serviceName, CHILD_SERVICE_LABELS\)/)
  assert.doesNotMatch(source, /diagnosticLabel\(details\.name/)
  assert.match(source, /win\.on\('unresponsive'/)
  assert.match(source, /webContents\.on\('did-fail-load'/)
})

test('before-quit remains prevented when exact-child shutdown rejects', () => {
  const source = fs.readFileSync(MAIN_PATH, 'utf8')
  const barrierStart = source.indexOf('function beginQuitBarrier (event)')
  const barrierEnd = source.indexOf("const hasSingleInstanceLock = app.requestSingleInstanceLock()", barrierStart)
  const barrier = source.slice(barrierStart, barrierEnd)

  assert.match(barrier, /event\.preventDefault\(\)/)
  assert.match(barrier, /\}\)\(\)\.then\(\(\) => \{[\s\S]*quitBarrierComplete = true[\s\S]*app\.quit\(\)/)
  assert.match(barrier, /\.catch\(\(error\) => \{[\s\S]*quitBarrierPromise = null/)
  assert.doesNotMatch(barrier, /\.finally\([\s\S]*app\.quit\(\)/)
})

test('the ordinary start command uses the exact-child evidence supervisor', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'))
  assert.equal(packageJson.scripts.start, 'node scripts/run-supervised-electron.js --entry .')
})
