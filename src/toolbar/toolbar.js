'use strict'

/* 工具条窗：命中测试 + 拖动（role=toolbar）+ 按钮 + 锁定/录制视觉同步 */

const wrap = document.getElementById('wrap')
const toolbar = document.getElementById('toolbar')

let locked = false
let dragging = false
let ignoring = null
let lastX = 0, lastY = 0

// --------------------------------------------------------------------------
// 命中测试：指针在条上 → 实心；否则穿透（露出四周留白/圆角外）
// --------------------------------------------------------------------------
function applyHit (x, y) {
  if (dragging) return
  const el = document.elementFromPoint(x, y)
  const solid = !!(el && el.closest('.toolbar'))
  const next = !solid
  if (next !== ignoring) {
    ignoring = next
    window.shell.mouseThrough(next)
  }
}
let hitQueued = false
document.addEventListener('mousemove', (e) => {
  lastX = e.clientX; lastY = e.clientY
  if (hitQueued) return
  hitQueued = true
  requestAnimationFrame(() => { hitQueued = false; applyHit(lastX, lastY) })
})
window.shell.mouseThrough(true)
ignoring = true

// --------------------------------------------------------------------------
// 拖动：未锁定 → 拖整个单元（role=toolbar，主进程改移字幕窗并停靠）
//       已锁定 → 独立拖工具条自身
// --------------------------------------------------------------------------
toolbar.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('.tb')) return
  dragging = true
  toolbar.classList.add('dragging')
  window.shell.dragStart('toolbar')
  try { toolbar.setPointerCapture(e.pointerId) } catch { /* noop */ }
})
function endDrag () {
  if (!dragging) return
  dragging = false
  toolbar.classList.remove('dragging')
  window.shell.dragEnd()
  applyHit(lastX, lastY)
}
window.addEventListener('pointerup', endDrag)
window.addEventListener('blur', endDrag)

// --------------------------------------------------------------------------
// 按钮
// --------------------------------------------------------------------------
toolbar.addEventListener('click', (e) => {
  const btn = e.target.closest('.tb')
  if (!btn) return
  switch (btn.dataset.act) {
    case 'toggle':   window.shell.recToggle(); break
    case 'history':  console.log('[skeleton] history panel — TODO'); break
    case 'lock':     window.shell.lockToggle(); break
    case 'settings': window.shell.action('settings'); break
    case 'close':    window.shell.action('close'); break
  }
})

// --------------------------------------------------------------------------
// 状态同步
// --------------------------------------------------------------------------
window.shell.onRec((on) => { wrap.dataset.state = on ? 'recording' : 'idle' })
window.shell.onLock((on) => { locked = on; wrap.dataset.locked = on ? 'on' : 'off' })

// 主题
function applyConfig (c) {
  document.documentElement.dataset.theme =
    c.theme === 'auto' ? (c.systemDark ? 'dark' : 'light') : c.theme
}
async function initConfig () {
  try { applyConfig(await window.shell.getConfig()) } catch { /* noop */ }
  window.shell.onConfig(applyConfig)
}
initConfig()
