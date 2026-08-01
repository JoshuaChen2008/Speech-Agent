'use strict'

/* J15a 布局资格报告的严格 verifier。
   --------------------------------------------------------------------------
   fail closed：缺字段、多字段、非法数值、边界被抬高、不变量为假、报告里出现
   字幕正文或本地路径，全部判失败。provenance 必须与当前源码一致——改了字幕
   renderer/样式/reducer 就必须重跑布局资格，不能拿旧报告冒充。

   与 I3 不同，这里**不保留 tracked 基线报告**：几何量随字体与 DPI 环境变化，
   把某台机器的像素快照冻进仓库只会制造假精度。真正冻结的是不变量本身。 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { parseStrictEvidenceJson } = require('./strict-evidence-json')

const ROOT = path.resolve(__dirname, '..')
const SCHEMA = 'caption-layout-report@v1'

const PROVENANCE_FILES = Object.freeze({
  captionMarkupSha256: 'src/caption/index.html',
  captionRendererSha256: 'src/caption/caption.js',
  captionStyleSha256: 'src/caption/caption.css',
  preloadSha256: 'src/preload/caption.js',
  reducerSha256: 'src/ui/shared/caption-reducer.js',
  runnerSha256: 'scripts/caption-layout-smoke.js',
  tokensSha256: 'src/ui/shared/tokens.css',
  verifierSha256: 'scripts/verify-caption-layout-report.js'
})

const REQUIRED_BOUNDARIES = Object.freeze([
  'audioCapture',
  'configBroadcastWiring',
  'dpiMatrix',
  'humanVisualReview',
  'productCompositionRoot',
  'realAsrOrVad'
])

const REQUIRED_INVARIANTS = Object.freeze([
  'bottomAnchored',
  'clippedIsWholeLines',
  'clipsFromTopOnly',
  'crossSegmentKeepsBothSegments',
  'everyGrowthCaseOverflowed',
  'largerFontShowsFewerLines',
  'newestLineVisible',
  'noHorizontalOverflow',
  'noWindowDragRequested',
  'noWindowResizeRequested',
  'pauseRetainsCaptions',
  'rewriteDidNotGrowContent',
  'rewriteKeepsFullHypothesis',
  'viewportIsWholeLines'
])

const REQUIRED_CASE_KEYS = Object.freeze([
  'availablePx',
  'bottomAnchored',
  'clippedIsWholeLines',
  'clippedPx',
  'clipsFromTopOnly',
  'contentIsWholeLines',
  'contentPx',
  'fontSizePx',
  'id',
  'lineHeightPx',
  'newestLineVisible',
  'nodeCount',
  'noHorizontalOverflow',
  'overflowed',
  'textKind',
  'textLength',
  'viewportIsWholeLines',
  'viewportPx',
  'visibleLines'
])

const EXPECTED_FONT_SIZES = Object.freeze([24, 30, 38])
const EXPECTED_TEXT_KINDS = Object.freeze(['zh', 'en', 'mixed', 'long-word'])

function exactKeys (value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} keys must be exactly [${wanted.join(', ')}]`)
  }
}

function sha256 (value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError(`${label} must be a SHA-256 digest`)
  }
}

function positiveNumber (value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive finite number`)
  }
}

function nonNegativeNumber (value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite number`)
  }
}

function positiveInteger (value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer`)
}

function trueBoolean (value, label) {
  if (value !== true) throw new Error(`${label} must be true`)
}

function falseBoolean (value, label) {
  if (value !== false) throw new Error(`${label} must be false`)
}

function strictGeneratedAt (value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TypeError('generatedAt must be a canonical UTC ISO-8601 millisecond timestamp')
  }
  const milliseconds = Date.parse(value)
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError('generatedAt must be a real canonical UTC timestamp')
  }
}

function currentProvenance () {
  const provenance = {}
  for (const [key, relativePath] of Object.entries(PROVENANCE_FILES)) {
    provenance[key] = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(ROOT, relativePath)))
      .digest('hex')
  }
  return provenance
}

function assertCurrentProvenance (provenance) {
  const expected = currentProvenance()
  exactKeys(provenance, Object.keys(expected), 'provenance')
  for (const [key, expectedDigest] of Object.entries(expected)) {
    sha256(provenance[key], `provenance.${key}`)
    if (provenance[key] !== expectedDigest) {
      throw new Error(`caption layout provenance drifted for ${key}; re-run scripts/caption-layout-smoke.js`)
    }
  }
}

function validateCase (value, label) {
  exactKeys(value, REQUIRED_CASE_KEYS, label)
  if (typeof value.id !== 'string' || !/^[a-z-]+@\d+$/.test(value.id)) {
    throw new TypeError(`${label}.id must look like <kind>@<fontSize>`)
  }
  if (!EXPECTED_TEXT_KINDS.includes(value.textKind)) {
    throw new Error(`${label}.textKind must be one of ${EXPECTED_TEXT_KINDS.join(', ')}`)
  }
  positiveNumber(value.fontSizePx, `${label}.fontSizePx`)
  positiveNumber(value.lineHeightPx, `${label}.lineHeightPx`)
  positiveInteger(value.visibleLines, `${label}.visibleLines`)
  positiveNumber(value.availablePx, `${label}.availablePx`)
  positiveNumber(value.viewportPx, `${label}.viewportPx`)
  positiveNumber(value.contentPx, `${label}.contentPx`)
  nonNegativeNumber(value.clippedPx, `${label}.clippedPx`)
  positiveInteger(value.nodeCount, `${label}.nodeCount`)
  positiveInteger(value.textLength, `${label}.textLength`)

  if (value.viewportPx > value.availablePx + 0.6) {
    throw new Error(`${label} viewport must never exceed the available caption height`)
  }
  if (Math.abs(value.viewportPx - value.visibleLines * value.lineHeightPx) > 0.6) {
    throw new Error(`${label} viewport must be an exact whole-line multiple`)
  }

  for (const key of [
    'bottomAnchored', 'clippedIsWholeLines', 'clipsFromTopOnly', 'contentIsWholeLines',
    'newestLineVisible', 'noHorizontalOverflow', 'viewportIsWholeLines'
  ]) {
    trueBoolean(value[key], `${label}.${key}`)
  }
  if (typeof value.overflowed !== 'boolean') throw new TypeError(`${label}.overflowed must be a boolean`)
}

function validateCaptionLayoutReport (report) {
  exactKeys(report, [
    'boundaries', 'cases', 'fixture', 'gateStatus', 'generatedAt',
    'intents', 'invariants', 'provenance', 'result', 'schema'
  ], 'caption layout report')

  if (report.schema !== SCHEMA) throw new Error(`schema must be ${SCHEMA}`)
  strictGeneratedAt(report.generatedAt)
  if (report.result !== 'pass') throw new Error('result must be pass')
  /* 上限固定为 partial：最小宿主不启产品组合根，也不做人工视觉验收。 */
  if (report.gateStatus !== 'partial') throw new Error('gateStatus must be partial')

  exactKeys(report.boundaries, REQUIRED_BOUNDARIES, 'boundaries')
  for (const key of REQUIRED_BOUNDARIES) falseBoolean(report.boundaries[key], `boundaries.${key}`)

  exactKeys(report.fixture, [
    'caseCount', 'corpusSha256', 'fontSizes', 'growthSteps',
    'textKinds', 'windowHeight', 'windowWidth'
  ], 'fixture')
  sha256(report.fixture.corpusSha256, 'fixture.corpusSha256')
  if (!Array.isArray(report.fixture.fontSizes) ||
    report.fixture.fontSizes.length !== EXPECTED_FONT_SIZES.length ||
    report.fixture.fontSizes.some((size, index) => size !== EXPECTED_FONT_SIZES[index])) {
    throw new Error(`fixture.fontSizes must be exactly [${EXPECTED_FONT_SIZES.join(', ')}]`)
  }
  if (!Array.isArray(report.fixture.textKinds) ||
    report.fixture.textKinds.length !== EXPECTED_TEXT_KINDS.length ||
    EXPECTED_TEXT_KINDS.some((kind) => !report.fixture.textKinds.includes(kind))) {
    throw new Error(`fixture.textKinds must cover exactly ${EXPECTED_TEXT_KINDS.join(', ')}`)
  }
  positiveInteger(report.fixture.growthSteps, 'fixture.growthSteps')
  positiveInteger(report.fixture.caseCount, 'fixture.caseCount')
  positiveInteger(report.fixture.windowWidth, 'fixture.windowWidth')
  positiveInteger(report.fixture.windowHeight, 'fixture.windowHeight')

  assertCurrentProvenance(report.provenance)

  exactKeys(report.intents, ['dragEnd', 'dragStart', 'mouseThrough', 'resizeEnd', 'resizeStart'], 'intents')
  for (const key of ['dragEnd', 'dragStart', 'resizeEnd', 'resizeStart']) {
    if (report.intents[key] !== 0) {
      throw new Error(`intents.${key} must be 0; caption content must never move or resize the window`)
    }
  }
  if (!Number.isSafeInteger(report.intents.mouseThrough) || report.intents.mouseThrough < 0) {
    throw new TypeError('intents.mouseThrough must be a non-negative integer')
  }

  exactKeys(report.invariants, REQUIRED_INVARIANTS, 'invariants')
  for (const key of REQUIRED_INVARIANTS) trueBoolean(report.invariants[key], `invariants.${key}`)

  if (!Array.isArray(report.cases) || report.cases.length !== report.fixture.caseCount) {
    throw new Error('cases must match fixture.caseCount')
  }
  const expectedMatrix = EXPECTED_FONT_SIZES.length * EXPECTED_TEXT_KINDS.length
  if (report.cases.length < expectedMatrix) {
    throw new Error(`cases must cover the full ${expectedMatrix}-case font-size × text-kind matrix`)
  }
  const ids = new Set()
  for (const [index, item] of report.cases.entries()) {
    validateCase(item, `cases[${index}]`)
    if (ids.has(item.id)) throw new Error(`duplicate case id ${item.id}`)
    ids.add(item.id)
  }
  for (const fontSize of EXPECTED_FONT_SIZES) {
    for (const kind of EXPECTED_TEXT_KINDS) {
      if (!ids.has(`${kind}@${fontSize}`)) throw new Error(`missing matrix case ${kind}@${fontSize}`)
    }
  }
  for (const id of ['rewrite@30', 'cross-segment@30', 'pause@30']) {
    if (!ids.has(id)) throw new Error(`missing scenario case ${id}`)
  }

  const rendered = JSON.stringify(report)
  if (/[A-Za-z]:[\\/]/.test(rendered)) throw new Error('caption layout report must not contain absolute paths')

  return report
}

function readAndValidateCaptionLayoutReport (reportPath) {
  const resolved = path.resolve(reportPath)
  return validateCaptionLayoutReport(
    parseStrictEvidenceJson(fs.readFileSync(resolved), `caption layout report ${path.basename(resolved)}`)
  )
}

if (require.main === module) {
  if (process.argv.length !== 3) throw new Error('usage: node scripts/verify-caption-layout-report.js <report.json>')
  const report = readAndValidateCaptionLayoutReport(process.argv[2])
  process.stdout.write(JSON.stringify({
    gateStatus: report.gateStatus,
    result: report.result,
    caseCount: report.fixture.caseCount
  }) + '\n')
}

module.exports = {
  EXPECTED_FONT_SIZES,
  EXPECTED_TEXT_KINDS,
  PROVENANCE_FILES,
  readAndValidateCaptionLayoutReport,
  validateCaptionLayoutReport
}
