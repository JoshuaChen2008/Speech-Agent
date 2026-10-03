'use strict'
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const path = require('node:path')
const test = require('node:test')

test('SEM-F23/J18/J22: production Agent date and question layouts remain aligned across themes and sizes', { timeout: 45000 }, async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.AGENT_LAYOUT_INTERACTIVE
  const child = spawn(require('electron'), [path.resolve(__dirname, '../../scripts/fixtures/agent-layout-app.js')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
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
