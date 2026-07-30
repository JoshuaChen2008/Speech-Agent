'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { DEV_MODEL_VALUE, resolveRuntimeOptions } = require('../../src/main/runtime-options')
const { FakeRuntimeAdapter } = require('../../src/main/session/fake-runtime-adapter')
const { SessionCoordinator } = require('../../src/main/session/session-coordinator')

const DEV_MODEL = resolveRuntimeOptions({ LIVE_SUBTITLE_DEV_MODEL: DEV_MODEL_VALUE })
const MEETING = {
  onboardingCompleted: true,
  onboardingPreset: 'meeting',
  mic: false,
  loopback: true
}

function deferred () {
  let resolve
  let reject
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function caption (sessionId, overrides = {}) {
  return {
    schemaVersion: 1,
    sessionId,
    sourceId: 'loopback',
    segmentId: 'segment-1',
    sequence: 1,
    revision: 1,
    kind: 'final',
    t0: 0,
    t1: 1,
    text: '已定稿。',
    translation: null,
    ...overrides
  }
}

function fixture (sinkOverrides = {}) {
  const calls = []
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  let starts = 0
  let stops = 0
  const adapterStart = adapter.start.bind(adapter)
  const adapterStop = adapter.stop.bind(adapter)
  adapter.start = async (context) => { starts += 1; return adapterStart(context) }
  adapter.stop = async (options) => { stops += 1; return adapterStop(options) }
  const sink = {
    openSession: async (payload) => { calls.push(['open', structuredClone(payload)]) },
    acceptCaption: (event) => { calls.push(['caption', structuredClone(event)]); return Promise.resolve() },
    closeSession: async (payload) => { calls.push(['close', structuredClone(payload)]) },
    retry: async () => { calls.push(['retry']) },
    flush: async () => { calls.push(['flush']) },
    ...sinkOverrides
  }
  const coordinator = new SessionCoordinator({
    adapter,
    runtimeOptions: DEV_MODEL,
    configuration: MEETING,
    idFactory: () => 'durable-session',
    persistenceSink: sink
  })
  return { adapter, calls, coordinator, sink, starts: () => starts, stops: () => stops }
}

test('start waits for durable session open before starting capture', async (t) => {
  const opening = deferred()
  const context = fixture({
    openSession: async (payload) => {
      context.calls.push(['open', structuredClone(payload)])
      return opening.promise
    }
  })
  t.after(() => context.coordinator.dispose())

  const starting = context.coordinator.command('start')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(context.coordinator.getSnapshot().phase, 'starting')
  assert.equal(context.starts(), 0)
  assert.deepEqual(context.calls[0], ['open', { sessionId: 'durable-session', sourceId: 'loopback' }])

  opening.resolve({ status: 'committed' })
  assert.equal((await starting).ok, true)
  assert.equal(context.starts(), 1)
  assert.equal(context.coordinator.getSnapshot().phase, 'listening')
})

test('persistence sink enqueues final before UI and stop stays stopping through close ACK', async (t) => {
  const closing = deferred()
  const order = []
  const context = fixture({
    acceptCaption: (event) => { order.push(`sink:${event.kind}`); return Promise.resolve() },
    closeSession: async (payload) => {
      context.calls.push(['close', structuredClone(payload)])
      return closing.promise
    }
  })
  t.after(() => context.coordinator.dispose())
  context.coordinator.onCaption((event) => order.push(`ui:${event.kind}`))
  await context.coordinator.command('start')
  context.adapter.emitCaption(caption('durable-session'))
  assert.deepEqual(order, ['sink:final', 'ui:final'])

  const stopping = context.coordinator.command('stop')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(context.coordinator.getSnapshot().phase, 'stopping')
  let settled = false
  stopping.finally(() => { settled = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)

  closing.resolve({ status: 'committed' })
  assert.equal((await stopping).ok, true)
  assert.equal(context.coordinator.getSnapshot().phase, 'idle')
  assert.deepEqual(context.calls.at(-1), ['close', {
    sessionId: 'durable-session', sourceId: 'loopback', state: 'closed'
  }])
})

test('close failure retains the session; retry only drains storage and then publishes idle', async (t) => {
  const context = fixture({
    closeSession: async (payload) => {
      context.calls.push(['close', structuredClone(payload)])
      throw new Error('storage unavailable')
    }
  })
  t.after(() => context.coordinator.dispose())
  await context.coordinator.command('start')
  const result = await context.coordinator.command('stop')
  assert.equal(result.code, 'STORAGE_CLOSE_FAILED')
  assert.equal(context.coordinator.getSnapshot().phase, 'error')
  assert.equal(context.coordinator.getSnapshot().lastError.scope, 'storage')
  assert.equal(context.coordinator.getSnapshot().sessionId, 'durable-session')
  assert.equal(context.starts(), 1)
  assert.equal(context.stops(), 1)

  assert.equal((await context.coordinator.command('retry')).ok, true)
  assert.equal(context.coordinator.getSnapshot().phase, 'idle')
  assert.equal(context.starts(), 1, 'close retry must not start a second capture')
  assert.equal(context.stops(), 1)
})

test('append failure stops capture, retains the session and resumes only after backlog retry', async (t) => {
  const context = fixture({
    acceptCaption: () => Promise.reject(new Error('append transport exhausted'))
  })
  t.after(() => context.coordinator.dispose())
  await context.coordinator.command('start')
  context.adapter.emitCaption(caption('durable-session'))
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(context.coordinator.getSnapshot().phase, 'error')
  assert.equal(context.coordinator.getSnapshot().lastError.code, 'STORAGE_APPEND_FAILED')
  assert.equal(context.adapter.context, null, 'capture adapter must be stopped after durable queue failure')
  assert.equal(context.stops(), 1)

  assert.equal((await context.coordinator.command('retry')).ok, true)
  assert.equal(context.coordinator.getSnapshot().phase, 'listening')
  assert.equal(context.coordinator.getSnapshot().sessionId, 'durable-session')
  assert.equal(context.starts(), 2)
})

test('open failure never starts capture and retry resumes the same frozen session', async (t) => {
  const context = fixture({
    openSession: async () => { throw new Error('open failed') }
  })
  t.after(() => context.coordinator.dispose())
  const result = await context.coordinator.command('start')
  assert.equal(result.code, 'STORAGE_OPEN_FAILED')
  assert.equal(context.starts(), 0)
  assert.equal(context.coordinator.getSnapshot().sessionId, 'durable-session')
  assert.equal(context.coordinator.getSnapshot().phase, 'error')

  assert.equal((await context.coordinator.command('retry')).ok, true)
  assert.equal(context.starts(), 1)
  assert.equal(context.coordinator.getSnapshot().phase, 'listening')
  assert.equal(context.coordinator.getSnapshot().sessionId, 'durable-session')
})

test('application quit closes an active durable session as interrupted before disposal', async () => {
  const context = fixture()
  await context.coordinator.command('start')
  context.adapter.emitCaption(caption('durable-session'))

  await context.coordinator.shutdownForAppQuit()

  assert.equal(context.coordinator.getSnapshot().phase, 'idle')
  assert.equal(context.adapter.context, null)
  assert.deepEqual(context.calls.filter(([name]) => name === 'close'), [[
    'close',
    { sessionId: 'durable-session', sourceId: 'loopback', state: 'interrupted' }
  ]])
  assert.equal(context.calls.some(([name]) => name === 'flush'), true)
  const afterQuit = await context.coordinator.command('start')
  assert.equal(afterQuit.code, 'COORDINATOR_CLOSED')
})
