'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const electronPath = require('electron')
const mainPath = path.join(__dirname, '../../src/agent-mvp/main.js')
const reportKeys = [
  'schemaVersion', 'result', 'phase', 'sessionCount', 'messageCount', 'jobCount', 'artifactCount',
  'toolEventCount', 'credentialAvailable', 'credentialPersisted', 'transcriptInReport', 'audioPersisted'
].sort()

function runPhase (userData, phase) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(electronPath, [mainPath], {
      cwd: path.join(__dirname, '../..'),
      windowsHide: true,
      env: { ...process.env, AGENT_MVP_SMOKE: '1', AGENT_MVP_SMOKE_PHASE: phase, AGENT_MVP_USER_DATA: userData }
    })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code !== 0) return reject(new Error(`Agent MVP Electron phase exited ${code}: ${stderr.slice(-500)}`))
      const line = stdout.split(/\r?\n/).find((value) => value.trim().startsWith('{"schemaVersion":1'))
      if (!line) return reject(new Error('Agent MVP Electron report is missing'))
      try { resolve(JSON.parse(line)) } catch (error) { reject(error) }
    })
  })
}

test('SEM-F29 / J23 real React, preload, exact IPC, utility processes and SQLite recover after restart', { timeout: 30000 }, async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mvp-electron-'))
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }))

  const first = await runPhase(userData, 'first')
  const restart = await runPhase(userData, 'restart')
  for (const [phase, report] of [['first', first], ['restart', restart]]) {
    assert.deepEqual(Object.keys(report).sort(), reportKeys)
    assert.equal(report.schemaVersion, 1)
    assert.equal(report.result, 'pass')
    assert.equal(report.phase, phase)
    assert.equal(report.sessionCount, 1)
    assert.equal(report.messageCount, 5)
    assert.equal(report.jobCount, 1)
    assert.equal(report.artifactCount, 1)
    assert.equal(typeof report.toolEventCount, 'number')
    assert.equal(typeof report.credentialAvailable, 'boolean')
    assert.equal(typeof report.credentialPersisted, 'boolean')
    assert.equal(report.transcriptInReport, false)
    assert.equal(report.audioPersisted, false)
    const serialized = JSON.stringify(report)
    assert.doesNotMatch(serialized, /[A-Za-z]:[\\/]|file:\/\/|\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)/i)
  }
  assert.equal(first.credentialAvailable, true)
  assert.equal(restart.credentialAvailable, first.credentialPersisted)
  assert.equal(restart.credentialPersisted, first.credentialPersisted)
  assert.equal(first.toolEventCount > 0, true)
  assert.equal(restart.sessionCount, first.sessionCount)
  assert.equal(restart.messageCount, first.messageCount)
  assert.equal(restart.jobCount, first.jobCount)
  assert.equal(restart.artifactCount, first.artifactCount)
})
