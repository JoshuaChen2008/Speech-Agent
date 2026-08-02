'use strict'

let cfg = null
let runtimeSnapshot = null
let modelStatus = null
let modelInstallPending = false
let refinementInstallPending = false
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
const refinementOverallState = document.getElementById('refinementOverallState')
const refinementInstallButton = document.getElementById('refinementInstallButton')
const refinementCancelButton = document.getElementById('refinementCancelButton')
const refinementProgress = document.getElementById('refinementProgress')
const refinementProgressBar = document.getElementById('refinementProgressBar')
const refinementProgressText = document.getElementById('refinementProgressText')
const refinementBytes = document.getElementById('refinementBytes')
const refinementError = document.getElementById('refinementError')
const refinementPreferenceToggle = document.getElementById('refinementPreferenceToggle')
const refinementPreferenceState = document.getElementById('refinementPreferenceState')
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
  refinementPreferenceToggle.checked = next.refinementEnabled === true
  if (next.refinementPreferenceFallback === true) {
    showStatus('精修模型不可用，已关闭精修偏好。请重新下载模型后再开启。')
  }
  updateRefinementPreferenceControl()
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
  updateRefinementPreferenceControl()
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
  core: Object.freeze({
    missing: '需要下载实时字幕模型与语音活动检测。',
    downloading: '正在下载核心字幕模型资源包。',
    verifying: '正在校验并安装核心字幕模型资源包。',
    ready: '实时字幕模型与语音活动检测已就绪。',
    error: '核心字幕模型资源包未能完成安装，可以重试。'
  }),
  refinement: Object.freeze({
    missing: '默认不下载；需要时请明确下载精修模型。',
    downloading: '正在下载精修模型；可取消，之后需明确继续下载。',
    verifying: '正在校验并安装精修模型。',
    ready: '精修模型已就绪；仍需再次明确开启。',
    error: '精修模型未能完成安装，可以重新下载。'
  })
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

function fallbackGroupStatus () {
  return {
    state: 'missing',
    progress: 0,
    downloadedBytes: 0,
    totalBytes: 0,
    error: null,
    canInstall: false
  }
}

function modelGroup (name) {
  const value = modelStatus && modelStatus[name]
  return value && typeof value === 'object' ? value : fallbackGroupStatus()
}

function isBusy (group) {
  return group.state === 'downloading' || group.state === 'verifying'
}

function renderGroupProgress (groupName, group, details, progress, progressBar, progressText, bytes, error) {
  const state = normalizeModelState(group.state)
  const percent = Math.round(clampProgress(group.progress) * 100)
  details.textContent = MODEL_STATE_DETAILS[groupName][state]
  progress.setAttribute('aria-valuenow', String(percent))
  progressBar.style.width = `${percent}%`
  progressText.textContent = `${percent}%`
  bytes.textContent = formatByteProgress(group.downloadedBytes, group.totalBytes)
  error.hidden = group.error === null
  error.textContent = group.error === null ? '' : safeModelErrorMessage(group.error)
}

function updateModelInstallControl () {
  const core = modelGroup('core')
  const refinement = modelGroup('refinement')
  const coreState = normalizeModelState(core.state)
  const refinementState = normalizeModelState(refinement.state)
  const coreBusy = isBusy(core)
  const refinementBusy = isBusy(refinement)
  const anyBusy = coreBusy || refinementBusy
  const runtimeKnown = runtimeSnapshot !== null
  const sessionActive = runtimeSnapshot !== null && runtimeSnapshot.sessionId !== null
  const canInstall = modelStatus !== null && modelStatus.canInstall === true
  const canInstallRefinement = modelStatus !== null && modelStatus.canInstallRefinement === true
  modelInstallButton.disabled = !runtimeKnown || modelInstallPending || sessionActive || anyBusy || coreState === 'ready' || !canInstall
  refinementInstallButton.disabled = !runtimeKnown || refinementInstallPending || sessionActive || anyBusy || refinementState === 'ready' || !canInstallRefinement
  refinementCancelButton.hidden = !refinementBusy
  refinementCancelButton.disabled = sessionActive || modelStatus === null || modelStatus.canCancelInstall !== true

  if (!runtimeKnown) {
    modelInstallButton.textContent = '正在读取'
    modelInstallButton.title = '正在读取字幕会话状态'
  } else if (sessionActive && !coreBusy && coreState !== 'ready') {
    modelInstallButton.textContent = '请先停止会话'
    modelInstallButton.title = '活动字幕会话期间不能安装模型资源'
  } else if (modelInstallPending || coreBusy) {
    modelInstallButton.textContent = coreState === 'verifying' ? '正在校验' : '正在下载'
    modelInstallButton.title = '核心字幕模型资源包正在处理'
  } else if (coreState === 'error') {
    modelInstallButton.textContent = '重试下载'
    modelInstallButton.title = '重新下载并校验核心字幕模型资源包'
  } else if (coreState === 'ready') {
    modelInstallButton.textContent = '已就绪'
    modelInstallButton.title = '核心字幕模型资源包已安装'
  } else if (coreState === 'missing') {
    modelInstallButton.textContent = '下载核心模型'
    modelInstallButton.title = '下载实时字幕模型与语音活动检测'
  } else {
    modelInstallButton.textContent = '正在读取'
    modelInstallButton.title = '正在读取核心字幕模型资源包状态'
  }

  if (!runtimeKnown) {
    refinementInstallButton.textContent = '正在读取'
    refinementInstallButton.title = '正在读取字幕会话状态'
  } else if (sessionActive && !refinementBusy && refinementState !== 'ready') {
    refinementInstallButton.textContent = '请先停止会话'
    refinementInstallButton.title = '活动字幕会话期间不能下载精修模型'
  } else if (refinementInstallPending || refinementBusy) {
    refinementInstallButton.textContent = refinementState === 'verifying' ? '正在校验' : '正在下载'
    refinementInstallButton.title = '精修模型正在处理'
  } else if (refinementState === 'ready') {
    refinementInstallButton.textContent = '已就绪'
    refinementInstallButton.title = '精修模型已安装；仍需明确开启'
  } else if (refinementState === 'error') {
    refinementInstallButton.textContent = '重新下载'
    refinementInstallButton.title = '重新下载并校验精修模型'
  } else if (refinement.downloadedBytes > 0) {
    refinementInstallButton.textContent = '继续下载'
    refinementInstallButton.title = '继续精修模型下载'
  } else {
    refinementInstallButton.textContent = '下载精修模型'
    refinementInstallButton.title = '下载可选精修模型'
  }
}

function updateRefinementPreferenceControl () {
  const refinement = modelGroup('refinement')
  const refinementBusy = isBusy(refinement)
  refinementPreferenceToggle.disabled = cfg === null || refinementBusy
  if (cfg === null) {
    refinementPreferenceState.textContent = '正在读取全局精修偏好。'
  } else if (cfg.refinementEnabled === true) {
    refinementPreferenceState.textContent = '已启用；只影响未来新会话，当前会话保持开始时的选择。'
  } else if (refinement.state === 'ready') {
    refinementPreferenceState.textContent = '模型已就绪；请明确开启，设置仅影响未来新会话。'
  } else {
    refinementPreferenceState.textContent = '默认关闭；模型缺失时尝试开启不会下载，请先下载精修模型。'
  }
}

function reflectModelStatus (next) {
  if (!next || next.schemaVersion !== 1 || !Array.isArray(next.resources) || !next.core || !next.refinement) return
  modelStatus = next
  const core = modelGroup('core')
  const refinement = modelGroup('refinement')
  renderGroupProgress('core', core, modelOverallState, modelProgress, modelProgressBar, modelProgressText, modelBytes, modelError)
  renderGroupProgress('refinement', refinement, refinementOverallState, refinementProgress, refinementProgressBar, refinementProgressText, refinementBytes, refinementError)

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

  updateModelInstallControl()
  updateRefinementPreferenceControl()
}

async function refreshModelStatus () {
  try {
    reflectModelStatus(await window.shell.getModelStatus())
  } catch {
    modelError.hidden = false
    modelError.textContent = '无法读取核心字幕模型资源包状态，请稍后重试。'
    refinementError.hidden = false
    refinementError.textContent = '无法读取精修模型资源状态，请稍后重试。'
    updateModelInstallControl()
    updateRefinementPreferenceControl()
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

refinementInstallButton.addEventListener('click', async () => {
  if (refinementInstallButton.disabled) return
  refinementInstallPending = true
  let installRequestFailed = false
  updateModelInstallControl()
  try {
    const result = await window.shell.installRefinementModel()
    installRequestFailed = !!(result && result.ok === false)
    const returnedStatus = result && result.value && result.value.schemaVersion === 1 ? result.value : null
    if (returnedStatus) reflectModelStatus(returnedStatus)
    if (installRequestFailed) showStatus(result?.error?.message || '精修模型下载请求未能完成。')
  } catch {
    installRequestFailed = true
  } finally {
    await refreshModelStatus()
    refinementInstallPending = false
    if (installRequestFailed && (!modelStatus || modelGroup('refinement').state !== 'error')) {
      refinementError.hidden = false
      refinementError.textContent = '精修模型下载请求未能完成，请稍后重试。'
    }
    updateModelInstallControl()
    updateRefinementPreferenceControl()
  }
})

refinementCancelButton.addEventListener('click', async () => {
  if (refinementCancelButton.disabled) return
  refinementCancelButton.disabled = true
  try {
    const result = await window.shell.cancelModelInstall()
    if (!result || result.ok !== true) showStatus(result?.error?.message || '取消下载请求未能完成。')
    else showStatus('已取消精修模型下载；需要时请明确继续下载。')
  } catch {
    showStatus('取消下载请求未能完成。')
  } finally {
    await refreshModelStatus()
  }
})

refinementPreferenceToggle.addEventListener('change', async () => {
  const enabled = refinementPreferenceToggle.checked
  refinementPreferenceToggle.disabled = true
  try {
    const result = await window.shell.setRefinementPreference(enabled)
    if (!result || result.ok !== true) {
      showStatus(result?.error?.message || '精修偏好未保存。')
      reflect(await window.shell.getConfig())
      return
    }
    reflect(result.value)
    showStatus('')
  } catch {
    showStatus('精修偏好未保存。')
    try { reflect(await window.shell.getConfig()) } catch { /* noop */ }
  } finally {
    updateRefinementPreferenceControl()
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
