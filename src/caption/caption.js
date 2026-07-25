'use strict'

/* 字幕窗：命中测试 + 拖动（role=caption）+ 锁定穿透 + 配置应用 + 假字幕流 */

const wrap = document.getElementById('wrap')
const card = document.getElementById('captionCard')
const captions = document.getElementById('captions')

let locked = false
let recording = false
let dragging = false
let ignoring = null
let lastX = 0, lastY = 0

// --------------------------------------------------------------------------
// 命中测试：指针在卡片上 → 实心；否则穿透。锁定态由主进程恒穿透，这里不干预。
// --------------------------------------------------------------------------
function applyHit (x, y) {
  if (dragging || locked) return
  const el = document.elementFromPoint(x, y)
  // 工具条“洞”内放行穿透，让工具条窗接管；洞外的卡片才算实心
  const overHole = !!(el && el.closest('.tb-hole'))
  const solid = !overHole && !!(el && el.closest('.caption-card'))
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
// 拖动（未锁定时可拖；role=caption）
// --------------------------------------------------------------------------
card.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || locked) return
  dragging = true
  card.classList.add('dragging')
  window.shell.dragStart('caption')
  try { card.setPointerCapture(e.pointerId) } catch { /* noop */ }
})
function endDrag () {
  if (!dragging) return
  dragging = false
  card.classList.remove('dragging')
  window.shell.dragEnd()
  applyHit(lastX, lastY)
}
window.addEventListener('pointerup', endDrag)
window.addEventListener('blur', endDrag)

// --------------------------------------------------------------------------
// 锁定：主进程已把本窗设为恒穿透；这里只更新视觉
// --------------------------------------------------------------------------
window.shell.onLock((on) => {
  locked = on
  wrap.dataset.locked = on ? 'on' : 'off'
  if (!on) { ignoring = null; applyHit(lastX, lastY) }
})

// --------------------------------------------------------------------------
// 配置
// --------------------------------------------------------------------------
function applyConfig (c) {
  const s = document.documentElement.style
  s.setProperty('--fs', c.fontSize + 'px')
  s.setProperty('--radius', c.radius + 'px')
  s.setProperty('--bar-alpha', String(c.opacity))
  s.setProperty('--max-lines', String(c.maxLines))
  document.documentElement.dataset.theme =
    c.theme === 'auto' ? (c.systemDark ? 'dark' : 'light') : c.theme
}
async function initConfig () {
  try { applyConfig(await window.shell.getConfig()) } catch { /* noop */ }
  window.shell.onConfig(applyConfig)
}
initConfig()

// --------------------------------------------------------------------------
// 录制状态 → 驱动假字幕流
// --------------------------------------------------------------------------
window.shell.onRec((on) => {
  recording = on
  if (on) startFakeStream()
  else stopFakeStream()
})

const SCRIPT = [
  '欢迎使用 Live Subtitle Agent 实时字幕',
  '我们下周先对齐一下 roadmap，再排 A/B test。',
  'The onboarding drop-off is mostly on step three.',
  '新用户流失主要集中在第三步，需要拉转化漏斗数据。',
  'Can we ship a shorter version this sprint?',
  '好，我先同步给设计，明天给结论。'
]
let si = 0, charTimer = null, lineTimer = null

function renderLines (prevText, partialText, isFinal) {
  captions.innerHTML = ''
  if (prevText) {
    const p = document.createElement('p')
    p.className = 'line prev'
    p.textContent = prevText
    captions.appendChild(p)
  }
  const cur = document.createElement('p')
  cur.className = 'line ' + (isFinal ? 'final' : 'partial')
  cur.textContent = partialText
  captions.appendChild(cur)
}
function typeLine (full, prevText, done) {
  let n = 0
  clearInterval(charTimer)
  charTimer = setInterval(() => {
    n += 1
    renderLines(prevText, full.slice(0, n), n >= full.length)
    if (n >= full.length) { clearInterval(charTimer); lineTimer = setTimeout(done, 900) }
  }, 55)
}
function nextLine (prevText) {
  const full = SCRIPT[si % SCRIPT.length]
  si += 1
  typeLine(full, prevText, () => { if (recording) nextLine(full) })
}
function startFakeStream () { stopFakeStream(); nextLine('') }
function stopFakeStream () { clearInterval(charTimer); clearTimeout(lineTimer); charTimer = lineTimer = null }
