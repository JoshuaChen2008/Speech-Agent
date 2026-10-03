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
async function until (probe) {
  for (let i = 0; i < 200; i++) { if (await probe()) return; await wait(50) }
  throw new Error('layout fixture readiness timeout')
}
function findWindow (name) {
  return BrowserWindow.getAllWindows().find(w => w.webContents.getURL().replaceAll('\\', '/').includes(`/${name}/`))
}
async function run () {
  await app.whenReady()
  await until(() => findWindow('toolbar'))
  const toolbar = findWindow('toolbar')
  await until(() => toolbar.webContents.executeJavaScript('Boolean(window.shell)'))
  await toolbar.webContents.executeJavaScript("window.shell.action('agent')")
  await until(() => findWindow('agent'))
  const win = findWindow('agent')
  const evaluate = source => win.webContents.executeJavaScript(source)
  await until(() => evaluate("Boolean(document.querySelector('#agentPrompt'))"))
  if (process.env.AGENT_LAYOUT_INTERACTIVE === '1') return
  await toolbar.webContents.executeJavaScript("window.shell.action('settings')")
  await until(() => findWindow('settings'))
  const settings = findWindow('settings')
  await until(() => settings.webContents.executeJavaScript("Boolean(document.querySelector('[data-preset=meeting]'))"))
  await settings.webContents.executeJavaScript("document.querySelector('[data-preset=meeting]').click()")
  await evaluate("document.querySelector('.scope-filters').open = true; document.querySelector('.session-functions button').click()")
  for (const theme of ['dark', 'light']) {
    await settings.webContents.executeJavaScript(`Array.from(document.querySelectorAll('button')).find(b => b.textContent === '${theme === 'dark' ? '深色' : '浅色'}').click()`)
    await until(() => evaluate(`document.documentElement.dataset.theme === '${theme}'`))
    for (const [width, height, zoom] of [[520, 420, 1], [720, 640, 1], [1100, 720, 1], [720, 640, 1.25]]) {
      win.setSize(width, height)
      win.webContents.setZoomFactor(zoom)
      await wait(100)
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
          disabledWithoutScope: document.querySelector('#agentPrompt').disabled && document.querySelector('[data-action="qa"]').disabled,
          inputBackground: getComputedStyle(document.querySelector('#agentDateFrom')).backgroundColor,
          inputScheme: getComputedStyle(document.querySelector('#agentDateFrom')).colorScheme
        };
      })()`)
      for (const [key, value] of Object.entries(metrics)) {
        if (typeof value === 'boolean') assert.equal(value, true, `${theme}/${width}/${zoom}: ${key}`)
      }
      assert.equal(metrics.inputScheme, theme)
      assert.notEqual(metrics.inputBackground, 'rgba(0, 0, 0, 0)')
    }
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
  assert.equal(await evaluate("document.querySelector('.date-range-fields button').disabled"), true)
  await setDate('agentDateThrough', '2026-01-03')
  await until(() => evaluate("!document.querySelector('.date-range-fields button').disabled"))
  await evaluate("document.querySelector('.project-actions button').click()")
  await until(() => evaluate("document.querySelector('.status').textContent.includes('还没有可选择的项目')"))
  assert.equal(await evaluate("document.querySelector('.close-button').getBoundingClientRect().width === 32"), true)
  await evaluate("document.querySelector('.close-button').click()")
  await until(() => !findWindow('agent'))
  console.log('AGENT_LAYOUT_OK')
  app.quit()
}
run().catch(error => { console.error(error.message); app.exit(1) })
