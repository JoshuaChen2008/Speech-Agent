'use strict'

// @ts-check

/* 预览页渲染。
   --------------------------------------------------------------------------
   这里只做「视图模型 → DOM」。所有状态判断都在 runtime-view.js 里，
   本文件不允许出现 phase 名的 switch —— 一旦出现，就说明有决策漏在了 DOM 层，
   真工具条接入时会重演一遍。唯一的例外是第 2 节挑选字幕内容，
   那属于演示数据编排，不是状态语义。 */

const { installSprite, iconMarkup } = window.Icons
const { buildRuntimeView } = window.RuntimeView
const F = window.FIXTURES

/** 正文可用高度：卡片 150 − padding-top 20 − padding-bottom 22 */
const CONTENT_BUDGET = 108
/** 当前窗口给工具条的内容宽度（main.js TB_W = 214 + 16×2） */
const TOOLBAR_BUDGET = 214

installSprite(document)

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
function el (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function iconEl (name, extraClass) {
  const span = el('span')
  span.innerHTML = iconMarkup(name)
  const svg = span.firstChild
  if (extraClass) svg.classList.add(extraClass)
  return svg
}

// ---------------------------------------------------------------------------
// 工具条
// ---------------------------------------------------------------------------

/** 过渡态才转圈；稳态不给无限动画。 */
const SPIN = { spinner: 'cw', recover: 'ccw' }

function actButton (action, extraClass) {
  const button = el('button', 'act' + (extraClass ? ' ' + extraClass : ''))
  button.dataset.act = action.act
  button.disabled = action.disabled
  button.setAttribute('aria-label', action.ariaLabel)
  if (action.reason) button.title = action.reason
  button.appendChild(iconEl(action.icon))
  return button
}

/** 只有图标、语义固定的窗口控制键。 */
function plainButton (act, icon, label, extraClass) {
  const button = el('button', 'act' + (extraClass ? ' ' + extraClass : ''))
  button.dataset.act = act
  button.setAttribute('aria-label', label)
  button.title = label
  button.appendChild(iconEl(icon))
  return button
}

function buildStatus (view) {
  const status = el('div', 'status')
  status.dataset.tone = view.status.tone
  status.setAttribute('role', 'status')

  const icon = iconEl(view.status.icon, 'status-icon')
  if (SPIN[view.status.icon]) icon.dataset.spin = SPIN[view.status.icon]
  status.appendChild(icon)

  const text = el('div', 'status-text')
  text.appendChild(el('span', 'status-label', view.status.label))
  text.appendChild(el('span', 'status-detail', view.status.detail))
  status.appendChild(text)
  return status
}

function buildToolbar (view, options) {
  const locked = !!(options && options.locked)
  const bar = el('div', 'bar')

  bar.appendChild(buildStatus(view))
  bar.appendChild(el('i', 'sep'))

  bar.appendChild(actButton(view.primary))
  view.secondary.forEach((action) => bar.appendChild(actButton(action)))

  if (view.nextAction) {
    const next = el('button', 'act act-text')
    next.dataset.act = view.nextAction.action
    next.dataset.tone = view.status.tone
    next.setAttribute('aria-label', view.nextAction.label + '：' + view.nextAction.message)
    next.title = view.nextAction.message
    next.appendChild(iconEl(view.nextAction.icon))
    next.appendChild(el('span', null, view.nextAction.label))
    bar.appendChild(next)
  }

  bar.appendChild(el('i', 'sep'))
  bar.appendChild(plainButton('history', 'history', '历史记录'))

  /* 锁定是唯一名称稳定的真 toggle，所以 aria-pressed 留给它。
     主按钮的可及名称在「开始 / 暂停 / 继续」间切换，不叠 pressed 语义。 */
  const lock = plainButton('lock', locked ? 'lock' : 'unlock', '锁定字幕')
  lock.setAttribute('aria-pressed', String(locked))
  bar.appendChild(lock)

  bar.appendChild(plainButton('settings', 'settings', '设置'))
  bar.appendChild(plainButton('close', 'close', '退出', 'act-danger'))
  return bar
}

// ---------------------------------------------------------------------------
// 字幕卡
// ---------------------------------------------------------------------------
function buildNotice (notice) {
  const box = el('div', 'notice')
  box.dataset.tone = notice.tone
  box.appendChild(iconEl(notice.icon, 'notice-icon'))

  const body = el('div', 'notice-body')
  body.appendChild(el('p', 'notice-title', notice.title))
  body.appendChild(el('p', 'notice-message', notice.message))
  body.appendChild(el('p', 'notice-detail', notice.detail))
  box.appendChild(body)
  return box
}

/**
 * @param {{prev?:string, current:string, partial?:boolean, translation?:string|null}} lines
 */
function buildLines (lines) {
  const wrap = el('div', 'cap-lines')
  if (lines.prev) wrap.appendChild(el('p', 'cap-line prev', lines.prev))
  wrap.appendChild(el('p', 'cap-line' + (lines.partial ? ' partial' : ''), lines.current))
  if (lines.translation) wrap.appendChild(el('p', 'cap-line tr', lines.translation))
  return wrap
}

function buildCard (content) {
  const card = el('div', 'cap-card')
  card.appendChild(content)
  return card
}

function buildStage (content, bg) {
  const stage = el('div', 'stage')
  stage.dataset.bg = bg || currentBg()
  stage.appendChild(content)
  return stage
}

// ---------------------------------------------------------------------------
// 控件状态
// ---------------------------------------------------------------------------
const ctl = {
  theme: document.getElementById('ctl-theme'),
  fs: document.getElementById('ctl-fs'),
  bg: document.getElementById('ctl-bg'),
  bilingual: document.getElementById('ctl-bilingual'),
  motion: document.getElementById('ctl-motion')
}
function currentBg () { return ctl.bg.value }
function bilingual () { return ctl.bilingual.checked }

// ---------------------------------------------------------------------------
// 1 · 状态矩阵
// ---------------------------------------------------------------------------
function renderMatrix () {
  const host = document.getElementById('matrix')
  host.textContent = ''
  const widths = []

  for (const [name, snapshot] of Object.entries(F.runtime)) {
    const view = buildRuntimeView(snapshot)

    const row = el('div', 'case')

    const head = el('div')
    head.appendChild(el('div', 'case-name', name))
    head.appendChild(el('div', 'case-phase', 'phase: ' + view.phase))
    row.appendChild(head)

    const stage = el('div', 'case-stage')
    const bar = buildToolbar(view, { locked: false })
    stage.appendChild(bar)
    row.appendChild(stage)

    const meta = el('div', 'case-meta')
    row.appendChild(meta)
    host.appendChild(row)

    /* 插入 DOM 后才能量到真实宽度 */
    const width = Math.round(bar.getBoundingClientRect().width)
    widths.push({ name, width })

    const tag = el('span', 'width-tag' + (width > TOOLBAR_BUDGET ? ' over' : ''), width + ' px')
    meta.appendChild(document.createTextNode('条宽 '))
    meta.appendChild(tag)
    meta.appendChild(el('div', null,
      '来源：' + view.sources.map((s) => s.label + ' ' + s.stateLabel).join('，')))
    meta.appendChild(el('div', null, '模型：' + view.model.label))
    meta.appendChild(el('div', null,
      '电平：' + view.sources.map((s) => s.id + ' ' + s.level).join('，')))
  }

  const max = widths.reduce((a, b) => (b.width > a.width ? b : a))
  const min = widths.reduce((a, b) => (b.width < a.width ? b : a))
  const summary = el('p', 'sec-note')
  summary.innerHTML =
    '<strong>实测：</strong>最窄 ' + min.width + ' px（' + min.name + '），' +
    '最宽 ' + max.width + ' px（' + max.name + '）。' +
    '当前窗口只给到 ' + TOOLBAR_BUDGET + ' px 内容宽（<code>main.js TB_W</code>），' +
    '差 ' + (max.width - TOOLBAR_BUDGET) + ' px。'
  host.appendChild(summary)
}

// ---------------------------------------------------------------------------
// 2 · 字幕卡（状态驱动）
// ---------------------------------------------------------------------------
const DEMO = {
  prev: F.captions.refined.text,
  partial: F.captions.partial.text,
  final: F.captions.final.text,
  translation: F.captions.translated.translation.text
}

/** 演示数据编排：哪个 phase 该看到什么字幕。不是状态语义，故留在预览页。 */
function captionContentFor (view) {
  if (view.notice) return buildNotice(view.notice)
  if (view.phase === 'idle') {
    return el('p', 'cap-idle', view.status.label + ' · ' + view.status.detail)
  }
  return buildLines({
    prev: DEMO.prev,
    current: view.phase === 'listening' ? DEMO.partial : DEMO.final,
    partial: view.phase === 'listening',
    translation: bilingual() ? DEMO.translation : null
  })
}

function renderCaptionStates () {
  const host = document.getElementById('captionStates')
  host.textContent = ''

  for (const [name, snapshot] of Object.entries(F.runtime)) {
    if (name === 'resumed') continue     /* 与 listening 同 phase，卡片表现一致 */
    const view = buildRuntimeView(snapshot)

    const row = el('div', 'stage-row')
    const head = el('div', 'stage-head')
    head.appendChild(el('strong', null, name))
    head.appendChild(el('span', 'tag', view.notice ? '说明条' : (view.phase === 'idle' ? '空态' : '字幕')))
    const verdict = el('span', 'verdict')
    head.appendChild(verdict)
    row.appendChild(head)

    const card = buildCard(captionContentFor(view))
    row.appendChild(buildStage(card))
    host.appendChild(row)

    measure(card, verdict)
  }
}

/** 量正文实际高度，和 108px 预算比对。 */
function measure (card, verdict) {
  const content = card.firstElementChild
  const height = Math.ceil(content.getBoundingClientRect().height)
  const over = height - CONTENT_BUDGET
  if (over > 0) {
    verdict.className = 'verdict bad'
    verdict.textContent = '正文 ' + height + ' px · 溢出 ' + over + ' px'
  } else {
    verdict.className = 'verdict ok'
    verdict.textContent = '正文 ' + height + ' px · 余 ' + -over + ' px'
  }
}

// ---------------------------------------------------------------------------
// 3 · 排版包线
// ---------------------------------------------------------------------------
const LONG_WORD = 'Pseudopseudohypoparathyroidism'
const TYPE_CASES = [
  { fs: 24, tr: false, label: '24px 单语' },
  { fs: 24, tr: true, label: '24px 双语' },
  { fs: 30, tr: false, label: '30px 单语（当前默认）' },
  { fs: 30, tr: true, label: '30px 双语' },
  { fs: 38, tr: false, label: '38px 单语' },
  { fs: 38, tr: true, label: '38px 双语' },
  { fs: 30, tr: false, label: '30px 长英文单词', current: LONG_WORD + ' ' + LONG_WORD },
  { fs: 38, tr: true, label: '38px 中英混排 + 双语', current: '这个 onboarding drop-off 主要卡在 step three。' }
]

function renderTypeCases () {
  const host = document.getElementById('typeCases')
  host.textContent = ''

  for (const item of TYPE_CASES) {
    const row = el('div', 'stage-row')
    const head = el('div', 'stage-head')
    head.appendChild(el('strong', null, item.label))
    head.appendChild(el('span', 'tag', '预算 ' + CONTENT_BUDGET + ' px'))
    const verdict = el('span', 'verdict')
    head.appendChild(verdict)
    row.appendChild(head)

    const card = buildCard(buildLines({
      prev: DEMO.prev,
      current: item.current || DEMO.final,
      partial: false,
      translation: item.tr ? DEMO.translation : null
    }))
    card.style.setProperty('--fs', item.fs + 'px')
    row.appendChild(buildStage(card))
    host.appendChild(row)

    measure(card, verdict)
  }
}

// ---------------------------------------------------------------------------
// 4 · CommandResult
// ---------------------------------------------------------------------------
const NEXT_LABEL = window.RuntimeView.NEXT_ACTION_VIEW

function renderCommands () {
  const host = document.getElementById('commandCases')
  host.textContent = ''

  for (const [name, result] of Object.entries(F.commands)) {
    const row = el('div', 'cmd-row')

    const code = el('div', 'cmd-code')
    code.appendChild(el('div', null, name))
    code.appendChild(el('div', null, 'code: ' + result.code))
    code.appendChild(el('div', null,
      'ok: ' + result.ok + (result.recoverable === null ? '' : ' · 可恢复: ' + result.recoverable)))
    row.appendChild(code)

    const tone = result.ok ? 'busy' : (result.recoverable ? 'warn' : 'danger')
    const feedback = el('div', 'cmd-feedback')
    feedback.dataset.tone = tone
    feedback.appendChild(iconEl(result.ok ? 'ready' : 'alert'))
    feedback.appendChild(el('span', 'msg', result.ok ? '命令已接受' : result.message))

    if (result.nextAction && NEXT_LABEL[result.nextAction]) {
      const view = NEXT_LABEL[result.nextAction]
      const button = el('button', 'act act-text')
      button.dataset.tone = tone
      button.setAttribute('aria-label', view.label + '：' + result.message)
      button.appendChild(iconEl(view.icon))
      button.appendChild(el('span', null, view.label))
      feedback.appendChild(button)
    }
    row.appendChild(feedback)
    host.appendChild(row)
  }
}

// ---------------------------------------------------------------------------
// 控件联动
// ---------------------------------------------------------------------------
function applyGlobals () {
  document.documentElement.dataset.theme = ctl.theme.value
  document.documentElement.style.setProperty('--fs', ctl.fs.value + 'px')
  document.body.classList.toggle('sim-reduced', ctl.motion.checked)
  document.querySelectorAll('.stage').forEach((stage) => { stage.dataset.bg = currentBg() })
}

function renderAll () {
  renderMatrix()
  renderCaptionStates()
  renderTypeCases()
  renderCommands()
  applyGlobals()
}

ctl.theme.addEventListener('change', applyGlobals)
ctl.bg.addEventListener('change', applyGlobals)
ctl.motion.addEventListener('change', applyGlobals)
/* 字号和双语会改变排版结果，必须重量一次 */
ctl.fs.addEventListener('change', renderAll)
ctl.bilingual.addEventListener('change', renderAll)

renderAll()
