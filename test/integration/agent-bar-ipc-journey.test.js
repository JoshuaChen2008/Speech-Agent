'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const electronExecutable = require('electron')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const FIXTURE = path.join(PROJECT_ROOT, 'scripts', 'fixtures', 'agent-bar-ipc-journey-app.js')

function waitForExit (child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('Agent Bar IPC journey timed out'))
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

test('SEM-F00/SEM-F31/SEM-F34/J22/J24: production renderer, preload, exact IPC and storage worker keep Agent optional and subtitles independent', { timeout: 60000 }, async () => {
  const { createServer } = await import('vite')
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bar-ipc-journey-'))
  const server = await createServer({
    configFile: path.join(PROJECT_ROOT, 'vite.config.mts'),
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 5173, strictPort: true, hmr: false }
  })
  let child = null
  let stdout = ''
  let stderr = ''
  try {
    await server.listen()
    const environment = {
      ...process.env,
      AGENT_BAR_JOURNEY_ORIGIN: 'http://127.0.0.1:5173',
      AGENT_BAR_JOURNEY_USER_DATA: path.join(workDirectory, 'user-data')
    }
    delete environment.ELECTRON_RUN_AS_NODE
    child = spawn(electronExecutable, [
      '--disable-gpu', '--disable-gpu-compositing', '--disable-software-rasterizer',
      '--in-process-gpu', '--password-store=basic', FIXTURE
    ], {
      cwd: PROJECT_ROOT,
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    })
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    const result = await waitForExit(child, 30000)
    assert.deepEqual(result, { code: 0, signal: null }, stderr.slice(-1000))
    const report = JSON.parse(stdout.trim().split(/\r?\n/).at(-1))
    assert.deepEqual(report, {
      schemaVersion: 1,
      result: 'pass',
      toolbarAgentEntry: true,
      agentOpenCount: 1,
      agentFocusObserved: true,
      agentClosed: true,
      providerEligibilityObserved: true,
      subtitleLifecycleStarted: true,
      subtitleLifecycleStopped: true,
      subtitleWindowAlive: true,
      subtitleSessionCount: 1,
      subtitlePageItems: 1,
      subtitleExportBytes: report.subtitleExportBytes,
      subtitleExportSha256: report.subtitleExportSha256
    })
    assert.equal(typeof report.subtitleExportBytes, 'number')
    assert.match(report.subtitleExportSha256, /^[a-f0-9]{64}$/)
    child = null
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill()
    await server.close()
    fs.rmSync(workDirectory, { recursive: true, force: true })
  }
})
