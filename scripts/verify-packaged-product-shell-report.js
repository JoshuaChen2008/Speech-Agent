'use strict'

// @ts-check

const fs = require('node:fs')
const path = require('node:path')
const { validateProductShellReport } = require('./verify-product-shell-report')

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

function hasExactKeys (value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function validatePackagedProductShellReport (report) {
  validateProductShellReport(report)
  const packaging = report.packaging
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
  if (!report.limitations.includes('packaged-test-variant-not-release-installer') ||
      !report.limitations.includes('not-clean-machine-i4')) {
    throw new Error('packaged product-shell report must preserve its test-variant boundary')
  }
  return report
}

function readAndValidatePackagedProductShellReport (reportPath) {
  return validatePackagedProductShellReport(JSON.parse(fs.readFileSync(path.resolve(reportPath), 'utf8')))
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
  readAndValidatePackagedProductShellReport,
  validatePackagedProductShellReport
}
