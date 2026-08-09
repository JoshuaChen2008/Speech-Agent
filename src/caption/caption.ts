'use strict'

;(function captionRenderer () {

// @ts-check

/* 字幕窗：命中测试 + 拖动（role=caption）+ 锁定穿透 + 配置应用 + CaptionEvent 渲染。
   状态归并和行数预算都在 ../ui/shared/caption-reducer.js，本文件只做 DOM 落地。 */

const {
  createState,
  hydrateState,
  applyEvent,
  evictCaptionPrefix,
  isCaptionSegmentEvicted,
  selectFlow,
  countVisibleLines
} = window.CaptionReducer
const { applyAppearance } = window.Appearance

function requireElement (id: string): HTMLElement {
  const element = document.getElementById(id)
  if (!element) throw new Error(`caption renderer element is missing: ${id}`)
  return element
}

const wrap = requireElement('wrap')
const card = requireElement('captionCard')
const captions = requireElement('captions')
const captionFlow = requireElement('captionFlow')
const liveRegion = requireElement('liveRegion')

/* 壳层 API。在纯浏览器里打开本页做视觉核对时不存在，降级成空操作，
   这样排版问题可以脱离 Electron 排查。
   ⚠ 不能叫 shell —— preload 的 contextBridge 已经占了这个全局名，
   顶层 const 同名会直接 SyntaxError，整个 renderer 白屏。 */
const bridge: any = window.shell || {
  mouseThrough () {}, dragStart () {}, dragEnd () {},
  resizeStart () {}, resizeEnd () {},
  onInteractionSync () {}, onLock () {}, onToolbarOverlap () {}, onConfig () {}, onCaption () {}, onCaptionState () {},
  reportCaptionViewportEviction () { return Promise.resolve(false) },
  getLock () { return Promise.reject(new Error('no shell')) },
  getConfig () { return Promise.reject(new Error('no shell')) },
  getCaptionState () { return Promise.reject(new Error('no shell')) }
}

let locked = false
let dragging = false
let resizing = false
let ignoring: boolean | null = null
let lastX = 0, lastY = 0
let toolbarOverlapGeneration = 0
let gesturePointerId: number | null = null
let interactionGeneration = 0
let interactionPhase = 'resume'

// --------------------------------------------------------------------------
// 边缘拉伸
// 卡片内侧 8px 是拉伸带，其余是拖动区。锁定后整窗恒穿透，两者都不生效。
// --------------------------------------------------------------------------
const EDGE = 8
const RESIZE_CURSOR: Record<string, string> = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize'
}

/** 指针落在卡片哪条边上；不在拉伸带内返回空串。 @param {number} x @param {number} y */
function edgeAt (x: number, y: number): string {
  if (locked) return ''
  const r = card.getBoundingClientRect()
  if (x < r.left || x > r.right || y < r.top || y > r.bottom) return ''

  let edge = ''
  if (y - r.top <= EDGE) edge += 'n'
  else if (r.bottom - y <= EDGE) edge += 's'
  if (x - r.left <= EDGE) edge += 'w'
  else if (r.right - x <= EDGE) edge += 'e'
  return edge
}

/** 字幕状态。排版不再依赖任何配置项——可见行数由实际可用高度与字号决定。 */
let state = createState()

// --------------------------------------------------------------------------
// 命中顺序固定为：透明外边距 → 工具条实际轮廓 → 8px 拉伸带 → 普通拖动。
// 锁定态由主进程恒穿透，这里不干预。
// --------------------------------------------------------------------------
/** @param {number} x @param {number} y */
function captionActionAt (x: number, y: number) {
  if (locked) return { kind: 'through', edge: '' }
  const el = document.elementFromPoint(x, y)
  if (!el || !el.closest('.caption-card')) return { kind: 'through', edge: '' }
  if (el.closest('.tb-hole')) return { kind: 'toolbar', edge: '' }
  const edge = edgeAt(x, y)
  return edge ? { kind: 'resize', edge } : { kind: 'drag', edge: '' }
}

/** @param {number} x @param {number} y @param {boolean=} force */
function applyHit (x: number, y: number, force = false): void {
  if (interactionPhase !== 'resume' || dragging || resizing) return
  const action = captionActionAt(x, y)
  const solid = !locked && (action.kind === 'resize' || action.kind === 'drag')
  const next = !solid
  if (force || next !== ignoring) {
    ignoring = next
    bridge.mouseThrough(next)
  }
}

let hitFrame: number | null = null
let hitRevision = 0
function cancelHitFrame (): void {
  hitRevision += 1
  if (hitFrame === null) return
  if (typeof cancelAnimationFrame === 'function' && hitFrame >= 0) {
    try { cancelAnimationFrame(hitFrame) } catch { /* revision still invalidates the callback */ }
  }
  hitFrame = null
}

function queueHit (force = false): void {
  if (hitFrame !== null || interactionPhase !== 'resume') return
  const generation = interactionGeneration
  const revision = hitRevision
  hitFrame = -1
  const frame = requestAnimationFrame(() => {
    if (generation !== interactionGeneration || revision !== hitRevision || interactionPhase !== 'resume') return
    hitFrame = null
    applyHit(lastX, lastY, force)
    if (!dragging && !resizing) {
      const action = captionActionAt(lastX, lastY)
      card.style.cursor = action.kind === 'resize' ? RESIZE_CURSOR[action.edge] : ''
    }
  })
  if (hitFrame !== null && revision === hitRevision) hitFrame = frame
}

document.addEventListener('mousemove', (e) => {
  lastX = e.clientX; lastY = e.clientY
  queueHit()
})

/** @param {any} payload */
function acceptToolbarOverlap (payload: any): void {
  if (!payload || !Number.isSafeInteger(payload.generation) || payload.generation <= 0 ||
      payload.generation < toolbarOverlapGeneration ||
      !['fallback', 'toolbar'].includes(payload.source) ||
      !payload.rect || typeof payload.rect !== 'object') return
  const { top, right, width, height } = payload.rect
  if (![top, right, width, height].every(Number.isFinite) ||
      top < 0 || right < 0 || width <= 0 || height <= 0 ||
      top > 72 || right > 600 || width > 600 || height > 72) return

  toolbarOverlapGeneration = payload.generation
  const style = document.documentElement.style
  style.setProperty('--toolbar-overlap-top', `${top}px`)
  style.setProperty('--toolbar-overlap-right', `${right}px`)
  style.setProperty('--toolbar-overlap-width', `${width}px`)
  style.setProperty('--toolbar-overlap-height', `${height}px`)
  /* A stationary pointer must not retain the hit result from the old hole. */
  applyHit(lastX, lastY)
}

if (typeof bridge.onToolbarOverlap === 'function') bridge.onToolbarOverlap(acceptToolbarOverlap)

// --------------------------------------------------------------------------
// 拖动（未锁定时可拖；role=caption）
// --------------------------------------------------------------------------
card.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.isPrimary === false || !Number.isInteger(e.pointerId) ||
      locked || gesturePointerId !== null) return
  const action = captionActionAt(e.clientX, e.clientY)
  if (action.kind !== 'resize' && action.kind !== 'drag') return
  try {
    const accepted = action.kind === 'resize'
      ? bridge.resizeStart(action.edge)
      : bridge.dragStart('caption')
    if (accepted === false) return
  } catch { return }

  gesturePointerId = e.pointerId
  if (action.kind === 'resize') {
    resizing = true
  } else {
    dragging = true
    card.classList.add('dragging')
  }
  try { card.setPointerCapture(e.pointerId) } catch { /* noop */ }
})

/* pointerup / pointercancel / lostpointercapture / blur 全都要收尾 ——
   主进程那边是一个持续跑的定时器，漏掉任何一条取消路径都会让窗口继续跟着光标跑。 */
/** @param {PointerEvent=} event @param {boolean=} notifyMain @param {boolean=} recomputeHit */
function endGesture (event?: Event & { pointerId?: number }, notifyMain = true, recomputeHit = true): void {
  if (!dragging && !resizing) return
  if (event && Number.isInteger(event.pointerId) && event.pointerId !== gesturePointerId) return
  const pointerId = gesturePointerId
  gesturePointerId = null
  if (pointerId !== null) {
    try { card.releasePointerCapture?.(pointerId) } catch { /* noop */ }
  }
  if (resizing) {
    resizing = false
    if (notifyMain) bridge.resizeEnd()
  }
  if (dragging) {
    dragging = false
    card.classList.remove('dragging')
    if (notifyMain) bridge.dragEnd()
  }
  card.style.cursor = ''
  if (recomputeHit) applyHit(lastX, lastY)
}
window.addEventListener('pointerup', endGesture)
window.addEventListener('pointercancel', endGesture)
card.addEventListener('lostpointercapture', endGesture)
window.addEventListener('blur', endGesture)
window.addEventListener('beforeunload', endGesture)

/** @param {any} value */
function acceptInteractionSync (value: any): void {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.generation) ||
      value.generation <= 0 || value.generation < interactionGeneration ||
      (value.phase !== 'suspend' && value.phase !== 'resume')) return
  if (value.phase === 'suspend' && Object.keys(value).length !== 3) return
  if (value.phase === 'resume' && (Object.keys(value).length !== 4 || !value.pointer ||
      Object.keys(value.pointer).length !== 2 ||
      !Number.isFinite(value.pointer.x) || !Number.isFinite(value.pointer.y))) return

  cancelHitFrame()
  endGesture(undefined, false, false)
  interactionGeneration = value.generation
  interactionPhase = value.phase
  ignoring = null
  if (value.phase === 'suspend') {
    card.style.cursor = ''
    return
  }
  lastX = value.pointer.x
  lastY = value.pointer.y
  queueHit(true)
}

if (typeof bridge.onInteractionSync === 'function') bridge.onInteractionSync(acceptInteractionSync)

// --------------------------------------------------------------------------
// 锁定：主进程已把本窗设为恒穿透；这里只更新视觉
// --------------------------------------------------------------------------
let lockRevision = 0

/** @param {boolean} on */
function applyLockState (on: boolean): void {
  locked = !!on
  wrap.dataset.locked = locked ? 'on' : 'off'
  if (locked) endGesture()
  else { ignoring = null; applyHit(lastX, lastY) }
}

async function initLock () {
  bridge.onLock((on: boolean) => {
    lockRevision += 1
    applyLockState(on)
  })
  const requestedAt = lockRevision
  try {
    const on = await bridge.getLock()
    if (lockRevision === requestedAt) applyLockState(on)
  } catch { /* browser preview */ }
}

// --------------------------------------------------------------------------
// 渲染：固定高度字幕流
//
// 职责切得很干净：本文件只决定「哪些段、什么顺序进 DOM」和「视口能放几行」，
// 换行位置、行盒高度与顶部裁剪全部由 Chromium 完成。绝不在 JS 里重新实现一遍
// 断行规则 —— 那样只会得到与 CSS 各自为政的第二套规则。
// --------------------------------------------------------------------------
/** @param {CSSStyleDeclaration} styles @param {string} name */
function cssNumber (styles: CSSStyleDeclaration, name: string): number {
  return parseFloat(styles.getPropertyValue(name))
}

/* 视口高度只在可用高度或字号变化时重算。partial 每秒刷新十几次，
   把 getComputedStyle/clientHeight 放进每帧渲染会产生持续的强制布局。 */
function applyViewport () {
  const styles = getComputedStyle(document.documentElement)
  const lines = countVisibleLines({
    /* 可用高度直接量 DOM，不复制一份常量到 JS —— 卡片内边距改了这里自动跟上 */
    available: captions.clientHeight,
    fontSize: cssNumber(styles, '--fs'),
    lineHeight: cssNumber(styles, '--lh-caption')
  })
  document.documentElement.style.setProperty('--visible-lines', String(lines))
  queueViewportEviction()
}

function patchSegmentNode (node: Element, item: any, index: number, length: number): void {
  if (node.textContent !== item.text) node.textContent = item.text
  node.classList.toggle('partial', item.isPartial)
  /* 最后一个是最新段；它永远贴在底部，裁剪只发生在它上方。 */
  node.classList.toggle('older', index < length - 1)
  if ((node as HTMLElement).dataset.segmentId !== item.segmentId) {
    (node as HTMLElement).dataset.segmentId = item.segmentId
  }
}

/** 按需增删节点、只改目标段；高频 partial 不扫描或重建整棵子树。 */
function render (scheduleEviction = true, changedSegmentId: string | null = null): void {
  const flow = selectFlow(state)
  const nodes = captionFlow.children

  const structureStable = nodes.length === flow.length && flow.every((item: any, index: number) =>
    (nodes[index] as HTMLElement).dataset.segmentId === item.segmentId)
  if (structureStable && changedSegmentId) {
    const index = flow.findIndex((item: any) => item.segmentId === changedSegmentId)
    if (index >= 0) patchSegmentNode(nodes[index], flow[index], index, flow.length)
    if (scheduleEviction) queueViewportEviction()
    return
  }

  while (nodes.length > flow.length) {
    const last = captionFlow.lastChild
    if (last) captionFlow.removeChild(last)
  }
  while (nodes.length < flow.length) {
    const node = document.createElement('p')
    node.className = 'seg'
    captionFlow.appendChild(node)
  }

  for (let i = 0; i < flow.length; i += 1) {
    patchSegmentNode(nodes[i], flow[i], i, flow.length)
  }
  if (scheduleEviction) queueViewportEviction()
}

// --------------------------------------------------------------------------
// 视觉退出闭合
//
// CSS 负责逐行裁剪；只有一个段的最后一行也完全越过视口顶部时，才把该段
// 作为有序前缀永久淘汰。回报只含会话/段身份，正文与屏幕几何都不出 renderer。
// --------------------------------------------------------------------------
const CLIP_EPSILON_PX = 0.5
let viewportEvictionQueued = false

function fullyClippedThroughSegmentId () {
  const flow = selectFlow(state)
  const nodes = captionFlow.children
  if (flow.length < 2 || nodes.length !== flow.length) return null
  const viewportTop = captionFlow.getBoundingClientRect().top
  if (!Number.isFinite(viewportTop)) return null

  let throughSegmentId = null
  /* 只接受连续旧前缀；一旦遇到仍有任一部分可见的段就停止。 */
  for (let index = 0; index < flow.length - 1; index += 1) {
    const bottom = nodes[index].getBoundingClientRect().bottom
    if (!Number.isFinite(bottom) || bottom > viewportTop + CLIP_EPSILON_PX) break
    throughSegmentId = flow[index].segmentId
  }
  return throughSegmentId
}

function retireFullyClippedPrefix () {
  const throughSegmentId = fullyClippedThroughSegmentId()
  const sessionId = state.sessionId
  if (!throughSegmentId || typeof sessionId !== 'string' ||
      !evictCaptionPrefix(state, throughSegmentId)) return false

  /* 删除的节点原本全在 overflow 顶部之外；重排后可见像素不应跳动。 */
  render(false)
  try {
    Promise.resolve(bridge.reportCaptionViewportEviction({
      schemaVersion: 1,
      sessionId,
      throughSegmentId
    })).catch(() => {})
  } catch { /* 主进程关闭或 browser preview：本地墓碑仍然生效 */ }
  return true
}

function queueViewportEviction () {
  if (viewportEvictionQueued) return
  viewportEvictionQueued = true
  requestAnimationFrame(() => {
    if (!viewportEvictionQueued) return
    viewportEvictionQueued = false
    retireFullyClippedPrefix()
  })
}

/* 在任何正文/版本替换之前先结算上一帧已经发生的视觉退出，避免同一帧紧随
   其后的短精修稿把刚离场的旧段重新拉回可见区域。 */
function flushViewportEviction () {
  if (!viewportEvictionQueued) return false
  viewportEvictionQueued = false
  return retireFullyClippedPrefix()
}

/** 只播报定稿。partial 每秒刷新十几次，逐帧播报会让屏幕阅读器无法使用。 @param {string} text */
function announce (text: string): void {
  liveRegion.textContent = text
}

/** @param {any} event */
function ingest (event: any): void {
  flushViewportEviction()
  const displaySuppressed = state.sessionId === event.sessionId &&
    isCaptionSegmentEvicted(state, event.segmentId)
  state = applyEvent(state, event)
  render(true, event.segmentId)
  if (!displaySuppressed && event.kind !== 'partial') announce(event.text)
}

/* Bootstrap 恢复：先订阅（此间事件全部缓冲），再读取主进程 canonical
   CaptionState 水合，最后把缓冲的事件重放进 reducer —— 已折叠进状态的
   事件会被单调判定丢弃，晚到的照常应用，两条路径必然收敛。
   重放不做无障碍播报：那是恢复历史，不是新说的话。 */
let bootstrapped = false
let canonicalRevision = 0
let bufferedCaptionInputs: Array<{type: 'event' | 'state', value: any}> = []

/** @param {any} event */
function onCaptionEvent (event: any): void {
  if (!bootstrapped) {
    bufferedCaptionInputs.push({ type: 'event', value: event })
    return
  }
  ingest(event)
}

/** @param {any} canonical */
function replaceCaptionState (canonical: any): void {
  flushViewportEviction()
  if (!canonical || !Number.isSafeInteger(canonical.revision) ||
      canonical.revision <= canonicalRevision) return
  state = hydrateState(canonical, state)
  canonicalRevision = canonical.revision
  render()
}

/** @param {any} canonical */
function onCaptionState (canonical: any): void {
  if (!bootstrapped) {
    bufferedCaptionInputs.push({ type: 'state', value: canonical })
    return
  }
  replaceCaptionState(canonical)
}

async function initCaptions () {
  try {
    const canonical = await bridge.getCaptionState()
    state = hydrateState(canonical)
    canonicalRevision = Number.isSafeInteger(canonical?.revision) ? canonical.revision : 0
  } catch { /* browser preview：保持空状态 */ }
  render()
  flushViewportEviction()
  bootstrapped = true
  const replay = bufferedCaptionInputs
  bufferedCaptionInputs = []
  for (const input of replay) {
    if (input.type === 'state') replaceCaptionState(input.value)
    else {
      flushViewportEviction()
      state = applyEvent(state, input.value)
      render()
    }
  }
  render()
}

/* 用户手动拉伸窗口、DPI 或主题字体变化时重算视口能放几行。
   反向不成立：字幕内容再长也不会改变窗口 bounds（SEM-F20）。 */
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(applyViewport).observe(captions)
}

// --------------------------------------------------------------------------
// 配置
// --------------------------------------------------------------------------
/** @param {any} c */
function applyConfig (c: any): void {
  applyAppearance(document.documentElement, c)
  /* 字号变化不改变 .captions 的高度，ResizeObserver 不会触发，必须显式重算。 */
  applyViewport()
  render()
}
async function initConfig () {
  try { applyConfig(await bridge.getConfig()) } catch { applyViewport(); render() }
  bridge.onConfig(applyConfig)
}
initConfig()
initLock()

// CaptionEvent 的唯一来源是主进程 SessionCoordinator。B1 的 fake adapter 与
// B2 的真实 worker 都走同一通道，renderer 不再自造“看起来成功”的字幕。
// 订阅必须先于 getCaptionState，否则两者之间到达的事件会永久丢失。
bridge.onCaption(onCaptionEvent)
bridge.onCaptionState(onCaptionState)
initCaptions()

})()

export {}
