'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { CloudAudioBuffer, RETAIN_SAMPLES } = require('../../src/runtime/recognition/cloud-audio-buffer')
const { WorkerCore } = require('../../src/runtime/realtime-worker/worker-core')

function fixture () {
  const core = new WorkerCore({ sessionId: 'buffer', sourceIds: ['mic'] })
  const sent = []; const faults = []; const events = []
  const buffer = new CloudAudioBuffer({ core, send: value => sent.push(value),
    emit: event => events.push(event), fault: code => faults.push(code) })
  const feed = (index, acknowledge = true) => {
    buffer.ingestFrame({ sourceId: 'mic', sequence: index, timestampSeconds: index / 10,
      sampleCount: 1600, samples: new Float32Array(1600) })
    if (acknowledge) buffer.acknowledge(index)
  }
  return { core, sent, faults, events, buffer, feed }
}

test('SEM-F14/J20 silent cloud audio stays bounded without invoking local recognition', async () => {
  const f = fixture()
  for (let i = 0; i < 650; i++) f.feed(i)
  assert.deepEqual(f.faults, [])
  assert.equal(f.buffer.queuedSamples, RETAIN_SAMPLES)
  assert.equal(f.buffer.pendingSamples, 0)
  assert.equal(f.core.sources.get('mic').adapter.framesAccepted, 0)
  // The last accepted SentenceEnd predates the retained range: fail closed.
  f.buffer.takeover(0)
  assert.deepEqual(f.faults, ['RECOGNITION_AUDIO_GAP'])
  assert.equal(f.buffer.frames.length, 0)
  await f.buffer.end()
  f.core.dispose()
})

test('SEM-F12/J20 unfinished cloud segment uses rolling retention and rejects missing handoff range', () => {
  const f = fixture()
  f.feed(0); f.buffer.begin(0)
  for (let i = 1; i < 1800; i++) f.feed(i)
  assert.deepEqual(f.faults, [])
  assert.equal(f.buffer.queuedSamples, RETAIN_SAMPLES)
  f.buffer.takeover(0)
  assert.deepEqual(f.faults, ['RECOGNITION_AUDIO_GAP'])
  assert.equal(f.buffer.pendingSamples, 0)
  f.core.dispose()
})

test('SEM-F12/J20 unacknowledged audio fails at two seconds and releases retained samples', () => {
  const f = fixture()
  for (let i = 0; i <= 20; i++) f.feed(i, false)
  assert.equal(f.sent.length, 20)
  assert.deepEqual(f.faults, ['RECOGNITION_BUFFER_LIMIT'])
  assert.equal(f.buffer.frames.length, 0)
  f.core.dispose()
})

test('SEM-F21/J20 handoff uses the sample cut, drains real worker core, and emits no fabricated transcript', async () => {
  const f = fixture()
  for (let i = 0; i < 10; i++) f.feed(i)
  f.buffer.commit(2400)
  f.buffer.takeover(2400)
  assert.equal(f.buffer.frames[0].timestampSeconds, 0.15)
  assert.equal(f.buffer.frames[0].sampleCount, 800)
  f.feed(10)
  await f.buffer.end()
  assert.deepEqual(f.faults, [])
  assert.deepEqual(f.events, []) // Null recognizer is only structural evidence.
  assert.equal(f.buffer.frames.length, 0)
  assert.equal(f.buffer.pendingSamples, 0)
  assert.equal(f.buffer.cloud, false)
  f.core.dispose()
})

test('SEM-F12/J20 gaps and nonfinite samples reject the entire frame', () => {
  for (const change of [{ sequence: 1 }, { timestampSeconds: 0.1 },
    { samples: new Float32Array(1600).fill(NaN) }, { sampleCount: 800 }]) {
    const f = fixture()
    f.buffer.ingestFrame({ sourceId: 'mic', sequence: 0, timestampSeconds: 0,
      sampleCount: 1600, samples: new Float32Array(1600), ...change })
    assert.deepEqual(f.faults, ['RECOGNITION_AUDIO_GAP'])
    assert.equal(f.sent.length, 0)
    f.core.dispose()
  }
})

test('SEM-F12/J20 closed cloud transport releases worker memory and reports an audio gap', () => {
  const f = fixture()
  f.buffer.send = () => { throw new Error('closed external port') }
  f.feed(0)
  assert.deepEqual(f.faults, ['RECOGNITION_AUDIO_GAP'])
  assert.equal(f.buffer.pendingSamples, 0)
  assert.equal(f.buffer.frames.length, 0)
  f.core.dispose()
})

test('SEM-F06/J20 handoff after audio end is rejected without local decode', async () => {
  const f = fixture()
  f.feed(0)
  await f.buffer.end()
  f.buffer.takeover(0)
  assert.deepEqual(f.faults, ['RECOGNITION_FALLBACK_FAILED'])
  assert.equal(f.buffer.cloud, true)
  assert.equal(f.buffer.frames.length, 0)
  assert.deepEqual(f.events, [])
  f.core.dispose()
})
