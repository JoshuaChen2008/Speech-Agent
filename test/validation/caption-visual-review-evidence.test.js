'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const {
  ARTIFACT_ROOT,
  EXPECTED_COMBINATIONS,
  OPERATOR_CHECKS,
  PROJECT_ROOT,
  buildOperatorCompletion,
  candidateSha256,
  currentProvenance,
  parseCompletionArguments,
  parseMatrixArguments,
  parseOperatorCompletion,
  parseRunnerArguments
} = require('../../scripts/caption-visual-review-protocol')
const {
  GEOMETRY_CHECKS,
  validateCaptionVisualReviewObservation
} = require('../../scripts/verify-caption-visual-review-report')
const {
  buildCaptionVisualReviewMatrix
} = require('../../scripts/summarize-caption-visual-review-matrix')
const {
  readAndValidateCaptionVisualReviewMatrix,
  validateCaptionVisualReviewMatrix
} = require('../../scripts/verify-caption-visual-review-matrix')

const PROVENANCE = currentProvenance()
const CANDIDATE = candidateSha256(PROVENANCE)

function clone (value) {
  return JSON.parse(JSON.stringify(value))
}

function sha256 (value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function validObservation (combination, crossScaleMove = false) {
  const fromScalePercent = crossScaleMove
    ? (combination.scalePercent === 100 ? 125 : 100)
    : combination.scalePercent
  return {
    schemaVersion: 1,
    kind: 'caption-visual-review-observation',
    result: 'pass',
    gateStatus: 'partial',
    candidateSha256: CANDIDATE,
    provenance: clone(PROVENANCE),
    combination: { ...combination },
    display: {
      browserZoomDefault: true,
      displayCount: crossScaleMove ? 2 : 1,
      distinctScaleFactorCount: crossScaleMove ? 2 : 1,
      rendererDeviceScaleMatched: true,
      systemThemeMatched: true,
      targetScaleFactorMatched: true
    },
    move: {
      requested: crossScaleMove,
      observed: crossScaleMove,
      acrossDifferentScaleFactors: crossScaleMove,
      fromScalePercent,
      toScalePercent: combination.scalePercent
    },
    geometry: Object.fromEntries(GEOMETRY_CHECKS.map((key) => [key, true])),
    window: {
      visible: true,
      transparent: true,
      focusable: false,
      frame: false
    },
    events: {
      captionEventCount: 9,
      finalEventCount: 7,
      partialEventCount: 2,
      segmentCount: 8,
      sourceCount: 1
    },
    operator: {
      observed: true,
      checks: Object.fromEntries(OPERATOR_CHECKS.map((key) => [key, true]))
    },
    boundaries: {
      audioCapture: false,
      browserZoomUsed: false,
      deviceNamesPersisted: false,
      hiddenWindow: false,
      localPathsPersisted: false,
      modelLoaded: false,
      networkAccess: false,
      physicalSourceOpened: false,
      syntheticCaptionEventsOnly: true,
      textPersisted: false
    }
  }
}

function validRecords (crossScaleIndex = 0) {
  return EXPECTED_COMBINATIONS.map((combination, index) => ({
    report: validObservation(combination, index === crossScaleIndex),
    observationSha256: sha256(`caption-visual-observation-${index}`)
  }))
}

function writeObservationBundle (root) {
  const observations = path.join(root, 'observations')
  fs.mkdirSync(observations, { recursive: true })
  const records = EXPECTED_COMBINATIONS.map((combination, index) => {
    const report = validObservation(combination, index === 0)
    const bytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`)
    fs.writeFileSync(path.join(observations, `${String(index).padStart(2, '0')}.observation.json`), bytes)
    return { report, observationSha256: sha256(bytes) }
  })
  const matrix = buildCaptionVisualReviewMatrix(records)
  const report = path.join(root, 'j15a.matrix.json')
  fs.writeFileSync(report, `${JSON.stringify(matrix, null, 2)}\n`)
  return { matrix, observations, report }
}

test('SEM-F20/J15a runner contract uses the visible production caption surface without capture boundaries', () => {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, 'scripts', 'caption-visual-review.js'), 'utf8')
  assert.equal(PROVENANCE.packageLockSha256,
    sha256(fs.readFileSync(path.join(PROJECT_ROOT, 'package-lock.json'))),
    'visual observations must bind the exact locked Electron/Chromium dependency graph')
  assert.match(source, /screen\.getAllDisplays\(\)/)
  assert.match(source, /screen\.getDisplayMatching\(/)
  assert.match(source, /\.scaleFactor/)
  assert.match(source, /app\.setPath\('userData'/)
  assert.match(source, /fs\.mkdtempSync\(path\.join\(fs\.realpathSync\(os\.tmpdir\(\)\)/)
  assert.doesNotMatch(source, /path\.join\(options\.workDir, ['"]user-data['"]\)/)
  assert.match(source, /process\.platform !== 'win32'/)
  assert.match(source, /preload:\s*path\.join\([^\n]+src[^\n]+preload[^\n]+caption\.js/)
  assert.match(source, /loadFile\(path\.join\([^\n]+src[^\n]+caption[^\n]+index\.html/)
  assert.match(source, /transparent:\s*true/)
  assert.match(source, /focusable:\s*false/)
  assert.match(source, /resizable:\s*false/)
  assert.match(source, /win\.show\(\)/)
  assert.match(source, /assertCaptionEvent\(/)
  assert.match(source, /CHANNELS\.CAPTION_EVENT/)
  assert.match(source, /getZoomFactor\(\)/)
  assert.match(source, /postCompletionChecks/)
  assert.match(source, /path\.relative\(PROJECT_ROOT, options\.completion\)/)
  assert.match(source, /new Set\(events\.map\(\(event\) => event\.segmentId\)\)\.size/)
  assert.match(source, /new Set\(events\.map\(\(event\) => event\.sourceId\)\)\.size/)
  assert.doesNotMatch(source, /setZoom(?:Factor|Level)|zoomFactor\s*:|webFrame/)
  assert.doesNotMatch(source, /setResizable\(true\)/)
  assert.doesNotMatch(source, /capturePage|offscreen\s*:/)
  assert.doesNotMatch(source, /getUserMedia\s*\(|new\s+AudioContext|mediaDevices|node:https?|require\(['"]https?['"]\)|fetch\s*\(|sherpa|model-manager/i)
})

test('SEM-F20/J15a CLI parsers bind observations and matrix reports below .artifacts', () => {
  const runner = parseRunnerArguments([
    '--work-dir', '.artifacts/j15a-visible/case-001',
    '--report', '.artifacts/j15a-visible/case-001/case-001.observation.json',
    '--completion', '.artifacts/j15a-visible/case-001/case-001.completion.json',
    '--scale-percent', '125',
    '--theme', 'dark',
    '--background', 'white-document',
    '--cross-scale-move',
    '--timeout-seconds', '120'
  ])
  assert.equal(runner.scalePercent, 125)
  assert.equal(runner.crossScaleMove, true)
  assert.ok(runner.report.startsWith(ARTIFACT_ROOT + path.sep))

  const matrix = parseMatrixArguments([
    '--observations', '.artifacts/j15a-visible',
    '--report', '.artifacts/j15a-visible/j15a.matrix.json'
  ])
  assert.ok(matrix.observations.startsWith(ARTIFACT_ROOT + path.sep))
  assert.throws(() => parseRunnerArguments([
    '--work-dir', '.artifacts/j15a-visible/case-001',
    '--report', '.artifacts/j15a-visible/case-001/case-001.observation.json',
    '--completion', '.artifacts/j15a-visible/case-001/case-001.completion.json',
    '--scale-percent', '125', '--scale-percent', '150',
    '--theme', 'dark', '--background', 'white-document'
  ]), /at most once/)
  assert.throws(() => parseRunnerArguments([
    '--work-dir', '.artifacts/j15a-visible/case-001',
    '--report', '.artifacts/j15a-visible/outside.observation.json',
    '--completion', '.artifacts/j15a-visible/case-001/case-001.completion.json',
    '--scale-percent', '125', '--theme', 'dark', '--background', 'white-document'
  ]), /inside --work-dir/)
  assert.throws(() => parseMatrixArguments([
    '--observations', '..', '--report', '.artifacts/j15a-visible/j15a.matrix.json'
  ]), /under \.artifacts/)
  assert.throws(() => parseRunnerArguments([
    '--work-dir', '.artifacts/j15a-visible/case-001',
    '--report', '.artifacts/j15a-visible/case-001/case-001.observation.json',
    '--completion', '.artifacts/j15a-visible/case-001/case-001.completion.json',
    '--scale-percent', '110', '--theme', 'dark', '--background', 'white-document'
  ]), /must be one of/)
})

test('SEM-F20/J15a operator completion is explicit, exact, and privacy bounded', () => {
  const combination = EXPECTED_COMBINATIONS[0]
  const completion = buildOperatorCompletion(combination)
  assert.deepEqual(parseOperatorCompletion(Buffer.from(JSON.stringify(completion)), combination), completion)
  assert.throws(() => parseCompletionArguments([
    '--completion', '.artifacts/j15a-visible/case.completion.json',
    '--scale-percent', '100', '--theme', 'dark', '--background', 'white-document'
  ]), /--confirm-observed is required/)
  const mismatched = clone(completion)
  mismatched.combination.background = 'dark-video'
  assert.throws(() => parseOperatorCompletion(Buffer.from(JSON.stringify(mismatched)), combination), /must match/)
  const leaked = clone(completion)
  leaked.localPath = 'C:\\private\\caption.txt'
  assert.throws(() => parseOperatorCompletion(Buffer.from(JSON.stringify(leaked)), combination), /forbidden sensitive field/)
  const duplicate = JSON.stringify(completion).replace('"observed":true', '"observed":true,"observed":true')
  assert.throws(() => parseOperatorCompletion(Buffer.from(duplicate), combination), /duplicate object key/)
})

test('SEM-F20/J15a one-observation verifier accepts only visible pass/partial evidence', () => {
  const valid = validObservation(EXPECTED_COMBINATIONS[0])
  assert.equal(validateCaptionVisualReviewObservation(valid), valid)

  for (const [label, mutate] of [
    ['complete claim', (report) => { report.gateStatus = 'visual-subgate-complete' }],
    ['hidden window', (report) => { report.window.visible = false }],
    ['hidden boundary', (report) => { report.boundaries.hiddenWindow = true }],
    ['browser zoom', (report) => { report.display.browserZoomDefault = false }],
    ['renderer scale mismatch', (report) => { report.display.rendererDeviceScaleMatched = false }],
    ['geometry failure', (report) => { report.geometry.topClipIsWholeLines = false }],
    ['operator omission', (report) => { report.operator.observed = false }],
    ['operator failure', (report) => { report.operator.checks.textReadable = false }],
    ['provenance drift', (report) => { report.provenance.runnerSha256 = '0'.repeat(64) }],
    ['text field', (report) => { report.transcriptText = 'forbidden evidence' }],
    ['device field', (report) => { report.deviceName = 'forbidden evidence' }]
  ]) {
    const report = clone(valid)
    mutate(report)
    assert.throws(() => validateCaptionVisualReviewObservation(report), undefined, label)
  }
})

test('SEM-F20/J15a one-observation verifier rejects same-display or same-scale movement substitutes', () => {
  const report = validObservation(EXPECTED_COMBINATIONS[0], true)
  assert.equal(validateCaptionVisualReviewObservation(report), report)
  for (const mutate of [
    (value) => { value.display.displayCount = 1 },
    (value) => { value.display.distinctScaleFactorCount = 1 },
    (value) => { value.move.fromScalePercent = value.move.toScalePercent },
    (value) => { value.move.observed = false }
  ]) {
    const invalid = clone(report)
    mutate(invalid)
    assert.throws(() => validateCaptionVisualReviewObservation(invalid))
  }
})

test('SEM-F20/J15a matrix requires all 36 canonical combinations and one real mixed-scale move', () => {
  const matrix = buildCaptionVisualReviewMatrix(validRecords())
  assert.equal(matrix.coverage.observationCount, 36)
  assert.equal(matrix.coverage.uniqueCombinationCount, 36)
  assert.equal(matrix.coverage.differentScaleFactorDualDisplayObserved, true)
  assert.equal(validateCaptionVisualReviewMatrix(matrix), matrix)

  assert.throws(() => buildCaptionVisualReviewMatrix(validRecords().slice(0, -1)), /exactly 36/)
  const duplicated = validRecords()
  duplicated[1].report.combination = { ...duplicated[0].report.combination }
  assert.throws(() => buildCaptionVisualReviewMatrix(duplicated), /duplicate observation combination/)
  assert.throws(() => buildCaptionVisualReviewMatrix(validRecords(-1)), /requires at least one visible move/)
})

test('SEM-F20/J15a matrix verifier rejects missing, duplicate, and cross-candidate entries', () => {
  const matrix = buildCaptionVisualReviewMatrix(validRecords())

  const missing = clone(matrix)
  missing.observations.pop()
  missing.coverage.observationCount = 35
  missing.coverage.uniqueCombinationCount = 35
  assert.throws(() => validateCaptionVisualReviewMatrix(missing), /exactly 36/)

  const duplicated = clone(matrix)
  duplicated.observations[1].combination = { ...duplicated.observations[0].combination }
  assert.throws(() => validateCaptionVisualReviewMatrix(duplicated), /missing, duplicated, or out of canonical order/)

  const crossCandidate = clone(matrix)
  crossCandidate.observations[1].candidateSha256 = 'f'.repeat(64)
  assert.throws(() => validateCaptionVisualReviewMatrix(crossCandidate), /must match the matrix candidate/)
})

test('SEM-F20/J15a matrix verifier rejects fake dual-display movement and private evidence', () => {
  const matrix = buildCaptionVisualReviewMatrix(validRecords())
  const fakeMove = clone(matrix)
  const moved = fakeMove.observations.find((entry) => entry.crossScaleMoveObserved)
  moved.displayCount = 1
  moved.distinctScaleFactorCount = 1
  moved.fromScalePercent = moved.toScalePercent
  assert.throws(() => validateCaptionVisualReviewMatrix(fakeMove), /requires at least two displays/)

  const noMove = clone(matrix)
  for (const entry of noMove.observations) {
    entry.crossScaleMoveObserved = false
    entry.fromScalePercent = entry.toScalePercent
  }
  noMove.coverage.crossScaleMoveObservationCount = 0
  noMove.coverage.differentScaleFactorDualDisplayObserved = false
  assert.throws(() => validateCaptionVisualReviewMatrix(noMove), /requires at least one visible move/)

  const leaked = clone(matrix)
  leaked.localPath = 'C:\\private\\visual-review.json'
  assert.throws(() => validateCaptionVisualReviewMatrix(leaked), /forbidden sensitive field/)
})

test('SEM-F20/J15a strict matrix reader revalidates and hash-closes all original observations', () => {
  fs.mkdirSync(ARTIFACT_ROOT, { recursive: true })
  const root = fs.mkdtempSync(path.join(ARTIFACT_ROOT, 'caption-visual-matrix-reader-'))
  try {
    const bundle = writeObservationBundle(root)
    assert.deepEqual(
      readAndValidateCaptionVisualReviewMatrix(bundle.report, bundle.observations),
      bundle.matrix
    )

    const firstObservation = path.join(bundle.observations, '00.observation.json')
    const originalBytes = fs.readFileSync(firstObservation)
    fs.writeFileSync(firstObservation, `${JSON.stringify(JSON.parse(originalBytes.toString('utf8')))}\n`)
    assert.throws(
      () => readAndValidateCaptionVisualReviewMatrix(bundle.report, bundle.observations),
      /summary does not match original observation/
    )

    fs.writeFileSync(firstObservation, originalBytes)
    fs.rmSync(firstObservation)
    assert.throws(
      () => readAndValidateCaptionVisualReviewMatrix(bundle.report, bundle.observations),
      /exactly 36 original observation files/
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
