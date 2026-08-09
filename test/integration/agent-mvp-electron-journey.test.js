'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const electronPath = require('electron')
const mainPath = path.join(__dirname, '../../src/agent-mvp/main.js')
const reportKeys = [
  'schemaVersion', 'result', 'scenario', 'phase', 'sessionCount', 'messageCount', 'jobCount', 'artifactCount',
  'toolEventCount', 'attemptCount', 'succeededCount', 'failedCount', 'cancelledCount', 'identityHash',
  'credentialAvailable', 'credentialPersisted', 'rendererReloaded', 'agentUtilityReplaced', 'storageUtilityPreserved',
  'transcriptInReport', 'audioPersisted', 'credentialInReport', 'internalThoughtInReport', 'localPathInReport'
].sort()
const SYNTHETIC_TRANSCRIPT_FRAGMENTS = [
  '这是隔离 Agent 内核',
  '合成终态会话',
  '本会话不包含现场音频',
  '固定工具与结构化产物'
]
const LOCAL_ABSOLUTE_PATH = /(?:^|[^A-Za-z])(?:[A-Za-z]:[\\/]|file:\/\/\/|\\\\(?:\?\\)?[^\\/\s]+[\\/][^\s"']+)/i
const RAW_ERROR_OR_STACK = /\b(?:Error|[A-Za-z]+Error):[^\r\n]*|(?:\r?\n|\\n)\s*at\s+(?:async\s+)?[^\r\n]+/im
const AUDIO_PATH = /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)(?![A-Za-z0-9])/i
const INTERNAL_THOUGHT = /hidden reasoning|internal thought|chain[- ]of[- ]thought|scratchpad|hidden prompt/i

function runPhase (userData, scenario, phase, expectedExitCode = 0) {
  return new Promise((resolve, reject) => {
    const privacyCanary = crypto.randomBytes(24).toString('hex')
    const thoughtCanary = crypto.randomBytes(24).toString('hex')
    const child = childProcess.spawn(electronPath, ['--disable-gpu', mainPath], {
      cwd: path.join(__dirname, '../..'),
      windowsHide: true,
      env: {
        ...process.env,
        AGENT_MVP_SMOKE: '1',
        AGENT_MVP_SMOKE_SCENARIO: scenario,
        AGENT_MVP_SMOKE_PHASE: phase,
        AGENT_MVP_USER_DATA: userData,
        AGENT_MVP_SMOKE_CREDENTIAL: privacyCanary,
        AGENT_MVP_SMOKE_THOUGHT: thoughtCanary,
        ELECTRON_DISABLE_LOGGING: 'true'
      }
    })
    let stdout = ''; let stderr = ''; let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      reject(new Error(`Agent MVP Electron ${scenario}/${phase} timed out`))
    }, 30000)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.once('error', (error) => {
      if (settled) return
      settled = true; clearTimeout(timer); reject(error)
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      if (code !== expectedExitCode) return reject(new Error(`Agent MVP Electron ${scenario}/${phase} exited ${code}: ${stdout.slice(-500)} ${stderr.slice(-500)}`))
      const line = stdout.split(/\r?\n/).find((value) => value.trim().startsWith('{"schemaVersion":2'))
      if (!line) return reject(new Error(`Agent MVP Electron ${scenario}/${phase} report is missing`))
      try { resolve({ report: JSON.parse(line), stdout, stderr, privacyCanary, thoughtCanary }) } catch (error) { reject(error) }
    })
  })
}

function assertStrictPrivateText (value, { forbiddenValues = [], forbidTranscript = false } = {}) {
  const projection = Buffer.isBuffer(value) ? value.toString('latin1') : String(value)
  for (const forbidden of forbiddenValues) assert.equal(projection.includes(forbidden), false)
  if (forbidTranscript) for (const fragment of SYNTHETIC_TRANSCRIPT_FRAGMENTS) assert.equal(projection.includes(fragment), false)
  assert.doesNotMatch(projection, LOCAL_ABSOLUTE_PATH)
  assert.doesNotMatch(projection, RAW_ERROR_OR_STACK)
  assert.doesNotMatch(projection, AUDIO_PATH)
  assert.doesNotMatch(projection, INTERNAL_THOUGHT)
}

function assertPrivateReport ({ report, stdout, stderr, privacyCanary, thoughtCanary }, scenario, phase) {
  assert.deepEqual(Object.keys(report).sort(), reportKeys)
  assert.equal(report.schemaVersion, 2)
  assert.equal(report.result, 'pass')
  assert.equal(report.scenario, scenario)
  assert.equal(report.phase, phase)
  assert.equal(report.transcriptInReport, false)
  assert.equal(report.audioPersisted, false)
  assert.equal(report.credentialInReport, false)
  assert.equal(report.internalThoughtInReport, false)
  assert.equal(report.localPathInReport, false)
  if (report.identityHash !== null) assert.match(report.identityHash, /^[a-f0-9]{64}$/)
  assertStrictPrivateText(JSON.stringify(report), { forbiddenValues: [privacyCanary, thoughtCanary], forbidTranscript: true })
  assertStrictPrivateText(`${stdout}\n${stderr}`, { forbiddenValues: [privacyCanary, thoughtCanary], forbidTranscript: true })
}

function privateFiles (root) {
  const files = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (entry.isFile()) files.push(target)
    }
  }
  visit(root)
  return files
}

function assertProductFilesPrivate (root, forbiddenValues = []) {
  const controlled = privateFiles(root).filter((file) => {
    const relative = path.relative(root, file).replace(/\\/g, '/')
    return /^agent-mvp(?:\.sqlite(?:-wal|-shm)?|-settings\.json)$/.test(relative) || relative.startsWith('agent-diagnostics/') || relative === 'agent-provider.credential'
  })
  for (const file of controlled) {
    const bytes = fs.readFileSync(file)
    for (const value of [root, ...forbiddenValues]) assert.equal(bytes.includes(Buffer.from(value)), false)
    assertStrictPrivateText(bytes, { forbiddenValues: [root, ...forbiddenValues] })
  }
}

function privateCanaries (...runs) {
  return runs.flatMap((run) => [run.privacyCanary, run.thoughtCanary])
}

test('SEM-F29 / J23-B16 strict privacy reader rejects sensitive payload classes instead of trusting report flags', () => {
  const canary = crypto.randomBytes(24).toString('hex')
  for (const value of [
    `credential=${canary}`,
    `path:C:\\private\\agent.db`,
    'path="D:\\private\\agent.db"',
    'file:///D:/private/agent.db',
    '{"message":"Error: private failure"}',
    'TypeError: private failure',
    '\n    at privateFrame (runtime-host.js:1:1)',
    '{"stack":"Error: private\\n    at privateFrame (runtime-host.js:1:1)"}',
    'capture.wav,',
    'hidden reasoning',
    SYNTHETIC_TRANSCRIPT_FRAGMENTS[0]
  ]) {
    assert.throws(() => assertStrictPrivateText(value, { forbiddenValues: [canary], forbidTranscript: true }))
  }
  assert.doesNotThrow(() => assertStrictPrivateText('{"result":"pass","provider":"https://provider.invalid/v1"}', { forbiddenValues: [canary], forbidTranscript: true }))
})

test('SEM-F29 / J23-B01 real React, preload, exact IPC, utility processes and SQLite restore the successful run', { timeout: 45000 }, async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mvp-happy-'))
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }))

  const first = await runPhase(userData, 'happy-restart', 'first')
  const restart = await runPhase(userData, 'happy-restart', 'restart')
  assertPrivateReport(first, 'happy-restart', 'first')
  assertPrivateReport(restart, 'happy-restart', 'restart')
  for (const value of [first.report, restart.report]) {
    assert.equal(value.sessionCount, 1)
    assert.equal(value.messageCount, 5)
    assert.equal(value.jobCount, 1)
    assert.equal(value.artifactCount, 1)
    assert.equal(value.attemptCount, 1)
    assert.equal(value.succeededCount, 1)
    assert.equal(value.failedCount, 0)
    assert.equal(value.cancelledCount, 0)
  }
  assert.equal(first.report.toolEventCount > 0, true)
  assert.equal(first.report.credentialAvailable, true)
  assert.equal(restart.report.credentialAvailable, first.report.credentialPersisted)
  assert.equal(restart.report.credentialPersisted, first.report.credentialPersisted)
  assert.equal(restart.report.identityHash, first.report.identityHash)
  assertProductFilesPrivate(userData, privateCanaries(first, restart))
})

test('SEM-F29 / J23-B02–B10/B13/B14 real renderer matrix closes claim races, provider classes, denied capabilities and idempotent replay', { timeout: 45000 }, async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mvp-boundary-'))
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }))

  const result = await runPhase(userData, 'boundary-matrix', 'matrix')
  assertPrivateReport(result, 'boundary-matrix', 'reload')
  assert.equal(result.report.sessionCount, 1)
  assert.equal(result.report.messageCount, 39)
  assert.equal(result.report.jobCount, 16)
  assert.equal(result.report.artifactCount, 5)
  assert.equal(result.report.toolEventCount > 0, true)
  assert.equal(result.report.attemptCount, 18)
  assert.equal(result.report.succeededCount, 5)
  assert.equal(result.report.failedCount, 8)
  assert.equal(result.report.cancelledCount, 3)
  assert.equal(result.report.rendererReloaded, true)
  assertProductFilesPrivate(userData, privateCanaries(result))
})

test('SEM-F29 / J23-B11 hard interruption recovers the same runId only after lease expiry', { timeout: 45000 }, async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mvp-interruption-'))
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }))

  const interrupted = await runPhase(userData, 'interruption-recovery', 'interrupt', 86)
  const recovered = await runPhase(userData, 'interruption-recovery', 'recover')
  assertPrivateReport(interrupted, 'interruption-recovery', 'interrupt')
  assertPrivateReport(recovered, 'interruption-recovery', 'recover')
  assert.equal(interrupted.report.jobCount, 1)
  assert.equal(interrupted.report.artifactCount, 0)
  assert.equal(interrupted.report.attemptCount, 1)
  assert.equal(recovered.report.jobCount, 1)
  assert.equal(recovered.report.artifactCount, 1)
  assert.equal(recovered.report.attemptCount, 2)
  assert.equal(recovered.report.succeededCount, 1)
  assert.equal(recovered.report.identityHash, interrupted.report.identityHash)
  assertProductFilesPrivate(userData, privateCanaries(interrupted, recovered))
})

test('SEM-F29 / J23-B12 Agent utility replacement preserves storage utility and run identity', { timeout: 45000 }, async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mvp-worker-'))
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }))

  const result = await runPhase(userData, 'worker-replacement', 'replace')
  assertPrivateReport(result, 'worker-replacement', 'recovered')
  assert.equal(result.report.jobCount, 1)
  assert.equal(result.report.artifactCount, 1)
  assert.equal(result.report.attemptCount, 2)
  assert.equal(result.report.succeededCount, 1)
  assert.equal(result.report.agentUtilityReplaced, true)
  assert.equal(result.report.storageUtilityPreserved, true)
  assertProductFilesPrivate(userData, privateCanaries(result))
})

test('SEM-F29 / J23-B15/B16 safeStorage-unavailable credentials stay in one process and evidence stays private', { timeout: 45000 }, async (t) => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mvp-credential-'))
  t.after(() => fs.rmSync(userData, { recursive: true, force: true }))

  const first = await runPhase(userData, 'credential-session-only', 'first')
  const restart = await runPhase(userData, 'credential-session-only', 'restart')
  assertPrivateReport(first, 'credential-session-only', 'first')
  assertPrivateReport(restart, 'credential-session-only', 'restart')
  assert.equal(first.report.credentialAvailable, true)
  assert.equal(first.report.credentialPersisted, false)
  assert.equal(restart.report.credentialAvailable, false)
  assert.equal(restart.report.credentialPersisted, false)
  assert.equal(fs.existsSync(path.join(userData, 'agent-provider.credential')), false)
  assertProductFilesPrivate(userData, privateCanaries(first, restart))
  for (const file of privateFiles(userData)) {
    const bytes = fs.readFileSync(file)
    assert.equal(bytes.includes(Buffer.from(first.privacyCanary)), false)
    assert.equal(bytes.includes(Buffer.from(first.thoughtCanary)), false)
    assert.doesNotMatch(path.basename(file), /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)$/i)
  }
})
