'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { assertCaptionEvent, assertRuntimeSnapshot } = require('../../src/contracts')
const { FakeRuntimeAdapter } = require('../../src/main/session/fake-runtime-adapter')
const { SessionCoordinator } = require('../../src/main/session/session-coordinator')
const { DEV_MODEL_VALUE, resolveRuntimeOptions } = require('../../src/main/runtime-options')

const NO_MODEL = resolveRuntimeOptions({})
const DEV_MODEL = resolveRuntimeOptions({ LIVE_SUBTITLE_DEV_MODEL: DEV_MODEL_VALUE })
const MEETING = {
  onboardingCompleted: true,
  onboardingPreset: 'meeting',
  mic: false,
  loopback: true
}
const DICTATION = {
  onboardingCompleted: true,
  onboardingPreset: 'dictation',
  mic: true,
  loopback: false
}
const NOT_ONBOARDED = {
  onboardingCompleted: false,
  onboardingPreset: null,
  mic: false,
  loopback: false
}

function makeCoordinator (options = {}) {
  const adapter = options.adapter || new FakeRuntimeAdapter({ autoEmit: false })
  const replacementAdapters = []
  let nextId = 0
  const coordinator = new SessionCoordinator({
    adapter,
    adapterFactory: options.adapterFactory || (() => {
      const replacement = new FakeRuntimeAdapter({ autoEmit: false })
      replacementAdapters.push(replacement)
      return replacement
    }),
    runtimeOptions: options.runtimeOptions || DEV_MODEL,
    configuration: options.configuration || DICTATION,
    idFactory: () => `session-${++nextId}`,
    transitionTimeoutMs: options.transitionTimeoutMs
  })
  return { adapter, coordinator, replacementAdapters }
}

test('no resolved model keeps the coordinator unavailable with no profiles', async (t) => {
  const { coordinator } = makeCoordinator({ runtimeOptions: NO_MODEL, configuration: MEETING })
  t.after(() => coordinator.dispose())

  const snapshot = coordinator.getSnapshot()
  assert.equal(snapshot.phase, 'unavailable')
  assert.equal(snapshot.model.state, 'missing')
  assert.deepEqual(snapshot.capabilities.availableProfiles, [])
  assert.equal(snapshot.capabilities.canStart, false)
  assert.equal(snapshot.capabilities.limitations[0].code, 'MODEL_NOT_READY')

  const result = await coordinator.command('start')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'MODEL_NOT_READY')
  assert.equal(coordinator.getSnapshot().revision, snapshot.revision)
})

test('an installed runtime can replace the missing model while idle and start immediately', async (t) => {
  const original = new FakeRuntimeAdapter({ autoEmit: false })
  const replacement = new FakeRuntimeAdapter({ autoEmit: false })
  const { coordinator } = makeCoordinator({
    adapter: original,
    runtimeOptions: NO_MODEL,
    configuration: MEETING
  })
  t.after(() => coordinator.dispose())

  const before = coordinator.getSnapshot()
  const activated = coordinator.replaceRuntime({
    adapterFactory: () => replacement,
    runtimeOptions: DEV_MODEL,
    transitionTimeoutMs: 30000
  })

  assert.equal(before.phase, 'unavailable')
  assert.equal(activated.phase, 'idle')
  assert.equal(activated.model.state, 'ready')
  assert.deepEqual(activated.capabilities.availableProfiles, ['balanced'])
  assert.equal(activated.capabilities.canStart, true)
  assert.ok(activated.revision > before.revision)

  assert.equal((await coordinator.command('start')).ok, true)
  assert.deepEqual(replacement.context.sourceIds, ['loopback'])
  assert.equal(replacement.context.profile, 'balanced')
  assert.equal(original.context, null)
})

test('the global refinement preference is frozen per session and does not vary by source', async (t) => {
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  const { coordinator } = makeCoordinator({
    adapter,
    runtimeOptions: { ...DEV_MODEL, refinementAvailable: true },
    configuration: { ...DICTATION, refinementEnabled: true }
  })
  t.after(() => coordinator.dispose())

  assert.equal((await coordinator.command('start')).ok, true)
  assert.equal(adapter.context.refinementEnabled, true)
  coordinator.updateConfiguration({ ...DICTATION, refinementEnabled: false })
  assert.equal(adapter.context.refinementEnabled, true, 'the active session keeps its frozen choice')
  assert.equal((await coordinator.command('stop')).ok, true)

  assert.equal((await coordinator.command('start')).ok, true)
  assert.equal(adapter.context.refinementEnabled, false, 'a future session reads the updated global preference')
})

test('a session that froze refinement off rejects stray refined events fail closed', async (t) => {
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  const { coordinator } = makeCoordinator({
    adapter,
    runtimeOptions: { ...DEV_MODEL, refinementAvailable: true },
    configuration: { ...DICTATION, refinementEnabled: false }
  })
  t.after(() => coordinator.dispose())

  assert.equal((await coordinator.command('start')).ok, true)
  const sessionId = coordinator.getSnapshot().sessionId
  const original = {
    schemaVersion: 1,
    sessionId,
    sourceId: 'mic',
    segmentId: 'segment-original-only',
    sequence: 1,
    revision: 1,
    kind: 'final',
    t0: 0,
    t1: 1,
    text: '原始字幕',
    translation: null
  }

  adapter.emitCaption(original)
  adapter.emitCaption({
    ...original,
    sequence: 2,
    revision: 2,
    kind: 'refined',
    text: '不应进入关闭精修的会话'
  })
  assert.deepEqual(coordinator.getCaptionState().segments.map((segment) => ({
    kind: segment.kind,
    text: segment.text
  })), [{ kind: 'final', text: '原始字幕' }])
})

test('a refinement fault restores visible originals, preserves the current partial, and stays session-local', async (t) => {
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  const durableFaults = []
  const observedFaults = []
  const replacementStates = []
  const displayedEvents = []
  const persistenceSink = {
    openSession: async () => {},
    acceptCaption: async () => {},
    recordRefinementFault: async (fault) => { durableFaults.push(structuredClone(fault)) },
    closeSession: async () => {},
    retry: async () => {},
    flush: async () => {}
  }
  const coordinator = new SessionCoordinator({
    adapter,
    runtimeOptions: { ...DEV_MODEL, refinementAvailable: true },
    configuration: { ...DICTATION, refinementEnabled: true },
    idFactory: () => 'session-refinement-fault',
    persistenceSink
  })
  t.after(() => coordinator.dispose())
  coordinator.onCaption((event) => displayedEvents.push(event.kind))
  coordinator.onCaptionState((state) => replacementStates.push(state))
  coordinator.onRefinementFault((fault) => observedFaults.push(fault))

  assert.equal((await coordinator.command('start')).ok, true)
  const base = {
    schemaVersion: 1,
    sessionId: 'session-refinement-fault',
    sourceId: 'mic',
    segmentId: 'segment-final',
    sequence: 1,
    revision: 1,
    kind: 'final',
    t0: 0,
    t1: 1,
    text: '原始字幕',
    translation: null
  }
  adapter.emitCaption(base)
  adapter.emitCaption({ ...base, sequence: 2, revision: 2, kind: 'refined', text: '精修字幕' })
  adapter.emitCaption({
    ...base,
    segmentId: 'segment-partial',
    sequence: 3,
    revision: 1,
    kind: 'partial',
    t0: 1,
    t1: 1.5,
    text: '当前还在识别'
  })
  const partialBefore = structuredClone(coordinator.getCaptionState().segments.at(-1))

  assert.equal(adapter.emitRefinementFault({
    code: 'REFINE_DECODE_FAILED',
    stage: 'decode',
    faultAtMs: 321
  }), true)

  assert.equal(coordinator.getSnapshot().phase, 'listening')
  assert.deepEqual(coordinator.getCaptionState().segments.map((segment) => segment.text), [
    '原始字幕',
    '当前还在识别'
  ])
  assert.deepEqual(coordinator.getCaptionState().segments.at(-1), partialBefore)
  assert.equal(replacementStates.length, 1)
  assert.deepEqual(replacementStates[0], coordinator.getCaptionState())
  assert.deepEqual(durableFaults, [{
    sessionId: 'session-refinement-fault',
    faultCode: 'REFINE_DECODE_FAILED',
    faultAtMs: 321
  }])
  assert.deepEqual(observedFaults, [{
    sessionId: 'session-refinement-fault',
    code: 'REFINE_DECODE_FAILED',
    stage: 'decode',
    faultAtMs: 321
  }])

  adapter.emitCaption({ ...base, sequence: 4, revision: 3, kind: 'refined', text: '迟到精修' })
  assert.deepEqual(coordinator.getCaptionState().segments.map((segment) => segment.text), [
    '原始字幕',
    '当前还在识别'
  ])
  assert.deepEqual(displayedEvents, ['final', 'refined', 'partial'])
  assert.equal(adapter.emitRefinementFault({
    code: 'REFINE_INTERNAL_FAILURE',
    stage: 'worker-channel',
    faultAtMs: 400
  }), false)
  assert.equal(durableFaults.length, 1)
})

test('runtime replacement is rejected while a session is active without touching its adapter', async (t) => {
  const original = new FakeRuntimeAdapter({ autoEmit: false })
  const replacement = new FakeRuntimeAdapter({ autoEmit: false })
  const { coordinator } = makeCoordinator({ adapter: original })
  t.after(() => coordinator.dispose())

  assert.equal((await coordinator.command('start')).ok, true)
  const listening = coordinator.getSnapshot()
  assert.throws(() => coordinator.replaceRuntime({
    adapterFactory: () => replacement,
    runtimeOptions: DEV_MODEL
  }), (error) => error.code === 'SESSION_ACTIVE')

  assert.equal(coordinator.getSnapshot().phase, 'listening')
  assert.equal(coordinator.getSnapshot().revision, listening.revision)
  assert.notEqual(original.context, null)
  assert.equal(replacement.context, null)
})

test('failed runtime candidate binding leaves the unavailable coordinator intact', async (t) => {
  const original = new FakeRuntimeAdapter({ autoEmit: false })
  const broken = new FakeRuntimeAdapter({ autoEmit: false })
  broken.onCaption = () => { throw new Error('binding failed') }
  const { coordinator } = makeCoordinator({
    adapter: original,
    runtimeOptions: NO_MODEL,
    configuration: MEETING
  })
  t.after(() => coordinator.dispose())
  const before = coordinator.getSnapshot()

  assert.throws(() => coordinator.replaceRuntime({
    adapterFactory: () => broken,
    runtimeOptions: DEV_MODEL
  }), /binding failed/)

  assert.deepEqual(coordinator.getSnapshot(), before)
  assert.equal((await coordinator.command('start')).code, 'MODEL_NOT_READY')
})

test('invalid replacement metadata is rejected before creating an adapter', async (t) => {
  const { coordinator } = makeCoordinator({ runtimeOptions: NO_MODEL, configuration: MEETING })
  t.after(() => coordinator.dispose())
  let factoryCalls = 0

  assert.throws(() => coordinator.replaceRuntime({
    adapterFactory: () => {
      factoryCalls += 1
      return new FakeRuntimeAdapter({ autoEmit: false })
    },
    runtimeOptions: {
      modelOverride: { id: 'real-model', profile: 'turbo', developmentOnly: false }
    }
  }), /profile is invalid/)
  assert.equal(factoryCalls, 0)
  assert.equal(coordinator.getSnapshot().model.state, 'missing')
})

test('Gate 0D blocks start until one of the two presets is explicit', async (t) => {
  const { coordinator } = makeCoordinator({ configuration: NOT_ONBOARDED })
  t.after(() => coordinator.dispose())

  assert.equal(coordinator.getSnapshot().phase, 'unavailable')
  assert.equal(coordinator.getSnapshot().capabilities.limitations[0].code, 'SETUP_REQUIRED')
  assert.equal((await coordinator.command('start')).code, 'SETUP_REQUIRED')

  const updated = coordinator.updateConfiguration(MEETING)
  assert.equal(updated.phase, 'idle')
  assert.deepEqual(updated.capabilities.availableSourceIds, ['loopback'])
})

test('state machine publishes valid monotonic snapshots through a full session', async (t) => {
  const { coordinator } = makeCoordinator()
  t.after(() => coordinator.dispose())
  const observed = []
  coordinator.onSnapshot((snapshot) => {
    assertRuntimeSnapshot(snapshot)
    observed.push(snapshot)
  })

  assert.equal(coordinator.getSnapshot().phase, 'idle')
  assert.equal((await coordinator.command('start')).ok, true)
  const sessionId = coordinator.getSnapshot().sessionId
  assert.equal(coordinator.getSnapshot().phase, 'listening')
  assert.equal((await coordinator.command('pause')).ok, true)
  assert.equal(coordinator.getSnapshot().phase, 'paused')
  assert.equal(coordinator.getSnapshot().sessionId, sessionId)
  assert.equal((await coordinator.command('resume')).ok, true)
  assert.equal(coordinator.getSnapshot().phase, 'listening')
  assert.equal((await coordinator.command('stop')).ok, true)
  assert.equal(coordinator.getSnapshot().phase, 'idle')
  assert.equal(coordinator.getSnapshot().sessionId, null)

  assert.deepEqual(observed.map((snapshot) => snapshot.phase), [
    'starting', 'listening', 'paused', 'listening', 'stopping', 'idle'
  ])
  const revisions = observed.map((snapshot) => snapshot.revision)
  assert.deepEqual(revisions, [...revisions].sort((a, b) => a - b))
  assert.equal(new Set(revisions).size, revisions.length)
})

test('concurrent commands are rejected while an adapter transition is pending', async (t) => {
  let releaseStart
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  const originalStart = adapter.start.bind(adapter)
  adapter.start = async (context) => {
    await new Promise((resolve) => { releaseStart = resolve })
    return originalStart(context)
  }
  const { coordinator } = makeCoordinator({ adapter })
  t.after(() => coordinator.dispose())

  const first = coordinator.command('start')
  assert.equal(coordinator.getSnapshot().phase, 'starting')
  const second = await coordinator.command('start')
  assert.equal(second.ok, false)
  assert.equal(second.code, 'COMMAND_BUSY')
  releaseStart()
  assert.equal((await first).ok, true)
})

test('adapter failures enter a recoverable error and retry the same session', async (t) => {
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  const originalStart = adapter.start.bind(adapter)
  let attempts = 0
  adapter.start = async (context) => {
    attempts += 1
    if (attempts === 1) throw new Error('injected failure')
    return originalStart(context)
  }
  const { coordinator } = makeCoordinator({ adapter })
  t.after(() => coordinator.dispose())

  const failed = await coordinator.command('start')
  assert.equal(failed.code, 'ADAPTER_START_FAILED')
  const failedSnapshot = coordinator.getSnapshot()
  assert.equal(failedSnapshot.phase, 'error')
  assert.equal(failedSnapshot.capabilities.canRetry, true)
  const sessionId = failedSnapshot.sessionId

  assert.equal((await coordinator.command('retry')).ok, true)
  assert.equal(coordinator.getSnapshot().phase, 'listening')
  assert.equal(coordinator.getSnapshot().sessionId, sessionId)
})

test('caption ingress validates session, source, sequence, and revision', async (t) => {
  const { adapter, coordinator } = makeCoordinator()
  t.after(() => coordinator.dispose())
  await coordinator.command('start')
  const sessionId = coordinator.getSnapshot().sessionId
  const accepted = []
  coordinator.onCaption((event) => {
    assertCaptionEvent(event)
    accepted.push(event)
  })

  const base = {
    schemaVersion: 1,
    sessionId,
    sourceId: 'mic',
    segmentId: 'segment-1',
    sequence: 1,
    revision: 1,
    kind: 'partial',
    t0: 0,
    t1: 0.5,
    text: '测',
    translation: null
  }
  adapter.emitCaption(base)
  adapter.emitCaption({ ...base, text: '旧事件' })
  adapter.emitCaption({ ...base, sessionId: 'other', sequence: 2, revision: 2 })
  adapter.emitCaption({ ...base, sourceId: 'loopback', sequence: 2, revision: 2 })
  adapter.emitCaption({ ...base, sequence: 2, revision: 2, text: '测试' })
  adapter.emitCaption({ ...base, sequence: 3, revision: 2, text: '复用 revision' })
  adapter.emitCaption({
    ...base,
    segmentId: 'segment-2',
    sequence: 2,
    revision: 1,
    text: '跨 segment 复用 sequence'
  })
  adapter.emitCaption({ invalid: true })

  assert.deepEqual(accepted.map((event) => event.text), ['测', '测试'])
})

test('fake adapter emits contract-shaped captions only while running', async () => {
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  const seen = []
  adapter.onCaption((event) => seen.push(assertCaptionEvent(event)))
  await adapter.start({ sessionId: 'session-1', sourceIds: ['mic'], profile: 'balanced' })
  adapter.emit('partial', 1, '测')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].sessionId, 'session-1')
  await adapter.stop()
  adapter.emit('partial', 2, '测试')
  assert.equal(seen.length, 1)
})

test('subscriber failures are isolated from state transitions and other subscribers', async (t) => {
  const listenerErrors = []
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  const coordinator = new SessionCoordinator({
    adapter,
    runtimeOptions: DEV_MODEL,
    configuration: DICTATION,
    idFactory: () => 'session-1',
    onListenerError: (error) => listenerErrors.push(error)
  })
  t.after(() => coordinator.dispose())

  const phases = []
  coordinator.onSnapshot(() => { throw new Error('broken renderer') })
  coordinator.onSnapshot((snapshot) => phases.push(snapshot.phase))
  assert.equal((await coordinator.command('start')).ok, true)
  assert.deepEqual(phases, ['starting', 'listening'])

  const captions = []
  coordinator.onCaption(() => { throw new Error('broken caption subscriber') })
  coordinator.onCaption((event) => captions.push(event.text))
  adapter.emitCaption({
    schemaVersion: 1,
    sessionId: 'session-1',
    sourceId: 'mic',
    segmentId: 'segment-1',
    sequence: 1,
    revision: 1,
    kind: 'partial',
    t0: 0,
    t1: 0.5,
    text: '测试',
    translation: null
  })
  assert.deepEqual(captions, ['测试'])
  assert.equal(listenerErrors.length, 3)
})

test('fake adapter keeps source sequence monotonic when retrying the same session', async () => {
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  const seen = []
  adapter.onCaption((event) => seen.push(event))
  const context = { sessionId: 'session-1', sourceIds: ['mic'], profile: 'balanced' }

  await adapter.start(context)
  adapter.emit('partial', 1, '一')
  await adapter.stop()
  await adapter.start(context)
  adapter.emit('partial', 2, '二')

  assert.deepEqual(seen.map((event) => event.sequence), [1, 2])
})

test('dispose cancels an unfinished start without reviving state or timers', async () => {
  let releaseStart
  const adapter = new FakeRuntimeAdapter({ autoEmit: true, characterIntervalMs: 1 })
  const originalStart = adapter.start.bind(adapter)
  adapter.start = async (context) => {
    await new Promise((resolve) => { releaseStart = resolve })
    return originalStart(context)
  }
  const { coordinator } = makeCoordinator({ adapter, transitionTimeoutMs: 1000 })
  const starting = coordinator.command('start')
  assert.equal(coordinator.getSnapshot().phase, 'starting')
  await coordinator.dispose()
  releaseStart()
  const result = await starting
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(result.code, 'COORDINATOR_CLOSED')
  assert.notEqual(coordinator.getSnapshot().phase, 'listening')
  assert.equal(adapter.context, null)
  assert.equal(adapter.characterTimer, null)
})

test('hung adapter transitions time out into recoverable error and clear busy', async (t) => {
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  adapter.start = async () => new Promise(() => {})
  const { coordinator } = makeCoordinator({ adapter, transitionTimeoutMs: 20 })
  t.after(() => coordinator.dispose())

  const result = await coordinator.command('start')
  assert.equal(result.code, 'ADAPTER_START_TIMEOUT')
  assert.equal(coordinator.getSnapshot().phase, 'error')
  assert.equal(coordinator.getSnapshot().capabilities.canRetry, true)
  assert.notEqual((await coordinator.command('stop')).code, 'COMMAND_BUSY')
})

test('captions emitted before start resolves are buffered until listening', async (t) => {
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  const originalStart = adapter.start.bind(adapter)
  adapter.start = async (context) => {
    await originalStart(context)
    adapter.emitCaption({
      schemaVersion: 1,
      sessionId: context.sessionId,
      sourceId: 'mic',
      segmentId: 'early-segment',
      sequence: 1,
      revision: 1,
      kind: 'partial',
      t0: 0,
      t1: 0.2,
      text: '早',
      translation: null
    })
  }
  const { coordinator } = makeCoordinator({ adapter })
  t.after(() => coordinator.dispose())
  const seen = []
  coordinator.onCaption((event) => seen.push({ phase: coordinator.getSnapshot().phase, text: event.text }))

  assert.equal((await coordinator.command('start')).ok, true)
  assert.deepEqual(seen, [{ phase: 'listening', text: '早' }])
})

test('fake pause flushes an in-progress partial as final', async () => {
  const adapter = new FakeRuntimeAdapter({
    autoEmit: true,
    characterIntervalMs: 1,
    script: [{ text: '这是一段足够长的测试文字用于暂停', translation: 'test', language: 'en' }]
  })
  const seen = []
  adapter.onCaption((event) => seen.push(event))
  await adapter.start({ sessionId: 'session-1', sourceIds: ['mic'], profile: 'balanced' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await adapter.pause()
  adapter.dispose()

  assert.ok(seen.some((event) => event.kind === 'partial'))
  assert.equal(seen.at(-1).kind, 'final')
  assert.ok(seen.at(-1).text.length > 0)
})

test('coordinator and fake adapter reject dual, empty, and preset-mismatched sources', async () => {
  assert.throws(() => makeCoordinator({ configuration: { ...MEETING, mic: true } }), /exactly one/)
  assert.throws(() => makeCoordinator({ configuration: { ...MEETING, loopback: false } }), /exactly one/)
  assert.throws(
    () => makeCoordinator({ configuration: { ...MEETING, onboardingPreset: 'dictation' } }),
    /exactly one/
  )

  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  await assert.rejects(
    adapter.start({ sessionId: 'session-1', sourceIds: ['mic', 'loopback'], profile: 'balanced' }),
    /exactly one/
  )
})

test('capture configuration changes are rejected during active sessions', async (t) => {
  const { coordinator } = makeCoordinator()
  t.after(() => coordinator.dispose())
  await coordinator.command('start')
  const before = coordinator.getSnapshot()

  assert.throws(() => coordinator.updateConfiguration(NOT_ONBOARDED), /active session/)
  assert.deepEqual(coordinator.getSnapshot(), before)
})

test('fake adapter rejects malformed scripts and validates generated events', async () => {
  assert.throws(() => new FakeRuntimeAdapter({ script: [] }), /non-empty array/)
  assert.throws(
    () => new FakeRuntimeAdapter({ script: [{ text: '', translation: 'x', language: 'en' }] }),
    /text/
  )
  assert.throws(
    () => new FakeRuntimeAdapter({ script: [{ text: 'x', translation: 'x', language: 'not valid' }] }),
    /language/
  )

  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  await adapter.start({ sessionId: 'session-1', sourceIds: ['mic'], profile: 'balanced' })
  assert.throws(() => adapter.emit('final', 0, 'invalid'), /revision/)
})

test('synchronous dispose during starting publication cannot miss cancellation', async () => {
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  adapter.start = async () => new Promise(() => {})
  const { coordinator } = makeCoordinator({ adapter, transitionTimeoutMs: 1000 })
  coordinator.onSnapshot((snapshot) => {
    if (snapshot.phase === 'starting') coordinator.dispose()
  })

  const result = await coordinator.command('start')
  assert.equal(result.code, 'COORDINATOR_CLOSED')
})

test('late completion from a timed-out adapter cannot stop a replacement runtime', async (t) => {
  let releaseOldStart
  let oldRunning = false
  const oldAdapter = new FakeRuntimeAdapter({ autoEmit: false })
  const oldStart = oldAdapter.start.bind(oldAdapter)
  oldAdapter.start = async (context) => {
    await new Promise((resolve) => { releaseOldStart = resolve })
    await oldStart(context)
    oldRunning = true
  }
  const oldStop = oldAdapter.stop.bind(oldAdapter)
  oldAdapter.stop = async (...args) => {
    oldRunning = false
    return oldStop(...args)
  }

  let replacementRunning = false
  const replacement = new FakeRuntimeAdapter({ autoEmit: false })
  const replacementStart = replacement.start.bind(replacement)
  replacement.start = async (context) => {
    await replacementStart(context)
    replacementRunning = true
  }
  const replacementStop = replacement.stop.bind(replacement)
  replacement.stop = async (...args) => {
    replacementRunning = false
    return replacementStop(...args)
  }

  const { coordinator } = makeCoordinator({
    adapter: oldAdapter,
    adapterFactory: () => replacement,
    transitionTimeoutMs: 20
  })
  t.after(() => coordinator.dispose())

  assert.equal((await coordinator.command('start')).code, 'ADAPTER_START_TIMEOUT')
  assert.equal((await coordinator.command('retry')).ok, true)
  assert.equal(coordinator.getSnapshot().phase, 'listening')
  assert.equal(replacementRunning, true)

  releaseOldStart()
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.equal(oldRunning, false)
  assert.equal(replacementRunning, true)
  assert.equal(coordinator.getSnapshot().phase, 'listening')
})

test('timeout without an adapter factory fails closed and does not offer retry', async (t) => {
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  adapter.start = async () => new Promise(() => {})
  const coordinator = new SessionCoordinator({
    adapter,
    runtimeOptions: DEV_MODEL,
    configuration: DICTATION,
    idFactory: () => 'session-1',
    transitionTimeoutMs: 20
  })
  t.after(() => coordinator.dispose())

  const result = await coordinator.command('start')
  assert.equal(result.code, 'ADAPTER_START_TIMEOUT')
  assert.equal(result.recoverable, false)
  assert.equal(coordinator.getSnapshot().capabilities.canRetry, false)
  assert.equal(coordinator.getSnapshot().capabilities.canStop, true)
  assert.equal((await coordinator.command('stop')).ok, true)
  assert.equal(coordinator.getSnapshot().sessionId, null)
  assert.equal(coordinator.getSnapshot().phase, 'unavailable')
  assert.equal(coordinator.getSnapshot().capabilities.canStart, false)
})

test('adapter factory cannot recycle a quarantined instance', async (t) => {
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  adapter.start = async () => new Promise(() => {})
  const { coordinator } = makeCoordinator({
    adapter,
    adapterFactory: () => adapter,
    transitionTimeoutMs: 20
  })
  t.after(() => coordinator.dispose())

  const result = await coordinator.command('start')
  assert.equal(result.code, 'ADAPTER_START_TIMEOUT')
  assert.equal(result.recoverable, false)
  assert.equal(coordinator.adapter, null)
  assert.equal(coordinator.getSnapshot().capabilities.canRetry, false)
  assert.equal((await coordinator.command('stop')).ok, true)
})

test('replacement cannot start until the quarantined adapter confirms disposal', async (t) => {
  let releaseRetirement
  const retired = new FakeRuntimeAdapter({ autoEmit: false })
  retired.start = async () => new Promise(() => {})
  retired.stop = async () => {}
  retired.dispose = () => new Promise((resolve) => { releaseRetirement = resolve })

  const replacement = new FakeRuntimeAdapter({ autoEmit: false })
  let replacementStarts = 0
  const replacementStart = replacement.start.bind(replacement)
  replacement.start = async (context) => {
    replacementStarts += 1
    return replacementStart(context)
  }
  const { coordinator } = makeCoordinator({
    adapter: retired,
    adapterFactory: () => replacement,
    transitionTimeoutMs: 20
  })
  t.after(() => coordinator.dispose())

  const first = await coordinator.command('start')
  assert.equal(first.code, 'ADAPTER_START_TIMEOUT')
  assert.equal(typeof releaseRetirement, 'function')

  const retry = coordinator.command('retry')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(replacementStarts, 0, 'new utility generation must wait for old adapter disposal')

  releaseRetirement()
  assert.equal((await retry).ok, true)
  assert.equal(replacementStarts, 1)
})
