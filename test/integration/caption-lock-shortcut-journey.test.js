'use strict'
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const test = require('node:test')
const { ConfigStore } = require('../../src/main/services/config-store')

test('SEM-F22/SEM-F23/SEM-T04/J17-SHORTCUT: production settings records right Alt, cancels safely, disables and reopens with the same preference', { timeout: 60000 }, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'caption-shortcut-journey-'))
  t.after(() => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
    assert.equal(path.basename(directory).startsWith('caption-shortcut-journey-'), true)
    fs.rmSync(directory, { recursive: true, force: true })
  })
  const store = new ConfigStore(path.join(directory, 'config.json')); store.load(); store.applyPreset('meeting')
  for (const reopen of [false, true]) {
    const env = { ...process.env, CAPTION_SHORTCUT_JOURNEY_DATA: directory }
    delete env.ELECTRON_RUN_AS_NODE
    if (reopen) env.CAPTION_SHORTCUT_JOURNEY_REOPEN = '1'
    else delete env.CAPTION_SHORTCUT_JOURNEY_REOPEN
    const child = spawn(require('electron'), [path.resolve(__dirname, '../../scripts/fixtures/caption-lock-shortcut-journey.js')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', data => { output = (output + data).slice(-5000) }); child.stderr.on('data', data => { output = (output + data).slice(-5000) })
    const timer = setTimeout(() => child.kill(), 25000)
    try {
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
      assert.equal(code, 0, output)
      assert.match(output, reopen ? /CAPTION_SHORTCUT_REOPEN_OK/ : /CAPTION_SHORTCUT_JOURNEY_OK/)
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill() }
  }
})
