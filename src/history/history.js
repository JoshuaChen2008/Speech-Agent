'use strict'

const api = window.historyApi || {
  dragStart () {}, dragEnd () {}, close () {}, onConfig () {},
  getConfig: async () => ({ theme: 'dark', systemDark: true }),
  listSessions: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
  getSession: async () => ({ ok: false, error: { message: '历史记录不可用' } }),
  exportSession: async () => ({ ok: false, error: { message: '导出不可用' } })
}

const PAGE_SIZE = 50
const titlebar = document.getElementById('titlebar')
const closeButton = document.getElementById('close')
const refreshButton = document.getElementById('refresh')
const globalStatus = document.getElementById('globalStatus')
const sessionCount = document.getElementById('sessionCount')
const sessionList = document.getElementById('sessionList')
const loadMore = document.getElementById('loadMore')
const emptyState = document.getElementById('emptyState')
const sessionDetail = document.getElementById('sessionDetail')
const detailSource = document.getElementById('detailSource')
const detailTitle = document.getElementById('detailTitle')
const detailMeta = document.getElementById('detailMeta')
const exportStatus = document.getElementById('exportStatus')
const timeline = document.getElementById('timeline')
const exportButtons = [...document.querySelectorAll('[data-export]')]

let sessions = []
let nextCursor = null
let selectedSessionId = null
let listPending = false
let detailRequest = 0
let exportPending = false
let dragging = false

function unwrap (response) {
  if (!response || response.ok !== true) {
    const error = new Error(response?.error?.message || '历史记录暂时不可用')
    error.code = response?.error?.code || 'HISTORY_UNAVAILABLE'
    throw error
  }
  return response.value
}

function sourceLabel (sourceId) {
  return sourceId === 'mic' ? '麦克风听写' : '系统音频字幕'
}

function stateLabel (state) {
  return state === 'interrupted' ? '会话被中断' : '正常结束'
}

function fullDateTime (epochMs) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date(epochMs))
}

function shortDateTime (epochMs) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(new Date(epochMs))
}

function durationText (startedAt, endedAt) {
  const totalSeconds = Math.max(0, Math.round((endedAt - startedAt) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`
  return `${seconds} 秒`
}

function relativeTime (milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (value) => String(value).padStart(2, '0')
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`
}

function wallTime (startedAt, offsetMs) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date(startedAt + offsetMs))
}

function element (tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function renderSessionList () {
  sessionList.textContent = ''
  if (sessions.length === 0 && !listPending) {
    const emptyItem = element('div', 'session-list-item')
    emptyItem.setAttribute('role', 'listitem')
    emptyItem.appendChild(element('p', 'list-message', '还没有可复盘的字幕会话。完成一次监听后，它会自动出现在这里。'))
    sessionList.appendChild(emptyItem)
  }
  for (const session of sessions) {
    const listItem = element('div', 'session-list-item')
    listItem.setAttribute('role', 'listitem')
    const button = element('button', 'session-card')
    button.type = 'button'
    button.dataset.sessionId = session.sessionId
    button.setAttribute('aria-current', String(session.sessionId === selectedSessionId))
    button.appendChild(element('strong', null, shortDateTime(session.startedAt)))
    button.appendChild(element('span', 'summary',
      `${sourceLabel(session.sourceId)} · ${durationText(session.startedAt, session.endedAt)}`))
    button.appendChild(element('span', 'state',
      `${stateLabel(session.state)} · ${session.segmentCount} 条字幕`))
    button.addEventListener('click', () => { void selectSession(session.sessionId) })
    listItem.appendChild(button)
    sessionList.appendChild(listItem)
  }
  sessionCount.textContent = listPending
    ? '正在读取…'
    : sessions.length === 0 ? '暂无会话' : `已显示 ${sessions.length} 条会话`
  loadMore.hidden = nextCursor === null
  loadMore.disabled = listPending
}

function renderTimeline (transcript) {
  timeline.textContent = ''
  if (transcript.segments.length === 0) {
    const item = element('li', 'timeline-empty', '这个会话没有已定稿字幕。')
    timeline.appendChild(item)
    return
  }
  for (const segment of transcript.segments) {
    const item = element('li', 'timeline-item')
    const time = element('div', 'time-code')
    time.appendChild(element('strong', null, relativeTime(segment.t0Ms)))
    time.appendChild(element('span', null, wallTime(transcript.session.startedAt, segment.t0Ms)))
    item.appendChild(time)
    item.appendChild(element('div', 'caption-text', segment.text))
    timeline.appendChild(item)
  }
}

async function selectSession (sessionId) {
  if (selectedSessionId === sessionId && !sessionDetail.hidden) return
  selectedSessionId = sessionId
  exportStatus.textContent = ''
  renderSessionList()
  const request = ++detailRequest
  globalStatus.textContent = '正在读取会话…'
  exportButtons.forEach((button) => { button.disabled = true })
  try {
    const transcript = unwrap(await api.getSession(sessionId))
    if (request !== detailRequest) return
    detailSource.textContent = `${sourceLabel(transcript.session.sourceId)} · ${stateLabel(transcript.session.state)}`
    detailTitle.textContent = fullDateTime(transcript.session.startedAt)
    detailMeta.textContent = `${durationText(transcript.session.startedAt, transcript.session.endedAt)}` +
      ` · ${transcript.segments.length} 条已定稿字幕`
    renderTimeline(transcript)
    emptyState.hidden = true
    sessionDetail.hidden = false
    globalStatus.textContent = ''
    exportButtons.forEach((button) => { button.disabled = false })
  } catch (error) {
    if (request !== detailRequest) return
    globalStatus.textContent = error.message
    sessionDetail.hidden = true
    emptyState.hidden = false
  }
}

async function loadSessions (reset) {
  if (listPending) return
  listPending = true
  refreshButton.disabled = true
  if (reset) {
    sessions = []
    nextCursor = null
    selectedSessionId = null
    detailRequest += 1
    sessionDetail.hidden = true
    emptyState.hidden = false
  }
  renderSessionList()
  globalStatus.textContent = ''
  try {
    const page = unwrap(await api.listSessions(PAGE_SIZE, reset ? null : nextCursor))
    sessions = reset ? page.items : sessions.concat(page.items)
    nextCursor = page.nextCursor
  } catch (error) {
    globalStatus.textContent = error.message
  } finally {
    listPending = false
    refreshButton.disabled = false
    renderSessionList()
  }
}

async function exportSelected (format) {
  if (!selectedSessionId || exportPending) return
  exportPending = true
  exportButtons.forEach((button) => { button.disabled = true })
  exportStatus.textContent = '正在准备导出…'
  try {
    const result = unwrap(await api.exportSession(selectedSessionId, format))
    exportStatus.textContent = result.status === 'saved' ? '字幕原文已导出' : '已取消导出'
  } catch (error) {
    exportStatus.textContent = error.message
  } finally {
    exportPending = false
    exportButtons.forEach((button) => { button.disabled = false })
  }
}

function applyConfig (config) {
  document.documentElement.dataset.theme = config.theme === 'auto'
    ? (config.systemDark ? 'dark' : 'light')
    : config.theme
}

titlebar.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('button')) return
  dragging = true
  titlebar.classList.add('dragging')
  api.dragStart()
  try { titlebar.setPointerCapture(event.pointerId) } catch { /* noop */ }
})
function endDrag () {
  if (!dragging) return
  dragging = false
  titlebar.classList.remove('dragging')
  api.dragEnd()
}
window.addEventListener('pointerup', endDrag)
window.addEventListener('pointercancel', endDrag)
window.addEventListener('blur', endDrag)
titlebar.addEventListener('lostpointercapture', endDrag)

closeButton.addEventListener('click', () => api.close())
refreshButton.addEventListener('click', () => { void loadSessions(true) })
loadMore.addEventListener('click', () => { void loadSessions(false) })
exportButtons.forEach((button) => {
  button.addEventListener('click', () => { void exportSelected(button.dataset.export) })
})

api.onConfig(applyConfig)
api.getConfig().then(applyConfig).catch(() => {})
void loadSessions(true)
