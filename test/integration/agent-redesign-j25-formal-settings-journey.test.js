'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const electron = require('electron')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const FIXTURE = path.join(PROJECT_ROOT, 'scripts', 'fixtures', 'formal-agent-j25-settings-journey.js')

function waitForExit (child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('formal J25 settings journey timed out'))
    }, timeoutMs)
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
    })
  })
}

test('SEM-F31/SEM-F33/SEM-F34/J25: formal settings → Agent Bar run → history uses one production IPC/SQLite path', { timeout: 90000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-j25-formal-settings-'))
  const userData = path.join(root, 'user-data')
  fs.mkdirSync(userData, { recursive: true })
  const child = spawn(electron, ['--disable-gpu', '--disable-gpu-compositing', '--disable-software-rasterizer', '--in-process-gpu', FIXTURE], {
    cwd: PROJECT_ROOT,
    windowsHide: true,
    env: {
      ...process.env,
      J25_FORMAL_USER_DATA: userData,
      ELECTRON_DISABLE_LOGGING: 'true'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  try {
    const result = await waitForExit(child, 75000)
    assert.deepEqual({ code: result.code, signal: result.signal }, { code: 0, signal: null }, result.stderr.slice(-4000))
    const reportLine = result.stdout.trim().split(/\r?\n/).find((line) => line.startsWith('{"schemaVersion":1'))
    assert.ok(reportLine, `formal J25 report missing: ${result.stdout.slice(-1000)}`)
    const report = JSON.parse(reportLine)
    assert.equal(report.result, true, JSON.stringify(report))
    assert.equal(report.settingsPath, 'formal-settings-renderer-preload')
    assert.equal(report.runPath, 'formal-agent-bar-renderer-preload-main')
    assert.equal(report.historyPath, 'formal-agent-history-renderer-preload-main')
    assert.equal(report.providerRequestCount, 1)
    assert.equal(report.providerCredentialObserved, true)
    assert.equal(report.modelIdentityObserved, true)
    assert.equal(report.transcriptAndPromptAbsentFromReport, true)
    assert.equal(report.publicProvider, false)
    assert.equal(report.systemCredential, false)
    assert.equal(/j25-local-provider-secret|请回答这场会的重点|受控正式设置/.test(reportLine), false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
