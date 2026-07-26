'use strict'

// @ts-check

/* 字幕窗：命中测试 + 拖动（role=caption）+ 锁定穿透 + 配置应用 + CaptionEvent 渲染。
   状态归并和行数预算都在 ../ui/shared/caption-reducer.js，本文件只做 DOM 落地。 */

const { createState, hydrateState, applyEvent, selectLines, computeLineBudget } = window.CaptionReducer
const { applyAppearance } = window.Appearance

const wrap = document.getElementById('wrap')
const card = document.getElementById('captionCard')
const captions = document.getElementById('captions')
const linePrev = document.getElementById('linePrev')
const lineCurrent = document.getElementById('lineCurrent')
const lineTranslation = document.getElementById('lineTranslation')
const liveRegion = document.getElementById('liveRegion')

/* 壳层 API。在纯浏览器里打开本页做视觉核对时不存在，降级成空操作，
   这样排版问题可以脱离 Electron 排查。
   ⚠ 不能叫 shell —— preload 的 contextBridge 已经占了这个全局名，
   顶层 const 同名会直接 SyntaxError，整个 renderer 白屏。 */
const bridge = window.shell || {
  mouseThrough () {}, dragStart () {}, dragEnd () {},
  resizeStart () {}, resizeEnd () {},
  onLock () {}, onConfig () {}, onCaption () {},
  getLock () { return Promise.reject(new Error('no shell')) },
  getConfig () { return Promise.reject(new Error('no shell')) },
  getCaptionState () { return Promise.reject(new Error('no shell')) }
}

let locked = false
let dragging = false
let resizing = false
let ignoring = null
let lastX = 0, lastY = 0

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

/** 字幕状态与影响排版的配置。默认值与 src/config.js 的 DEFAULTS 对齐。 */
let state = createState()
let cfg = { bilingual: true, maxLines: 4 }

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
// 渲染：固定槽位 + 总高度预算
// --------------------------------------------------------------------------
function cssNumber (styles, name) {
  return parseFloat(styles.getPropertyValue(name))
}

/** 只改 textContent 与 --n，永不重建节点。 */
function applySlot (node, text, lines) {
  const show = lines > 0 && !!text
  node.hidden = !show
  if (!show) return
  node.style.setProperty('--n', String(lines))
  if (node.textContent !== text) node.textContent = text
}

function render () {
  const lines = selectLines(state, { bilingual: cfg.bilingual })
  const styles = getComputedStyle(document.documentElement)

  const plan = computeLineBudget({
    /* 可用高度直接量 DOM，不复制一份 110 常量到 JS —— 卡片内边距改了这里自动跟上 */
    available: captions.clientHeight,
    fontSize: cssNumber(styles, '--fs'),
    lineHeight: cssNumber(styles, '--lh-caption'),
    prevRatio: cssNumber(styles, '--fs-caption-ratio-prev'),
    gap: cssNumber(styles, '--line-gap'),
    hasPrevious: !!lines.previous,
    hasTranslation: !!lines.translation,
    maxCurrentLines: cfg.maxLines
  })

  applySlot(linePrev, lines.previous, plan.previous)
  applySlot(lineCurrent, lines.current, plan.current)
  applySlot(lineTranslation, lines.translation, plan.translation)
  lineCurrent.classList.toggle('partial', lines.isPartial)
}

/** 只播报定稿。partial 每秒刷新十几次，逐帧播报会让屏幕阅读器无法使用。 */
function announce (text, translation) {
  liveRegion.textContent = translation ? text + '。' + translation : text
}

function ingest (event) {
  state = applyEvent(state, event)
  render()
  if (event.kind !== 'partial') {
    announce(event.text, cfg.bilingual && event.translation ? event.translation.text : null)
  }
}

/* Bootstrap 恢复：先订阅（此间事件全部缓冲），再读取主进程 canonical
   CaptionState 水合，最后把缓冲的事件重放进 reducer —— 已折叠进状态的
   事件会被单调判定丢弃，晚到的照常应用，两条路径必然收敛。
   重放不做无障碍播报：那是恢复历史，不是新说的话。 */
let bootstrapped = false
let bufferedEvents = []

function onCaptionEvent (event) {
  if (!bootstrapped) {
    bufferedEvents.push(event)
    return
  }
  ingest(event)
}

async function initCaptions () {
  try {
    state = hydrateState(await bridge.getCaptionState())
  } catch { /* browser preview：保持空状态 */ }
  bootstrapped = true
  const replay = bufferedEvents
  bufferedEvents = []
  for (const event of replay) state = applyEvent(state, event)
  render()
}

/* 卡片尺寸随 DPI / 主题字体变化时重算预算 */
if (typeof ResizeObserver === 'function') {
  new ResizeObserver(render).observe(captions)
}

// --------------------------------------------------------------------------
// 配置
// --------------------------------------------------------------------------
function applyConfig (c) {
  applyAppearance(document.documentElement, c)
  cfg = { bilingual: !!c.bilingual, maxLines: c.maxLines }
  render()
}
async function initConfig () {
  try { applyConfig(await bridge.getConfig()) } catch { render() }
  bridge.onConfig(applyConfig)
}
initConfig()
initLock()

// CaptionEvent 的唯一来源是主进程 SessionCoordinator。B1 的 fake adapter 与
// B2 的真实 worker 都走同一通道，renderer 不再自造“看起来成功”的字幕。
// 订阅必须先于 getCaptionState，否则两者之间到达的事件会永久丢失。
bridge.onCaption(onCaptionEvent)
initCaptions()
