'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

test('SEM-F28/F33/SEM-T15/J22/J24: locked Pi ESM runs in Electron main and utility process', { timeout: 30000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-core-electron-'))
  const environment = { ...process.env }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), ['--disable-gpu', path.resolve(__dirname,
    '../../scripts/fixtures/pi-core-qualification.js'), directory], { windowsHide: true,
    env: environment, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { child.kill(); fs.rmSync(directory, { recursive: true, force: true }) })
  let output = ''; let errors = ''
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { errors += data })
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Pi Electron qualification timed out')) }, 25000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
  })
  assert.deepEqual(result, { code: 0, signal: null }, errors.slice(-2000))
  const report = JSON.parse(output.trim().split(/\r?\n/u).find(line => line.startsWith('{')))
  assert.deepEqual(report, { requests: 2, tools: 2, turns: 2, peakTools: 1,
    cancelledTools: 1, cancelledRequests: 1, failedRequests: 1 })
})
