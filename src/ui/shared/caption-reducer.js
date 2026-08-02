'use strict'

// @ts-check

/* CaptionEvent → 可渲染的字幕状态，以及行数预算的计算。
   --------------------------------------------------------------------------
   纯逻辑，不碰 DOM。两块职责：

   1. reducer：把乱序、重复、迟到的 CaptionEvent 归并成稳定的段落列表。
      文本和译文各自记录 revision —— 迟到的 translated 事件可以补上译文，
      但绝不能把已经更新到更高 revision 的正文回滚。

   2. 固定视口：字幕是一条连续的流，不再有 previous/current/translation 三个
      各自带行数预算的槽位。这里只回答两个问题——哪些段按什么顺序进入这条流，
      以及固定高度里能完整放下几行。真正的换行和"最旧行离场"由 Chromium 的
      布局与 overflow 裁剪完成（见 SEM-F20 与 docs/subtitle-flow-and-transcript-versions.md），
      本文件不重新实现断行规则。

   UMD，理由同 runtime-view.js。 */

;(function (root) {
  /**
   * canonical 实时视图的内存保险上限。产品最大 420px 窗高、最小 24px
   * 字号下最多完整显示 10 行；64 段远高于视觉容量，所以它不会在视口尚未
   * 写满时提前删除短段。真正的正常淘汰来自 Chromium 量出的整段视觉退出。
   */
  const KEEP_SEGMENTS = 64

  function createState () {
    const state = { sessionId: null, segments: [], refinementSuppressed: false }
    /* Internal-only immutable first passes. Keep them non-enumerable so the
       public CaptionState shape and deterministic state comparisons do not
       accidentally expose another transcript field. */
    Object.defineProperty(state, 'firstPassBySegment', {
      value: new Map(),
      enumerable: false,
      configurable: false,
      writable: false
    })
    /* 已经整段离开固定视口的显示墓碑。只存会话内 segmentId，不进入历史、
       CaptionState 或持久化；主进程用它抑制迟到显示事件，renderer 用它保护
       canonical replacement。 */
    Object.defineProperty(state, 'evictedSegmentIds', {
      value: new Set(),
      enumerable: false,
      configurable: false,
      writable: false
    })
    return state
  }

  /**
   * 从主进程 CaptionState 水合 reducer 状态（reload/bootstrap 恢复用）。
   * canonical segment 字段与本地 segment 一一对应；只保留最近
   * KEEP_SEGMENTS 段。水合后照常 applyEvent —— 已折叠进状态的事件
   * 会因 revision/sequence 不更新而被单调判定自然丢弃。
   * @param {*} canonical 已通过 assertCaptionState 的主进程状态
   */
  function hydrateState (canonical, previousState = null) {
    const state = createState()
    if (!canonical || typeof canonical !== 'object') return state
    if (typeof canonical.sessionId !== 'string' || canonical.sessionId.length === 0) return state
    const segments = Array.isArray(canonical.segments) ? canonical.segments : []
    state.sessionId = canonical.sessionId
    if (previousState?.sessionId === canonical.sessionId && previousState.evictedSegmentIds) {
      for (const segmentId of previousState.evictedSegmentIds) state.evictedSegmentIds.add(segmentId)
    }
    const eligible = segments
      .filter((segment) => !state.evictedSegmentIds.has(segment.segmentId))
    const overflow = Math.max(0, eligible.length - KEEP_SEGMENTS)
    for (let index = 0; index < overflow; index += 1) {
      state.evictedSegmentIds.add(eligible[index].segmentId)
    }
    const retained = eligible.slice(overflow)
    for (const segment of retained) {
      state.segments.push({
        segmentId: segment.segmentId,
        sourceId: segment.sourceId,
        sequence: segment.sequence,
        kind: segment.kind,
        text: segment.text,
        textRevision: segment.textRevision,
        translation: segment.translation
          ? {
              language: segment.translation.language,
              text: segment.translation.text,
              basedOnRevision: segment.translation.basedOnRevision
            }
          : null,
        translationRevision: segment.translationRevision,
        t0: segment.t0,
        t1: segment.t1
      })
      if (segment.kind === 'final') state.firstPassBySegment.set(segment.segmentId, segment.text)
    }
    return state
  }

  function findSegment (state, segmentId) {
    for (let i = state.segments.length - 1; i >= 0; i -= 1) {
      if (state.segments[i].segmentId === segmentId) return state.segments[i]
    }
    return null
  }

  /**
   * 应用一个 CaptionEvent，返回新的 state（原地更新，调用方不需要比较引用）。
   * @param {*} state
   * @param {*} event 已通过 assertCaptionEvent 的 CaptionEvent
   */
  function applyEvent (state, event) {
    /* 换会话：旧字幕不属于新会话，整体丢弃 */
    if (state.sessionId !== event.sessionId) {
      state.sessionId = event.sessionId
      state.segments = []
      state.refinementSuppressed = false
      state.firstPassBySegment.clear()
      state.evictedSegmentIds.clear()
    }

    /* CSS 已确认整段离场后，本会话的任何迟到版本都只能留在权威历史，
       不能再进入实时显示 fold。 */
    if (state.evictedSegmentIds.has(event.segmentId)) return state

    /* A confirmed refinement fault retires that worker generation. Late
       refined events must not repaint the caption after the original version
       has been restored. */
    if (state.refinementSuppressed && event.kind === 'refined') return state

    let segment = findSegment(state, event.segmentId)
    if (!segment) {
      /* refined/translated 是对既有段的修订（basedOnRevision 必然指向更早的
         正文版本），不能开新段：目标段已被淘汰出窗口时直接忽略。主进程
         foldCaptionState 用同一规则，保证 reload 前后的显示视图严格一致，
         也避免老句子被迟到修订复活成当前行。 */
      if (event.kind === 'refined' || event.kind === 'translated') return state
      segment = {
        segmentId: event.segmentId,
        sourceId: event.sourceId,
        sequence: event.sequence,
        kind: event.kind,
        text: '',
        textRevision: 0,
        translation: null,
        translationRevision: 0,
        t0: event.t0,
        t1: event.t1
      }
      state.segments.push(segment)
      if (state.segments.length > KEEP_SEGMENTS) {
        const removed = state.segments.shift()
        state.evictedSegmentIds.add(removed.segmentId)
        state.firstPassBySegment.delete(removed.segmentId)
      }
    }

    /* 严格「更新」判定：先比 revision，再比 sequence。
       后半段是为了兼容 partial 期间不递增 revision、只靠 sequence 区分的后端；
       两者都不更大就是旧事件，一律丢弃，绝不回滚已显示的文本。 */
    const isNewerText = event.revision > segment.textRevision ||
      (event.revision === segment.textRevision && event.sequence > segment.sequence)

    /* The first final is the immutable source text for runtime fallback. */
    if (event.kind === 'final' && !state.firstPassBySegment.has(segment.segmentId)) {
      state.firstPassBySegment.set(segment.segmentId, event.text)
    }

    /* 正文：只接受更新的事件。旧事件不能覆盖新文本。 */
    if (isNewerText) {
      segment.text = event.text
      segment.kind = event.kind
      segment.textRevision = event.revision
      segment.sequence = event.sequence
      segment.t0 = event.t0
      segment.t1 = event.t1
    }

    /* 译文独立记 revision：迟到的 translated 仍可补上译文，
       但因为上面那段没跑，正文不会被回滚到更旧的版本。 */
    if (event.translation && event.revision > segment.translationRevision) {
      segment.translation = event.translation
      segment.translationRevision = event.revision
    }

    return state
  }

  /**
   * Retire refinement display for the current session and restore every still
   * retained finalized segment to its immutable first pass. Current partial
   * objects are not touched, and evicted segments cannot be recreated because
   * they are absent from this bounded state.
   * @returns {boolean} whether visible displayed text changed
   */
  function fallbackRefinement (state) {
    state.refinementSuppressed = true
    let changed = false
    for (const segment of state.segments) {
      const firstPassText = state.firstPassBySegment.get(segment.segmentId)
      if (segment.kind === 'partial' || typeof firstPassText !== 'string') continue
      if (segment.text !== firstPassText || segment.kind !== 'final') changed = true
      segment.text = firstPassText
      segment.kind = 'final'
    }
    return changed
  }

  /**
   * 永久淘汰一个已经完全离开视觉视口的有序前缀。
   * throughSegmentId 必须仍在当前 state 中，且不能是最新段；这既保证报告
   * 表达的是旧前缀，也让 renderer 即使被错误调用也无法清空当前 partial。
   */
  function evictCaptionPrefix (state, throughSegmentId) {
    if (typeof throughSegmentId !== 'string' || throughSegmentId.length === 0) return false
    const index = state.segments.findIndex((segment) => segment.segmentId === throughSegmentId)
    if (index < 0 || index >= state.segments.length - 1) return false
    const removed = state.segments.splice(0, index + 1)
    for (const segment of removed) {
      state.evictedSegmentIds.add(segment.segmentId)
      state.firstPassBySegment.delete(segment.segmentId)
    }
    return removed.length > 0
  }

  function isCaptionSegmentEvicted (state, segmentId) {
    return !!state?.evictedSegmentIds?.has(segmentId)
  }

  /**
   * 选出进入字幕流的段落，按时间升序：最旧在前，最新在后。
   *
   * 渲染层把它们依次落进固定高度视口，而视口是从**顶部**裁剪的，所以
   * SEM-F20 的「当前 partial 始终优先、不得被旧段或精修稿挤掉」由 DOM 顺序
   * 结构性保证，不需要在这里再做一次优先级判断。空文本段不进流——它只会
   * 占掉一整行视觉预算却什么都不显示。
   *
   * @returns {Array<{segmentId: string, text: string, isPartial: boolean}>}
   */
  function selectFlow (state) {
    const flow = []
    for (const segment of state.segments) {
      if (!segment.text) continue
      flow.push({
        segmentId: segment.segmentId,
        text: segment.text,
        /* partial 才是「还在输入」。final / refined / translated 都是定稿。 */
        isPartial: segment.kind === 'partial'
      })
    }
    return flow
  }

  /**
   * 固定视口能**完整**容纳多少行。
   *
   * 只按整行向下取整：留下半行会被顶部裁掉一截，违反 SEM-F20 的
   * 「只隐藏最上方最旧的完整视觉行」。字幕流内所有行必须同字号同行高、
   * 段间无外边距，否则内容总高不再是行高的整数倍，取整就失去意义。
   *
   * 一行都放不下时仍返回 1：宁可溢出一点，也不能没有字幕。
   *
   * @param {{available: number, fontSize: number, lineHeight: number}} input
   * @returns {number} 正整数
   */
  function countVisibleLines (input) {
    const line = Number(input.fontSize) * Number(input.lineHeight)
    const available = Number(input.available)
    if (!Number.isFinite(line) || line <= 0) return 1
    if (!Number.isFinite(available) || available <= 0) return 1
    return Math.max(1, Math.floor(available / line))
  }

  const api = {
    KEEP_SEGMENTS,
    createState,
    evictCaptionPrefix,
    hydrateState,
    isCaptionSegmentEvicted,
    applyEvent,
    fallbackRefinement,
    selectFlow,
    countVisibleLines
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.CaptionReducer = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
