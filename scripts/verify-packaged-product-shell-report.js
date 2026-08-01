'use strict'

// @ts-check

const fs = require('node:fs')
const path = require('node:path')
const { validateProductShellReport } = require('./verify-product-shell-report')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')
const { IDENTITY_VERSION } = require('../src/main/services/product-payload-identity')

const PACKAGING_KEYS = Object.freeze([
  'appIsPackaged',
  'defaultApp',
  'smokeMainFromAsar',
  'productMainFromAsar',
  'storageUtilityRoundTrip',
  'nativeBinaryCount',
  'nativeAddonLoadedInUtility',
  'nativeApiSurfaceReady',
  'nativeProbeExactExitCode',
  'nativeProbeFatalObserved',
  'packagedDb0Status',
  'packagedDb0CheckCount',
  'packagedDb0Wal',
  'packagedDb0Reopen',
  'packagedDb0Integrity',
  'packagedDb0ExactExitCode',
  'releaseCandidate',
  'installedViaNsis'
])
const QUALIFICATION_KEYS = Object.freeze([
  'runId',
  'phase',
  'freshProductReportSha256',
  'productPayloadVersion',
  'productPayloadFileCount',
  'productPayloadSha256'
])
const RUN_ID_PATTERN = /^b5-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

function hasExactKeys (value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function validatePackagedRuntimeEvidence (packaging) {
  if (!hasExactKeys(packaging, PACKAGING_KEYS) ||
      packaging.appIsPackaged !== true || packaging.defaultApp !== false ||
      packaging.smokeMainFromAsar !== true || packaging.productMainFromAsar !== true ||
      packaging.storageUtilityRoundTrip !== true || packaging.nativeBinaryCount !== 5 ||
      packaging.nativeAddonLoadedInUtility !== true || packaging.nativeApiSurfaceReady !== true ||
      packaging.nativeProbeExactExitCode !== 0 || packaging.nativeProbeFatalObserved !== false ||
      packaging.packagedDb0Status !== 'pass' ||
      !Number.isSafeInteger(packaging.packagedDb0CheckCount) || packaging.packagedDb0CheckCount < 10 ||
      packaging.packagedDb0Wal !== true || packaging.packagedDb0Reopen !== true ||
      packaging.packagedDb0Integrity !== true || packaging.packagedDb0ExactExitCode !== 0 ||
      packaging.releaseCandidate !== false || packaging.installedViaNsis !== false) {
    throw new Error('packaged product-shell evidence is incomplete or overclaims the release candidate')
  }
  return packaging
}

function validatePackagedQualification (qualification, expectedPhase) {
  if (!hasExactKeys(qualification, QUALIFICATION_KEYS) ||
      !RUN_ID_PATTERN.test(String(qualification.runId || '')) ||
      qualification.phase !== expectedPhase ||
      qualification.productPayloadVersion !== IDENTITY_VERSION ||
      !Number.isSafeInteger(qualification.productPayloadFileCount) ||
      qualification.productPayloadFileCount < 1 ||
      !SHA256_PATTERN.test(String(qualification.productPayloadSha256 || '')) ||
      (expectedPhase === 'fresh'
        ? qualification.freshProductReportSha256 !== null
        : !SHA256_PATTERN.test(String(qualification.freshProductReportSha256 || '')))) {
    throw new Error('packaged product-shell qualification identity is incomplete')
  }
  return qualification
}

function validatePackagedProductShellReport (report) {
  validateProductShellReport(report)
  const packaging = report.packaging
  validatePackagedRuntimeEvidence(packaging)
  validatePackagedQualification(report.qualification, 'fresh')
  if (!report.limitations.includes('packaged-test-variant-not-release-installer') ||
      !report.limitations.includes('not-clean-machine-i4')) {
    throw new Error('packaged product-shell report must preserve its test-variant boundary')
  }
  return report
}

function readAndValidatePackagedProductShellReport (reportPath) {
  const resolved = path.resolve(reportPath)
  return validatePackagedProductShellReport(parseStrictEvidenceJson(
    fs.readFileSync(resolved),
    `packaged product-shell report ${path.basename(resolved)}`
  ))
}

if (require.main === module) {
  if (process.argv.length !== 3) {
    throw new Error('usage: node scripts/verify-packaged-product-shell-report.js <report.json>')
  }
  const report = readAndValidatePackagedProductShellReport(process.argv[2])
  process.stdout.write(JSON.stringify({
    result: report.result,
    appIsPackaged: report.packaging.appIsPackaged,
    mainFromAsar: report.packaging.productMainFromAsar,
    nativeAddonLoadedInUtility: report.packaging.nativeAddonLoadedInUtility,
    packagedDb0Status: report.packaging.packagedDb0Status,
    storageUtilityRoundTrip: report.packaging.storageUtilityRoundTrip
  }) + '\n')
}

module.exports = {
  PACKAGING_KEYS,
  QUALIFICATION_KEYS,
  readAndValidatePackagedProductShellReport,
  validatePackagedQualification,
  validatePackagedRuntimeEvidence,
  validatePackagedProductShellReport
}
