'use strict'

// @ts-check

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { IDENTITY_VERSION } = require('../src/main/services/product-payload-identity')
const { readAndValidateElectronExitEvidence } = require('./verify-electron-exit-evidence')
const { readAndValidatePackagedProductShellReport } = require('./verify-packaged-product-shell-report')
const { readAndValidateProductShellRestartReport } = require('./verify-product-shell-restart-report')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')

const SHA256_PATTERN = /^[a-f0-9]{64}$/
const RUN_ID_PATTERN = /^b5-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function exactKeys (value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${label} must be an object`)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has unexpected keys`)
  }
  return value
}

function sha256File (filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function validatePackagedRunBindingReport (report) {
  exactKeys(report, [
    'schemaVersion', 'kind', 'generatedAt', 'result', 'gateStatus', 'run',
    'fresh', 'restart', 'limitations'
  ], 'packaged run binding')
  if (report.schemaVersion !== 1 || report.kind !== 'b5-packaged-run-binding' ||
      report.result !== 'pass' || report.gateStatus !== 'packaged-ci-qualified' ||
      typeof report.generatedAt !== 'string' || Number.isNaN(Date.parse(report.generatedAt))) {
    throw new Error('invalid packaged run binding envelope')
  }
  exactKeys(report.run, [
    'runId', 'electronMajor', 'testExecutableSha256', 'productPayloadVersion',
    'productPayloadFileCount', 'productPayloadSha256'
  ], 'packaged run identity')
  if (!RUN_ID_PATTERN.test(String(report.run.runId || '')) || report.run.electronMajor !== 43 ||
      !SHA256_PATTERN.test(String(report.run.testExecutableSha256 || '')) ||
      report.run.productPayloadVersion !== IDENTITY_VERSION ||
      !Number.isSafeInteger(report.run.productPayloadFileCount) || report.run.productPayloadFileCount < 1 ||
      !SHA256_PATTERN.test(String(report.run.productPayloadSha256 || ''))) {
    throw new Error('invalid packaged run identity')
  }
  for (const [phase, value] of [['fresh', report.fresh], ['restart', report.restart]]) {
    exactKeys(value, ['productReportSha256', 'exitReportSha256'], `${phase} evidence binding`)
    if (!SHA256_PATTERN.test(String(value.productReportSha256 || '')) ||
        !SHA256_PATTERN.test(String(value.exitReportSha256 || ''))) {
      throw new Error(`invalid ${phase} evidence digest`)
    }
  }
  if (!Array.isArray(report.limitations) || report.limitations.length !== 2 ||
      report.limitations[0] !== 'test-package-not-release-installer' ||
      report.limitations[1] !== 'not-clean-machine-i4') {
    throw new Error('packaged run binding lost its release limitations')
  }
  const serialized = JSON.stringify(report)
  if (/[A-Za-z]:[\\/]/.test(serialized) || /file:\/\//i.test(serialized) ||
      /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)/i.test(serialized)) {
    throw new Error('packaged run binding leaked a local address or audio reference')
  }
  return report
}

function createPackagedRunBindingReport (options) {
  exactKeys(options, [
    'runId', 'electronMajor', 'testExecutable', 'freshProductReport', 'freshExitReport',
    'restartProductReport', 'restartExitReport'
  ], 'packaged run binding options')
  if (!RUN_ID_PATTERN.test(String(options.runId || '')) || options.electronMajor !== 43) {
    throw new TypeError('invalid packaged qualification run identity')
  }
  const freshProduct = readAndValidatePackagedProductShellReport(options.freshProductReport)
  const freshExit = readAndValidateElectronExitEvidence(options.freshExitReport)
  const restartProduct = readAndValidateProductShellRestartReport(options.restartProductReport)
  const restartExit = readAndValidateElectronExitEvidence(options.restartExitReport)
  const freshProductSha256 = sha256File(options.freshProductReport)
  const freshQualification = freshProduct.qualification
  const restartQualification = restartProduct.qualification
  if (freshExit.outcome !== 'clean-exit' || restartExit.outcome !== 'clean-exit' ||
      freshExit.scope.packagedRuntime !== true || restartExit.scope.packagedRuntime !== true ||
      freshQualification?.runId !== options.runId || freshQualification?.phase !== 'fresh' ||
      freshQualification?.freshProductReportSha256 !== null ||
      restartQualification?.runId !== options.runId || restartQualification?.phase !== 'restart' ||
      restartQualification?.freshProductReportSha256 !== freshProductSha256 ||
      freshQualification.productPayloadVersion !== restartQualification.productPayloadVersion ||
      freshQualification.productPayloadFileCount !== restartQualification.productPayloadFileCount ||
      freshQualification.productPayloadSha256 !== restartQualification.productPayloadSha256) {
    throw new Error('packaged fresh/restart reports are not one exact supervised run')
  }
  return validatePackagedRunBindingReport({
    schemaVersion: 1,
    kind: 'b5-packaged-run-binding',
    generatedAt: new Date().toISOString(),
    result: 'pass',
    gateStatus: 'packaged-ci-qualified',
    run: {
      runId: options.runId,
      electronMajor: options.electronMajor,
      testExecutableSha256: sha256File(options.testExecutable),
      productPayloadVersion: freshQualification.productPayloadVersion,
      productPayloadFileCount: freshQualification.productPayloadFileCount,
      productPayloadSha256: freshQualification.productPayloadSha256
    },
    fresh: {
      productReportSha256: freshProductSha256,
      exitReportSha256: sha256File(options.freshExitReport)
    },
    restart: {
      productReportSha256: sha256File(options.restartProductReport),
      exitReportSha256: sha256File(options.restartExitReport)
    },
    limitations: ['test-package-not-release-installer', 'not-clean-machine-i4']
  })
}

function readAndValidatePackagedRunBindingReport (reportPath) {
  const resolved = path.resolve(reportPath)
  return validatePackagedRunBindingReport(parseStrictEvidenceJson(
    fs.readFileSync(resolved),
    `packaged run binding ${path.basename(resolved)}`
  ))
}

function writePackagedRunBindingReport (reportPath, report) {
  const target = path.resolve(reportPath)
  fs.writeFileSync(target, `${JSON.stringify(validatePackagedRunBindingReport(report), null, 2)}\n`, { flag: 'wx' })
}

module.exports = {
  RUN_ID_PATTERN,
  createPackagedRunBindingReport,
  readAndValidatePackagedRunBindingReport,
  sha256File,
  validatePackagedRunBindingReport,
  writePackagedRunBindingReport
}
