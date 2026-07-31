'use strict'

// @ts-check

/* Real Electron main-process fixture for the privacy-safe supervisor. It
   creates no BrowserWindow, opens no audio source and persists no application
   data beyond Electron's isolated userData directory supplied by the test. */

const { app } = require('electron')
const {
  createMainEvidenceBridge
} = require('../../src/main/services/electron-exit-evidence')

const MODES = new Set([
  'clean',
  'delayed-clean',
  'secondary',
  'abnormal',
  'prebootstrap-abnormal',
  'late-incident',
  'renderer-unresponsive',
  'storage-breakpoint-signed',
  'storage-breakpoint-unsigned'
])
const requested = process.argv.find((value) => value.startsWith('--mode='))
const mode = requested ? requested.slice('--mode='.length) : 'clean'
const isolatedUserData = process.env.ELECTRON_EVIDENCE_FIXTURE_USER_DATA

if (typeof isolatedUserData === 'string' && isolatedUserData.length > 0) {
  app.setPath('userData', isolatedUserData)
}

const evidence = createMainEvidenceBridge()
evidence.markLifecycle('main-started')
app.on('window-all-closed', () => {})

function quitCleanly () {
  evidence.markLifecycle('quit-requested')
  app.once('will-quit', (event) => {
    event.preventDefault()
    evidence.markLifecycle('will-quit')
    setTimeout(() => app.exit(0), 25)
  })
  app.quit()
}

app.whenReady().then(() => {
  evidence.markLifecycle('app-ready')

  if (!MODES.has(mode)) {
    app.exit(64)
    return
  }
  if (mode !== 'secondary' && mode !== 'prebootstrap-abnormal') {
    evidence.markLifecycle('bootstrap-complete')
  }
  if (mode === 'abnormal' || mode === 'prebootstrap-abnormal') {
    setTimeout(() => app.exit(23), 25)
    return
  }
  if (mode === 'secondary') {
    setTimeout(quitCleanly, 25)
    return
  }
  if (mode === 'late-incident') {
    evidence.markLifecycle('quit-requested')
    app.once('will-quit', (event) => {
      event.preventDefault()
      evidence.markLifecycle('will-quit')
      evidence.recordChildProcessGone({
        type: 'Utility',
        serviceName: 'Speech Agent subtitle storage',
        reason: 'crashed',
        exitCode: -2147483645
      })
      app.exit(0)
    })
    app.quit()
    return
  }
  if (mode === 'renderer-unresponsive') {
    const webContents = {}
    evidence.registerWebContents(webContents, 'renderer')
    evidence.recordUnresponsive(webContents)
  }
  if (mode.startsWith('storage-breakpoint')) {
    evidence.recordChildProcessGone({
      type: 'Utility',
      serviceName: 'Speech Agent subtitle storage',
      reason: 'crashed',
      exitCode: mode === 'storage-breakpoint-signed' ? -2147483645 : 2147483651,
      location: 'C:\\Users\\private\\native.cc',
      report: 'private subtitle body and diagnostic memory',
      message: 'private-audio.wav'
    })
  }
  setTimeout(quitCleanly, mode === 'delayed-clean' ? 450 : 25)
}).catch(() => app.exit(70))
