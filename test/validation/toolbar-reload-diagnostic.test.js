'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')
const { EventEmitter } = require('node:events')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { readAndValidate } = require('../../scripts/verify-toolbar-reload-diagnostic')
const {
  createRecorder, MAIN_STAGES, RENDERER_STAGES
} = require('../../src/preload/toolbar-layout-diagnostic')
const { ToolbarLayoutState } = require('../../src/main/window-layout-contract')
const CHANNELS = require('../../src/main/ipc/channels')
const {
  installMainProbe, makeReport, validateReport, readRendererSnapshot
} = require('../../scripts/toolbar-reload-diagnostic')

function fixture () {
  const main = createRecorder(MAIN_STAGES, () => 10)
  const renderer = createRecorder(RENDERER_STAGES, () => 10)
  return { main, renderer, report (status = 'captured') {
    return makeReport({
      profile: 'default', productPayloadSha256: 'a'.repeat(64), outcome: 'failed', phase: 'recovery',
      main: main.snapshot(20, 2),
      renderer: { status, snapshot: status === 'captured' ? renderer.snapshot(20, 2) : null }
    })
  } }
}

test('SEM-F22/F14/J17: diagnostic distinguishes no send, missing delivery, rejection and observed recovery', () => {
  const absent = fixture()
  absent.renderer.record('renderer-init')
  absent.renderer.record('context-valid', 2)
  absent.renderer.record('queued', 2)
  assert.equal(absent.report().facts.rendererSentObserved, false)

  const sent = fixture()
  sent.renderer.record('sent', 2)
  const sentReport = sent.report()
  assert.equal(sentReport.facts.rendererSentObserved, true)
  assert.equal(sentReport.facts.mainReceivedObserved, false)

  const rejected = fixture()
  rejected.main.record('report-arrived', 2)
  rejected.main.record('sender-accepted', 2)
  rejected.main.record('layout-rejected', 2, 'rect-range', true)
  assert.equal(rejected.report().facts.layoutRejectedObserved, true)

  const accepted = fixture()
  accepted.main.record('layout-accepted', 2, 'accepted', true)
  accepted.renderer.record('sent', 2)
  const report = accepted.report()
  report.outcome = 'recovered'
  assert.equal(validateReport(report).facts.targetLayoutAcceptedObserved, true)
  assert.equal(report.gateStatus, 'diagnostic-only')
})

test('SEM-F22/J17: context issuance, invalidation and stale report retain order without raw generations', () => {
  const sample = fixture()
  sample.main.record('context-issued', 1)
  sample.main.record('invalidated', 2)
  sample.main.record('layout-rejected', 1, 'generation-mismatch', false)
  const report = sample.report()
  assert.equal(report.facts.generationMismatchObserved, true)
  assert.deepEqual(report.main.entries.map((entry) => [entry.stage, entry.generationRelation]), [
    ['context-issued', 'older'], ['invalidated', 'target'], ['layout-rejected', 'older']
  ])
})

test('SEM-F14/J17: bounded diagnostic marks missing or overflow evidence unknown instead of zero', () => {
  for (const status of ['missing', 'timeout', 'invalid', 'unavailable']) {
    assert.equal(fixture().report(status).facts.rendererSentObserved, null)
  }
  const sample = fixture()
  for (let index = 0; index < 130; index += 1) sample.renderer.record('queued', 2)
  sample.renderer.record('sent', 2)
  const report = sample.report()
  assert.equal(report.renderer.snapshot.entries.length, 128)
  assert.equal(report.renderer.snapshot.readTimeOverflowCount, 3)
  assert.equal(report.facts.rendererSentObserved, null)
})

test('SEM-F22/J17: cutoff excludes late events and snapshot freezes subsequent observations', () => {
  let at = 10
  const recorder = createRecorder(RENDERER_STAGES, () => at)
  recorder.record('queued', 2)
  at = 30
  recorder.record('sent', 2)
  const snapshot = recorder.snapshot(20, 2)
  recorder.record('retry-fired', 2)
  assert.deepEqual(snapshot.entries.map((entry) => entry.stage), ['queued'])
  assert.deepEqual(recorder.snapshot(20, 2), snapshot)
})

test('SEM-F22/J17: a previous document cannot supply initial-load evidence for a later reload', () => {
  let at = 10
  const recorder = createRecorder(RENDERER_STAGES, () => at)
  recorder.record('sent', 1)
  at = 30
  recorder.record('sent', 1)
  assert.equal(recorder.snapshot(40, 2, 20), null)
})

test('SEM-F22/J17: post-cutoff overflow does not turn pre-cutoff absence into unknown', () => {
  let at = 10
  const recorder = createRecorder(RENDERER_STAGES, () => at)
  for (let index = 0; index < 128; index += 1) recorder.record('queued', 2)
  at = 30
  recorder.record('sent', 2)
  const report = fixture().report()
  report.renderer.snapshot = recorder.snapshot(20, 2)
  assert.equal(report.renderer.snapshot.readTimeOverflowCount, 1)
  assert.equal(report.renderer.snapshot.overflowBeforeCutoff, false)
  assert.equal(validateReport(report).facts.rendererSentObserved, false)
})

test('SEM-F14/J17: strict diagnostic reader rejects unknown, sensitive and contradictory fields', () => {
  const base = fixture().report()
  const mutate = [
    (r) => { r.localPath = 'C:\\private\\file' },
    (r) => { r.main.geometry = { x: 1 } },
    (r) => { r.renderer.snapshot.entries.push({ stage: 'sent', generation: 2 }) },
    (r) => { r.main.entries.push({ stage: 'private text', decision: 'none', matchesCurrent: null, generationRelation: 'target' }) },
    (r) => { r.main.readTimeOverflowCount = -1 },
    (r) => { r.main.readTimeOverflowCount = 1.5 },
    (r) => { r.main.overflowBeforeCutoff = true },
    (r) => { r.recoveryTimeoutMs = 6000 },
    (r) => { r.snapshotBudgetMs = 2000 },
    (r) => { r.productPayloadSha256 = 'private text' },
    (r) => { r.facts.rendererSentObserved = true },
    (r) => { r.outcome = 'recovered' },
    (r) => { r.renderer.status = 'missing' }
  ]
  for (const change of mutate) {
    const report = structuredClone(base)
    change(report)
    assert.throws(() => validateReport(report))
  }
})

test('SEM-F14/J17: persisted diagnostic rejects duplicate keys and invalid UTF-8', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'toolbar-diagnostic-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const filename = path.join(directory, 'report.json')
  const report = fixture().report()
  const text = JSON.stringify(report)
  fs.writeFileSync(filename, text)
  assert.deepEqual(readAndValidate(filename), report)
  fs.writeFileSync(filename, text.replace('"kind":', '"kind":"untrusted","kind":'))
  assert.throws(() => readAndValidate(filename), /duplicate object key/)
  fs.writeFileSync(filename, Buffer.from([0xff]))
  assert.throws(() => readAndValidate(filename), /invalid UTF-8/)
})

test('SEM-F22/J17: renderer read is bounded and missing/invalid/thrown reads stay distinct', async () => {
  assert.equal((await readRendererSnapshot(() => new Promise(() => {}), 20, 2, 10)).status, 'timeout')
  assert.equal((await readRendererSnapshot(() => null, 20, 2)).status, 'missing')
  assert.equal((await readRendererSnapshot(() => ({ rawError: 'private' }), 20, 2)).status, 'invalid')
  assert.equal((await readRendererSnapshot(() => { throw new Error('private') }, 20, 2)).status, 'unavailable')
  const snapshot = createRecorder(RENDERER_STAGES).snapshot(Date.now(), 2)
  assert.deepEqual(await readRendererSnapshot(() => snapshot, 20, 2), { status: 'captured', snapshot })
})

test('SEM-F22/J17: main observation preserves real layout decisions, IPC return and original failure', () => {
  // Local observer mechanics, not a replacement for the Electron J17 journey.
  const ipc = new EventEmitter()
  const handlers = new Map()
  ipc.handle = (channel, handler) => handlers.set(channel, handler)
  class Layout extends ToolbarLayoutState {}
  const probe = installMainProbe(ipc, Layout, () => 10)
  try {
    const state = new Layout()
    const denied = new Error('sender rejected')
    const afterAcceptance = new Error('publication failed')
    ipc.handle(CHANNELS.TOOLBAR_LAYOUT_GET_CONTEXT, () => state.getContext())
    ipc.on(CHANNELS.TOOLBAR_LAYOUT_REPORT_RECT, (event, report) => {
      if (!event.allowed) throw denied
      state.acceptReport(report)
      if (event.failPublication) throw afterAcceptance
    })
    probe.begin()
    assert.deepEqual(handlers.get(CHANNELS.TOOLBAR_LAYOUT_GET_CONTEXT)(), { generation: 1 })
    state.invalidate()
    assert.throws(() => ipc.emit(CHANNELS.TOOLBAR_LAYOUT_REPORT_RECT, { allowed: false }, {}), (error) => error === denied)
    const rect = { x: 16, y: 16, width: 568, height: 40 }
    ipc.emit(CHANNELS.TOOLBAR_LAYOUT_REPORT_RECT, { allowed: true }, { generation: 1, rect })
    assert.equal(state.getOverlap().source, 'fallback')
    assert.throws(() => ipc.emit(CHANNELS.TOOLBAR_LAYOUT_REPORT_RECT,
      { allowed: true, failPublication: true }, { generation: 2, rect }), (error) => error === afterAcceptance)
    assert.equal(state.getOverlap().source, 'toolbar')
    const main = probe.freeze(20, 2)
    assert.equal(main.entries.filter((entry) => entry.stage === 'sender-rejected').length, 1)
    assert.equal(main.entries.filter((entry) => entry.stage === 'handler-failed').length, 1)
    assert.equal(main.entries.filter((entry) => entry.stage === 'layout-accepted').length, 1)
    assert.equal(main.entries.filter((entry) => entry.decision === 'generation-mismatch').length, 1)
  } finally { probe.restore() }
})
