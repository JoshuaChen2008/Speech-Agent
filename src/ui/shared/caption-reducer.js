'use strict'

// @ts-check

/* CaptionEvent → 可渲染的字幕状态，以及行数预算的计算。
   --------------------------------------------------------------------------
   纯逻辑，不碰 DOM。两块职责：

   1. reducer：把乱序、重复、迟到的 CaptionEvent 归并成稳定的段落列表。
      文本和译文各自记录 revision —— 迟到的 translated 事件可以补上译文，
      但绝不能把已经更新到更高 revision 的正文回滚。

   2. 行数预算：整张卡片只有一个高度预算，按 current → translation → prev
      的优先级分配，而不是给每行各发一个 maxLines 然后叠出溢出。
      分配顺序是产品判断：当前句永远要有一行；开了双语就说明用户要译文；
      上一句是锦上添花，放不下先牺牲它。

   UMD，理由同 runtime-view.js。 */

;(function (root) {
  /** 保留多少段历史。渲染只用到最后两段，多留一点是为了迟到事件还能落位。 */
  const KEEP_SEGMENTS = 8

  function createState () {
    return { sessionId: null, segments: [] }
  }

  /**
   * 从主进程 CaptionState 水合 reducer 状态（reload/bootstrap 恢复用）。
   * canonical segment 字段与本地 segment 一一对应；只保留最近
   * KEEP_SEGMENTS 段。水合后照常 applyEvent —— 已折叠进状态的事件
   * 会因 revision/sequence 不更新而被单调判定自然丢弃。
   * @param {*} canonical 已通过 assertCaptionState 的主进程状态
   */
  function hydrateState (canonical) {
    const state = createState()
    if (!canonical || typeof canonical !== 'object') return state
    if (typeof canonical.sessionId !== 'string' || canonical.sessionId.length === 0) return state
    const segments = Array.isArray(canonical.segments) ? canonical.segments : []
    state.sessionId = canonical.sessionId
    for (const segment of segments.slice(-KEEP_SEGMENTS)) {
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
    }

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
      if (state.segments.length > KEEP_SEGMENTS) state.segments.shift()
    }

    /* 严格「更新」判定：先比 revision，再比 sequence。
       后半段是为了兼容 partial 期间不递增 revision、只靠 sequence 区分的后端；
       两者都不更大就是旧事件，一律丢弃，绝不回滚已显示的文本。 */
    const isNewerText = event.revision > segment.textRevision ||
      (event.revision === segment.textRevision && event.sequence > segment.sequence)

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
   * 选出要渲染的三个槽位。
   * @returns {{previous: string, current: string, isPartial: boolean, translation: string|null}}
   */
  function selectLines (state, options) {
    const bilingual = !!(options && options.bilingual)
    const segments = state.segments
    const current = segments[segments.length - 1] || null
    const previous = segments[segments.length - 2] || null

    return {
      previous: previous ? previous.text : '',
      current: current ? current.text : '',
      /* partial 才是「还在输入」。final / refined / translated 都是定稿。 */
      isPartial: !!current && current.kind === 'partial',
      translation: bilingual && current && current.translation
        ? current.translation.text
        : null
    }
  }

  /**
   * 行数预算。
   *
   * 分配顺序：current 保底 1 行 → translation 1 行 → previous 1 行
   *          → 剩余高度再喂给 current，上限 maxCurrentLines。
   *
   * @param {{
   *   available: number,      正文可用高度（px）
   *   fontSize: number,       当前字号（px）
   *   lineHeight: number,     行高倍数
   *   prevRatio: number,      previous / translation 相对当前行的字号比例
   *   gap: number,            previous 与 translation 各自的外边距（px）
   *   hasPrevious: boolean,
   *   hasTranslation: boolean,
   *   maxCurrentLines: number
   * }} input
   * @returns {{previous: number, current: number, translation: number, used: number}}
   */
  function computeLineBudget (input) {
    const currentLine = input.fontSize * input.lineHeight
    const minorLine = input.fontSize * input.prevRatio * input.lineHeight

    const plan = { previous: 0, current: 1, translation: 0, used: currentLine }
    /* 当前句一行都放不下时也不降到 0：宁可溢出一点，也不能没有字幕。 */
    if (plan.used > input.available) return plan

    const tryTake = (cost) => {
      if (plan.used + cost > input.available) return false
      plan.used += cost
      return true
    }

    if (input.hasTranslation && tryTake(minorLine + input.gap)) plan.translation = 1
    if (input.hasPrevious && tryTake(minorLine + input.gap)) plan.previous = 1

    while (plan.current < input.maxCurrentLines && tryTake(currentLine)) {
      plan.current += 1
    }

    return plan
  }

  const api = { KEEP_SEGMENTS, createState, hydrateState, applyEvent, selectLines, computeLineBudget }

  if (typeof module !== 'undefined' && module.exports) module.exports = api
  else root.CaptionReducer = api
})(typeof globalThis !== 'undefined' ? globalThis : this)
