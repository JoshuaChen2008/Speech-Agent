'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const {
  RefinementNoticeStore,
  buildRefinementNotice
} = require('../../src/main/services/refinement-notice')

function refinement (overrides = {}) {
  return {
    segmentCount: 100,
    refinedSegmentCount: 73,
    refinementResultStatus: 'known',
    refinementEnabled: true,
    refinementFaultCode: 'REFINE_WORKER_EXITED',
    ...overrides
  }
}

test('notice copy reports a fault independently from whole-session coverage', () => {
  assert.deepEqual(buildRefinementNotice('session-1', refinement()), {
    schemaVersion: 1,
    kind: 'refinement-fault',
    sessionId: 'session-1',
    message: '精修异常，已精修 73/100 段，其余保留原字幕'
  })
  assert.equal(
    buildRefinementNotice('session-1', refinement({ refinedSegmentCount: 100 })).message,
    '精修进程异常结束，但本次已生成 100/100 段精修稿'
  )
  assert.equal(
    buildRefinementNotice('session-1', refinement({ segmentCount: 0, refinedSegmentCount: 0 })).message,
    '精修进程异常结束；本会话未产生可精修的已定稿字幕'
  )
  assert.equal(buildRefinementNotice('session-1', refinement({ refinementFaultCode: null })), null)
  assert.equal(buildRefinementNotice('session-1', refinement({ refinementResultStatus: 'not_recorded' })), null)
})

test('notice store is memory-only and remains until an explicit lifecycle clear', () => {
  const store = new RefinementNoticeStore()
  const changes = []
  store.onChanged((notice) => changes.push(notice))

  assert.equal(store.get(), null, 'a fresh process never replays an old notice')
  store.setFromResult('session-1', refinement())
  assert.equal(store.get().sessionId, 'session-1')
  assert.equal(store.get().message.includes('73/100'), true)
  assert.equal(store.get().message.includes('摘要'), false)

  store.clear()
  assert.equal(store.get(), null)
  assert.deepEqual(changes.map((notice) => notice?.sessionId || null), ['session-1', null])
  assert.equal(store.clear(), false, 'clearing an already empty notice is idempotent')
})

test('notice rejects unbounded or renderer-invented result shapes', () => {
  assert.throws(() => buildRefinementNotice('', refinement()), /session id/)
  assert.throws(() => buildRefinementNotice('session-1', {
    ...refinement(),
    segmentCount: 1,
    refinedSegmentCount: 2
  }), /coverage/)
  assert.throws(() => buildRefinementNotice('session-1', {
    ...refinement(),
    rawError: 'private path'
  }), /exact result shape/)
})
