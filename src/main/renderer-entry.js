'use strict'

// @ts-check

const path = require('node:path')

const RENDERER_PAGES = Object.freeze({
  caption: 'caption/index.html',
  toolbar: 'toolbar/index.html',
  settings: 'settings/settings.html',
  history: 'history/index.html'
})

function validateDevServerUrl (value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('renderer development URL is invalid')
  }
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || parsed.port !== '5173' ||
      parsed.username || parsed.password || parsed.search || parsed.hash ||
      (parsed.pathname !== '/' && parsed.pathname !== '')) {
    throw new TypeError('renderer development URL must be an exact loopback origin')
  }
  return parsed.origin
}

function resolveRendererTarget (role, options = {}) {
  const page = RENDERER_PAGES[role]
  if (!page) throw new TypeError('renderer role is invalid')

  const devServerUrl = options.devServerUrl === undefined
    ? process.env.LIVE_SUBTITLE_RENDERER_URL
    : options.devServerUrl
  const isPackaged = options.isPackaged === true

  if (devServerUrl) {
    if (isPackaged) throw new Error('packaged renderer cannot use a development server')
    const origin = validateDevServerUrl(devServerUrl)
    return Object.freeze({ kind: 'url', value: `${origin}/${page}` })
  }

  const appRoot = path.resolve(options.appRoot || path.resolve(__dirname, '..', '..'))
  return Object.freeze({
    kind: 'file',
    value: path.join(appRoot, 'src', 'renderer-dist', ...page.split('/'))
  })
}

function loadRenderer (win, role, options = {}) {
  const target = resolveRendererTarget(role, options)
  return target.kind === 'url'
    ? win.loadURL(target.value)
    : win.loadFile(target.value)
}

async function loadRendererFailClosed (win, role, options = {}) {
  try {
    await loadRenderer(win, role, options)
  } catch (error) {
    if (typeof win.isDestroyed !== 'function' || !win.isDestroyed()) win.destroy()
    throw error
  }
}

module.exports = {
  RENDERER_PAGES,
  loadRenderer,
  loadRendererFailClosed,
  resolveRendererTarget,
  validateDevServerUrl
}
