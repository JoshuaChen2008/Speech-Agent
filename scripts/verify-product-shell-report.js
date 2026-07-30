'use strict'

// @ts-check

const fs = require('node:fs')
const path = require('node:path')

function validateProductShellReport (report) {
  if (!report || report.schemaVersion !== 1 || report.kind !== 'product-shell-smoke') {
    throw new Error('invalid product-shell report envelope')
  }
  if (report.result !== 'pass' || report.gateStatus !== 'partial') {
    throw new Error('product-shell journey did not pass or overclaimed the release gate')
  }
  if (!/^43\./.test(String(report.runtime?.electron || '')) ||
      report.runtime?.rendererCount !== 4 || report.runtime?.crashEventCount !== 0) {
    throw new Error('product-shell Electron runtime evidence is incomplete')
  }
  const journey = report.journey || {}
  if (journey.onboardingPreset !== 'dictation' ||
      journey.startListeningStop !== true ||
      journey.finalCaptionRendered !== true ||
      !Number.isSafeInteger(journey.terminalHistoryCount) || journey.terminalHistoryCount < 1 ||
      journey.resourcesPaneOpenedFromToolbar !== true ||
      journey.modelState !== 'ready' || journey.resourceCount !== 3 ||
      journey.modelReadinessSource !== 'development-fixture-files' ||
      journey.translationAdvertised !== false) {
    throw new Error('product-shell user journey evidence is incomplete')
  }
  if (report.privacy?.physicalAudioSourceOpened !== false ||
      report.privacy?.audioPersisted !== false ||
      report.privacy?.transcriptTextPersistedInReport !== false ||
      report.privacy?.localPathsPersistedInReport !== false) {
    throw new Error('product-shell privacy evidence is incomplete')
  }
  const requiredLimitations = [
    'fake-asr-no-physical-audio',
    'development-model-fixtures-no-real-inference',
    'not-packaged-i4'
  ]
  if (!Array.isArray(report.limitations) ||
      requiredLimitations.some((limitation) => !report.limitations.includes(limitation))) {
    throw new Error('product-shell report must preserve its external-boundary limitations')
  }
  const serialized = JSON.stringify(report)
  if (/[A-Za-z]:[\\/]/.test(serialized) ||
      /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)/i.test(serialized) ||
      /joined(?:Final|Refined)Text|captionArrivals|"text"\s*:/i.test(serialized)) {
    throw new Error('product-shell report leaked a path, audio reference or transcript text')
  }
  return report
}

function readAndValidateProductShellReport (reportPath) {
  return validateProductShellReport(JSON.parse(fs.readFileSync(path.resolve(reportPath), 'utf8')))
}

if (require.main === module) {
  const reportPath = process.argv[2]
  if (!reportPath || process.argv.length !== 3) {
    throw new Error('usage: node scripts/verify-product-shell-report.js <report.json>')
  }
  const report = readAndValidateProductShellReport(reportPath)
  process.stdout.write(JSON.stringify({
    result: report.result,
    gateStatus: report.gateStatus,
    electron: report.runtime.electron,
    rendererCount: report.runtime.rendererCount,
    crashEventCount: report.runtime.crashEventCount
  }) + '\n')
}

module.exports = {
  readAndValidateProductShellReport,
  validateProductShellReport
}
