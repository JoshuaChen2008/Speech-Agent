'use strict'

const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')

const { RefinementController } = require('../../src/runtime/realtime-worker/refinement-controller')

class FakePort extends EventEmitter {
  constructor () {
    super()
    this.messages = []
    this.started = false
  }

  postMessage (message) {
    this.messages.push(message)
  }

  start () {
    this.started = true
  }

  close () {
    this.emit('close')
  }

  respond (message) {
    this.emit('message', { data: message })
  }
}

function segment (ordinal) {
  return {
    sourceId: 'mic',
    segmentId: `seg-mic-${ordinal}`,
    baseRevision: ordinal,
    t0: ordinal,
    t1: ordinal + 0.5,
    chunks: [new Float32Array([ordinal, ordinal + 0.25])]
  }
}

function harness () {
  const published = []
  const faults = []
  const controller = new RefinementController({
    emitRefined: (info, text) => ({
      kind: 'refined',
      segmentId: info.segmentId,
      revision: info.baseRevision + 1,
      text
    }),
    publish: (message) => published.push(message),
    publishFault: (fault) => faults.push(fault)
  })
  const port = new FakePort()
  controller.attachPort(port)
  return { controller, port, published, faults }
}

test('refined responses arriving while paused wait for resume ack and keep arrival order', () => {
  const { controller, port, published } = harness()
  assert.equal(controller.request(segment(1)), true)
  assert.equal(controller.request(segment(2)), true)
  assert.equal(port.started, true)

  controller.pause()
  port.respond({ type: 'refined', requestId: 1, text: ' 第一条。 ' })
  port.respond({ type: 'refined', requestId: 2, text: '第二条。' })

  assert.deepEqual(published, [], 'paused 相位不得发布 caption')
  assert.equal(controller.bufferedWhilePaused.length, 2)
  assert.equal(controller.pending.size, 0)

  controller.resume(() => published.push({ type: 'resumed' }))

  assert.deepEqual(published.map((message) => message.type), ['resumed', 'caption', 'caption'])
  assert.deepEqual(
    published.slice(1).map((message) => [message.event.segmentId, message.event.text]),
    [['seg-mic-1', '第一条。'], ['seg-mic-2', '第二条。']]
  )
  assert.equal(controller.bufferedWhilePaused.length, 0)

  controller.resume(() => published.push({ type: 'resumed-again' }))
  assert.deepEqual(published.map((message) => message.type), ['resumed', 'caption', 'caption', 'resumed-again'])
})

test('end stops new refinement requests before flushing and clears in-flight work', () => {
  const { controller, port, published, faults } = harness()
  assert.equal(controller.request(segment(1)), true)

  controller.end(() => {
    assert.equal(controller.request(segment(2)), false, 'end-flushed segment must stay final')
  })
  assert.equal(controller.request(segment(3)), false, 'requests after end must be skipped')

  assert.equal(controller.accepting, false)
  assert.equal(controller.pending.size, 0)
  assert.equal(controller.skipped, 2)
  assert.equal(port.messages.length, 1)

  port.respond({ type: 'refined', requestId: 1, text: '迟到结果' })
  assert.equal(controller.pending.size, 0)
  assert.deepEqual(published, [], 'end-cleared late responses must not publish')
  assert.deepEqual(faults, [], 'normal stop must not report a refinement fault')
})

test('first refinement failure disables only refinement and publishes a stable safe fault once', () => {
  const { controller, port, faults } = harness()
  controller.enabled = true
  assert.equal(controller.request(segment(1)), true)

  port.respond({
    type: 'refine-failed',
    requestId: 1,
    message: 'C:\\private\\model.onnx: decoder rejected transcript text'
  })
  port.respond({ type: 'refined', requestId: 1, text: 42 })
  port.close()

  assert.deepEqual(faults, [{
    code: 'REFINE_DECODE_FAILED',
    stage: 'decode'
  }])
  assert.equal(controller.enabled, false)
  assert.equal(controller.accepting, false)
  assert.equal(controller.request(segment(2)), false)
  assert.equal(JSON.stringify(faults).includes('private'), false)
  assert.equal(JSON.stringify(faults).includes('transcript'), false)
})

test('invalid refinement response reports its stable code and retains no pending work', () => {
  const { controller, port, faults } = harness()
  controller.enabled = true
  assert.equal(controller.request(segment(1)), true)

  port.respond({ type: 'refined', requestId: 1, text: { unexpected: true } })

  assert.deepEqual(faults, [{
    code: 'REFINE_INVALID_RESPONSE',
    stage: 'response'
  }])
  assert.equal(controller.pending.size, 0)
  assert.equal(controller.enabled, false)
})

test('refine port close invalidates pending requests and degrades to skipping', () => {
  const { controller, port, published } = harness()
  assert.equal(controller.request(segment(1)), true)
  assert.equal(controller.request(segment(2)), true)
  assert.equal(controller.pending.size, 2)

  port.close()

  assert.equal(controller.port, null)
  assert.equal(controller.pending.size, 0)
  assert.equal(controller.request(segment(3)), false)
  assert.equal(controller.skipped, 1)
  assert.equal(port.messages.length, 2)

  port.respond({ type: 'refined', requestId: 1, text: '迟到结果' })
  assert.deepEqual(published, [])
})

test('port replacement retires old pending without letting a delayed close clear new work', () => {
  const { controller, port: oldPort } = harness()
  oldPort.close = () => { oldPort.closeRequested = true }
  assert.equal(controller.request(segment(1)), true)

  const newPort = new FakePort()
  controller.attachPort(newPort)
  assert.equal(oldPort.closeRequested, true)
  assert.equal(controller.pending.size, 0, 'old generation must be retired immediately')

  assert.equal(controller.request(segment(2)), true)
  oldPort.emit('close')
  assert.equal(controller.port, newPort)
  assert.equal(controller.pending.size, 1, 'delayed old close must not clear new generation')

  newPort.close()
  assert.equal(controller.port, null)
  assert.equal(controller.pending.size, 0)
})
