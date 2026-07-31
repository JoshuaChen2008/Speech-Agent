'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  MAX_INCIDENTS,
  createEvidenceAccumulator,
  createMainEvidenceBridge,
  incidentEnvelope,
  lifecycleEnvelope,
  normalizeStatusClass,
  roleForChildProcess,
  validateEvidenceReport,
  validateIpcEnvelope
} = require('../../src/main/services/electron-exit-evidence')

test('Windows breakpoint status accepts only signed int32 or uint32 representations', () => {
  assert.equal(normalizeStatusClass(-2147483645), 'breakpoint-0x80000003')
  assert.equal(normalizeStatusClass(2147483651), 'breakpoint-0x80000003')
  assert.equal(normalizeStatusClass(0), 'zero')
  assert.equal(normalizeStatusClass(23), 'other-nonzero')
  assert.equal(normalizeStatusClass(0x180000003), 'not-observed', 'oversized values must not wrap into breakpoint')
  assert.equal(normalizeStatusClass(1.5), 'not-observed')
  assert.equal(normalizeStatusClass('2147483651'), 'not-observed')
})

test('main bridge reduces renderer, audio host and utility details to fixed role evidence', () => {
  const sent = []
  const bridge = createMainEvidenceBridge({ send: (value) => sent.push(value) })
  const visibleContents = {}
  const audioContents = {}
  bridge.registerWebContents(visibleContents, 'caption')
  bridge.registerWebContents(audioContents, 'audio-host')

  bridge.recordRenderProcessGone(visibleContents, {
    reason: 'crashed',
    exitCode: -2147483645,
    message: 'private subtitle body',
    path: 'C:\\Users\\private\\renderer.js'
  })
  bridge.recordRenderProcessGone(audioContents, {
    reason: 'oom',
    exitCode: 7,
    samples: new Float32Array([0.25])
  })
  bridge.recordChildProcessGone({
    type: 'Utility',
    serviceName: 'Speech Agent realtime ASR',
    reason: 'crashed',
    exitCode: 2147483651,
    location: 'C:\\private\\native.cc',
    report: 'private diagnostic memory',
    message: 'private-audio.wav'
  })
  bridge.recordChildProcessGone({
    type: 'Utility',
    serviceName: 'Speech Agent offline refinement',
    reason: 'abnormal-exit',
    exitCode: 9
  })
  bridge.recordChildProcessGone({
    type: 'Utility',
    serviceName: 'Speech Agent subtitle storage',
    reason: 'integrity-failure',
    exitCode: 11
  })
  bridge.recordUtilityFatal('refine')
  bridge.recordPreloadError(visibleContents, new Error('not accepted by the API'))
  bridge.recordUnresponsive(audioContents)

  for (const envelope of sent) validateIpcEnvelope(envelope)
  assert.deepEqual(sent.map((value) => value.event.role), [
    'renderer', 'audio-host', 'realtime', 'refine', 'storage', 'refine', 'renderer', 'audio-host'
  ])
  assert.deepEqual(sent.filter((value) => value.event.statusClass === 'breakpoint-0x80000003')
    .map((value) => value.event.role), ['renderer', 'realtime'])
  assert.doesNotMatch(JSON.stringify(sent), /Users|private|subtitle body|diagnostic memory|\.wav|samples|location|report|message/i)
  assert.throws(() => bridge.registerWebContents({}, 'arbitrary-role'), /unsupported webContents evidence role/)
  assert.throws(() => bridge.recordUtilityFatal('gpu'), /unsupported utility evidence role/)
})

test('service names map only fixed application utilities and keep Chromium roles honest', () => {
  assert.equal(roleForChildProcess({ serviceName: 'Speech Agent realtime ASR', type: 'Utility' }), 'realtime')
  assert.equal(roleForChildProcess({ serviceName: 'Speech Agent offline refinement', type: 'Utility' }), 'refine')
  assert.equal(roleForChildProcess({ serviceName: 'Speech Agent subtitle storage', type: 'Utility' }), 'storage')
  assert.equal(roleForChildProcess({ serviceName: 'Audio Service', type: 'Utility' }), 'chromium-other')
  assert.equal(roleForChildProcess({ type: 'GPU' }), 'chromium-other')
  assert.equal(roleForChildProcess({}), 'unknown')
})

test('IPC protocol rejects unknown keys and never accepts raw diagnostic fields', () => {
  validateIpcEnvelope(lifecycleEnvelope('main-started'))
  validateIpcEnvelope(incidentEnvelope({
    role: 'storage', source: 'child-process-gone', reason: 'crashed', statusClass: 'other-nonzero'
  }))
  assert.throws(() => validateIpcEnvelope({
    ...lifecycleEnvelope('app-ready'),
    path: 'C:\\private'
  }), /invalid evidence IPC envelope/)
  assert.throws(() => validateIpcEnvelope({
    schemaVersion: 1,
    channel: 'speech-agent:electron-exit-evidence',
    event: {
      kind: 'incident', role: 'storage', source: 'utility-fatal', reason: 'fatal-v8',
      statusClass: 'not-observed', report: 'private'
    }
  }), /invalid evidence incident event/)
})

test('accumulator caps evidence at sixteen incidents while retaining only counters beyond the cap', () => {
  const accumulator = createEvidenceAccumulator({
    electronMajor: 43,
    platform: 'win32',
    now: () => 1700000000000
  })
  accumulator.markMainSpawned()
  accumulator.acceptIpcMessage(lifecycleEnvelope('main-started'))
  for (let index = 0; index < 20; index += 1) {
    accumulator.acceptIpcMessage(incidentEnvelope({
      role: 'renderer',
      source: 'unresponsive',
      reason: 'unresponsive',
      statusClass: 'not-observed'
    }))
  }
  const report = accumulator.snapshot()
  assert.equal(report.incidents.length, MAX_INCIDENTS)
  assert.equal(report.counters.incidentCount, MAX_INCIDENTS)
  assert.equal(report.counters.droppedIncidentCount, 4)
  assert.equal(report.counters.unresponsiveCount, 20)
  assert.equal(report.outcome, 'abnormal-exit')
  validateEvidenceReport(report)
})

test('a renderer unresponsive incident cannot be reported as a clean supervised exit', () => {
  const accumulator = createEvidenceAccumulator({ now: () => 1700000000000 })
  accumulator.markMainSpawned()
  for (const stage of ['main-started', 'app-ready', 'bootstrap-complete', 'quit-requested', 'will-quit']) {
    accumulator.acceptIpcMessage(lifecycleEnvelope(stage))
  }
  accumulator.acceptIpcMessage(incidentEnvelope({
    role: 'renderer', source: 'unresponsive', reason: 'unresponsive', statusClass: 'not-observed'
  }))
  accumulator.finishMainExit(0)

  const report = accumulator.snapshot()
  assert.equal(report.outcome, 'abnormal-exit')
  assert.equal(report.mainExit.statusClass, 'zero')
  assert.equal(report.counters.unresponsiveCount, 1)
  validateEvidenceReport(report)
})

test('fault after an unresponsive cap is retained and keeps the outcome abnormal', () => {
  const accumulator = createEvidenceAccumulator({ now: () => 1700000000000 })
  for (let index = 0; index < MAX_INCIDENTS; index += 1) {
    accumulator.acceptIpcMessage(incidentEnvelope({
      role: 'renderer', source: 'unresponsive', reason: 'unresponsive',
      statusClass: 'not-observed'
    }))
  }
  accumulator.acceptIpcMessage(incidentEnvelope({
    role: 'storage', source: 'child-process-gone', reason: 'crashed',
    statusClass: 'other-nonzero'
  }))

  const report = accumulator.snapshot()
  assert.equal(report.outcome, 'abnormal-exit')
  assert.equal(report.incidents.length, MAX_INCIDENTS)
  assert.equal(report.counters.droppedIncidentCount, 1)
  assert.equal(report.counters.unresponsiveCount, MAX_INCIDENTS)
  assert.equal(report.counters.utilityGoneCount, 1)
  assert.equal(report.incidents.filter((incident) => incident.source === 'unresponsive').length, MAX_INCIDENTS - 1)
  assert.deepEqual(report.incidents.at(-1), {
    ordinal: MAX_INCIDENTS,
    role: 'storage',
    source: 'child-process-gone',
    reason: 'crashed',
    statusClass: 'other-nonzero'
  })
  validateEvidenceReport(report)
})

test('fault before an unresponsive cap cannot be displaced by lower-value evidence', () => {
  const accumulator = createEvidenceAccumulator({ now: () => 1700000000000 })
  accumulator.acceptIpcMessage(incidentEnvelope({
    role: 'refine', source: 'utility-fatal', reason: 'fatal-v8',
    statusClass: 'not-observed'
  }))
  for (let index = 0; index < MAX_INCIDENTS; index += 1) {
    accumulator.acceptIpcMessage(incidentEnvelope({
      role: 'renderer', source: 'unresponsive', reason: 'unresponsive',
      statusClass: 'not-observed'
    }))
  }

  const report = accumulator.snapshot()
  assert.equal(report.outcome, 'abnormal-exit')
  assert.equal(report.counters.droppedIncidentCount, 1)
  assert.equal(report.incidents.some((incident) => incident.source === 'utility-fatal'), true)
  validateEvidenceReport(report)
})

test('breakpoint roles replace bounded low-value incidents and remain ambiguous across roles', () => {
  const accumulator = createEvidenceAccumulator({ now: () => 1700000000000 })
  for (let index = 0; index < MAX_INCIDENTS; index += 1) {
    accumulator.acceptIpcMessage(incidentEnvelope({
      role: 'renderer', source: 'unresponsive', reason: 'unresponsive',
      statusClass: 'not-observed'
    }))
  }
  for (const role of ['realtime', 'storage']) {
    accumulator.acceptIpcMessage(incidentEnvelope({
      role, source: 'child-process-gone', reason: 'crashed',
      statusClass: 'breakpoint-0x80000003'
    }))
  }

  const report = accumulator.snapshot()
  assert.deepEqual(report.incidents
    .filter((incident) => incident.statusClass === 'breakpoint-0x80000003')
    .map((incident) => incident.role), ['realtime', 'storage'])
  assert.deepEqual(report.attribution, {
    breakpointObserved: true,
    role: null,
    confidence: 'ambiguous'
  })
  assert.equal(report.counters.droppedIncidentCount, 2)
  validateEvidenceReport(report)
})

test('new breakpoint role evicts only a repeated breakpoint when the cap contains no non-breakpoints', () => {
  const accumulator = createEvidenceAccumulator({ now: () => 1700000000000 })
  for (let index = 0; index < MAX_INCIDENTS; index += 1) {
    accumulator.acceptIpcMessage(incidentEnvelope({
      role: 'renderer', source: 'render-process-gone', reason: 'crashed',
      statusClass: 'breakpoint-0x80000003'
    }))
  }
  accumulator.acceptIpcMessage(incidentEnvelope({
    role: 'storage', source: 'child-process-gone', reason: 'crashed',
    statusClass: 'breakpoint-0x80000003'
  }))

  const report = accumulator.snapshot()
  assert.equal(report.incidents.filter((incident) => incident.role === 'renderer').length, MAX_INCIDENTS - 1)
  assert.equal(report.incidents.filter((incident) => incident.role === 'storage').length, 1)
  assert.equal(report.counters.droppedIncidentCount, 1)
  assert.equal(report.attribution.confidence, 'ambiguous')
  validateEvidenceReport(report)
})

test('main breakpoint remains bounded and exactly attributable after the cap', () => {
  const accumulator = createEvidenceAccumulator({ now: () => 1700000000000 })
  for (let index = 0; index < MAX_INCIDENTS; index += 1) {
    accumulator.acceptIpcMessage(incidentEnvelope({
      role: 'audio-host', source: 'unresponsive', reason: 'unresponsive',
      statusClass: 'not-observed'
    }))
  }
  accumulator.finishMainExit(-2147483645)

  const report = accumulator.snapshot()
  assert.deepEqual(report.attribution, {
    breakpointObserved: true,
    role: 'main',
    confidence: 'exact-handle'
  })
  assert.equal(report.incidents.some((incident) =>
    incident.role === 'main' && incident.statusClass === 'breakpoint-0x80000003'), true)
  assert.equal(report.outcome, 'abnormal-exit')
  assert.equal(report.counters.droppedIncidentCount, 1)
  validateEvidenceReport(report)
})

test('multiple breakpoint roles are reported as ambiguous instead of guessed', () => {
  const accumulator = createEvidenceAccumulator({ now: () => 1700000000000 })
  accumulator.acceptIpcMessage(incidentEnvelope({
    role: 'renderer', source: 'render-process-gone', reason: 'crashed',
    statusClass: 'breakpoint-0x80000003'
  }))
  accumulator.acceptIpcMessage(incidentEnvelope({
    role: 'storage', source: 'child-process-gone', reason: 'crashed',
    statusClass: 'breakpoint-0x80000003'
  }))
  accumulator.finishMainExit(0)
  const report = accumulator.snapshot()
  assert.deepEqual(report.attribution, {
    breakpointObserved: true,
    role: null,
    confidence: 'ambiguous'
  })
  validateEvidenceReport(report)
})

test('clean child exits do not become crash incidents', () => {
  const sent = []
  const bridge = createMainEvidenceBridge({ send: (value) => sent.push(value) })
  assert.equal(bridge.recordChildProcessGone({
    type: 'Utility',
    serviceName: 'Speech Agent subtitle storage',
    reason: 'clean-exit',
    exitCode: 0
  }), false)
  assert.deepEqual(sent, [])
})
