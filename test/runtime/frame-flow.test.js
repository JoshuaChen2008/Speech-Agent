'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { FrameFlow } = require('../../src/runtime/audio-host/frame-flow')
const {
  sanitizeControlMessage,
  validateCaptureOptions
} = require('../../src/runtime/audio-host/policy')

function frame (sequence, sampleCount = 1600) {
  return { type: 'frame', sourceId: 'mic', sequence, sampleCount }
}

function makeFlow (options = {}) {
  const sent = []
  const flow = new FrameFlow({ send: (item) => sent.push(item.sequence), sampleRate: 16000, ...options })
  return { flow, sent }
}

test('frames are sent directly while credits last and stall afterwards', () => {
  const { flow, sent } = makeFlow({ initialCredits: 2, maxQueueMs: 1000 })
  flow.handleFrame(frame(1))
  flow.handleFrame(frame(2))
  flow.handleFrame(frame(3))
  assert.deepEqual(sent, [1, 2])
  const metrics = flow.metrics()
  assert.equal(metrics.sentFrames, 2)
  assert.equal(metrics.queuedFrames, 1)
  assert.equal(metrics.creditStalls, 1)
  assert.equal(metrics.credits, 0)
})

test('granting credits drains the queue in FIFO order before live frames', () => {
  const { flow, sent } = makeFlow({ maxQueueMs: 2000 })
  flow.handleFrame(frame(1))
  flow.handleFrame(frame(2))
  assert.deepEqual(sent, [])
  flow.grantCredits(3)
  assert.deepEqual(sent, [1, 2])
  flow.handleFrame(frame(3))
  assert.deepEqual(sent, [1, 2, 3], '剩余 credit 直接发实时帧')
  assert.equal(flow.metrics().credits, 0)
})

test('the queue is bounded by maxQueueMs and drops the oldest frames', () => {
  const { flow, sent } = makeFlow({ maxQueueMs: 300 })
  for (let sequence = 1; sequence <= 5; sequence += 1) flow.handleFrame(frame(sequence))
  const metrics = flow.metrics()
  assert.equal(metrics.droppedFrames, 2, '100ms×5 帧对 300ms 预算丢 2 帧')
  assert.equal(metrics.queuedFrames, 3)
  assert.equal(metrics.queuedMs, 300)
  assert.ok(metrics.maxQueuedMsObserved <= 400, '瞬时峰值不超过预算+1帧')

  flow.grantCredits(10)
  assert.deepEqual(sent, [3, 4, 5], '最旧的 1、2 被丢弃，消费端会看到 sequence 缺口')
})

test('queue duration accounts for variable frame sizes', () => {
  const { flow } = makeFlow({ maxQueueMs: 150 })
  flow.handleFrame(frame(1, 800))
  flow.handleFrame(frame(2, 800))
  flow.handleFrame(frame(3, 800))
  const metrics = flow.metrics()
  assert.equal(metrics.queuedFrames, 3)
  assert.equal(metrics.queuedMs, 150)
  flow.handleFrame(frame(4, 1600))
  assert.equal(flow.metrics().droppedFrames, 2)
})

test('discardQueued clears the queue and counts the loss', () => {
  const { flow, sent } = makeFlow({ maxQueueMs: 1000 })
  flow.handleFrame(frame(1))
  flow.handleFrame(frame(2))
  assert.equal(flow.discardQueued(), 2)
  assert.equal(flow.metrics().droppedFrames, 2)
  assert.equal(flow.metrics().queuedFrames, 0)
  flow.grantCredits(1)
  assert.deepEqual(sent, [], '丢弃后的授信不重放旧帧')
})

test('port replacement invalidates credits, keeps the queue, and accounts in-flight loss', () => {
  const { flow, sent } = makeFlow({ initialCredits: 5, maxQueueMs: 1000 })
  flow.handleFrame(frame(1))
  flow.handleFrame(frame(2))
  assert.deepEqual(sent, [1, 2])
  flow.acknowledge(1)

  flow.markPortReplaced()
  const afterReplace = flow.metrics()
  assert.equal(afterReplace.credits, 0, '旧 credit 作废')
  assert.equal(afterReplace.lostInFlightFrames, 1, '已发送未确认的帧计入在途损失上界')
  assert.equal(afterReplace.portReplacements, 1)

  flow.handleFrame(frame(3))
  assert.deepEqual(sent, [1, 2], '替换后帧只能排队等新消费端授信')
  assert.equal(flow.metrics().queuedFrames, 1)
  flow.grantCredits(1)
  assert.deepEqual(sent, [1, 2, 3])

  /* 第二次替换：frame 3 未确认 → 再计 1。 */
  flow.markPortReplaced()
  assert.equal(flow.metrics().lostInFlightFrames, 2)
})

test('acknowledge is clamped to frames actually sent and ignores junk', () => {
  const { flow } = makeFlow({ initialCredits: 2, maxQueueMs: 1000 })
  flow.handleFrame(frame(1))
  flow.acknowledge(99)
  assert.equal(flow.metrics().acknowledgedFrames, 1, '确认数不能超过已发送数')
  flow.acknowledge(0)
  flow.acknowledge(-1)
  flow.acknowledge(1.5)
  assert.equal(flow.metrics().acknowledgedFrames, 1)
  flow.markPortReplaced()
  assert.equal(flow.metrics().lostInFlightFrames, 0, '全部已确认则无在途损失')
})

test('frame flow rejects invalid construction and input', () => {
  assert.throws(() => new FrameFlow({}), /send/)
  assert.throws(() => new FrameFlow({ send () {}, maxQueueMs: 0 }), /maxQueueMs/)
  const { flow } = makeFlow()
  assert.throws(() => flow.handleFrame({ sampleCount: 0 }), /sampleCount/)
  assert.throws(() => flow.grantCredits(0), /credits/)
  assert.throws(() => flow.grantCredits(1.5), /credits/)
})

test('capture options validation enforces the queue budget range', () => {
  const normalized = validateCaptureOptions({ sessionId: 's-1', sourceIds: ['loopback'], maxQueueMs: 500 })
  assert.deepEqual(normalized, { sessionId: 's-1', sourceIds: ['loopback'], maxQueueMs: 500, micLabelSha256: null })
  assert.equal(validateCaptureOptions({ sessionId: 's', sourceIds: ['mic'] }).maxQueueMs, 2000)
  const micHash = 'a'.repeat(64)
  assert.equal(validateCaptureOptions({ sessionId: 's', sourceIds: ['mic'], micLabelSha256: micHash }).micLabelSha256, micHash)
  assert.throws(() => validateCaptureOptions({ sessionId: 's', sourceIds: ['mic'], micLabelSha256: 'not-a-hash' }), /SHA-256/)
  assert.throws(() => validateCaptureOptions({ sessionId: 's', sourceIds: ['loopback'], micLabelSha256: micHash }), /only valid for mic/)
  assert.throws(() => validateCaptureOptions({ sessionId: 's', sourceIds: ['mic'], maxQueueMs: 100 }), /maxQueueMs/)
  assert.throws(() => validateCaptureOptions({ sessionId: 's', sourceIds: ['mic'], maxQueueMs: 20000 }), /maxQueueMs/)
  assert.throws(() => validateCaptureOptions({ sessionId: 's', sourceIds: ['tv'] }), /unknown sourceId/)
  assert.throws(() => validateCaptureOptions({ sessionId: 's', sourceIds: ['mic', 'loopback'] }), /exactly one/)
  assert.throws(() => validateCaptureOptions(null), /options/)
})

test('control messages are whitelist-sanitized at the main boundary', () => {
  assert.equal(sanitizeControlMessage(null), null)
  assert.equal(sanitizeControlMessage({ type: 'evil' }), null)
  assert.equal(sanitizeControlMessage({ type: 'track-ended', sourceId: 'webcam' }), null)

  const ended = sanitizeControlMessage({ type: 'track-ended', sessionId: 's-1', sourceId: 'mic', extra: 'x' })
  assert.deepEqual(ended, { type: 'track-ended', sessionId: 's-1', sourceId: 'mic' })

  const metrics = sanitizeControlMessage({
    type: 'metrics',
    sessionId: 'x'.repeat(500),
    sources: {
      loopback: { capturedFrames: 40, droppedFrames: 2, evil: 'C:\\Users\\x', queuedMs: 100.5 },
      webcam: { capturedFrames: 1 },
      mic: 'not-an-object'
    }
  })
  assert.equal(metrics.sessionId.length, 128)
  assert.deepEqual(metrics.sources, { loopback: { capturedFrames: 40, droppedFrames: 2, queuedMs: 100.5 } })

  const stopped = sanitizeControlMessage({ type: 'stopped', sessionId: 's', sources: null })
  assert.deepEqual(stopped, { type: 'stopped', sessionId: 's', sources: {} })
})
