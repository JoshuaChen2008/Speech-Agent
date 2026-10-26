'use strict'
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const path = require('node:path')
const test = require('node:test')

for (const deviceScaleFactor of [null, 1.25]) {
  test(`SEM-F23/J18/J22: production Agent date and question layouts remain aligned across themes and sizes (device scale ${deviceScaleFactor ?? 'system'})`, {
    // User-requested CI pause, 2026-10-26; retain local coverage and the original assertions.
    skip: process.env.GITHUB_ACTIONS === 'true' ? 'Temporarily paused in CI by user decision; J18/J22 layout remains unaccepted' : false,
    timeout: 45000
  }, async () => {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.AGENT_LAYOUT_INTERACTIVE
    const args = [path.resolve(__dirname, '../../scripts/fixtures/agent-layout-app.js')]
    if (deviceScaleFactor !== null) args.push(`--force-device-scale-factor=${deviceScaleFactor}`)
    const child = spawn(require('electron'), args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output = (output + data).slice(-3000) })
    child.stderr.on('data', data => { output = (output + data).slice(-3000) })
    const timer = setTimeout(() => child.kill(), 35000)
    try {
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
      assert.equal(code, 0, output)
      assert.match(output, /AGENT_LAYOUT_OK/)
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill() }
  })
}
