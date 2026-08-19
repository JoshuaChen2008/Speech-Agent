'use strict'

const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const origin = process.env.RENDERER_DEVELOPMENT_FIXTURE_ORIGIN
const userData = process.env.RENDERER_DEVELOPMENT_FIXTURE_USER_DATA

if (origin !== 'http://127.0.0.1:5173' ||
    typeof userData !== 'string' || !path.isAbsolute(userData)) {
  app.exit(64)
} else {
  app.setPath('userData', userData)
}

app.on('window-all-closed', () => {})

const readinessExpressions = Object.freeze({
  caption: `Boolean(
    window.Appearance &&
    typeof window.Appearance.applyAppearance === 'function' &&
    window.CaptionReducer &&
    typeof window.CaptionReducer.createState === 'function' &&
    document.documentElement.style.getPropertyValue('--visible-lines')
  )`,
  toolbar: `Boolean(
    window.Appearance &&
    typeof window.Appearance.applyAppearance === 'function' &&
    window.RuntimeView &&
    typeof window.RuntimeView.buildRuntimeView === 'function' &&
    window.Icons &&
    typeof window.Icons.iconMarkup === 'function' &&
    document.querySelectorAll('#commands button').length >= 1 &&
    document.querySelectorAll('#windowControls button').length === 5
  )`
})

async function waitForRendererEntry (win, expression) {
  return win.webContents.executeJavaScript(`(async () => {
    const deadline = performance.now() + 5000
    while (performance.now() < deadline) {
      if (${expression}) return true
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    return false
  })()`, true)
}

async function inspectRenderer (role, page) {
  const win = new BrowserWindow({
    width: 800,
    height: 500,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })
  let rendererGone = false
  win.webContents.once('render-process-gone', () => { rendererGone = true })
  try {
    await win.loadURL(`${origin}/${page}`)
    const initialized = await waitForRendererEntry(win, readinessExpressions[role])
    if (rendererGone || initialized !== true) throw new Error('renderer entry did not initialize')
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}

app.whenReady().then(async () => {
  await inspectRenderer('caption', 'caption/index.html')
  await inspectRenderer('toolbar', 'toolbar/index.html')
  app.exit(0)
}).catch(() => app.exit(1))
