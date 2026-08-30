'use strict'

// @ts-check

/* Agent Bar 视觉设计基准页的渲染。
   ---------------------------------------------------------------------------
   数据是手写的设计取值，不经任何 exact validator，也没有 preload、IPC 或存储：
   本页只回答「这套状态用当前视觉语言长什么样」，不回答「后端能不能产出它」。
   状态、文案与信息架构逐条对应 docs/agent-ui-ux-handoff.md §13.3 / §13.4。

   控件词汇与设置页 · Agent 模型配置档案（src/settings/agent-model-pane.tsx）保持一致：
     区块        .group
     一行        .row + .label + .hint
     单选        .seg[role=radiogroup] + .on
     主/次/链接  .primary-btn / .secondary-btn / .link-btn
     只读清单    .resource-list + .resource-row + .resource-status
     不可用      .group > p.note[role=alert] + .secondary-btn
   外观全部来自 settings.css，这里只组合，不新建控件样式。 */

const MATRIX = document.getElementById('matrix')

/** 四值范围类型闭集，见 CONTEXT.md「Agent Bar」词条。 */
const SCOPE_TYPES = ['当前选区', '终态会话', '日期范围', '项目']

/** 所有场景共用的底座；每个场景只写自己不同的那几项。 */
const BASE = {
  scope: { selected: '终态会话', summary: '本次会话 · 已提交 128 段', disabled: [], readonly: false },
  eligibility: null,
  unavailable: null,
  intent: { text: '把这次会议的结论和待办整理出来', empty: false, locked: false },
  submit: 'enabled',
  cancel: false,
  status: null,
  result: null,
  recent: { items: [{ when: '14:02', scope: '本次会话 · 配置档案 A', terminal: '成功' }], more: false }
}

const RESULT_FACTS_KNOWN = [
  '本次会话',
  '配置档案 A · 通用模型',
  '用时 12 秒',
  '输入 2,140 · 输出 380 token',
  '缓存命中 32%'
]

const FEEDBACK_ACTIONS = ['编辑', '采纳', '不采纳', '记住这条', '忘记这条']

const spec = (overrides) => ({ ...BASE, ...overrides })

/* ---------------------------------------------------------------------------
   场景。分组与顺序对齐 handoff §13.3 的 A/B/C/D/E/F 六张表。
   --------------------------------------------------------------------------- */
const GROUPS = [
  {
    title: 'A 范围选择',
    note: '范围类型是四值闭集；不可用的范围显示为不可选并说明原因，不提供选不出结果的下拉框。',
    cases: [
      {
        case: '当前选区可用',
        bar: spec({ scope: { selected: '当前选区', summary: '来自字幕历史的选区 · 12 段', disabled: [], readonly: false } })
      },
      {
        case: '当前选区不可用',
        bar: spec({
          scope: { selected: '终态会话', summary: '本次会话 · 已提交 128 段', disabled: ['当前选区'], readonly: false },
          eligibility: { text: '请先在字幕历史选择内容' }
        })
      },
      {
        case: '清单为空',
        note: '终态会话 / 日期范围 / 项目',
        bar: spec({
          scope: { selected: '项目', summary: '', disabled: [], readonly: false },
          eligibility: { text: '这个范围类型下还没有可选内容。' },
          submit: 'disabled'
        })
      },
      {
        case: '范围含省略标记',
        bar: spec({
          scope: { selected: '日期范围', summary: '2026-08-24 至 2026-08-30 · 部分来源已省略', disabled: [], readonly: false }
        })
      },
      {
        case: '范围投影不可用',
        bar: spec({
          scope: { selected: '终态会话', summary: '', disabled: SCOPE_TYPES, readonly: true },
          unavailable: { text: 'Agent Bar 暂时不可用。' },
          intent: { text: '把这次会议的结论和待办整理出来', empty: false, locked: true },
          submit: 'disabled',
          recent: { items: [], more: false }
        })
      }
    ]
  },
  {
    title: 'B 九值 Agent 处理资格',
    note: 'Core 按固定优先级计算，UI 只翻译原因与下一动作，不自行推断可重试性。未知值 fail closed。',
    cases: [
      { case: 'ready', bar: spec({}) },
      ...[
        ['no_committed_transcript', '所选范围内还没有已提交的字幕内容。', null],
        ['outside_automatic_window', '该会话早于自动处理边界；你仍可明确请求处理它。', null],
        ['agent_disabled', 'Agent 功能当前未开启。前往设置开启。', '打开设置'],
        ['provider_not_configured', '还没有配置可用的模型。前往设置配置模型。', '打开设置 · Agent 模型配置档案'],
        ['cloud_disclosure_required', '这次处理会使用云端模型，需要你先确认。', '确认云端处理'],
        ['credential_unavailable', '所选模型的凭据当前不可用。前往设置检查凭据。', '打开设置'],
        ['local_model_not_ready', '本地模型尚未就绪。前往设置查看模型资源。', '打开模型资源'],
        ['session_not_terminal', '所选会话仍在进行中。', null],
        ['未知资格值', '当前无法处理这个请求。', null]
      ].map(([name, text, nextAction]) => ({
        case: name,
        bar: spec({ eligibility: { text, nextAction }, submit: 'disabled' })
      }))
    ]
  },
  {
    title: 'C 运行生命周期',
    note: '写动作一律先 pending 再回执，无乐观成功态。取消请求中不得提前显示已取消。',
    cases: [
      {
        case: '提交中',
        note: '尚未收到 pending 确认',
        bar: spec({ intent: { text: '把这次会议的结论和待办整理出来', empty: false, locked: true }, submit: 'busy' })
      },
      {
        case: 'pending',
        bar: spec({
          scope: { selected: '终态会话', summary: '本次会话 · 已提交 128 段', disabled: SCOPE_TYPES, readonly: false },
          intent: { text: '把这次会议的结论和待办整理出来', empty: false, locked: true },
          submit: 'busy',
          cancel: true,
          status: { role: 'status', text: '正在处理，请稍候。' }
        })
      },
      {
        case: '取消请求中',
        bar: spec({
          intent: { text: '把这次会议的结论和待办整理出来', empty: false, locked: true },
          submit: 'busy',
          status: { role: 'status', text: '正在取消。' }
        })
      },
      {
        case: '取消终态',
        bar: spec({
          status: { role: 'status', text: '已取消。' },
          result: { kind: '摘要', body: '（取消前已生成的部分保留在这里，缺失部分不补造。）', facts: RESULT_FACTS_KNOWN }
        })
      },
      {
        case: '成功终态',
        bar: spec({
          result: {
            kind: '摘要',
            rechoose: true,
            body: '概要：确认了下一阶段范围与两项风险。结论：本周内冻结接口。待办：补齐资格状态矩阵。',
            facts: RESULT_FACTS_KNOWN,
            feedback: 'idle'
          }
        })
      },
      {
        case: '失败终态',
        bar: spec({ status: { role: 'alert', text: '这次处理没有完成。', retry: '重试' } })
      },
      {
        case: '结果为空',
        bar: spec({ result: { kind: '问答', body: '这次没有生成结果。', empty: true, facts: RESULT_FACTS_KNOWN } })
      }
    ]
  },
  {
    title: 'D 结果头部事实',
    note: '相对时长始终显示，绝对时刻不出现。用量未知时不出现任何数字，也不估算；金额字段永不出现。',
    cases: [
      {
        case: '用量与缓存命中率均已知',
        bar: spec({
          result: { kind: '分析报告', rechoose: true, body: '按范围内的来源引用给出三条结论与两条待确认事项。', facts: RESULT_FACTS_KNOWN, feedback: 'idle' }
        })
      },
      {
        case: '用量未知',
        bar: spec({
          result: {
            kind: '分析报告',
            body: '按范围内的来源引用给出三条结论与两条待确认事项。',
            facts: ['本次会话', '配置档案 A · 通用模型', '用时 12 秒', '用量未知'],
            feedback: 'idle'
          }
        })
      },
      {
        case: '缓存命中率未知',
        note: '不显示该行，也不显示占位 0%',
        bar: spec({
          result: {
            kind: '规划建议',
            body: '给出一份区分事实、假设与待确认事项的计划草案。',
            facts: ['2026-08-24 至 2026-08-30', '配置档案 A · 通用模型', '用时 21 秒', '输入 4,090 · 输出 612 token'],
            feedback: 'idle'
          }
        })
      }
    ]
  },
  {
    title: 'E 恢复与迟到',
    note: '未知 contract 版本、未知枚举值与缺失字段一律 fail closed：整个表面只读可重试，不从部分字段继续渲染。',
    cases: [
      {
        case: '未知 contract 版本',
        bar: spec({
          scope: { selected: '终态会话', summary: '', disabled: SCOPE_TYPES, readonly: true },
          unavailable: { text: 'Agent Bar 暂时不可用。' },
          intent: { text: '把这次会议的结论和待办整理出来', empty: false, locked: true },
          submit: 'disabled',
          recent: { items: [], more: false }
        })
      },
      {
        case: '最近交互含未知枚举值',
        bar: spec({
          recent: {
            items: [
              { when: '14:02', scope: '本次会话 · 配置档案 A', terminal: '成功' },
              { when: '13:41', scope: '2026-08-24 至 2026-08-30 · 配置档案 A', terminal: '这条记录包含当前版本无法解释的内容，暂不提供操作。' }
            ],
            more: false
          }
        })
      }
    ]
  },
  {
    title: 'F 最小交互历史与反馈',
    note: '列表不含未读状态、角标、红点或计数；触达上界只说明还有更多，不伪造完整总数。',
    cases: [
      { case: '列表为空', bar: spec({ recent: { items: [], more: false } }) },
      {
        case: '列表触达上界',
        bar: spec({
          recent: {
            items: [
              { when: '14:02', scope: '本次会话 · 配置档案 A', terminal: '成功' },
              { when: '13:41', scope: '2026-08-24 至 2026-08-30 · 配置档案 A', terminal: '已取消' },
              { when: '11:07', scope: '项目：字幕重构 · 配置档案 A', terminal: '成功' }
            ],
            more: true
          }
        })
      },
      {
        case: '反馈动作 pending',
        bar: spec({
          result: { kind: '摘要', body: '概要：确认了下一阶段范围与两项风险。', facts: RESULT_FACTS_KNOWN, feedback: 'pending', status: { role: 'status', text: '正在提交，请稍候。' } }
        })
      },
      {
        case: '反馈成功回执',
        bar: spec({
          result: { kind: '摘要', body: '概要：确认了下一阶段范围与两项风险。', facts: RESULT_FACTS_KNOWN, feedback: 'idle', status: { role: 'status', text: '已保存。' } }
        })
      },
      {
        case: '反馈 revision conflict',
        bar: spec({
          result: { kind: '摘要', body: '概要：确认了下一阶段范围与两项风险。（用户的编辑保留在这里。）', facts: RESULT_FACTS_KNOWN, feedback: 'idle', status: { role: 'alert', text: '这条内容已在别处更新，本次未写入。你的编辑仍保留。' } }
        })
      }
    ]
  }
]

/* ---------------------------------------------------------------------------
   规格 → DOM。只用 settings.css 已有的控件类。
   --------------------------------------------------------------------------- */
function el (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button (className, label, { disabled = false, busy = false } = {}) {
  const node = el('button', className, label)
  node.type = 'button'
  if (disabled) node.disabled = true
  if (busy) node.setAttribute('aria-busy', 'true')
  return node
}

/* 失败用设置页的 .model-error（左对齐、tone-danger、role=alert），
   成功与 pending 用 .hint。刻意不用 .settings-status：它带 flex:1 + 右对齐，
   是为顶栏写的，独立成行时会把一句话甩到右边。 */
function statusLine (status) {
  const node = el('p', status.role === 'alert' ? 'model-error' : 'hint', status.text)
  node.setAttribute('role', status.role)
  node.setAttribute('aria-live', 'polite')
  return node
}

function renderScopeRow (bar) {
  const row = el('div', 'row')
  const left = el('div')
  left.appendChild(el('div', 'label', '范围'))
  left.appendChild(el('div', 'hint', bar.scope.summary || '未选择'))

  const seg = el('div', 'seg')
  seg.setAttribute('role', 'radiogroup')
  seg.setAttribute('aria-label', '范围类型')
  for (const type of SCOPE_TYPES) {
    const selected = type === bar.scope.selected
    const option = button(selected ? 'on' : '', type, { disabled: bar.scope.disabled.includes(type) })
    option.setAttribute('role', 'radio')
    option.setAttribute('aria-checked', String(selected))
    seg.appendChild(option)
  }

  row.append(left, seg)
  return row
}

function renderEligibilityRow (eligibility) {
  const row = el('div', 'row')
  row.appendChild(el('div', 'label', eligibility.text))
  if (eligibility.nextAction) row.appendChild(button('link-btn', eligibility.nextAction))
  return row
}

function renderComposeRow (bar) {
  const row = el('div', 'row compose-row')

  const intent = document.createElement('input')
  intent.type = 'text'
  intent.setAttribute('aria-label', '自然语言意图')
  intent.placeholder = '说说你想让 Agent 做什么'
  if (!bar.intent.empty) intent.value = bar.intent.text
  if (bar.intent.locked) intent.disabled = true

  const actions = el('div', 'resource-actions')
  if (bar.cancel) actions.appendChild(button('secondary-btn', '取消'))
  actions.appendChild(button('primary-btn', '发送', {
    disabled: bar.submit !== 'enabled',
    busy: bar.submit === 'busy'
  }))

  row.append(intent, actions)
  return row
}

function renderResult (result) {
  const group = el('div', 'group')

  const head = el('div', 'row')
  const left = el('div')
  left.appendChild(el('div', 'label', result.kind))
  const facts = el('div', 'hint agent-facts')
  for (const fact of result.facts) facts.appendChild(el('span', null, fact))
  left.appendChild(facts)
  head.appendChild(left)
  if (result.rechoose) head.appendChild(button('link-btn', '换一种方式处理'))
  group.appendChild(head)

  const body = el('p', 'agent-result-body', result.body)
  if (result.empty) body.dataset.empty = 'true'
  group.appendChild(body)

  if (result.feedback) {
    const row = el('div', 'row')
    const actions = el('div', 'resource-actions')
    for (const action of FEEDBACK_ACTIONS) {
      actions.appendChild(button('link-btn', action, {
        disabled: result.feedback === 'pending',
        busy: result.feedback === 'pending'
      }))
    }
    row.appendChild(actions)
    group.appendChild(row)
  }

  if (result.status) group.appendChild(statusLine(result.status))
  return group
}

function renderRecent (recent) {
  const wrapper = el('div')
  wrapper.appendChild(el('p', 'hint', '最近交互'))

  const list = el('div', 'resource-list')
  list.setAttribute('aria-label', '最近交互')
  if (recent.items.length === 0) {
    list.appendChild(el('p', 'note', '还没有交互记录。'))
    wrapper.appendChild(list)
    return wrapper
  }
  for (const item of recent.items) {
    const row = el('div', 'resource-row')
    const left = el('div')
    left.appendChild(el('div', 'label', item.when))
    left.appendChild(el('div', 'hint', item.scope))
    row.append(left, el('div', 'resource-status', item.terminal))
    list.appendChild(row)
  }
  if (recent.more) {
    const row = el('div', 'resource-row')
    row.appendChild(button('link-btn', '还有更多记录未载入。'))
    list.appendChild(row)
  }
  wrapper.appendChild(list)
  return wrapper
}

function renderBar (bar) {
  const surface = el('div', 'agent-bar')
  surface.dataset.readonly = String(bar.scope.readonly)
  surface.setAttribute('aria-label', 'Agent Bar')

  if (bar.unavailable) {
    const group = el('div', 'group')
    const note = el('p', 'note', bar.unavailable.text)
    note.setAttribute('role', 'alert')
    group.append(note, button('secondary-btn', '重试'))
    surface.appendChild(group)
    surface.appendChild(renderRecent(bar.recent))
    return surface
  }

  const group = el('div', 'group')
  group.appendChild(renderScopeRow(bar))
  if (bar.eligibility) group.appendChild(renderEligibilityRow(bar.eligibility))
  group.appendChild(renderComposeRow(bar))
  if (bar.status) {
    group.appendChild(statusLine(bar.status))
    if (bar.status.retry) group.appendChild(button('secondary-btn', bar.status.retry))
  }
  surface.appendChild(group)

  if (bar.result) surface.appendChild(renderResult(bar.result))
  surface.appendChild(renderRecent(bar.recent))
  return surface
}

function renderMatrix () {
  for (const group of GROUPS) {
    const section = el('section', 'case-group')
    section.appendChild(el('h2', null, group.title))
    section.appendChild(el('p', 'note', group.note))

    const cases = el('div', 'cases')
    for (const entry of group.cases) {
      const card = el('figure', 'case')
      const caption = el('figcaption')
      caption.appendChild(el('span', 'case-name', entry.case))
      if (entry.note) caption.appendChild(el('span', 'case-note', entry.note))
      card.append(caption, renderBar(entry.bar))
      cases.appendChild(card)
    }
    section.appendChild(cases)
    MATRIX.appendChild(section)
  }
}

document.getElementById('ctl-theme').addEventListener('change', (event) => {
  document.documentElement.setAttribute('data-theme', event.target.value)
})

document.getElementById('ctl-desaturate').addEventListener('change', (event) => {
  MATRIX.classList.toggle('is-desaturated', event.target.checked)
})

renderMatrix()
