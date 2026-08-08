'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  RENDERER_PAGES,
  loadRenderer,
  loadRendererFailClosed,
  resolveRendererTarget,
  validateDevServerUrl
} = require('../../src/main/renderer-entry')

const ROOT = path.resolve(__dirname, '../..')

test('SEM-F23/J18 production renderer roles resolve only inside the Vite build root', () => {
  for (const [role, page] of Object.entries(RENDERER_PAGES)) {
    const target = resolveRendererTarget(role, {
      appRoot: ROOT,
      isPackaged: true,
      devServerUrl: ''
    })
    assert.equal(target.kind, 'file')
    assert.equal(target.value, path.join(ROOT, 'src', 'renderer-dist', ...page.split('/')))
    assert.equal(fs.existsSync(target.value), true, `${role} production page must be built before tests`)
  }
  assert.throws(() => resolveRendererTarget('audio-host', { appRoot: ROOT }), /role is invalid/)
})

test('SEM-F23/J18 development renderer accepts only an exact loopback origin', () => {
  assert.equal(validateDevServerUrl('http://127.0.0.1:5173'), 'http://127.0.0.1:5173')
  assert.equal(resolveRendererTarget('settings', {
    devServerUrl: 'http://127.0.0.1:5173',
    isPackaged: false
  }).value, 'http://127.0.0.1:5173/settings/settings.html')

  for (const value of [
    'https://127.0.0.1:5173',
    'http://127.0.0.1:5174',
    'http://localhost:5173',
    'http://127.0.0.1:5173/path',
    'http://user@127.0.0.1:5173',
    'not-a-url'
  ]) {
    assert.throws(() => validateDevServerUrl(value), /development URL/)
  }
  assert.throws(() => resolveRendererTarget('caption', {
    devServerUrl: 'http://127.0.0.1:5173',
    isPackaged: true
  }), /packaged renderer/)
})

test('SEM-F23/J18 renderer loader selects exactly one BrowserWindow load boundary', async () => {
  const calls = []
  const win = {
    loadFile: async (value) => calls.push(['file', value]),
    loadURL: async (value) => calls.push(['url', value])
  }

  await loadRenderer(win, 'history', { appRoot: ROOT, devServerUrl: '' })
  await loadRenderer(win, 'toolbar', {
    devServerUrl: 'http://127.0.0.1:5173',
    isPackaged: false
  })

  assert.deepEqual(calls, [
    ['file', path.join(ROOT, 'src', 'renderer-dist', 'history', 'index.html')],
    ['url', 'http://127.0.0.1:5173/toolbar/index.html']
  ])
})

test('SEM-F23/J18 renderer loader destroys a blank window when a production page cannot load', async () => {
  let destroyCount = 0
  const win = {
    loadFile: async () => { throw new Error('missing production bundle') },
    loadURL: async () => {},
    isDestroyed: () => false,
    destroy: () => { destroyCount += 1 }
  }

  await assert.rejects(
    loadRendererFailClosed(win, 'caption', { appRoot: ROOT, devServerUrl: '' }),
    /missing production bundle/
  )
  assert.equal(destroyCount, 1)
})

test('SEM-F23/J18 Vite manifest binds all four production renderer entries', () => {
  const manifestPath = path.join(ROOT, 'src', 'renderer-dist', 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  for (const page of Object.values(RENDERER_PAGES)) {
    const sourceName = page.replace(/\\/g, '/')
    assert.equal(Object.values(manifest).some((entry) => entry.src === sourceName && entry.isEntry === true), true,
      `${sourceName} must be a production Vite entry`)
  }
})
