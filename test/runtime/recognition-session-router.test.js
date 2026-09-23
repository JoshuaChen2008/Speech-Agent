'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { RecognitionSessionRouter } = require('../../src/runtime/recognition/recognition-session-router')
const { assertCaptionEvent } = require('../../src/contracts/caption-event')
const reducer = require('../../src/ui/shared/caption-reducer')

function fixture () {
  const events = []; const controls = []; const statuses = []; const state = reducer.createState()
  const router = new RecognitionSessionRouter({ sessionId: 'session', sourceId: 'mic', now: () => 1200,
    emit: event => { assertCaptionEvent(event); events.push(event); reducer.applyEvent(state, event); return true },
    control: value => controls.push(value), status: value => statuses.push(value) })
  router.openStream(0)
  for (let i = 0; i < 10; i++) router.audio(i * 1600, 1600)
  return { router, events, controls, statuses, state }
}

test('SEM-F04/J20 cloud final is unique and fallback removes only the abandoned partial', () => {
  const f = fixture(); const r = f.router
  r.result(1, { kind: 'begin', index: 1, timeMs: 0 })
  r.result(1, { kind: 'partial', index: 1, timeMs: 200, text: '临时' })
  r.result(1, { kind: 'final', index: 1, beginMs: 0, timeMs: 400, text: '原始' })
  assert.equal(r.result(1, { kind: 'final', index: 1, beginMs: 0, timeMs: 400, text: '原始' }), false)
  r.result(1, { kind: 'begin', index: 2, timeMs: 500 })
  r.result(1, { kind: 'partial', index: 2, timeMs: 800, text: '丢弃假设' })
  assert.equal(r.fallback('NLS_CONNECTION_CLOSED'), true)
  assert.equal(r.actualProvider, 'nls')
  assert.equal(f.statuses.length, 0)
  assert.equal(r.confirmTakeover(), true)
  assert.equal(r.fallback('NLS_SERVICE_FAILED'), false)
  assert.deepEqual(f.state.segments.map(segment => segment.text), ['原始'])
  assert.deepEqual(f.controls.at(-1), { type: 'takeover', sample: 6400 })
  assert.equal(r.result(1, { kind: 'final', index: 2, beginMs: 500, timeMs: 900, text: '迟到' }), false)
  assert.equal(f.events.filter(event => event.kind === 'final').length, 1)
  assert.equal(f.statuses[0].actualProvider, 'local')
})

test('SEM-F06/J20 resumed task rejects old generation and preserves session time and sequence', () => {
  const f = fixture(); const r = f.router
  r.result(1, { kind: 'final', index: 1, beginMs: 0, timeMs: 400, text: '先前' })
  r.openStream(7)
  r.audio(0, 1600)
  assert.equal(r.result(1, { kind: 'final', index: 2, beginMs: 0, timeMs: 100, text: '迟到' }), false)
  r.result(2, { kind: 'final', index: 1, beginMs: 0, timeMs: 100, text: '恢复' })
  assert.equal(f.events[1].t0, 7)
  assert.equal(f.events[1].t1, 7.1)
  assert.ok(f.events[1].sequence > f.events[0].sequence)
  assert.notEqual(f.events[1].segmentId, f.events[0].segmentId)
})

test('SEM-F04/J20 conflicting finals and results beyond sent samples fail closed', () => {
  const f = fixture(); const r = f.router
  r.result(1, { kind: 'final', index: 1, beginMs: 0, timeMs: 400, text: '原始' })
  assert.throws(() => r.result(1, { kind: 'final', index: 1, beginMs: 0, timeMs: 400, text: '覆盖' }), /NLS_INVALID_RESPONSE/)
  assert.throws(() => r.result(1, { kind: 'begin', index: 2, timeMs: 1001 }), /NLS_INVALID_RESPONSE/)
  assert.equal(f.events.length, 1)
})

test('SEM-F21/J20 failed worker takeover never publishes local provider and retains the first fault', () => {
  const f = fixture(); const r = f.router
  r.fallback('NLS_CONNECTION_CLOSED')
  r.fail('RECOGNITION_AUDIO_GAP')
  assert.equal(r.confirmTakeover(), false)
  assert.equal(r.actualProvider, 'nls')
  assert.equal(f.statuses[0].fallbackCode, null)
  r.fail('RECOGNITION_FALLBACK_FAILED')
  assert.equal(f.statuses.at(-1).faultCode, 'RECOGNITION_AUDIO_GAP')
})
