'use strict'

// @ts-check

/* 工具条窗：命中测试 + 拖动（role=toolbar）+ 从 RuntimeSnapshot 渲染 + 发出用户意图。
   --------------------------------------------------------------------------
   本文件不做状态判断。「这个 phase 该显示什么、哪个按钮该亮」全部在
   ../ui/shared/runtime-view.js 里；这里只负责把视图模型落成 DOM，
   并把点击交给 shell。文件里不允许出现按 phase 分支的逻辑。 */

const { installSprite, iconMarkup } = window.Icons
const { buildRuntimeView } = window.RuntimeView
const { applyAppearance } = window.Appearance

/* 壳层 API。缺失时降级成空操作：既让本页能在纯浏览器里做视觉核对，
   也让 preload 万一没挂上时工具条仍然渲染得出来，而不是留一个空白窗难以排查。
   ⚠ 不能叫 shell —— preload 的 contextBridge 已经占了这个全局名，
   顶层 const 同名会直接 SyntaxError，整个 renderer 白屏。 */
const bridge = window.shell || {
  mouseThrough () {}, dragStart () {}, dragEnd () {},
  lockToggle () {}, action () {},
  onLock () {}, onConfig () {}, onSnapshot () {},
  command () { return Promise.reject(new Error('no shell')) },
  getLock () { return Promise.reject(new Error('no shell')) },
  getConfig () { return Promise.reject(new Error('no shell')) },
  getSnapshot () { return Promise.reject(new Error('no shell')) }
}

const wrap = document.getElementById('wrap')
const toolbar = document.getElementById('toolbar')
const grip = document.getElementById('grip')
const statusHost = document.getElementById('status')
const commandHost = document.getElementById('commands')
const windowControlHost = document.getElementById('windowControls')

let locked = false
let dragging = false
let ignoring = null
let lastX = 0, lastY = 0
let snapshot = window.FIXTURES.runtime.unavailable
let commandPending = false
let commandFailure = null

installSprite(document)
grip.innerHTML = iconMarkup('grip')

// ---------------------------------------------------------------------------
// 运行状态来源
//
// 订阅先于 get，随后用 revision 去重，避免 renderer reload 时的 get/on 竞态。
// ---------------------------------------------------------------------------
function currentSnapshot () {
  return snapshot
}

async function runCommand (name) {
  if (commandPending) return
  commandPending = true
  commandFailure = null
  render()
  try {
    const result = await bridge.command(name)
    if (!result.ok) commandFailure = result
  } catch {
    commandFailure = { message: '命令未送达' }
  } finally {
    commandPending = false
    render()
  }
}

const SUPPORTED = {
  start: () => runCommand('start'),
  pause: () => runCommand('pause'),
  resume: () => runCommand('resume'),
  stop: () => runCommand('stop'),
  retry: () => runCommand('retry'),
  'open-settings': () => bridge.action('settings'),
  history: () => bridge.action('history'),
  lock: () => bridge.lockToggle(),
  settings: () => bridge.action('settings'),
  close: () => bridge.action('close')
}
const UNSUPPORTED_REASON = '功能尚未接入'

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
  const runtimeCommand = ['start', 'pause', 'resume', 'stop', 'retry'].includes(spec.act)
  const disabled = spec.disabled || !supported || (runtimeCommand && commandPending)
  const reason = commandPending && runtimeCommand
    ? '命令处理中'
    : (spec.disabled ? spec.reason : (supported ? null : UNSUPPORTED_REASON))

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

/**
 * 状态区。
 * quiet 只渲染图标 —— 形状加色调足够区分状态，条保持极简，少遮字幕。
 * attention 才带出一行说明，因为 unavailable / recovering / error 的信息量
 * 压不进一个图标。文字取自后端，不在这里编。
 *
 * 图标是装饰性的（aria-hidden），语义全部挂在 .status 的 aria-label 上，
 * 所以 quiet 模式下屏幕阅读器读到的信息没有任何缩水。
 */
function renderStatus (view) {
  statusHost.textContent = ''
  statusHost.dataset.tone = view.status.tone
  statusHost.dataset.emphasis = view.status.emphasis
  statusHost.setAttribute('aria-label', view.status.ariaLabel)

  const icon = iconEl(view.status.icon, 'status-icon')
  if (SPIN[view.status.icon]) icon.dataset.spin = SPIN[view.status.icon]
  statusHost.appendChild(icon)

  const message = el('span', 'status-message',
    view.status.emphasis === 'attention' ? view.status.message : '')
  message.title = view.status.ariaLabel
  statusHost.appendChild(message)

  if (commandFailure) {
    const message = statusHost.querySelector('.status-message')
    message.textContent = commandFailure.message
    message.title = commandFailure.message
    statusHost.dataset.tone = 'danger'
    statusHost.dataset.emphasis = 'attention'
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
      /* 文字降级成 tooltip，只留带 tone 底色的图标 —— 它仍是一排中性图标键里
         唯一带色块的那个，不至于沉没 */
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
  /* 需要用户介入时条不允许隐身（带着说明和下一步出口，必须看得见） */
  wrap.dataset.attention = (commandFailure || view.status.emphasis === 'attention') ? 'on' : 'off'
  toolbar.setAttribute('aria-busy', String(commandPending))
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
window.addEventListener('pointercancel', endDrag)
toolbar.addEventListener('lostpointercapture', endDrag)
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
let lockRevision = 0

function applyLockState (on) {
  locked = !!on
  wrap.dataset.locked = locked ? 'on' : 'off'
  render()
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

function acceptSnapshot (next) {
  if (!next || typeof next.revision !== 'number') return
  if (snapshot && next.revision < snapshot.revision) return
  snapshot = next
  commandFailure = null
  render()
}

async function initRuntime () {
  bridge.onSnapshot(acceptSnapshot)
  try { acceptSnapshot(await bridge.getSnapshot()) } catch { /* browser preview */ }
}

function applyConfig (c) {
  applyAppearance(document.documentElement, c)
}
async function initConfig () {
  try { applyConfig(await bridge.getConfig()) } catch { /* noop */ }
  bridge.onConfig(applyConfig)
}

render()
initLock()
initConfig()
initRuntime()
