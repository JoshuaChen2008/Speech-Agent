'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  isGestureIntent,
  isInteractionReadyIntent,
  isInteractionSync,
  isMouseThroughIntent,
  isResizeStartIntent,
  resumeSync,
  suspendSync
} = require('../../src/contracts/window-interaction')

test('SEM-F22/SEM-F24/J17/J19: preload readiness intent is exact and versioned', () => {
  assert.equal(isInteractionReadyIntent({ schemaVersion: 1 }), true)
  assert.equal(isInteractionReadyIntent({ schemaVersion: 2 }), false)
  assert.equal(isInteractionReadyIntent({ schemaVersion: 1, extra: true }), false)
  assert.equal(isInteractionReadyIntent(null), false)
})

test('SEM-F22/SEM-F24/J17/J19: window interaction sync is an exact role-scoped union', () => {
  assert.deepEqual(suspendSync(2), { schemaVersion: 1, generation: 2, phase: 'suspend' })
  assert.deepEqual(resumeSync(2, { x: -12.5, y: 800 }), {
    schemaVersion: 1,
    generation: 2,
    phase: 'resume',
    pointer: { x: -12.5, y: 800 }
  })
  assert.equal(isInteractionSync(suspendSync(2), 'caption'), true)
  assert.equal(isInteractionSync(resumeSync(2, { x: -12.5, y: 800 }), 'toolbar'), true)
  assert.equal(isInteractionSync(resumeSync(2, null), 'settings'), true)
  assert.equal(isInteractionSync(resumeSync(2, null), 'history'), true)

  for (const value of [
    { schemaVersion: 1, generation: 2, phase: 'suspend', pointer: null },
    { schemaVersion: 1, generation: 2, phase: 'resume' },
    { schemaVersion: 1, generation: 2, phase: 'resume', pointer: null },
    { schemaVersion: 1, generation: 2, phase: 'resume', pointer: { x: 1, y: Number.NaN } },
    { schemaVersion: 1, generation: 2, phase: 'resume', pointer: { x: 1, y: 2, extra: true } },
    { schemaVersion: 1, generation: 0, phase: 'suspend' },
    { schemaVersion: 2, generation: 2, phase: 'suspend' }
  ]) assert.equal(isInteractionSync(value, 'caption'), false)

  assert.equal(isInteractionSync(resumeSync(2, { x: 1, y: 2 }), 'settings'), false)
  assert.equal(isInteractionSync(resumeSync(2, null), 'toolbar'), false)
})

test('SEM-F22/SEM-F24/J17/J19: renderer interaction intents require exact current-generation shapes', () => {
  assert.equal(isMouseThroughIntent({ schemaVersion: 1, generation: 3, ignore: true }), true)
  assert.equal(isGestureIntent({ schemaVersion: 1, generation: 3 }), true)
  assert.equal(isResizeStartIntent({ schemaVersion: 1, generation: 3, edge: 'sw' }), true)

  assert.equal(isMouseThroughIntent({ schemaVersion: 1, generation: 3, ignore: 1 }), false)
  assert.equal(isMouseThroughIntent({ schemaVersion: 1, generation: 3, ignore: true, extra: true }), false)
  assert.equal(isGestureIntent({ schemaVersion: 1, generation: 3, edge: 'e' }), false)
  assert.equal(isResizeStartIntent({ schemaVersion: 1, generation: 3, edge: 'center' }), false)
})
