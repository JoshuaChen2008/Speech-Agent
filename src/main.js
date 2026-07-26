'use strict'

const { app, BrowserWindow, ipcMain, nativeTheme, screen, globalShortcut } = require('electron')
const path = require('node:path')
const config = require('./config')

/** @type {BrowserWindow | null} */ let captionWin = null
/** @type {BrowserWindow | null} */ let toolbarWin = null
/** @type {BrowserWindow | null} */ let settingsWin = null

let locked = false
let recording = false

// 尺寸常量（DIP）
const MARGIN = 20          // 字幕窗内卡片四周留白（给阴影）
const TB_MARGIN = 16       // 工具条窗内条四周留白
const INSET = 12           // 工具条距卡片右上角内缩
const CAP_W = 880 + MARGIN * 2      // 默认值；用户拉伸后由 config 覆盖
const CAP_H = 150 + MARGIN * 2

// 字幕窗尺寸上下限（DIP，含窗口留白）。
// 高 140 刚好容得下 38px 单行 + 上下留白；420 约为 38px 六行。
// 宽上限还会再被当前屏幕工作区封顶，见 captionLimits()。
const CAP_LIMITS = { minW: 480, maxW: 1600, minH: 140, maxH: 420 }
// 工具条内容宽按最坏情况固定：error 态（图标 + 说明文字 + 开始/停止/重试/下一步）。
// 常态（idle / listening / paused …）只有 287–319，条自适应收窄，
// 多出来的区域全透明并逐像素穿透，所以窗口宽不等于遮挡宽。
//
// 568 的由来：Electron @125% DPI 实测 error 态 544；说明文字有 160px 上限
// （phases.css .status-message），因此理论上界约 554，再留 14 余量。
// 条在窗内右对齐，dock() 按右沿反推，公式不受宽度影响。
const TB_W = 568 + TB_MARGIN * 2
const TB_H = 40 + TB_MARGIN * 2

// ---------------------------------------------------------------------------
// 配置广播
// ---------------------------------------------------------------------------
function payload () {
  return { ...config.get(), systemDark: nativeTheme.shouldUseDarkColors }
}
function broadcastConfig () {
  const p = payload()
  for (const w of [captionWin, toolbarWin, settingsWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('config:changed', p)
  }
}

// ---------------------------------------------------------------------------
// 通用透明浮窗
// ---------------------------------------------------------------------------
function makeOverlay (w, h, x, y, file, focusable = true) {
  const win = new BrowserWindow({
    width: w, height: h, x, y,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  win.loadFile(file)
  return win
}

function clamp (value, min, max) {
  return Math.min(max, Math.max(min, Math.round(value)))
}

/** 尺寸上限还要受当前屏幕工作区约束，免得拉出屏幕外。 */
function captionLimits (win) {
  const display = win && !win.isDestroyed()
    ? screen.getDisplayMatching(win.getBounds())
    : screen.getPrimaryDisplay()
  const area = display.workAreaSize
  return {
    minW: CAP_LIMITS.minW,
    maxW: Math.min(CAP_LIMITS.maxW, area.width),
    minH: CAP_LIMITS.minH,
    maxH: Math.min(CAP_LIMITS.maxH, area.height)
  }
}

function createWindows () {
  const { workAreaSize } = screen.getPrimaryDisplay()
  const saved = config.get()
  const capW = clamp(saved.captionWidth || CAP_W, CAP_LIMITS.minW, Math.min(CAP_LIMITS.maxW, workAreaSize.width))
  const capH = clamp(saved.captionHeight || CAP_H, CAP_LIMITS.minH, Math.min(CAP_LIMITS.maxH, workAreaSize.height))
  const cx = Math.round((workAreaSize.width - capW) / 2)
  const cy = 72

  // 字幕窗 focusable:false → 点击它不会把它抬到工具条之上，z 序稳定
  captionWin = makeOverlay(capW, capH, cx, cy, path.join(__dirname, 'caption', 'index.html'), false)
  captionWin.setResizable(true)
  toolbarWin = makeOverlay(TB_W, TB_H, cx, cy, path.join(__dirname, 'toolbar', 'index.html'), true)

  captionWin.webContents.on('console-message', (e) => console.log('[caption]', e.message))
  toolbarWin.webContents.on('console-message', (e) => console.log('[toolbar]', e.message))

  const raiseToolbar = () => { if (toolbarWin && !toolbarWin.isDestroyed()) toolbarWin.moveTop() }
  captionWin.once('ready-to-show', () => { captionWin.show(); raiseToolbar() })
  toolbarWin.once('ready-to-show', () => { toolbarWin.show(); dock() })
  // 两窗都显示后再兜底提一次，让工具条尽量在最上（配合字幕卡“洞”双保险）
  setTimeout(raiseToolbar, 300)

  captionWin.on('closed', () => { stopResize(); captionWin = null })
  toolbarWin.on('closed', () => { toolbarWin = null })
}

// 工具条停靠到字幕卡片右上角内部
function dock () {
  if (!captionWin || captionWin.isDestroyed() || !toolbarWin || toolbarWin.isDestroyed()) return
  const c = captionWin.getBounds()
  const t = toolbarWin.getBounds()
  const cardRight = c.x + c.width - MARGIN
  const cardTop = c.y + MARGIN
  const x = Math.round(cardRight - INSET - (t.width - TB_MARGIN))
  const y = Math.round(cardTop + INSET - TB_MARGIN)
  // 用 setBounds 固定宽高，避免 HiDPI 下 setPosition 反复调用导致尺寸累积增长
  toolbarWin.setBounds({ x, y, width: TB_W, height: TB_H })
  toolbarWin.moveTop()   // 停靠后保持在字幕窗之上
}

// 各窗的“目标尺寸”（DIP）—— 拖动/停靠时恒定命令，杜绝漂移。
// 字幕窗尺寸现在由用户拉伸决定，所以读实时 bounds；否则一拖就被重置回默认值。
function intendedSize (win) {
  if (win === toolbarWin) return { width: TB_W, height: TB_H }
  const b = win.getBounds()
  return { width: b.width, height: b.height }
}

// ---------------------------------------------------------------------------
// 设置窗（亚克力，独立第三窗）
// ---------------------------------------------------------------------------
function openSettingsWindow () {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return }
  settingsWin = new BrowserWindow({
    width: 880, height: 620,
    titleBarStyle: 'hidden',
    backgroundMaterial: 'acrylic',
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    skipTaskbar: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  settingsWin.once('ready-to-show', () => settingsWin.show())
  settingsWin.on('closed', () => { settingsWin = null })
  settingsWin.loadFile(path.join(__dirname, 'settings', 'settings.html'))
}

// ---------------------------------------------------------------------------
// 手动拖动
//   role='toolbar' 且未锁定 → 拖动的是整个单元（移动字幕窗，工具条跟随停靠）
//   其余 → 拖动发起窗自身
// ---------------------------------------------------------------------------
let dragState = null

function dragTick () {
  if (!dragState) return
  const p = screen.getCursorScreenPoint()
  const { win, offX, offY, w, h, redock } = dragState
  if (win && !win.isDestroyed()) {
    // 固定宽高的 setBounds，避免 HiDPI 下 setPosition 累积放大窗口
    win.setBounds({ x: p.x - offX, y: p.y - offY, width: w, height: h })
    if (redock) dock()
  }
  dragState.timer = setTimeout(dragTick, 8)
}

ipcMain.on('win-drag:start', (e, role) => {
  const sender = BrowserWindow.fromWebContents(e.sender)
  if (!sender || sender.isDestroyed()) return
  let win = sender
  let redock = false
  if (role === 'toolbar' && !locked) { win = captionWin; redock = true }   // 嵌入态：拖工具条=拖整个单元
  else if (sender === captionWin && !locked) { redock = true }
  if (!win || win.isDestroyed()) return
  const p = screen.getCursorScreenPoint()
  const b = win.getBounds()
  const size = intendedSize(win)
  dragState = { win, offX: p.x - b.x, offY: p.y - b.y, w: size.width, h: size.height, redock, timer: null }
  dragTick()
})

ipcMain.on('win-drag:end', () => {
  if (dragState && dragState.timer) clearTimeout(dragState.timer)
  dragState = null
})

// ---------------------------------------------------------------------------
// 手动拉伸（只有字幕窗可拉）
//   透明无边框窗在 Windows 上没有可用的原生拉伸边，路子与拖动一致：
//   渲染层判定贴边并发出意图，主进程轮询光标改 bounds。
//   被拖的那条边跟着光标走，对面那条边钉住不动。
// ---------------------------------------------------------------------------
let resizeState = null

function resizeTick () {
  if (!resizeState) return
  const { win, edge, start, origin, limits } = resizeState
  if (win && !win.isDestroyed()) {
    const p = screen.getCursorScreenPoint()
    const dx = p.x - origin.x
    const dy = p.y - origin.y

    let width = start.width
    let height = start.height
    if (edge.includes('e')) width = start.width + dx
    if (edge.includes('w')) width = start.width - dx
    if (edge.includes('s')) height = start.height + dy
    if (edge.includes('n')) height = start.height - dy

    width = clamp(width, limits.minW, limits.maxW)
    height = clamp(height, limits.minH, limits.maxH)

    // 钉住对面那条边：夹紧之后也要用夹紧后的尺寸反推原点，否则到达上下限时窗口会漂移
    const x = edge.includes('w') ? start.x + (start.width - width) : start.x
    const y = edge.includes('n') ? start.y + (start.height - height) : start.y

    win.setBounds({ x, y, width, height })
    dock()
  }
  resizeState.timer = setTimeout(resizeTick, 8)
}

function stopResize () {
  if (!resizeState) return
  if (resizeState.timer) clearTimeout(resizeState.timer)
  const { win } = resizeState
  resizeState = null
  if (win && !win.isDestroyed()) {
    const b = win.getBounds()
    config.set({ captionWidth: b.width, captionHeight: b.height })
    broadcastConfig()
  }
}

ipcMain.on('win-resize:start', (e, edge) => {
  const sender = BrowserWindow.fromWebContents(e.sender)
  // 只有字幕窗可拉伸；工具条宽度由内容决定，设置窗是普通窗
  if (!sender || sender !== captionWin || sender.isDestroyed()) return
  if (locked) return
  if (!/^[nsew]{1,2}$/.test(edge)) return

  stopResize()
  resizeState = {
    win: sender,
    edge,
    start: sender.getBounds(),
    origin: screen.getCursorScreenPoint(),
    limits: captionLimits(sender),
    timer: null
  }
  resizeTick()
})

ipcMain.on('win-resize:end', stopResize)

// ---------------------------------------------------------------------------
// 锁定
// ---------------------------------------------------------------------------
function applyLock (on) {
  locked = on
  // 锁定意味着字幕卡钉死且恒穿透，进行中的拉伸必须立刻收尾，
  // 否则 8ms 定时器会继续按旧意图改 bounds
  if (on) stopResize()
  if (captionWin && !captionWin.isDestroyed()) {
    if (on) captionWin.setIgnoreMouseEvents(true, { forward: true })   // 钉住 + 穿透
    // 解锁时由字幕窗自身命中测试恢复交互
    captionWin.webContents.send('lock:changed', on)
  }
  if (toolbarWin && !toolbarWin.isDestroyed()) toolbarWin.webContents.send('lock:changed', on)
  if (!on) dock()   // 解锁：工具条重新停靠
}

ipcMain.on('lock:toggle', () => applyLock(!locked))
ipcMain.handle('lock:get', () => locked)

// 录制状态（播放键在工具条窗，字幕流在字幕窗，跨窗同步）
function applyRec (on) {
  recording = on
  for (const w of [captionWin, toolbarWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('rec:changed', on)
  }
}
ipcMain.on('rec:toggle', () => applyRec(!recording))
ipcMain.handle('rec:get', () => recording)

// ---------------------------------------------------------------------------
// 其余 IPC
// ---------------------------------------------------------------------------
ipcMain.on('mouse-through', (e, ignore) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (!w || w.isDestroyed()) return
  // 锁定态下字幕窗恒穿透，忽略其渲染层的“变实心”请求
  if (w === captionWin && locked && !ignore) return
  w.setIgnoreMouseEvents(!!ignore, { forward: true })
})

ipcMain.on('bar-action', (e, action) => {
  switch (action) {
    case 'settings': openSettingsWindow(); break
    case 'close': app.quit(); break
  }
})

ipcMain.handle('config:get', () => payload())
ipcMain.on('config:set', (e, patch) => { config.set(patch || {}); broadcastConfig() })

ipcMain.on('settings:close', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender)
  if (w && !w.isDestroyed()) w.close()
})

nativeTheme.on('updated', broadcastConfig)

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  config.load()
  createWindows()

  globalShortcut.register('CommandOrControl+Alt+L', () => applyLock(!locked))

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindows()
  })
})

app.on('will-quit', () => globalShortcut.unregisterAll())
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
