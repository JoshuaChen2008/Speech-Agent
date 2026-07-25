'use strict'

// @ts-check

/* 工具条窗：命中测试 + 拖动（role=toolbar）+ 从 RuntimeSnapshot 渲染 + 发出用户意图。
   --------------------------------------------------------------------------
   本文件不做状态判断。「这个 phase 该显示什么、哪个按钮该亮」全部在
   ../ui/shared/runtime-view.js 里；这里只负责把视图模型落成 DOM，
   并把点击交给 shell。文件里不允许出现按 phase 分支的逻辑。 */

const { installSprite, iconMarkup } = window.Icons
const { buildRuntimeView } = window.RuntimeView

/* 壳层 API。缺失时降级成空操作：既让本页能在纯浏览器里做视觉核对，
   也让 preload 万一没挂上时工具条仍然渲染得出来，而不是留一个空白窗难以排查。
   ⚠ 不能叫 shell —— preload 的 contextBridge 已经占了这个全局名，
   顶层 const 同名会直接 SyntaxError，整个 renderer 白屏。 */
const bridge = window.shell || {
  mouseThrough () {}, dragStart () {}, dragEnd () {},
  recToggle () {}, lockToggle () {}, action () {},
  onRec () {}, onLock () {}, onConfig () {},
  getConfig () { return Promise.reject(new Error('no shell')) }
}

const wrap = document.getElementById('wrap')
const toolbar = document.getElementById('toolbar')
const statusHost = document.getElementById('status')
const commandHost = document.getElementById('commands')
const windowControlHost = document.getElementById('windowControls')

let locked = false
let recording = false
let dragging = false
let ignoring = null
let lastX = 0, lastY = 0

installSprite(document)

// ---------------------------------------------------------------------------
// 运行状态来源
//
// 骨架阶段壳层还没有 SessionCoordinator，只有一个 rec 布尔，产不出 RuntimeSnapshot。
// 这里退而用契约样例驱动渲染，并在条上打「演示」标记 —— 不能让这些
// “监听中 / 模型就绪”被当成真的（docs/subtitle-window.md §8）。
//
// B1 落地后：把 currentSnapshot() 换成 shell 推来的真快照，删掉 IS_DEMO，
// 本文件其余部分不用动。
// ---------------------------------------------------------------------------
const DEMO_SNAPSHOTS = window.FIXTURES.runtime
const IS_DEMO = true

function currentSnapshot () {
  return recording ? DEMO_SNAPSHOTS.listening : DEMO_SNAPSHOTS.idle
}

/** 骨架阶段壳层真正能执行的意图。其余一律禁用并说明，不做无声失败的按钮。 */
const SUPPORTED = {
  start: () => bridge.recToggle(),
  pause: () => bridge.recToggle(),
  resume: () => bridge.recToggle(),
  'open-settings': () => bridge.action('settings'),
  lock: () => bridge.lockToggle(),
  settings: () => bridge.action('settings'),
  close: () => bridge.action('close')
}
const UNSUPPORTED_REASON = '骨架阶段尚未接入，B1 之后可用'

// ---------------------------------------------------------------------------
// DOM 小工具
// ---------------------------------------------------------------------------
function el (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function iconEl (name, extraClass) {
  const holder = el('span')
  holder.innerHTML = iconMarkup(name)
  const svg = holder.firstChild
  if (extraClass) svg.classList.add(extraClass)
  return svg
}

/**
 * 造一个命令按钮。
 * 禁用有两种来源，都必须说明白：
 *   - 运行时能力不允许（reason 来自 capabilities.limitations / lastError）
 *   - 骨架阶段壳层没接（UNSUPPORTED_REASON）
 */
function commandButton (spec, extraClass) {
  const button = el('button', 'act' + (extraClass ? ' ' + extraClass : ''))
  button.dataset.act = spec.act
  button.appendChild(iconEl(spec.icon))
  if (spec.label && spec.showLabel) button.appendChild(el('span', null, spec.label))

  const supported = !!SUPPORTED[spec.act]
  const disabled = spec.disabled || !supported
  const reason = spec.disabled ? spec.reason : (supported ? null : UNSUPPORTED_REASON)

  button.disabled = disabled
  button.setAttribute('aria-label', reason ? spec.ariaLabel + '（' + reason + '）' : spec.ariaLabel)
  button.title = reason || spec.label || spec.ariaLabel
  return button
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------
/** 过渡态才转圈；listening 是可能持续两小时的稳态，不给无限动画。 */
const SPIN = { spinner: 'cw', recover: 'ccw' }

function renderStatus (view) {
  statusHost.textContent = ''
  statusHost.dataset.tone = view.status.tone

  const icon = iconEl(view.status.icon, 'status-icon')
  if (SPIN[view.status.icon]) icon.dataset.spin = SPIN[view.status.icon]
  statusHost.appendChild(icon)

  const text = el('div', 'status-text')
  text.appendChild(el('span', 'status-label', view.status.label))
  text.appendChild(el('span', 'status-detail', view.status.detail))
  statusHost.appendChild(text)

  if (IS_DEMO) {
    const tag = el('span', 'demo-tag', '演示')
    tag.title = '骨架阶段：运行状态取自契约样例，尚未接入真实音频与识别'
    statusHost.appendChild(tag)
  }
}

function renderCommands (view) {
  commandHost.textContent = ''

  commandHost.appendChild(commandButton(view.primary))
  view.secondary.forEach((action) => commandHost.appendChild(commandButton(action)))

  if (view.nextAction) {
    const cta = commandButton({
      act: view.nextAction.action,
      icon: view.nextAction.icon,
      label: view.nextAction.label,
      /* 412px 宽度方案下文字降级成 tooltip，只留带色块的图标 */
      showLabel: false,
      ariaLabel: view.nextAction.label + '：' + view.nextAction.message,
      disabled: false,
      reason: null
    }, 'act-cta')
    cta.dataset.tone = view.status.tone
    commandHost.appendChild(cta)
  }
}

const WINDOW_CONTROLS = [
  { act: 'history', icon: 'history', label: '历史记录' },
  { act: 'lock', icon: 'unlock', label: '锁定字幕', toggle: true },
  { act: 'settings', icon: 'settings', label: '设置' },
  { act: 'close', icon: 'close', label: '退出', danger: true }
]

function renderWindowControls () {
  windowControlHost.textContent = ''
  for (const item of WINDOW_CONTROLS) {
    const button = commandButton({
      act: item.act,
      /* 锁定是唯一名称稳定的真 toggle，形状随状态换，aria-pressed 也只给它 */
      icon: item.act === 'lock' ? (locked ? 'lock' : 'unlock') : item.icon,
      label: item.label,
      showLabel: false,
      ariaLabel: item.label,
      disabled: false,
      reason: null
    }, item.danger ? 'act-danger' : null)
    if (item.toggle) button.setAttribute('aria-pressed', String(locked))
    windowControlHost.appendChild(button)
  }
}

function render () {
  const view = buildRuntimeView(currentSnapshot())
  renderStatus(view)
  renderCommands(view)
  renderWindowControls()
  /* idle 之外的一切状态都值得被看见：会话在跑、或者有事要处理 */
  wrap.dataset.live = view.phase === 'idle' ? 'off' : 'on'
}

// ---------------------------------------------------------------------------
// 命中测试：指针在条上 → 实心；否则穿透（窗口比条宽，右对齐留出的空白全部放行）
// ---------------------------------------------------------------------------
function applyHit (x, y) {
  if (dragging) return
  const hit = document.elementFromPoint(x, y)
  const solid = !!(hit && hit.closest('.toolbar'))
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
  requestAnimationFrame(() => { hitQueued = false; applyHit(lastX, lastY) })
})
bridge.mouseThrough(true)
ignoring = true

// ---------------------------------------------------------------------------
// 拖动：未锁定 → 拖整个单元（主进程改移字幕窗并停靠）；已锁定 → 拖工具条自身
// ---------------------------------------------------------------------------
toolbar.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('.act')) return
  dragging = true
  toolbar.classList.add('dragging')
  bridge.dragStart('toolbar')
  try { toolbar.setPointerCapture(e.pointerId) } catch { /* noop */ }
})
function endDrag () {
  if (!dragging) return
  dragging = false
  toolbar.classList.remove('dragging')
  bridge.dragEnd()
  applyHit(lastX, lastY)
}
window.addEventListener('pointerup', endDrag)
window.addEventListener('blur', endDrag)

// ---------------------------------------------------------------------------
// 用户意图：只转交，不预判成功。壳层回执到位后（B1 的 CommandResult）
// 才更新状态，这里不做乐观更新。
// ---------------------------------------------------------------------------
toolbar.addEventListener('click', (e) => {
  const button = e.target.closest('.act')
  if (!button || button.disabled) return
  const run = SUPPORTED[button.dataset.act]
  if (run) run()
})

// ---------------------------------------------------------------------------
// 状态同步
// ---------------------------------------------------------------------------
bridge.onRec((on) => { recording = on; render() })
bridge.onLock((on) => {
  locked = on
  wrap.dataset.locked = on ? 'on' : 'off'
  render()
})

function applyConfig (c) {
  document.documentElement.dataset.theme =
    c.theme === 'auto' ? (c.systemDark ? 'dark' : 'light') : c.theme
}
async function initConfig () {
  try { applyConfig(await bridge.getConfig()) } catch { /* noop */ }
  bridge.onConfig(applyConfig)
}

render()
initConfig()
