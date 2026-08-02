'use strict'

/* J15a 布局资格的报告契约。
   这一层不启动 Electron：它证明 verifier 是 fail-closed 的，以及 CI 真的把布局
   资格排在所有重步骤之前。真实 Chromium 几何由 scripts/caption-layout-smoke.js
   在 CI 里产出，本文件只保证那份报告不能被悄悄放宽。 */

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  EXPECTED_FONT_SIZES,
  EXPECTED_TEXT_KINDS,
  PROVENANCE_FILES,
  validateCaptionLayoutReport
} = require('../../scripts/verify-caption-layout-report')

const ROOT = path.resolve(__dirname, '../..')

function currentProvenance () {
  const provenance = {}
  for (const [key, relativePath] of Object.entries(PROVENANCE_FILES)) {
    provenance[key] = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(ROOT, relativePath)))
      .digest('hex')
  }
  return provenance
}

function layoutCase (id, textKind, fontSizePx) {
  const lineHeightPx = fontSizePx * 1.35
  const visibleLines = Math.max(1, Math.floor(112 / lineHeightPx))
  return {
    id,
    textKind,
    fontSizePx,
    lineHeightPx,
    visibleLines,
    availablePx: 112,
    viewportPx: visibleLines * lineHeightPx,
    contentPx: (visibleLines + 3) * lineHeightPx,
    clippedPx: 3 * lineHeightPx,
    nodeCount: 1,
    textLength: 192,
    overflowed: true,
    viewportIsWholeLines: true,
    contentIsWholeLines: true,
    clippedIsWholeLines: true,
    clipsFromTopOnly: true,
    newestLineVisible: true,
    bottomAnchored: true,
    noHorizontalOverflow: true
  }
}

function validReport () {
  const cases = []
  for (const fontSize of EXPECTED_FONT_SIZES) {
    for (const kind of EXPECTED_TEXT_KINDS) cases.push(layoutCase(`${kind}@${fontSize}`, kind, fontSize))
  }
  cases.push(layoutCase('rewrite@30', 'mixed', 30))
  cases.push(layoutCase('cross-segment@30', 'zh', 30))
  cases.push(layoutCase('pause@30', 'zh', 30))

  return {
    schema: 'caption-layout-report@v2',
    generatedAt: '2026-08-01T12:00:00.000Z',
    result: 'pass',
    gateStatus: 'partial',
    boundaries: {
      productCompositionRoot: false,
      configBroadcastWiring: false,
      realAsrOrVad: false,
      audioCapture: false,
      humanVisualReview: false,
      dpiMatrix: false
    },
    fixture: {
      corpusSha256: 'a'.repeat(64),
      fontSizes: [...EXPECTED_FONT_SIZES],
      textKinds: [...EXPECTED_TEXT_KINDS],
      growthSteps: 6,
      caseCount: cases.length,
      windowWidth: 920,
      windowHeight: 190
    },
    provenance: currentProvenance(),
    intents: {
      captionViewportEviction: 1,
      mouseThrough: 1,
      dragStart: 0,
      dragEnd: 0,
      resizeStart: 0,
      resizeEnd: 0
    },
    invariants: {
      everyGrowthCaseOverflowed: true,
      noHorizontalOverflow: true,
      newestLineVisible: true,
      clipsFromTopOnly: true,
      bottomAnchored: true,
      viewportIsWholeLines: true,
      clippedIsWholeLines: true,
      largerFontShowsFewerLines: true,
      rewriteKeepsFullHypothesis: true,
      rewriteDidNotGrowContent: true,
      crossSegmentKeepsCurrentSegment: true,
      fullyClippedPrefixReported: true,
      lateAmendmentDoesNotRevive: true,
      pauseRetainsCaptions: true,
      noWindowResizeRequested: true,
      noWindowDragRequested: true
    },
    cases
  }
}

function rejects (mutate, expected) {
  const report = validReport()
  mutate(report)
  assert.throws(() => validateCaptionLayoutReport(report), expected)
}

test('a complete caption layout report passes the strict verifier', () => {
  const report = validateCaptionLayoutReport(validReport())
  assert.equal(report.result, 'pass')
  assert.equal(report.gateStatus, 'partial')
  assert.equal(report.cases.length, EXPECTED_FONT_SIZES.length * EXPECTED_TEXT_KINDS.length + 3)
})

test('the verifier refuses reports that claim more than a minimal host can prove', () => {
  rejects((report) => { report.gateStatus = 'pass' }, /gateStatus must be partial/)
  rejects((report) => { report.boundaries.productCompositionRoot = true }, /boundaries.productCompositionRoot must be false/)
  rejects((report) => { report.boundaries.humanVisualReview = true }, /boundaries.humanVisualReview must be false/)
  rejects((report) => { report.boundaries.realAsrOrVad = true }, /boundaries.realAsrOrVad must be false/)
})

test('the verifier refuses a report whose layout invariants did not hold', () => {
  rejects((report) => { report.result = 'fail' }, /result must be pass/)
  rejects((report) => { report.invariants.noHorizontalOverflow = false }, /invariants.noHorizontalOverflow must be true/)
  rejects((report) => { report.invariants.newestLineVisible = false }, /invariants.newestLineVisible must be true/)
  rejects((report) => { report.invariants.clipsFromTopOnly = false }, /invariants.clipsFromTopOnly must be true/)
  rejects((report) => { report.invariants.viewportIsWholeLines = false }, /invariants.viewportIsWholeLines must be true/)
  rejects((report) => { report.invariants.fullyClippedPrefixReported = false }, /invariants.fullyClippedPrefixReported must be true/)
  rejects((report) => { report.invariants.lateAmendmentDoesNotRevive = false }, /invariants.lateAmendmentDoesNotRevive must be true/)
  rejects((report) => { report.cases[0].newestLineVisible = false }, /cases\[0\].newestLineVisible must be true/)
})

test('the verifier refuses a run whose growth cases never actually overflowed', () => {
  rejects((report) => { report.invariants.everyGrowthCaseOverflowed = false },
    /invariants.everyGrowthCaseOverflowed must be true/)
})

test('the verifier refuses a viewport that is not an exact whole-line multiple', () => {
  rejects((report) => { report.cases[0].viewportPx += 7 }, /whole-line multiple/)
  rejects((report) => { report.cases[0].viewportPx = report.cases[0].availablePx + 30 },
    /viewport must never exceed the available caption height/)
})

test('the verifier refuses any caption-driven window movement or resize', () => {
  rejects((report) => { report.intents.resizeStart = 1 }, /intents.resizeStart must be 0/)
  rejects((report) => { report.intents.dragStart = 1 }, /intents.dragStart must be 0/)
  rejects((report) => { report.invariants.noWindowResizeRequested = false },
    /invariants.noWindowResizeRequested must be true/)
})

test('the verifier requires an identity-only viewport eviction observation', () => {
  rejects((report) => { report.intents.captionViewportEviction = 0 }, /must be a positive integer/)
  rejects((report) => { report.intents.captionViewportEviction = 1.5 }, /must be a positive integer/)
  rejects((report) => { report.intents.evictedText = 'leak' }, /intents keys must be exactly/)
})

test('the verifier requires the full font-size by text-kind matrix plus the three scenarios', () => {
  for (const missing of ['zh@24', 'long-word@38', 'mixed@30']) {
    rejects((report) => {
      report.cases = report.cases.filter((item) => item.id !== missing)
      report.fixture.caseCount = report.cases.length
    }, new RegExp(`missing matrix case ${missing.replace('-', '-')}`))
  }
  for (const missing of ['rewrite@30', 'cross-segment@30', 'pause@30']) {
    rejects((report) => {
      report.cases = report.cases.filter((item) => item.id !== missing)
      report.fixture.caseCount = report.cases.length
    }, new RegExp(`missing scenario case ${missing}`))
  }
  rejects((report) => { report.fixture.fontSizes = [30] }, /fixture.fontSizes must be exactly/)
  rejects((report) => { report.fixture.textKinds = ['zh'] }, /fixture.textKinds must cover exactly/)
})

test('the verifier refuses stale evidence after the caption renderer, style, or reducer changes', () => {
  for (const key of Object.keys(PROVENANCE_FILES)) {
    rejects((report) => { report.provenance[key] = 'b'.repeat(64) },
      new RegExp(`provenance drifted for ${key}`))
  }
})

test('the verifier refuses unknown, missing, or duplicated report structure', () => {
  rejects((report) => { report.extra = true }, /caption layout report keys must be exactly/)
  rejects((report) => { delete report.intents }, /caption layout report keys must be exactly/)
  rejects((report) => { report.cases[0].extra = 1 }, /cases\[0\] keys must be exactly/)
  rejects((report) => { report.cases[1].id = report.cases[0].id }, /duplicate case id/)
  rejects((report) => { report.schema = 'caption-layout-report@v1' }, /schema must be caption-layout-report@v2/)
  rejects((report) => { report.generatedAt = '2026-08-01T12:00:00Z' }, /canonical UTC ISO-8601/)
})

test('a leaked local path cannot reach the report, because unknown keys are rejected first', () => {
  /* 报告的字段集合足够窄：允许的字符串字段要么是枚举、要么是 SHA-256、要么是
     受正则约束的 case id，本身放不下路径。所以路径只可能以「多出来的调试字段」
     形式泄漏，而结构校验会先于内容校验拦下它——这正是要冻结的 fail-closed 顺序。 */
  rejects((report) => { report.leakedPath = 'D:\\A1Project\\Speech-Agent2.0' }, /keys must be exactly/)
  rejects((report) => { report.cases[0].sourcePath = '/home/runner/work/repo' }, /cases\[0\] keys must be exactly/)
})

test('CI runs the caption layout qualification before every heavy step', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  const layout = workflow.indexOf('scripts/caption-layout-smoke.js')
  const verify = workflow.indexOf('scripts/verify-caption-layout-report.js')
  assert.ok(layout > 0, 'CI must run the caption layout qualification')
  assert.ok(verify > layout, 'CI must verify the caption layout report after producing it')

  for (const heavy of [
    'scripts/db0-sqlite-smoke.js',
    'scripts/db1-storage-smoke.js',
    'scripts/storage-gateway-smoke.js',
    'scripts/product-shell-smoke.js',
    'npm run package:smoke',
    'npm run package:release',
    'scripts/qualify-nsis-lifecycle.js',
    'npm run test:ci'
  ]) {
    const index = workflow.indexOf(heavy)
    assert.ok(index > 0, `CI must still run ${heavy}`)
    assert.ok(index > verify, `caption layout qualification must run before ${heavy}`)
  }
})

test('CI uploads structured evidence even when a step fails', () => {
  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
  assert.match(workflow, /actions\/upload-artifact/)
  assert.match(workflow, /if:\s*always\(\)/)
})
