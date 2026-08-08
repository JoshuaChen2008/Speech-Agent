'use strict'

/*
 * SEM-F20 / J15a visible DWM review protocol.
 *
 * This module is intentionally pure: it validates CLI inputs, bounded artifact
 * paths, operator hand-off evidence, provenance and the frozen 36-combination
 * matrix without opening Electron, audio devices, models or the network.
 */

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { parseStrictEvidenceJson } = require('./strict-evidence-json')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const ARTIFACT_ROOT = path.join(PROJECT_ROOT, '.artifacts')

const SCALE_PERCENTS = Object.freeze([100, 125, 150, 200])
const THEMES = Object.freeze(['dark', 'light', 'high-contrast'])
const BACKGROUNDS = Object.freeze(['white-document', 'dark-video', 'complex-desktop'])
const OPERATOR_CHECKS = Object.freeze([
  'transparentSurfaceHasNoBlackBackground',
  'textReadable',
  'newestLineComplete',
  'topEdgeHasNoPartialLine',
  'noHorizontalMotionOrScrollbar',
  'boundsStayedFixed'
])

const PROVENANCE_FILES = Object.freeze({
  appearanceSha256: 'src/ui/shared/appearance.js',
  captionContractSha256: 'src/contracts/caption-event.js',
  captionContractSharedSha256: 'src/contracts/shared.js',
  captionMarkupSha256: 'src/caption/index.html',
  captionRendererManifestSha256: 'src/renderer-dist/manifest.json',
  captionPreloadSha256: 'src/preload/caption.js',
  captionPreloadSharedSha256: 'src/preload/shared.js',
  captionReducerSha256: 'src/ui/shared/caption-reducer.js',
  captionRendererSha256: 'src/caption/caption.ts',
  captionStyleSha256: 'src/caption/caption.css',
  channelsSha256: 'src/main/ipc/channels.js',
  completionCliSha256: 'scripts/complete-caption-visual-review.js',
  configStoreSha256: 'src/main/services/config-store.js',
  mainSha256: 'src/main.js',
  matrixSummarizerSha256: 'scripts/summarize-caption-visual-review-matrix.js',
  matrixVerifierSha256: 'scripts/verify-caption-visual-review-matrix.js',
  observationVerifierSha256: 'scripts/verify-caption-visual-review-report.js',
  packageLockSha256: 'package-lock.json',
  protocolSha256: 'scripts/caption-visual-review-protocol.js',
  runnerSha256: 'scripts/caption-visual-review.js',
  strictEvidenceJsonSha256: 'scripts/strict-evidence-json.js',
  tokensSha256: 'src/ui/shared/tokens.css'
})

const EXPECTED_COMBINATIONS = Object.freeze(SCALE_PERCENTS.flatMap((scalePercent) =>
  THEMES.flatMap((theme) => BACKGROUNDS.map((background) =>
    Object.freeze({ scalePercent, theme, background })
  ))
))

function assertPlainRecord (value, label) {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  const prototype = Object.getPrototypeOf(value)
  assert.ok(prototype === Object.prototype || prototype === null, `${label} must be a plain object`)
}

function assertExactKeys (value, keys, label) {
  assertPlainRecord(value, label)
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has missing or unknown fields`)
}

function assertNonNegativeInteger (value, label) {
  assert.equal(typeof value, 'number', `${label} must be a number`)
  assert.ok(Number.isSafeInteger(value) && value >= 0, `${label} must be a non-negative safe integer`)
}

function assertPositiveInteger (value, label) {
  assertNonNegativeInteger(value, label)
  assert.ok(value > 0, `${label} must be positive`)
}

function assertSha256 (value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  assert.match(value, /^[a-f0-9]{64}$/, `${label} must be a SHA-256 digest`)
}

function assertCombination (value, label = 'combination') {
  assertExactKeys(value, ['background', 'scalePercent', 'theme'], label)
  assert.ok(SCALE_PERCENTS.includes(value.scalePercent), `${label}.scalePercent is invalid`)
  assert.ok(THEMES.includes(value.theme), `${label}.theme is invalid`)
  assert.ok(BACKGROUNDS.includes(value.background), `${label}.background is invalid`)
  return value
}

function combinationKey (value) {
  assertCombination(value)
  return `${value.scalePercent}|${value.theme}|${value.background}`
}

function inspectSafeEvidenceValue (value, keyPath = 'evidence') {
  if (typeof value === 'string') {
    assert.doesNotMatch(value, /(?:[A-Za-z]:[\\/]|^\\\\|file:\/\/|\/(?:Users|home|tmp|var|etc|mnt)\/)/i,
      `${keyPath} must not expose a local path`)
    assert.doesNotMatch(value, /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)(?:$|[?#\s])/i,
      `${keyPath} must not reference an audio file`)
    assert.doesNotMatch(value, /^data:audio\//i, `${keyPath} must not embed audio data`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectSafeEvidenceValue(entry, `${keyPath}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    assert.doesNotMatch(key,
      /^(?:text|captionText|transcript|transcriptText|deviceId|deviceLabel|deviceName|displayId|displayName|localPath|modelPath|audioPath|audioFile|pcm|samples|absoluteTime|clockOffset)$/i,
      `${keyPath}.${key} is a forbidden sensitive field`)
    inspectSafeEvidenceValue(nested, `${keyPath}.${key}`)
  }
}

function isWithin (parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function artifactPath (value, label, suffix = null) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} requires a path`)
  const resolved = path.resolve(PROJECT_ROOT, value)
  if (!isWithin(ARTIFACT_ROOT, resolved)) throw new Error(`${label} must stay under .artifacts`)
  if (suffix !== null && !resolved.endsWith(suffix)) throw new Error(`${label} must end with ${suffix}`)
  return resolved
}

function collectObservationFiles (root) {
  if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('observations must name an existing directory')
  }
  const realRoot = fs.realpathSync(root)
  const files = []

  function visit (directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('observation directories must not contain symbolic links')
      if (entry.isDirectory()) {
        visit(entryPath)
      } else if (entry.isFile() && entry.name.endsWith('.observation.json')) {
        const realFile = fs.realpathSync(entryPath)
        if (!isWithin(realRoot, realFile)) throw new Error('observation file escaped its evidence directory')
        files.push(realFile)
      }
    }
  }

  visit(realRoot)
  files.sort((left, right) => left.localeCompare(right, 'en'))
  return files
}

function readValueFlag (argv, index, flag) {
  const value = argv[index + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
  return value
}

function parseRunnerArguments (argv) {
  const options = {
    workDir: null,
    report: null,
    completion: null,
    scalePercent: null,
    theme: null,
    background: null,
    crossScaleMove: false,
    timeoutSeconds: 600
  }
  const valueFlags = new Set([
    '--work-dir', '--report', '--completion', '--scale-percent', '--theme', '--background', '--timeout-seconds'
  ])
  const booleanFlags = new Set(['--cross-scale-move'])
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!valueFlags.has(flag) && !booleanFlags.has(flag)) throw new Error(`Unknown argument: ${flag}`)
    if (seen.has(flag)) throw new Error(`${flag} must be provided at most once`)
    seen.add(flag)
    if (booleanFlags.has(flag)) {
      options.crossScaleMove = true
      continue
    }
    const value = readValueFlag(argv, index, flag)
    index += 1
    if (flag === '--work-dir') options.workDir = value
    else if (flag === '--report') options.report = value
    else if (flag === '--completion') options.completion = value
    else if (flag === '--scale-percent') options.scalePercent = Number(value)
    else if (flag === '--theme') options.theme = value
    else if (flag === '--background') options.background = value
    else options.timeoutSeconds = Number(value)
  }

  if (!SCALE_PERCENTS.includes(options.scalePercent)) {
    throw new Error(`--scale-percent must be one of ${SCALE_PERCENTS.join(', ')}`)
  }
  if (!THEMES.includes(options.theme)) throw new Error(`--theme must be one of ${THEMES.join(', ')}`)
  if (!BACKGROUNDS.includes(options.background)) {
    throw new Error(`--background must be one of ${BACKGROUNDS.join(', ')}`)
  }
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 60 || options.timeoutSeconds > 1800) {
    throw new Error('--timeout-seconds must be an integer between 60 and 1800')
  }

  options.workDir = artifactPath(options.workDir, '--work-dir')
  options.report = artifactPath(options.report, '--report', '.observation.json')
  options.completion = artifactPath(options.completion, '--completion', '.completion.json')
  if (!isWithin(options.workDir, options.report) || !isWithin(options.workDir, options.completion)) {
    throw new Error('--report and --completion must stay inside --work-dir')
  }
  if (options.report === options.completion) throw new Error('--report and --completion must be distinct')
  return options
}

function parseCompletionArguments (argv) {
  const options = {
    completion: null,
    scalePercent: null,
    theme: null,
    background: null,
    confirmed: false
  }
  const valueFlags = new Set(['--completion', '--scale-percent', '--theme', '--background'])
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!valueFlags.has(flag) && flag !== '--confirm-observed') throw new Error(`Unknown argument: ${flag}`)
    if (seen.has(flag)) throw new Error(`${flag} must be provided at most once`)
    seen.add(flag)
    if (flag === '--confirm-observed') {
      options.confirmed = true
      continue
    }
    const value = readValueFlag(argv, index, flag)
    index += 1
    if (flag === '--completion') options.completion = value
    else if (flag === '--scale-percent') options.scalePercent = Number(value)
    else if (flag === '--theme') options.theme = value
    else options.background = value
  }
  assertCombination({
    scalePercent: options.scalePercent,
    theme: options.theme,
    background: options.background
  }, 'completion combination')
  if (!options.confirmed) throw new Error('--confirm-observed is required')
  options.completion = artifactPath(options.completion, '--completion', '.completion.json')
  return options
}

function parseMatrixArguments (argv) {
  const options = { observations: null, report: null }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!['--observations', '--report'].includes(flag)) throw new Error(`Unknown argument: ${flag}`)
    if (seen.has(flag)) throw new Error(`${flag} must be provided at most once`)
    seen.add(flag)
    const value = readValueFlag(argv, index, flag)
    index += 1
    if (flag === '--observations') options.observations = value
    else options.report = value
  }
  options.observations = artifactPath(options.observations, '--observations')
  options.report = artifactPath(options.report, '--report', '.matrix.json')
  if (options.observations === options.report) throw new Error('--observations and --report must be distinct')
  return options
}

function buildOperatorCompletion (combination) {
  assertCombination(combination)
  return {
    schemaVersion: 1,
    kind: 'caption-visual-review-operator-completion',
    combination: { ...combination },
    observed: true,
    checks: Object.fromEntries(OPERATOR_CHECKS.map((key) => [key, true]))
  }
}

function parseOperatorCompletion (bytes, expectedCombination = null) {
  const value = parseStrictEvidenceJson(bytes, 'caption visual review operator completion')
  inspectSafeEvidenceValue(value)
  assertExactKeys(value, ['checks', 'combination', 'kind', 'observed', 'schemaVersion'], 'operator completion')
  assert.equal(value.schemaVersion, 1)
  assert.equal(value.kind, 'caption-visual-review-operator-completion')
  assert.equal(value.observed, true, 'operator completion must explicitly record observed=true')
  assertCombination(value.combination, 'operator completion.combination')
  if (expectedCombination !== null) {
    assert.equal(combinationKey(value.combination), combinationKey(expectedCombination),
      'operator completion combination must match the running observation')
  }
  assertExactKeys(value.checks, OPERATOR_CHECKS, 'operator completion.checks')
  for (const key of OPERATOR_CHECKS) assert.equal(value.checks[key], true, `operator completion.checks.${key} must be true`)
  return value
}

function sha256File (relativePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(PROJECT_ROOT, relativePath))).digest('hex')
}

function currentProvenance () {
  return Object.fromEntries(Object.entries(PROVENANCE_FILES).map(([key, relativePath]) => [key, sha256File(relativePath)]))
}

function candidateSha256 (provenance) {
  assertExactKeys(provenance, Object.keys(PROVENANCE_FILES), 'provenance')
  for (const [key, digest] of Object.entries(provenance)) assertSha256(digest, `provenance.${key}`)
  return crypto.createHash('sha256').update(JSON.stringify(provenance)).digest('hex')
}

function assertCurrentProvenance (provenance) {
  const expected = currentProvenance()
  assertExactKeys(provenance, Object.keys(expected), 'provenance')
  for (const [key, digest] of Object.entries(expected)) {
    assertSha256(provenance[key], `provenance.${key}`)
    assert.equal(provenance[key], digest, `caption visual review provenance drifted for ${key}`)
  }
  return provenance
}

function scalePercentForFactor (scaleFactor) {
  if (typeof scaleFactor !== 'number' || !Number.isFinite(scaleFactor) || scaleFactor <= 0) {
    throw new TypeError('screen scaleFactor must be a positive finite number')
  }
  return Math.round(scaleFactor * 100)
}

module.exports = {
  ARTIFACT_ROOT,
  BACKGROUNDS,
  EXPECTED_COMBINATIONS,
  OPERATOR_CHECKS,
  PROJECT_ROOT,
  PROVENANCE_FILES,
  SCALE_PERCENTS,
  THEMES,
  artifactPath,
  assertCombination,
  assertCurrentProvenance,
  assertExactKeys,
  assertNonNegativeInteger,
  assertPlainRecord,
  assertPositiveInteger,
  assertSha256,
  buildOperatorCompletion,
  candidateSha256,
  collectObservationFiles,
  combinationKey,
  currentProvenance,
  inspectSafeEvidenceValue,
  isWithin,
  parseCompletionArguments,
  parseMatrixArguments,
  parseOperatorCompletion,
  parseRunnerArguments,
  scalePercentForFactor
}
