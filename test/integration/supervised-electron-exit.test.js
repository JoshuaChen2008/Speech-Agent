'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const electronExecutable = require('electron')
const {
  superviseElectron,
  writeReportAtomic
} = require('../../scripts/run-supervised-electron')
const {
  readAndValidateElectronExitEvidence
} = require('../../scripts/verify-electron-exit-evidence')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const FIXTURE = path.join(PROJECT_ROOT, 'scripts', 'fixtures', 'electron-exit-evidence-app.js')
let fixtureOrdinal = 0

function allFiles (directory) {
  if (!fs.existsSync(directory)) return []
  const found = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) found.push(...allFiles(target))
    else found.push(target)
  }
  return found
}

async function runFixture (mode, overrides = {}) {
  const workDirectory = overrides.workDirectory ||
    fs.mkdtempSync(path.join(os.tmpdir(), `electron-evidence-${mode}-`))
  const reportPath = overrides.reportPath || path.join(workDirectory, 'evidence.json')
  fixtureOrdinal += 1
  const userData = path.join(workDirectory, `user-data-${fixtureOrdinal}`)
  const environment = { ...process.env, ELECTRON_EVIDENCE_FIXTURE_USER_DATA: userData }
  delete environment.ELECTRON_RUN_AS_NODE
  const report = await superviseElectron({
    executablePath: electronExecutable,
    electronMajor: 43,
    entryPath: FIXTURE,
    entryArguments: [`--mode=${mode}`],
    reportPath,
    cwd: PROJECT_ROOT,
    env: environment,
    lastAbnormalReportPath: overrides.lastAbnormalReportPath,
    reportWriter: overrides.reportWriter,
    strictReport: overrides.strictReport
  })
  return { report, reportPath, workDirectory }
}

test('exactly supervised Electron main reports a normal ready-to-will-quit lifecycle', { timeout: 30000 }, async () => {
  const { report, reportPath, workDirectory } = await runFixture('clean')
  assert.equal(report.outcome, 'clean-exit')
  assert.deepEqual(report.lifecycle, {
    mainSpawned: true,
    mainStarted: true,
    appReady: true,
    bootstrapComplete: true,
    quitRequested: true,
    willQuitObserved: true
  })
  assert.deepEqual(report.mainExit, { statusClass: 'zero', cleanIntentObserved: true })
  assert.deepEqual(report.incidents, [])
  assert.equal(readAndValidateElectronExitEvidence(reportPath).outcome, 'clean-exit')
  assert.equal(allFiles(workDirectory).some((file) => file.endsWith('.current')), false)
  assert.deepEqual(allFiles(workDirectory).filter((file) =>
    /\.(?:dmp|wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)$/i.test(file)), [])
})

test('supervisor attributes a non-zero exit to the exact Electron main child', { timeout: 30000 }, async () => {
  const { report, reportPath } = await runFixture('abnormal')
  assert.equal(report.outcome, 'abnormal-exit')
  assert.equal(report.mainExit.statusClass, 'other-nonzero')
  assert.equal(report.mainExit.cleanIntentObserved, false)
  assert.deepEqual(report.incidents, [{
    ordinal: 1,
    role: 'main',
    source: 'main-exit',
    reason: 'abnormal-exit',
    statusClass: 'other-nonzero'
  }])
  assert.deepEqual(report.attribution, {
    breakpointObserved: false,
    role: null,
    confidence: 'none'
  })
  readAndValidateElectronExitEvidence(reportPath)
})

test('exit drain retains the last lifecycle and incident sent immediately before Electron exits', { timeout: 30000 }, async () => {
  const { report, reportPath } = await runFixture('late-incident')
  assert.equal(report.lifecycle.willQuitObserved, true)
  assert.equal(report.mainExit.statusClass, 'zero')
  assert.deepEqual(report.incidents, [{
    ordinal: 1,
    role: 'storage',
    source: 'child-process-gone',
    reason: 'crashed',
    statusClass: 'breakpoint-0x80000003'
  }])
  assert.deepEqual(readAndValidateElectronExitEvidence(reportPath).attribution, {
    breakpointObserved: true,
    role: 'storage',
    confidence: 'service-name'
  })
})

test('a renderer unresponsive event makes a zero-code Electron exit abnormal', { timeout: 30000 }, async () => {
  const { report, reportPath } = await runFixture('renderer-unresponsive')
  assert.equal(report.outcome, 'abnormal-exit')
  assert.equal(report.mainExit.statusClass, 'zero')
  assert.deepEqual(report.incidents, [{
    ordinal: 1,
    role: 'renderer',
    source: 'unresponsive',
    reason: 'unresponsive',
    statusClass: 'not-observed'
  }])
  assert.equal(readAndValidateElectronExitEvidence(reportPath).outcome, 'abnormal-exit')
})

test('evidence write failure is fail-open and Electron completes its natural clean lifecycle', { timeout: 30000 }, async () => {
  const snapshots = []
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-evidence-fail-open-'))
  const reportPath = path.join(workDirectory, 'canonical.json')
  const { report } = await runFixture('clean', {
    workDirectory,
    reportPath,
    reportWriter: (_target, candidate) => {
      snapshots.push(structuredClone(candidate))
      throw new Error('simulated write failure with a private path')
    }
  })
  assert.equal(report.outcome, 'clean-exit')
  assert.deepEqual(report.lifecycle, {
    mainSpawned: true,
    mainStarted: true,
    appReady: true,
    bootstrapComplete: true,
    quitRequested: true,
    willQuitObserved: true
  })
  assert.deepEqual(report.mainExit, { statusClass: 'zero', cleanIntentObserved: true })
  assert.deepEqual(snapshots.at(-1).mainExit, report.mainExit)
  assert.equal(fs.existsSync(reportPath), false)
})

test('strict post-spawn write failure waits for natural Electron exit before rejecting', { timeout: 30000 }, async () => {
  const snapshots = []
  let writes = 0
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-evidence-strict-'))
  const reportPath = path.join(workDirectory, 'canonical.json')
  await assert.rejects(runFixture('clean', {
    workDirectory,
    reportPath,
    strictReport: true,
    reportWriter: (target, candidate) => {
      snapshots.push(structuredClone(candidate))
      writes += 1
      if (writes === 1) writeReportAtomic(target, candidate)
      else throw new Error('simulated post-spawn failure')
    }
  }), (error) => error?.code === 'E_ELECTRON_EVIDENCE_PERSISTENCE')
  const finalAttempt = snapshots.at(-1)
  assert.equal(finalAttempt.outcome, 'clean-exit')
  assert.equal(finalAttempt.lifecycle.willQuitObserved, true)
  assert.deepEqual(finalAttempt.mainExit, { statusClass: 'zero', cleanIntentObserved: true })
  assert.equal(allFiles(workDirectory).some((file) => file.endsWith('.current')), false)
})

test('current launches preserve canonical evidence and retain last abnormal independently', { timeout: 60000 }, async () => {
  const workDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-evidence-promotion-'))
  const reportPath = path.join(workDirectory, 'last-exit-evidence.json')
  const lastAbnormalReportPath = path.join(workDirectory, 'last-abnormal-exit-evidence.json')

  await runFixture('abnormal', { workDirectory, reportPath, lastAbnormalReportPath })
  const firstAbnormal = readAndValidateElectronExitEvidence(reportPath)
  assert.equal(firstAbnormal.outcome, 'abnormal-exit')
  assert.deepEqual(readAndValidateElectronExitEvidence(lastAbnormalReportPath), firstAbnormal)

  const delayedClean = runFixture('delayed-clean', {
    workDirectory,
    reportPath,
    lastAbnormalReportPath
  })
  assert.equal(fs.readdirSync(workDirectory).filter((name) => name.endsWith('.current')).length, 1,
    'an in-flight supervisor owns one isolated current report')
  assert.deepEqual(readAndValidateElectronExitEvidence(reportPath), firstAbnormal,
    'new current evidence must not replace the last completed canonical report')
  await delayedClean
  const completedClean = readAndValidateElectronExitEvidence(reportPath)
  assert.equal(completedClean.outcome, 'clean-exit')
  assert.deepEqual(readAndValidateElectronExitEvidence(lastAbnormalReportPath), firstAbnormal,
    'a clean run must not erase the separately retained abnormal report')

  await runFixture('secondary', { workDirectory, reportPath, lastAbnormalReportPath })
  assert.deepEqual(readAndValidateElectronExitEvidence(reportPath), completedClean,
    'clean pre-bootstrap secondary exits must not replace canonical evidence')

  await runFixture('prebootstrap-abnormal', { workDirectory, reportPath, lastAbnormalReportPath })
  const prebootstrapAbnormal = readAndValidateElectronExitEvidence(reportPath)
  assert.equal(prebootstrapAbnormal.outcome, 'abnormal-exit')
  assert.equal(prebootstrapAbnormal.lifecycle.bootstrapComplete, false)
  assert.deepEqual(readAndValidateElectronExitEvidence(lastAbnormalReportPath), prebootstrapAbnormal,
    'pre-bootstrap abnormal exits remain material and must be retained')
  assert.equal(allFiles(workDirectory).some((file) => file.endsWith('.current')), false)
})

test('sanitized child-process event survives Electron IPC and maps breakpoint to storage', { timeout: 30000 }, async () => {
  const { report, reportPath } = await runFixture('storage-breakpoint-signed')
  assert.equal(report.outcome, 'abnormal-exit')
  assert.equal(report.mainExit.statusClass, 'zero')
  assert.deepEqual(report.attribution, {
    breakpointObserved: true,
    role: 'storage',
    confidence: 'service-name'
  })
  assert.deepEqual(report.incidents, [{
    ordinal: 1,
    role: 'storage',
    source: 'child-process-gone',
    reason: 'crashed',
    statusClass: 'breakpoint-0x80000003'
  }])
  const serialized = JSON.stringify(readAndValidateElectronExitEvidence(reportPath))
  assert.doesNotMatch(serialized, /Users|private|subtitle body|diagnostic memory|\.wav|location|report|message/i)
})

test('unsigned uint32 breakpoint representation survives the Electron fixture boundary', { timeout: 30000 }, async () => {
  const { report, reportPath } = await runFixture('storage-breakpoint-unsigned')
  assert.equal(report.outcome, 'abnormal-exit')
  assert.equal(report.mainExit.statusClass, 'zero')
  assert.deepEqual(report.attribution, {
    breakpointObserved: true,
    role: 'storage',
    confidence: 'service-name'
  })
  assert.equal(report.incidents[0].statusClass, 'breakpoint-0x80000003')
  readAndValidateElectronExitEvidence(reportPath)
})

test('supervisor source never enumerates or terminates Electron by process name', () => {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'run-supervised-electron.js'), 'utf8')
  assert.doesNotMatch(source, /taskkill|Stop-Process|Get-Process|Win32_Process|wmic|killall|electron\.exe.*(?:kill|stop)/i)
  assert.doesNotMatch(source, /\bchild\s*\.\s*kill\s*\(/)
  assert.doesNotMatch(source, /\.pid\b/)
  assert.match(source, /spawnProcess\(executablePath/)
})
