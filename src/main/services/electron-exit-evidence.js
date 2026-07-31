'use strict'

// @ts-check

/* Privacy-safe Electron process-role evidence.
   -------------------------------------------------------------------------
   This module deliberately has no filesystem responsibility. The Electron
   main process emits only fixed-enum lifecycle/incident messages; an external
   supervisor owns persistence so a native main-process exit can still be
   recorded. Never add Error objects, argv, URLs, paths, diagnostic reports,
   transcript text, PCM, PIDs or arbitrary strings to this protocol. */

const SCHEMA_VERSION = 1
const IPC_CHANNEL = 'speech-agent:electron-exit-evidence'
const MAX_INCIDENTS = 16

const APP_ROLES = Object.freeze([
  'main',
  'renderer',
  'audio-host',
  'realtime',
  'refine',
  'storage',
  'chromium-other',
  'unknown'
])

const WEB_CONTENTS_ROLE_MAP = Object.freeze({
  caption: 'renderer',
  toolbar: 'renderer',
  settings: 'renderer',
  history: 'renderer',
  renderer: 'renderer',
  'audio-host': 'audio-host'
})

const SERVICE_ROLE_MAP = Object.freeze({
  'Speech Agent realtime ASR': 'realtime',
  'Speech Agent offline refinement': 'refine',
  'Speech Agent subtitle storage': 'storage'
})

const LIFECYCLE_STAGES = Object.freeze([
  'main-started',
  'app-ready',
  'bootstrap-complete',
  'quit-requested',
  'will-quit'
])

const INCIDENT_SOURCES = Object.freeze([
  'main-exit',
  'render-process-gone',
  'child-process-gone',
  'utility-fatal',
  'preload-error',
  'unresponsive'
])

const INCIDENT_REASONS = Object.freeze([
  'clean-exit',
  'abnormal-exit',
  'killed',
  'crashed',
  'oom',
  'launch-failed',
  'integrity-failure',
  'memory-eviction',
  'fatal-v8',
  'preload-failure',
  'unresponsive',
  'unknown'
])

const STATUS_CLASSES = Object.freeze([
  'zero',
  'breakpoint-0x80000003',
  'other-nonzero',
  'not-observed'
])

const ATTRIBUTION_CONFIDENCE = Object.freeze([
  'none',
  'exact-handle',
  'exact-webcontents',
  'service-name',
  'ambiguous'
])

const OUTCOMES = Object.freeze(['clean-exit', 'abnormal-exit', 'incomplete'])
const PLATFORMS = Object.freeze(['win32', 'darwin', 'linux', 'other'])

const ROOT_KEYS = Object.freeze([
  'schemaVersion', 'kind', 'generatedAt', 'outcome', 'gateStatus', 'runtime',
  'lifecycle', 'mainExit', 'attribution', 'counters', 'incidents', 'privacy',
  'scope'
])
const RUNTIME_KEYS = Object.freeze(['electronMajor', 'platform', 'supervised'])
const LIFECYCLE_KEYS = Object.freeze([
  'mainSpawned', 'mainStarted', 'appReady', 'bootstrapComplete',
  'quitRequested', 'willQuitObserved'
])
const MAIN_EXIT_KEYS = Object.freeze(['statusClass', 'cleanIntentObserved'])
const ATTRIBUTION_KEYS = Object.freeze(['breakpointObserved', 'role', 'confidence'])
const COUNTER_KEYS = Object.freeze([
  'incidentCount', 'droppedIncidentCount', 'rendererGoneCount',
  'utilityGoneCount', 'mainExitCount', 'fatalV8Count', 'preloadErrorCount',
  'unresponsiveCount', 'rejectedIpcCount'
])
const INCIDENT_KEYS = Object.freeze(['ordinal', 'role', 'source', 'reason', 'statusClass'])
const PRIVACY_KEYS = Object.freeze([
  'audioPayloadPersisted', 'subtitleBodyPersisted', 'localAddressPersisted',
  'diagnosticDumpPersisted', 'externalUploadEnabled'
])
const SCOPE_KEYS = Object.freeze([
  'roleAttribution', 'nativeStackCaptured', 'rootCauseIdentified',
  'packagedRuntime'
])

function isPlainObject (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function hasExactKeys (value, expected) {
  if (!isPlainObject(value)) return false
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function enumValue (value, allowed, fallback = null) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback
}

function normalizePlatform (value) {
  return enumValue(value, PLATFORMS, 'other')
}

function normalizeReason (value) {
  return enumValue(value, INCIDENT_REASONS, 'unknown')
}

/**
 * Windows native status values may surface as either signed int32 or uint32.
 * Values outside those two representations are not accepted and cannot wrap
 * into the breakpoint code accidentally.
 */
function normalizeStatusClass (value) {
  if (!Number.isSafeInteger(value) || value < -0x80000000 || value > 0xFFFFFFFF) {
    return 'not-observed'
  }
  if (value === 0) return 'zero'
  if ((value >>> 0) === 0x80000003) return 'breakpoint-0x80000003'
  return 'other-nonzero'
}

function normalizeWebContentsRole (role) {
  if (typeof role !== 'string') return 'unknown'
  return WEB_CONTENTS_ROLE_MAP[role] || 'unknown'
}

function roleForChildProcess (details) {
  if (!isPlainObject(details)) return 'unknown'
  if (typeof details.serviceName === 'string' && SERVICE_ROLE_MAP[details.serviceName]) {
    return SERVICE_ROLE_MAP[details.serviceName]
  }
  if (typeof details.type === 'string') return 'chromium-other'
  return 'unknown'
}

function lifecycleEnvelope (stage) {
  const normalized = enumValue(stage, LIFECYCLE_STAGES)
  if (!normalized) throw new TypeError('invalid evidence lifecycle stage')
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    channel: IPC_CHANNEL,
    event: Object.freeze({ kind: 'lifecycle', stage: normalized })
  })
}

function incidentEnvelope (incident) {
  if (!isPlainObject(incident)) throw new TypeError('invalid evidence incident')
  const role = enumValue(incident.role, APP_ROLES)
  const source = enumValue(incident.source, INCIDENT_SOURCES)
  const reason = enumValue(incident.reason, INCIDENT_REASONS)
  const statusClass = enumValue(incident.statusClass, STATUS_CLASSES)
  if (!role || !source || !reason || !statusClass) {
    throw new TypeError('invalid evidence incident enum')
  }
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    channel: IPC_CHANNEL,
    event: Object.freeze({ kind: 'incident', role, source, reason, statusClass })
  })
}

function validateIpcEnvelope (value) {
  if (!hasExactKeys(value, ['schemaVersion', 'channel', 'event']) ||
      value.schemaVersion !== SCHEMA_VERSION || value.channel !== IPC_CHANNEL ||
      !isPlainObject(value.event)) {
    throw new TypeError('invalid evidence IPC envelope')
  }
  if (value.event.kind === 'lifecycle') {
    if (!hasExactKeys(value.event, ['kind', 'stage']) ||
        !LIFECYCLE_STAGES.includes(value.event.stage)) {
      throw new TypeError('invalid evidence lifecycle event')
    }
  } else if (value.event.kind === 'incident') {
    if (!hasExactKeys(value.event, ['kind', 'role', 'source', 'reason', 'statusClass']) ||
        !APP_ROLES.includes(value.event.role) ||
        !INCIDENT_SOURCES.includes(value.event.source) ||
        !INCIDENT_REASONS.includes(value.event.reason) ||
        !STATUS_CLASSES.includes(value.event.statusClass)) {
      throw new TypeError('invalid evidence incident event')
    }
  } else {
    throw new TypeError('invalid evidence IPC event kind')
  }
  return value
}

function defaultSend (value) {
  if (typeof process.send !== 'function' || process.connected === false) return false
  try {
    process.send(value)
    return true
  } catch {
    return false
  }
}

/**
 * Narrow Electron-main integration seam. It owns only a WeakMap and emits
 * fixed protocol values; all Electron detail objects are immediately reduced.
 */
function createMainEvidenceBridge (options = {}) {
  const send = typeof options.send === 'function' ? options.send : defaultSend
  const roles = new WeakMap()

  function emit (envelope) {
    validateIpcEnvelope(envelope)
    try {
      return send(envelope) !== false
    } catch {
      return false
    }
  }

  function markLifecycle (stage) {
    return emit(lifecycleEnvelope(stage))
  }

  function registerWebContents (webContents, role) {
    if ((!webContents || (typeof webContents !== 'object' && typeof webContents !== 'function'))) {
      throw new TypeError('webContents object is required')
    }
    const normalized = normalizeWebContentsRole(role)
    if (normalized === 'unknown') throw new TypeError('unsupported webContents evidence role')
    roles.set(webContents, normalized)
    return () => roles.delete(webContents)
  }

  function webContentsRole (webContents) {
    if (!webContents || (typeof webContents !== 'object' && typeof webContents !== 'function')) {
      return 'unknown'
    }
    return roles.get(webContents) || 'unknown'
  }

  function recordRenderProcessGone (webContents, details) {
    const reason = normalizeReason(details?.reason)
    const statusClass = normalizeStatusClass(details?.exitCode)
    if (reason === 'clean-exit' && statusClass === 'zero') return false
    return emit(incidentEnvelope({
      role: webContentsRole(webContents),
      source: 'render-process-gone',
      reason,
      statusClass
    }))
  }

  function recordChildProcessGone (details) {
    const reason = normalizeReason(details?.reason)
    const statusClass = normalizeStatusClass(details?.exitCode)
    if (reason === 'clean-exit' && statusClass === 'zero') return false
    return emit(incidentEnvelope({
      role: roleForChildProcess(details),
      source: 'child-process-gone',
      reason,
      statusClass
    }))
  }

  function recordUtilityFatal (role) {
    if (!['realtime', 'refine', 'storage'].includes(role)) {
      throw new TypeError('unsupported utility evidence role')
    }
    return emit(incidentEnvelope({
      role,
      source: 'utility-fatal',
      reason: 'fatal-v8',
      statusClass: 'not-observed'
    }))
  }

  function recordPreloadError (webContents) {
    return emit(incidentEnvelope({
      role: webContentsRole(webContents),
      source: 'preload-error',
      reason: 'preload-failure',
      statusClass: 'not-observed'
    }))
  }

  function recordUnresponsive (webContents) {
    return emit(incidentEnvelope({
      role: webContentsRole(webContents),
      source: 'unresponsive',
      reason: 'unresponsive',
      statusClass: 'not-observed'
    }))
  }

  return Object.freeze({
    markLifecycle,
    recordChildProcessGone,
    recordPreloadError,
    recordRenderProcessGone,
    recordUnresponsive,
    recordUtilityFatal,
    registerWebContents
  })
}

function emptyLifecycle () {
  return {
    mainSpawned: false,
    mainStarted: false,
    appReady: false,
    bootstrapComplete: false,
    quitRequested: false,
    willQuitObserved: false
  }
}

function emptyCounters () {
  return {
    incidentCount: 0,
    droppedIncidentCount: 0,
    rendererGoneCount: 0,
    utilityGoneCount: 0,
    mainExitCount: 0,
    fatalV8Count: 0,
    preloadErrorCount: 0,
    unresponsiveCount: 0,
    rejectedIpcCount: 0
  }
}

function confidenceForIncident (incident) {
  if (incident.source === 'main-exit') return 'exact-handle'
  if (incident.source === 'render-process-gone') return 'exact-webcontents'
  if (incident.source === 'child-process-gone') return 'service-name'
  return 'none'
}

function isBreakpointIncident (incident) {
  return incident.statusClass === 'breakpoint-0x80000003'
}

function isFaultIncident (incident) {
  return incident.source !== 'unresponsive' || isBreakpointIncident(incident)
}

function faultCounterTotal (counters) {
  return counters.mainExitCount + counters.rendererGoneCount +
    counters.utilityGoneCount + counters.fatalV8Count +
    counters.preloadErrorCount + counters.unresponsiveCount
}

/* Unresponsive is an abnormal product outcome, but it remains the lowest
   retention priority so a later crash/breakpoint can replace it under the
   bounded incident cap. */
function retainedFaultCounterTotal (counters) {
  return counters.mainExitCount + counters.rendererGoneCount +
    counters.utilityGoneCount + counters.fatalV8Count +
    counters.preloadErrorCount
}

function deriveAttribution (mainExit, incidents) {
  const candidates = []
  if (mainExit.statusClass === 'breakpoint-0x80000003') {
    candidates.push({ role: 'main', confidence: 'exact-handle' })
  }
  for (const incident of incidents) {
    if (incident.statusClass !== 'breakpoint-0x80000003') continue
    candidates.push({ role: incident.role, confidence: confidenceForIncident(incident) })
  }
  if (candidates.length === 0) {
    return { breakpointObserved: false, role: null, confidence: 'none' }
  }
  const roles = [...new Set(candidates.map((candidate) => candidate.role))]
  if (roles.length !== 1) {
    return { breakpointObserved: true, role: null, confidence: 'ambiguous' }
  }
  const confidenceRank = ['none', 'service-name', 'exact-webcontents', 'exact-handle']
  const confidence = candidates
    .filter((candidate) => candidate.role === roles[0])
    .map((candidate) => candidate.confidence)
    .sort((left, right) => confidenceRank.indexOf(right) - confidenceRank.indexOf(left))[0]
  return { breakpointObserved: true, role: roles[0], confidence }
}

function deriveOutcome (mainExit, lifecycle, incidents, counters, mainExitFinalized = true) {
  // Source counters include accepted incidents that could not remain inside the
  // bounded incident list. They are therefore authoritative for the presence
  // of a fault after the cap is reached; the list alone is not.
  const hasFaultIncident = incidents.some(isFaultIncident) || faultCounterTotal(counters) > 0
  if (mainExit.statusClass === 'breakpoint-0x80000003' ||
      mainExit.statusClass === 'other-nonzero' || hasFaultIncident ||
      incidents.some(isBreakpointIncident)) {
    return 'abnormal-exit'
  }
  if (!mainExitFinalized || mainExit.statusClass !== 'zero' || counters.rejectedIpcCount > 0) {
    return 'incomplete'
  }
  if (!lifecycle.quitRequested || !lifecycle.willQuitObserved) return 'incomplete'
  return 'clean-exit'
}

function createEvidenceAccumulator (options = {}) {
  const electronMajor = options.electronMajor === null || options.electronMajor === undefined
    ? null
    : options.electronMajor
  if (electronMajor !== null && (!Number.isSafeInteger(electronMajor) || electronMajor < 1 || electronMajor > 999)) {
    throw new TypeError('electronMajor must be null or a positive integer')
  }
  const platform = normalizePlatform(options.platform || process.platform)
  if (options.packagedRuntime !== undefined && typeof options.packagedRuntime !== 'boolean') {
    throw new TypeError('packagedRuntime must be boolean')
  }
  const packagedRuntime = options.packagedRuntime === true
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const lifecycle = emptyLifecycle()
  const counters = emptyCounters()
  const incidents = []
  let mainExitStatus = 'not-observed'
  let mainExitFinalized = false

  function incrementSourceCounter (source) {
    if (source === 'main-exit') counters.mainExitCount += 1
    if (source === 'render-process-gone') counters.rendererGoneCount += 1
    if (source === 'child-process-gone') counters.utilityGoneCount += 1
    if (source === 'utility-fatal') counters.fatalV8Count += 1
    if (source === 'preload-error') counters.preloadErrorCount += 1
    if (source === 'unresponsive') counters.unresponsiveCount += 1
  }

  function boundedIncident (value, ordinal) {
    return Object.freeze({
      ordinal,
      role: value.role,
      source: value.source,
      reason: value.reason,
      statusClass: value.statusClass
    })
  }

  function replaceBoundedIncident (index, value) {
    incidents.splice(index, 1)
    for (let current = index; current < incidents.length; current += 1) {
      incidents[current] = boundedIncident(incidents[current], current + 1)
    }
    incidents.push(boundedIncident(value, incidents.length + 1))
  }

  function replacementIndexForBreakpoint (value) {
    const sameRoleIndexes = []
    for (let index = 0; index < incidents.length; index += 1) {
      if (isBreakpointIncident(incidents[index]) && incidents[index].role === value.role) {
        sameRoleIndexes.push(index)
      }
    }

    // A role already represented by a breakpoint remains attributable. Only
    // replace its weakest observation when the new exactness is stronger.
    if (sameRoleIndexes.length > 0) {
      const confidenceRank = ['none', 'service-name', 'exact-webcontents', 'exact-handle']
      const weakestIndex = sameRoleIndexes.reduce((left, right) => {
        return confidenceRank.indexOf(confidenceForIncident(incidents[right])) <
          confidenceRank.indexOf(confidenceForIncident(incidents[left])) ? right : left
      })
      return confidenceRank.indexOf(confidenceForIncident(value)) >
        confidenceRank.indexOf(confidenceForIncident(incidents[weakestIndex]))
        ? weakestIndex
        : -1
    }

    // A previously unseen breakpoint role is higher-value than any bounded
    // non-breakpoint observation. Prefer an unresponsive observation first.
    const unresponsiveIndex = incidents.findIndex((incident) =>
      !isBreakpointIncident(incident) && !isFaultIncident(incident))
    if (unresponsiveIndex !== -1) return unresponsiveIndex
    const nonBreakpointIndex = incidents.findIndex((incident) => !isBreakpointIncident(incident))
    if (nonBreakpointIndex !== -1) return nonBreakpointIndex

    // APP_ROLES is smaller than MAX_INCIDENTS, so a full list of breakpoints
    // must contain a repeated role. Evict only a duplicate, never that role's
    // sole retained observation.
    const roleCounts = new Map()
    for (const incident of incidents) {
      roleCounts.set(incident.role, (roleCounts.get(incident.role) || 0) + 1)
    }
    const duplicateIndexes = incidents
      .map((incident, index) => ({ incident, index }))
      .filter(({ incident }) => roleCounts.get(incident.role) > 1)
    if (duplicateIndexes.length === 0) return -1
    const confidenceRank = ['none', 'service-name', 'exact-webcontents', 'exact-handle']
    return duplicateIndexes.reduce((left, right) => {
      return confidenceRank.indexOf(confidenceForIncident(right.incident)) <
        confidenceRank.indexOf(confidenceForIncident(left.incident)) ? right : left
    }).index
  }

  function replacementIndex (value) {
    if (isBreakpointIncident(value)) return replacementIndexForBreakpoint(value)

    // Keep one concrete fault observation whenever counters say a fault was
    // received. Further non-breakpoint faults may be summarized by counters.
    if (isFaultIncident(value) && !incidents.some(isFaultIncident)) {
      return incidents.findIndex((incident) => !isFaultIncident(incident))
    }
    return -1
  }

  function addIncident (value) {
    if (value.reason === 'clean-exit' && value.statusClass === 'zero') return false
    incrementSourceCounter(value.source)
    if (incidents.length >= MAX_INCIDENTS) {
      counters.droppedIncidentCount += 1
      const index = replacementIndex(value)
      if (index === -1) return false
      replaceBoundedIncident(index, value)
      counters.incidentCount = incidents.length
      return true
    }
    incidents.push(boundedIncident(value, incidents.length + 1))
    counters.incidentCount = incidents.length
    return true
  }

  function acceptIpcMessage (value) {
    let envelope
    try {
      envelope = validateIpcEnvelope(value)
    } catch {
      counters.rejectedIpcCount += 1
      return false
    }
    const event = envelope.event
    if (event.kind === 'lifecycle') {
      if (event.stage === 'main-started') lifecycle.mainStarted = true
      if (event.stage === 'app-ready') lifecycle.appReady = true
      if (event.stage === 'bootstrap-complete') lifecycle.bootstrapComplete = true
      if (event.stage === 'quit-requested') lifecycle.quitRequested = true
      if (event.stage === 'will-quit') lifecycle.willQuitObserved = true
      return true
    }
    addIncident(event)
    return true
  }

  function markMainSpawned () {
    lifecycle.mainSpawned = true
  }

  function finishMainExit (code, signalObserved = false) {
    if (mainExitFinalized) return
    mainExitFinalized = true
    mainExitStatus = normalizeStatusClass(code)
    if (mainExitStatus !== 'zero') {
      addIncident({
        role: 'main',
        source: 'main-exit',
        reason: signalObserved ? 'killed' : 'abnormal-exit',
        statusClass: mainExitStatus
      })
    }
  }

  function failMainLaunch () {
    if (mainExitFinalized) return
    mainExitFinalized = true
    addIncident({
      role: 'main',
      source: 'main-exit',
      reason: 'launch-failed',
      statusClass: 'not-observed'
    })
  }

  function snapshot () {
    const cleanIntentObserved = lifecycle.quitRequested && lifecycle.willQuitObserved
    const mainExit = {
      statusClass: mainExitStatus,
      cleanIntentObserved
    }
    const generated = new Date(now())
    if (Number.isNaN(generated.getTime())) throw new TypeError('evidence clock is invalid')
    return {
      schemaVersion: SCHEMA_VERSION,
      kind: 'electron-role-exit-evidence',
      generatedAt: generated.toISOString(),
      outcome: deriveOutcome(mainExit, lifecycle, incidents, counters, mainExitFinalized),
      gateStatus: 'diagnostic-only',
      runtime: { electronMajor, platform, supervised: true },
      lifecycle: { ...lifecycle },
      mainExit,
      attribution: deriveAttribution(mainExit, incidents),
      counters: { ...counters },
      incidents: incidents.map((incident) => ({ ...incident })),
      privacy: {
        audioPayloadPersisted: false,
        subtitleBodyPersisted: false,
        localAddressPersisted: false,
        diagnosticDumpPersisted: false,
        externalUploadEnabled: false
      },
      scope: {
        roleAttribution: true,
        nativeStackCaptured: false,
        rootCauseIdentified: false,
        packagedRuntime
      }
    }
  }

  return Object.freeze({
    acceptIpcMessage,
    failMainLaunch,
    finishMainExit,
    markMainSpawned,
    snapshot
  })
}

function nonNegativeSafeInteger (value) {
  return Number.isSafeInteger(value) && value >= 0
}

function walkPropertyNames (value, visitor) {
  if (Array.isArray(value)) {
    for (const item of value) walkPropertyNames(item, visitor)
    return
  }
  if (!isPlainObject(value)) return
  for (const [key, child] of Object.entries(value)) {
    visitor(key)
    walkPropertyNames(child, visitor)
  }
}

function walkStrings (value, visitor) {
  if (typeof value === 'string') {
    visitor(value)
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) walkStrings(item, visitor)
    return
  }
  if (isPlainObject(value)) {
    for (const child of Object.values(value)) walkStrings(child, visitor)
  }
}

function validateEvidenceReport (report) {
  if (!hasExactKeys(report, ROOT_KEYS) || report.schemaVersion !== SCHEMA_VERSION ||
      report.kind !== 'electron-role-exit-evidence' ||
      !OUTCOMES.includes(report.outcome) || report.gateStatus !== 'diagnostic-only' ||
      typeof report.generatedAt !== 'string' || Number.isNaN(Date.parse(report.generatedAt))) {
    throw new TypeError('invalid evidence report envelope')
  }
  if (!hasExactKeys(report.runtime, RUNTIME_KEYS) ||
      (report.runtime.electronMajor !== null &&
       (!Number.isSafeInteger(report.runtime.electronMajor) || report.runtime.electronMajor < 1 || report.runtime.electronMajor > 999)) ||
      !PLATFORMS.includes(report.runtime.platform) || report.runtime.supervised !== true) {
    throw new TypeError('invalid evidence runtime')
  }
  if (!hasExactKeys(report.lifecycle, LIFECYCLE_KEYS) ||
      LIFECYCLE_KEYS.some((key) => typeof report.lifecycle[key] !== 'boolean')) {
    throw new TypeError('invalid evidence lifecycle')
  }
  if (!hasExactKeys(report.mainExit, MAIN_EXIT_KEYS) ||
      !STATUS_CLASSES.includes(report.mainExit.statusClass) ||
      typeof report.mainExit.cleanIntentObserved !== 'boolean' ||
      report.mainExit.cleanIntentObserved !== (report.lifecycle.quitRequested && report.lifecycle.willQuitObserved)) {
    throw new TypeError('invalid evidence main exit')
  }
  if (!hasExactKeys(report.attribution, ATTRIBUTION_KEYS) ||
      typeof report.attribution.breakpointObserved !== 'boolean' ||
      (report.attribution.role !== null && !APP_ROLES.includes(report.attribution.role)) ||
      !ATTRIBUTION_CONFIDENCE.includes(report.attribution.confidence)) {
    throw new TypeError('invalid evidence attribution')
  }
  if (!hasExactKeys(report.counters, COUNTER_KEYS) ||
      COUNTER_KEYS.some((key) => !nonNegativeSafeInteger(report.counters[key])) ||
      !Array.isArray(report.incidents) || report.incidents.length > MAX_INCIDENTS ||
      report.counters.incidentCount !== report.incidents.length) {
    throw new TypeError('invalid evidence counters')
  }
  for (let index = 0; index < report.incidents.length; index += 1) {
    const incident = report.incidents[index]
    if (!hasExactKeys(incident, INCIDENT_KEYS) || incident.ordinal !== index + 1 ||
        !APP_ROLES.includes(incident.role) ||
        !INCIDENT_SOURCES.includes(incident.source) ||
        !INCIDENT_REASONS.includes(incident.reason) ||
        !STATUS_CLASSES.includes(incident.statusClass)) {
      throw new TypeError('invalid evidence incident')
    }
  }
  if (report.mainExit.statusClass === 'breakpoint-0x80000003' &&
      !report.incidents.some((incident) => incident.role === 'main' &&
        incident.source === 'main-exit' && isBreakpointIncident(incident))) {
    throw new TypeError('evidence bounded incidents lost the main breakpoint')
  }
  const derived = deriveAttribution(report.mainExit, report.incidents)
  if (JSON.stringify(derived) !== JSON.stringify(report.attribution)) {
    throw new TypeError('evidence attribution does not match observations')
  }
  const sourceCounterTotal = report.counters.mainExitCount + report.counters.rendererGoneCount +
    report.counters.utilityGoneCount + report.counters.fatalV8Count +
    report.counters.preloadErrorCount + report.counters.unresponsiveCount
  if (sourceCounterTotal !== report.counters.incidentCount + report.counters.droppedIncidentCount) {
    throw new TypeError('evidence source counters do not match bounded incidents')
  }
  const recordedBySource = {
    'main-exit': report.incidents.filter((incident) => incident.source === 'main-exit').length,
    'render-process-gone': report.incidents.filter((incident) => incident.source === 'render-process-gone').length,
    'child-process-gone': report.incidents.filter((incident) => incident.source === 'child-process-gone').length,
    'utility-fatal': report.incidents.filter((incident) => incident.source === 'utility-fatal').length,
    'preload-error': report.incidents.filter((incident) => incident.source === 'preload-error').length,
    unresponsive: report.incidents.filter((incident) => incident.source === 'unresponsive').length
  }
  if (report.counters.mainExitCount < recordedBySource['main-exit'] ||
      report.counters.rendererGoneCount < recordedBySource['render-process-gone'] ||
      report.counters.utilityGoneCount < recordedBySource['child-process-gone'] ||
      report.counters.fatalV8Count < recordedBySource['utility-fatal'] ||
      report.counters.preloadErrorCount < recordedBySource['preload-error'] ||
      report.counters.unresponsiveCount < recordedBySource.unresponsive) {
    throw new TypeError('evidence source counter is smaller than its observations')
  }
  if (retainedFaultCounterTotal(report.counters) > 0 && !report.incidents.some(isFaultIncident)) {
    throw new TypeError('evidence bounded incidents lost all fault observations')
  }
  const inferredMainFinalized = report.mainExit.statusClass !== 'not-observed' ||
    report.incidents.some((incident) => incident.source === 'main-exit' && incident.reason === 'launch-failed')
  const expectedOutcome = deriveOutcome(
    report.mainExit,
    report.lifecycle,
    report.incidents,
    report.counters,
    inferredMainFinalized
  )
  if (report.outcome !== expectedOutcome) {
    throw new TypeError('evidence outcome does not match observations')
  }
  if (!hasExactKeys(report.privacy, PRIVACY_KEYS) ||
      PRIVACY_KEYS.some((key) => report.privacy[key] !== false)) {
    throw new TypeError('evidence privacy contract was violated')
  }
  if (!hasExactKeys(report.scope, SCOPE_KEYS) ||
      report.scope.roleAttribution !== true || report.scope.nativeStackCaptured !== false ||
      report.scope.rootCauseIdentified !== false || typeof report.scope.packagedRuntime !== 'boolean') {
    throw new TypeError('evidence scope overclaim')
  }

  const forbiddenKeys = new Set([
    'pid', 'text', 'transcript', 'caption', 'pcm', 'path', 'stack', 'message',
    'report', 'location', 'argv', 'cwd', 'env'
  ])
  walkPropertyNames(report, (key) => {
    if (forbiddenKeys.has(key.toLowerCase())) throw new TypeError('evidence contains a forbidden property')
  })
  walkStrings(report, (value) => {
    if (/[A-Za-z]:[\\/]/.test(value) || /^\\\\/.test(value) || /file:\/\//i.test(value) ||
        /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)(?:$|[?#])/i.test(value)) {
      throw new TypeError('evidence contains a local address or audio reference')
    }
  })
  return report
}

module.exports = {
  APP_ROLES,
  IPC_CHANNEL,
  MAX_INCIDENTS,
  SCHEMA_VERSION,
  createEvidenceAccumulator,
  createMainEvidenceBridge,
  deriveAttribution,
  deriveOutcome,
  incidentEnvelope,
  lifecycleEnvelope,
  normalizeReason,
  normalizeStatusClass,
  roleForChildProcess,
  validateEvidenceReport,
  validateIpcEnvelope
}
