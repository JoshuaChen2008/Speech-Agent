'use strict'

let cfg = null
let runtimeSnapshot = null
let modelStatus = null
let modelInstallPending = false
let pendingPatch = {}
let patchTimer = null

const status = document.getElementById('settingsStatus')
const onboarding = document.getElementById('onboarding')
const presetButtons = [...document.querySelectorAll('.preset-card')]
const sourceButtons = [...document.querySelectorAll('#audioSourceChoice button')]
const asrNote = document.getElementById('asrNote')
const modelOverallState = document.getElementById('modelOverallState')
const modelInstallButton = document.getElementById('modelInstallButton')
const modelProgress = document.getElementById('modelProgress')
const modelProgressBar = document.getElementById('modelProgressBar')
const modelProgressText = document.getElementById('modelProgressText')
const modelBytes = document.getElementById('modelBytes')
const modelError = document.getElementById('modelError')
const modelResourceRows = [...document.querySelectorAll('[data-resource-id]')]

function showStatus (message) {
  status.textContent = message || ''
}

document.getElementById('close').addEventListener('click', () => window.shell.closeSettings())

const titlebar = document.querySelector('.titlebar')
let dragging = false
titlebar.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('button')) return
  dragging = true
  titlebar.classList.add('dragging')
  window.shell.dragStart()
  try { titlebar.setPointerCapture(event.pointerId) } catch { /* noop */ }
})
function endDrag () {
  if (!dragging) return
  dragging = false
  titlebar.classList.remove('dragging')
  window.shell.dragEnd()
}
window.addEventListener('pointerup', endDrag)
window.addEventListener('pointercancel', endDrag)
titlebar.addEventListener('lostpointercapture', endDrag)
window.addEventListener('blur', endDrag)

const navItems = [...document.querySelectorAll('.nav-item')]
const panes = [...document.querySelectorAll('.pane')]
function activatePane (name) {
  const selected = navItems.find((item) => item.dataset.pane === name)
  if (!selected) return false
  navItems.forEach((node) => node.classList.toggle('active', node === selected))
  panes.forEach((pane) => pane.classList.toggle('active', pane.dataset.pane === name))
  return true
}

navItems.forEach((item) => {
  item.addEventListener('click', () => activatePane(item.dataset.pane))
})

async function savePatch (patch) {
  try {
    const result = await window.shell.setConfig(patch)
    if (!result.ok) {
      showStatus(result.message)
      reflect(await window.shell.getConfig())
      return false
    }
    showStatus('')
    return true
  } catch {
    showStatus('设置未保存')
    try { reflect(await window.shell.getConfig()) } catch { /* noop */ }
    return false
  }
}

function queuePatch (patch) {
  pendingPatch = { ...pendingPatch, ...patch }
  clearTimeout(patchTimer)
  patchTimer = setTimeout(flushPatch, 120)
}

function flushPatch () {
  clearTimeout(patchTimer)
  patchTimer = null
  const patch = pendingPatch
  pendingPatch = {}
  if (Object.keys(patch).length > 0) void savePatch(patch)
}

const SEG_KEY = { fontsize: 'fontSize', theme: 'theme', latency: 'latency' }
const NUM_SEG = { fontsize: true, latency: true }
document.querySelectorAll('.seg[data-seg]').forEach((seg) => {
  seg.addEventListener('click', (event) => {
    const button = event.target.closest('button')
    if (!button || button.disabled) return
    const key = SEG_KEY[seg.dataset.seg]
    let value = button.dataset.val
    if (NUM_SEG[seg.dataset.seg]) value = Number(value)
    void savePatch({ [key]: value })
  })
})

sourceButtons.forEach((button) => {
  button.addEventListener('click', async () => {
    if (button.disabled || button.getAttribute('aria-checked') === 'true') return
    sourceButtons.forEach((item) => { item.disabled = true })
    showStatus('正在切换监听模式…')
    try {
      const result = await window.shell.selectPreset(button.dataset.preset)
      if (!result.ok) {
        showStatus(result.message)
        reflect(await window.shell.getConfig())
      } else {
        showStatus('')
      }
    } catch {
      showStatus('监听模式未保存')
      try { reflect(await window.shell.getConfig()) } catch { /* noop */ }
    } finally {
      const active = runtimeSnapshot && runtimeSnapshot.sessionId !== null
      sourceButtons.forEach((item) => { item.disabled = !!active })
    }
  })
})

const opacity = document.getElementById('opacity')
const opacityVal = document.getElementById('opacityVal')
opacity.addEventListener('input', () => {
  opacityVal.textContent = Number(opacity.value).toFixed(2)
  queuePatch({ opacity: Number(opacity.value) })
})

const toolbarOpacity = document.getElementById('toolbarOpacity')
const toolbarOpacityVal = document.getElementById('toolbarOpacityVal')
toolbarOpacity.addEventListener('input', () => {
  toolbarOpacityVal.textContent = Number(toolbarOpacity.value).toFixed(2)
  queuePatch({ toolbarOpacity: Number(toolbarOpacity.value) })
})

const radius = document.getElementById('radius')
const radiusVal = document.getElementById('radiusVal')
radius.addEventListener('input', () => {
  radiusVal.textContent = radius.value + ' px'
  queuePatch({ radius: Number(radius.value) })
})

const barColor = document.getElementById('barColor')
const barColorVal = document.getElementById('barColorVal')
const barColorReset = document.getElementById('barColorReset')
barColor.addEventListener('input', () => queuePatch({ barColor: barColor.value }))
barColorReset.addEventListener('click', () => { void savePatch({ barColor: null }) })

presetButtons.forEach((button) => {
  button.addEventListener('click', async () => {
    presetButtons.forEach((item) => { item.disabled = true })
    showStatus('正在保存场景…')
    try {
      const result = await window.shell.selectPreset(button.dataset.preset)
      if (!result.ok) {
        showStatus(result.message)
        presetButtons.forEach((item) => { item.disabled = false })
      } else {
        showStatus('')
      }
    } catch {
      showStatus('场景未保存')
      presetButtons.forEach((item) => { item.disabled = false })
    }
  })
})

function setSeg (segName, value) {
  const seg = document.querySelector(`.seg[data-seg="${segName}"]`)
  if (!seg) return
  ;[...seg.children].forEach((button) => button.classList.toggle('on', String(button.dataset.val) === String(value)))
}

function reflect (next) {
  cfg = next
  onboarding.hidden = !!next.onboardingCompleted
  if (next.onboardingCompleted) presetButtons.forEach((button) => { button.disabled = false })
  setSeg('fontsize', next.fontSize)
  setSeg('theme', next.theme)
  setSeg('latency', next.latency)
  sourceButtons.forEach((button) => {
    const checked = next[button.dataset.source] === true
    button.classList.toggle('on', checked)
    button.setAttribute('aria-checked', String(checked))
  })
  opacity.value = next.opacity
  opacityVal.textContent = Number(next.opacity).toFixed(2)
  toolbarOpacity.value = next.toolbarOpacity
  toolbarOpacityVal.textContent = Number(next.toolbarOpacity).toFixed(2)
  radius.value = next.radius
  radiusVal.textContent = next.radius + ' px'
  const custom = typeof next.barColor === 'string' && next.barColor.length > 0
  if (custom) barColor.value = next.barColor
  barColorVal.textContent = custom ? next.barColor : '跟随主题'
  barColorReset.disabled = !custom
  document.documentElement.dataset.theme =
    next.theme === 'auto' ? (next.systemDark ? 'dark' : 'light') : next.theme
}

const PROFILE_BY_LATENCY = { 160: 'fast', 480: 'balanced', 960: 'accurate' }
function reflectRuntime (snapshot) {
  if (!snapshot || (runtimeSnapshot && snapshot.revision < runtimeSnapshot.revision)) return
  runtimeSnapshot = snapshot
  sourceButtons.forEach((button) => { button.disabled = snapshot.sessionId !== null })
  const profiles = snapshot.capabilities.availableProfiles
  const buttons = document.querySelectorAll('.seg[data-seg="latency"] button')
  buttons.forEach((button) => {
    button.disabled = !profiles.includes(PROFILE_BY_LATENCY[button.dataset.val])
  })
  /* 文案跟随快照，不硬编码 gate 状态：无档位时优先展示后端给出的
     limitation 原句（如「模型未就绪」），有档位时按契约说明能力来源。 */
  const limitation = snapshot.capabilities.limitations.find((item) => item.capability === 'start')
  asrNote.textContent = profiles.length === 0
    ? (limitation ? limitation.message : '当前没有可用识别档位。')
    : '识别档位由本机已就绪的模型决定，不可用的档位已停用。'
  updateModelInstallControl()
}

const MODEL_STATES = Object.freeze(['missing', 'downloading', 'verifying', 'ready', 'error'])
const MODEL_STATE_LABELS = Object.freeze({
  missing: '未安装',
  downloading: '正在下载',
  verifying: '正在校验',
  ready: '已就绪',
  error: '安装失败'
})
const MODEL_STATE_DETAILS = Object.freeze({
  missing: '需要下载三项本地 ASR 资源',
  downloading: '正在下载本地资源，可以关闭应用后继续',
  verifying: '正在校验并安装本地资源',
  ready: '实时字幕、离线精修与语音活动检测均已就绪',
  error: '资源未能完成安装，可以安全重试'
})

function normalizeModelState (value) {
  return MODEL_STATES.includes(value) ? value : 'missing'
}

function clampProgress (value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 0
}

function formatBytes (value) {
  let bytes = Number(value)
  if (!Number.isFinite(bytes) || bytes < 0) bytes = 0
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let unit = 0
  while (bytes >= 1024 && unit < units.length - 1) {
    bytes /= 1024
    unit += 1
  }
  const digits = unit === 0 || bytes >= 100 ? 0 : 1
  return `${bytes.toFixed(digits)} ${units[unit]}`
}

function formatByteProgress (downloaded, total) {
  return `${formatBytes(downloaded)} / ${formatBytes(total)}`
}

/* 不把后端错误原文直接放进 DOM：即使未来底层错误意外带路径，设置页也只给出
   可执行的安全说明。错误 code 是公开契约，用于选择说明，不用于拼接展示。 */
function safeModelErrorMessage (error) {
  const code = error && typeof error.code === 'string' ? error.code.toUpperCase() : ''
  if (/HASH|INTEGRITY|CHECKSUM|SIZE/.test(code)) return '资源校验未通过，请重新下载。'
  if (/NETWORK|DOWNLOAD|CONNECTION|HTTP/.test(code)) return '下载未完成，请检查网络后重试。'
  if (/ARCHIVE|EXTRACT|CONTENT/.test(code)) return '资源包无法安全安装，请重新下载。'
  if (/SESSION|ACTIVE|BUSY/.test(code)) return '请先停止当前字幕会话，再安装模型资源。'
  if (/ABORT|CANCEL|SHUTDOWN/.test(code)) return '安装已中断，下次可以继续下载。'
  return '模型资源未能完成安装，请重试。'
}

function updateModelInstallControl () {
  const state = modelStatus ? normalizeModelState(modelStatus.state) : null
  const busy = state === 'downloading' || state === 'verifying'
  const runtimeKnown = runtimeSnapshot !== null
  const sessionActive = runtimeSnapshot !== null && runtimeSnapshot.sessionId !== null
  const canInstall = modelStatus !== null && modelStatus.canInstall === true
  modelInstallButton.disabled = !runtimeKnown || modelInstallPending || sessionActive || busy || state === 'ready' || !canInstall

  if (!runtimeKnown) {
    modelInstallButton.textContent = '正在读取'
    modelInstallButton.title = '正在读取字幕会话状态'
  } else if (sessionActive && !busy && state !== 'ready') {
    modelInstallButton.textContent = '请先停止会话'
    modelInstallButton.title = '活动字幕会话期间不能安装模型资源'
  } else if (modelInstallPending || busy) {
    modelInstallButton.textContent = state === 'verifying' ? '正在校验' : '正在下载'
    modelInstallButton.title = '模型资源正在处理'
  } else if (state === 'error') {
    modelInstallButton.textContent = '重试'
    modelInstallButton.title = '重新下载并校验模型资源'
  } else if (state === 'ready') {
    modelInstallButton.textContent = '已就绪'
    modelInstallButton.title = '模型资源已安装'
  } else if (state === 'missing') {
    modelInstallButton.textContent = '下载模型'
    modelInstallButton.title = '下载本地字幕识别所需资源'
  } else {
    modelInstallButton.textContent = '正在读取'
    modelInstallButton.title = '正在读取模型资源状态'
  }
}

function reflectModelStatus (next) {
  if (!next || next.schemaVersion !== 1 || !Array.isArray(next.resources)) return
  modelStatus = next
  const state = normalizeModelState(next.state)
  const progress = clampProgress(next.progress)
  const percent = Math.round(progress * 100)

  modelOverallState.textContent = MODEL_STATE_DETAILS[state]
  modelProgress.setAttribute('aria-valuenow', String(percent))
  modelProgressBar.style.width = `${percent}%`
  modelProgressText.textContent = `${percent}%`
  modelBytes.textContent = formatByteProgress(next.downloadedBytes, next.totalBytes)

  const resources = new Map(next.resources.map((resource) => [resource.id, resource]))
  modelResourceRows.forEach((row) => {
    const resource = resources.get(row.dataset.resourceId) || {
      state: 'missing',
      downloadedBytes: 0,
      totalBytes: 0
    }
    const resourceState = normalizeModelState(resource.state)
    row.dataset.state = resourceState
    const resourcePercent = Math.round(clampProgress(resource.progress) * 100)
    row.querySelector('[data-field="state"]').textContent =
      resourceState === 'downloading' || resourceState === 'verifying'
        ? `${MODEL_STATE_LABELS[resourceState]} · ${resourcePercent}%`
        : MODEL_STATE_LABELS[resourceState]
    row.querySelector('[data-field="bytes"]').textContent = formatByteProgress(
      resource.downloadedBytes,
      resource.totalBytes
    )
  })

  modelError.hidden = next.error === null
  modelError.textContent = next.error === null ? '' : safeModelErrorMessage(next.error)
  updateModelInstallControl()
}

async function refreshModelStatus () {
  try {
    reflectModelStatus(await window.shell.getModelStatus())
  } catch {
    modelError.hidden = false
    modelError.textContent = '无法读取模型资源状态，请稍后重试。'
    updateModelInstallControl()
  }
}

modelInstallButton.addEventListener('click', async () => {
  if (modelInstallButton.disabled) return
  modelInstallPending = true
  let installRequestFailed = false
  updateModelInstallControl()
  try {
    const result = await window.shell.installModelResources()
    installRequestFailed = !!(result && result.ok === false)
    const returnedStatus = result && result.schemaVersion === 1
      ? result
      : (result && result.value && result.value.schemaVersion === 1 ? result.value : null)
    if (returnedStatus) reflectModelStatus(returnedStatus)
  } catch {
    installRequestFailed = true
  } finally {
    await refreshModelStatus()
    modelInstallPending = false
    if (installRequestFailed && (!modelStatus || modelStatus.state !== 'error')) {
      modelError.hidden = false
      modelError.textContent = '安装请求未能完成，请稍后重试。'
    }
    updateModelInstallControl()
  }
})

async function init () {
  window.shell.onConfig(reflect)
  window.shell.onSnapshot(reflectRuntime)
  window.shell.onModelStatus(reflectModelStatus)
  window.shell.onNavigate((pane) => activatePane(String(pane || '')))
  try { reflect(await window.shell.getConfig()) } catch { /* noop */ }
  try { reflectRuntime(await window.shell.getSnapshot()) } catch { /* noop */ }
  await refreshModelStatus()
}

window.addEventListener('beforeunload', flushPatch)
init()
