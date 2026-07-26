'use strict'

// @ts-check

/* 字幕窗：命中测试 + 拖动（role=caption）+ 锁定穿透 + 配置应用 + CaptionEvent 渲染。
   状态归并和行数预算都在 ../ui/shared/caption-reducer.js，本文件只做 DOM 落地。 */

const { createState, applyEvent, selectLines, computeLineBudget } = window.CaptionReducer
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
  onLock () {}, onRec () {}, onConfig () {},
  getConfig () { return Promise.reject(new Error('no shell')) }
}

let locked = false
let recording = false
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
bridge.onLock((on) => {
  locked = on
  wrap.dataset.locked = on ? 'on' : 'off'
  if (!on) { ignoring = null; applyHit(lastX, lastY) }
})

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

// --------------------------------------------------------------------------
// 假字幕流 —— 产出真正形状的 CaptionEvent，好让 reducer 和预算跑在真链路上。
// B2 接入真 ASR 时只需换掉事件来源，render / reducer 不动。
// --------------------------------------------------------------------------
const SCRIPT = [
  { text: '欢迎使用 Live Subtitle Agent 实时字幕', tr: 'Welcome to Live Subtitle Agent.' },
  { text: '我们下周先对齐一下 roadmap，再排 A/B test。', tr: "Let's align on the roadmap next week, then schedule the A/B test." },
  { text: 'The onboarding drop-off is mostly on step three.', tr: '新用户流失主要发生在第三步。' },
  { text: '新用户流失主要集中在第三步，需要拉转化漏斗数据。', tr: 'Most churn happens at step three; we need funnel data.' },
  { text: 'Can we ship a shorter version this sprint?', tr: '这个 sprint 能先发一个精简版吗？' },
  { text: '好，我先同步给设计，明天给结论。', tr: "I'll sync with design and come back tomorrow." }
]

const FAKE_SESSION = 'preview-session'
let scriptIndex = 0
let segmentIndex = 0
let sequence = 0
let elapsed = 0
let charTimer = null
let lineTimer = null

function emit (kind, revision, text, translation) {
  sequence += 1
  ingest({
    schemaVersion: 1,
    sessionId: FAKE_SESSION,
    sourceId: 'loopback',
    segmentId: 'segment-' + segmentIndex,
    sequence,
    revision,
    kind,
    t0: elapsed,
    t1: elapsed + 2.4,
    text,
    translation: translation
      ? { language: 'en', text: translation, basedOnRevision: revision - 1 }
      : null
  })
}

function typeLine (entry, done) {
  let n = 0
  let revision = 0
  clearInterval(charTimer)
  charTimer = setInterval(() => {
    n += 1
    revision += 1
    emit('partial', revision, entry.text.slice(0, n))
    if (n >= entry.text.length) {
      clearInterval(charTimer)
      emit('final', revision + 1, entry.text)
      /* 译文晚到：验证它不会把已定稿的正文回滚 */
      lineTimer = setTimeout(() => {
        emit('translated', revision + 2, entry.text, entry.tr)
        lineTimer = setTimeout(done, 700)
      }, 400)
    }
  }, 55)
}

function nextLine () {
  const entry = SCRIPT[scriptIndex % SCRIPT.length]
  scriptIndex += 1
  segmentIndex += 1
  elapsed += 3.1
  typeLine(entry, () => { if (recording) nextLine() })
}

function startFakeStream () { stopFakeStream(); nextLine() }
function stopFakeStream () {
  clearInterval(charTimer)
  clearTimeout(lineTimer)
  charTimer = lineTimer = null
}

bridge.onRec((on) => {
  recording = on
  if (on) startFakeStream()
  else stopFakeStream()
})
