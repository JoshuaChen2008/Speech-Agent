'use strict'

const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const { readAndValidateProductShellReport } = require('../../scripts/verify-product-shell-report')
const { readAndValidate: readDiagnostic } = require('../../scripts/verify-toolbar-reload-diagnostic')
const { readAndValidateElectronExitEvidence } = require('../../scripts/verify-electron-exit-evidence')
const { defaultElectronRuntime, superviseElectron } = require('../../scripts/run-supervised-electron')

test('SEM-F22/SEM-T04/J17/J19: real four-window reload recovers while Chromium frame callbacks are held', { timeout: 65000 }, async () => {
  const root = path.resolve(__dirname, '../..')
  const artifacts = path.join(root, '.artifacts')
  fs.mkdirSync(artifacts, { recursive: true })
  const outputRoot = fs.mkdtempSync(path.join(artifacts, 'toolbar-reload-frames-'))
  const relativeRoot = path.relative(root, outputRoot)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  let output = ''
  let child = null
  let closed = Promise.resolve()
  let supervision = null
  let timer = null
  const keepOutput = data => { output = (output + data).slice(-4000) }
  try {
    supervision = superviseElectron({
      ...defaultElectronRuntime(),
      entryPath: path.join(root, 'scripts/product-shell-smoke.js'),
      entryArguments: [
        '--toolbar-reload-diagnostic', '--hold-toolbar-reload-frames',
        '--work-dir', `${relativeRoot}/work`, '--report', `${relativeRoot}/report.json`
      ],
      cwd: root,
      env,
      reportPath: path.join(outputRoot, 'exit-evidence.json'),
      strictReport: true,
      spawnProcess (executable, argv, options) {
        child = spawn(executable, argv, { ...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
        child.stdout.on('data', keepOutput)
        child.stderr.on('data', keepOutput)
        closed = new Promise(resolve => child.once('close', resolve))
        timer = setTimeout(() => child.kill(), 55000)
        return child
      }
    })
    const observedExit = await supervision
    await closed
    assert.equal(observedExit.outcome, 'clean-exit', output)
    const report = readAndValidateProductShellReport(path.join(outputRoot, 'report.json'))
    const diagnostic = readDiagnostic(path.join(outputRoot, 'toolbar-reload-diagnostic.json'))
    const exit = readAndValidateElectronExitEvidence(path.join(outputRoot, 'exit-evidence.json'))
    assert.equal(report.result, 'pass')
    assert.equal(report.windowInteraction.reloadValidRecoveryObserved, true)
    assert.equal(diagnostic.outcome, 'recovered')
    assert.equal(diagnostic.recoveryTimeoutMs, 5000)
    assert.equal(diagnostic.facts.targetLayoutAcceptedObserved, true)
    assert.equal(diagnostic.productPayloadSha256, report.sourceIdentity.productPayloadSha256)
    assert.equal(diagnostic.renderer.snapshot.entries.some(entry => entry.stage === 'raf-ran'), false,
      'recovery must be observed before the held Chromium frames are released')
    assert.equal(exit.outcome, 'clean-exit')
    assert.equal(exit.counters.incidentCount, 0)
  } finally {
    clearTimeout(timer)
    if (child && child.exitCode === null) child.kill()
    if (supervision) await supervision.catch(() => {})
    await closed
    assert.equal(path.dirname(path.resolve(outputRoot)), artifacts)
    fs.rmSync(outputRoot, { recursive: true, force: true })
  }
})
