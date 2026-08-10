'use strict'

/*
 * Shared, pure protocol for the executable I2 interaction scenarios.
 *
 * The Electron runner owns real media/worker/UI work.  This module owns the
 * report shape, privacy boundary, transport snapshots and operator hand-off files,
 * so all of those can be unit-tested without launching Electron or touching a
 * microphone, loopback device, speaker, network or desktop window.
 */

const assert = require('node:assert/strict')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')
const { IDENTITY_VERSION: PRODUCT_PAYLOAD_IDENTITY_VERSION } = require('../src/main/services/product-payload-identity')

const LEGACY_SCENARIOS = Object.freeze(['pause-refine', 'worker-crash-retry', 'dwm-drag'])
const RECOVERY_SCENARIOS = Object.freeze(['device-removal-retry', 'sleep-wake-retry'])
const SCENARIOS = Object.freeze([...LEGACY_SCENARIOS, ...RECOVERY_SCENARIOS])
const SOURCES = Object.freeze(['loopback', 'mic'])
const DWM_SCALE_PERCENTS = Object.freeze([100, 125, 150, 200])
const DWM_THEMES = Object.freeze(['dark', 'light', 'high-contrast'])
const DWM_COMBINATIONS = Object.freeze(DWM_SCALE_PERCENTS.flatMap((scalePercent) =>
  DWM_THEMES.map((theme) => Object.freeze({ scalePercent, theme }))))
const DWM_TOOLBAR_STATES = Object.freeze(['quiet', 'attention', 'session-status-notice'])
const DWM_RESIZE_TARGETS = Object.freeze([
  'north-edge', 'east-edge', 'south-edge', 'west-edge',
  'north-east-corner', 'south-east-corner', 'south-west-corner', 'north-west-corner'
])
const DWM_NORMAL_WINDOW_ROLES = Object.freeze(['settings', 'history'])
const DWM_V3_OBSERVATION_IDS = Object.freeze([
  'caption-left-drag',
  'caption-center-drag',
  'caption-right-drag',
  'caption-multiline-blank-drag',
  'caption-stationary-press-release',
  'transparent-margin-through',
  ...DWM_TOOLBAR_STATES.map((state) => `toolbar-${state}`),
  ...DWM_RESIZE_TARGETS.map((target) => `resize-${target}`),
  'grip-unlocked',
  'grip-locked',
  'locked-caption-through',
  'settings-foreground-titlebar',
  'settings-body-controls-static',
  'history-foreground-titlebar',
  'history-body-controls-static',
  'foreground-demotion',
  'titlebar-neutral-structure'
])
const DWM_V6_BASE_OBSERVATION_IDS = Object.freeze(
  DWM_V3_OBSERVATION_IDS.map((id) => id === 'grip-unlocked' ? 'grip-unlocked-hidden' : id)
)
const DWM_LIFECYCLE_OBSERVATION_IDS = Object.freeze([
  'application-taskbar-restore',
  'caption-stationary-restore-hit',
  'caption-post-restore-drag',
  'locked-caption-post-restore-through'
])
const DWM_STABILITY_OBSERVATION_IDS = Object.freeze([
  'toolbar-edge-repeat-stability',
  'post-geometry-pointer-rehit',
  'post-restore-toolbar-near-drag-stability'
])
const DWM_OBSERVATION_IDS = Object.freeze([
  ...DWM_V6_BASE_OBSERVATION_IDS,
  ...DWM_LIFECYCLE_OBSERVATION_IDS,
  ...DWM_STABILITY_OBSERVATION_IDS
])
const DWM_OBSERVATION_CHECKLIST = Object.freeze({
  'caption-left-drag': 'Press the left ordinary drag region of the visible caption card, move the pointer, and verify the caption and docked toolbar follow continuously without resizing.',
  'caption-center-drag': 'Press the center ordinary drag region of the visible caption card, move the pointer, and verify the caption and docked toolbar follow continuously without resizing.',
  'caption-right-drag': 'Press the right ordinary drag region of the visible caption card, move the pointer, and verify the caption and docked toolbar follow continuously without resizing.',
  'caption-multiline-blank-drag': 'With multiline captions visible, press a blank ordinary drag region inside the card, move the pointer, and verify continuous caption and toolbar movement.',
  'caption-stationary-press-release': 'Press and release an ordinary caption drag region without moving the pointer and verify neither window bounds nor toolbar docking changes.',
  'transparent-margin-through': 'Press through the transparent 20 DIP caption margin and verify the desktop target receives the interaction while caption bounds stay unchanged.',
  'toolbar-quiet': 'In the quiet toolbar state, verify the entire visible toolbar contour owns pointer interaction and every visible control remains responsive.',
  'toolbar-attention': 'In the attention toolbar state, verify the entire visible toolbar contour owns pointer interaction and every visible control remains responsive.',
  'toolbar-session-status-notice': 'With the session-status notice visible, verify the entire expanded toolbar contour owns pointer interaction and every visible control remains responsive.',
  'resize-north-edge': 'Drag only the caption card north 8px resize band and verify a north-edge resize without moving the opposite edge or toolbar docking unexpectedly.',
  'resize-east-edge': 'Drag only the caption card east 8px resize band and verify an east-edge resize without moving the opposite edge or toolbar docking unexpectedly.',
  'resize-south-edge': 'Drag only the caption card south 8px resize band and verify a south-edge resize without moving the opposite edge or toolbar docking unexpectedly.',
  'resize-west-edge': 'Drag only the caption card west 8px resize band and verify a west-edge resize without moving the opposite edge or toolbar docking unexpectedly.',
  'resize-north-east-corner': 'Drag only the caption card north-east 8px corner and verify the expected two-axis resize without unexpected toolbar drift.',
  'resize-south-east-corner': 'Drag only the caption card south-east 8px corner and verify the expected two-axis resize without unexpected toolbar drift.',
  'resize-south-west-corner': 'Drag only the caption card south-west 8px corner and verify the expected two-axis resize without unexpected toolbar drift.',
  'resize-north-west-corner': 'Drag only the caption card north-west 8px corner and verify the expected two-axis resize without unexpected toolbar drift.',
  'grip-unlocked-hidden': 'With captions unlocked, verify the six-dot toolbar grip is absent from the toolbar layout; repeatedly operate its former area and verify no toolbar drag starts, caption bounds remain stable, and the caption card ordinary drag region still moves the caption and toolbar together.',
  'grip-locked': 'With captions locked, press the visible six-dot toolbar grip, move the pointer, and verify only the toolbar moves while the caption remains stationary and mouse-through.',
  'locked-caption-through': 'With captions locked, press through the visible caption card and verify the underlying desktop target receives the interaction.',
  'settings-foreground-titlebar': 'Drag Settings from a non-interactive point in its 48px titlebar and verify it is promoted above the overlays while focused.',
  'settings-body-controls-static': 'Interact with Settings titlebar controls and body controls and verify none starts a window drag.',
  'history-foreground-titlebar': 'Drag Caption History from a non-interactive point in its 48px titlebar and verify it is promoted above the overlays while focused.',
  'history-body-controls-static': 'Interact with Caption History titlebar controls and body controls and verify none starts a window drag.',
  'foreground-demotion': 'Move focus away from Settings and Caption History and verify each returns from the temporary overlay layer.',
  'titlebar-neutral-structure': 'In the selected theme, verify Settings and Caption History share the neutral titlebar surface and divider without using a status color.',
  'application-taskbar-restore': 'Minimize the toolbar through the Windows taskbar, restore it from the taskbar, and verify the previous visible window set, bounds, and foreground ordering return.',
  'caption-stationary-restore-hit': 'Before minimizing, leave the pointer over an ordinary caption drag region; after taskbar restore do not move it, then verify the next primary press is received by the caption.',
  'caption-post-restore-drag': 'Immediately after taskbar restore, start a fresh caption drag and verify continuous caption and docked-toolbar movement without resuming the pre-minimize gesture.',
  'locked-caption-post-restore-through': 'Lock captions, minimize and restore through the taskbar, then verify the caption remains mouse-through and the toolbar contour remains interactive.',
  'toolbar-edge-repeat-stability': 'Exercise the toolbar top contour, right contour, top-adjacent ordinary caption drag lane, and right-adjacent ordinary caption drag lane. In each of the four named zones perform at least 20 press/move/release repetitions (80 total), include non-zero 1-2 DIP pointer jitter in every zone, and verify zero resize, unchanged caption width and height, stable toolbar docking, and responsive toolbar buttons.',
  'post-geometry-pointer-rehit': 'After each of these four geometry settlements—caption resize, unlocked caption-card combined drag, locked toolbar-only grip drag, and unlock/redock—leave the pointer stationary and verify the next press uses the new geometry, with toolbar controls still responsive.',
  'post-restore-toolbar-near-drag-stability': 'Minimize and restore through the Windows taskbar with the pointer left in a toolbar-adjacent ordinary caption drag lane. Without moving the pointer first, press and drag there; verify caption width and height stay unchanged, toolbar docking does not drift, and toolbar buttons remain responsive.'
})
const TRANSPORT_FIELDS = Object.freeze([
  'capturedFrames', 'sentFrames', 'ingestedFrames', 'droppedFrames',
  'creditStalls', 'maxQueuedMsObserved', 'acknowledgedFrames',
  'lostInFlightFrames', 'portReplacements', 'queuedFramesAtStop',
  'queuedMsAtStop', 'discardedAtStop', 'sequenceGapCount', 'missedFrames',
  'badSampleTypeFrames', 'droppedCaptionCount'
])
const LOSS_FIELDS = Object.freeze([
  'droppedFrames', 'lostInFlightFrames', 'sequenceGapCount', 'missedFrames',
  'badSampleTypeFrames', 'droppedCaptionCount'
])
const PROGRESS_STATES = Object.freeze([
  'starting', 'ready-for-dwm-drag', 'awaiting-operator-completion', 'completed', 'failed'
])
const RECOVERY_PROGRESS_STATES = Object.freeze([
  'starting', 'awaiting-device-removal', 'awaiting-system-suspend', 'fault-observed',
  'awaiting-operator-completion', 'operator-completion-observed', 'retrying', 'completed', 'failed'
])
const RECOVERY_FAULT_CODES = Object.freeze({
  'device-removal-retry': 'AUDIO_TRACK_ENDED',
  'sleep-wake-retry': 'SYSTEM_SUSPEND'
})
const RECOVERY_OPERATOR_ACTIONS = Object.freeze({
  'device-removal-retry': 'device-restored-after-removal',
  'sleep-wake-retry': 'system-resumed-after-sleep'
})
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const DWM_LEGACY_LIMITATIONS = Object.freeze([
  'This interaction report does not attest physical device removal or OS sleep/wake.',
  'No captured audio, transcript text, device name, model path, or local audio path is persisted in this evidence.'
])
const DWM_V3_LIMITATIONS = Object.freeze([
  'Operator completion records one visible scale and theme combination only and cannot independently produce pass.',
  'Current I2 acceptance requires the strict twelve-combination matrix and a bound J17 product-shell report.',
  'No captured audio, transcript text, device name, model path, local audio path, geometry, coordinate, or absolute monotonic time is persisted in this evidence.'
])
const DWM_V4_LIMITATIONS = Object.freeze([
  'Operator completion records one visible scale and theme combination only and cannot independently produce pass.',
  'Current I2 acceptance requires the strict twelve-combination schema-v4 matrix and a bound schema-v7 J17 product-shell report.',
  'No captured audio, transcript text, device name, model path, local audio path, geometry, coordinate, or absolute monotonic time is persisted in this evidence.'
])
const DWM_V5_LIMITATIONS = Object.freeze([
  'Operator completion records one visible scale and theme combination only and cannot independently produce pass.',
  'Current I2 acceptance requires the strict twelve-combination schema-v5 matrix and a bound schema-v7 J17 product-shell report.',
  'No captured audio, transcript text, device name, model path, local audio path, geometry, coordinate, or absolute monotonic time is persisted in this evidence.'
])
const DWM_V6_LIMITATIONS = Object.freeze([
  'Operator completion records one visible scale and theme combination only and cannot independently produce pass.',
  'Current I2 acceptance requires the strict twelve-combination schema-v6 matrix and a bound schema-v8 J17 product-shell report.',
  'No captured audio, transcript text, device name, model path, local audio path, geometry, coordinate, or absolute monotonic time is persisted in this evidence.'
])

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

function assertNullableNonNegativeInteger (value, label) {
  if (value === null) return
  assertNonNegativeInteger(value, label)
}

function assertIsoTimestamp (value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  assert.match(value, ISO_TIMESTAMP_PATTERN, `${label} must be canonical UTC ISO time`)
  const epoch = Date.parse(value)
  assert.ok(Number.isFinite(epoch) && new Date(epoch).toISOString() === value, `${label} must be valid ISO time`)
}

function inspectSafeValue (value, keyPath = 'report') {
  if (typeof value === 'string') {
    assert.doesNotMatch(value, /(?:[A-Za-z]:[\\/]|^\\\\|file:\/\/|\/(?:Users|home|tmp|var|etc|mnt)\/)/i,
      `${keyPath} must not expose a local path`)
    assert.doesNotMatch(value, /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)(?:$|[?#\s])/i,
      `${keyPath} must not reference an audio file`)
    assert.doesNotMatch(value, /^data:audio\//i, `${keyPath} must not embed audio data`)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => inspectSafeValue(entry, `${keyPath}[${index}]`))
    return
  }
  if (!value || typeof value !== 'object') return
  for (const [key, nested] of Object.entries(value)) {
    assert.doesNotMatch(key,
      /^(?:capturedPcmBase64|pcm(?:16)?Base64|samples|audioBase64|audioFile|audioFilePath|transcript|transcriptText|captionText|joinedFinalText|joinedRefinedText|deviceLabel|deviceName|localPath|modelDir|modelPath|text|x|y|top|right|bottom|left|width|height|rect|bounds|coordinates|screenPosition|windowPosition|toolbarRect|absoluteMonotonicTime|clockOffset|displayId)$/i,
      `${keyPath}.${key} is a forbidden sensitive field`)
    inspectSafeValue(nested, `${keyPath}.${key}`)
  }
}

function assertSafeInteractionValue (value) {
  inspectSafeValue(value)
  const serialized = JSON.stringify(value)
  assert.doesNotMatch(serialized,
    /(?:"text"\s*:|captionArrivals|capturedPcmBase64|pcm16Base64|deviceLabel|modelDir|modelPath)/i,
    'interaction evidence must contain no caption text, PCM, device label or model path')
}

function parseArguments (argv) {
  const options = {
    scenario: null,
    source: null,
    report: null,
    progress: null,
    completion: null,
    physicalMicPreflight: null,
    scalePercent: null,
    theme: null,
    crossScaleFromPercent: null,
    timeoutSeconds: 90
  }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!['--scenario', '--source', '--report', '--progress', '--completion', '--physical-mic-preflight',
      '--scale-percent', '--theme', '--cross-scale-from-percent', '--timeout-seconds'].includes(flag)) {
      throw new Error(`Unknown argument: ${flag}`)
    }
    if (seen.has(flag)) throw new Error(`${flag} must be provided at most once`)
    seen.add(flag)
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} requires a value`)
    index += 1
    if (flag === '--scenario') options.scenario = value
    else if (flag === '--source') options.source = value
    else if (flag === '--report') options.report = value
    else if (flag === '--progress') options.progress = value
    else if (flag === '--completion') options.completion = value
    else if (flag === '--physical-mic-preflight') options.physicalMicPreflight = value
    else if (flag === '--scale-percent') options.scalePercent = Number(value)
    else if (flag === '--theme') options.theme = value
    else if (flag === '--cross-scale-from-percent') options.crossScaleFromPercent = Number(value)
    else options.timeoutSeconds = Number(value)
  }
  if (!SCENARIOS.includes(options.scenario)) throw new Error(`--scenario must be one of ${SCENARIOS.join(', ')}`)
  if (!SOURCES.includes(options.source)) throw new Error('--source must be loopback or mic')
  if (typeof options.report !== 'string' || options.report.trim().length === 0) throw new Error('--report is required')
  if (!Number.isInteger(options.timeoutSeconds) || options.timeoutSeconds < 15 || options.timeoutSeconds > 180) {
    throw new Error('--timeout-seconds must be an integer between 15 and 180')
  }
  if (options.source === 'mic' && !options.physicalMicPreflight) {
    throw new Error('--physical-mic-preflight is required for controlled mic interaction scenarios')
  }
  if (options.source === 'loopback' && options.physicalMicPreflight !== null) {
    throw new Error('--physical-mic-preflight is only valid with --source mic')
  }
  const operatorScenario = options.scenario === 'dwm-drag' || RECOVERY_SCENARIOS.includes(options.scenario)
  if (operatorScenario && (!options.progress || !options.completion)) {
    throw new Error(`${options.scenario} requires both --progress and --completion`)
  }
  if (!operatorScenario && (options.progress || options.completion)) {
    throw new Error('--progress and --completion are only valid for operator interaction scenarios')
  }
  if (options.scenario === 'dwm-drag') {
    if (!DWM_SCALE_PERCENTS.includes(options.scalePercent) || !DWM_THEMES.includes(options.theme)) {
      throw new Error('dwm-drag requires --scale-percent 100|125|150|200 and --theme dark|light|high-contrast')
    }
    if (options.crossScaleFromPercent !== null &&
        (!DWM_SCALE_PERCENTS.includes(options.crossScaleFromPercent) ||
          options.crossScaleFromPercent === options.scalePercent)) {
      throw new Error('--cross-scale-from-percent must be a different supported scale')
    }
  } else if (options.scalePercent !== null || options.theme !== null || options.crossScaleFromPercent !== null) {
    throw new Error('DWM scale and theme arguments are only valid for dwm-drag')
  }
  return options
}

function numberOrNull (value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function transportSnapshot (diagnostics, sourceId) {
  if (!SOURCES.includes(sourceId)) throw new TypeError('sourceId must be loopback or mic')
  const capture = diagnostics?.capture?.[sourceId] || {}
  const worker = diagnostics?.worker || {}
  const source = worker?.sources?.[sourceId] || {}
  return {
    capturedFrames: numberOrNull(capture.capturedFrames),
    sentFrames: numberOrNull(capture.sentFrames),
    ingestedFrames: numberOrNull(source.framesIngested),
    droppedFrames: numberOrNull(capture.droppedFrames),
    creditStalls: numberOrNull(capture.creditStalls),
    maxQueuedMsObserved: numberOrNull(capture.maxQueuedMsObserved),
    acknowledgedFrames: numberOrNull(capture.acknowledgedFrames),
    lostInFlightFrames: numberOrNull(capture.lostInFlightFrames),
    portReplacements: numberOrNull(capture.portReplacements),
    queuedFramesAtStop: numberOrNull(capture.queuedFrames),
    queuedMsAtStop: numberOrNull(capture.queuedMs),
    discardedAtStop: numberOrNull(capture.discardedAtStop),
    sequenceGapCount: numberOrNull(source.sequenceGapCount),
    missedFrames: numberOrNull(source.missedFrames),
    badSampleTypeFrames: numberOrNull(worker.badSampleTypeFrames ?? source.badSampleTypeFrames),
    droppedCaptionCount: numberOrNull(diagnostics?.droppedCaptionCount)
  }
}

function transportDelta (before, after, comparable) {
  validateTransportSnapshot(before, 'before transport')
  validateTransportSnapshot(after, 'after transport')
  if (!comparable) return null
  return Object.fromEntries(TRANSPORT_FIELDS.map((field) => {
    const beforeValue = before[field]
    const afterValue = after[field]
    return [field, beforeValue === null || afterValue === null ? null : afterValue - beforeValue]
  }))
}

function validateTransportSnapshot (value, label) {
  assertExactKeys(value, TRANSPORT_FIELDS, label)
  for (const field of TRANSPORT_FIELDS) assertNullableNonNegativeInteger(value[field], `${label}.${field}`)
}

function assertSha256 (value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  assert.match(value, SHA256_PATTERN, `${label} must be lowercase SHA-256`)
}

function validateDwmCombination (value, label = 'DWM combination') {
  assertExactKeys(value, ['scalePercent', 'theme'], label)
  assert.ok(DWM_SCALE_PERCENTS.includes(value.scalePercent), `${label}.scalePercent is invalid`)
  assert.ok(DWM_THEMES.includes(value.theme), `${label}.theme is invalid`)
  return value
}

function validateDwmConfirmations (confirmations, observationIds = DWM_OBSERVATION_IDS) {
  assert.ok(Array.isArray(confirmations), 'DWM observations must be an array')
  assert.equal(confirmations.length, observationIds.length, 'DWM observations are missing or duplicated')
  const seen = new Set()
  for (const id of confirmations) {
    assert.ok(observationIds.includes(id), `DWM observation is unknown: ${id}`)
    assert.equal(seen.has(id), false, `DWM observation is duplicated: ${id}`)
    seen.add(id)
  }
  for (const id of observationIds) assert.equal(seen.has(id), true, `DWM observation is missing: ${id}`)
}

function completeDwmLifecycleChecks () {
  return {
    taskbarRestoreObserved: true,
    stationaryPointerHitObserved: true,
    postRestoreCaptionDragObserved: true,
    lockedCaptionPassedThroughAfterRestore: true
  }
}

function validateDwmLifecycleChecks (value, label = 'DWM lifecycle') {
  assertExactKeys(value, [
    'taskbarRestoreObserved',
    'stationaryPointerHitObserved',
    'postRestoreCaptionDragObserved',
    'lockedCaptionPassedThroughAfterRestore'
  ], label)
  for (const [key, observed] of Object.entries(value)) {
    assert.equal(observed, true, `${label}.${key} must be true`)
  }
  return value
}

function completeDwmStabilityChecks () {
  return {
    toolbarEdgeRepeatStableObserved: true,
    postGeometryPointerRehitObserved: true,
    postRestoreToolbarNearDragStableObserved: true
  }
}

function validateDwmStabilityChecks (value, label = 'DWM stability') {
  assertExactKeys(value, [
    'toolbarEdgeRepeatStableObserved',
    'postGeometryPointerRehitObserved',
    'postRestoreToolbarNearDragStableObserved'
  ], label)
  for (const [key, observed] of Object.entries(value)) {
    assert.equal(observed, true, `${label}.${key} must be true`)
  }
  return value
}

function completeDwmChecks () {
  return {
    caption: {
      leftImmediateContinuousDrag: true,
      centerImmediateContinuousDrag: true,
      rightImmediateContinuousDrag: true,
      multilineBlankImmediateContinuousDrag: true,
      stationaryPressReleaseBoundsUnchanged: true,
      transparentMarginPassedThrough: true
    },
    toolbarStates: DWM_TOOLBAR_STATES.map((state) => ({
      state,
      contourDidNotStartCaptionDrag: true,
      adjacentCaptionStartedDrag: true
    })),
    resizeTargets: DWM_RESIZE_TARGETS.map((target) => ({ target, resizePrecededDrag: true })),
    grip: {
      unlockedGripHidden: true,
      unlockedGripDidNotStartDrag: true,
      lockedOnlyGripStartedDrag: true,
      lockedGripMovedToolbarOnly: true,
      lockedCaptionPassedThrough: true,
      lockedCaptionResizeDisabled: true
    },
    normalWindows: DWM_NORMAL_WINDOW_ROLES.map((role) => ({
      role,
      focusedAboveOverlays: true,
      blurRestoredNormalLayer: true,
      titlebarDraggable: true,
      bodyDidNotDrag: true,
      controlsDidNotDrag: true
    })),
    titlebar: {
      settingsStructurallyDistinct: true,
      historyStructurallyDistinct: true,
      sharedNeutralTreatment: true,
      notReadAsRuntimeState: true
    }
  }
}

function completeLegacyDwmChecks () {
  const checks = completeDwmChecks()
  checks.grip = {
    unlockedOnlyGripStartedDrag: true,
    unlockedGripMovedCaptionToolbarPair: true,
    lockedOnlyGripStartedDrag: true,
    lockedGripMovedToolbarOnly: true,
    lockedCaptionPassedThrough: true,
    lockedCaptionResizeDisabled: true
  }
  return checks
}

function validateDwmChecks (value, label = 'DWM checks', schemaVersion = 6) {
  assertExactKeys(value, ['caption', 'toolbarStates', 'resizeTargets', 'grip', 'normalWindows', 'titlebar'], label)
  assertExactKeys(value.caption, [
    'leftImmediateContinuousDrag', 'centerImmediateContinuousDrag', 'rightImmediateContinuousDrag',
    'multilineBlankImmediateContinuousDrag', 'stationaryPressReleaseBoundsUnchanged',
    'transparentMarginPassedThrough'
  ], `${label}.caption`)
  for (const [key, observed] of Object.entries(value.caption)) {
    assert.equal(observed, true, `${label}.caption.${key} must be true`)
  }
  assert.ok(Array.isArray(value.toolbarStates), `${label}.toolbarStates must be an array`)
  assert.equal(value.toolbarStates.length, DWM_TOOLBAR_STATES.length, `${label}.toolbarStates is incomplete`)
  value.toolbarStates.forEach((entry, index) => {
    assertExactKeys(entry, ['state', 'contourDidNotStartCaptionDrag', 'adjacentCaptionStartedDrag'],
      `${label}.toolbarStates[${index}]`)
    assert.equal(entry.state, DWM_TOOLBAR_STATES[index])
    assert.equal(entry.contourDidNotStartCaptionDrag, true)
    assert.equal(entry.adjacentCaptionStartedDrag, true)
  })
  assert.ok(Array.isArray(value.resizeTargets), `${label}.resizeTargets must be an array`)
  assert.equal(value.resizeTargets.length, DWM_RESIZE_TARGETS.length, `${label}.resizeTargets is incomplete`)
  value.resizeTargets.forEach((entry, index) => {
    assertExactKeys(entry, ['target', 'resizePrecededDrag'], `${label}.resizeTargets[${index}]`)
    assert.equal(entry.target, DWM_RESIZE_TARGETS[index])
    assert.equal(entry.resizePrecededDrag, true)
  })
  const gripKeys = schemaVersion >= 6
    ? [
        'unlockedGripHidden', 'unlockedGripDidNotStartDrag',
        'lockedOnlyGripStartedDrag', 'lockedGripMovedToolbarOnly',
        'lockedCaptionPassedThrough', 'lockedCaptionResizeDisabled'
      ]
    : [
        'unlockedOnlyGripStartedDrag', 'unlockedGripMovedCaptionToolbarPair',
        'lockedOnlyGripStartedDrag', 'lockedGripMovedToolbarOnly',
        'lockedCaptionPassedThrough', 'lockedCaptionResizeDisabled'
      ]
  assertExactKeys(value.grip, gripKeys, `${label}.grip`)
  for (const [key, observed] of Object.entries(value.grip)) assert.equal(observed, true, `${label}.grip.${key} must be true`)
  assert.ok(Array.isArray(value.normalWindows), `${label}.normalWindows must be an array`)
  assert.equal(value.normalWindows.length, DWM_NORMAL_WINDOW_ROLES.length, `${label}.normalWindows is incomplete`)
  value.normalWindows.forEach((entry, index) => {
    assertExactKeys(entry, [
      'role', 'focusedAboveOverlays', 'blurRestoredNormalLayer',
      'titlebarDraggable', 'bodyDidNotDrag', 'controlsDidNotDrag'
    ], `${label}.normalWindows[${index}]`)
    assert.equal(entry.role, DWM_NORMAL_WINDOW_ROLES[index])
    for (const key of ['focusedAboveOverlays', 'blurRestoredNormalLayer', 'titlebarDraggable', 'bodyDidNotDrag', 'controlsDidNotDrag']) {
      assert.equal(entry[key], true, `${label}.normalWindows[${index}].${key} must be true`)
    }
  })
  assertExactKeys(value.titlebar, [
    'settingsStructurallyDistinct', 'historyStructurallyDistinct',
    'sharedNeutralTreatment', 'notReadAsRuntimeState'
  ], `${label}.titlebar`)
  for (const [key, observed] of Object.entries(value.titlebar)) assert.equal(observed, true, `${label}.titlebar.${key} must be true`)
  return value
}

function validateDwmCrossScale (value, label = 'DWM crossScale') {
  assertExactKeys(value, ['observed', 'criticalHitMatrixRepeated'], label)
  assert.equal(typeof value.observed, 'boolean')
  assert.equal(typeof value.criticalHitMatrixRepeated, 'boolean')
  assert.equal(value.criticalHitMatrixRepeated, value.observed,
    `${label}.criticalHitMatrixRepeated must match observed`)
  return value
}

function validateProductPayloadBinding (value, label = 'product payload') {
  assert.equal(value.productPayloadVersion, PRODUCT_PAYLOAD_IDENTITY_VERSION, `${label} version is invalid`)
  assertNonNegativeInteger(value.productPayloadFileCount, `${label}.productPayloadFileCount`)
  assert.ok(value.productPayloadFileCount > 0, `${label}.productPayloadFileCount must be positive`)
  assertSha256(value.productPayloadSha256, `${label}.productPayloadSha256`)
}

function dwmOperatorCompletion ({
  confirmations,
  runBindingSha256,
  productPayloadVersion,
  productPayloadFileCount,
  productPayloadSha256,
  combination,
  crossScaleObserved = false
}) {
  validateDwmConfirmations(confirmations)
  const completion = {
    schemaVersion: 6,
    kind: 'i2-dwm-drag-operator-completion',
    scenario: 'dwm-drag',
    runBindingSha256,
    productPayloadVersion,
    productPayloadFileCount,
    productPayloadSha256,
    combination: { ...combination },
    observed: true,
    checks: completeDwmChecks(),
    lifecycle: completeDwmLifecycleChecks(),
    stability: completeDwmStabilityChecks(),
    crossScale: {
      observed: crossScaleObserved === true,
      criticalHitMatrixRepeated: crossScaleObserved === true
    }
  }
  validateDwmOperatorCompletion(completion)
  return completion
}

function buildDwmProgress ({
  sourceId,
  state,
  transport,
  operatorCompletionObserved,
  runBindingSha256,
  productPayloadVersion,
  productPayloadFileCount,
  productPayloadSha256,
  combination
}) {
  if (!SOURCES.includes(sourceId)) throw new TypeError('progress sourceId is invalid')
  if (!PROGRESS_STATES.includes(state)) throw new TypeError('progress state is invalid')
  validateTransportSnapshot(transport.before, 'progress transport.before')
  validateTransportSnapshot(transport.after, 'progress transport.after')
  if (transport.delta !== null) validateTransportDelta(transport.delta, 'progress transport.delta')
  const progress = {
    schemaVersion: 6,
    kind: 'i2-dwm-drag-progress',
    scenario: 'dwm-drag',
    sourceId,
    state,
    runBindingSha256,
    productPayloadVersion,
    productPayloadFileCount,
    productPayloadSha256,
    combination: { ...combination },
    operatorCompletionObserved: operatorCompletionObserved === true,
    transport
  }
  return validateDwmProgress(progress)
}

function validateTransportDelta (value, label) {
  assertExactKeys(value, TRANSPORT_FIELDS, label)
  for (const field of TRANSPORT_FIELDS) {
    const entry = value[field]
    if (entry === null) continue
    assert.equal(typeof entry, 'number', `${label}.${field} must be number or null`)
    assert.ok(Number.isSafeInteger(entry), `${label}.${field} must be a safe integer`)
  }
}

function validateDwmProgress (value) {
  assertSafeInteractionValue(value)
  if (value?.schemaVersion === 1) {
    assertExactKeys(value, [
      'schemaVersion', 'kind', 'scenario', 'sourceId', 'state', 'operatorCompletionObserved', 'transport'
    ], 'legacy DWM progress')
    assert.equal(value.kind, 'i2-dwm-drag-progress')
    assert.equal(value.scenario, 'dwm-drag')
    assert.ok(SOURCES.includes(value.sourceId))
    assert.ok(PROGRESS_STATES.includes(value.state))
    assert.equal(typeof value.operatorCompletionObserved, 'boolean')
    assertExactKeys(value.transport, ['comparison', 'before', 'after', 'delta'], 'legacy DWM progress.transport')
    assert.equal(value.transport.comparison, 'same-capture-generation')
    validateTransportSnapshot(value.transport.before, 'legacy DWM progress.transport.before')
    validateTransportSnapshot(value.transport.after, 'legacy DWM progress.transport.after')
    validateTransportDelta(value.transport.delta, 'legacy DWM progress.transport.delta')
    return value
  }
  assertExactKeys(value, [
    'schemaVersion', 'kind', 'scenario', 'sourceId', 'state', 'runBindingSha256',
    'productPayloadVersion', 'productPayloadFileCount', 'productPayloadSha256',
    'combination', 'operatorCompletionObserved', 'transport'
  ], 'DWM progress')
  assert.ok([3, 4, 5, 6].includes(value.schemaVersion), 'DWM progress schemaVersion must be 3, 4, 5 or 6')
  assert.equal(value.kind, 'i2-dwm-drag-progress')
  assert.equal(value.scenario, 'dwm-drag')
  assert.ok(SOURCES.includes(value.sourceId))
  assert.ok(PROGRESS_STATES.includes(value.state))
  assertSha256(value.runBindingSha256, 'DWM progress.runBindingSha256')
  validateProductPayloadBinding(value, 'DWM progress product payload')
  validateDwmCombination(value.combination, 'DWM progress.combination')
  assert.equal(typeof value.operatorCompletionObserved, 'boolean')
  assertExactKeys(value.transport, ['comparison', 'before', 'after', 'delta'], 'DWM progress.transport')
  assert.equal(value.transport.comparison, 'same-capture-generation')
  validateTransportSnapshot(value.transport.before, 'DWM progress.transport.before')
  validateTransportSnapshot(value.transport.after, 'DWM progress.transport.after')
  validateTransportDelta(value.transport.delta, 'DWM progress.transport.delta')
  return value
}

function parseOperatorCompletion (bytes) {
  const value = parseStrictEvidenceJson(bytes, 'DWM operator completion')
  assertSafeInteractionValue(value)
  if (value?.schemaVersion === 1) {
    assertExactKeys(value, ['schemaVersion', 'kind', 'scenario', 'observed'], 'legacy DWM operator completion')
    assert.equal(value.kind, 'i2-dwm-drag-operator-completion')
    assert.equal(value.scenario, 'dwm-drag')
    assert.equal(value.observed, true, 'operator completion must explicitly record observed=true')
    return value
  }
  return validateDwmOperatorCompletion(value)
}

function validateDwmOperatorCompletion (value) {
  assertSafeInteractionValue(value)
  const schemaVersion = value?.schemaVersion
  assertExactKeys(value, [
    'schemaVersion', 'kind', 'scenario', 'runBindingSha256',
    'productPayloadVersion', 'productPayloadFileCount', 'productPayloadSha256',
    'combination', 'observed', 'checks',
    ...(schemaVersion >= 4 ? ['lifecycle'] : []),
    ...(schemaVersion >= 5 ? ['stability'] : []),
    'crossScale'
  ], 'DWM operator completion')
  assert.ok([3, 4, 5, 6].includes(schemaVersion), 'DWM operator completion schemaVersion must be 3, 4, 5 or 6')
  assert.equal(value.kind, 'i2-dwm-drag-operator-completion')
  assert.equal(value.scenario, 'dwm-drag')
  assertSha256(value.runBindingSha256, 'DWM operator completion.runBindingSha256')
  validateProductPayloadBinding(value, 'DWM operator completion product payload')
  validateDwmCombination(value.combination, 'DWM operator completion.combination')
  assert.equal(value.observed, true, 'operator completion must explicitly record observed=true')
  validateDwmChecks(value.checks, 'DWM operator completion.checks', schemaVersion)
  if (schemaVersion >= 4) validateDwmLifecycleChecks(value.lifecycle, 'DWM operator completion.lifecycle')
  if (schemaVersion >= 5) validateDwmStabilityChecks(value.stability, 'DWM operator completion.stability')
  validateDwmCrossScale(value.crossScale, 'DWM operator completion.crossScale')
  return value
}

function buildRecoveryProgress ({
  scenario,
  sourceId,
  state,
  faultCodeObserved = null,
  captureReleased = false,
  automaticReacquireObserved = false,
  operatorCompletionObserved = false,
  retryIssued = false,
  captionsAfterRetry = 0
}) {
  const progress = {
    schemaVersion: 1,
    kind: 'i2-recovery-progress',
    scenario,
    sourceId,
    state,
    faultCodeObserved,
    captureReleased,
    automaticReacquireObserved,
    operatorCompletionObserved,
    retryIssued,
    captionsAfterRetry
  }
  return validateRecoveryProgress(progress)
}

function validateRecoveryProgress (value) {
  assertSafeInteractionValue(value)
  assertExactKeys(value, [
    'schemaVersion', 'kind', 'scenario', 'sourceId', 'state', 'faultCodeObserved',
    'captureReleased', 'automaticReacquireObserved', 'operatorCompletionObserved',
    'retryIssued', 'captionsAfterRetry'
  ], 'recovery progress')
  assert.equal(value.schemaVersion, 1)
  assert.equal(value.kind, 'i2-recovery-progress')
  assert.ok(RECOVERY_SCENARIOS.includes(value.scenario), 'recovery progress scenario is invalid')
  assert.ok(SOURCES.includes(value.sourceId), 'recovery progress source is invalid')
  assert.ok(RECOVERY_PROGRESS_STATES.includes(value.state), 'recovery progress state is invalid')
  if (value.faultCodeObserved !== null) {
    assert.equal(value.faultCodeObserved, RECOVERY_FAULT_CODES[value.scenario])
  }
  for (const key of [
    'captureReleased', 'automaticReacquireObserved', 'operatorCompletionObserved', 'retryIssued'
  ]) assert.equal(typeof value[key], 'boolean', `recovery progress.${key} must be boolean`)
  assertNonNegativeInteger(value.captionsAfterRetry, 'recovery progress.captionsAfterRetry')
  return value
}

function recoveryOperatorCompletion ({ scenario }) {
  if (!RECOVERY_SCENARIOS.includes(scenario)) throw new TypeError('recovery completion scenario is invalid')
  return {
    schemaVersion: 1,
    kind: 'i2-recovery-operator-completion',
    scenario,
    action: RECOVERY_OPERATOR_ACTIONS[scenario],
    observed: true
  }
}

function parseRecoveryOperatorCompletion (bytes, expectedScenario = null) {
  const value = parseStrictEvidenceJson(bytes, 'I2 recovery operator completion')
  assertSafeInteractionValue(value)
  assertExactKeys(value, ['schemaVersion', 'kind', 'scenario', 'action', 'observed'],
    'I2 recovery operator completion')
  assert.equal(value.schemaVersion, 1)
  assert.equal(value.kind, 'i2-recovery-operator-completion')
  assert.ok(RECOVERY_SCENARIOS.includes(value.scenario), 'recovery completion scenario is invalid')
  if (expectedScenario !== null) assert.equal(value.scenario, expectedScenario)
  assert.equal(value.action, RECOVERY_OPERATOR_ACTIONS[value.scenario])
  assert.equal(value.observed, true, 'operator completion must explicitly record observed=true')
  return value
}

function buildInteractionReport ({
  executedAt,
  scenario,
  sourceId,
  result,
  runtime,
  counts,
  scenarioEvidence,
  transport,
  deviceRecovery
}) {
  const recoveryReport = RECOVERY_SCENARIOS.includes(scenario)
  const dwmReport = scenario === 'dwm-drag'
  return {
    schemaVersion: dwmReport ? 6 : (recoveryReport ? 2 : 1),
    kind: 'i2-live-interaction',
    executedAt,
    scenario,
    sourceId,
    result,
    runtime,
    counts,
    scenarioEvidence,
    transport,
    deviceRecovery,
    privacy: {
      capturedAudioPersisted: false,
      reportContainsTranscriptText: false,
      reportContainsAudioPath: false,
      reportContainsDeviceName: false
    },
    limitations: dwmReport
      ? [...DWM_V6_LIMITATIONS]
      : recoveryReport
      ? [
          'Operator completion records the external action only and cannot independently produce pass.',
          'No captured audio, transcript text, device name, model path, or local audio path is persisted in this evidence.'
        ]
      : [
          'This interaction report does not attest physical device removal or OS sleep/wake.',
          'No captured audio, transcript text, device name, model path, or local audio path is persisted in this evidence.'
        ]
  }
}

function validateRuntime (runtime) {
  assertExactKeys(runtime, ['modelId', 'profile', 'vad', 'refinement', 'sqliteSessionRecorder'], 'runtime')
  assert.equal(runtime.modelId, 'x-asr-160ms')
  assert.equal(runtime.profile, 'fast')
  assert.equal(runtime.vad, 'silero')
  assert.equal(runtime.refinement, 'x-asr-offline')
  assert.equal(runtime.sqliteSessionRecorder, true)
}

function validateCounts (counts) {
  assertExactKeys(counts, ['captions', 'partials', 'finals', 'refined'], 'counts')
  for (const field of Object.keys(counts)) assertNonNegativeInteger(counts[field], `counts.${field}`)
  assert.equal(counts.captions, counts.partials + counts.finals + counts.refined)
}

function validateDeviceRecovery (value, scenario, result) {
  assertExactKeys(value, [
    'simulatedTrackEnded', 'actualOsDeviceRemoval', 'actualSystemSleepWake', 'networkRecoveryNotApplicable'
  ], 'deviceRecovery')
  for (const key of Object.keys(value)) assert.equal(typeof value[key], 'boolean', `deviceRecovery.${key} must be boolean`)
  assert.equal(value.simulatedTrackEnded, false)
  assert.equal(value.networkRecoveryNotApplicable, true)
  if (!RECOVERY_SCENARIOS.includes(scenario)) {
    assert.equal(value.actualOsDeviceRemoval, false)
    assert.equal(value.actualSystemSleepWake, false)
    return
  }
  if (result === 'pass' && scenario === 'device-removal-retry') {
    assert.equal(value.actualOsDeviceRemoval, true)
    assert.equal(value.actualSystemSleepWake, false)
  } else if (result === 'pass') {
    assert.equal(value.actualOsDeviceRemoval, false)
    assert.equal(value.actualSystemSleepWake, true)
  }
}

function validateInteractionTransport (transport, scenario, result) {
  assertExactKeys(transport, ['comparison', 'before', 'after', 'delta'], 'transport')
  const expectedComparison = scenario === 'worker-crash-retry' || RECOVERY_SCENARIOS.includes(scenario)
    ? 'cross-recovery-generation'
    : 'same-capture-generation'
  assert.equal(transport.comparison, expectedComparison)
  validateTransportSnapshot(transport.before, 'transport.before')
  validateTransportSnapshot(transport.after, 'transport.after')
  if (expectedComparison === 'same-capture-generation') {
    validateTransportDelta(transport.delta, 'transport.delta')
  } else {
    assert.equal(transport.delta, null, 'cross-generation transport delta must not pretend to be comparable')
  }
  if (result === 'pass' || result === 'pass-manual-observed') {
    assertNonNegativeInteger(transport.after.capturedFrames, 'transport.after.capturedFrames')
    assert.ok(transport.after.capturedFrames > 0, 'transport.after.capturedFrames must be positive')
    assertNonNegativeInteger(transport.after.sentFrames, 'transport.after.sentFrames')
    for (const field of LOSS_FIELDS) assert.equal(transport.after[field], 0, `transport.after.${field} must be zero`)
    if (RECOVERY_SCENARIOS.includes(scenario)) {
      assertNonNegativeInteger(transport.before.capturedFrames, 'transport.before.capturedFrames')
      assert.ok(transport.before.capturedFrames > 0, 'transport.before.capturedFrames must be positive')
      assertNonNegativeInteger(transport.before.sentFrames, 'transport.before.sentFrames')
      for (const field of LOSS_FIELDS) assert.equal(transport.before[field], 0, `transport.before.${field} must be zero`)
    }
  }
}

function validateDwmScenarioEvidence (value, result, schemaVersion) {
  assertExactKeys(value, [
    'mode', 'rendererAssets', 'manualSetBounds', 'runBindingSha256',
    'operatorCompletionObserved', 'operatorCompletionSha256', 'combination', 'checks', 'crossScale',
    ...(schemaVersion >= 4 ? ['lifecycle'] : []),
    ...(schemaVersion >= 5 ? ['stability'] : []),
    'productPayloadVersion', 'productPayloadFileCount', 'productPayloadSha256',
    'productionReuse', 'automaticObservation', 'controllerCounts'
  ], 'scenarioEvidence')
  assert.equal(value.mode, 'production-dwm-harness')
  assert.equal(value.rendererAssets, 'caption-toolbar-settings-history')
  assert.equal(value.manualSetBounds, true)
  assertSha256(value.runBindingSha256, 'scenarioEvidence.runBindingSha256')
  assert.equal(typeof value.operatorCompletionObserved, 'boolean')
  if (value.operatorCompletionSha256 !== null) assertSha256(value.operatorCompletionSha256, 'scenarioEvidence.operatorCompletionSha256')
  validateDwmCombination(value.combination, 'scenarioEvidence.combination')
  if (value.operatorCompletionObserved) {
    validateDwmChecks(value.checks, 'scenarioEvidence.checks', schemaVersion)
    if (schemaVersion >= 4) validateDwmLifecycleChecks(value.lifecycle, 'scenarioEvidence.lifecycle')
    if (schemaVersion >= 5) validateDwmStabilityChecks(value.stability, 'scenarioEvidence.stability')
    validateDwmCrossScale(value.crossScale, 'scenarioEvidence.crossScale')
  } else {
    assert.equal(value.operatorCompletionSha256, null)
    assert.equal(value.checks, null)
    if (schemaVersion >= 4) assert.equal(value.lifecycle, null)
    if (schemaVersion >= 5) assert.equal(value.stability, null)
    assert.equal(value.crossScale, null)
  }
  validateProductPayloadBinding(value, 'scenarioEvidence product payload')

  assertExactKeys(value.productionReuse, [
    'interactionController', 'windowLayerController', 'ipcAccessPolicy',
    'windowRoles', 'preloadRoles', 'pageRoles', 'mainProcessManualBoundsUpdates',
    ...(schemaVersion >= 5
      ? ['interactionGenerationController', 'applicationWindowLifecycleController']
      : [])
  ], 'scenarioEvidence.productionReuse')
  for (const key of [
    'interactionController',
    'windowLayerController',
    'ipcAccessPolicy',
    'mainProcessManualBoundsUpdates',
    ...(schemaVersion >= 5
      ? ['interactionGenerationController', 'applicationWindowLifecycleController']
      : [])
  ]) {
    assert.equal(value.productionReuse[key], true, `scenarioEvidence.productionReuse.${key} must be true`)
  }
  for (const key of ['windowRoles', 'preloadRoles', 'pageRoles']) {
    assert.deepEqual(value.productionReuse[key], ['caption', 'toolbar', 'settings', 'history'])
  }

  assertExactKeys(value.automaticObservation, [
    'actualScaleMatched', 'systemThemeMatched', 'rendererScaleMatched',
    'displayCount', 'distinctScaleFactorCount', 'crossScaleMoveObserved',
    'fromScalePercent', 'toScalePercent'
  ], 'scenarioEvidence.automaticObservation')
  for (const key of ['actualScaleMatched', 'systemThemeMatched', 'rendererScaleMatched', 'crossScaleMoveObserved']) {
    assert.equal(typeof value.automaticObservation[key], 'boolean',
      `scenarioEvidence.automaticObservation.${key} must be boolean`)
  }
  for (const key of ['displayCount', 'distinctScaleFactorCount']) {
    assertNonNegativeInteger(value.automaticObservation[key], `scenarioEvidence.automaticObservation.${key}`)
    assert.ok(value.automaticObservation[key] <= 16, `scenarioEvidence.automaticObservation.${key} is out of range`)
  }
  assert.ok(DWM_SCALE_PERCENTS.includes(value.automaticObservation.fromScalePercent))
  assert.ok(DWM_SCALE_PERCENTS.includes(value.automaticObservation.toScalePercent))
  assert.equal(value.automaticObservation.toScalePercent, value.combination.scalePercent)
  const crossScaleObserved = value.crossScale?.observed === true
  assert.equal(value.automaticObservation.crossScaleMoveObserved, crossScaleObserved)
  if (crossScaleObserved) {
    assert.ok(value.automaticObservation.displayCount >= 2)
    assert.ok(value.automaticObservation.distinctScaleFactorCount >= 2)
    assert.ok(value.automaticObservation.distinctScaleFactorCount <= value.automaticObservation.displayCount)
    assert.notEqual(value.automaticObservation.fromScalePercent, value.automaticObservation.toScalePercent)
  } else {
    assert.equal(value.automaticObservation.fromScalePercent, value.automaticObservation.toScalePercent)
  }

  const countKeys = [
    'windowLoadCount', 'toolbarLayoutReportCount', 'captionDragStartCount',
    'captionMovedDragCount', 'captionStationaryPressReleaseCount', 'toolbarGripDragStartCount',
    'resizeStartCount', 'settingsTitlebarDragStartCount', 'historyTitlebarDragStartCount',
    'lockTransitionCount', 'focusPromotionCount', 'focusDemotionCount'
  ]
  assertExactKeys(value.controllerCounts, countKeys, 'scenarioEvidence.controllerCounts')
  for (const key of countKeys) {
    assertNonNegativeInteger(value.controllerCounts[key], `scenarioEvidence.controllerCounts.${key}`)
    assert.ok(value.controllerCounts[key] <= 1000000, `scenarioEvidence.controllerCounts.${key} is out of range`)
  }

  if (result === 'pass-manual-observed') {
    assert.equal(value.operatorCompletionObserved, true)
    assert.notEqual(value.checks, null)
    if (schemaVersion >= 4) assert.notEqual(value.lifecycle, null)
    if (schemaVersion >= 5) assert.notEqual(value.stability, null)
    assert.notEqual(value.crossScale, null)
    assertSha256(value.operatorCompletionSha256, 'scenarioEvidence.operatorCompletionSha256')
    assert.equal(value.automaticObservation.actualScaleMatched, true)
    assert.equal(value.automaticObservation.systemThemeMatched, true)
    assert.equal(value.automaticObservation.rendererScaleMatched, true)
    const minima = {
      windowLoadCount: 4,
      toolbarLayoutReportCount: 3,
      captionDragStartCount: 5,
      captionMovedDragCount: 4,
      captionStationaryPressReleaseCount: 1,
      toolbarGripDragStartCount: schemaVersion >= 6 ? 1 : 2,
      resizeStartCount: 8,
      settingsTitlebarDragStartCount: 1,
      historyTitlebarDragStartCount: 1,
      lockTransitionCount: 2,
      focusPromotionCount: 2,
      focusDemotionCount: 2
    }
    for (const [key, minimum] of Object.entries(minima)) {
      assert.ok(value.controllerCounts[key] >= minimum,
        `scenarioEvidence.controllerCounts.${key} must be at least ${minimum}`)
    }
  }
}

function validateScenarioEvidence (scenario, value, result, schemaVersion) {
  if (scenario === 'pause-refine') {
    assertExactKeys(value, [
      'pauseAcknowledged', 'resumeAcknowledged', 'finalBeforePause', 'refinementPendingAtPause',
      'refinedWhilePaused', 'refinedAfterResume'
    ], 'scenarioEvidence')
    assert.equal(typeof value.pauseAcknowledged, 'boolean')
    assert.equal(typeof value.resumeAcknowledged, 'boolean')
    assertNonNegativeInteger(value.finalBeforePause, 'scenarioEvidence.finalBeforePause')
    assertNonNegativeInteger(value.refinementPendingAtPause, 'scenarioEvidence.refinementPendingAtPause')
    assertNonNegativeInteger(value.refinedWhilePaused, 'scenarioEvidence.refinedWhilePaused')
    assertNonNegativeInteger(value.refinedAfterResume, 'scenarioEvidence.refinedAfterResume')
    if (result === 'pass') {
      assert.equal(value.pauseAcknowledged, true)
      assert.equal(value.resumeAcknowledged, true)
      assert.ok(value.finalBeforePause > 0)
      assert.ok(value.refinementPendingAtPause > 0, 'a real refinement request must still be pending at pause')
      assert.equal(value.refinedWhilePaused, 0)
      assert.ok(value.refinedAfterResume > 0)
    }
    return
  }
  if (scenario === 'worker-crash-retry') {
    assertExactKeys(value, [
      'crashMethod', 'workerExitObserved', 'retrySucceeded', 'sameSession', 'runtimeAdapterReusedAfterRetry',
      'freshWorkerGenerationAfterRetry', 'workerGenerationCount',
      'finalBeforeCrash', 'finalAfterRetry'
    ], 'scenarioEvidence')
    assert.equal(value.crashMethod, 'forced-exact-realtime-worker-termination')
    assert.equal(typeof value.workerExitObserved, 'boolean')
    assert.equal(typeof value.retrySucceeded, 'boolean')
    assert.equal(typeof value.sameSession, 'boolean')
    assert.equal(typeof value.runtimeAdapterReusedAfterRetry, 'boolean')
    assert.equal(typeof value.freshWorkerGenerationAfterRetry, 'boolean')
    assertNonNegativeInteger(value.workerGenerationCount, 'scenarioEvidence.workerGenerationCount')
    assertNonNegativeInteger(value.finalBeforeCrash, 'scenarioEvidence.finalBeforeCrash')
    assertNonNegativeInteger(value.finalAfterRetry, 'scenarioEvidence.finalAfterRetry')
    if (result === 'pass') {
      assert.equal(value.workerExitObserved, true)
      assert.equal(value.retrySucceeded, true)
      assert.equal(value.sameSession, true)
      assert.equal(value.runtimeAdapterReusedAfterRetry, true)
      assert.equal(value.freshWorkerGenerationAfterRetry, true)
      assert.ok(value.workerGenerationCount >= 2)
      assert.ok(value.finalBeforeCrash > 0)
      assert.ok(value.finalAfterRetry > 0)
    }
    return
  }
  if (RECOVERY_SCENARIOS.includes(scenario)) {
    assertExactKeys(value, [
      'faultCodeObserved', 'faultPhaseObserved', 'captureReleased', 'operatorCompletionObserved',
      'systemResumeEventObserved', 'workerGenerationCountAtFault', 'workerGenerationCountBeforeRetry',
      'workerGenerationCountAfterRetry', 'noAutomaticReacquire', 'explicitRetryIssued', 'retrySucceeded',
      'sameSession', 'runtimeAdapterReusedAfterRetry', 'freshWorkerGenerationAfterRetry',
      'captionsBeforeFault', 'captionsAfterRetry', 'finalBeforeFault', 'finalAfterRetry',
      'maxSequenceBeforeFault', 'firstSequenceAfterRetry', 'sequenceStrictlyIncreased',
      'sqliteSessionClosed', 'sqliteSourceMatched', 'sqlitePersistedSegmentCount',
      'sqlitePersistedAtLeastObservedFinals'
    ], 'scenarioEvidence')
    if (value.faultCodeObserved !== null) assert.equal(value.faultCodeObserved, RECOVERY_FAULT_CODES[scenario])
    for (const key of [
      'faultPhaseObserved', 'captureReleased', 'operatorCompletionObserved', 'systemResumeEventObserved',
      'noAutomaticReacquire', 'explicitRetryIssued', 'retrySucceeded', 'sameSession',
      'runtimeAdapterReusedAfterRetry', 'freshWorkerGenerationAfterRetry', 'sequenceStrictlyIncreased',
      'sqliteSessionClosed', 'sqliteSourceMatched', 'sqlitePersistedAtLeastObservedFinals'
    ]) assert.equal(typeof value[key], 'boolean', `scenarioEvidence.${key} must be boolean`)
    for (const key of [
      'workerGenerationCountAtFault', 'workerGenerationCountBeforeRetry', 'workerGenerationCountAfterRetry',
      'captionsBeforeFault', 'captionsAfterRetry', 'finalBeforeFault', 'finalAfterRetry',
      'maxSequenceBeforeFault', 'sqlitePersistedSegmentCount'
    ]) assertNonNegativeInteger(value[key], `scenarioEvidence.${key}`)
    assertNullableNonNegativeInteger(value.firstSequenceAfterRetry, 'scenarioEvidence.firstSequenceAfterRetry')
    if (result === 'pass') {
      assert.equal(value.faultCodeObserved, RECOVERY_FAULT_CODES[scenario])
      assert.equal(value.faultPhaseObserved, true)
      assert.equal(value.captureReleased, true)
      assert.equal(value.operatorCompletionObserved, true)
      assert.equal(value.systemResumeEventObserved, scenario === 'sleep-wake-retry')
      assert.equal(value.workerGenerationCountAtFault, value.workerGenerationCountBeforeRetry,
        'operator completion must not auto-create a worker generation')
      assert.equal(value.workerGenerationCountAfterRetry, value.workerGenerationCountBeforeRetry + 1,
        'explicit Retry must create exactly one worker generation')
      assert.equal(value.noAutomaticReacquire, true)
      assert.equal(value.explicitRetryIssued, true)
      assert.equal(value.retrySucceeded, true)
      assert.equal(value.sameSession, true)
      assert.equal(value.runtimeAdapterReusedAfterRetry, true)
      assert.equal(value.freshWorkerGenerationAfterRetry, true)
      assert.ok(value.captionsBeforeFault > 0)
      assert.ok(value.captionsAfterRetry > 0)
      assert.ok(value.finalBeforeFault > 0)
      assert.ok(value.finalAfterRetry > 0)
      assert.ok(value.maxSequenceBeforeFault > 0)
      assert.ok(value.firstSequenceAfterRetry > value.maxSequenceBeforeFault)
      assert.equal(value.sequenceStrictlyIncreased, true)
      assert.equal(value.sqliteSessionClosed, true)
      assert.equal(value.sqliteSourceMatched, true)
      assert.ok(value.sqlitePersistedSegmentCount >= value.finalBeforeFault + value.finalAfterRetry)
      assert.equal(value.sqlitePersistedAtLeastObservedFinals, true)
    }
    return
  }
  if (scenario === 'dwm-drag' && [3, 4, 5, 6].includes(schemaVersion)) {
    validateDwmScenarioEvidence(value, result, schemaVersion)
    return
  }
  assertExactKeys(value, [
    'mode', 'rendererAssets', 'manualSetBounds', 'operatorCompletionObserved'
  ], 'scenarioEvidence')
  assert.equal(value.mode, 'manual-dwm-harness')
  assert.equal(value.rendererAssets, 'caption-toolbar')
  assert.equal(value.manualSetBounds, true)
  assert.equal(typeof value.operatorCompletionObserved, 'boolean')
  if (result === 'pass-manual-observed') assert.equal(value.operatorCompletionObserved, true)
}

function validateInteractionReport (report, expectedScenario = null) {
  assertSafeInteractionValue(report)
  assertExactKeys(report, [
    'schemaVersion', 'kind', 'executedAt', 'scenario', 'sourceId', 'result', 'runtime', 'counts',
    'scenarioEvidence', 'transport', 'deviceRecovery', 'privacy', 'limitations'
  ], 'interaction report')
  assert.ok([1, 2, 3, 4, 5, 6].includes(report.schemaVersion), 'schemaVersion must be 1, 2, 3, 4, 5 or 6')
  assert.equal(report.kind, 'i2-live-interaction')
  assertIsoTimestamp(report.executedAt, 'executedAt')
  assert.ok(SCENARIOS.includes(report.scenario), 'scenario is invalid')
  if (report.schemaVersion === 1) assert.ok(LEGACY_SCENARIOS.includes(report.scenario), 'schema v1 scenario is invalid')
  if (report.schemaVersion === 2) assert.ok(RECOVERY_SCENARIOS.includes(report.scenario), 'schema v2 scenario is invalid')
  if (report.schemaVersion === 3) assert.equal(report.scenario, 'dwm-drag', 'schema v3 scenario is invalid')
  if (report.schemaVersion === 4) assert.equal(report.scenario, 'dwm-drag', 'schema v4 scenario is invalid')
  if (report.schemaVersion === 5) assert.equal(report.scenario, 'dwm-drag', 'schema v5 scenario is invalid')
  if (report.schemaVersion === 6) assert.equal(report.scenario, 'dwm-drag', 'schema v6 scenario is invalid')
  if (expectedScenario !== null) assert.equal(report.scenario, expectedScenario)
  assert.ok(SOURCES.includes(report.sourceId), 'sourceId is invalid')
  const allowedResults = report.scenario === 'dwm-drag'
    ? ['pass-manual-observed', 'inconclusive-manual-observation', 'fail']
    : ['pass', 'fail']
  assert.ok(allowedResults.includes(report.result), 'result is invalid for scenario')
  validateRuntime(report.runtime)
  validateCounts(report.counts)
  validateScenarioEvidence(report.scenario, report.scenarioEvidence, report.result, report.schemaVersion)
  validateInteractionTransport(report.transport, report.scenario, report.result)
  validateDeviceRecovery(report.deviceRecovery, report.scenario, report.result)
  assert.deepEqual(report.privacy, {
    capturedAudioPersisted: false,
    reportContainsTranscriptText: false,
    reportContainsAudioPath: false,
    reportContainsDeviceName: false
  })
  assert.deepEqual(report.limitations, report.schemaVersion === 6
    ? [...DWM_V6_LIMITATIONS]
    : report.schemaVersion === 5
    ? [...DWM_V5_LIMITATIONS]
    : report.schemaVersion === 4
    ? [...DWM_V4_LIMITATIONS]
    : report.schemaVersion === 3
    ? [...DWM_V3_LIMITATIONS]
    : report.schemaVersion === 2
    ? [
        'Operator completion records the external action only and cannot independently produce pass.',
        'No captured audio, transcript text, device name, model path, or local audio path is persisted in this evidence.'
      ]
    : [...DWM_LEGACY_LIMITATIONS])
  return report
}

module.exports = {
  DWM_COMBINATIONS,
  DWM_LIFECYCLE_OBSERVATION_IDS,
  DWM_NORMAL_WINDOW_ROLES,
  DWM_OBSERVATION_CHECKLIST,
  DWM_OBSERVATION_IDS,
  DWM_STABILITY_OBSERVATION_IDS,
  DWM_V3_OBSERVATION_IDS,
  DWM_RESIZE_TARGETS,
  DWM_SCALE_PERCENTS,
  DWM_THEMES,
  DWM_TOOLBAR_STATES,
  DWM_V3_LIMITATIONS,
  DWM_V4_LIMITATIONS,
  DWM_V5_LIMITATIONS,
  DWM_V6_LIMITATIONS,
  LOSS_FIELDS,
  RECOVERY_FAULT_CODES,
  RECOVERY_OPERATOR_ACTIONS,
  RECOVERY_PROGRESS_STATES,
  RECOVERY_SCENARIOS,
  PROGRESS_STATES,
  SCENARIOS,
  SOURCES,
  TRANSPORT_FIELDS,
  assertSafeInteractionValue,
  buildDwmProgress,
  buildInteractionReport,
  buildRecoveryProgress,
  completeDwmChecks,
  completeLegacyDwmChecks,
  completeDwmLifecycleChecks,
  completeDwmStabilityChecks,
  dwmOperatorCompletion,
  parseArguments,
  parseOperatorCompletion,
  parseRecoveryOperatorCompletion,
  recoveryOperatorCompletion,
  transportDelta,
  transportSnapshot,
  validateDwmProgress,
  validateDwmChecks,
  validateDwmLifecycleChecks,
  validateDwmStabilityChecks,
  validateDwmCombination,
  validateDwmOperatorCompletion,
  validateInteractionReport,
  validateRecoveryProgress,
  validateTransportSnapshot
}
