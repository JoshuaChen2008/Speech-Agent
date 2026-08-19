'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const electronExecutable = require('electron')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const FIXTURE = path.join(PROJECT_ROOT, 'scripts', 'fixtures', 'renderer-development-entry-app.js')
const RESTART_COUNT = 4

function waitForExit (child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('renderer development fixture timed out'))
    }, timeoutMs)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal })
    })
  })
}

test('SEM-F23/J18 four repeated Vite development starts initialize the caption and toolbar renderers', { timeout: 60000 }, async () => {
  const { createServer } = await import('vite')
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'renderer-development-entry-'))
  const server = await createServer({
    configFile: path.join(PROJECT_ROOT, 'vite.config.mts'),
    logLevel: 'silent',
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      hmr: false
    }
  })
  let child = null
  try {
    await server.listen()
    const environment = {
      ...process.env,
      RENDERER_DEVELOPMENT_FIXTURE_ORIGIN: 'http://127.0.0.1:5173',
      RENDERER_DEVELOPMENT_FIXTURE_USER_DATA: path.join(workDirectory, 'user-data')
    }
    delete environment.ELECTRON_RUN_AS_NODE
    for (let restart = 1; restart <= RESTART_COUNT; restart += 1) {
      child = spawn(electronExecutable, [FIXTURE], {
        cwd: PROJECT_ROOT,
        env: environment,
        stdio: 'ignore',
        windowsHide: true
      })
      const result = await waitForExit(child, 15000)
      assert.deepEqual(result, { code: 0, signal: null }, `development start ${restart} failed`)
      child = null
    }
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    await server.close()
    fs.rmSync(workDirectory, { recursive: true, force: true })
  }
})
