'use strict'

let cfg = null
let runtimeSnapshot = null
let pendingPatch = {}
let patchTimer = null

const status = document.getElementById('settingsStatus')
const onboarding = document.getElementById('onboarding')
const presetButtons = [...document.querySelectorAll('.preset-card')]
const asrNote = document.getElementById('asrNote')

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
navItems.forEach((item) => {
  item.addEventListener('click', () => {
    navItems.forEach((node) => node.classList.toggle('active', node === item))
    panes.forEach((pane) => pane.classList.toggle('active', pane.dataset.pane === item.dataset.pane))
  })
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
document.querySelectorAll('.seg').forEach((seg) => {
  seg.addEventListener('click', (event) => {
    const button = event.target.closest('button')
    if (!button || button.disabled) return
    const key = SEG_KEY[seg.dataset.seg]
    let value = button.dataset.val
    if (NUM_SEG[seg.dataset.seg]) value = Number(value)
    void savePatch({ [key]: value })
  })
})

document.querySelectorAll('.toggle').forEach((toggle) => {
  toggle.addEventListener('click', () => {
    void savePatch({ [toggle.dataset.toggle]: !toggle.classList.contains('on') })
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

function setToggle (name, on) {
  const toggle = document.querySelector(`.toggle[data-toggle="${name}"]`)
  if (toggle) toggle.classList.toggle('on', !!on)
}

function reflect (next) {
  cfg = next
  onboarding.hidden = !!next.onboardingCompleted
  if (next.onboardingCompleted) presetButtons.forEach((button) => { button.disabled = false })
  setSeg('fontsize', next.fontSize)
  setSeg('theme', next.theme)
  setSeg('latency', next.latency)
  setToggle('bilingual', next.bilingual)
  setToggle('mic', next.mic)
  setToggle('loopback', next.loopback)
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
}

async function init () {
  window.shell.onConfig(reflect)
  window.shell.onSnapshot(reflectRuntime)
  try { reflect(await window.shell.getConfig()) } catch { /* noop */ }
  try { reflectRuntime(await window.shell.getSnapshot()) } catch { /* noop */ }
}

window.addEventListener('beforeunload', flushPatch)
init()
