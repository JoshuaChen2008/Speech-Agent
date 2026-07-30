'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { assertCaptionEvent } = require('../../src/contracts')
const { EnergyVad } = require('../../src/runtime/realtime-worker/energy-vad')
const {
  NullRecognizerAdapter,
  createRecognizerAdapter,
  registerRecognizerAdapter
} = require('../../src/runtime/realtime-worker/recognizer-adapter')
const { WorkerCore } = require('../../src/runtime/realtime-worker/worker-core')
const { FakeRuntimeAdapter } = require('../../src/main/session/fake-runtime-adapter')
const { SessionCoordinator } = require('../../src/main/session/session-coordinator')
const { DEV_MODEL_VALUE, resolveRuntimeOptions } = require('../../src/main/runtime-options')

const FRAME_SAMPLES = 1600

function frame (sourceId, sequence, amplitude) {
  const samples = new Float32Array(FRAME_SAMPLES).fill(amplitude)
  return {
    sourceId,
    sequence,
    timestampSeconds: sequence * 0.1,
    sampleCount: FRAME_SAMPLES,
    samples
  }
}

/* 逐帧回声式 stub：poll 返回累计文本，endSegment 定稿并复位。 */
function scriptedAdapter () {
  let buffered = 0
  return {
    frames: 0,
    acceptFrame () { buffered += 1; this.frames += 1 },
    poll () { return buffered > 0 ? `听到 ${buffered} 帧` : null },
    endSegment () {
      const text = buffered > 0 ? `定稿 ${buffered} 帧。` : null
      buffered = 0
      return text
    },
    dispose () {}
  }
}

test('energy vad opens on sustained voice, closes on silence, and force-ends long segments', () => {
  const vad = new EnergyVad({ threshold: 0.05, voicedFramesToStart: 2, silentFramesToEnd: 3, maxSegmentFrames: 6 })
  const loud = new Float32Array(FRAME_SAMPLES).fill(0.3)
  const quiet = new Float32Array(FRAME_SAMPLES)

  assert.equal(vad.push(loud).event, null, '单帧不开段')
  assert.equal(vad.push(loud).event, 'speech-start')
  assert.equal(vad.push(quiet).event, null)
  assert.equal(vad.push(quiet).event, null)
  assert.equal(vad.push(quiet).event, 'speech-end')

  /* 静音流不产生任何事件。 */
  for (let index = 0; index < 10; index += 1) assert.equal(vad.push(quiet).event, null)

  /* 超长段强制收束。 */
  assert.equal(vad.push(loud).event, null)
  assert.equal(vad.push(loud).event, 'speech-start')
  let forced = null
  for (let index = 0; index < 6; index += 1) {
    const verdict = vad.push(loud)
    if (verdict.event === 'speech-end') { forced = verdict; break }
  }
  assert.ok(forced && forced.forced, '到达 maxSegmentFrames 必须强制收段')
})

test('null recognizer adapter consumes frames but never produces text', () => {
  const adapter = new NullRecognizerAdapter()
  adapter.acceptFrame(new Float32Array(FRAME_SAMPLES), 0)
  assert.equal(adapter.poll(), null)
  assert.equal(adapter.endSegment(), null)
  assert.equal(adapter.framesAccepted, 1)

  assert.throws(() => createRecognizerAdapter('balanced'), /unknown recognizer profile/)
  assert.throws(() => registerRecognizerAdapter('null', () => null), /already registered/)
})

test('worker core with the null adapter detects segments but emits zero captions', () => {
  const core = new WorkerCore({ sessionId: 'session-1', sourceIds: ['loopback'], vadOptions: { threshold: 0.05 } })
  const events = []
  let sequence = 0
  for (let index = 0; index < 5; index += 1) events.push(...core.ingestFrame(frame('loopback', sequence++, 0.3)))
  for (let index = 0; index < 8; index += 1) events.push(...core.ingestFrame(frame('loopback', sequence++, 0)))

  assert.deepEqual(events, [])
  const metrics = core.metrics().loopback
  assert.equal(metrics.segmentsDetected, 1)
  assert.equal(metrics.captionsEmitted, 0)
  assert.equal(metrics.framesIngested, 13)
  assert.equal(metrics.sequenceGapCount, 0)
})

test('worker core emits contract-valid partial/final streams per segment', () => {
  const core = new WorkerCore({
    sessionId: 'session-1',
    sourceIds: ['mic'],
    adapterFactory: () => scriptedAdapter(),
    vadOptions: { threshold: 0.05, voicedFramesToStart: 2, silentFramesToEnd: 3 }
  })
  const events = []
  let sequence = 0
  const voiced = (count) => { for (let i = 0; i < count; i += 1) events.push(...core.ingestFrame(frame('mic', sequence++, 0.3))) }
  const silent = (count) => { for (let i = 0; i < count; i += 1) events.push(...core.ingestFrame(frame('mic', sequence++, 0))) }

  voiced(4)
  silent(3)
  voiced(4)
  silent(3)

  for (const event of events) assertCaptionEvent(event)
  const kinds = events.map((event) => event.kind)
  assert.equal(kinds.filter((kind) => kind === 'final').length, 2, '两段各出一个 final')
  assert.ok(kinds.filter((kind) => kind === 'partial').length >= 2)

  /* pre-roll 锁：VAD 需 2 帧确认（确认帧在 0.1s），开段时段前缓冲的
     第 0 帧必须补喂——t0 是 0.0 而非确认帧时间，adapter 开段即吃到 2 帧。 */
  assert.equal(events[0].t0, 0)
  assert.equal(events[0].text, '听到 2 帧')

  /* sequence 全源单调；revision 段内单调；两段 segmentId 不同且含 sourceId。 */
  const sequences = events.map((event) => event.sequence)
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b))
  assert.equal(new Set(sequences).size, sequences.length)
  const segmentIds = [...new Set(events.map((event) => event.segmentId))]
  assert.equal(segmentIds.length, 2)
  assert.ok(segmentIds.every((id) => id.includes('mic')))
  for (const segmentId of segmentIds) {
    const revisions = events.filter((event) => event.segmentId === segmentId).map((event) => event.revision)
    assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b))
    assert.equal(new Set(revisions).size, revisions.length)
  }
  /* 段首 pre-roll：t0 不晚于确认帧，t1 随帧推进且 >= t0。 */
  for (const event of events) assert.ok(event.t1 >= event.t0)
})

test('worker core supports either source in separate runs and rejects dual-source input', () => {
  assert.throws(() => new WorkerCore({
    sessionId: 'session-dual',
    sourceIds: ['mic', 'loopback']
  }), /exactly one/)

  for (const sourceId of ['mic', 'loopback']) {
    const core = new WorkerCore({
      sessionId: `session-${sourceId}`,
      sourceIds: [sourceId],
      adapterFactory: () => scriptedAdapter(),
      vadOptions: { threshold: 0.05, voicedFramesToStart: 1, silentFramesToEnd: 2 }
    })
    const events = []
    events.push(...core.ingestFrame(frame(sourceId, 0, 0.3)))
    events.push(...core.ingestFrame(frame(sourceId, 3, 0.3)))
    events.push(...core.ingestFrame(frame(sourceId, 4, 0)))
    events.push(...core.ingestFrame(frame(sourceId, 5, 0)))
    const metrics = core.metrics()[sourceId]
    assert.equal(metrics.sequenceGapCount, 1)
    assert.equal(metrics.missedFrames, 2)
    assert.ok(events.length > 0)
    for (const event of events) {
      assertCaptionEvent(event)
      assert.equal(event.sourceId, sourceId)
    }
  }
})

test('worker core flush finalizes an open segment and malformed frames are ignored', () => {
  const core = new WorkerCore({
    sessionId: 'session-1',
    sourceIds: ['mic'],
    adapterFactory: () => scriptedAdapter(),
    vadOptions: { threshold: 0.05, voicedFramesToStart: 1, silentFramesToEnd: 5 }
  })
  const events = []
  events.push(...core.ingestFrame(frame('mic', 0, 0.3)))
  events.push(...core.ingestFrame(frame('mic', 1, 0.3)))

  assert.deepEqual(core.ingestFrame({ sourceId: 'tv', sequence: 0, timestampSeconds: 0, sampleCount: 1600, samples: new Float32Array(1600) }), [])
  assert.deepEqual(core.ingestFrame({ sourceId: 'mic', sequence: -1, timestampSeconds: 0, sampleCount: 1600, samples: new Float32Array(1600) }), [])
  assert.deepEqual(core.ingestFrame({ sourceId: 'mic', sequence: 2, timestampSeconds: 0.2, sampleCount: 0, samples: new Float32Array(0) }), [])

  const flushed = core.flush(0.5)
  assert.equal(flushed.length, 1)
  assert.equal(flushed.at(-1).kind, 'final')
  assertCaptionEvent(flushed[0])
  assert.equal(core.metrics().mic.inSegment, false)
})

test('whitespace-only finals are suppressed and t1 never regresses below t0', () => {
  const whitespaceAdapter = () => ({
    acceptFrame () {},
    poll () { return null },
    endSegment () { return '   ' },
    dispose () {}
  })
  const core = new WorkerCore({
    sessionId: 'session-1',
    sourceIds: ['mic'],
    adapterFactory: whitespaceAdapter,
    vadOptions: { threshold: 0.05, voicedFramesToStart: 1, silentFramesToEnd: 2 }
  })
  core.ingestFrame(frame('mic', 0, 0.3))
  core.ingestFrame(frame('mic', 1, 0))
  const events = core.ingestFrame(frame('mic', 2, 0))
  assert.deepEqual(events, [], '纯空白 final 不得发出（契约 nonEmpty 用 trim 判定）')

  /* 时间戳回退（采集重启）：t1 被夹逼到 t0，事件仍契约合法。 */
  const regressCore = new WorkerCore({
    sessionId: 'session-1',
    sourceIds: ['mic'],
    adapterFactory: () => scriptedAdapter(),
    vadOptions: { threshold: 0.05, voicedFramesToStart: 1, silentFramesToEnd: 5 }
  })
  regressCore.ingestFrame({ ...frame('mic', 0, 0.3), timestampSeconds: 10 })
  const regressed = regressCore.ingestFrame({ ...frame('mic', 1, 0.3), timestampSeconds: 0.05 })
  assert.ok(regressed.length >= 1)
  for (const event of regressed) {
    assertCaptionEvent(event)
    assert.ok(event.t1 >= event.t0)
  }
})

test('worker host cleans up the child on configure failure and rejects fast on early exit', async () => {
  const { EventEmitter } = require('node:events')
  const { RealtimeWorkerHost } = require('../../src/runtime/realtime-worker/worker-host')

  function fakeChild (behavior) {
    const child = new EventEmitter()
    child.killed = false
    child.kill = () => { child.killed = true }
    child.postMessage = (message) => {
      if (message?.type === 'configure') setImmediate(() => behavior(child))
    }
    return child
  }

  /* configure-failed：reject + kill + 可重试。 */
  let child1
  const host1 = new RealtimeWorkerHost({
    electron: { utilityProcess: { fork: () => { child1 = fakeChild((c) => c.emit('message', { type: 'configure-failed', message: 'bad profile' })); return child1 } } }
  })
  await assert.rejects(host1.start({ sessionId: 's', sourceIds: ['mic'] }), /configure failed: bad profile/)
  assert.equal(child1.killed, true, '失败必须 kill 子进程')
  assert.equal(host1.child, null, '占位复位后可重试 start')

  /* configured 前退出：立即 reject（不是等 5 秒超时）。 */
  let child2
  const host2 = new RealtimeWorkerHost({
    electron: { utilityProcess: { fork: () => { child2 = fakeChild((c) => c.emit('exit', 13)); return child2 } } }
  })
  await assert.rejects(host2.start({ sessionId: 's', sourceIds: ['mic'] }), /exited before configuring \(code 13\)/)
  assert.equal(host2.child, null)

  /* 成功路径 + caption 边界校验与丢弃计数。 */
  let child3
  const host3 = new RealtimeWorkerHost({
    electron: { utilityProcess: { fork: () => { child3 = fakeChild((c) => c.emit('message', { type: 'configured' })); return child3 } } }
  })
  const received = []
  host3.onCaption((event) => received.push(event))
  await host3.start({ sessionId: 's', sourceIds: ['mic'] })
  child3.emit('message', { type: 'caption', event: { invalid: true } })
  child3.emit('message', {
    type: 'caption',
    event: {
      schemaVersion: 1,
      sessionId: 's',
      sourceId: 'mic',
      segmentId: 'seg-mic-1',
      sequence: 1,
      revision: 1,
      kind: 'partial',
      t0: 0,
      t1: 0.1,
      text: '好',
      translation: null
    }
  })
  assert.equal(received.length, 1)
  assert.equal(host3.droppedCaptionCount, 1, '非法事件丢弃必须可观测')
  host3.dispose()
  assert.equal(child3.killed, true)
})

test('worker core honors the recovery cursor: sequence base and attempt namespace', () => {
  const core = new WorkerCore({
    sessionId: 'session-1',
    sourceIds: ['mic'],
    adapterFactory: () => scriptedAdapter(),
    vadOptions: { threshold: 0.05, voicedFramesToStart: 1, silentFramesToEnd: 2 },
    attempt: 1,
    sequenceBases: { mic: 9 }
  })
  const events = []
  events.push(...core.ingestFrame(frame('mic', 0, 0.3)))
  events.push(...core.ingestFrame(frame('mic', 1, 0)))
  events.push(...core.ingestFrame(frame('mic', 2, 0)))

  assert.ok(events.length >= 2)
  assert.ok(events.every((event) => event.sequence > 9), 'sequence 必须从游标之上续增')
  assert.equal(events[0].sequence, 10)
  assert.ok(events.every((event) => event.segmentId.startsWith('seg-a1-mic-')), 'segmentId 以 attempt 命名空间隔离')

  assert.throws(() => new WorkerCore({
    sessionId: 's', sourceIds: ['mic'], attempt: -1
  }), /attempt/)
  assert.throws(() => new WorkerCore({
    sessionId: 's', sourceIds: ['mic'], sequenceBases: { mic: 1.5 }
  }), /sequenceBases/)
})

test('worker core events pass the real SessionCoordinator acceptCaption gate', async (t) => {
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  const coordinator = new SessionCoordinator({
    adapter,
    runtimeOptions: resolveRuntimeOptions({ LIVE_SUBTITLE_DEV_MODEL: DEV_MODEL_VALUE }),
    configuration: { onboardingCompleted: true, onboardingPreset: 'dictation', mic: true, loopback: false },
    idFactory: () => 'session-worker-1'
  })
  t.after(() => coordinator.dispose())
  assert.equal((await coordinator.command('start')).ok, true)

  const delivered = []
  coordinator.onCaption((event) => delivered.push(event))

  const core = new WorkerCore({
    sessionId: 'session-worker-1',
    sourceIds: ['mic'],
    adapterFactory: () => scriptedAdapter(),
    vadOptions: { threshold: 0.05, voicedFramesToStart: 2, silentFramesToEnd: 3 }
  })
  let sequence = 0
  const produced = []
  for (let index = 0; index < 4; index += 1) produced.push(...core.ingestFrame(frame('mic', sequence++, 0.3)))
  for (let index = 0; index < 3; index += 1) produced.push(...core.ingestFrame(frame('mic', sequence++, 0)))

  assert.ok(produced.length >= 3)
  /* 真正的验收路径：worker 事件全部经 acceptCaption 且全部被接受。 */
  for (const event of produced) adapter.emitCaption(event)
  assert.deepEqual(delivered, produced)
  assert.equal(coordinator.getCaptionState().segments.length, 1)
})
