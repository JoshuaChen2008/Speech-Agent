'use strict'

// Production main/preload/renderers/storage, isolated userData, no audio or model requests.
const assert = require('node:assert/strict')
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'agent-layout-')))
require('../../src/main')
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
async function until (probe, stage) {
  for (let i = 0; i < 200; i++) { if (await probe()) return; await wait(50) }
  throw new Error(`layout fixture readiness timeout: ${stage}`)
}
function findWindow (name) {
  return BrowserWindow.getAllWindows().find(w => w.webContents.getURL().replaceAll('\\', '/').includes(`/${name}/`))
}
async function run () {
  await app.whenReady()
  await until(() => findWindow('toolbar'), 'toolbar window')
  const toolbar = findWindow('toolbar')
  await until(() => toolbar.webContents.executeJavaScript('Boolean(window.shell)'), 'toolbar preload')
  await toolbar.webContents.executeJavaScript("window.shell.action('agent')")
  await until(() => findWindow('agent'), 'agent window')
  const win = findWindow('agent')
  const evaluate = source => win.webContents.executeJavaScript(source)
  await until(() => evaluate("Boolean(document.querySelector('#agentPrompt'))"), 'agent renderer')
  if (process.env.AGENT_LAYOUT_INTERACTIVE === '1') return
  assert.equal(await toolbar.webContents.executeJavaScript("document.querySelector('#status').textContent.includes('正在打开会话总结')"), false, 'loaded Agent window must settle toolbar opening feedback')
  await toolbar.webContents.executeJavaScript("window.shell.action('settings')")
  await until(() => findWindow('settings'), 'settings window')
  const settings = findWindow('settings')
  await until(() => settings.webContents.executeJavaScript("Boolean(document.querySelector('[data-preset=meeting]'))"), 'settings renderer')
  await settings.webContents.executeJavaScript("document.querySelector('[data-preset=meeting]').click()")
  await evaluate("document.querySelector('.scope-filters').open = true; document.querySelector('.session-functions button').click()")
  for (const theme of ['dark', 'light']) {
    await settings.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === '${theme === 'dark' ? '深色' : '浅色'}').click()`)
    await until(() => evaluate(`document.documentElement.dataset.theme === '${theme}'`), `${theme}: theme receipt`)
    for (const [width, height, zoom] of [[520, 420, 1], [720, 640, 1], [1100, 720, 1], [720, 640, 1.25], [1100, 720, 1], [720, 640, 1.25], [520, 420, 1], [720, 640, 1.25]]) {
      win.setSize(width, height)
      win.webContents.setZoomFactor(zoom)
      let viewportState
      try {
        await until(async () => {
          const size = win.getSize()
          const content = win.getContentSize()
          const viewport = await evaluate('({ width: innerWidth, height: innerHeight, devicePixelRatio })')
          viewportState = { size, content, viewport, zoom: win.webContents.getZoomFactor(), visible: win.isVisible(), enabled: win.isEnabled(), loading: win.webContents.isLoadingMainFrame() }
          return Math.abs(size[0] - width) <= 2 && Math.abs(size[1] - height) <= 2 &&
            Math.abs(viewport.width - content[0] / zoom) <= 1 && Math.abs(viewport.height - content[1] / zoom) <= 1
        }, `${theme}/${width}x${height}/${zoom}: viewport commit`)
      } catch (error) {
        throw new Error(`${error.message} ${JSON.stringify(viewportState)}`)
      }
      assert.equal(await evaluate("document.querySelector('.history-panel').hidden"), true)
      const readingHeight = await evaluate("document.querySelector('.request-panel').getBoundingClientRect().height")
      await evaluate("document.querySelector('[aria-controls=agentHistory]').click()")
      await until(() => evaluate("!document.querySelector('.history-panel').hidden"), `${theme}/${width}/${zoom}: history opened`)
      const readHistoryMetrics = () => evaluate(`(() => {
        const panel = document.querySelector('.history-panel').getBoundingClientRect();
        const layout = document.querySelector('.agent-layout').getBoundingClientRect();
        return {
          rightOverflow: Math.round(panel.right * devicePixelRatio) - Math.round(innerWidth * devicePixelRatio),
          pageOverflow: document.documentElement.scrollWidth - innerWidth,
          topDifference: panel.top - layout.top,
          readingHeightDifference: document.querySelector('.request-panel').getBoundingClientRect().height - ${readingHeight}
        };
      })()`)
      const historyMetrics = await readHistoryMetrics()
      assert.ok(historyMetrics.rightOverflow <= 0 && historyMetrics.pageOverflow <= 0 &&
        Math.abs(historyMetrics.topDifference) < 1 && Math.abs(historyMetrics.readingHeightDifference) < 1,
        `${theme}/${width}/${zoom}: history geometry ${JSON.stringify(historyMetrics)}`)
      // innerWidth is integer-rounded; start the negative control at its measured boundary.
      const injectedOverflow = await evaluate(`(() => {
        const panel = document.querySelector('.history-panel');
        const beforeRight = panel.getBoundingClientRect().right, beforeWidth = innerWidth;
        panel.style.transform = 'translateX(' + (beforeWidth + 1 - beforeRight) + 'px)';
        const afterRight = panel.getBoundingClientRect().right;
        return { beforeRight, beforeWidth, afterRight, afterWidth: innerWidth,
          devicePixelRatio, pageOverflow: document.documentElement.scrollWidth - innerWidth,
          translation: new DOMMatrixReadOnly(getComputedStyle(panel).transform).m41,
          overflow: afterRight - innerWidth };
      })()`)
      try {
        assert.ok(Math.abs(injectedOverflow.overflow - 1) < 0.001,
          `${theme}/${width}/${zoom}: negative control must inject one CSS pixel of overflow ${JSON.stringify(injectedOverflow)}`)
        assert.ok((await readHistoryMetrics()).rightOverflow > 0, 'one CSS pixel of overflow must be detected')
      } finally {
        await evaluate("document.querySelector('.history-panel').style.removeProperty('transform')")
      }
      await evaluate("document.querySelector('[aria-label=\"收起生成记录\"]').click()")
      await until(() => evaluate("document.querySelector('.history-panel').hidden"), `${theme}/${width}/${zoom}: history closed`)
      const metrics = await evaluate(`(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        const from = rect('#agentDateFrom'), through = rect('#agentDateThrough');
        const label = rect('label[for="agentDateFrom"]'), prompt = rect('#agentPrompt');
        const promptLabel = rect('.prompt-label'), field = rect('.question-field');
        const submit = rect('[data-action="qa"]'), close = rect('.close-button');
        return {
          dateStacked: label.bottom <= from.top && from.bottom < through.top,
          dateEqual: Math.abs(from.width - through.width) < 1 && from.height >= 36,
          promptStacked: promptLabel.bottom <= prompt.top,
          promptFullWidth: Math.abs(prompt.width - field.width) < 1,
          submitAligned: submit.top >= prompt.bottom && Math.abs(submit.right - prompt.right) < 1,
          closeVisible: close.width === 32 && close.height === 32 && close.right <= innerWidth && close.top >= 0,
          noPageOverflow: document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight,
          pageGeometry: { width: innerWidth, height: innerHeight,
            clientWidth: document.documentElement.clientWidth, clientHeight: document.documentElement.clientHeight,
            scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
            bodyWidth: document.body.getBoundingClientRect().width, bodyHeight: document.body.getBoundingClientRect().height,
            shellHeight: rect('.agent-shell').height, layoutHeight: rect('.agent-layout').height },
          disabledWithoutScope: document.querySelector('#agentPrompt').disabled && document.querySelector('[data-action="qa"]').disabled,
          inputBackground: getComputedStyle(document.querySelector('#agentDateFrom')).backgroundColor,
          inputScheme: getComputedStyle(document.querySelector('#agentDateFrom')).colorScheme,
          scrollbarWidth: getComputedStyle(document.querySelector('.request-panel')).scrollbarWidth,
          scrollbarColor: getComputedStyle(document.querySelector('.request-panel')).scrollbarColor
        };
      })()`)
      for (const [key, value] of Object.entries(metrics)) {
        if (typeof value === 'boolean') assert.equal(value, true, `${theme}/${width}/${zoom}: ${key}${key === 'noPageOverflow' ? ` ${JSON.stringify(metrics.pageGeometry)}` : ''}`)
      }
      assert.equal(metrics.inputScheme, theme)
      assert.equal(metrics.scrollbarWidth, 'thin')
      assert.notEqual(metrics.scrollbarColor, 'auto')
      assert.notEqual(metrics.inputBackground, 'rgba(0, 0, 0, 0)')
    }
  }
  win.webContents.debugger.attach('1.3')
  try {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] })
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.request-panel')).scrollbarColor"), 'auto')
    assert.equal(await evaluate("getComputedStyle(document.querySelector('.request-panel')).scrollbarWidth"), 'auto')
  } finally {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    win.webContents.debugger.detach()
  }
  const setDate = async (id, value) => {
    await evaluate(`(() => {
      const field = document.getElementById('${id}');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, '${value}');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
  }
  await setDate('agentDateFrom', '2026-01-02')
  await setDate('agentDateThrough', '2026-01-01')
  assert.equal(await evaluate("document.querySelector('.date-range-fields button').disabled"), true, 'reversed date range disables selection')
  await setDate('agentDateThrough', '2026-01-03')
  await until(() => evaluate("!document.querySelector('.date-range-fields button').disabled"), 'date range enabled')
  await evaluate("document.querySelector('.project-actions button').click()")
  await until(() => evaluate("document.querySelector('.status').textContent.includes('还没有可选择的项目')"), 'empty project receipt')
  assert.equal(await evaluate("document.querySelector('.close-button').getBoundingClientRect().width"), 32, 'close control retains its width after date and project interactions')
  await evaluate("document.querySelector('.close-button').click()")
  await until(() => !findWindow('agent'), 'agent closed')
  await until(() => toolbar.webContents.executeJavaScript("!document.querySelector('#status').textContent.includes('会话总结')"), 'toolbar close receipt')
  await toolbar.webContents.executeJavaScript("document.querySelector('[data-act=agent]').click()")
  await until(() => findWindow('agent'), 'agent reopened')
  const reopened = findWindow('agent')
  await until(() => reopened.webContents.executeJavaScript("Boolean(document.querySelector('#agentPrompt'))"), 'agent reopened renderer')
  await until(() => toolbar.webContents.executeJavaScript("!document.querySelector('#status').textContent.includes('正在打开会话总结')"), 'toolbar reopen receipt')
  await reopened.webContents.executeJavaScript("document.querySelector('.close-button').click()")
  await until(() => !findWindow('agent'), 'reopened agent closed')
  await until(() => toolbar.webContents.executeJavaScript("!document.querySelector('#status').textContent.includes('会话总结')"), 'toolbar second close receipt')
  console.log('AGENT_LAYOUT_OK')
  app.quit()
}
run().catch(error => { console.error(error.message); app.exit(1) })
