'use strict'

const { isDeepStrictEqual } = require('node:util')
const {
  LIMIT, MAIN_STAGES, RENDERER_STAGES, DECISIONS, createRecorder
} = require('../src/preload/toolbar-layout-diagnostic')
const CHANNELS = require('../src/main/ipc/channels')

// Installed by the product-shell entry only. All product callbacks still run
// once, synchronously, with their original receiver, arguments and exceptions.
function installMainProbe (ipcMain, LayoutState, now = Date.now) {
  let recorder = null
  let invocation = null
  const restore = []
  const record = (...args) => {
    try { recorder?.record(...args) } catch { /* diagnostic isolation */ }
  }
  function wrap (host, name, factory) {
    const original = host[name]
    host[name] = factory(original)
    restore.push(() => { host[name] = original })
  }
  wrap(LayoutState.prototype, 'getContext', (original) => function (...args) {
    const result = original.apply(this, args)
    if (invocation?.kind === 'context') {
      invocation.entered = true
      record('context-issued', result.generation)
    }
    return result
  })
  wrap(LayoutState.prototype, 'invalidate', (original) => function (...args) {
    const result = original.apply(this, args)
    record('invalidated', result.generation)
    return result
  })
  wrap(LayoutState.prototype, 'acceptReport', (original) => function (report, observeDecision) {
    if (invocation?.kind === 'report') invocation.entered = true
    record('sender-accepted', report?.generation)
    const matchesCurrent = report?.generation === this.generation
    return original.call(this, report, (decision) => {
      record(decision === 'accepted' ? 'layout-accepted' : 'layout-rejected',
        report?.generation, decision, matchesCurrent)
      observeDecision?.(decision)
    })
  })
  for (const [method, channel, kind] of [
    ['on', CHANNELS.TOOLBAR_LAYOUT_REPORT_RECT, 'report'],
    ['handle', CHANNELS.TOOLBAR_LAYOUT_GET_CONTEXT, 'context']
  ]) {
    wrap(ipcMain, method, (register) => function (name, listener) {
      if (name !== channel) return register.call(this, name, listener)
      return register.call(this, name, function (...args) {
        const previous = invocation
        invocation = { kind, entered: false }
        record(kind === 'report' ? 'report-arrived' : 'context-arrived', args[1]?.generation)
        try {
          return listener.apply(this, args)
        } catch (error) {
          record(invocation.entered ? 'handler-failed' : kind === 'report' ? 'sender-rejected' : 'context-rejected')
          throw error
        } finally {
          invocation = previous
        }
      })
    })
  }
  return {
    begin () { recorder = createRecorder(MAIN_STAGES, now) },
    freeze (cutoff, generation) {
      const snapshot = recorder.snapshot(cutoff, generation)
      recorder = null
      return snapshot
    },
    restore () { for (const reset of restore.reverse()) reset() }
  }
}

function exact (value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) {
    throw new Error('invalid diagnostic shape')
  }
}
function count (value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid diagnostic count')
}
function oneOf (value, values) {
  if (!values.includes(value)) throw new Error('invalid diagnostic enum')
}
function validateSnapshot (snapshot, stages) {
  exact(snapshot, ['entries', 'readTimeOverflowCount', 'overflowBeforeCutoff'])
  count(snapshot.readTimeOverflowCount)
  if (typeof snapshot.overflowBeforeCutoff !== 'boolean' ||
      (snapshot.overflowBeforeCutoff && snapshot.readTimeOverflowCount === 0)) throw new Error('invalid diagnostic overflow')
  if (!Array.isArray(snapshot.entries) || snapshot.entries.length > LIMIT) throw new Error('invalid diagnostic entries')
  for (const entry of snapshot.entries) {
    exact(entry, ['stage', 'decision', 'matchesCurrent', 'generationRelation'])
    oneOf(entry.stage, stages)
    oneOf(entry.decision, DECISIONS)
    oneOf(entry.generationRelation, ['unknown', 'target', 'older', 'newer'])
    oneOf(entry.matchesCurrent, [null, true, false])
    if (entry.stage === 'layout-accepted' || entry.stage === 'layout-rejected') {
      if (typeof entry.matchesCurrent !== 'boolean' ||
          (entry.stage === 'layout-accepted' ? entry.decision !== 'accepted' || !entry.matchesCurrent
            : ['none', 'accepted'].includes(entry.decision))) throw new Error('invalid diagnostic decision')
    } else if (entry.decision !== 'none' || entry.matchesCurrent !== null) throw new Error('unexpected diagnostic decision')
  }
  return snapshot
}

function summarize (main, renderer) {
  function observed (snapshot, predicate) {
    if (!snapshot) return null
    if (snapshot.entries.some(predicate)) return true
    return snapshot.overflowBeforeCutoff ? null : false
  }
  const rendererSnapshot = renderer.status === 'captured' ? renderer.snapshot : null
  return {
    rendererSentObserved: observed(rendererSnapshot, (entry) => entry.stage === 'sent'),
    mainReceivedObserved: observed(main, (entry) => entry.stage === 'report-arrived'),
    senderRejectedObserved: observed(main, (entry) => entry.stage === 'sender-rejected'),
    layoutRejectedObserved: observed(main, (entry) => entry.stage === 'layout-rejected'),
    generationMismatchObserved: observed(main, (entry) => entry.decision === 'generation-mismatch'),
    targetLayoutAcceptedObserved: observed(main, (entry) => entry.stage === 'layout-accepted' && entry.generationRelation === 'target')
  }
}

function makeReport ({ profile, productPayloadSha256, outcome, phase, main, renderer }) {
  const report = {
    schemaVersion: 1,
    kind: 'toolbar-reload-diagnostic',
    gateStatus: 'diagnostic-only',
    profile,
    productPayloadSha256,
    outcome,
    phase,
    recoveryTimeoutMs: 5000,
    snapshotBudgetMs: 1000,
    bufferLimit: LIMIT,
    main,
    renderer,
    facts: summarize(main, renderer)
  }
  return validateReport(report)
}

function validateReport (report) {
  exact(report, ['schemaVersion', 'kind', 'gateStatus', 'profile', 'productPayloadSha256',
    'outcome', 'phase', 'recoveryTimeoutMs', 'snapshotBudgetMs', 'bufferLimit', 'main', 'renderer', 'facts'])
  if (report.schemaVersion !== 1 || report.kind !== 'toolbar-reload-diagnostic' ||
      report.gateStatus !== 'diagnostic-only' || report.recoveryTimeoutMs !== 5000 ||
      report.snapshotBudgetMs !== 1000 || report.bufferLimit !== LIMIT) throw new Error('invalid diagnostic contract')
  oneOf(report.profile, ['default', 'legacy-risk', 'current-risk'])
  oneOf(report.outcome, ['recovered', 'failed'])
  oneOf(report.phase, ['renderer-load', 'generation', 'fallback', 'recovery'])
  if (typeof report.productPayloadSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(report.productPayloadSha256)) {
    throw new Error('invalid diagnostic digest')
  }
  validateSnapshot(report.main, MAIN_STAGES)
  exact(report.renderer, ['status', 'snapshot'])
  oneOf(report.renderer.status, ['captured', 'missing', 'timeout', 'invalid', 'unavailable'])
  if (report.renderer.status === 'captured') validateSnapshot(report.renderer.snapshot, RENDERER_STAGES)
  else if (report.renderer.snapshot !== null) throw new Error('unexpected renderer snapshot')
  const expectedFacts = summarize(report.main, report.renderer)
  exact(report.facts, Object.keys(expectedFacts))
  if (!isDeepStrictEqual(report.facts, expectedFacts)) throw new Error('inconsistent diagnostic facts')
  if (report.outcome === 'recovered' && (report.phase !== 'recovery' ||
      report.facts.targetLayoutAcceptedObserved === false)) throw new Error('inconsistent recovery observation')
  return report
}

async function readRendererSnapshot (read, cutoff, generation, budgetMs = 1000) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(() => read(cutoff, generation)).then((snapshot) => {
        if (snapshot === null || snapshot === undefined) return { status: 'missing', snapshot: null }
        try {
          validateSnapshot(snapshot, RENDERER_STAGES)
          return { status: 'captured', snapshot }
        } catch { return { status: 'invalid', snapshot: null } }
      }, () => ({ status: 'unavailable', snapshot: null })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 'timeout', snapshot: null }), budgetMs) })
    ])
  } finally { clearTimeout(timer) }
}

module.exports = { installMainProbe, makeReport, validateReport, validateSnapshot, readRendererSnapshot }
