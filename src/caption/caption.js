'use strict'

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

const wrap = document.getElementById('wrap')
const card = document.getElementById('captionCard')
const captions = document.getElementById('captions')
const captionFlow = document.getElementById('captionFlow')
const liveRegion = document.getElementById('liveRegion')

/* 壳层 API。在纯浏览器里打开本页做视觉核对时不存在，降级成空操作，
   这样排版问题可以脱离 Electron 排查。
   ⚠ 不能叫 shell —— preload 的 contextBridge 已经占了这个全局名，
   顶层 const 同名会直接 SyntaxError，整个 renderer 白屏。 */
const bridge = window.shell || {
  mouseThrough () {}, dragStart () {}, dragEnd () {},
  resizeStart () {}, resizeEnd () {},
  onLock () {}, onToolbarOverlap () {}, onConfig () {}, onCaption () {}, onCaptionState () {},
  reportCaptionViewportEviction () { return Promise.resolve(false) },
  getLock () { return Promise.reject(new Error('no shell')) },
  getConfig () { return Promise.reject(new Error('no shell')) },
  getCaptionState () { return Promise.reject(new Error('no shell')) }
}

let locked = false
let dragging = false
let resizing = false
let ignoring = null
let lastX = 0, lastY = 0
let toolbarOverlapGeneration = 0

// --------------------------------------------------------------------------
// 边缘拉伸
// 卡片内侧 8px 是拉伸带，其余是拖动区。锁定后整窗恒穿透，两者都不生效。
// --------------------------------------------------------------------------
const EDGE = 8
const RESIZE_CURSOR = {
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize'
}

/** 指针落在卡片哪条边上；不在拉伸带内返回空串。 */
function edgeAt (x, y) {
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
// 命中测试：指针在卡片上 → 实心；否则穿透。锁定态由主进程恒穿透，这里不干预。
// --------------------------------------------------------------------------
function applyHit (x, y) {
  if (dragging || resizing || locked) return
  const el = document.elementFromPoint(x, y)
  // 工具条“洞”内放行穿透，让工具条窗接管；洞外的卡片才算实心。
  // 但拉伸带优先于洞 —— 否则洞盖住的右上角就再也拉不动了。
  // 洞是从卡片右上角起算的一大片，而工具条实际停靠时内缩 12px，
  // 所以 8px 的拉伸带落在工具条按钮之外，两者不会抢事件。
  const overHole = !!(el && el.closest('.tb-hole'))
  const onEdge = edgeAt(x, y) !== ''
  const solid = (onEdge || !overHole) && !!(el && el.closest('.caption-card'))
  const next = !solid
  if (next !== ignoring) {
    ignoring = next
    bridge.mouseThrough(next)
  }
}

let hitQueued = false
document.addEventListener('mousemove', (e) => {
  lastX = e.clientX; lastY = e.clientY
  if (hitQueued) return
  hitQueued = true
  requestAnimationFrame(() => {
    hitQueued = false
    applyHit(lastX, lastY)
    if (!dragging && !resizing) {
      const edge = edgeAt(lastX, lastY)
      card.style.cursor = edge ? RESIZE_CURSOR[edge] : ''
    }
  })
})

bridge.mouseThrough(true)
ignoring = true

function acceptToolbarOverlap (payload) {
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
  if (e.button !== 0 || locked) return
  const edge = edgeAt(e.clientX, e.clientY)
  if (edge) {
    resizing = true
    bridge.resizeStart(edge)
  } else {
    dragging = true
    card.classList.add('dragging')
    bridge.dragStart('caption')
  }
  try { card.setPointerCapture(e.pointerId) } catch { /* noop */ }
})

/* pointerup / pointercancel / lostpointercapture / blur 全都要收尾 ——
   主进程那边是 8ms 定时器，漏掉任何一条取消路径都会让窗口继续跟着光标跑。 */
function endGesture () {
  if (resizing) {
    resizing = false
    bridge.resizeEnd()
  }
  if (dragging) {
    dragging = false
    card.classList.remove('dragging')
    bridge.dragEnd()
  }
  card.style.cursor = ''
  applyHit(lastX, lastY)
}
window.addEventListener('pointerup', endGesture)
window.addEventListener('pointercancel', endGesture)
card.addEventListener('lostpointercapture', endGesture)
window.addEventListener('blur', endGesture)

// --------------------------------------------------------------------------
// 锁定：主进程已把本窗设为恒穿透；这里只更新视觉
// --------------------------------------------------------------------------
let lockRevision = 0

function applyLockState (on) {
  locked = !!on
  wrap.dataset.locked = locked ? 'on' : 'off'
  if (!locked) { ignoring = null; applyHit(lastX, lastY) }
}

async function initLock () {
  bridge.onLock((on) => {
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
function cssNumber (styles, name) {
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

/** 按需增删节点、只改 textContent；不为一次 partial 刷新重建整棵子树。 */
function render (scheduleEviction = true) {
  const flow = selectFlow(state)
  const nodes = captionFlow.children

  while (nodes.length > flow.length) captionFlow.removeChild(captionFlow.lastChild)
  while (nodes.length < flow.length) {
    const node = document.createElement('p')
    node.className = 'seg'
    captionFlow.appendChild(node)
  }

  for (let i = 0; i < flow.length; i += 1) {
    const node = nodes[i]
    const item = flow[i]
    if (node.textContent !== item.text) node.textContent = item.text
    node.classList.toggle('partial', item.isPartial)
    /* 最后一个是最新段；它永远贴在底部，裁剪只发生在它上方。 */
    node.classList.toggle('older', i < flow.length - 1)
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

/** 只播报定稿。partial 每秒刷新十几次，逐帧播报会让屏幕阅读器无法使用。 */
function announce (text) {
  liveRegion.textContent = text
}

function ingest (event) {
  flushViewportEviction()
  const displaySuppressed = state.sessionId === event.sessionId &&
    isCaptionSegmentEvicted(state, event.segmentId)
  state = applyEvent(state, event)
  render()
  if (!displaySuppressed && event.kind !== 'partial') announce(event.text)
}

/* Bootstrap 恢复：先订阅（此间事件全部缓冲），再读取主进程 canonical
   CaptionState 水合，最后把缓冲的事件重放进 reducer —— 已折叠进状态的
   事件会被单调判定丢弃，晚到的照常应用，两条路径必然收敛。
   重放不做无障碍播报：那是恢复历史，不是新说的话。 */
let bootstrapped = false
let canonicalRevision = 0
let bufferedCaptionInputs = []

function onCaptionEvent (event) {
  if (!bootstrapped) {
    bufferedCaptionInputs.push({ type: 'event', value: event })
    return
  }
  ingest(event)
}

function replaceCaptionState (canonical) {
  flushViewportEviction()
  if (!canonical || !Number.isSafeInteger(canonical.revision) ||
      canonical.revision <= canonicalRevision) return
  state = hydrateState(canonical, state)
  canonicalRevision = canonical.revision
  render()
}

function onCaptionState (canonical) {
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
function applyConfig (c) {
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
