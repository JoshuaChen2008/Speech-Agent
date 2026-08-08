'use strict'

/* J15a / SEM-F20 固定高度字幕流的布局资格。
   --------------------------------------------------------------------------
   这是一个**最小 Electron 宿主**：只创建字幕窗、加载真实的 caption preload 与
   真实的 Vite 生产字幕 bundle，由主进程直接广播契约合法的 CaptionEvent。
   它刻意不启动产品组合根、模型与存储 —— 目的是让「字幕排版对不对」这个问题
   能在一两分钟内单独回答，而不是等整条四窗旅程。

   为什么必须是真实 Chromium：满高后「最旧完整视觉行退出」由 CSS 的底部锚定 +
   overflow 裁剪完成，断行位置也由 Chromium 决定。用 JS 假字体度量重算一遍等于
   写出与 CSS 各自为政的第二套规则，测试全绿产品仍可能错行。

   本报告明确不证明：
   - 真实主进程的 config 广播接线（由产品壳旅程的两条最小断言兜底）；
   - 真实 ASR/VAD、物理音频；
   - DPI、主题、透明窗的人工视觉验收（仍归实机门禁）。

   隐私（SEM-F14）：报告只写几何量、计数、布尔与哈希，绝不写字幕正文或本地路径。 */

const { app, BrowserWindow, ipcMain } = require('electron')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const CHANNELS = require('../src/main/ipc/channels')
const { DEFAULT_CONFIG } = require('../src/main/services/config-store')
const { assertCaptionEvent, assertCaptionViewportEviction } = require('../src/contracts')

const ROOT = path.resolve(__dirname, '..')
const SCHEMA = 'caption-layout-report@v2'
const FONT_SIZES = Object.freeze([24, 30, 38])

/* 语料只用于制造溢出，不进报告。四类分别针对不同的断行规则：
   中文逐字断行、英文按词断行、中英混排、以及没有任何断点的超长单词。 */
const CORPUS = Object.freeze({
  zh: '这是一段持续增长的实时字幕假设用来把固定高度的视口写满并继续增长',
  en: 'this is a continuously growing realtime caption hypothesis that keeps filling the fixed viewport ',
  mixed: '我们下周先对齐 roadmap 再排 A/B test 然后 review 一下 latency 预算 ',
  'long-word': 'supercalifragilisticexpialidociousantidisestablishmentarianismpneumonoultramicroscopicsilicovolcanoconiosis'
})
const TEXT_KINDS = Object.freeze(Object.keys(CORPUS))

/* 每种语料重复到足以在最大字号下也溢出 190 DIP 的字幕窗。 */
const GROWTH_STEPS = 6

const PROVENANCE_FILES = Object.freeze({
  captionMarkupSha256: 'src/caption/index.html',
  captionRendererManifestSha256: 'src/renderer-dist/manifest.json',
  captionRendererSha256: 'src/caption/caption.ts',
  captionStyleSha256: 'src/caption/caption.css',
  captionStateContractSha256: 'src/contracts/caption-state.js',
  ipcChannelsSha256: 'src/main/ipc/channels.js',
  preloadSha256: 'src/preload/caption.js',
  reducerSha256: 'src/ui/shared/caption-reducer.js',
  runnerSha256: 'scripts/caption-layout-smoke.js',
  tokensSha256: 'src/ui/shared/tokens.css',
  verifierSha256: 'scripts/verify-caption-layout-report.js'
})

function sha256File (relativePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, relativePath))).digest('hex')
}

function currentProvenance () {
  const provenance = {}
  for (const [key, relativePath] of Object.entries(PROVENANCE_FILES)) {
    provenance[key] = sha256File(relativePath)
  }
  return provenance
}

function parseArguments (argv) {
  let reportPath = null
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--report' && typeof argv[index + 1] === 'string') {
      reportPath = path.resolve(argv[index + 1])
      index += 1
    }
  }
  if (!reportPath) throw new Error('usage: electron scripts/caption-layout-smoke.js --report <report.json>')
  return { reportPath }
}

/* --------------------------------------------------------------------------
   渲染进程里的量测。只回答几何问题，不回传任何正文。
   -------------------------------------------------------------------------- */
const MEASURE = `(() => {
  const cap = document.getElementById('captions')
  const flow = document.getElementById('captionFlow')
  const rs = getComputedStyle(document.documentElement)
  const fontSizePx = parseFloat(rs.getPropertyValue('--fs'))
  const lineHeightRatio = parseFloat(rs.getPropertyValue('--lh-caption'))
  const linePx = fontSizePx * lineHeightRatio
  const visibleLines = parseInt(rs.getPropertyValue('--visible-lines'), 10)
  const capRect = cap.getBoundingClientRect()
  const flowRect = flow.getBoundingClientRect()
  const kids = Array.from(flow.children)
  const rects = kids.map((node) => node.getBoundingClientRect())
  const first = rects[0] || null
  const last = rects[rects.length - 1] || null
  const contentPx = rects.reduce((sum, rect) => sum + rect.height, 0)
  /* 顶部被裁掉的高度。注意不能用 scrollHeight —— flex 容器在 justify-content:flex-end
     下，起始方向的溢出内容被视为不可达，scrollHeight 恒等于 clientHeight。 */
  const clippedPx = first ? Math.max(0, flowRect.top - first.top) : 0
  const near = (a, b) => Math.abs(a - b) < 0.6
  return {
    fontSizePx,
    lineHeightPx: Math.round(linePx * 1000) / 1000,
    visibleLines,
    availablePx: cap.clientHeight,
    viewportPx: flow.clientHeight,
    contentPx: Math.round(contentPx * 1000) / 1000,
    clippedPx: Math.round(clippedPx * 1000) / 1000,
    nodeCount: kids.length,
    textLength: kids.reduce((total, node) => total + node.textContent.length, 0),
    overflowed: clippedPx > 0.5,
    viewportIsWholeLines: near(flow.clientHeight, visibleLines * linePx),
    contentIsWholeLines: near(contentPx % linePx, 0) || near(contentPx % linePx, linePx),
    clippedIsWholeLines: near(clippedPx % linePx, 0) || near(clippedPx % linePx, linePx),
    clipsFromTopOnly: !first || (first.top <= flowRect.top + 0.6 && last.bottom <= flowRect.bottom + 0.6),
    /* 「最新行可见」要量最后一**行**，不是最后一个段落节点：一个长 partial 的
       盒子必然高于视口，用节点顶边判断会永远为假。最后一行的盒子是
       [last.bottom - linePx, last.bottom]，它必须完整落在视口内。 */
    newestLineVisible: !last || (
      last.bottom <= flowRect.bottom + 0.6 &&
      last.bottom - linePx >= flowRect.top - 0.6 &&
      last.bottom <= capRect.bottom + 0.6
    ),
    bottomAnchored: near(flowRect.bottom, capRect.bottom),
    noHorizontalOverflow:
      flow.scrollWidth <= flow.clientWidth &&
      cap.scrollWidth <= cap.clientWidth &&
      document.documentElement.scrollWidth <= document.documentElement.clientWidth
  }
})()`

const READ_FLOW_DIGEST = `(() => {
  const flow = document.getElementById('captionFlow')
  return Array.from(flow.children).map((node) => node.textContent).join('\\u0000')
})()`

function digest (value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')
}

function grow (kind, step) {
  const unit = CORPUS[kind]
  return unit.repeat(step)
}

async function main () {
  const { reportPath } = parseArguments(process.argv.slice(2))

  app.commandLine.appendSwitch('disable-gpu-compositing')
  await app.whenReady()

  let config = { ...DEFAULT_CONFIG, systemDark: true }
  const intents = {
    captionViewportEviction: 0,
    mouseThrough: 0,
    dragStart: 0,
    dragEnd: 0,
    resizeStart: 0,
    resizeEnd: 0
  }
  const viewportEvictions = []

  ipcMain.handle(CHANNELS.LOCK_GET, () => false)
  ipcMain.handle(CHANNELS.CONFIG_GET, () => config)
  /* 空闲状态：没有历史字幕可水合，renderer 从零开始。 */
  ipcMain.handle(CHANNELS.CAPTION_STATE_GET, () => null)
  ipcMain.handle(CHANNELS.CAPTION_VIEWPORT_EVICT, (_event, report) => {
    const accepted = structuredClone(assertCaptionViewportEviction(report))
    viewportEvictions.push(accepted)
    intents.captionViewportEviction += 1
    return true
  })
  ipcMain.on(CHANNELS.MOUSE_THROUGH, () => { intents.mouseThrough += 1 })
  ipcMain.on(CHANNELS.DRAG_START, () => { intents.dragStart += 1 })
  ipcMain.on(CHANNELS.DRAG_END, () => { intents.dragEnd += 1 })
  ipcMain.on(CHANNELS.RESIZE_START, () => { intents.resizeStart += 1 })
  ipcMain.on(CHANNELS.RESIZE_END, () => { intents.resizeEnd += 1 })

  /* 与产品字幕窗相同的关键选项：固定尺寸、透明、不可聚焦、不节流。
     show:false 只是不让 CI 里闪窗，布局与量测照常发生。 */
  const win = new BrowserWindow({
    width: DEFAULT_CONFIG.captionWidth,
    height: DEFAULT_CONFIG.captionHeight,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      preload: path.join(ROOT, 'src', 'preload', 'caption.js'),
      contextIsolation: true,
      nodeIntegration: false,
      /* 与 src/main.js 的字幕窗一致：preload 需要 require 项目内模块，
         sandbox 打开时会以 "module not found" 静默失败。 */
      sandbox: false,
      backgroundThrottling: false
    }
  })
  /* renderer 里的异常必须冒出来，否则量测只会得到一堆 0 而看不出原因。 */
  win.webContents.on('console-message', (...args) => {
    const payload = args.length === 1 && args[0] && typeof args[0] === 'object'
      ? `${args[0].level} ${args[0].message}`
      : `${args[1]} ${args[2]}`
    console.error('[renderer]', payload)
  })
  win.webContents.on('preload-error', (_event, preloadPath, error) => {
    console.error('[preload]', path.basename(preloadPath), error && error.message)
  })

  await win.loadFile(path.join(ROOT, 'src', 'renderer-dist', 'caption', 'index.html'))

  /* 前置检查而不是日志：preload 一旦静默失败（例如 sandbox 打开时 require 不到
     项目模块），所有量测都会变成 0，然后以一堆看不懂的不变量失败收场。 */
  const ready = await win.webContents.executeJavaScript(`JSON.stringify({
    bridge: typeof window.shell,
    reducer: typeof (window.CaptionReducer || {}).selectFlow,
    flowNode: !!document.getElementById('captionFlow')
  })`)
  const readiness = JSON.parse(ready)
  if (readiness.bridge !== 'object' || readiness.reducer !== 'function' || !readiness.flowNode) {
    throw new Error(`caption renderer did not come up: ${ready}`)
  }

  const measure = () => win.webContents.executeJavaScript(MEASURE)
  const flowDigest = async () => digest(await win.webContents.executeJavaScript(READ_FLOW_DIGEST))

  let sessionCounter = 0
  let sequence = 0

  function emit (input) {
    const event = {
      schemaVersion: 1,
      sessionId: input.sessionId,
      sourceId: 'loopback',
      segmentId: input.segmentId,
      sequence: ++sequence,
      revision: input.revision,
      kind: input.kind,
      t0: input.t0,
      t1: input.t1,
      text: input.text,
      translation: null
    }
    assertCaptionEvent(event)
    win.webContents.send(CHANNELS.CAPTION_EVENT, event)
    return event
  }

  async function setFontSize (fontSize) {
    config = { ...config, fontSize }
    win.webContents.send(CHANNELS.CONFIG_CHANGED, config)
    /* 等一帧，让 renderer 完成 applyViewport + render 后再量。 */
    await win.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  }

  async function freshSession () {
    sessionCounter += 1
    return `caption-layout-${sessionCounter}`
  }

  const cases = []

  /* ---- 主矩阵：字号 × 语料，长 partial 持续增长到溢出 ---- */
  for (const fontSize of FONT_SIZES) {
    await setFontSize(fontSize)
    for (const textKind of TEXT_KINDS) {
      const sessionId = await freshSession()
      let last = null
      for (let step = 1; step <= GROWTH_STEPS; step += 1) {
        emit({
          sessionId,
          segmentId: 'segment-1',
          revision: step,
          kind: 'partial',
          t0: 0,
          t1: step * 500,
          text: grow(textKind, step)
        })
        last = await measure()
      }
      cases.push({ id: `${textKind}@${fontSize}`, textKind, ...last })
    }
  }

  /* ---- 回改：假设变短后重排，不得截断当前假设，也不得触发窗口 resize ---- */
  await setFontSize(30)
  const rewriteSession = await freshSession()
  emit({ sessionId: rewriteSession, segmentId: 'segment-1', revision: 1, kind: 'partial', t0: 0, t1: 500, text: grow('mixed', GROWTH_STEPS) })
  const beforeRewrite = await measure()
  const rewrittenText = grow('mixed', 2) + '改过的结尾'
  emit({ sessionId: rewriteSession, segmentId: 'segment-1', revision: 2, kind: 'partial', t0: 0, t1: 900, text: rewrittenText })
  const afterRewrite = await measure()
  cases.push({ id: 'rewrite@30', textKind: 'mixed', ...afterRewrite })

  /* ---- 跨段：上一段定稿、下一段开始，旧段逐行淘汰而不是整窗清空 ---- */
  const crossSession = await freshSession()
  emit({ sessionId: crossSession, segmentId: 'segment-1', revision: 1, kind: 'final', t0: 0, t1: 1000, text: grow('zh', 2) })
  const afterFirstFinal = await measure()
  for (let step = 1; step <= GROWTH_STEPS; step += 1) {
    emit({ sessionId: crossSession, segmentId: 'segment-2', revision: step, kind: 'partial', t0: 1000, t1: 1000 + step * 500, text: grow('zh', step) })
  }
  await win.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const afterSecondGrows = await measure()
  cases.push({ id: 'cross-segment@30', textKind: 'zh', ...afterSecondGrows })

  /* 已整段离场的 segment-1 即使收到更短的迟到精修，也不能重新出现在 flow。 */
  const beforeLateAmendment = await flowDigest()
  emit({
    sessionId: crossSession,
    segmentId: 'segment-1',
    revision: 2,
    kind: 'refined',
    t0: 0,
    t1: 1000,
    text: '短'
  })
  await win.webContents.executeJavaScript('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  const afterLateAmendment = await flowDigest()

  /* ---- 停顿：没有新事件时字幕必须原样保留 ---- */
  const pausedBefore = await flowDigest()
  await new Promise((resolve) => setTimeout(resolve, 400))
  const pausedAfter = await flowDigest()
  const afterPause = await measure()
  cases.push({ id: 'pause@30', textKind: 'zh', ...afterPause })

  const every = (predicate) => cases.every(predicate)
  const invariants = {
    /* 溢出场景必须真的溢出，否则四条不变量都是空转。 */
    everyGrowthCaseOverflowed: cases.filter((item) => item.id.includes('@')).every((item) => item.overflowed),
    noHorizontalOverflow: every((item) => item.noHorizontalOverflow),
    newestLineVisible: every((item) => item.newestLineVisible),
    clipsFromTopOnly: every((item) => item.clipsFromTopOnly),
    bottomAnchored: every((item) => item.bottomAnchored),
    viewportIsWholeLines: every((item) => item.viewportIsWholeLines),
    clippedIsWholeLines: every((item) => item.clippedIsWholeLines),
    largerFontShowsFewerLines:
      FONT_SIZES.every((fontSize) => cases.some((item) => item.id.endsWith(`@${fontSize}`))) &&
      Math.max(...cases.filter((item) => item.id.endsWith('@24')).map((item) => item.visibleLines)) >
      Math.max(...cases.filter((item) => item.id.endsWith('@38')).map((item) => item.visibleLines)),
    rewriteKeepsFullHypothesis: afterRewrite.textLength === rewrittenText.length,
    rewriteDidNotGrowContent: afterRewrite.contentPx <= beforeRewrite.contentPx,
    crossSegmentKeepsCurrentSegment:
      afterFirstFinal.nodeCount === 1 &&
      afterSecondGrows.nodeCount === 1 &&
      afterSecondGrows.textLength === grow('zh', GROWTH_STEPS).length,
    fullyClippedPrefixReported: viewportEvictions.some((report) =>
      report.sessionId === crossSession && report.throughSegmentId === 'segment-1'),
    lateAmendmentDoesNotRevive: beforeLateAmendment === afterLateAmendment,
    pauseRetainsCaptions: pausedBefore === pausedAfter,
    noWindowResizeRequested: intents.resizeStart === 0 && intents.resizeEnd === 0,
    noWindowDragRequested: intents.dragStart === 0 && intents.dragEnd === 0
  }

  const report = {
    schema: SCHEMA,
    generatedAt: new Date().toISOString(),
    result: Object.values(invariants).every(Boolean) ? 'pass' : 'fail',
    gateStatus: 'partial',
    boundaries: {
      productCompositionRoot: false,
      configBroadcastWiring: false,
      realAsrOrVad: false,
      audioCapture: false,
      humanVisualReview: false,
      dpiMatrix: false
    },
    fixture: {
      corpusSha256: digest(JSON.stringify(CORPUS)),
      fontSizes: [...FONT_SIZES],
      textKinds: [...TEXT_KINDS],
      growthSteps: GROWTH_STEPS,
      caseCount: cases.length,
      windowWidth: DEFAULT_CONFIG.captionWidth,
      windowHeight: DEFAULT_CONFIG.captionHeight
    },
    provenance: currentProvenance(),
    intents: { ...intents },
    invariants,
    cases
  }

  const rendered = JSON.stringify(report, null, 2)
  if (/[A-Za-z]:[\\/]/.test(rendered)) throw new Error('caption layout report must not contain absolute paths')
  fs.mkdirSync(path.dirname(reportPath), { recursive: true })
  fs.writeFileSync(reportPath, rendered + '\n')
  console.log(JSON.stringify({ result: report.result, gateStatus: report.gateStatus, caseCount: cases.length }))

  if (report.result !== 'pass') throw new Error('fixed-height caption layout invariants failed')
  win.destroy()
}

main()
  .then(() => app.exit(0))
  .catch((error) => {
    console.error(error && error.stack ? error.stack : String(error))
    app.exit(1)
  })
