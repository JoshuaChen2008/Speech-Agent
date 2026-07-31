'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const {
  MAX_INCIDENTS,
  createEvidenceAccumulator,
  incidentEnvelope,
  lifecycleEnvelope
} = require('../../src/main/services/electron-exit-evidence')
const {
  readAndValidateElectronExitEvidence,
  validateElectronExitEvidence
} = require('../../scripts/verify-electron-exit-evidence')
const {
  currentReportPath,
  defaultLastAbnormalReportPath,
  defaultReportPath,
  parseArguments,
  shouldPromoteCanonical,
  superviseElectron,
  writeReportAtomic
} = require('../../scripts/run-supervised-electron')

function passingReport () {
  const accumulator = createEvidenceAccumulator({
    electronMajor: 43,
    platform: 'win32',
    now: () => 1700000000000
  })
  accumulator.markMainSpawned()
  for (const stage of ['main-started', 'app-ready', 'bootstrap-complete', 'quit-requested', 'will-quit']) {
    accumulator.acceptIpcMessage(lifecycleEnvelope(stage))
  }
  accumulator.finishMainExit(0)
  return accumulator.snapshot()
}

function clone (value) {
  return structuredClone(value)
}

test('strict verifier accepts a clean, bounded, diagnostic-only report', () => {
  const report = passingReport()
  assert.equal(report.outcome, 'clean-exit')
  assert.equal(report.mainExit.statusClass, 'zero')
  assert.equal(report.incidents.length, 0)
  assert.equal(validateElectronExitEvidence(report), report)

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-evidence-verify-'))
  const reportFile = path.join(directory, 'evidence.json')
  fs.writeFileSync(reportFile, `${JSON.stringify(report)}\n`)
  assert.equal(readAndValidateElectronExitEvidence(reportFile).outcome, 'clean-exit')
})

test('verifier rejects unknown fields, privacy regressions and scope overclaims', () => {
  const report = passingReport()

  const unknownRoot = clone(report)
  unknownRoot.details = 'arbitrary'
  assert.throws(() => validateElectronExitEvidence(unknownRoot), /invalid evidence report envelope/)

  const unknownNested = clone(report)
  unknownNested.runtime.cwd = 'private'
  assert.throws(() => validateElectronExitEvidence(unknownNested), /invalid evidence runtime/)

  const privacyRegression = clone(report)
  privacyRegression.privacy.audioPayloadPersisted = true
  assert.throws(() => validateElectronExitEvidence(privacyRegression), /privacy contract/)

  const scopeOverclaim = clone(report)
  scopeOverclaim.scope.rootCauseIdentified = true
  assert.throws(() => validateElectronExitEvidence(scopeOverclaim), /scope overclaim/)

  const fabricatedAttribution = clone(report)
  fabricatedAttribution.attribution = {
    breakpointObserved: true,
    role: 'storage',
    confidence: 'service-name'
  }
  assert.throws(() => validateElectronExitEvidence(fabricatedAttribution), /does not match observations/)

  const fabricatedOutcome = clone(report)
  fabricatedOutcome.outcome = 'abnormal-exit'
  assert.throws(() => validateElectronExitEvidence(fabricatedOutcome), /outcome does not match observations/)

  const fabricatedCounter = clone(report)
  fabricatedCounter.counters.utilityGoneCount = 1
  assert.throws(() => validateElectronExitEvidence(fabricatedCounter), /source counters do not match/)
})

test('verifier derives capped fault outcome from counters and rejects hidden fault observations', () => {
  const accumulator = createEvidenceAccumulator({ now: () => 1700000000000 })
  for (let index = 0; index < MAX_INCIDENTS; index += 1) {
    accumulator.acceptIpcMessage(incidentEnvelope({
      role: 'renderer', source: 'unresponsive', reason: 'unresponsive',
      statusClass: 'not-observed'
    }))
  }
  accumulator.acceptIpcMessage(incidentEnvelope({
    role: 'storage', source: 'child-process-gone', reason: 'crashed',
    statusClass: 'other-nonzero'
  }))
  const report = accumulator.snapshot()
  assert.equal(report.outcome, 'abnormal-exit')
  assert.equal(validateElectronExitEvidence(report), report)

  const fabricatedOutcome = clone(report)
  fabricatedOutcome.outcome = 'incomplete'
  assert.throws(() => validateElectronExitEvidence(fabricatedOutcome), /outcome does not match observations/)

  const hiddenFault = clone(report)
  hiddenFault.incidents[MAX_INCIDENTS - 1] = {
    ordinal: MAX_INCIDENTS,
    role: 'renderer',
    source: 'unresponsive',
    reason: 'unresponsive',
    statusClass: 'not-observed'
  }
  assert.throws(() => validateElectronExitEvidence(hiddenFault), /lost all fault observations/)
})

test('verifier rejects a capped report that removes the retained main breakpoint', () => {
  const accumulator = createEvidenceAccumulator({ now: () => 1700000000000 })
  accumulator.acceptIpcMessage(incidentEnvelope({
    role: 'storage', source: 'child-process-gone', reason: 'crashed',
    statusClass: 'breakpoint-0x80000003'
  }))
  for (let index = 1; index < MAX_INCIDENTS; index += 1) {
    accumulator.acceptIpcMessage(incidentEnvelope({
      role: 'renderer', source: 'unresponsive', reason: 'unresponsive',
      statusClass: 'not-observed'
    }))
  }
  accumulator.finishMainExit(-2147483645)
  const report = accumulator.snapshot()
  assert.equal(validateElectronExitEvidence(report), report)

  const hiddenMainBreakpoint = clone(report)
  hiddenMainBreakpoint.incidents[MAX_INCIDENTS - 1] = {
    ordinal: MAX_INCIDENTS,
    role: 'renderer',
    source: 'unresponsive',
    reason: 'unresponsive',
    statusClass: 'not-observed'
  }
  assert.throws(() => validateElectronExitEvidence(hiddenMainBreakpoint), /lost the main breakpoint/)
})

test('published schema exposes no PID, body, PCM, path, stack or diagnostic payload field', () => {
  const report = passingReport()
  const forbidden = new Set([
    'pid', 'text', 'transcript', 'caption', 'pcm', 'path', 'stack', 'message',
    'report', 'location', 'argv', 'cwd', 'env'
  ])
  const keys = []
  const visit = (value) => {
    if (Array.isArray(value)) return value.forEach(visit)
    if (!value || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      keys.push(key.toLowerCase())
      visit(child)
    }
  }
  visit(report)
  assert.deepEqual(keys.filter((key) => forbidden.has(key)), [])
  const serialized = JSON.stringify(report)
  assert.doesNotMatch(serialized, /[A-Za-z]:[\\/]|file:\/\/|\\\\[^\\]|\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)/i)
})

test('default report address is per-user and repeated atomic replacement works on Windows', () => {
  const defaultTarget = defaultReportPath()
  assert.equal(path.isAbsolute(defaultTarget), true)
  assert.equal(path.basename(defaultTarget), 'last-exit-evidence.json')
  assert.equal(path.basename(defaultLastAbnormalReportPath(defaultTarget)), 'last-abnormal-exit-evidence.json')
  assert.notEqual(currentReportPath(defaultTarget, 'test-run'), defaultTarget)

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-evidence-replace-'))
  const reportFile = path.join(directory, 'evidence.json')
  const first = passingReport()
  const second = clone(first)
  second.generatedAt = '2023-11-14T22:13:21.000Z'
  writeReportAtomic(reportFile, first)
  writeReportAtomic(reportFile, second)
  assert.equal(readAndValidateElectronExitEvidence(reportFile).generatedAt, second.generatedAt)
  assert.deepEqual(fs.readdirSync(directory), ['evidence.json'], 'temporary files must not survive replacement')
})

test('strict-report is explicit, singular and defaults to fail-open', () => {
  assert.deepEqual(parseArguments(['--entry', '.', '--entry-arg', '--fixture', '--strict-report']), {
    reportPath: null,
    entryPath: '.',
    executablePath: null,
    electronMajor: null,
    entryArguments: ['--fixture'],
    strictReport: true,
    packaged: false
  })
  assert.equal(parseArguments(['--entry', '.']).strictReport, false)
  assert.throws(() => parseArguments(['--strict-report', '--strict-report']), /duplicate/)
  assert.throws(() => parseArguments(['--strict-report=true']), /invalid/)
  assert.deepEqual(parseArguments([
    '--packaged',
    '--electron', 'C:\\Program Files\\Speech Agent\\SpeechAgent.exe',
    '--electron-major', '43',
    '--entry-arg', '--fixture'
  ]), {
    reportPath: null,
    entryPath: '.',
    executablePath: 'C:\\Program Files\\Speech Agent\\SpeechAgent.exe',
    electronMajor: 43,
    entryArguments: ['--fixture'],
    strictReport: false,
    packaged: true
  })
  assert.throws(() => parseArguments(['--packaged']), /requires --electron/)
  assert.throws(() => parseArguments([
    '--packaged', '--electron', 'SpeechAgent.exe', '--electron-major', '43', '--entry', '.'
  ]), /without --entry/)
})

test('packaged supervision launches the exact executable without injecting a source entry', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-evidence-packaged-spawn-'))
  const child = new EventEmitter()
  let observedArguments = null
  const report = await superviseElectron({
    executablePath: path.join(directory, 'SpeechAgent.exe'),
    packaged: true,
    entryArguments: ['--fixture', 'value'],
    reportPath: path.join(directory, 'canonical.json'),
    spawnProcess: (_executable, args) => {
      observedArguments = args
      setImmediate(() => {
        child.emit('spawn')
        for (const stage of ['main-started', 'app-ready', 'bootstrap-complete', 'quit-requested', 'will-quit']) {
          child.emit('message', lifecycleEnvelope(stage))
        }
        child.emit('exit', 0, null)
        child.emit('disconnect')
        child.emit('close', 0, null)
      })
      return child
    }
  })
  assert.deepEqual(observedArguments, ['--fixture', 'value'])
  assert.equal(report.outcome, 'clean-exit')
  assert.equal(report.scope.packagedRuntime, true)
})

test('only completed primaries and abnormal exits qualify for canonical promotion', () => {
  const primary = passingReport()
  assert.equal(shouldPromoteCanonical(primary), true)

  const cleanSecondary = clone(primary)
  cleanSecondary.lifecycle.bootstrapComplete = false
  assert.equal(shouldPromoteCanonical(cleanSecondary), false)

  const abnormal = clone(primary)
  abnormal.mainExit.statusClass = 'other-nonzero'
  abnormal.outcome = 'abnormal-exit'
  abnormal.incidents = [{
    ordinal: 1,
    role: 'main',
    source: 'main-exit',
    reason: 'abnormal-exit',
    statusClass: 'other-nonzero'
  }]
  abnormal.counters.incidentCount = 1
  abnormal.counters.mainExitCount = 1
  assert.equal(shouldPromoteCanonical(abnormal), true)
})

test('strict initial persistence failure refuses before spawning Electron', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-evidence-strict-initial-'))
  let spawnCalled = false
  await assert.rejects(superviseElectron({
    executablePath: process.execPath,
    entryPath: __filename,
    reportPath: path.join(directory, 'canonical.json'),
    strictReport: true,
    reportWriter: () => { throw new Error('simulated initial failure') },
    spawnProcess: () => {
      spawnCalled = true
      throw new Error('must not spawn')
    }
  }), (error) => error?.code === 'E_ELECTRON_EVIDENCE_PERSISTENCE')
  assert.equal(spawnCalled, false)
})

test('exit waits for IPC disconnect so a queued final lifecycle event is retained', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-evidence-drain-'))
  const reportPath = path.join(directory, 'canonical.json')
  const child = new EventEmitter()
  const resultPromise = superviseElectron({
    executablePath: process.execPath,
    entryPath: __filename,
    reportPath,
    ipcDrainTimeoutMs: 100,
    spawnProcess: () => {
      setImmediate(() => {
        child.emit('spawn')
        for (const stage of ['main-started', 'app-ready', 'bootstrap-complete', 'quit-requested']) {
          child.emit('message', lifecycleEnvelope(stage))
        }
        child.emit('exit', 0, null)
        child.emit('message', lifecycleEnvelope('will-quit'))
        child.emit('disconnect')
        child.emit('close', 0, null)
      })
      return child
    }
  })
  const report = await resultPromise
  assert.equal(report.outcome, 'clean-exit')
  assert.equal(report.lifecycle.willQuitObserved, true)
  assert.equal(readAndValidateElectronExitEvidence(reportPath).lifecycle.willQuitObserved, true)
  assert.deepEqual(fs.readdirSync(directory), ['canonical.json'])
})

test('missing IPC disconnect uses a bounded drain timeout without touching child lifetime', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-evidence-drain-timeout-'))
  const child = new EventEmitter()
  const report = await superviseElectron({
    executablePath: process.execPath,
    entryPath: __filename,
    reportPath: path.join(directory, 'canonical.json'),
    ipcDrainTimeoutMs: 10,
    spawnProcess: () => {
      setImmediate(() => {
        child.emit('spawn')
        for (const stage of ['main-started', 'app-ready', 'bootstrap-complete', 'quit-requested', 'will-quit']) {
          child.emit('message', lifecycleEnvelope(stage))
        }
        child.emit('exit', 0, null)
      })
      return child
    }
  })
  assert.equal(report.outcome, 'clean-exit')
  assert.equal(report.mainExit.statusClass, 'zero')
})
