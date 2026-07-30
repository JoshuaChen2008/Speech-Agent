'use strict'

const api = window.historyApi || {
  dragStart () {}, dragEnd () {}, close () {}, onConfig () {},
  getConfig: async () => ({ theme: 'dark', systemDark: true }),
  listSessions: async () => ({ ok: true, value: { items: [], nextCursor: null } }),
  getSessionPage: async () => ({ ok: false, error: { message: '历史记录不可用' } }),
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
const previousPageButton = document.getElementById('previousPage')
const nextPageButton = document.getElementById('nextPage')
const retryPageButton = document.getElementById('retryPage')
const rangeStatus = document.getElementById('rangeStatus')
const timeline = document.getElementById('timeline')
const exportButtons = [...document.querySelectorAll('[data-export]')]

let sessions = []
let sessionButtons = new Map()
let nextCursor = null
let selectedSessionId = null
let listPending = false
let detailGeneration = 0
let detailPending = false
let detailError = null
let detailPage = null
let detailPageIndex = 0
let detailCursorStack = [{ cursor: null, offset: 0 }]
let exportRequest = 0
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
  sessionButtons = new Map()
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
    sessionButtons.set(session.sessionId, button)
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

function selectSessionButton (sessionId) {
  if (selectedSessionId === sessionId) return
  sessionButtons.get(selectedSessionId)?.setAttribute('aria-current', 'false')
  selectedSessionId = sessionId
  sessionButtons.get(selectedSessionId)?.setAttribute('aria-current', 'true')
}

function assertHistoryPage (value, sessionId) {
  if (!value || typeof value !== 'object' || !value.session || value.session.sessionId !== sessionId) {
    throw new Error('历史记录分页响应无效')
  }
  if (!Array.isArray(value.items) || value.items.length > PAGE_SIZE) {
    throw new Error('历史记录分页响应无效')
  }
  if (!Number.isSafeInteger(value.totalCount) || value.totalCount < 0) {
    throw new Error('历史记录分页响应无效')
  }
  if (value.nextCursor !== null && (
    !Number.isSafeInteger(value.nextCursor?.t0Ms) ||
    !Number.isSafeInteger(value.nextCursor?.firstEventOrder)
  )) {
    throw new Error('历史记录分页响应无效')
  }
  return value
}

function updateDetailControls () {
  previousPageButton.disabled = detailPending || detailPageIndex === 0
  nextPageButton.disabled = detailPending || detailPage === null || detailPage.nextCursor === null
  retryPageButton.hidden = detailError === null
  retryPageButton.disabled = detailPending
  exportButtons.forEach((button) => {
    button.disabled = detailPending || exportPending || detailPage === null
  })
}

function invalidateExportPresentation () {
  exportRequest += 1
  exportPending = false
  exportStatus.textContent = ''
}

function renderDetailHeading (session, totalCount) {
  detailSource.textContent = `${sourceLabel(session.sourceId)} · ${stateLabel(session.state)}`
  detailTitle.textContent = fullDateTime(session.startedAt)
  detailMeta.textContent = `${durationText(session.startedAt, session.endedAt)}` +
    ` · ${totalCount} 条已定稿字幕`
}

function renderSelectedSessionHeading (sessionId) {
  const session = sessions.find((candidate) => candidate.sessionId === sessionId)
  if (!session) {
    detailSource.textContent = ''
    detailTitle.textContent = '字幕会话'
    detailMeta.textContent = ''
    return
  }
  renderDetailHeading(session, session.segmentCount)
}

function renderTimeline (page, offset) {
  timeline.textContent = ''
  if (page.items.length === 0) {
    const item = element('li', 'timeline-empty', '这个会话没有已定稿字幕。')
    item.setAttribute('role', 'listitem')
    timeline.appendChild(item)
    rangeStatus.textContent = page.totalCount === 0
      ? '共 0 条已定稿字幕'
      : `当前批次为空，共 ${page.totalCount} 条已定稿字幕`
    return
  }
  page.items.forEach((segment, index) => {
    const item = element('li', 'timeline-item')
    item.setAttribute('role', 'listitem')
    item.setAttribute('aria-posinset', String(offset + index + 1))
    item.setAttribute('aria-setsize', String(page.totalCount))
    const time = element('div', 'time-code')
    time.appendChild(element('strong', null, relativeTime(segment.t0Ms)))
    time.appendChild(element('span', null, wallTime(page.session.startedAt, segment.t0Ms)))
    item.appendChild(time)
    item.appendChild(element('div', 'caption-text', segment.text))
    timeline.appendChild(item)
  })
  rangeStatus.textContent = `第 ${offset + 1}–${offset + page.items.length} 条，共 ${page.totalCount} 条`
}

async function loadDetailPage (pageIndex) {
  const sessionId = selectedSessionId
  const cursorEntry = detailCursorStack[pageIndex]
  if (!sessionId || !cursorEntry || detailPending) return

  const generation = ++detailGeneration
  invalidateExportPresentation()
  detailPending = true
  detailError = null
  detailPage = null
  detailPageIndex = pageIndex
  timeline.textContent = ''
  timeline.setAttribute('aria-busy', 'true')
  rangeStatus.textContent = '正在读取字幕批次…'
  globalStatus.textContent = '正在读取会话…'
  updateDetailControls()
  try {
    const page = assertHistoryPage(
      unwrap(await api.getSessionPage(sessionId, PAGE_SIZE, cursorEntry.cursor)),
      sessionId
    )
    if (generation !== detailGeneration || sessionId !== selectedSessionId) return

    detailPage = page
    detailCursorStack = detailCursorStack.slice(0, pageIndex + 1)
    if (page.nextCursor !== null) {
      detailCursorStack.push({
        cursor: page.nextCursor,
        offset: cursorEntry.offset + page.items.length
      })
    }
    renderDetailHeading(page.session, page.totalCount)
    renderTimeline(page, cursorEntry.offset)
    emptyState.hidden = true
    sessionDetail.hidden = false
    globalStatus.textContent = ''
  } catch (error) {
    if (generation !== detailGeneration || sessionId !== selectedSessionId) return
    detailError = error
    globalStatus.textContent = error.message
    rangeStatus.textContent = '读取失败，请重试'
  } finally {
    if (generation !== detailGeneration || sessionId !== selectedSessionId) return
    detailPending = false
    timeline.setAttribute('aria-busy', 'false')
    updateDetailControls()
  }
}

async function selectSession (sessionId) {
  if (selectedSessionId === sessionId && (detailPending || detailPage !== null)) return
  if (selectedSessionId !== sessionId) {
    detailGeneration += 1
    detailPending = false
  }
  selectSessionButton(sessionId)
  detailCursorStack = [{ cursor: null, offset: 0 }]
  detailPageIndex = 0
  detailPage = null
  detailError = null
  renderSelectedSessionHeading(sessionId)
  timeline.textContent = ''
  emptyState.hidden = true
  sessionDetail.hidden = false
  await loadDetailPage(0)
}

function clearDetailSelection () {
  detailGeneration += 1
  invalidateExportPresentation()
  sessionButtons.get(selectedSessionId)?.setAttribute('aria-current', 'false')
  selectedSessionId = null
  detailPending = false
  detailError = null
  detailPage = null
  detailPageIndex = 0
  detailCursorStack = [{ cursor: null, offset: 0 }]
  timeline.textContent = ''
  timeline.setAttribute('aria-busy', 'false')
  rangeStatus.textContent = ''
  sessionDetail.hidden = true
  emptyState.hidden = false
  updateDetailControls()
}

async function loadSessions (reset) {
  if (listPending) return
  listPending = true
  refreshButton.disabled = true
  if (reset) {
    clearDetailSelection()
    sessions = []
    nextCursor = null
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
  const sessionId = selectedSessionId
  const generation = detailGeneration
  const request = ++exportRequest
  exportPending = true
  exportStatus.textContent = '正在准备导出…'
  updateDetailControls()
  try {
    const result = unwrap(await api.exportSession(sessionId, format))
    if (request !== exportRequest || generation !== detailGeneration || sessionId !== selectedSessionId) return
    exportStatus.textContent = result.status === 'saved' ? '字幕原文已导出' : '已取消导出'
  } catch (error) {
    if (request !== exportRequest || generation !== detailGeneration || sessionId !== selectedSessionId) return
    exportStatus.textContent = error.message
  } finally {
    if (request !== exportRequest || generation !== detailGeneration || sessionId !== selectedSessionId) return
    exportPending = false
    updateDetailControls()
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
previousPageButton.addEventListener('click', () => {
  if (!detailPending && detailPageIndex > 0) void loadDetailPage(detailPageIndex - 1)
})
nextPageButton.addEventListener('click', () => {
  if (!detailPending && detailPage !== null && detailPage.nextCursor !== null) {
    void loadDetailPage(detailPageIndex + 1)
  }
})
retryPageButton.addEventListener('click', () => {
  if (!detailPending && detailError !== null) void loadDetailPage(detailPageIndex)
})
exportButtons.forEach((button) => {
  button.addEventListener('click', () => { void exportSelected(button.dataset.export) })
})

updateDetailControls()
api.onConfig(applyConfig)
api.getConfig().then(applyConfig).catch(() => {})
void loadSessions(true)
