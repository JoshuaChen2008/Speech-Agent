'use strict'

;(function toolbarRenderer () {

// @ts-check

/* 工具条窗：命中测试 + 拖动（role=toolbar）+ 从 RuntimeSnapshot 渲染 + 发出用户意图。
   --------------------------------------------------------------------------
   本文件不做状态判断。「这个 phase 该显示什么、哪个按钮该亮」全部在
   ../ui/shared/runtime-view.js 里；这里只负责把视图模型落成 DOM，
   并把点击交给 shell。文件里不允许出现按 phase 分支的逻辑。 */

const { installSprite, iconMarkup } = window.Icons
const { buildRuntimeView } = window.RuntimeView
const { applyAppearance } = window.Appearance
const bindManualWindowDrag = window.ManualWindowDrag?.bindManualWindowDrag || (() => ({
  cancel () {},
  end () {},
  isDragging () { return false }
}))

/* 壳层 API。缺失时降级成空操作：既让本页能在纯浏览器里做视觉核对，
   也让 preload 万一没挂上时工具条仍然渲染得出来，而不是留一个空白窗难以排查。
   ⚠ 不能叫 shell —— preload 的 contextBridge 已经占了这个全局名，
   顶层 const 同名会直接 SyntaxError，整个 renderer 白屏。 */
const bridge: any = window.shell || {
  mouseThrough () {}, dragStart () {}, dragEnd () {},
  lockToggle () {}, action () {},
  onInteractionSync () {}, onLock () {}, onConfig () {}, onSnapshot () {}, onRefinementNotice () {},
  getToolbarLayoutContext () { return Promise.reject(new Error('no shell')) },
  reportToolbarLayout () {},
  command () { return Promise.reject(new Error('no shell')) },
  getLock () { return Promise.reject(new Error('no shell')) },
  getConfig () { return Promise.reject(new Error('no shell')) },
  getSnapshot () { return Promise.reject(new Error('no shell')) },
  getRefinementNotice () { return Promise.reject(new Error('no shell')) }
}

function requireElement (id: string): HTMLElement {
  const element = document.getElementById(id)
  if (!element) throw new Error(`toolbar renderer element is missing: ${id}`)
  return element
}

const wrap = requireElement('wrap')
const toolbar = requireElement('toolbar')
const grip = requireElement('grip')
const statusHost = requireElement('status')
const commandHost = requireElement('commands')
const windowControlHost = requireElement('windowControls')

let locked = false
let dragging = false
let ignoring: boolean | null = null
let lastX = 0, lastY = 0
let interactionGeneration = 0
let interactionPhase = 'resume'
let snapshot = window.FIXTURES.runtime.unavailable
let runtimeSnapshotAccepted = false
let commandPending = false
let commandFailure: any | null = null
let refinementNotice: any | null = null
let toolbarLayoutGeneration = 0
let toolbarLayoutObserver: ResizeObserver | null = null
let toolbarLayoutQueued = false
let lastToolbarLayoutKey = ''
let toolbarLayoutRetryTimer: ReturnType<typeof setTimeout> | null = null

installSprite(document)
grip.innerHTML = iconMarkup('grip')

// ---------------------------------------------------------------------------
// 工具条实际轮廓：只上报现有 #toolbar.toolbar 的外接矩形。
// generation 由主进程签发；reload 前后的 renderer 不能复用旧矩形。
// ---------------------------------------------------------------------------
function queueToolbarLayoutReport (force = false) {
  if (toolbarLayoutQueued || toolbarLayoutGeneration <= 0) return
  toolbarLayoutQueued = true
  requestAnimationFrame(() => {
    toolbarLayoutQueued = false
    const rect = toolbar.getBoundingClientRect()
    const report = {
      generation: toolbarLayoutGeneration,
      rect: {
        x: Number(rect.x),
        y: Number(rect.y),
        width: Number(rect.width),
        height: Number(rect.height)
      }
    }
    const key = JSON.stringify(report)
    if (!force && key === lastToolbarLayoutKey) return
    lastToolbarLayoutKey = key
    bridge.reportToolbarLayout(report)
  })
}

async function initToolbarLayout () {
  if (typeof bridge.getToolbarLayoutContext !== 'function' ||
      typeof bridge.reportToolbarLayout !== 'function' ||
      typeof ResizeObserver !== 'function') return
  try {
    const context = await bridge.getToolbarLayoutContext()
    if (!context || !Number.isSafeInteger(context.generation) || context.generation <= 0) return
    toolbarLayoutGeneration = context.generation
    /* 观察者已在命中测试一节建好（它同时给命中矩形标脏）。generation 到位前
       queueToolbarLayoutReport 自行短路，所以这里只补一次首报。 */
    queueToolbarLayoutReport()
    // 导航/reload 后的首帧可能早于最终样式与字体布局。主进程会对该帧
    // fail closed 到 fallback；稳定后强制补报一次，不能被 renderer 去重吞掉。
    toolbarLayoutRetryTimer = setTimeout(() => queueToolbarLayoutReport(true), 100)
  } catch { /* browser preview or a navigation already invalidated this renderer */ }
}

window.addEventListener('beforeunload', () => {
  if (toolbarLayoutObserver) toolbarLayoutObserver.disconnect()
  if (toolbarLayoutRetryTimer) clearTimeout(toolbarLayoutRetryTimer)
})

// ---------------------------------------------------------------------------
// 运行状态来源
//
// 订阅先于 get，随后用 revision 去重，避免 renderer reload 时的 get/on 竞态。
// ---------------------------------------------------------------------------
function currentSnapshot () {
  return snapshot
}

/** @param {string} name */
async function runCommand (name: string): Promise<void> {
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

const SUPPORTED: Record<string, () => unknown> = {
  start: () => runCommand('start'),
  pause: () => runCommand('pause'),
  resume: () => runCommand('resume'),
  stop: () => runCommand('stop'),
  retry: () => runCommand('retry'),
  'open-settings': () => bridge.action('settings'),
  'open-model-manager': () => bridge.action('open-model-manager'),
  history: () => bridge.action('history'),
  'dismiss-refinement-notice': () => bridge.action('dismiss-refinement-notice'),
  lock: () => bridge.lockToggle(),
  settings: () => bridge.action('settings'),
  minimize: () => bridge.action('minimize'),
  close: () => bridge.action('close')
}
const UNSUPPORTED_REASON = '功能尚未接入'

// ---------------------------------------------------------------------------
// DOM 小工具
// ---------------------------------------------------------------------------
/** @param {string} tag @param {string | null=} className @param {string=} text */
function el (tag: string, className?: string | null, text?: string): HTMLElement {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

/** @param {string} name @param {string=} extraClass */
function iconEl (name: string, extraClass?: string): SVGElement {
  const holder = el('span')
  holder.innerHTML = iconMarkup(name)
  const svg = holder.firstChild as SVGElement | null
  if (!svg) throw new Error(`toolbar icon is missing: ${name}`)
  if (extraClass) svg.classList.add(extraClass)
  return svg
}

/**
 * 造一个命令按钮。
 * 禁用有两种来源，都必须说明白：
 *   - 运行时能力不允许（reason 来自 capabilities.limitations / lastError）
 *   - 骨架阶段壳层没接（UNSUPPORTED_REASON）
 */
/** @param {any} spec @param {string | null=} extraClass */
function commandButton (spec: any, extraClass?: string | null): HTMLButtonElement {
  const button = el('button', 'act' + (extraClass ? ' ' + extraClass : '')) as HTMLButtonElement
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
const SPIN: Record<string, string> = { spinner: 'cw', recover: 'ccw' }

/**
 * 状态区。
 * quiet 只渲染图标 —— 形状加色调足够区分状态，条保持极简，少遮字幕。
 * attention 才带出一行说明，因为 unavailable / recovering / error 的信息量
 * 压不进一个图标。文字取自后端，不在这里编。
 *
 * 图标是装饰性的（aria-hidden），语义全部挂在 .status 的 aria-label 上，
 * 所以 quiet 模式下屏幕阅读器读到的信息没有任何缩水。
 */
/** @param {any} view */
function renderStatus (view: any): void {
  statusHost.textContent = ''
  statusHost.classList.remove('refinement-notice')
  statusHost.dataset.tone = view.status.tone
  statusHost.dataset.emphasis = view.status.emphasis
  statusHost.setAttribute('aria-label', view.status.ariaLabel)

  if (refinementNotice) {
    statusHost.classList.add('refinement-notice')
    statusHost.dataset.tone = 'warn'
    statusHost.dataset.emphasis = 'attention'
    statusHost.setAttribute('aria-label', `${refinementNotice.message}；可查看历史或关闭提示`)
    statusHost.appendChild(iconEl('alert', 'status-icon'))
    const message = el('span', 'status-message', refinementNotice.message)
    message.title = refinementNotice.message
    statusHost.appendChild(message)
    statusHost.appendChild(commandButton({
      act: 'history',
      icon: 'history',
      label: '查看历史',
      showLabel: true,
      ariaLabel: `查看本次会话历史：${refinementNotice.message}`,
      disabled: false,
      reason: null
    }, 'notice-history'))
    statusHost.appendChild(commandButton({
      act: 'dismiss-refinement-notice',
      icon: 'close',
      label: '关闭提示',
      showLabel: false,
      ariaLabel: '关闭精修状态提示',
      disabled: false,
      reason: null
    }, 'notice-dismiss'))
  } else {
    const icon = iconEl(view.status.icon, 'status-icon')
    if (SPIN[view.status.icon]) icon.dataset.spin = SPIN[view.status.icon]
    statusHost.appendChild(icon)

    const message = el('span', 'status-message',
      view.status.emphasis === 'attention' ? view.status.message : '')
    message.title = view.status.ariaLabel
    statusHost.appendChild(message)
  }

  if (commandFailure) {
    const message = statusHost.querySelector<HTMLElement>('.status-message')
    if (!message) throw new Error('toolbar status message is missing')
    message.textContent = commandFailure.message
    message.title = commandFailure.message
    statusHost.dataset.tone = 'danger'
    statusHost.dataset.emphasis = 'attention'
  }
}

/** @param {any} view */
function renderCommands (view: any): void {
  commandHost.textContent = ''

  commandHost.appendChild(commandButton(view.primary))
  view.secondary.forEach((action: any) => commandHost.appendChild(commandButton(action)))

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
  { act: 'minimize', icon: 'minimize', label: '最小化' },
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
  wrap.dataset.attention = (commandFailure || refinementNotice || view.status.emphasis === 'attention') ? 'on' : 'off'
  toolbar.setAttribute('aria-busy', String(commandPending))
}

// ---------------------------------------------------------------------------
// 命中测试：指针在条上 → 实心；否则穿透（窗口比条宽，右对齐留出的空白全部放行）
//
// 穿透状态一翻转，光标就换主人：穿透时由下面那个应用画（网页里就是 I 形），
// 实心时才是本窗的箭头。所以判定每抖一次，用户就看见光标闪一次。
// 两条措施把抖动摁死：
//   1. 迟滞：进入用真实轮廓，离开要超出 6px。工具条上报的轮廓经主进程取整后
//      变成字幕窗的洞，洞比条最多大 1px；那一圈里两个窗都会说「不是我的」，
//      迟滞带必须盖过它。
//   2. 同步判定：矩形比较几乎零成本，不再压进 rAF —— 那一帧延迟正好发生在
//      光标扫过边缘的时候，判定用的永远是上一帧的答案。
// ---------------------------------------------------------------------------
const HIT_EXIT_MARGIN = 6

let toolbarRect: DOMRect | null = null

/* 每帧读 getBoundingClientRect 会反复触发强制布局。条的几何只在重渲染和
   ResizeObserver 回调后才可能变，所以标脏、下一次 mousemove 时才真正量。 */
function invalidateToolbarRect (): void {
  toolbarRect = null
  queueToolbarLayoutReport()
}

if (typeof ResizeObserver === 'function') {
  toolbarLayoutObserver = new ResizeObserver(() => invalidateToolbarRect())
  toolbarLayoutObserver.observe(toolbar)
}

/** @param {number} x @param {number} y @param {boolean=} force */
function applyHit (x: number, y: number, force = false): void {
  if (interactionPhase !== 'resume' || dragging) return
  if (!toolbarRect) toolbarRect = toolbar.getBoundingClientRect()
  const rect = toolbarRect
  /* 已经实心时才外扩：进入保持精确，离开才需要粘性 */
  const margin = ignoring === false ? HIT_EXIT_MARGIN : 0
  const solid = x >= rect.left - margin && x <= rect.right + margin &&
                y >= rect.top - margin && y <= rect.bottom + margin
  const next = !solid
  if (force || next !== ignoring) {
    ignoring = next
    bridge.mouseThrough(next)
  }
}
document.addEventListener('mousemove', (e) => {
  lastX = e.clientX; lastY = e.clientY
  applyHit(lastX, lastY)
})
/* 光标一跳跃出整个窗口时不会再有 mousemove。窗口比条宽得多（左右各 16px、
   上下各 16px 透明边距 > 6px 迟滞带），正常移动摸不到这条路径；留着是防止
   任何情况下卡在实心态 —— 那会让 600×72 这块区域整个挡住下面的应用。 */
document.addEventListener('mouseleave', () => {
  if (interactionPhase !== 'resume' || dragging || ignoring === true) return
  ignoring = true
  bridge.mouseThrough(true)
})

// ---------------------------------------------------------------------------
// 拖动：只有持续可见的握把可以开始。未锁定时主进程移动字幕窗并重停靠，
// 已锁定时主进程只移动工具条自身。
// ---------------------------------------------------------------------------
const toolbarDrag = bindManualWindowDrag({
  handle: grip,
  classTarget: toolbar,
  onStart: () => bridge.dragStart('toolbar'),
  onEnd: () => bridge.dragEnd(),
  onActiveChange: (active: boolean) => {
    dragging = active
    if (!active) applyHit(lastX, lastY)
  }
})

/** @param {any} value */
function acceptInteractionSync (value: any): void {
  if (!value || value.schemaVersion !== 1 || !Number.isSafeInteger(value.generation) ||
      value.generation <= 0 || value.generation < interactionGeneration ||
      (value.phase !== 'suspend' && value.phase !== 'resume')) return
  if (value.phase === 'suspend' && Object.keys(value).length !== 3) return
  if (value.phase === 'resume' && (Object.keys(value).length !== 4 || !value.pointer ||
      Object.keys(value.pointer).length !== 2 ||
      !Number.isFinite(value.pointer.x) || !Number.isFinite(value.pointer.y))) return

  interactionGeneration = value.generation
  interactionPhase = 'suspend'
  toolbarDrag.cancel()
  ignoring = null
  interactionPhase = value.phase
  if (value.phase === 'suspend') return
  lastX = value.pointer.x
  lastY = value.pointer.y
  applyHit(lastX, lastY, true)
}

if (typeof bridge.onInteractionSync === 'function') bridge.onInteractionSync(acceptInteractionSync)

// ---------------------------------------------------------------------------
// 用户意图：只转交，不预判成功。壳层回执到位后（B1 的 CommandResult）
// 才更新状态，这里不做乐观更新。
// ---------------------------------------------------------------------------
toolbar.addEventListener('click', (e) => {
  const target = e.target as Element | null
  const button = target?.closest<HTMLButtonElement>('.act') || null
  if (!button || button.disabled) return
  const action = button.dataset.act
  if (!action) return
  const run = SUPPORTED[action]
  if (run) run()
})

// ---------------------------------------------------------------------------
// 状态同步
// ---------------------------------------------------------------------------
let lockRevision = 0

/** @param {boolean} on */
function applyLockState (on: boolean): void {
  toolbarDrag.end()
  locked = !!on
  wrap.dataset.locked = locked ? 'on' : 'off'
  render()
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

/** @param {any} next */
function acceptSnapshot (next: any): void {
  if (!next || typeof next.revision !== 'number') return
  /* The preview fixture has its own illustrative revision. It is not part of
     the live coordinator sequence, so the first real snapshot must always
     replace it. Revision ordering only applies after that boundary. */
  if (runtimeSnapshotAccepted && snapshot && next.revision < snapshot.revision) return
  runtimeSnapshotAccepted = true
  snapshot = next
  commandFailure = null
  render()
}

async function initRuntime () {
  bridge.onSnapshot(acceptSnapshot)
  try { acceptSnapshot(await bridge.getSnapshot()) } catch { /* browser preview */ }
}

let refinementNoticeRevision = 0

/** @param {any} notice */
function acceptRefinementNotice (notice: any): void {
  refinementNoticeRevision += 1
  refinementNotice = notice && notice.kind === 'refinement-fault' ? notice : null
  render()
}

async function initRefinementNotice () {
  bridge.onRefinementNotice(acceptRefinementNotice)
  const requestedAt = refinementNoticeRevision
  try {
    const notice = await bridge.getRefinementNotice()
    if (refinementNoticeRevision === requestedAt) acceptRefinementNotice(notice)
  } catch { /* browser preview */ }
}

/** @param {any} c */
function applyConfig (c: any): void {
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
initRefinementNotice()
initToolbarLayout()

})()

export {}
