'use strict'

// @ts-check

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const {
  defaultLastAbnormalReportPath,
  superviseElectron
} = require('./run-supervised-electron')
const {
  readAndValidatePackagedProductShellReport
} = require('./verify-packaged-product-shell-report')
const {
  readAndValidateElectronExitEvidence
} = require('./verify-electron-exit-evidence')
const {
  readAndValidateProductShellRestartReport
} = require('./verify-product-shell-restart-report')
const {
  createPackagedRunBindingReport,
  sha256File,
  writePackagedRunBindingReport
} = require('./verify-packaged-run-binding')

function parseArguments (argv) {
  const values = { executable: null, artifactsRoot: null, electronMajor: null }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!['--executable', '--artifacts-root', '--electron-major'].includes(flag) ||
        seen.has(flag) || index + 1 >= argv.length) {
      throw new Error('invalid packaged product-shell arguments')
    }
    seen.add(flag)
    const value = String(argv[++index])
    if (flag === '--executable') values.executable = value
    if (flag === '--artifacts-root') values.artifactsRoot = value
    if (flag === '--electron-major') values.electronMajor = Number(value)
  }
  if (!values.executable || !path.isAbsolute(values.executable) ||
      !values.artifactsRoot || !path.isAbsolute(values.artifactsRoot) ||
      path.resolve(values.artifactsRoot) === path.parse(path.resolve(values.artifactsRoot)).root ||
      !Number.isSafeInteger(values.electronMajor) || values.electronMajor < 1) {
    throw new Error('absolute executable/artifacts root and positive Electron major are required')
  }
  return values
}

function sanitizedEnvironment (environment = process.env) {
  const result = { ...environment }
  for (const name of Object.keys(result)) {
    if (name === 'NODE_OPTIONS' || name === 'NODE_PATH' || name === 'ELECTRON_RUN_AS_NODE' ||
        name.startsWith('LIVE_SUBTITLE_')) delete result[name]
  }
  return result
}

async function main () {
  const options = parseArguments(process.argv.slice(2))
  const artifactsRoot = path.resolve(options.artifactsRoot)
  if (fs.existsSync(artifactsRoot)) throw new Error('packaged smoke artifacts root must not already exist')
  fs.mkdirSync(artifactsRoot, { recursive: false })
  const qualificationRunId = `b5-${randomUUID()}`
  const reportPath = path.join(artifactsRoot, 'product-shell.json')
  const evidencePath = path.join(artifactsRoot, 'exit-evidence.json')
  const report = await superviseElectron({
    executablePath: options.executable,
    electronMajor: options.electronMajor,
    packaged: true,
    entryArguments: [
      '--artifacts-root', artifactsRoot,
      '--work-dir', 'work',
      '--report', 'product-shell.json',
      '--qualification-run-id', qualificationRunId
    ],
    reportPath: evidencePath,
    lastAbnormalReportPath: defaultLastAbnormalReportPath(evidencePath),
    strictReport: true,
    cwd: artifactsRoot,
    env: sanitizedEnvironment()
  })
  if (report.outcome !== 'clean-exit' || report.scope.packagedRuntime !== true) {
    throw new Error('packaged Electron did not complete a clean supervised exit')
  }
  const product = readAndValidatePackagedProductShellReport(reportPath)
  const evidence = readAndValidateElectronExitEvidence(evidencePath)
  if (evidence.scope.packagedRuntime !== true) {
    throw new Error('packaged Electron exit evidence lost its runtime scope')
  }
  const freshProductReportSha256 = sha256File(reportPath)

  const restartReportPath = path.join(artifactsRoot, 'offline-restart.json')
  const restartEvidencePath = path.join(artifactsRoot, 'offline-restart-exit-evidence.json')
  const restartExit = await superviseElectron({
    executablePath: options.executable,
    electronMajor: options.electronMajor,
    packaged: true,
    entryArguments: [
      '--artifacts-root', artifactsRoot,
      '--work-dir', 'work',
      '--report', 'offline-restart.json',
      '--mode', 'restart',
      '--qualification-run-id', qualificationRunId,
      '--fresh-product-report-sha256', freshProductReportSha256
    ],
    reportPath: restartEvidencePath,
    lastAbnormalReportPath: defaultLastAbnormalReportPath(restartEvidencePath),
    strictReport: true,
    cwd: artifactsRoot,
    env: sanitizedEnvironment()
  })
  if (restartExit.outcome !== 'clean-exit' || restartExit.scope.packagedRuntime !== true) {
    throw new Error('packaged offline restart did not complete a clean supervised exit')
  }
  const restart = readAndValidateProductShellRestartReport(restartReportPath)
  const restartEvidence = readAndValidateElectronExitEvidence(restartEvidencePath)
  if (restartEvidence.scope.packagedRuntime !== true) {
    throw new Error('packaged offline restart exit evidence lost its runtime scope')
  }
  const bindingReportPath = path.join(artifactsRoot, 'qualification-binding.json')
  const binding = createPackagedRunBindingReport({
    runId: qualificationRunId,
    electronMajor: options.electronMajor,
    testExecutable: options.executable,
    freshProductReport: reportPath,
    freshExitReport: evidencePath,
    restartProductReport: restartReportPath,
    restartExitReport: restartEvidencePath
  })
  writePackagedRunBindingReport(bindingReportPath, binding)
  process.stdout.write(JSON.stringify({
    result: product.result,
    packaged: product.packaging.appIsPackaged,
    nativeAddonLoaded: product.packaging.nativeAddonLoadedInUtility,
    storageUtilityRoundTrip: product.packaging.storageUtilityRoundTrip,
    exit: evidence.outcome,
    offlineRestart: restart.result,
    offlineModelFetchAttemptCount: restart.journey.modelFetchAttemptCount,
    offlineRestartExit: restartEvidence.outcome,
    qualificationRunId: binding.run.runId,
    productPayloadSha256: binding.run.productPayloadSha256,
    breakpointObserved: evidence.attribution.breakpointObserved
  }) + '\n')
}

if (require.main === module) {
  main().catch(() => {
    process.stderr.write('Packaged product-shell qualification failed.\n')
    process.exitCode = 1
  })
}

module.exports = {
  parseArguments,
  sanitizedEnvironment
}
