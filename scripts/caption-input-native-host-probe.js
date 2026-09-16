'use strict'

// I2/J17 diagnostic host. This is intentionally outside the product entry:
// it creates one real non-focusable BrowserWindow on the Electron UI thread,
// attaches the native subclass, probes WM_MOUSEACTIVATE, and verifies that
// WM_NCDESTROY releases the binding. Only fixed booleans and Win32 enum values
// are printed; no window address, path, caption text, or pointer coordinates
// leave the process.

const { app, BrowserWindow } = require('electron')
const {
  createDiagnosticBinding,
  loadCaptionInputNative
} = require('../src/main/caption-input-native')

// The host probe must stay independent of the machine's GPU driver. A single
// Chromium switch is sufficient to keep the native input assertion focused on
// the BrowserWindow/UI-thread boundary without changing product startup.
app.commandLine.appendSwitch('disable-gpu')

async function main () {
  let win = null
  let binding = null
  let passed = false
  try {
    const addon = loadCaptionInputNative({
      platform: process.platform,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath
    })
    win = new BrowserWindow({
      show: false,
      focusable: false,
      frame: false,
      transparent: true,
      skipTaskbar: true,
      webPreferences: { sandbox: false, contextIsolation: true, nodeIntegration: false }
    })
    const hwnd = win.getNativeWindowHandle()
    binding = createDiagnosticBinding(addon, hwnd, { correct: true })
    const attachedBeforeDestroy = binding.isAttached()
    const sameThread = binding.inspect()?.sameThread === true
    const sameProcess = binding.inspect()?.sameProcess === true
    const beforeProbe = binding.stats() || {}
    const effectiveMouseActivate = binding.probeMouseActivate(1, 513)
    const afterProbe = binding.stats() || {}
    const correctionObserved = effectiveMouseActivate === 3 &&
      afterProbe.lastResult === 4 &&
      afterProbe.swallowedCount === (beforeProbe.swallowedCount || 0) + 1 &&
      afterProbe.correctedCount === (beforeProbe.correctedCount || 0) + 1
    win.show()
    win.minimize()
    const minimizedObserved = win.isMinimized()
    win.restore()
    await new Promise((resolve) => setImmediate(resolve))
    const restoredStatsBeforeProbe = binding.stats() || {}
    const restoredMouseActivate = binding.probeMouseActivate(1, 513)
    const restoredStats = binding.stats() || {}
    const restoredBindingAlive = binding.isAttached() &&
      binding.matches(win.getNativeWindowHandle()) &&
      !win.isMinimized() &&
      restoredMouseActivate === 3 &&
      restoredStats.lastResult === 4 &&
      restoredStats.swallowedCount === (restoredStatsBeforeProbe.swallowedCount || 0) + 1 &&
      restoredStats.correctedCount === (restoredStatsBeforeProbe.correctedCount || 0) + 1
    win.destroy()
    await new Promise((resolve) => setImmediate(resolve))
    passed = attachedBeforeDestroy && sameThread && sameProcess &&
      correctionObserved && minimizedObserved && restoredBindingAlive && binding.isAttached() === false
  } catch {
    passed = false
  } finally {
    try { binding?.dispose() } catch {}
    try {
      if (win && !win.isDestroyed()) win.destroy()
    } catch {}
    const result = JSON.stringify({ result: passed ? 'pass' : 'fail' }) + '\n'
    process.stdout.write(result, () => app.exit(passed ? 0 : 1))
  }
}

app.whenReady().then(main).catch(() => {
  process.stdout.write(JSON.stringify({ result: 'fail' }) + '\n', () => app.exit(1))
})
