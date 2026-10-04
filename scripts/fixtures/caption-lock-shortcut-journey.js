'use strict'

// Real main/preloads/renderers/ConfigStore/BrowserWindows/SQLite. Only the OS
// key-state and global registration boundaries are controlled; no audio/model
// is requested. UI KeyboardEvents represent deterministic external input.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const electron = require('electron')
const { app, BrowserWindow } = electron
const callbacks = new Map()
let down = []; let suspended = false; let denied = false; let observationFault = false; let samples = 0
let writeFault = false
const originalRename = fs.renameSync
fs.renameSync = (from, to) => {
  if (writeFault && to === path.join(app.getPath('userData'), 'config.json')) {
    const error = new Error('controlled filesystem permission failure'); error.code = 'EACCES'; throw error
  }
  return originalRename(from, to)
}
const osShortcuts = {
  register (accelerator, callback) { if (suspended || denied || callbacks.has(accelerator)) return false; callbacks.set(accelerator, callback); return true },
  unregister: accelerator => callbacks.delete(accelerator),
  setSuspended: value => { suspended = value }
}
const originalLoad = Module._load
Module._load = function (request, parent, ...rest) {
  const result = originalLoad.call(this, request, parent, ...rest)
  if (request === 'electron' && parent?.filename === path.resolve(__dirname, '../../src/main.js')) return { ...result, globalShortcut: osShortcuts }
  return result
}
const nativeModule = require('../../src/main/caption-input-native')
const originalNativeLoad = nativeModule.loadCaptionInputNative
nativeModule.loadCaptionInputNative = options => {
  const addon = originalNativeLoad(options)
  return {
    attach: (...args) => addon.attach(...args), isAttached: (...args) => addon.isAttached(...args), detach: (...args) => addon.detach(...args),
    readShortcutKeys () { samples += 1; if (observationFault) throw new Error('controlled OS access failure'); return [...down] }
  }
}
if (!process.env.CAPTION_SHORTCUT_JOURNEY_DATA) throw new Error('isolated userData required')
app.setPath('userData', process.env.CAPTION_SHORTCUT_JOURNEY_DATA)
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('in-process-gpu')
require('../../src/main')

const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until (probe) {
  for (let i = 0; i < 300; i++) { if (await probe()) return; await wait(20) }
  throw new Error('caption shortcut readiness timeout')
}
function find (role) { return BrowserWindow.getAllWindows().find(win => win.webContents.getURL().replaceAll('\\', '/').includes(`/${role}/`)) }
async function run () {
  await app.whenReady()
  await until(() => find('toolbar') && find('caption'))
  const toolbar = find('toolbar'); const caption = find('caption')
  await until(() => toolbar.webContents.executeJavaScript('Boolean(window.shell)'))
  await until(() => caption.webContents.executeJavaScript('Boolean(document.getElementById("captionLockHint"))'))
  await toolbar.webContents.executeJavaScript("window.shell.action('settings')")
  await until(() => find('settings'))
  let settings = find('settings')
  const evaluate = source => settings.webContents.executeJavaScript(source)
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const config = () => evaluate('window.shell.getConfig()')
  const lock = () => caption.webContents.executeJavaScript('window.shell.getLock()')
  const hint = () => caption.webContents.executeJavaScript('document.getElementById("captionLockHint").textContent')
  async function key (code, type, options = {}) {
    await evaluate(`document.getElementById('captionShortcutInput').dispatchEvent(new KeyboardEvent(${JSON.stringify(type)}, { bubbles: true, cancelable: true, code: ${JSON.stringify(code)}, key: ${JSON.stringify(code === 'Escape' ? 'Escape' : code)}, ...${JSON.stringify(options)} }))`)
  }
  async function tap (values) { down = values; await wait(65); down = []; await wait(65) }
  await until(() => evaluate('Boolean(document.querySelector(".nav-item[data-pane=shortcuts]"))'))
  await click('.nav-item[data-pane=shortcuts]')
  await until(() => evaluate('Boolean(document.getElementById("captionShortcutRecord"))'))
  await wait(60)

  if (process.env.CAPTION_SHORTCUT_JOURNEY_REOPEN === '1') {
    const saved = await config()
    assert.equal(saved.captionLockShortcutEnabled, false); assert.deepEqual(saved.captionLockShortcut, ['AltRight'])
    assert.equal(callbacks.size, 0); const before = samples; await tap([165]); assert.equal(samples, before)
    assert.match(await hint(), /工具条锁定按钮/)
    denied = true
    await click('#captionShortcutReset')
    await until(() => evaluate('document.getElementById("captionShortcutError").textContent.includes("占用")'))
    assert.equal((await config()).captionLockShortcutEnabled, false)
    denied = false
    await click('#captionShortcutReset')
    await until(async () => (await config()).captionLockShortcutEnabled === true)
    assert.deepEqual((await config()).captionLockShortcut, ['Control', 'Alt', 'KeyL'])
    assert.match(await hint(), /Ctrl\+Alt\+L/)
    assert.equal(callbacks.has('Control+Alt+L'), true)
    await app.quit()
    process.stdout.write('CAPTION_SHORTCUT_REOPEN_OK\n')
    return
  }

  assert.match(await hint(), /Ctrl\+Alt\+L/)
  await click('#captionShortcutRecord'); await until(() => evaluate('Boolean(document.getElementById("captionShortcutInput"))'))
  assert.equal(suspended, true)
  await key('ControlLeft', 'keydown'); await key('AltRight', 'keydown', { ctrlKey: true, altKey: true })
  await key('AltRight', 'keyup'); await key('ControlLeft', 'keyup')
  assert.equal(await evaluate('document.getElementById("captionShortcutInput").value'), '右 Alt')
  assert.equal(await evaluate('document.getElementById("captionShortcutSave").disabled'), false)
  if (process.env.CAPTION_SHORTCUT_JOURNEY_SCREENSHOT) {
    await wait(250) // Let the compositor paint the recorded draft and settle the pane transition.
    const shot = await settings.webContents.capturePage()
    fs.writeFileSync(process.env.CAPTION_SHORTCUT_JOURNEY_SCREENSHOT, shot.toPNG())
  }
  await click('#captionShortcutSave')
  await until(async () => (await config()).captionLockShortcut[0] === 'AltRight' && !suspended)
  await until(async () => (await hint()).includes('右 Alt'))
  await wait(40) // Finish the required neutral sample after the save input.
  assert.equal(callbacks.size, 0)
  const first = await lock()
  down = [165]; await wait(140); assert.equal(await lock(), first)
  down = []; await until(async () => await lock() !== first)
  const after = await lock(); await tap([164]); assert.equal(await lock(), after)
  down = [165]; await wait(50); down = [165, 65]; await wait(50); down = []; await wait(60)
  assert.equal(await lock(), after)
  await tap([162, 165]); assert.equal(await lock(), first)

  await click('#captionShortcutRecord'); await until(() => evaluate('Boolean(document.getElementById("captionShortcutInput"))'))
  await key('F8', 'keydown'); await key('F8', 'keyup')
  writeFault = true
  await click('#captionShortcutSave')
  await until(() => evaluate('document.getElementById("captionShortcutError").textContent.includes("未保存")'))
  writeFault = false
  assert.deepEqual((await config()).captionLockShortcut, ['AltRight'])
  assert.equal(callbacks.has('F8'), false)
  await click('#captionShortcutCancel'); await until(() => !suspended)

  await click('#captionShortcutRecord'); await until(() => evaluate('Boolean(document.getElementById("captionShortcutInput"))'))
  await key('KeyK', 'keydown'); await key('KeyK', 'keyup'); await key('Escape', 'keydown')
  await until(() => !suspended); assert.deepEqual((await config()).captionLockShortcut, ['AltRight'])
  await click('#captionShortcutRecord'); await until(() => evaluate('Boolean(document.getElementById("captionShortcutInput"))'))
  await click('.nav-item[data-pane=display]'); await until(() => !suspended)
  await click('.nav-item[data-pane=shortcuts]')
  await click('#captionShortcutRecord'); await until(() => evaluate('Boolean(document.getElementById("captionShortcutInput"))'))
  // Window blur/reload are real production main lifecycle boundaries.
  settings.blur(); await until(() => !suspended)
  settings.focus(); await wait(60)
  await evaluate('window.shell.setCaptionLockShortcutRecording({ recording: true })')
  assert.equal(suspended, true)
  settings.webContents.reload()
  await until(() => !suspended)
  await until(() => evaluate('Boolean(document.querySelector(".nav-item[data-pane=shortcuts]"))'))
  await click('.nav-item[data-pane=shortcuts]')
  await until(() => evaluate('Boolean(document.getElementById("captionShortcutRecord"))'))
  await evaluate('window.shell.setCaptionLockShortcutRecording({ recording: true })')
  await evaluate('window.shell.closeSettings()'); await until(() => !find('settings')); assert.equal(suspended, false)
  await toolbar.webContents.executeJavaScript("window.shell.action('settings')"); await until(() => find('settings')); settings = find('settings')
  await until(() => evaluate('Boolean(document.querySelector(".nav-item[data-pane=shortcuts]"))'))
  await click('.nav-item[data-pane=shortcuts]')
  await until(() => evaluate('Boolean(document.getElementById("captionShortcutEnabled"))'))
  observationFault = true; await until(async () => (await config()).captionLockShortcutStatus === 'unavailable')
  assert.match(await hint(), /工具条锁定按钮/)
  observationFault = false
  const restored = await evaluate('window.shell.setConfig({ captionLockShortcutEnabled: true })'); assert.equal(restored.ok, true)
  await until(async () => (await config()).captionLockShortcutStatus === 'active')
  await click('#captionShortcutEnabled')
  await until(async () => (await config()).captionLockShortcutEnabled === false)
  assert.deepEqual((await config()).captionLockShortcut, ['AltRight'])
  assert.match(await hint(), /工具条锁定按钮/)
  const disabledLock = await lock(); const sampleCount = samples; await tap([165]); assert.equal(await lock(), disabledLock); assert.equal(samples, sampleCount)
  await toolbar.webContents.executeJavaScript('window.shell.lockToggle()')
  await until(async () => await lock() !== disabledLock)
  // No subtitle text or audio in this settings-only PNG.
  if (process.env.CAPTION_SHORTCUT_JOURNEY_SCREENSHOT) {
    await wait(250)
    const shot = await settings.webContents.capturePage()
    fs.writeFileSync(process.env.CAPTION_SHORTCUT_JOURNEY_SCREENSHOT.replace(/\.png$/, '-disabled.png'), shot.toPNG())
  }
  process.stdout.write('CAPTION_SHORTCUT_JOURNEY_OK\n')
  app.quit()
}
run().catch(error => { console.error(error); app.exit(1) })
