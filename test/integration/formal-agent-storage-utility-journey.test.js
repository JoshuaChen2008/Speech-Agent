'use strict'

const assert = require('node:assert/strict')
const childProcess = require('node:child_process')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { DatabaseSync } = require('node:sqlite')

const electronPath = require('electron')
const root = path.resolve(__dirname, '..', '..')
const mainPath = path.join(root, 'scripts', 'formal-agent-storage-utility-smoke.js')
const REPORT_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'result', 'checks', 'metrics', 'identityHash', 'scope', 'privacy'
].sort())
const CHECK_KEYS = Object.freeze([
  'threeJobsReconciled',
  'meetingStoppedDetached',
  'nextSessionStartedBeforeNotificationRecovery',
  'disabledAndEmptySessionsSkipped',
  'duplicateMeetingStoppedCoalesced',
  'invalidPolicyFailsClosed',
  'notificationFailureDeferred',
  'notificationFailureChildReaped',
  'exactChildReaped',
  'replacementBlockedBeforePolicy',
  'taskPolicyReplayedBeforeRecovery',
  'duplicateReconciliationIdempotent',
  'sameRunRecovered',
  'taskIdentityStable',
  'independentResultsCommitted',
  'noDuplicateClaims',
  'artifactProjectionExact',
  'pluginTaskClosureExact',
  'eligibilityContextExact',
  'captionFactsPreserved',
  'gracefulExactExit'
].sort())
const TRANSCRIPT_FRAGMENTS = Object.freeze([
  'D12 synthetic committed transcript before Agent enable',
  'D12 synthetic committed transcript first',
  'D12 synthetic committed transcript second',
  'synthetic utility transport overview',
  'synthetic utility decision',
  'synthetic enhanced utility transcript'
])
const PROVIDER_URL = 'https://api.deepseek.com'
const LOCAL_ABSOLUTE_PATH = /(?:^|[^A-Za-z])(?:[A-Za-z]:[\\/]|file:\/\/\/|\\\\(?:\?\\)?[^\\/\s]+[\\/][^\s"']+)/i
const RAW_ERROR_OR_STACK = /\b(?:Error|[A-Za-z]+Error):[^\r\n]*|(?:\r?\n|\\n)\s*at\s+(?:async\s+)?[^\r\n]+/im
const AUDIO_PATH = /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)(?![A-Za-z0-9])/i

function assertPrivateProjection (value, dataRoot) {
  const projection = String(value)
  assert.equal(projection.includes(dataRoot), false)
  for (const fragment of TRANSCRIPT_FRAGMENTS) assert.equal(projection.includes(fragment), false)
  assert.doesNotMatch(projection, LOCAL_ABSOLUTE_PATH)
  assert.doesNotMatch(projection, RAW_ERROR_OR_STACK)
  assert.doesNotMatch(projection, AUDIO_PATH)
}

function runJourney (dataRoot) {
  return new Promise((resolve, reject) => {
    const credentialCanary = crypto.randomBytes(24).toString('hex')
    const child = childProcess.spawn(electronPath, [
      '--disable-gpu',
      mainPath,
      '--data-root',
      dataRoot
    ], {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        DEEPSEEK_API_KEY: credentialCanary,
        ELECTRON_DISABLE_LOGGING: 'true'
      }
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      child.kill()
    }, 30000)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (timedOut) return reject(new Error('formal Agent storage utility journey timed out after exact child exit'))
      const line = stdout.split(/\r?\n/).find((value) =>
        value.startsWith('{"schemaVersion":1,"kind":"formal-agent-storage-utility-journey"')
      )
      if (!line) return reject(new Error('formal Agent storage utility report is missing'))
      let report
      try { report = JSON.parse(line) } catch (error) { return reject(error) }
      if (code !== 0) return reject(new Error(`formal Agent storage utility journey exited ${code} at ${report.failurePhase || 'unknown'}`))
      resolve({ report, stdout, stderr, credentialCanary })
    })
  })
}

function listFiles (directory) {
  const result = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) result.push(...listFiles(target))
    else if (entry.isFile()) result.push(target)
  }
  return result
}

test('SEM-F14 / J24-B30 D6 report privacy reader rejects transcript, path, raw error and audio classes', () => {
  const dataRoot = path.join(os.tmpdir(), 'formal-agent-utility-private-canary')
  for (const value of [
    TRANSCRIPT_FRAGMENTS[0],
    `${dataRoot}\\data`,
    'TypeError: private failure',
    '\n    at privateFrame (formal-agent-storage-utility-smoke.js:1:1)',
    'capture.wav'
  ]) assert.throws(() => assertPrivateProjection(value, dataRoot))
  assert.doesNotThrow(() => assertPrivateProjection(
    '{"result":"pass","identityHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}',
    dataRoot
  ))
})

test('SEM-F00/F09/F12/F16/F28 / D6/D10/D12/J7/J24-B01/B04/B25/B26/B33 commits then reconciles registry-backed tasks once', { timeout: 40000 }, async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-agent-storage-utility-'))
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }))

  const { report, stdout, stderr, credentialCanary } = await runJourney(dataRoot)
  assert.deepEqual(Object.keys(report).sort(), REPORT_KEYS)
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.kind, 'formal-agent-storage-utility-journey')
  assert.equal(report.result, 'pass')
  assert.deepEqual(Object.keys(report.checks).sort(), CHECK_KEYS)
  assert.equal(Object.values(report.checks).every((value) => value === true), true)
  assert.deepEqual(report.metrics, {
    storageGenerationCount: 3,
    jobCount: 3,
    artifactCount: 2,
    memoryCommitCount: 1,
    providerCallCount: 3,
    recoveredAttemptCount: 2
  })
  assert.match(report.identityHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(report.scope, {
    storageUtilityProcess: true,
    agentUtilityProcess: false,
    meetingStoppedWiring: true,
    meetingStoppedStorageGatewayWiring: true,
    agentJobRunnerStorageGatewayWiring: false,
    preloadIpcRenderer: false,
    packagedRuntime: false
  })
  assert.deepEqual(report.privacy, {
    noBrowserWindowCreated: true,
    browserWindowCount: 0,
    reportContainsTranscriptText: false,
    reportContainsAbsolutePath: false,
    persistedAudio: false,
    audioFileCount: 0
  })
  assertPrivateProjection(JSON.stringify(report), dataRoot)
  assertPrivateProjection(stdout, dataRoot)
  assertPrivateProjection(stderr, dataRoot)
  assert.equal(JSON.stringify(report).includes(credentialCanary), false)
  assert.equal(stdout.includes(credentialCanary), false)
  assert.equal(stderr.includes(credentialCanary), false)

  const files = listFiles(dataRoot)
  assert.equal(files.some((file) => AUDIO_PATH.test(path.basename(file))), false)
  for (const file of files) {
    assert.equal(fs.readFileSync(file).includes(Buffer.from(credentialCanary)), false)
    assert.equal(fs.readFileSync(file).includes(Buffer.from(PROVIDER_URL)), false)
  }
  const config = JSON.parse(fs.readFileSync(path.join(dataRoot, 'data', 'config.json'), 'utf8'))
  assert.equal(Object.hasOwn(config, 'providerId'), false)
  assert.equal(Object.hasOwn(config, 'model'), false)
  assert.equal(Object.hasOwn(config, 'baseUrl'), false)
  assert.equal(Object.hasOwn(config, 'apiKey'), false)
  const smokeSource = fs.readFileSync(mainPath, 'utf8')
  assert.doesNotMatch(smokeSource, /new\s+BrowserWindow\s*\(/)
  assert.match(smokeSource, /BrowserWindow\.getAllWindows\(\)/)
  const databasePath = path.join(dataRoot, 'data', 'speech-agent.sqlite3')
  assert.equal(files.includes(databasePath), true)

  const database = new DatabaseSync(databasePath, { readOnly: true })
  try {
    const jobs = database.prepare(`
      SELECT run_id, plugin_id, state, attempt_count, input_digest
      FROM agent_jobs ORDER BY job_order
    `).all()
    assert.deepEqual(jobs.map((job) => ({
      taskKind: job.plugin_id,
      state: job.state,
      attemptCount: Number(job.attempt_count)
    })), [
      { taskKind: 'meeting-minutes', state: 'succeeded', attemptCount: 2 },
      { taskKind: 'memory-extraction', state: 'succeeded', attemptCount: 1 },
      { taskKind: 'enhanced-transcript', state: 'succeeded', attemptCount: 1 }
    ])
    assert.equal(new Set(jobs.map((job) => job.run_id)).size, 3)
    assert.equal(new Set(jobs.map((job) => job.input_digest)).size, 1)
    assert.deepEqual(database.prepare(`
      SELECT type, COUNT(*) AS count FROM agent_artifacts GROUP BY type ORDER BY type
    `).all().map((row) => ({ type: row.type, count: Number(row.count) })), [
      { type: 'enhanced-transcript', count: 1 },
      { type: 'meeting-minutes', count: 1 }
    ])
    assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM memory_items').get().count), 1)
    assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM memory_evidence').get().count), 1)
    assert.equal(Number(database.prepare('SELECT COUNT(*) AS count FROM caption_events').get().count), 3)
    const storageColumns = database.prepare(`
      SELECT schema.name AS table_name, columns.name AS column_name
      FROM sqlite_schema AS schema
      JOIN pragma_table_info(schema.name) AS columns
      WHERE schema.type = 'table'
    `).all()
    assert.equal(storageColumns.some((column) =>
      /(?:^|_)(?:audio|pcm|recording|samples?|wav|waveform|device)(?:_|$)/i.test(column.column_name)
    ), false)
    const independentIdentityHash = crypto.createHash('sha256').update(JSON.stringify({
      inputDigest: jobs[0].input_digest,
      runIds: jobs.map((job) => job.run_id).sort()
    })).digest('hex')
    assert.equal(report.identityHash, independentIdentityHash)
  } finally {
    database.close()
  }
})
