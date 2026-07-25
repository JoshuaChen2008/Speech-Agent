'use strict'

/* 设置窗：所有控件与主进程配置双向绑定。
   改动 → setConfig → 主进程写盘并广播 → 字幕条实时生效。 */

let cfg = null

// 关闭
document.getElementById('close').addEventListener('click', () => window.shell.closeSettings())

// 顶栏手动拖动（绕开 app-region 在亚克力窗上的拖动闪烁）
const titlebar = document.querySelector('.titlebar')
let dragging = false
titlebar.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('button')) return
  dragging = true
  titlebar.classList.add('dragging')
  window.shell.dragStart()
  try { titlebar.setPointerCapture(e.pointerId) } catch { /* noop */ }
})
function endDrag () {
  if (!dragging) return
  dragging = false
  titlebar.classList.remove('dragging')
  window.shell.dragEnd()
}
window.addEventListener('pointerup', endDrag)
window.addEventListener('blur', endDrag)

// 左导航切换
const navItems = [...document.querySelectorAll('.nav-item')]
const panes = [...document.querySelectorAll('.pane')]
navItems.forEach((it) => {
  it.addEventListener('click', () => {
    navItems.forEach((n) => n.classList.toggle('active', n === it))
    panes.forEach((p) => p.classList.toggle('active', p.dataset.pane === it.dataset.pane))
  })
})

// 配置键 ← → 控件
const SEG_KEY = { fontsize: 'fontSize', theme: 'theme', latency: 'latency' }
const NUM_SEG = { fontsize: true, latency: true }   // 值需转数字

// 分段控件
document.querySelectorAll('.seg').forEach((seg) => {
  seg.addEventListener('click', (e) => {
    const btn = e.target.closest('button')
    if (!btn) return
    ;[...seg.children].forEach((b) => b.classList.toggle('on', b === btn))
    const key = SEG_KEY[seg.dataset.seg]
    let val = btn.dataset.val
    if (NUM_SEG[seg.dataset.seg]) val = Number(val)
    window.shell.setConfig({ [key]: val })
  })
})

// toggle
document.querySelectorAll('.toggle').forEach((t) => {
  t.addEventListener('click', () => {
    const on = !t.classList.contains('on')
    t.classList.toggle('on', on)
    window.shell.setConfig({ [t.dataset.toggle]: on })
  })
})

// 滑杆（input 回显，change 落库；拖动过程也实时生效 → 用 input 直接写）
const opacity = document.getElementById('opacity')
const opacityVal = document.getElementById('opacityVal')
opacity.addEventListener('input', () => {
  opacityVal.textContent = Number(opacity.value).toFixed(2)
  window.shell.setConfig({ opacity: Number(opacity.value) })
})

const radius = document.getElementById('radius')
const radiusVal = document.getElementById('radiusVal')
radius.addEventListener('input', () => {
  radiusVal.textContent = radius.value + ' px'
  window.shell.setConfig({ radius: Number(radius.value) })
})

// --------------------------------------------------------------------------
// 用配置回填所有控件
// --------------------------------------------------------------------------
function setSeg (segName, value) {
  const seg = document.querySelector(`.seg[data-seg="${segName}"]`)
  if (!seg) return
  ;[...seg.children].forEach((b) => b.classList.toggle('on', String(b.dataset.val) === String(value)))
}
function setToggle (name, on) {
  const t = document.querySelector(`.toggle[data-toggle="${name}"]`)
  if (t) t.classList.toggle('on', !!on)
}

function reflect (c) {
  cfg = c
  setSeg('fontsize', c.fontSize)
  setSeg('theme', c.theme)
  setSeg('latency', c.latency)
  setToggle('bilingual', c.bilingual)
  setToggle('mic', c.mic)
  setToggle('loopback', c.loopback)
  opacity.value = c.opacity
  opacityVal.textContent = Number(c.opacity).toFixed(2)
  radius.value = c.radius
  radiusVal.textContent = c.radius + ' px'
  // 设置窗自身也跟随主题
  document.documentElement.dataset.theme =
    c.theme === 'auto' ? (c.systemDark ? 'dark' : 'light') : c.theme
}

async function init () {
  try { reflect(await window.shell.getConfig()) } catch { /* noop */ }
  // 其他窗口改了配置也同步过来
  window.shell.onConfig(reflect)
}
init()
