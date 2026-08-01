'use strict'

// @ts-check

const fs = require('node:fs')
const path = require('node:path')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')

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
  const requiredModelStates = ['missing', 'downloading', 'verifying', 'ready']
  if (journey.onboardingPreset !== 'dictation' ||
      journey.modelInstallClicked !== true ||
      journey.modelInitialState !== 'missing' ||
      !Array.isArray(journey.modelObservedStates) ||
      journey.modelObservedStates.length !== requiredModelStates.length ||
      journey.modelObservedStates.some((state, index) => state !== requiredModelStates[index]) ||
      journey.modelRangeResumeObserved !== true ||
      journey.modelReadyMarkerCount !== 3 ||
      journey.modelHotActivation !== true ||
      journey.startListeningStop !== true ||
      journey.pauseResume !== true ||
      journey.finalCaptionRendered !== true ||
      /* J15a：可见字幕必须就是那条定稿，且改字号后视口按整行重算不溢出。 */
      journey.visibleCaptionMatchesFinal !== true ||
      journey.captionFontApplied !== true ||
      journey.downloadedModelSessionInHistory !== true ||
      journey.terminalHistoryCount !== 3 ||
      journey.legacyJsonlMigrated !== true || journey.legacySessionVisible !== true ||
      journey.legacySourceReadOnly !== true ||
      journey.longHistorySegmentCount !== 205 || journey.historyPageCount !== 5 ||
      journey.historyPageSize !== 50 || journey.historyMaxTimelineNodes > 50 ||
      !Number.isSafeInteger(journey.historyMaxTimelineNodes) || journey.historyMaxTimelineNodes < 1 ||
      journey.historyReachedEnd !== true || journey.historyBackForwardNavigation !== true ||
      journey.historyAriaRangeAligned !== true ||
      journey.historyExportDialogCount !== 3 ||
      !Array.isArray(journey.historyExportFormats) ||
      journey.historyExportFormats.length !== 3 ||
      journey.historyExportFormats.some((format, index) => format !== ['txt', 'md', 'srt'][index]) ||
      journey.historyExportArtifactCount !== 3 ||
      journey.historyExportFullSegmentCount !== 205 ||
      journey.resourcesPaneOpenedFromToolbar !== true ||
      journey.modelState !== 'ready' || journey.resourceCount !== 3 ||
      journey.modelReadinessSource !== 'settings-click-controlled-install' ||
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
    'controlled-model-fixtures-no-real-tensors',
    'deterministic-205-segment-fixture-not-two-hour-i3',
    report.packaging?.appIsPackaged === true ? 'not-clean-machine-i4' : 'not-packaged-i4'
  ]
  if (!Array.isArray(report.limitations) ||
      requiredLimitations.some((limitation) => !report.limitations.includes(limitation)) ||
      (report.packaging?.appIsPackaged === true && report.limitations.includes('not-packaged-i4'))) {
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
  const resolved = path.resolve(reportPath)
  return validateProductShellReport(parseStrictEvidenceJson(
    fs.readFileSync(resolved),
    `product-shell report ${path.basename(resolved)}`
  ))
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
