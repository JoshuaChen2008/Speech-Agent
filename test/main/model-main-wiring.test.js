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
  assert.match(source, /externalReady:\s*\(artifactId\) => isExternalArtifactReady\(artifactId\)/)
})

test('settings-only model IPC accepts no renderer-controlled install parameters', () => {
  const source = fs.readFileSync(MAIN_PATH, 'utf8')
  assert.match(source, /ipcMain\.handle\(CHANNELS\.MODEL_STATUS_GET, \(event\) => \{\s*requireSender\(event, CHANNELS\.MODEL_STATUS_GET\)/s)
  assert.match(source, /ipcMain\.handle\(CHANNELS\.MODEL_INSTALL, \(event\) => \{\s*requireSender\(event, CHANNELS\.MODEL_INSTALL\)\s*return installModelResources\(\)/s)
  assert.doesNotMatch(source, /ipcMain\.handle\(CHANNELS\.MODEL_INSTALL, \(event,\s*[^)]/)
  assert.match(source, /activateApprovedRuntime\(\{\s*coordinator,\s*userDataDir: app\.getPath\('userData'\)\s*\}\)/s)
})

test('quit and native-crash diagnostics are wired at the product composition root', () => {
  const source = fs.readFileSync(MAIN_PATH, 'utf8')
  const managerShutdown = source.indexOf('await modelManager.shutdownWithin(DEFAULT_MODEL_SHUTDOWN_TIMEOUT_MS)')
  const storageShutdown = source.indexOf('await applicationRuntime.shutdownWithin', managerShutdown)
  assert.ok(managerShutdown >= 0 && storageShutdown > managerShutdown)
  assert.match(source, /webContents\.on\('render-process-gone'/)
  assert.match(source, /app\.on\('child-process-gone'/)
  assert.match(source, /win\.on\('unresponsive'/)
  assert.match(source, /webContents\.on\('did-fail-load'/)
})
