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
  'schemaVersion', 'kind', 'phase', 'result', 'checks', 'metrics', 'identityHash', 'scope', 'privacy'
].sort())
const INITIAL_CHECK_KEYS = Object.freeze([
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
  'taskPolicyReplayedBeforeUtility',
  'agentUtilityTaskClosureExact',
  'agentUtilityProviderResultObserved',
  'agentUtilityExitChildReaped',
  'utilityExitRetriedSameRun',
  'credentialInvalidated',
  'sameProcessClaimBlocked',
  'noPartialArtifact',
  'taskIdentityStable',
  'eligibilityContextExact',
  'captionFactsPreserved',
  'gracefulStorageExit'
].sort())
const RECOVERY_CHECK_KEYS = Object.freeze([
  'freshStartupCredentialAvailable',
  'taskPolicyReplayedBeforeRecovery',
  'runnerCommitReplacementChildReaped',
  'runnerCommitReplayedThroughGateway',
  'runnerReplacementBlockedBeforePolicy',
  'sameRunRecovered',
  'taskIdentityStable',
  'independentResultsCommitted',
  'memoryReadThroughGateway',
  'noDuplicateClaims',
  'artifactProjectionExact',
  'agentUtilityTaskClosureExact',
  'eligibilityContextExact',
  'captionFactsPreserved',
  'gracefulAgentUtilityExit',
  'gracefulStorageExit'
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

function runPhase (dataRoot, phase) {
  return new Promise((resolve, reject) => {
    const credentialCanary = crypto.randomBytes(24).toString('hex')
    const child = childProcess.spawn(electronPath, [
      '--disable-gpu',
      mainPath,
      '--data-root',
      dataRoot,
      '--phase',
      phase
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
    }, 40000)
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
      if (timedOut) return reject(new Error(`formal Agent utility ${phase} phase timed out`))
      const line = stdout.split(/\r?\n/).find((value) =>
        value.startsWith('{"schemaVersion":1,"kind":"formal-agent-storage-utility-journey"')
      )
      if (!line) return reject(new Error(`formal Agent utility ${phase} report is missing`))
      let report
      try { report = JSON.parse(line) } catch (error) { return reject(error) }
      if (code !== 0) {
        return reject(new Error(`formal Agent utility ${phase} exited ${code} at ${report.failurePhase || 'unknown'}`))
      }
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

function assertReportEnvelope (report, phase, checkKeys) {
  assert.deepEqual(Object.keys(report).sort(), REPORT_KEYS)
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.kind, 'formal-agent-storage-utility-journey')
  assert.equal(report.phase, phase)
  assert.equal(report.result, 'pass')
  assert.deepEqual(Object.keys(report.checks).sort(), checkKeys)
  assert.equal(Object.values(report.checks).every((value) => value === true), true)
  assert.match(report.identityHash, /^[a-f0-9]{64}$/)
  assert.deepEqual(report.scope, {
    storageUtilityProcess: true,
    agentUtilityProcess: true,
    meetingStoppedWiring: true,
    meetingStoppedStorageGatewayWiring: true,
    agentJobRunnerStorageGatewayWiring: true,
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

test('SEM-F00/F09/F12/F16/F25/F28/SEM-T15 / D6/D10/D12/D13/D14/J7/J24-B01/B04/B05/B06/B07/B14/B23/B25/B26/B30/B33 routes formal tasks through exact utility generations', { timeout: 90000 }, async (t) => {
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'formal-agent-storage-utility-'))
  t.after(() => fs.rmSync(dataRoot, { recursive: true, force: true }))

  const initial = await runPhase(dataRoot, 'initial')
  const recovery = await runPhase(dataRoot, 'recovery')
  assertReportEnvelope(initial.report, 'initial', INITIAL_CHECK_KEYS)
  assertReportEnvelope(recovery.report, 'recovery', RECOVERY_CHECK_KEYS)
  assert.deepEqual(initial.report.metrics, {
    storageGenerationCount: 3,
    agentUtilityGenerationCount: 1,
    jobCount: 3,
    artifactCount: 0,
    memoryCommitCount: 0,
    providerResultCount: 1,
    recoveredAttemptCount: 2
  })
  assert.deepEqual(recovery.report.metrics, {
    storageGenerationCount: 2,
    agentUtilityGenerationCount: 1,
    jobCount: 3,
    artifactCount: 2,
    memoryCommitCount: 1,
    providerResultCount: 3,
    recoveredAttemptCount: 3
  })
  assert.equal(initial.report.identityHash, recovery.report.identityHash)
  assert.equal(initial.report.metrics.storageGenerationCount + recovery.report.metrics.storageGenerationCount, 5)
  assert.equal(initial.report.metrics.agentUtilityGenerationCount + recovery.report.metrics.agentUtilityGenerationCount, 2)
  assert.equal(initial.report.metrics.providerResultCount + recovery.report.metrics.providerResultCount, 4)

  for (const execution of [initial, recovery]) {
    assertPrivateProjection(JSON.stringify(execution.report), dataRoot)
    assertPrivateProjection(execution.stdout, dataRoot)
    assertPrivateProjection(execution.stderr, dataRoot)
    for (const canary of [initial.credentialCanary, recovery.credentialCanary]) {
      assert.equal(JSON.stringify(execution.report).includes(canary), false)
      assert.equal(execution.stdout.includes(canary), false)
      assert.equal(execution.stderr.includes(canary), false)
    }
  }

  const files = listFiles(dataRoot)
  assert.equal(files.some((file) => AUDIO_PATH.test(path.basename(file))), false)
  for (const file of files) {
    const bytes = fs.readFileSync(file)
    assert.equal(bytes.includes(Buffer.from(initial.credentialCanary)), false)
    assert.equal(bytes.includes(Buffer.from(recovery.credentialCanary)), false)
    assert.equal(bytes.includes(Buffer.from(PROVIDER_URL)), false)
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
      { taskKind: 'meeting-minutes', state: 'succeeded', attemptCount: 3 },
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
    assert.equal(recovery.report.identityHash, independentIdentityHash)
  } finally {
    database.close()
  }
})
