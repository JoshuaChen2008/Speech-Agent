'use strict'

/* B2.0 恢复缺口回归：canonical CaptionState、renderer reload 水合，
   以及 replacement adapter 的 sequence/segment cursor handoff。 */

const assert = require('node:assert/strict')
const test = require('node:test')

const { assertCaptionState } = require('../../src/contracts')
const { FakeRuntimeAdapter } = require('../../src/main/session/fake-runtime-adapter')
const { SessionCoordinator } = require('../../src/main/session/session-coordinator')
const { DEV_MODEL_VALUE, resolveRuntimeOptions } = require('../../src/main/runtime-options')
const {
  KEEP_SEGMENTS,
  applyEvent,
  createState,
  hydrateState,
  selectFlow
} = require('../../src/ui/shared/caption-reducer')

const DEV_MODEL = resolveRuntimeOptions({ LIVE_SUBTITLE_DEV_MODEL: DEV_MODEL_VALUE })
const DICTATION = {
  onboardingCompleted: true,
  onboardingPreset: 'dictation',
  mic: true,
  loopback: false
}
function caption (overrides = {}) {
  return {
    schemaVersion: 1,
    sessionId: 'session-1',
    sourceId: 'mic',
    segmentId: 'segment-a',
    sequence: 1,
    revision: 1,
    kind: 'partial',
    t0: 0,
    t1: 0.5,
    text: '文本',
    translation: null,
    ...overrides
  }
}

function makeCoordinator (options = {}) {
  const adapter = options.adapter || new FakeRuntimeAdapter({ autoEmit: false })
  const replacements = []
  const resumeContexts = []
  let nextId = 0
  const coordinator = new SessionCoordinator({
    adapter,
    adapterFactory: () => {
      const replacement = new FakeRuntimeAdapter({ autoEmit: false })
      const originalStart = replacement.start.bind(replacement)
      replacement.start = async (context) => {
        resumeContexts.push(structuredClone(context.resume === undefined ? null : context.resume))
        return originalStart(context)
      }
      replacements.push(replacement)
      return replacement
    },
    runtimeOptions: DEV_MODEL,
    configuration: options.configuration || DICTATION,
    idFactory: () => `session-${++nextId}`,
    transitionTimeoutMs: options.transitionTimeoutMs
  })
  return { adapter, coordinator, replacements, resumeContexts }
}

test('renderer reload rehydrates exactly the delivered caption view', async (t) => {
  const { adapter, coordinator } = makeCoordinator()
  t.after(() => coordinator.dispose())
  await coordinator.command('start')
  const sessionId = coordinator.getSnapshot().sessionId

  const live = createState()
  coordinator.onCaption((event) => applyEvent(live, event))

  adapter.emitCaption(caption({ sessionId, segmentId: 'segment-1', sequence: 1, revision: 1, text: '你' }))
  adapter.emitCaption(caption({ sessionId, segmentId: 'segment-1', sequence: 2, revision: 2, text: '你好' }))
  adapter.emitCaption(caption({
    sessionId, segmentId: 'segment-1', sequence: 3, revision: 3, kind: 'final', text: '你好。'
  }))
  adapter.emitCaption(caption({
    sessionId,
    segmentId: 'segment-1',
    sequence: 4,
    revision: 4,
    kind: 'translated',
    text: '你好。',
    translation: { language: 'en', text: 'Hello.', basedOnRevision: 3 }
  }))

  /* reload 开始：先订阅（缓冲），事件可能落在订阅之后、快照之前 —— 它会
     同时出现在快照和缓冲里，重放必须是 no-op。 */
  const buffered = []
  coordinator.onCaption((event) => buffered.push(event))
  adapter.emitCaption(caption({ sessionId, segmentId: 'segment-2', sequence: 5, revision: 1, text: '正在' }))
  const canonical = coordinator.getCaptionState()
  /* 快照之后、水合之前又来一条 —— 只在缓冲里。 */
  adapter.emitCaption(caption({ sessionId, segmentId: 'segment-2', sequence: 6, revision: 2, text: '正在输入' }))

  const rehydrated = hydrateState(canonical)
  for (const event of buffered) applyEvent(rehydrated, event)

  assert.deepEqual(rehydrated.segments, live.segments)
  assert.deepEqual(selectFlow(rehydrated), selectFlow(live))
  assert.equal(selectFlow(rehydrated).at(-2).text, '你好。')
  assert.equal(selectFlow(rehydrated).at(-1).text, '正在输入')
})

test('late amendments to evicted segments keep live and reloaded views identical', async (t) => {
  const { adapter, coordinator } = makeCoordinator()
  t.after(() => coordinator.dispose())
  await coordinator.command('start')
  const sessionId = coordinator.getSnapshot().sessionId

  const live = createState()
  coordinator.onCaption((event) => applyEvent(live, event))

  /* 12 段定稿：renderer 窗口只剩 seg-5..seg-12。 */
  for (let index = 1; index <= 12; index += 1) {
    adapter.emitCaption(caption({
      sessionId, segmentId: `seg-${index}`, sequence: index, kind: 'final', text: `句子${index}`
    }))
  }
  /* 迟到修订落在已被 renderer 淘汰的 seg-3：两侧都不得开新段/复活。 */
  adapter.emitCaption(caption({
    sessionId, segmentId: 'seg-3', sequence: 13, revision: 2, kind: 'refined', text: '精修句三'
  }))
  adapter.emitCaption(caption({
    sessionId,
    segmentId: 'seg-3',
    sequence: 14,
    revision: 3,
    kind: 'translated',
    text: '精修句三',
    translation: { language: 'en', text: 'Sentence three.', basedOnRevision: 2 }
  }))

  assert.equal(selectFlow(live).at(-1).text, '句子12')
  const rehydrated = hydrateState(coordinator.getCaptionState())
  assert.deepEqual(rehydrated.segments, live.segments)
  assert.deepEqual(selectFlow(rehydrated), selectFlow(live))

  /* canonical 与 renderer 同窗口：seg-3 已淘汰，修订被一致地忽略。 */
  const canonical = coordinator.getCaptionState()
  assert.equal(canonical.segments.some((segment) => segment.segmentId === 'seg-3'), false)
  assert.equal(canonical.segments.at(-1).segmentId, 'seg-12')
})

test('canonical fold and live reducer stay equivalent across adversarial streams', async (t) => {
  const { adapter, coordinator } = makeCoordinator()
  t.after(() => coordinator.dispose())
  await coordinator.command('start')
  const first = coordinator.getSnapshot().sessionId

  const live = createState()
  coordinator.onCaption((event) => applyEvent(live, event))
  const assertEquivalent = () => {
    const rehydrated = hydrateState(coordinator.getCaptionState())
    assert.deepEqual(rehydrated.segments, live.segments)
    assert.equal(rehydrated.sessionId, live.sessionId)
  }

  /* 单路多段 + 迟到定稿 + 窗口内外修订，每一步都要求 reload 视图与实时视图相同。 */
  const stream = [
    caption({ sessionId: first, sourceId: 'mic', segmentId: 'a-1', sequence: 1, revision: 1, text: '我在说' }),
    ...Array.from({ length: KEEP_SEGMENTS + 1 }, (_, i) => caption({
      sessionId: first,
      sourceId: 'mic',
      segmentId: `l-${i + 1}`,
      sequence: i + 2,
      revision: 1,
      kind: 'final',
      text: `对方句${i + 1}`
    })),
    /* a-1 已被窗口淘汰后才定稿：两侧都按重开新段处理（复活到末尾）。 */
    caption({ sessionId: first, sourceId: 'mic', segmentId: 'a-1', sequence: KEEP_SEGMENTS + 3, revision: 2, kind: 'final', text: '我说完了。' }),
    /* 窗口内修订：应用。 */
    caption({
      sessionId: first,
      sourceId: 'mic',
      segmentId: `l-${KEEP_SEGMENTS + 1}`,
      sequence: KEEP_SEGMENTS + 4,
      revision: 2,
      kind: 'translated',
      text: `对方句${KEEP_SEGMENTS + 1}`,
      translation: { language: 'en', text: 'Latest.', basedOnRevision: 1 }
    }),
    /* 窗口外修订：两侧一致忽略。 */
    caption({ sessionId: first, sourceId: 'mic', segmentId: 'l-1', sequence: KEEP_SEGMENTS + 5, revision: 2, kind: 'refined', text: '精修第一句' })
  ]
  for (const event of stream) {
    adapter.emitCaption(event)
    assertEquivalent()
  }

  /* 新会话的第一条广播事件是修订：两侧都切会话但不开段。 */
  assert.equal((await coordinator.command('stop')).ok, true)
  assert.equal((await coordinator.command('start')).ok, true)
  const second = coordinator.getSnapshot().sessionId
  adapter.emitCaption(caption({ sessionId: second, segmentId: 'ghost', sequence: 1, revision: 2, kind: 'refined', text: '幽灵段' }))
  assertEquivalent()
  assert.deepEqual(live.segments, [])
  assert.equal(live.sessionId, second)
})

test('pending captions flushed at listening are folded into caption state', async (t) => {
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  const originalStart = adapter.start.bind(adapter)
  adapter.start = async (context) => {
    await originalStart(context)
    adapter.emitCaption(caption({
      sessionId: context.sessionId, segmentId: 'early', kind: 'final', text: '早到的字幕'
    }))
  }
  const { coordinator } = makeCoordinator({ adapter })
  t.after(() => coordinator.dispose())

  assert.equal((await coordinator.command('start')).ok, true)
  const state = coordinator.getCaptionState()
  assert.deepEqual(state.segments.map((segment) => segment.text), ['早到的字幕'])
})

test('caption state is retained through pause and mid-session error', async (t) => {
  const { adapter, coordinator } = makeCoordinator({ transitionTimeoutMs: 20 })
  t.after(() => coordinator.dispose())
  await coordinator.command('start')
  adapter.emit('final', 1, '第一句')

  assert.equal((await coordinator.command('pause')).ok, true)
  assert.deepEqual(coordinator.getCaptionState().segments.map((segment) => segment.text), ['第一句'])

  assert.equal((await coordinator.command('resume')).ok, true)
  adapter.pause = async () => new Promise(() => {})
  assert.equal((await coordinator.command('pause')).code, 'ADAPTER_PAUSE_TIMEOUT')
  assert.equal(coordinator.getSnapshot().phase, 'error')
  assert.deepEqual(coordinator.getCaptionState().segments.map((segment) => segment.text), ['第一句'])
})

test('captions buffered during a failed retry are discarded from caption state', async (t) => {
  const { adapter, coordinator, replacements } = makeCoordinator({ transitionTimeoutMs: 20 })
  t.after(() => coordinator.dispose())
  await coordinator.command('start')
  adapter.emit('final', 1, '第一句')

  adapter.pause = async () => new Promise(() => {})
  assert.equal((await coordinator.command('pause')).code, 'ADAPTER_PAUSE_TIMEOUT')

  /* replacement 在 recovering 期间发出字幕（进入 pending 缓冲）随后失败：
     缓冲被丢弃，canonical state 不得出现这些段。 */
  const replacement = replacements[0]
  const replacementStart = replacement.start
  replacement.start = async (context) => {
    await replacementStart(context)
    replacement.emit('partial', 1, '不该出现')
    throw new Error('injected retry failure')
  }
  const before = coordinator.getCaptionState()
  assert.equal((await coordinator.command('retry')).code, 'ADAPTER_RETRY_FAILED')
  assert.deepEqual(coordinator.getCaptionState(), before)
  assert.deepEqual(coordinator.getCaptionState().segments.map((segment) => segment.text), ['第一句'])
})

test('caption state retains stopped captions until the next session delivers', async (t) => {
  const { adapter, coordinator } = makeCoordinator()
  t.after(() => coordinator.dispose())

  await coordinator.command('start')
  const firstSession = coordinator.getSnapshot().sessionId
  adapter.emitCaption(caption({ sessionId: firstSession, kind: 'final', text: '第一句。' }))
  assert.equal((await coordinator.command('stop')).ok, true)

  const retained = coordinator.getCaptionState()
  assert.equal(retained.sessionId, firstSession)
  assert.equal(retained.segments.length, 1)
  assert.equal(retained.segments[0].text, '第一句。')
  assert.equal(coordinator.getSnapshot().sessionId, null)

  /* 新会话开始但还没有任何字幕：旧字幕保留（与未重载 renderer 一致）。 */
  await coordinator.command('start')
  const secondSession = coordinator.getSnapshot().sessionId
  assert.notEqual(secondSession, firstSession)
  assert.equal(coordinator.getCaptionState().sessionId, firstSession)

  /* 新会话第一条已广播字幕才清空旧会话。 */
  adapter.emitCaption(caption({ sessionId: secondSession, segmentId: 'segment-b', text: '新会话' }))
  const switched = coordinator.getCaptionState()
  assert.equal(switched.sessionId, secondSession)
  assert.deepEqual(switched.segments.map((segment) => segment.segmentId), ['segment-b'])
})

test('discarded pending captions never appear in caption state', async (t) => {
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  const originalStart = adapter.start.bind(adapter)
  adapter.start = async (context) => {
    await originalStart(context)
    adapter.emitCaption(caption({ sessionId: context.sessionId, segmentId: 'early', text: '早' }))
    throw new Error('injected failure')
  }
  const { coordinator } = makeCoordinator({ adapter })
  t.after(() => coordinator.dispose())

  const before = coordinator.getCaptionState()
  const result = await coordinator.command('start')
  assert.equal(result.code, 'ADAPTER_START_FAILED')
  assert.deepEqual(coordinator.getCaptionState(), before)
})

test('replacement adapter keeps captions flowing after a mid-session timeout', async (t) => {
  const { adapter, coordinator, replacements, resumeContexts } = makeCoordinator({ transitionTimeoutMs: 20 })
  t.after(() => coordinator.dispose())
  const delivered = []
  coordinator.onCaption((event) => delivered.push(event.text))

  await coordinator.command('start')
  adapter.emit('final', 1, '第一句')
  assert.deepEqual(delivered, ['第一句'])

  adapter.pause = async () => new Promise(() => {})
  const paused = await coordinator.command('pause')
  assert.equal(paused.code, 'ADAPTER_PAUSE_TIMEOUT')
  assert.equal(coordinator.getSnapshot().phase, 'error')

  assert.equal((await coordinator.command('retry')).ok, true)
  assert.equal(coordinator.getSnapshot().phase, 'listening')
  assert.deepEqual(resumeContexts, [{ attempt: 1, sourceSequences: { mic: 1 } }])

  /* §12.3 的核心回归：replacement 的下一条字幕必须被接受并到达订阅者。 */
  replacements[0].emit('partial', 1, '恢复')
  replacements[0].emit('final', 2, '恢复了')
  assert.deepEqual(delivered, ['第一句', '恢复', '恢复了'])

  /* 被隔离的旧 adapter 已解除绑定，迟到的发射不能再混进来。 */
  adapter.emit('final', 9, '幽灵')
  assert.deepEqual(delivered, ['第一句', '恢复', '恢复了'])

  const state = coordinator.getCaptionState()
  assert.deepEqual(state.segments.map((segment) => segment.segmentId), ['segment-0', 'segment-r1-0'])
  assert.equal(state.segments[1].text, '恢复了')
})

test('replacement adapter first caption is accepted after a start timeout retry', async (t) => {
  const adapter = new FakeRuntimeAdapter({ autoEmit: false })
  adapter.start = async () => new Promise(() => {})
  const { coordinator, replacements, resumeContexts } = makeCoordinator({ adapter, transitionTimeoutMs: 20 })
  t.after(() => coordinator.dispose())
  const delivered = []
  coordinator.onCaption((event) => delivered.push(event.text))

  assert.equal((await coordinator.command('start')).code, 'ADAPTER_START_TIMEOUT')
  assert.equal((await coordinator.command('retry')).ok, true)
  assert.deepEqual(resumeContexts, [{ attempt: 1, sourceSequences: {} }])

  replacements[0].emit('partial', 1, '新的')
  assert.deepEqual(delivered, ['新的'])
})

test('caption state folds only the configured source', async (t) => {
  const { adapter, coordinator } = makeCoordinator()
  t.after(() => coordinator.dispose())
  await coordinator.command('start')
  const sessionId = coordinator.getSnapshot().sessionId

  adapter.emitCaption(caption({ sessionId, sourceId: 'mic', segmentId: 'm-1', text: '我说' }))
  adapter.emitCaption(caption({ sessionId, sourceId: 'loopback', segmentId: 'l-1', text: '对方说' }))

  const state = assertCaptionState(coordinator.getCaptionState())
  assert.deepEqual(
    state.segments.map((segment) => [segment.segmentId, segment.sourceId]),
    [['m-1', 'mic']]
  )
})

test('caption state segment cap keeps the newest segments', async (t) => {
  const { adapter, coordinator } = makeCoordinator()
  t.after(() => coordinator.dispose())
  await coordinator.command('start')
  const sessionId = coordinator.getSnapshot().sessionId

  const total = KEEP_SEGMENTS + 6
  for (let index = 1; index <= total; index += 1) {
    adapter.emitCaption(caption({
      sessionId,
      segmentId: `seg-${index}`,
      sequence: index,
      kind: 'final',
      text: `句子 ${index}`
    }))
  }

  const state = coordinator.getCaptionState()
  assert.equal(state.segments.length, KEEP_SEGMENTS)
  assert.equal(state.segments[0].segmentId, `seg-${total - KEEP_SEGMENTS + 1}`)
  assert.equal(state.segments.at(-1).segmentId, `seg-${total}`)
})

test('dispose clears caption state', async (t) => {
  const { adapter, coordinator } = makeCoordinator()
  await coordinator.command('start')
  adapter.emitCaption(caption({ sessionId: coordinator.getSnapshot().sessionId, kind: 'final', text: '句。' }))
  assert.equal(coordinator.getCaptionState().segments.length, 1)

  await coordinator.dispose()
  const state = coordinator.getCaptionState()
  assert.equal(state.sessionId, null)
  assert.deepEqual(state.segments, [])
})
