'use strict'

/*
 * Deterministic J25 product journey.  The production main/preload/renderers
 * remain the system under test; only the provider network seam is substituted
 * by a loopback HTTP responder.  The real eligibility IPC handler is counted
 * and paused once to observe its pending UI without replacing its result.
 * The report deliberately contains no prompt,
 * provider payload, credential, transcript text, or filesystem path.
 */

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, ipcMain } = require('electron')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const eligibilityProbe = { count: 0, nextHold: null }
const inputProbe = { pending: false, rejected: false, invalidCommands: 0 }
const originalIpcHandle = ipcMain.handle.bind(ipcMain)
ipcMain.handle = (channel, handler) => originalIpcHandle(channel, async (...args) => {
  // Pause the real command, inspect its renderer, then retain its real result.
  if (channel === 'agent-model:configure' && args[1]?.command?.httpsOrigin === 'http://invalid.example') {
    inputProbe.invalidCommands += 1
    const contents = args[0].sender
    await waitFor(() => contents.executeJavaScript(`(() => {
      const field = document.querySelector('input[aria-label="API 服务器地址"]')
      return field?.disabled === true
    })()`), 'settings command pending')
    inputProbe.pending = await contents.executeJavaScript(`(() => {
      const field = document.querySelector('input[aria-label="API 服务器地址"]')
      const save = [...field.closest('.group').querySelectorAll('button')].find(b => b.textContent === '保存修改')
      save.click()
      return save.disabled && getComputedStyle(field).opacity === '1'
    })()`)
    const result = await handler(...args)
    inputProbe.rejected = result.ok === false
    return result
  }
  if (channel === 'agent-run:get-eligibility') {
    eligibilityProbe.count += 1
    const hold = eligibilityProbe.nextHold
    eligibilityProbe.nextHold = null
    if (hold) await hold.promise
  }
  return handler(...args)
})

function deferred () {
  let resolve
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function wait (milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function waitFor (probe, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await probe()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await wait(50)
  }
  throw new Error(`${label} timed out${lastError ? `: ${lastError.message}` : ''}`)
}

function windowFor (suffix) {
  return BrowserWindow.getAllWindows().find((win) => {
    if (win.isDestroyed()) return false
    return win.webContents.getURL().replace(/\\/g, '/').includes(suffix)
  }) || null
}

function hostFactory (service, databasePath) {
  let sequence = 0
  const { OPERATIONS, PROTOCOL_VERSION, StorageError, makeCaptionEventId, makeCloseSessionKey, makeOpenSessionKey } =
    require(path.join(PROJECT_ROOT, 'src', 'runtime', 'storage-worker', 'protocol'))
  const call = (operation, payload, idempotencyKey) => {
    const response = service.handle({
      version: PROTOCOL_VERSION,
      type: 'storage:request',
      requestId: `j25-formal.${++sequence}`,
      operation,
      payload,
      ...(idempotencyKey ? { idempotencyKey } : {})
    })
    if (!response.ok) throw new StorageError(response.error.code)
    return response.result
  }
  return {
    state: 'stopped',
    async start () { call(OPERATIONS.INITIALIZE, { databasePath }); this.state = 'ready' },
    async openSession (value) { return call(OPERATIONS.OPEN_SESSION, value, makeOpenSessionKey(value.sessionId)) },
    async appendCaption (event) { return call(OPERATIONS.APPEND_CAPTION, { event }, makeCaptionEventId(event)) },
    async closeSession (value) { return call(OPERATIONS.CLOSE_SESSION, value, makeCloseSessionKey(value.sessionId)) },
    async shutdown () { if (!service.shuttingDown) call(OPERATIONS.SHUTDOWN, {}); this.state = 'closed' },
    async terminateAndWait () { await this.shutdown(); return 0 }
  }
}

async function seedTerminalSession (userDataDir) {
  const { StorageGateway } = require(path.join(PROJECT_ROOT, 'src', 'main', 'services', 'storage-gateway'))
  const { StorageWorkerService } = require(path.join(PROJECT_ROOT, 'src', 'runtime', 'storage-worker', 'worker-service'))
  const databasePath = path.join(userDataDir, 'data', 'speech-agent.sqlite3')
  const service = new StorageWorkerService()
  const gateway = new StorageGateway({
    databasePath,
    hostFactory: () => hostFactory(service, databasePath),
    maxRestarts: 0
  })
  await gateway.start()
  await gateway.openSession({
    sessionId: 'session.j25.formal',
    sourceId: 'mic',
    startedAt: 1770000000000,
    refinementEnabled: false
  })
  await gateway.appendCaption({
    schemaVersion: 1,
    sessionId: 'session.j25.formal',
    sourceId: 'mic',
    segmentId: 'segment.j25.formal',
    sequence: 1,
    revision: 1,
    kind: 'final',
    t0: 0,
    t1: 10,
    text: '受控正式设置到历史旅程输入',
    translation: null
  })
  await gateway.closeSession({
    sessionId: 'session.j25.formal',
    sourceId: 'mic',
    endedAt: 1770000001000,
    state: 'closed'
  })
  await gateway.shutdown()
}

function providerServer () {
  const state = { requestCount: 0, modelIds: [], credentialObserved: false, credentialExact: false }
  const server = http.createServer((request, response) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      if (!['/chat/completions', '/v1/chat/completions'].includes(request.url) || request.method !== 'POST') {
        response.writeHead(404)
        response.end()
        return
      }
      let body = null
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
      state.requestCount += 1
      if (typeof request.headers.authorization === 'string' && request.headers.authorization.length > 0) {
        state.credentialObserved = true
      }
      if (request.headers.authorization === 'Bearer j25-local-provider-secret') state.credentialExact = true
      if (typeof body?.model === 'string') state.modelIds.push(body.model)
      const isRouteRequest = !Array.isArray(body?.tools) || body.tools.length === 0
      const content = isRouteRequest
        ? JSON.stringify({ recipeId: 'qa.answer', confidence: 0.9 })
        : JSON.stringify({
            schemaVersion: 1,
            answer: '受控 provider 返回的正式 Agent 结果。',
            sourceRefs: [{ sessionId: 'session.j25.formal', transcriptVersion: 'raw', fromEventOrder: 1, throughEventOrder: 1 }],
            memoryRefs: [],
            unresolved: []
          })
      const payload = {
        choices: [{
          message: {
            content
          }
        }],
        usage: { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 }
      }
      const encoded = JSON.stringify(payload)
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) })
      response.end(encoded)
    })
  })
  return { server, state }
}

// Computed renderer checks are deterministic evidence, not physical DPI/Mica observations.
async function inspectInputAppearance (settings) {
  const wc = settings.webContents
  const evaluate = (source) => wc.executeJavaScript(source)
  wc.debugger.attach('1.3')
  try {
    await evaluate(`document.querySelector('.nav-item[data-pane="agentModel"]').click()`)
    await waitFor(() => evaluate(`Boolean(document.querySelector('input[aria-label="新服务名称"]'))`), 'new profile inputs')
    await evaluate(`document.querySelector('.agent-model-new-profile > summary').click()`)
    await waitFor(() => evaluate(`document.querySelector('input[aria-label="新服务名称"]').getBoundingClientRect().height > 0`), 'expanded input geometry')
    const selector = 'input[aria-label="新服务名称"]'
    const dimensions = () => evaluate(`(() => { const r = document.querySelector('${selector}').getBoundingClientRect(); return [r.width, r.height] })()`)
    const before = await dimensions()
    settings.show()
    settings.focus()
    wc.focus()
    await waitFor(() => evaluate(`(() => { const e = document.querySelector('${selector}'); e.focus(); return document.activeElement === e })()`), 'input focus before Tab')
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' })
    await waitFor(() => evaluate(`document.activeElement.getAttribute('aria-label') === '新服务 API 服务器地址'`), 'Tab reaches next input')
    const keyboardFocus = await evaluate(`(() => {
      const field = document.activeElement, css = getComputedStyle(field)
      return field.getAttribute('aria-label') === '新服务 API 服务器地址' && field.matches(':focus-visible') &&
        css.outlineStyle === 'solid' && parseFloat(css.outlineWidth) > 0
    })()`)
    const point = await evaluate(`(() => { const e = document.querySelector('${selector}'); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + 10, y: r.y + 10 } })()`)
    await wc.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
    const after = await dimensions()
    const stableGeometry = before.every((n, i) => n === after[i]) && await evaluate(`document.querySelector('${selector}').matches(':hover')`)
    // Ordinary themes use the production preference buttons, not CSS attribute injection.
    const themes = []
    for (const theme of ['light', 'dark', 'auto']) {
      await evaluate(`document.querySelector('.nav-item[data-pane="display"]').click()`)
      await evaluate(`document.querySelector('[data-seg="theme"] [data-val="${theme}"]').click()`)
      await evaluate(`document.querySelector('.nav-item[data-pane="agentModel"]').click()`)
      await waitFor(() => evaluate(`Boolean(document.querySelector('${selector}'))`), 'theme profile remount')
      const style = await evaluate(`(() => {
        const e = document.querySelector('input[aria-label="新服务名称"]'), s = getComputedStyle(e)
        return { background: s.backgroundColor, foreground: s.color, radius: s.borderRadius }
      })()`)
      themes.push(style)
    }
    const themeReadable = themes.every(s => s.background !== 'rgba(0, 0, 0, 0)' && s.radius === '8px') &&
      themes[0].foreground !== themes[1].foreground
    await evaluate(`document.querySelector('.nav-item[data-pane="agentModel"]').click(); document.querySelector('.agent-model-new-profile').open = true`)
    const controlledStates = await evaluate(`(() => {
      const e = document.querySelector('${selector}')
      const normal = getComputedStyle(e)
      const expected = [normal.backgroundColor, normal.fontFamily, normal.borderRadius].join('|')
      const types = ['text', 'url', 'search', 'email'].every(type => {
        e.type = type
        const css = getComputedStyle(e)
        return [css.backgroundColor, css.fontFamily, css.borderRadius].join('|') === expected
      })
      e.removeAttribute('type')
      e.readOnly = true
      const readonly = getComputedStyle(e).borderStyle === 'dashed' && !e.disabled
      e.readOnly = false; e.setAttribute('aria-invalid', 'true')
      const invalid = getComputedStyle(e).borderTopColor
      e.removeAttribute('aria-invalid')
      return types && readonly && invalid !== getComputedStyle(e).borderTopColor
    })()`)
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }, { name: 'prefers-reduced-motion', value: 'reduce' }] })
    const systemPreferences = await evaluate(`(() => {
      const s = getComputedStyle(document.querySelector('${selector}'))
      return matchMedia('(forced-colors: active)').matches && s.borderTopStyle !== 'none' &&
        s.color !== s.backgroundColor && getComputedStyle(document.querySelector('.pane.active')).animationName === 'none'
    })()`)
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    let fits = true
    for (const zoom of [1, 1.25, 1.5, 2]) {
      wc.setZoomFactor(zoom)
      fits = fits && await evaluate(`(() => {
        const e = document.querySelector('${selector}')
        const value = e.value; e.value = 'long-model-'.repeat(80)
        const main = document.querySelector('.content'), r = e.getBoundingClientRect(), m = main.getBoundingClientRect()
        const fits = r.width > 0 && r.height >= 36 && main.scrollWidth <= main.clientWidth + 1 && r.right <= m.right && r.left >= m.left
        e.value = value
        return fits
      })()`)
    }
    wc.setZoomFactor(1)
    await evaluate(`document.querySelector('.nav-item[data-pane="display"]').click()`)
    await evaluate(`(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      for (const [id, value] of [['opacity', '0.6'], ['barColor', '#123456']]) {
        const e = document.getElementById(id)
        setter.call(e, value); e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }))
      }
    })()`)
    await waitFor(() => evaluate(`document.getElementById('opacityVal').textContent === '0.60' && document.getElementById('barColorVal').textContent === '#123456'`), 'specialized controls preview')
    const specialized = await evaluate(`(() => {
      const color = document.querySelector('input[type="color"]'), range = document.querySelector('input[type="range"]')
      const checkbox = document.querySelector('input[type="checkbox"]')
      return getComputedStyle(color).height === '26px' && getComputedStyle(range).height === '4px' &&
        getComputedStyle(checkbox).minHeight !== '36px'
    })()`)
    await evaluate(`document.getElementById('barColorReset').click()`)
    await waitFor(() => evaluate(`document.getElementById('barColorVal').textContent === '跟随主题'`), 'color reset')
    // Resume the real first-run wizard to inspect its password/model/number controls.
    await evaluate(`document.querySelector('.nav-item[data-pane="agentModel"]').click()`)
    await waitFor(() => evaluate(`Boolean(document.querySelector('.agent-model-preset-launcher'))`), 'wizard launcher')
    await evaluate(`document.querySelector('.agent-model-preset-launcher').click()`)
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-wizard-step="connection"]'))`), 'wizard connection')
    await evaluate(`document.querySelector('[data-wizard-step="connection"] .primary-btn').click()`)
    await waitFor(() => evaluate(`Boolean(document.querySelector('input[aria-label="首次配置 API 密钥"]'))`), 'wizard password')
    const wizardPassword = await evaluate(`(() => {
      const e = document.querySelector('input[aria-label="首次配置 API 密钥"]'), css = getComputedStyle(e)
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(e, 'j25-wizard-secret')
      e.dispatchEvent(new Event('input', { bubbles: true }))
      return parseFloat(css.minHeight) >= 36 && css.borderRadius === '8px'
    })()`)
    await waitFor(() => evaluate(`document.querySelector('[data-wizard-step="credential"] .primary-btn')?.disabled === false`), 'wizard credential editable')
    await evaluate(`document.querySelector('[data-wizard-step="credential"] .primary-btn').click()`)
    await waitFor(() => evaluate(`Boolean(document.querySelector('[data-wizard-step="model"] input[type="number"]'))`), 'wizard model')
    const wizardInputs = wizardPassword && await evaluate(`(() => {
      const fields = [...document.querySelectorAll('[data-wizard-step="model"] input')]
      return fields.length >= 3 && fields.every(e => {
        const css = getComputedStyle(e)
        return parseFloat(css.minHeight) >= 36 && css.borderRadius === '8px' && css.fontFamily === getComputedStyle(document.body).fontFamily
      })
    })()`)
    await evaluate(`document.querySelector('.wizard-exit').click()`)
    return { keyboardFocus, stableGeometry, themeReadable, controlledStates, systemPreferences, fits, specialized, wizardInputs }
  } finally {
    wc.setZoomFactor(1)
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] })
    wc.debugger.detach()
  }
}

/* Native picker probe: this is a real BrowserWindow/input path, not a synthetic
   change event.  A headless runner may be unable to expose the OS popup, so the
   report keeps `opened` as an observation while still requiring Escape to retain
   the value and emit no change event. */
async function inspectNativePicker (settings) {
  const wc = settings.webContents
  const evaluate = (source) => wc.executeJavaScript(source)
  await evaluate(`document.querySelector('.nav-item[data-pane="agentModel"]')?.click()`)
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-purpose="default"] select'))`), 'native select picker target')
  const before = await evaluate(`(() => {
    const select = document.querySelector('[data-purpose="default"] select')
    window.__nativeSelectChanges = 0
    select.addEventListener('change', () => { window.__nativeSelectChanges += 1 }, { once: false })
    select.focus()
    const rect = select.getBoundingClientRect()
    return {
      value: select.value,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      supportsAppearance: CSS.supports('appearance', 'base-select'),
      supportsPicker: CSS.supports('selector(::picker(select))')
    }
  })()`)
  settings.show()
  settings.focus()
  wc.focus()
  const point = {
    x: Math.round(before.rect.x + before.rect.width / 2),
    y: Math.round(before.rect.y + before.rect.height / 2)
  }
  wc.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
  wc.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
  await wait(150)
  const opened = await evaluate(`(() => {
    try { return document.querySelector('[data-purpose="default"] select').matches(':open') } catch { return false }
  })()`)
  if (opened) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'ARROWDOWN' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'ARROWDOWN' })
    await wait(50)
  }
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' })
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' })
  await wait(150)
  const after = await evaluate(`(() => {
    const select = document.querySelector('[data-purpose="default"] select')
    let open = false
    try { open = select.matches(':open') } catch {}
    return { open, value: select.value, changes: window.__nativeSelectChanges }
  })()`)
  return {
    attempted: true,
    opened,
    supportsAppearance: before.supportsAppearance,
    supportsPicker: before.supportsPicker,
    cancelValuePreserved: after.value === before.value && after.open === false,
    noChangeAfterCancel: after.changes === 0,
    changeCount: after.changes
  }
}

async function configureThroughSettings (settings, port) {
  return settings.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const waitFor = async (probe, label) => {
      for (let i = 0; i < 160; i += 1) {
        const value = probe()
        if (value) return value
        await sleep(50)
      }
      throw new Error(label + ' timed out')
    }
    const clickText = (root, text) => {
      const button = [...root.querySelectorAll('button')].find((item) => item.textContent === text)
      if (!button) throw new Error('button not found: ' + text)
      button.click()
    }
    const setInput = (input, value) => {
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value').set
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const select = (element, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setter.call(element, value)
      element.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const setChecked = (input, checked) => {
      if (input.checked !== checked) input.click()
    }

    await waitFor(() => document.querySelector('#onboarding'), 'settings onboarding')
    if (!document.querySelector('#onboarding').hidden) document.querySelector('[data-preset="meeting"]').click()
    await waitFor(() => document.querySelector('#onboarding').hidden, 'settings onboarding dismissed')
    const nav = await waitFor(() => document.querySelector('[data-pane="agentModel"]'), 'agent model navigation')
    nav.click()
    const agentToggle = await waitFor(() => document.querySelector('input[aria-label="启用 Agent 系统"]'), 'Agent system toggle')
    setChecked(agentToggle, true)
    await waitFor(() => document.querySelector('input[aria-label="启用 Agent 系统"]')?.checked === true, 'Agent system enabled')
    const cardFor = () => document.querySelector('[data-profile-id="deepseek"]')
    await waitFor(cardFor, 'deepseek profile')
    clickText(cardFor(), '编辑连接')
    await waitFor(() => cardFor()?.querySelector('input[aria-label="API 服务器地址"]'), 'connection editor')
    const address = cardFor().querySelector('input[aria-label="API 服务器地址"]')
    const styled = (element) => {
      const css = getComputedStyle(element)
      return css.fontFamily === getComputedStyle(document.body).fontFamily &&
        css.borderRadius === getComputedStyle(document.documentElement).getPropertyValue('--radius-control').trim() &&
        parseFloat(css.minHeight) >= 36 && css.backgroundColor !== 'rgba(0, 0, 0, 0)'
    }
    const textStyled = styled(address)
    setInput(cardFor().querySelector('input[aria-label="API 服务器地址"]'), 'https://127.0.0.1:${port}')
    await sleep(0)
    clickText(cardFor(), '保存修改')
    await waitFor(() => [...cardFor().querySelectorAll('button')].some((item) => item.textContent === '编辑连接'), 'connection saved')

    clickText(cardFor(), '添加模型')
    const modelId = await waitFor(() => cardFor()?.querySelector('input[aria-label="模型名称（Model ID）"]'), 'model form')
    setInput(modelId, 'j25-local-model')
    setInput(cardFor().querySelector('input[aria-label="最大输入 token"]'), '64000')
    setInput(cardFor().querySelector('input[aria-label="最大输出 token"]'), '4096')
    const numberStyled = styled(cardFor().querySelector('input[type="number"]'))
    for (const label of ['工具调用', '结构化输出', '流式输出', '用量上报']) {
      const group = await waitFor(() => cardFor()?.querySelector('[aria-label="' + label + '"]'), label + ' capability group')
      clickText(group, '支持')
      await waitFor(() => cardFor()?.querySelector('[aria-label="' + label + '"] button[aria-pressed="true"]'), label + ' capability selected')
    }
    await waitFor(() => [...cardFor().querySelectorAll('button')].some((item) => item.textContent === '保存模型' && !item.disabled), 'model form valid')
    clickText(cardFor(), '保存模型')
    await waitFor(() => cardFor()?.querySelector('[data-model-id="j25-local-model"]'), 'model saved')

    const credential = cardFor().querySelector('input[type="password"]')
    const passwordStyled = styled(credential)
    setInput(credential, 'j25-local-provider-secret')
    clickText(cardFor(), '设置新的 API 密钥')
    await waitFor(() => credential.value === '', 'credential cleared')

    // Exercise a configured connection failure; keep the real credential lifecycle intact.
    clickText(cardFor(), '编辑连接')
    const failingAddress = await waitFor(() => cardFor()?.querySelector('input[aria-label="API 服务器地址"]'), 'configured connection editor')
    setInput(failingAddress, 'http://invalid.example')
    await sleep(0)
    clickText(cardFor(), '保存修改')
    await waitFor(() => document.querySelector('section[data-pane="agentModel"] [role="alert"]') && !failingAddress.disabled, 'invalid connection restored')
    const failedInputRetained = failingAddress.value === 'http://invalid.example'
    const catalog = await window.shell.getAgentModelCatalog({ contractId: 'agent-model-ui', contractVersion: '1.0.0' })
    const failedConfigUnchanged = catalog.ok === true && catalog.snapshot.profiles.find(p => p.profileId === 'deepseek').httpsOrigin === 'https://127.0.0.1:${port}'
    clickText(failingAddress.closest('.group'), '取消')
    await waitFor(() => !cardFor()?.querySelector('input[aria-label="API 服务器地址"]'), 'connection editor closed')

    const purpose = document.querySelector('[data-purpose="default"] select')
    await waitFor(() => purpose && [...purpose.options].some((option) => option.value === 'deepseek::j25-local-model'), 'purpose target')
    let selectStyled = styled(purpose) && [...purpose.options].every((option) => {
      const css = getComputedStyle(option)
      return css.backgroundColor !== 'rgba(0, 0, 0, 0)' && css.color !== css.backgroundColor
    })
    select(purpose, 'deepseek::j25-local-model')
    await waitFor(() => document.querySelector('[data-purpose="default"]').textContent.includes('普通请求：配置充分'), 'purpose assigned')
    const defaultReady = document.querySelector('[data-purpose="default"]').textContent.includes('普通请求：配置充分')

    const contextNav = await waitFor(() => document.querySelector('[data-pane="agentContext"]'), 'personal context navigation')
    contextNav.click()
    const remember = await waitFor(() => document.querySelector('textarea[aria-label="记住个人记忆"]'), 'remember form')
    const textareaStyled = styled(remember) && getComputedStyle(remember).resize === 'vertical' && parseFloat(getComputedStyle(remember).minHeight) >= 70
    const contextSelects = [...document.querySelectorAll('.agent-context-form-row select')]
    const contextSelectsStyled = contextSelects.length === 2 && contextSelects.every((element) => styled(element) && [...element.options].every((option) => {
      const css = getComputedStyle(option)
      return css.backgroundColor !== 'rgba(0, 0, 0, 0)' && css.color !== css.backgroundColor
    }))
    selectStyled = selectStyled && contextSelectsStyled
    setInput(remember, 'J25 formal settings memory')
    clickText(document.querySelector('section[data-pane="agentContext"]'), '记住')
    const memory = await waitFor(() => document.querySelector('[data-memory-id]'), 'remembered memory')
    const memoryId = memory.getAttribute('data-memory-id')
    const memoryLabel = memory.getAttribute('aria-label') || ''
    const contextSection = () => document.querySelector('section[data-pane="agentContext"]')
    const memoryRow = () => document.querySelector('[data-memory-id="' + memoryId + '"]')
    const forgetButton = await waitFor(() => memoryRow()?.querySelector('button[aria-label^="忘记个人记忆："]'), 'forget action')
    forgetButton.click()
    const forgetDialog = await waitFor(() => contextSection()?.querySelector('[role="alertdialog"]'), 'forget confirmation')
    clickText(forgetDialog, '确认')
    await waitFor(() => {
      const row = memoryRow()
      if (!row) return false
      const expand = row.querySelector('.agent-context-expand')
      if (expand && expand.getAttribute('aria-expanded') !== 'true') expand.click()
      return row.textContent.includes('已退出检索')
    }, 'forgotten memory')
    const deleteButton = await waitFor(() => memoryRow()?.querySelector('button[aria-label^="删除个人记忆："]'), 'delete action')
    deleteButton.click()
    const deleteDialog = await waitFor(() => contextSection()?.querySelector('[role="alertdialog"]'), 'delete confirmation')
    clickText(deleteDialog, '确认')
    await waitFor(() => memoryRow() === null, 'deleted memory')
    const contextHeader = { contract_id: 'speech-agent.personal-context.ui', contract_version: '1.1.0' }
    const processingToggle = await waitFor(() => document.querySelector('input[aria-label="个人记忆自动处理"]'), 'memory processing toggle')
    processingToggle.click()
    const suspendDialog = await waitFor(() => contextSection()?.querySelector('[role="alertdialog"]'), 'suspend confirmation')
    clickText(suspendDialog, '确认')
    await waitFor(() => document.querySelector('input[aria-label="个人记忆自动处理"]')?.checked === false, 'memory processing suspended')
    const processingSuspended = document.querySelector('input[aria-label="个人记忆自动处理"]')?.checked === false &&
      contextSection()?.textContent.includes('已休眠')
    document.querySelector('input[aria-label="个人记忆自动处理"]')?.click()
    const enableDialog = await waitFor(() => contextSection()?.querySelector('[role="alertdialog"]'), 're-enable confirmation')
    clickText(enableDialog, '确认')
    await waitFor(() => document.querySelector('input[aria-label="个人记忆自动处理"]')?.checked === true, 'memory processing re-enabled')
    const processingReenabled = document.querySelector('input[aria-label="个人记忆自动处理"]')?.checked === true &&
      contextSection()?.textContent.includes('处理中')
    const overview = await window.shell.getAgentContextOverview(contextHeader)
    const currentRevision = Number(overview?.snapshot?.revision)
    const staleResponse = currentRevision > 0
      ? await window.shell.manageAgentContext({
          ...contextHeader,
          request_id: 'context.j25.revision-conflict',
          command: {
            type: 'remember',
            expected_revision: currentRevision - 1,
            entry: { display_text: 'stale revision probe', kind: 'term', scope: { kind: 'global', reference: null } }
          }
        })
      : null
    const revisionConflict = currentRevision > 0 && staleResponse?.ok === false &&
      staleResponse.error?.code === 'AGENT_CONTEXT_REVISION_CONFLICT'
    nav.click()
    await waitFor(() => document.querySelector('[data-pane="agentModel"]'), 'model pane after context management')
    await waitFor(cardFor, 'model profile after context management')
    const profileConnection = cardFor()?.textContent.includes('https://127.0.0.1:${port}') === true
    const modelVisible = cardFor()?.querySelector('[data-model-id="j25-local-model"]') !== null
    const credentialCleared = credential.value === ''
    contextNav.click()
    await waitFor(() => document.querySelector('textarea[aria-label="记住个人记忆"]'), 'context pane after context management')

    return {
      inputsStyled: { textStyled, numberStyled, passwordStyled, selectStyled, textareaStyled },
      inputFailureRecovered: failedInputRetained && failedConfigUnchanged,
      profileConnection,
      modelVisible,
      credentialCleared,
      defaultReady,
      agentEnabled: agentToggle.checked === true,
      memoryManaged: memoryId !== null && memoryLabel.length > 0 && memoryRow() === null &&
        document.querySelector('[data-memory-id="' + memoryId + '"]') === null,
      processingSuspended,
      processingReenabled,
      revisionConflict
    }
  })()`)
}

async function runAgentBar (toolbar) {
  await toolbar.webContents.executeJavaScript("window.shell.openAgent(); true")
  const agent = await waitFor(() => windowFor('/agent/index.html'), 'Agent Bar window')
  await waitFor(async () => agent.webContents.executeJavaScript("document.readyState === 'complete'"), 'Agent Bar renderer')
  await waitFor(async () => agent.webContents.executeJavaScript("Boolean(document.querySelector('.scope-card'))"), 'terminal scope')
  await waitFor(async () => agent.webContents.executeJavaScript("document.querySelector('.eligibility')?.textContent === '可以生成'"), 'provider eligibility')
  const readsBeforeManualRefresh = eligibilityProbe.count
  const eligibilityHold = deferred()
  eligibilityProbe.nextHold = eligibilityHold
  await agent.webContents.executeJavaScript("document.querySelector('.scope-panel .panel-heading button').click(); true")
  await waitFor(() => eligibilityProbe.count > readsBeforeManualRefresh, 'manual eligibility refresh')
  const submitDisabledDuringEligibilityRefresh = await agent.webContents.executeJavaScript("document.querySelector('[data-action=\"qa\"]')?.disabled === true && document.querySelector('[data-action=\"minutes\"]')?.disabled === true")
  eligibilityHold.resolve()
  await waitFor(async () => agent.webContents.executeJavaScript("document.querySelector('.eligibility')?.textContent === '可以生成'"), 'refreshed provider eligibility')
  const result = await agent.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const waitFor = async (probe, label) => {
      for (let i = 0; i < 240; i += 1) {
        const value = probe()
        if (value) return value
        await sleep(50)
      }
      throw new Error(label + ' timed out')
    }
    const setInput = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const headers = { contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0' }
    const prompt = document.querySelector('#agentPrompt')
    setInput(prompt, '请回答这场会的重点')
    document.querySelector('[data-action="qa"]').click()
    await waitFor(() => document.querySelector('.run-card'), 'submitted interaction')
    let detail = null
    let history = null
    let interactionId = null
    for (let i = 0; i < 240; i += 1) {
      history = await window.agentApi.getHistory({ ...headers, limit: 50, cursor: null })
      interactionId = history?.ok === true ? history.result.items[0]?.interaction_id : null
      if (!interactionId) { await sleep(50); continue }
      detail = await window.agentApi.getInteraction({ ...headers, interaction_id: interactionId })
      if (detail.ok === true && ['succeeded', 'failed', 'cancelled'].includes(detail.result.state)) break
      await sleep(50)
    }
    return {
      succeeded: detail?.ok === true && detail.result.state === 'succeeded',
      historyVisible: history?.ok === true && history.result.items.some((item) => item.interaction_id === interactionId),
      modelVisible: detail?.result?.model?.model_id === 'j25-local-model',
      interactionId,
      resultDigest: detail?.result?.result_digest || null
    }
  })()`)
  await agent.webContents.reload()
  await waitFor(async () => agent.webContents.executeJavaScript("document.readyState === 'complete'"), 'reloaded Agent Bar renderer')
  await waitFor(async () => agent.webContents.executeJavaScript("Boolean(document.querySelector('.history-card'))"), 'history renderer')
  const feedback = await agent.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const waitFor = async (probe, label) => {
      for (let i = 0; i < 240; i += 1) {
        const value = probe()
        if (value) return value
        await sleep(50)
      }
      throw new Error(label + ' timed out')
    }
    const setInput = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const headers = { contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0' }
    const interactionId = ${JSON.stringify(result.interactionId)}
    const resultDigest = ${JSON.stringify(result.resultDigest)}
    document.querySelector('.history-card').click()
    const editor = await waitFor(() => document.querySelector('#agentEdit'), 'edit feedback form')
    setInput(editor, 'J25 renderer feedback')
    document.querySelector('[data-signal="edit"]').click()
    const feedbackSubmittedThroughRenderer = Boolean(await waitFor(() => document.querySelector('.signal-status')?.textContent.includes('已记录交互反馈'), 'renderer feedback receipt'))
    const detailAfterFeedback = await window.agentApi.getInteraction({ ...headers, interaction_id: interactionId })
    const signal = await window.agentApi.recordSignal({
      ...headers, interaction_id: interactionId, signal_kind: 'accept', payload: null,
      result_digest: resultDigest, signal_idempotency_key: 'signal.j25.formal.accept'
    })
    const signalReplay = signal?.ok === true ? await window.agentApi.recordSignal({
      ...headers, interaction_id: interactionId, signal_kind: 'accept', payload: null,
      result_digest: resultDigest, signal_idempotency_key: 'signal.j25.formal.accept'
    }) : null
    return {
      signalAccepted: signal?.ok === true && signal.result?.accepted === true,
      signalReplayed: signalReplay?.ok === true && signalReplay.result?.replayed === true,
      feedbackSubmittedThroughRenderer,
      detailRereadAfterFeedback: detailAfterFeedback?.ok === true &&
        detailAfterFeedback.result.interaction_id === interactionId &&
        detailAfterFeedback.result.state === 'succeeded' &&
        detailAfterFeedback.result.result_digest === resultDigest
    }
  })()`)
  await agent.webContents.reload()
  await waitFor(async () => agent.webContents.executeJavaScript("document.readyState === 'complete'"), 'feedback-reloaded Agent Bar renderer')
  await waitFor(async () => agent.webContents.executeJavaScript("Boolean(document.querySelector('.history-card'))"), 'feedback history renderer')
  const ui = await agent.webContents.executeJavaScript(`(() => {
    const visible = document.body.textContent
    return {
      historyVisible: document.querySelector('.history-card') !== null,
      modelVisible: visible.includes('j25-local-model'),
      promptAbsent: !visible.includes('请回答这场会的重点'),
      credentialAbsent: !visible.includes('j25-local-provider-secret')
    }
  })()`)
  return {
    ...result,
    ...feedback,
    ...ui,
    manualEligibilityRefresh: eligibilityProbe.count > readsBeforeManualRefresh,
    submitDisabledDuringEligibilityRefresh,
    eligibilityReadCount: eligibilityProbe.count
  }
}

async function main () {
  const rawUserDataDir = process.env.J25_FORMAL_USER_DATA
  if (typeof rawUserDataDir !== 'string' || rawUserDataDir.length === 0) throw new Error('J25_FORMAL_USER_DATA is required')
  const userDataDir = path.resolve(rawUserDataDir)
  if (userDataDir === path.parse(userDataDir).root || userDataDir === PROJECT_ROOT) throw new Error('J25_FORMAL_USER_DATA must be isolated')
  fs.mkdirSync(userDataDir, { recursive: true })
  app.setPath('userData', userDataDir)
  await seedTerminalSession(userDataDir)

  const provider = providerServer()
  await new Promise((resolve, reject) => {
    provider.server.once('error', reject)
    provider.server.listen(0, '127.0.0.1', resolve)
  })
  const port = provider.server.address().port
  const originalFetch = globalThis.fetch
  const localOrigin = `https://127.0.0.1:${port}`
  globalThis.fetch = (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input?.url
    if (typeof rawUrl === 'string' && rawUrl.startsWith(localOrigin)) {
      const rewritten = rawUrl.replace(localOrigin, `http://127.0.0.1:${port}`)
      return originalFetch(rewritten, init)
    }
    return originalFetch(input, init)
  }

  require(path.join(PROJECT_ROOT, 'src', 'main.js'))
  try {
    await app.whenReady()
    const settings = await waitFor(() => windowFor('/settings/settings.html'), 'settings window')
    const toolbar = await waitFor(() => windowFor('/toolbar/index.html'), 'toolbar window')
    await waitFor(async () => toolbar.webContents.executeJavaScript("document.readyState === 'complete'"), 'toolbar renderer')
    const settingsResult = await configureThroughSettings(settings, port)
    const nativePicker = await inspectNativePicker(settings)
    const inputAppearance = await inspectInputAppearance(settings)
    const runResult = await runAgentBar(toolbar)
    const report = {
      schemaVersion: 1,
      result: Object.values(inputAppearance).every(Boolean) && Object.values(settingsResult.inputsStyled).every(Boolean) && settingsResult.inputFailureRecovered &&
        nativePicker.opened && nativePicker.cancelValuePreserved && nativePicker.noChangeAfterCancel &&
        inputProbe.pending && inputProbe.rejected && inputProbe.invalidCommands === 1 &&
        settingsResult.profileConnection && settingsResult.modelVisible && settingsResult.credentialCleared &&
        settingsResult.defaultReady && settingsResult.agentEnabled && settingsResult.memoryManaged &&
        settingsResult.processingSuspended && settingsResult.processingReenabled && settingsResult.revisionConflict &&
        runResult.succeeded && runResult.historyVisible && runResult.modelVisible && runResult.signalAccepted &&
        runResult.signalReplayed && runResult.manualEligibilityRefresh && runResult.submitDisabledDuringEligibilityRefresh &&
        runResult.feedbackSubmittedThroughRenderer && runResult.detailRereadAfterFeedback &&
        runResult.promptAbsent && runResult.credentialAbsent && provider.state.requestCount === 1 &&
        provider.state.credentialObserved && provider.state.credentialExact && provider.state.modelIds.length === 1 && provider.state.modelIds[0] === 'j25-local-model',
      settingsPath: 'formal-settings-renderer-preload',
      inputAppearance,
      nativePicker,
      inputsStyled: settingsResult.inputsStyled,
      inputFailureRecovered: settingsResult.inputFailureRecovered,
      inputPendingObserved: inputProbe.pending,
      invalidInputCommandCount: inputProbe.invalidCommands,
      runPath: 'formal-agent-bar-renderer-preload-main',
      historyPath: 'formal-agent-history-renderer-preload-main',
      providerRequestCount: provider.state.requestCount,
      providerCredentialObserved: provider.state.credentialObserved,
      providerCredentialExact: provider.state.credentialExact,
      modelIdentityObserved: runResult.modelVisible,
      agentEnabled: settingsResult.agentEnabled,
      personalContextManaged: settingsResult.memoryManaged,
      processingSuspended: settingsResult.processingSuspended,
      processingReenabled: settingsResult.processingReenabled,
      personalContextRevisionConflict: settingsResult.revisionConflict,
      interactionSignalAccepted: runResult.signalAccepted,
      interactionSignalReplayed: runResult.signalReplayed,
      manualEligibilityRefresh: runResult.manualEligibilityRefresh,
      submitDisabledDuringEligibilityRefresh: runResult.submitDisabledDuringEligibilityRefresh,
      eligibilityReadCount: runResult.eligibilityReadCount,
      feedbackSubmittedThroughRenderer: runResult.feedbackSubmittedThroughRenderer,
      detailRereadAfterFeedback: runResult.detailRereadAfterFeedback,
      transcriptAndPromptAbsentFromReport: true,
      publicProvider: false,
      systemCredential: false
    }
    process.stdout.write(`${JSON.stringify(report)}\n`)
  } finally {
    globalThis.fetch = originalFetch
    await new Promise((resolve) => provider.server.close(resolve))
    app.quit()
  }
}

void main().catch((error) => {
  process.stderr.write(`${error && error.stack ? error.stack : error}\n`)
  try { app.quit() } catch {}
  process.exitCode = 1
})
