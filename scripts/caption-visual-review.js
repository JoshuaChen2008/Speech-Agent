'use strict'

/*
 * Visible, non-audio Electron runner for the SEM-F20/J15a DWM protocol.
 * It loads the production caption page and preload, injects only schema-valid
 * synthetic CaptionEvent objects, and never starts the product runtime.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { app, BrowserWindow, ipcMain, nativeTheme, screen } = require('electron')

const CHANNELS = require('../src/main/ipc/channels')
const { DEFAULT_CONFIG } = require('../src/main/services/config-store')
const { assertCaptionEvent } = require('../src/contracts/caption-event')
const {
  PROJECT_ROOT,
  candidateSha256,
  currentProvenance,
  parseOperatorCompletion,
  parseRunnerArguments,
  scalePercentForFactor
} = require('./caption-visual-review-protocol')
const {
  validateCaptionVisualReviewObservation
} = require('./verify-caption-visual-review-report')

const CAPTION_WIDTH = 920
const CAPTION_HEIGHT = 190
const RENDER_SETTLE_MS = 90

function delay (milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function sameBounds (left, right) {
  return ['x', 'y', 'width', 'height'].every((key) => left[key] === right[key])
}

function boundsForDisplay (display) {
  const area = display.workArea
  if (area.width < 480 || area.height < 140) {
    throw new Error('target display work area is smaller than the caption window minimum')
  }
  const width = Math.min(CAPTION_WIDTH, area.width)
  const height = Math.min(CAPTION_HEIGHT, area.height)
  return {
    width,
    height,
    x: Math.round(area.x + (area.width - width) / 2),
    y: Math.round(area.y + Math.min(72, Math.max(0, area.height - height)))
  }
}

function buildSyntheticCaptionEvents () {
  const finalized = [
    '这是一条用于检查固定高度字幕流的合成语句。',
    '新增内容以后最旧的完整视觉行应从顶部离开。',
    '字幕窗口自身的宽度和高度必须保持完全不变。',
    '当前最新内容应持续贴近字幕视口的底部显示。',
    '透明窗口后方的真实桌面背景仍应清楚可辨。',
    '这里继续加入一条长度稳定的合法合成字幕事件。',
    '淘汰过程不得产生横向移动或可见的滚动条。'
  ]
  let sequence = 0
  const events = finalized.map((text, index) => {
    sequence += 1
    return assertCaptionEvent({
      schemaVersion: 1,
      sessionId: 'visual-review-session',
      sourceId: 'visual-review-source',
      segmentId: `visual-segment-${index + 1}`,
      sequence,
      revision: 1,
      kind: 'final',
      t0: index,
      t1: index + 0.8,
      text,
      translation: null
    })
  })
  for (const [revision, text] of [
    [1, '最新片段正在底部显示。'],
    [2, '最新片段正在底部完整显示，并继续接收更新。']
  ]) {
    sequence += 1
    events.push(assertCaptionEvent({
      schemaVersion: 1,
      sessionId: 'visual-review-session',
      sourceId: 'visual-review-source',
      segmentId: 'visual-segment-current',
      sequence,
      revision,
      kind: 'partial',
      t0: 8,
      t1: 8 + revision * 0.1,
      text,
      translation: null
    }))
  }
  return events
}

function installCaptionIpc (win, config) {
  ipcMain.handle(CHANNELS.LOCK_GET, () => false)
  ipcMain.handle(CHANNELS.CONFIG_GET, () => ({ ...config }))
  ipcMain.handle(CHANNELS.CAPTION_STATE_GET, () => null)
  ipcMain.on(CHANNELS.MOUSE_THROUGH, (event, ignore) => {
    if (event.sender === win.webContents && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(Boolean(ignore), { forward: true })
    }
  })
  for (const channel of [CHANNELS.DRAG_START, CHANNELS.DRAG_END, CHANNELS.RESIZE_START, CHANNELS.RESIZE_END]) {
    ipcMain.on(channel, () => {})
  }
}

async function measureCaptionGeometry (win) {
  return win.webContents.executeJavaScript(`(() => {
    const flow = document.getElementById('captionFlow')
    const captions = document.getElementById('captions')
    const nodes = Array.from(flow.children)
    const flowRect = flow.getBoundingClientRect()
    const rootStyles = getComputedStyle(document.documentElement)
    const line = parseFloat(rootStyles.getPropertyValue('--fs')) *
      parseFloat(rootStyles.getPropertyValue('--lh-caption'))
    const lineRects = []
    for (const node of nodes) {
      const range = document.createRange()
      range.selectNodeContents(node)
      lineRects.push(...Array.from(range.getClientRects()))
      range.detach()
    }
    const newest = nodes[nodes.length - 1]
    const newestRange = document.createRange()
    if (newest) newestRange.selectNodeContents(newest)
    const newestRects = newest ? Array.from(newestRange.getClientRects()) : []
    newestRange.detach()
    const contentTop = lineRects.length ? Math.min(...lineRects.map((rect) => rect.top)) : flowRect.top
    const contentBottom = lineRects.length ? Math.max(...lineRects.map((rect) => rect.bottom)) : flowRect.bottom
    const clippedTop = Math.max(0, flowRect.top - contentTop)
    const closeToInteger = (value) => Number.isFinite(value) && Math.abs(value - Math.round(value)) <= 0.08
    const overflowed = clippedTop > 0.5 || flow.scrollHeight > flow.clientHeight + 0.5
    return {
      contentOverflowed: overflowed,
      newestLineVisible: newestRects.length > 0 && newestRects.every((rect) =>
        rect.top >= flowRect.top - 0.75 && rect.bottom <= flowRect.bottom + 0.75),
      noHorizontalOverflow:
        document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 &&
        document.body.scrollWidth <= document.body.clientWidth + 1 &&
        captions.scrollWidth <= captions.clientWidth + 1 &&
        flow.scrollWidth <= flow.clientWidth + 1,
      topClipIsWholeLines: overflowed && closeToInteger(clippedTop / line),
      topOnlyClip: overflowed && contentTop < flowRect.top - 0.5 && contentBottom <= flowRect.bottom + 0.75,
      viewportIsWholeLines: closeToInteger(flowRect.height / line),
      rendererTheme: document.documentElement.dataset.theme,
      forcedColorsActive: matchMedia('(forced-colors: active)').matches,
      devicePixelRatio: window.devicePixelRatio
    }
  })()`)
}

async function waitForTwoAnimationFrames (win) {
  await win.webContents.executeJavaScript(`new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve))
  })`)
}

async function injectAndMeasure (win, events, initialBounds) {
  const aggregate = {
    boundsUnchangedAfterCaptionUpdates: true,
    contentOverflowed: false,
    newestLineVisible: true,
    noHorizontalOverflow: true,
    topClipIsWholeLines: true,
    topOnlyClip: true,
    viewportIsWholeLines: true
  }
  for (const event of events) {
    win.webContents.send(CHANNELS.CAPTION_EVENT, event)
    await waitForTwoAnimationFrames(win)
    await delay(RENDER_SETTLE_MS)
    const measured = await measureCaptionGeometry(win)
    aggregate.boundsUnchangedAfterCaptionUpdates &&= sameBounds(win.getBounds(), initialBounds)
    aggregate.newestLineVisible &&= measured.newestLineVisible
    aggregate.noHorizontalOverflow &&= measured.noHorizontalOverflow
    aggregate.viewportIsWholeLines &&= measured.viewportIsWholeLines
    if (measured.contentOverflowed) {
      aggregate.contentOverflowed = true
      aggregate.topClipIsWholeLines &&= measured.topClipIsWholeLines
      aggregate.topOnlyClip &&= measured.topOnlyClip
    }
  }
  const finalMeasurement = await measureCaptionGeometry(win)
  return { aggregate, finalMeasurement }
}

function systemThemeMatched (requestedTheme, measurement) {
  const highContrast = nativeTheme.shouldUseHighContrastColors === true
  if (requestedTheme === 'high-contrast') {
    return highContrast && measurement.forcedColorsActive === true
  }
  const expectedDark = requestedTheme === 'dark'
  return !highContrast && nativeTheme.shouldUseDarkColors === expectedDark &&
    measurement.forcedColorsActive === false && measurement.rendererTheme === requestedTheme
}

async function waitForOperatorCompletion (completionPath, combination, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000
  while (Date.now() < deadline) {
    if (fs.existsSync(completionPath)) {
      return parseOperatorCompletion(fs.readFileSync(completionPath), combination)
    }
    await delay(250)
  }
  throw new Error('operator completion timed out; no observation report was written')
}

async function runVisualReview (options) {
  if (process.platform !== 'win32') {
    throw new Error('SEM-F20/J15a visible DWM review requires Windows')
  }
  if (fs.existsSync(options.workDir)) throw new Error('--work-dir already exists; refusing stale evidence')
  fs.mkdirSync(path.dirname(options.report), { recursive: true })
  fs.mkdirSync(path.dirname(options.completion), { recursive: true })
  const userData = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'speech-caption-visual-'))
  app.setPath('userData', userData)

  await app.whenReady()
  const displays = screen.getAllDisplays()
  const targetDisplay = displays.find((display) =>
    scalePercentForFactor(display.scaleFactor) === options.scalePercent)
  if (!targetDisplay) throw new Error(`no display currently reports ${options.scalePercent}% system scaling`)
  const sourceDisplay = options.crossScaleMove
    ? displays.find((display) => scalePercentForFactor(display.scaleFactor) !== options.scalePercent)
    : targetDisplay
  if (!sourceDisplay) {
    throw new Error('cross-scale movement requires a second display with a different screen.scaleFactor')
  }

  const config = {
    ...DEFAULT_CONFIG,
    theme: 'auto',
    systemDark: nativeTheme.shouldUseDarkColors,
    captionWidth: Math.min(CAPTION_WIDTH, targetDisplay.workArea.width),
    captionHeight: Math.min(CAPTION_HEIGHT, targetDisplay.workArea.height)
  }
  const win = new BrowserWindow({
    ...boundsForDisplay(sourceDisplay),
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    focusable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload', 'caption.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })
  installCaptionIpc(win, config)
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  await win.loadFile(path.join(__dirname, '..', 'src', 'caption', 'index.html'))
  win.show()
  await delay(750)

  const fromScalePercent = scalePercentForFactor(screen.getDisplayMatching(win.getBounds()).scaleFactor)
  if (options.crossScaleMove) {
    win.setBounds(boundsForDisplay(targetDisplay), false)
    await delay(1000)
  }
  const observedDisplay = screen.getDisplayMatching(win.getBounds())
  const toScalePercent = scalePercentForFactor(observedDisplay.scaleFactor)
  const movedAcrossScaleFactors = options.crossScaleMove && fromScalePercent !== toScalePercent
  const initialBounds = win.getBounds()

  const events = buildSyntheticCaptionEvents()
  const { aggregate, finalMeasurement } = await injectAndMeasure(win, events, initialBounds)
  const distinctScaleFactorCount = new Set(displays.map((display) =>
    scalePercentForFactor(display.scaleFactor))).size
  const browserZoomDefault = Math.abs(win.webContents.getZoomFactor() - 1) < 1e-9
  const rendererDeviceScaleMatched = Math.abs(finalMeasurement.devicePixelRatio - observedDisplay.scaleFactor) < 0.01
  const targetScaleFactorMatched = toScalePercent === options.scalePercent
  const themeMatched = systemThemeMatched(options.theme, finalMeasurement)
  const automaticChecks = {
    ...aggregate,
    browserZoomDefault,
    rendererDeviceScaleMatched,
    systemThemeMatched: themeMatched,
    targetScaleFactorMatched,
    visible: win.isVisible() && !win.isMinimized(),
    moveObserved: !options.crossScaleMove || movedAcrossScaleFactors
  }
  const failedChecks = Object.entries(automaticChecks).filter(([, value]) => value !== true).map(([key]) => key)
  if (failedChecks.length > 0) {
    throw new Error(`automatic visual observation checks failed: ${failedChecks.join(', ')}`)
  }

  const completionArgument = path.relative(PROJECT_ROOT, options.completion).split(path.sep).join('/')
  process.stdout.write(
    `Visible caption review is awaiting explicit operator completion for ${options.scalePercent}% / ` +
    `${options.theme} / ${options.background}.\n` +
    'Confirm transparent surface has no black background, text is readable, newest line is complete, ' +
    'the top edge has no partial line, no horizontal motion/scrollbar appears, and bounds stay fixed.\n' +
    'Keep this window visible over the named real desktop background, then run:\n' +
    `node scripts/complete-caption-visual-review.js --completion "${completionArgument}" ` +
    `--scale-percent ${options.scalePercent} --theme ${options.theme} --background ${options.background} ` +
    '--confirm-observed\n'
  )
  const completion = await waitForOperatorCompletion(
    options.completion,
    { scalePercent: options.scalePercent, theme: options.theme, background: options.background },
    options.timeoutSeconds
  )

  const postCompletionDisplay = screen.getDisplayMatching(win.getBounds())
  const postCompletionMeasurement = await measureCaptionGeometry(win)
  const postCompletionChecks = {
    boundsStayedFixed: sameBounds(win.getBounds(), initialBounds),
    browserZoomStayedDefault: Math.abs(win.webContents.getZoomFactor() - 1) < 1e-9,
    rendererDeviceScaleStillMatched:
      Math.abs(postCompletionMeasurement.devicePixelRatio - postCompletionDisplay.scaleFactor) < 0.01,
    systemThemeStillMatched: systemThemeMatched(options.theme, postCompletionMeasurement),
    targetScaleFactorStillMatched:
      scalePercentForFactor(postCompletionDisplay.scaleFactor) === options.scalePercent,
    visibleAfterCompletion: win.isVisible() && !win.isMinimized()
  }
  const failedPostCompletionChecks = Object.entries(postCompletionChecks)
    .filter(([, value]) => value !== true)
    .map(([key]) => key)
  if (failedPostCompletionChecks.length > 0) {
    throw new Error(`post-completion visual checks failed: ${failedPostCompletionChecks.join(', ')}`)
  }
  aggregate.boundsUnchangedAfterCaptionUpdates &&= postCompletionChecks.boundsStayedFixed

  const provenance = currentProvenance()
  const finalCount = events.filter((event) => event.kind === 'final').length
  const partialCount = events.filter((event) => event.kind === 'partial').length
  const segmentCount = new Set(events.map((event) => event.segmentId)).size
  const sourceCount = new Set(events.map((event) => event.sourceId)).size
  const report = validateCaptionVisualReviewObservation({
    schemaVersion: 1,
    kind: 'caption-visual-review-observation',
    result: 'pass',
    gateStatus: 'partial',
    candidateSha256: candidateSha256(provenance),
    provenance,
    combination: {
      scalePercent: options.scalePercent,
      theme: options.theme,
      background: options.background
    },
    display: {
      browserZoomDefault,
      displayCount: displays.length,
      distinctScaleFactorCount,
      rendererDeviceScaleMatched,
      systemThemeMatched: themeMatched,
      targetScaleFactorMatched
    },
    move: {
      requested: options.crossScaleMove,
      observed: movedAcrossScaleFactors,
      acrossDifferentScaleFactors: movedAcrossScaleFactors,
      fromScalePercent,
      toScalePercent
    },
    geometry: aggregate,
    window: {
      visible: true,
      transparent: true,
      focusable: false,
      frame: false
    },
    events: {
      captionEventCount: events.length,
      finalEventCount: finalCount,
      partialEventCount: partialCount,
      segmentCount,
      sourceCount
    },
    operator: {
      observed: completion.observed,
      checks: { ...completion.checks }
    },
    boundaries: {
      audioCapture: false,
      browserZoomUsed: false,
      deviceNamesPersisted: false,
      hiddenWindow: false,
      localPathsPersisted: false,
      modelLoaded: false,
      networkAccess: false,
      physicalSourceOpened: false,
      syntheticCaptionEventsOnly: true,
      textPersisted: false
    }
  })
  fs.writeFileSync(options.report, JSON.stringify(report, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'wx'
  })
  win.destroy()
  return report
}

async function main () {
  const options = parseRunnerArguments(process.argv.slice(2))
  const report = await runVisualReview(options)
  process.stdout.write(JSON.stringify({
    result: report.result,
    gateStatus: report.gateStatus,
    scalePercent: report.combination.scalePercent,
    theme: report.combination.theme,
    background: report.combination.background
  }) + '\n')
  app.exit(0)
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`)
    if (app.isReady()) app.exit(1)
    else process.exitCode = 1
  })
}

module.exports = {
  boundsForDisplay,
  buildSyntheticCaptionEvents,
  runVisualReview
}
