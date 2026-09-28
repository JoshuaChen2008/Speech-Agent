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
const crypto = require('node:crypto')
const { app, BrowserWindow, dialog, ipcMain } = require('electron')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')
const eligibilityProbe = { count: 0, nextHold: null }
const inputProbe = { pending: false, rejected: false, failureCode: null, invalidCommands: 0 }
const submitReceipts = []
const runControlProbe = {
  cancelElapsedMs: null, cancelState: null, diagnosticsExportStatus: null, summaryAcceptResults: [],
  summaryCancelCommandCount: 0,
  dropChangedRequestId: null, droppedChangedCount: 0,
  capacityRequestNotificationLossObserved: false
}
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
    inputProbe.failureCode = result.error?.code || null
    return result
  }
  if (channel === 'agent-run:get-eligibility') {
    eligibilityProbe.count += 1
    const hold = eligibilityProbe.nextHold
    eligibilityProbe.nextHold = null
    if (hold) await hold.promise
  }
  const startedAt = channel === 'session-summary-run:cancel' ? process.hrtime.bigint() : null
  const response = await handler(...args)
  if (channel === 'session-summary-run:accept') {
    runControlProbe.summaryAcceptResults.push({
      accepted: response?.ok === true && response.result?.accepted === true,
      errorCode: response?.error?.code || response?.result?.error_code || null
    })
  }
  if (channel === 'session-summary-run:cancel') runControlProbe.summaryCancelCommandCount += 1
  if (channel === 'session-summary-run:accept' && response?.ok === true && response.result?.accepted === true) {
    const snapshot = response.result.snapshot
    if (snapshot.action === 'summary') runControlProbe.dropChangedRequestId = snapshot.request_id
    submitReceipts.push({
      requestId: snapshot.request_id,
      generation: snapshot.generation,
      recipeId: snapshot.action === 'question' ? 'qa.answer' : 'summary.minutes'
    })
  }
  if (startedAt !== null) {
    runControlProbe.cancelElapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6
    runControlProbe.cancelState = response?.result?.snapshot?.state || null
  }
  if (channel === 'session-summary-run:diagnostics-export') {
    runControlProbe.diagnosticsExportStatus = response?.ok === true ? response.result?.status || null : null
  }
  return response
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
    text: 'J30-ELECTRON-PRIVACY-TRANSCRIPT-MARKER',
    translation: null
  })
  await gateway.closeSession({
    sessionId: 'session.j25.formal',
    sourceId: 'mic',
    endedAt: 1770000001000,
    state: 'closed'
  })
  const capacitySessionId = 'session.j25.synthetic-capacity'
  await gateway.openSession({
    sessionId: capacitySessionId,
    sourceId: 'mic',
    startedAt: 1770000002000,
    refinementEnabled: false
  })
  for (let sequence = 1; sequence <= 1589; sequence += 1) {
    await gateway.appendCaption({
      schemaVersion: 1,
      sessionId: capacitySessionId,
      sourceId: 'mic',
      segmentId: `${capacitySessionId}.segment.${sequence}`,
      sequence,
      revision: 1,
      kind: 'final',
      t0: sequence * 10,
      t1: sequence * 10 + 9,
      text: '合成字幕内容用于容量边界验证。'.repeat(5),
      translation: null
    })
  }
  await gateway.closeSession({
    sessionId: capacitySessionId,
    sourceId: 'mic',
    endedAt: 1770000003000,
    state: 'closed'
  })
  await gateway.shutdown()
}

function providerServer () {
  let markSummaryRequested
  const state = {
    requestCount: 0, modelIds: [], requestShapes: [], credentialObserved: false, credentialExact: false,
    holdNextSummary: false,
    heldSummarySockets: [],
    heldSummaryResponders: [],
    closeHeldSummary: () => {
      for (const socket of state.heldSummarySockets.splice(0)) socket.destroy()
    },
    releaseHeldSummary: () => {
      for (const respond of state.heldSummaryResponders.splice(0)) respond()
      state.heldSummarySockets.length = 0
    },
    summaryRequested: new Promise((resolve) => { markSummaryRequested = resolve })
  }
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
      const userMessage = Array.isArray(body?.messages)
        ? body.messages.find((message) => message?.role === 'user')?.content
        : null
      const isSummaryRequest = isRouteRequest && typeof userMessage === 'string' && userMessage.includes('生成会话总结')
      const summaryModelRequest = Array.isArray(body?.tools) && body.tools.length === 1 && typeof userMessage === 'string' && userMessage.includes('请基于这场已结束的会话生成会话总结')
      state.requestShapes.push({
        toolCount: Array.isArray(body?.tools) ? body.tools.length : null,
        messageCount: Array.isArray(body?.messages) ? body.messages.length : null,
        summaryModelRequest,
        authorizationPresent: typeof request.headers.authorization === 'string' && request.headers.authorization.length > 0,
        authorizationExact: request.headers.authorization === 'Bearer j25-local-provider-secret'
      })
      const holdSummaryResponse = summaryModelRequest && state.holdNextSummary
      if (summaryModelRequest) {
        markSummaryRequested()
        if (holdSummaryResponse) state.holdNextSummary = false
      }
      const content = isRouteRequest
        ? JSON.stringify({ recipeId: isSummaryRequest ? 'summary.minutes' : 'qa.answer', confidence: 0.9 })
        : summaryModelRequest
          ? JSON.stringify({ schemaVersion: 1, overview: '受控恢复旅程结果。', conclusions: [], todos: [], risks: [] })
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
      const respond = () => {
        if (response.destroyed || response.writableEnded) return
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) })
        response.end(encoded)
      }
      if (holdSummaryResponse) {
        state.heldSummarySockets.push(request.socket)
        state.heldSummaryResponders.push(respond)
        return
      }
      respond()
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
    let failedInputRetained = false
    let failedConfigUnchanged = false
    let uncredentialedFailureObserved = false
    let failedRevisionUnchanged = false
    let failedChangedNotBroadcast = false
    const modelChangedRevisions = []
    const unsubscribeModelChanged = window.shell.onAgentModelChanged((event) => {
      modelChangedRevisions.push(event.revision)
    })
    clickText(cardFor(), '编辑连接')
    const uncredentialedAddress = await waitFor(() => cardFor()?.querySelector('input[aria-label="API 服务器地址"]'), 'uncredentialed connection editor')
    const beforeUncredentialedCatalog = await window.shell.getAgentModelCatalog({ contractId: 'agent-model-ui', contractVersion: '1.0.0' })
    const beforeUncredentialedRevision = beforeUncredentialedCatalog.snapshot?.revision
    const changedCountBeforeFailure = modelChangedRevisions.length
    setInput(uncredentialedAddress, 'http://invalid.example')
    await sleep(0)
    clickText(cardFor(), '保存修改')
    await waitFor(() => document.querySelector('section[data-pane="agentModel"] [role="alert"]') && !uncredentialedAddress.disabled, 'uncredentialed connection restored')
    failedInputRetained = uncredentialedAddress.value === 'http://invalid.example'
    const uncredentialedCatalog = await window.shell.getAgentModelCatalog({ contractId: 'agent-model-ui', contractVersion: '1.0.0' })
    const uncredentialedProfile = uncredentialedCatalog.snapshot?.profiles?.find(p => p.profileId === 'deepseek')
    uncredentialedFailureObserved = uncredentialedCatalog.ok === true &&
      uncredentialedProfile?.credential?.present === false &&
      uncredentialedProfile?.httpsOrigin === 'https://api.deepseek.com'
    failedRevisionUnchanged = uncredentialedFailureObserved &&
      uncredentialedCatalog.snapshot.revision === beforeUncredentialedRevision
    failedChangedNotBroadcast = modelChangedRevisions.length === changedCountBeforeFailure
    failedConfigUnchanged = uncredentialedFailureObserved && failedRevisionUnchanged && failedChangedNotBroadcast
    clickText(uncredentialedAddress.closest('.group'), '取消')
    await waitFor(() => !cardFor()?.querySelector('input[aria-label="API 服务器地址"]'), 'uncredentialed editor closed')
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
    unsubscribeModelChanged()

    return {
      inputsStyled: { textStyled, numberStyled, passwordStyled, selectStyled, textareaStyled },
      inputFailureRecovered: failedInputRetained && failedConfigUnchanged,
      uncredentialedFailureObserved,
      failedRevisionUnchanged,
      failedChangedNotBroadcast,
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

async function runAgentBar (toolbar, providerState) {
  await toolbar.webContents.executeJavaScript("window.shell.openAgent(); true")
  let agent = await waitFor(() => windowFor('/agent/index.html'), 'Agent Bar window')
  await waitFor(async () => agent.webContents.executeJavaScript("document.readyState === 'complete'"), 'Agent Bar renderer')
  await waitFor(async () => agent.webContents.executeJavaScript("Boolean(document.querySelector('.scope-card'))"), 'terminal scope')
  await agent.webContents.executeJavaScript(`(async () => {
    const headers = { contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0' }
    const scopes = await window.agentApi.getScopes({ ...headers, limit: 50, cursor: null })
    const scopeIndex = scopes?.ok === true ? scopes.scopes.findIndex((item) => item.scope.reference === 'session.j25.formal') : -1
    const card = scopeIndex >= 0 ? document.querySelectorAll('.scope-card')[scopeIndex] : null
    if (!card) throw new Error('formal session missing from renderer scope list')
    card.click()
    return true
  })()`)
  await waitFor(async () => agent.webContents.executeJavaScript("document.querySelector('.eligibility')?.textContent === '配置已就绪，提交后检查输入容量'"), 'provider eligibility')
  const readsBeforeManualRefresh = eligibilityProbe.count
  const eligibilityHold = deferred()
  eligibilityProbe.nextHold = eligibilityHold
  await agent.webContents.executeJavaScript("document.querySelector('.scope-panel .panel-heading button').click(); true")
  await waitFor(() => eligibilityProbe.count > readsBeforeManualRefresh, 'manual eligibility refresh')
  const submitDisabledDuringEligibilityRefresh = await agent.webContents.executeJavaScript("document.querySelector('[data-action=\"qa\"]')?.disabled === true && document.querySelector('[data-action=\"minutes\"]')?.disabled === true")
  eligibilityHold.resolve()
  await waitFor(async () => agent.webContents.executeJavaScript("document.querySelector('.eligibility')?.textContent === '配置已就绪，提交后检查输入容量'"), 'refreshed provider eligibility')
  const providerShapeCountAtSubmit = providerState.requestShapes.length
  const providerModelCountAtSubmit = providerState.modelIds.length
  const qaSubmitCount = submitReceipts.length
  await agent.webContents.executeJavaScript(`(() => {
    const setInput = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const prompt = document.querySelector('#agentPrompt')
    setInput(prompt, '请回答这场会的重点')
    document.querySelector('[data-action="qa"]').click()
    return true
  })()`)
  const qaReceipt = await waitFor(() => submitReceipts.slice(qaSubmitCount).find((receipt) => receipt.recipeId === 'qa.answer'), 'QA session-summary acceptance')
  const result = await agent.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const headers = { contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0' }
    const summaryHeaders = { contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0' }
    const requestId = ${JSON.stringify(qaReceipt.requestId)}
    let requestSnapshot = null
    for (let i = 0; i < 240; i += 1) {
      const request = await window.agentApi.getSessionSummaryRun({ ...summaryHeaders, request_id: requestId })
      requestSnapshot = request?.ok === true ? request.result.snapshot : null
      if (requestSnapshot?.interaction_id) break
      await sleep(50)
    }
    const interactionId = requestSnapshot?.interaction_id || null
    if (!interactionId) {
      return {
        succeeded: false,
        terminalState: requestSnapshot?.state || 'unavailable',
        terminalErrorCode: requestSnapshot?.error_code || 'unavailable',
        historyVisible: false, historyItems: [], modelVisible: false,
        routingMode: requestSnapshot?.routing_mode || null, interactionId: null,
        resultDigest: null, requestState: requestSnapshot?.state || 'unavailable'
      }
    }
    let detail = null
    let history = null
    for (let i = 0; i < 240; i += 1) {
      history = await window.agentApi.getHistory({ ...headers, limit: 50, cursor: null })
      detail = await window.agentApi.getInteraction({ ...headers, interaction_id: interactionId })
      if (detail.ok === true && ['succeeded', 'failed', 'cancelled'].includes(detail.result.state)) break
      await sleep(50)
    }
    return {
      succeeded: detail?.ok === true && detail.result.state === 'succeeded',
      terminalState: detail?.ok === true ? detail.result.state : 'unavailable',
      terminalErrorCode: detail?.ok === true ? detail.result.error_code : detail?.error?.code || 'unavailable',
      historyVisible: history?.ok === true && history.result.items.some((item) => item.interaction_id === interactionId),
      historyItems: history?.ok === true ? history.result.items.map((item) => ({ interactionId: item.interaction_id, recipeId: item.recipe_id, state: item.terminal_reason, errorCode: item.error_code })) : [],
      modelVisible: detail?.result?.model?.model_id === 'j25-local-model',
      routingMode: detail?.result?.routing_mode || null,
      interactionId,
      resultDigest: detail?.result?.result_digest || null,
      requestState: requestSnapshot?.state || 'unavailable'
    }
  })()`)
  const runProviderShapes = providerState.requestShapes.slice(providerShapeCountAtSubmit)
  const runProviderModelIds = providerState.modelIds.slice(providerModelCountAtSubmit)
  const runProviderCredentialObserved = runProviderShapes.some((shape) => shape.authorizationPresent)
  const runProviderCredentialExact = runProviderShapes.some((shape) => shape.authorizationExact)
  if (!result.succeeded) throw new Error(`production Agent Bar request ended ${result.terminalState}/${result.terminalErrorCode} at ${result.requestState} ${JSON.stringify({ historyItems: result.historyItems, providerRequestCount: runProviderShapes.length, requestShapes: runProviderShapes })}`)
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
    const exactDetail = await window.agentApi.getInteraction({ ...headers, interaction_id: interactionId })
    const historySnapshot = await window.agentApi.getHistory({ ...headers, limit: 50, cursor: null })
    const historyIndex = historySnapshot?.ok === true ? historySnapshot.result.items.findIndex((item) => item.interaction_id === interactionId) : -1
    const expectedHistoryCard = historyIndex >= 0 ? document.querySelectorAll('.history-card')[historyIndex] : null
    if (!expectedHistoryCard) throw new Error('expected interaction missing from rendered history ' + JSON.stringify({
      historyCount: document.querySelectorAll('.history-card').length,
      historyIds: historySnapshot?.ok === true ? historySnapshot.result.items.map((item) => item.interaction_id) : [],
      requestedInteractionId: interactionId
    }))
    expectedHistoryCard.click()
    let feedbackState = null
    const editor = await waitFor(() => {
      feedbackState = {
        historyCount: document.querySelectorAll('.history-card').length,
        runState: document.querySelector('.run-card strong')?.textContent || null,
        detailState: document.querySelector('.result-card header strong')?.textContent || null,
        detailError: document.querySelector('.result-card [role="alert"]')?.textContent || null,
        detailVisible: Boolean(document.querySelector('.result-card')),
        feedbackVisible: Boolean(document.querySelector('.signal-actions')),
        selectedHistory: document.querySelector('.history-card[aria-current="true"]') !== null,
        apiState: exactDetail?.ok === true ? exactDetail.result.state : 'unavailable',
        apiErrorCode: exactDetail?.ok === true ? exactDetail.result.error_code : exactDetail?.error?.code || 'unavailable',
        apiDigestMatches: exactDetail?.ok === true && exactDetail.result.result_digest === resultDigest,
        historyContainsExpected: historySnapshot?.ok === true && historySnapshot.result.items.some((item) => item.interaction_id === interactionId)
      }
      return document.querySelector('#agentEdit')
    }, 'edit feedback form').catch(() => { throw new Error('feedback state mismatch ' + JSON.stringify(feedbackState)) })
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
  const summarySubmitCount = submitReceipts.length
  const summaryShapeCount = providerState.requestShapes.length
  providerState.holdNextSummary = true
  await agent.webContents.executeJavaScript(`(async () => {
    const headers = { contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0' }
    const result = await window.agentApi.getScopes({ ...headers, limit: 50, cursor: null })
    const index = result?.ok === true ? result.scopes.findIndex((item) => item.scope.reference === 'session.j25.formal') : -1
    const card = index >= 0 ? document.querySelectorAll('.scope-card')[index] : null
    if (!card) throw new Error('J30 formal summary scope missing')
    card.click()
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const button = document.querySelector('[data-action="minutes"]')
      if (card.getAttribute('aria-current') === 'true' && button && !button.disabled) {
        button.click()
        return true
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error('J30 summary control did not become available')
  })()`)
  const summaryReceipt = await waitFor(
    () => submitReceipts.slice(summarySubmitCount).find((receipt) => receipt.recipeId === 'summary.minutes'),
    `formal J30 summary acceptance ${JSON.stringify(runControlProbe.summaryAcceptResults.slice(-2))}`
  )
  await waitFor(() => providerState.requestShapes.slice(summaryShapeCount).some((shape) => shape.summaryModelRequest), 'summary provider request is pending')
  await waitFor(async () => agent.webContents.executeJavaScript("document.querySelector('.run-card button')?.textContent === '取消生成'"), 'formal summary cancel action')
  await agent.webContents.executeJavaScript("document.querySelector('.run-card button').click(); true")
  await waitFor(() => runControlProbe.cancelState === 'cancelled', 'formal summary cancellation receipt')
  const cancelledSummary = await agent.webContents.executeJavaScript(`(async () => {
    const headers = { contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0' }
    const response = await window.agentApi.getSessionSummaryRun({ ...headers, request_id: ${JSON.stringify(summaryReceipt.requestId)} })
    const snapshot = response?.ok === true ? response.result.snapshot : null
    return snapshot?.state === 'cancelled' && snapshot?.resume_required === false
  })()`)
  await agent.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.diagnostics-panel')
    if (!panel) throw new Error('formal summary diagnostics panel missing')
    panel.querySelector('summary').click()
    const actions = [...panel.querySelectorAll('button')]
    const read = actions.find((button) => button.textContent === '查看诊断')
    if (!read) throw new Error('diagnostic query action missing')
    read.click()
    return true
  })()`)
  const diagnosticsVisible = await waitFor(async () => agent.webContents.executeJavaScript(
    "document.querySelector('.diagnostics-panel [aria-label=\"诊断记录\"] [role=\"status\"]')?.textContent.includes('已读取')"
  ), 'formal summary diagnostics query')
  await agent.webContents.executeJavaScript(`(() => {
    const panel = document.querySelector('.diagnostics-panel')
    const button = [...panel.querySelectorAll('button')].find((item) => item.textContent === '导出诊断')
    if (!button) throw new Error('diagnostic export action missing')
    button.click()
    return true
  })()`)
  await waitFor(() => runControlProbe.diagnosticsExportStatus === 'saved', 'formal summary diagnostics export')
  const diagnosticFile = path.join(process.env.J25_FORMAL_USER_DATA, 'p1-summary-diagnostics.json')
  const diagnosticBytes = fs.readFileSync(diagnosticFile)
  const diagnosticText = diagnosticBytes.toString('utf8')
  const diagnosticJson = JSON.parse(diagnosticText)
  const diagnosticsPrivacyClean = !diagnosticText.includes('J30-ELECTRON-PRIVACY-TRANSCRIPT-MARKER') &&
    !diagnosticText.includes('j25-local-provider-secret') && !/[A-Z]:[\\/]/.test(diagnosticText)
  const diagnosticsExportSha256 = crypto.createHash('sha256').update(diagnosticBytes).digest('hex')
  const summaryCancelledWithinDeadline = cancelledSummary && runControlProbe.cancelState === 'cancelled' &&
    Number.isFinite(runControlProbe.cancelElapsedMs) && runControlProbe.cancelElapsedMs <= 5000
  const summaryWindowCloseSubmitCount = submitReceipts.length
  const summaryProviderShapeCountBeforeWindowClose = providerState.requestShapes.length
  providerState.holdNextSummary = true
  await agent.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const headers = { contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0' }
    const scopes = await window.agentApi.getScopes({ ...headers, limit: 50, cursor: null })
    const index = scopes?.ok === true ? scopes.scopes.findIndex((item) => item.scope.reference === 'session.j25.formal') : -1
    const card = index >= 0 ? document.querySelectorAll('.scope-card')[index] : null
    if (!card) throw new Error('window-close summary scope missing')
    card.click()
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const button = document.querySelector('[data-action="minutes"]')
      if (card.getAttribute('aria-current') === 'true' && button && !button.disabled) {
        button.click()
        return true
      }
      await sleep(50)
    }
    throw new Error('window-close summary control did not become available')
  })()`)
  const windowCloseReceipt = await waitFor(
    () => submitReceipts.slice(summaryWindowCloseSubmitCount).find((receipt) => receipt.recipeId === 'summary.minutes'),
    'Agent window-close summary receipt'
  )
  await waitFor(() => providerState.requestShapes.slice(summaryProviderShapeCountBeforeWindowClose).some((shape) => shape.summaryModelRequest),
    'Agent window-close summary provider request')
  const activeSummaryBeforeWindowClose = await agent.webContents.executeJavaScript(`(async () => {
    const response = await window.agentApi.getSessionSummaryRun({
      contract_id: 'speech-agent.session-summary-run.ui',
      contract_version: '1.0.0',
      request_id: ${JSON.stringify(windowCloseReceipt.requestId)}
    })
    return response?.ok === true ? response.result.snapshot : null
  })()`)
  const heldSummaryNoFalseProgress = activeSummaryBeforeWindowClose?.request_id === windowCloseReceipt.requestId &&
    !['succeeded', 'failed', 'cancelled'].includes(activeSummaryBeforeWindowClose.state) &&
    activeSummaryBeforeWindowClose.validated_chunk_count === null &&
    activeSummaryBeforeWindowClose.total_chunk_count === null &&
    Number.isSafeInteger(activeSummaryBeforeWindowClose.elapsed_ms)
  const cancellationCommandsBeforeWindowClose = runControlProbe.summaryCancelCommandCount
  agent.close()
  await waitFor(() => agent.isDestroyed(), 'Agent window close')
  await wait(200)
  const windowCloseDidNotSendCancellation = runControlProbe.summaryCancelCommandCount === cancellationCommandsBeforeWindowClose
  await toolbar.webContents.executeJavaScript('window.shell.openAgent(); true')
  agent = await waitFor(() => windowFor('/agent/index.html'), 'reopened Agent Bar window')
  await waitFor(async () => agent.webContents.executeJavaScript("document.readyState === 'complete'"), 'reopened Agent Bar renderer')
  const windowCloseSnapshot = await agent.webContents.executeJavaScript(`(async () => {
    const response = await window.agentApi.getSessionSummaryRun({
      contract_id: 'speech-agent.session-summary-run.ui',
      contract_version: '1.0.0',
      request_id: ${JSON.stringify(windowCloseReceipt.requestId)}
    })
    return response?.ok === true ? response.result.snapshot : null
  })()`)
  const windowCloseRequestStayedActive = windowCloseSnapshot?.request_id === windowCloseReceipt.requestId &&
    !['succeeded', 'failed', 'cancelled'].includes(windowCloseSnapshot.state)
  providerState.releaseHeldSummary()
  const windowCloseTerminalSnapshot = await waitFor(async () => agent.webContents.executeJavaScript(`(async () => {
    const response = await window.agentApi.getSessionSummaryRun({
      contract_id: 'speech-agent.session-summary-run.ui',
      contract_version: '1.0.0',
      request_id: ${JSON.stringify(windowCloseReceipt.requestId)}
    })
    const snapshot = response?.ok === true ? response.result.snapshot : null
    return snapshot?.state === 'succeeded' && snapshot.request_id === ${JSON.stringify(windowCloseReceipt.requestId)}
      ? { state: snapshot.state, attempt: snapshot.attempt } : null
  })()`), 'summary settlement after Agent window close')
  const providerShapeCountBeforeCapacity = providerState.requestShapes.length
  const droppedChangesBeforeCapacity = runControlProbe.droppedChangedCount
  const capacitySubmitCount = submitReceipts.length
  await agent.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const waitFor = async (probe, label) => {
      for (let i = 0; i < 240; i += 1) {
        const value = probe()
        if (value) return value
        await sleep(50)
      }
      throw new Error(label + ' timed out')
    }
    const headers = { contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0' }
    const scopeSnapshot = await window.agentApi.getScopes({ ...headers, limit: 50, cursor: null })
    const capacityIndex = scopeSnapshot?.ok === true ? scopeSnapshot.scopes.findIndex((item) => item.scope.reference === 'session.j25.synthetic-capacity') : -1
    const capacityCard = capacityIndex >= 0 ? document.querySelectorAll('.scope-card')[capacityIndex] : null
    if (!capacityCard) throw new Error('synthetic capacity session missing from renderer scope list')
    capacityCard.click()
    await waitFor(() => capacityCard.getAttribute('aria-current') === 'true', 'synthetic capacity scope selection')
    await waitFor(() => document.querySelector('.eligibility')?.textContent === '配置已就绪，提交后检查输入容量', 'synthetic capacity eligibility')
    document.querySelector('[data-action="minutes"]').click()
    return true
  })()`)
  const capacityReceipt = await waitFor(() => submitReceipts.slice(capacitySubmitCount).find((receipt) => receipt.recipeId === 'summary.minutes'), 'over-limit summary submit receipt')
  const capacityFeedback = await agent.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const waitFor = async (probe, label) => {
      for (let i = 0; i < 240; i += 1) {
        const value = probe()
        if (value) return value
        await sleep(50)
      }
      throw new Error(label + ' timed out')
    }
    const headers = { contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0' }
    const summaryHeaders = { contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0' }
    const requestId = ${JSON.stringify(capacityReceipt.requestId)}
    let requestSnapshot = null
    for (let i = 0; i < 240; i += 1) {
      const request = await window.agentApi.getSessionSummaryRun({ ...summaryHeaders, request_id: requestId })
      requestSnapshot = request?.ok === true ? request.result.snapshot : null
      if (requestSnapshot?.interaction_id) break
      await sleep(50)
    }
    const interactionId = requestSnapshot?.interaction_id || null
    if (!interactionId) {
      return {
        failed: false, dedicatedError: false, exactFeedback: false, recoveryFeedback: false,
        summaryToolCalls: -1, requestState: requestSnapshot?.state || 'unavailable'
      }
    }
    let detail = null
    for (let i = 0; i < 240; i += 1) {
      detail = await window.agentApi.getInteraction({ ...headers, interaction_id: interactionId })
      if (detail?.ok === true && ['succeeded', 'failed', 'cancelled'].includes(detail.result.state)) break
      await sleep(50)
    }
    await waitFor(() => {
      const message = document.querySelector('.result-card [role="alert"]')?.textContent || ''
      return message.includes('会话总结输入超过当前上限；总结模型尚未调用。')
    }, 'capacity failure feedback in Agent Bar')
    const alertText = document.querySelector('.result-card [role="alert"]')?.textContent || ''
    const recoveryText = document.querySelector('.result-card .empty')?.textContent || ''
    return {
      failed: detail?.ok === true && detail.result.state === 'failed',
      dedicatedError: detail?.ok === true && detail.result.error_code === 'AGENT_SUMMARY_INPUT_LIMIT_EXCEEDED',
      exactFeedback: alertText.includes('会话总结输入超过当前上限；总结模型尚未调用。'),
      recoveryFeedback: recoveryText.includes('可缩短输入，或选择内容较少的会话后重试。'),
      summaryToolCalls: detail?.ok === true ? detail.result.tool_calls.length : -1,
      requestState: requestSnapshot?.state || 'unavailable'
    }
  })()`)
  runControlProbe.capacityRequestNotificationLossObserved =
    runControlProbe.dropChangedRequestId === capacityReceipt.requestId &&
    runControlProbe.droppedChangedCount > droppedChangesBeforeCapacity
  runControlProbe.dropChangedRequestId = null
  const capacityProviderShapes = providerState.requestShapes.slice(providerShapeCountBeforeCapacity)
  return {
    ...result,
    ...feedback,
    ...ui,
    summaryCancelledWithinDeadline,
    summaryWindowCloseDidNotCancel: windowCloseDidNotSendCancellation && windowCloseRequestStayedActive,
    summaryWindowCloseRequestSucceeded: windowCloseTerminalSnapshot.state === 'succeeded',
    summaryHeldNoFalseProgress: heldSummaryNoFalseProgress,
    summaryTerminalNotificationDropped: runControlProbe.capacityRequestNotificationLossObserved,
    summaryDiagnosticsVisible: diagnosticsVisible && diagnosticJson.records?.length > 0,
    summaryDiagnosticsExported: runControlProbe.diagnosticsExportStatus === 'saved' && diagnosticBytes.length > 0,
    summaryDiagnosticsPrivacyClean: diagnosticsPrivacyClean,
    summaryDiagnosticsRecordCount: Array.isArray(diagnosticJson.records) ? diagnosticJson.records.length : 0,
    summaryDiagnosticsExportBytes: diagnosticBytes.length,
    summaryDiagnosticsExportSha256: diagnosticsExportSha256,
    summaryCapacityFailed: capacityFeedback.failed && capacityFeedback.dedicatedError,
    summaryCapacityErrorVisible: capacityFeedback.exactFeedback,
    summaryCapacityRecoveryVisible: capacityFeedback.recoveryFeedback,
    summaryCapacityToolCalls: capacityFeedback.summaryToolCalls,
    summaryCapacityNoSummaryModelRequest: capacityProviderShapes.every((shape) => shape.summaryModelRequest !== true),
    providerRequestCount: runProviderShapes.length,
    providerRequestShapes: runProviderShapes.map((shape) => ({ toolCount: shape.toolCount, messageCount: shape.messageCount })),
    providerCredentialObserved: runProviderCredentialObserved,
    providerCredentialExact: runProviderCredentialExact,
    providerModelIds: runProviderModelIds,
    manualEligibilityRefresh: eligibilityProbe.count > readsBeforeManualRefresh,
    submitDisabledDuringEligibilityRefresh,
    eligibilityReadCount: eligibilityProbe.count
  }
}

async function prepareRestartRecovery (toolbar, providerState) {
  await toolbar.webContents.executeJavaScript('window.shell.openAgent(); true')
  const agent = await waitFor(() => windowFor('/agent/index.html'), 'restart preparation Agent Bar window')
  await waitFor(async () => agent.webContents.executeJavaScript("document.readyState === 'complete'"), 'restart preparation Agent Bar renderer')
  await waitFor(async () => agent.webContents.executeJavaScript("Boolean(document.querySelector('.scope-card'))"), 'restart preparation session scope')
  await agent.webContents.executeJavaScript(`(async () => {
    const headers = { contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0' }
    const scopes = await window.agentApi.getScopes({ ...headers, limit: 50, cursor: null })
    const index = scopes?.ok === true ? scopes.scopes.findIndex((item) => item.scope.reference === 'session.j25.formal') : -1
    const card = index >= 0 ? document.querySelectorAll('.scope-card')[index] : null
    if (!card) throw new Error('restart preparation session is unavailable')
    card.click()
    return true
  })()`)
  await waitFor(async () => agent.webContents.executeJavaScript("document.querySelector('.eligibility')?.textContent === '配置已就绪，提交后检查输入容量'"), 'restart preparation eligibility')
  providerState.holdNextSummary = true
  const acceptedBefore = submitReceipts.length
  await agent.webContents.executeJavaScript("document.querySelector('[data-action=\"minutes\"]')?.click(); true")
  const receipt = await waitFor(
    () => submitReceipts.slice(acceptedBefore).find((item) => item.recipeId === 'summary.minutes'),
    'restart preparation summary receipt'
  )
  await waitFor(() => providerState.requestShapes.some((shape) => shape.summaryModelRequest), 'restart preparation provider request')
  const snapshot = await agent.webContents.executeJavaScript(`(async () => {
    const response = await window.agentApi.getSessionSummaryRun({
      contract_id: 'speech-agent.session-summary-run.ui',
      contract_version: '1.0.0',
      request_id: ${JSON.stringify(receipt.requestId)}
    })
    return response?.ok === true ? response.result.snapshot : null
  })()`)
  const requestStayedActive = snapshot?.request_id === receipt.requestId &&
    !['succeeded', 'failed', 'cancelled'].includes(snapshot.state) && typeof snapshot.target_run_id === 'string'
  if (!requestStayedActive) throw new Error('restart preparation request was not durably active')
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, phase: 'restart-pending', result: true, requestStayedActive, attempt: snapshot.attempt })}\n`)
  providerState.closeHeldSummary()
}

async function configureRecoveryModel (settings, port) {
  await waitFor(async () => settings.webContents.executeJavaScript("document.readyState === 'complete'"), 'recovery settings renderer')
  const configured = await settings.webContents.executeJavaScript(`(async () => {
    const waitFor = async (probe, label) => {
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        const value = probe()
        if (value) return value
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      throw new Error(label + ' timed out')
    }
    const onboarding = await waitFor(() => document.querySelector('#onboarding'), 'recovery onboarding')
    if (!onboarding.hidden) document.querySelector('[data-preset="meeting"]').click()
    await waitFor(() => document.querySelector('#onboarding')?.hidden === true, 'recovery onboarding dismissal')
    const modelNavigation = await waitFor(() => document.querySelector('[data-pane="agentModel"]'), 'recovery model navigation')
    modelNavigation.click()
    const toggle = await waitFor(() => document.querySelector('input[aria-label="启用 Agent 系统"]'), 'recovery Agent setting')
    if (!toggle.checked) toggle.click()
    await waitFor(() => document.querySelector('input[aria-label="启用 Agent 系统"]')?.checked === true, 'recovery Agent enabled')

    const headers = { contractId: 'agent-model-ui', contractVersion: '1.0.0' }
    const initial = await window.shell.getAgentModelCatalog(headers)
    if (initial?.ok !== true || !Number.isSafeInteger(initial.snapshot?.revision)) throw new Error('recovery model catalog unavailable')
    let expectedRevision = initial.snapshot.revision
    const configure = async (command) => {
      const response = await window.shell.configureAgentModel({
        ...headers, command: { ...command, expectedRevision }
      })
      if (response?.ok !== true || !Number.isSafeInteger(response.revision)) {
        throw new Error('recovery model configuration rejected: ' + (response?.error?.code || 'unavailable'))
      }
      expectedRevision = response.revision
    }
    await configure({
      type: 'updateProfile', profileId: 'deepseek', label: 'DeepSeek',
      httpsOrigin: 'https://127.0.0.1:${port}', basePath: '/v1'
    })
    await configure({
      type: 'addModel', profileId: 'deepseek', modelId: 'j25-local-model',
      capabilities: {
        maxInputTokens: 64000, maxOutputTokens: 4096,
        supportsToolCalling: true, supportsStructuredOutput: true,
        supportsStreaming: true, usageReporting: true
      }
    })
    await configure({ type: 'setCredential', profileId: 'deepseek', credential: 'j25-local-provider-secret' })
    await configure({ type: 'assignPurpose', purpose: 'default', target: { profileId: 'deepseek', modelId: 'j25-local-model' } })
    const latest = await window.shell.getAgentModelCatalog(headers)
    return latest?.ok === true && latest.snapshot.readinessByPurpose.default.singleShot === 'ready' &&
      latest.snapshot.readinessByPurpose.default.agentLoop === 'ready'
  })()`)
  if (configured !== true) throw new Error('recovery model is not ready')
}

async function continueRestartRecovery (toolbar, providerState) {
  await toolbar.webContents.executeJavaScript('window.shell.openAgent(); true')
  const agent = await waitFor(() => windowFor('/agent/index.html'), 'recovery Agent Bar window')
  await waitFor(async () => agent.webContents.executeJavaScript("document.readyState === 'complete'"), 'recovery Agent Bar renderer')
  await waitFor(async () => agent.webContents.executeJavaScript("Boolean(document.querySelector('.recoverable-runs li'))"), 'recoverable summary request')
  const recovered = await agent.webContents.executeJavaScript(`(async () => {
    const response = await window.agentApi.listRecoverableSessionSummaryRuns({
      contract_id: 'speech-agent.session-summary-run.ui', contract_version: '1.0.0'
    })
    if (response?.ok !== true || !Array.isArray(response.result?.requests)) return null
    const item = response.result.requests.find((entry) => entry?.snapshot?.action === 'summary')
    if (!item) return null
    return {
      requestId: item.snapshot.request_id,
      generation: item.snapshot.generation,
      revision: item.snapshot.revision,
      targetRunId: item.snapshot.target_run_id,
      state: item.snapshot.state,
      resumeRequired: item.snapshot.resume_required
    }
  })()`)
  if (!recovered || recovered.state !== 'retry_wait' || recovered.resumeRequired !== true ||
      typeof recovered.targetRunId !== 'string') throw new Error('restarted summary was not held for explicit continuation')
  const providerRequestsBeforeContinue = providerState.requestShapes.filter((shape) => shape.summaryModelRequest).length
  const explicitActionVisible = await agent.webContents.executeJavaScript(`(() => {
    const item = [...document.querySelectorAll('.recoverable-runs li')]
      .find((node) => node.textContent.includes('会话总结已暂停'))
    return Boolean(item && [...item.querySelectorAll('button')].some((button) => button.textContent === '继续生成'))
  })()`)
  if (!explicitActionVisible) throw new Error('recovery UI did not expose explicit continuation')
  await agent.webContents.executeJavaScript(`(() => {
    const item = [...document.querySelectorAll('.recoverable-runs li')]
      .find((node) => node.textContent.includes('会话总结已暂停'))
    const button = item && [...item.querySelectorAll('button')].find((entry) => entry.textContent === '继续生成')
    if (!button) throw new Error('explicit continuation action missing')
    button.click()
    return true
  })()`)
  await waitFor(() => providerState.requestShapes.filter((shape) => shape.summaryModelRequest).length > providerRequestsBeforeContinue,
    'provider request after explicit continuation')
  const resumed = await waitFor(async () => agent.webContents.executeJavaScript(`(async () => {
    const response = await window.agentApi.getSessionSummaryRun({
      contract_id: 'speech-agent.session-summary-run.ui',
      contract_version: '1.0.0',
      request_id: ${JSON.stringify(recovered.requestId)}
    })
    const snapshot = response?.ok === true ? response.result.snapshot : null
    return snapshot && ['succeeded', 'failed', 'cancelled'].includes(snapshot.state)
      ? { state: snapshot.state, requestId: snapshot.request_id, targetRunId: snapshot.target_run_id,
          attempt: snapshot.attempt, generation: snapshot.generation }
      : null
  })()`), 'restarted summary terminal state', 45000)
  const result = {
    result: resumed.state === 'succeeded' && resumed.requestId === recovered.requestId &&
      resumed.targetRunId === recovered.targetRunId && resumed.attempt > 1,
    requestStayedRecoverableUntilUserAction: recovered.state === 'retry_wait' && recovered.resumeRequired,
    explicitContinuationVisible: explicitActionVisible,
    noProviderRequestBeforeContinue: providerRequestsBeforeContinue === 0,
    sameRequestAndRunResumed: resumed.requestId === recovered.requestId && resumed.targetRunId === recovered.targetRunId,
    attemptAfterRestart: resumed.attempt,
    terminalState: resumed.state,
    providerRequestCountAfterContinue: providerState.requestShapes.filter((shape) => shape.summaryModelRequest).length
  }
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, phase: 'restart-resume', ...result })}\n`)
  return result
}

async function main () {
  const rawUserDataDir = process.env.J25_FORMAL_USER_DATA
  if (typeof rawUserDataDir !== 'string' || rawUserDataDir.length === 0) throw new Error('J25_FORMAL_USER_DATA is required')
  const userDataDir = path.resolve(rawUserDataDir)
  if (userDataDir === path.parse(userDataDir).root || userDataDir === PROJECT_ROOT) throw new Error('J25_FORMAL_USER_DATA must be isolated')
  fs.mkdirSync(userDataDir, { recursive: true })
  app.setPath('userData', userDataDir)
  const phase = process.env.J25_FORMAL_PHASE || 'full'
  dialog.showSaveDialog = async () => ({
    canceled: false,
    filePath: path.join(userDataDir, 'p1-summary-diagnostics.json')
  })
  const channels = require(path.join(PROJECT_ROOT, 'src', 'main', 'ipc', 'channels'))
  app.on('browser-window-created', (_event, win) => {
    const send = win.webContents.send.bind(win.webContents)
    win.webContents.send = (channel, ...args) => {
      if (channel === channels.SESSION_SUMMARY_RUN_CHANGED &&
          args[0]?.request_id === runControlProbe.dropChangedRequestId) {
        runControlProbe.droppedChangedCount += 1
        return true
      }
      return send(channel, ...args)
    }
  })
  if (phase !== 'restart-resume') await seedTerminalSession(userDataDir)

  const provider = providerServer()
  const providerPortFile = path.join(userDataDir, 'j30-provider-port.txt')
  const requestedProviderPort = phase === 'restart-resume'
    ? Number(fs.readFileSync(providerPortFile, 'utf8'))
    : 0
  if (!Number.isInteger(requestedProviderPort) || requestedProviderPort < 0 || requestedProviderPort > 65535) {
    throw new Error('formal provider port control is invalid')
  }
  await new Promise((resolve, reject) => {
    provider.server.once('error', reject)
    provider.server.listen(requestedProviderPort, '127.0.0.1', resolve)
  })
  const port = provider.server.address().port
  if (phase !== 'restart-resume') fs.writeFileSync(providerPortFile, String(port), { mode: 0o600 })
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
    const settings = phase === 'restart-resume'
      ? null
      : await waitFor(() => windowFor('/settings/settings.html'), 'settings window')
    const toolbar = await waitFor(() => windowFor('/toolbar/index.html'), 'toolbar window')
    await waitFor(async () => toolbar.webContents.executeJavaScript("document.readyState === 'complete'"), 'toolbar renderer')
    if (phase === 'restart-resume') {
      const recovery = await continueRestartRecovery(toolbar, provider.state)
      if (!recovery.result) throw new Error(`formal restart recovery failed: ${JSON.stringify(recovery)}`)
      return
    }
    if (phase === 'restart-prepare') {
      await configureRecoveryModel(settings, port)
      await prepareRestartRecovery(toolbar, provider.state)
      return
    }
    const settingsResult = await configureThroughSettings(settings, port)
    const nativePicker = await inspectNativePicker(settings)
    const inputAppearance = await inspectInputAppearance(settings)
    const runResult = await runAgentBar(toolbar, provider.state)
    const report = {
      schemaVersion: 1,
      result: Object.values(inputAppearance).every(Boolean) && Object.values(settingsResult.inputsStyled).every(Boolean) && settingsResult.inputFailureRecovered &&
        settingsResult.uncredentialedFailureObserved &&
        settingsResult.failedRevisionUnchanged && settingsResult.failedChangedNotBroadcast &&
        nativePicker.opened && nativePicker.cancelValuePreserved && nativePicker.noChangeAfterCancel &&
        inputProbe.pending && inputProbe.rejected && inputProbe.failureCode === 'MODEL_CONFIG_INVALID' && inputProbe.invalidCommands === 1 &&
        settingsResult.profileConnection && settingsResult.modelVisible && settingsResult.credentialCleared &&
        settingsResult.defaultReady && settingsResult.agentEnabled && settingsResult.memoryManaged &&
        settingsResult.processingSuspended && settingsResult.processingReenabled && settingsResult.revisionConflict &&
        runResult.succeeded && runResult.historyVisible && runResult.modelVisible && runResult.signalAccepted &&
        runResult.signalReplayed && runResult.manualEligibilityRefresh && runResult.submitDisabledDuringEligibilityRefresh &&
        runResult.feedbackSubmittedThroughRenderer && runResult.detailRereadAfterFeedback &&
        runResult.summaryCancelledWithinDeadline && runResult.summaryWindowCloseDidNotCancel &&
        runResult.summaryWindowCloseRequestSucceeded && runResult.summaryHeldNoFalseProgress &&
        runResult.summaryDiagnosticsVisible &&
        runResult.summaryDiagnosticsExported && runResult.summaryDiagnosticsPrivacyClean &&
        runResult.summaryTerminalNotificationDropped &&
        runResult.summaryCapacityFailed && runResult.summaryCapacityErrorVisible && runResult.summaryCapacityRecoveryVisible &&
        runResult.summaryCapacityToolCalls === 0 && runResult.summaryCapacityNoSummaryModelRequest &&
        runResult.promptAbsent && runResult.credentialAbsent && runResult.providerRequestCount > 0 &&
        runResult.providerCredentialObserved && runResult.providerCredentialExact && runResult.providerModelIds.length > 0 && runResult.providerModelIds.every((modelId) => modelId === 'j25-local-model'),
      settingsPath: 'formal-settings-renderer-preload',
      inputAppearance,
      nativePicker,
      inputsStyled: settingsResult.inputsStyled,
      inputFailureRecovered: settingsResult.inputFailureRecovered,
      uncredentialedFailureObserved: settingsResult.uncredentialedFailureObserved,
      failedRevisionUnchanged: settingsResult.failedRevisionUnchanged,
      failedChangedNotBroadcast: settingsResult.failedChangedNotBroadcast,
      inputPendingObserved: inputProbe.pending,
      invalidInputFailureCode: inputProbe.failureCode,
      invalidInputCommandCount: inputProbe.invalidCommands,
      runPath: 'formal-agent-bar-renderer-preload-main',
      historyPath: 'formal-agent-history-renderer-preload-main',
      routingMode: runResult.routingMode,
      providerRequestCount: runResult.providerRequestCount,
      providerRequestShapes: runResult.providerRequestShapes,
      providerCredentialObserved: runResult.providerCredentialObserved,
      providerCredentialExact: runResult.providerCredentialExact,
      modelIdentityObserved: runResult.modelVisible,
      agentEnabled: settingsResult.agentEnabled,
      personalContextManaged: settingsResult.memoryManaged,
      processingSuspended: settingsResult.processingSuspended,
      processingReenabled: settingsResult.processingReenabled,
      personalContextRevisionConflict: settingsResult.revisionConflict,
      interactionSignalAccepted: runResult.signalAccepted,
      interactionSignalReplayed: runResult.signalReplayed,
      summaryCapacityFailed: runResult.summaryCapacityFailed,
      summaryCapacityErrorVisible: runResult.summaryCapacityErrorVisible,
      summaryCapacityRecoveryVisible: runResult.summaryCapacityRecoveryVisible,
      summaryCapacityToolCalls: runResult.summaryCapacityToolCalls,
      summaryCapacityNoSummaryModelRequest: runResult.summaryCapacityNoSummaryModelRequest,
      manualEligibilityRefresh: runResult.manualEligibilityRefresh,
      submitDisabledDuringEligibilityRefresh: runResult.submitDisabledDuringEligibilityRefresh,
      eligibilityReadCount: runResult.eligibilityReadCount,
      feedbackSubmittedThroughRenderer: runResult.feedbackSubmittedThroughRenderer,
      detailRereadAfterFeedback: runResult.detailRereadAfterFeedback,
      summaryCancelledWithinDeadline: runResult.summaryCancelledWithinDeadline,
      summaryCancelElapsedMs: runControlProbe.cancelElapsedMs,
      summaryWindowCloseDidNotCancel: runResult.summaryWindowCloseDidNotCancel,
      summaryWindowCloseRequestSucceeded: runResult.summaryWindowCloseRequestSucceeded,
      summaryHeldNoFalseProgress: runResult.summaryHeldNoFalseProgress,
      summaryDiagnosticsVisible: runResult.summaryDiagnosticsVisible,
      summaryDiagnosticsExported: runResult.summaryDiagnosticsExported,
      summaryDiagnosticsPrivacyClean: runResult.summaryDiagnosticsPrivacyClean,
      summaryDiagnosticsRecordCount: runResult.summaryDiagnosticsRecordCount,
      summaryDiagnosticsExportBytes: runResult.summaryDiagnosticsExportBytes,
      summaryDiagnosticsExportSha256: runResult.summaryDiagnosticsExportSha256,
      summaryTerminalNotificationDropped: runControlProbe.capacityRequestNotificationLossObserved,
      summaryDroppedChangedCount: runControlProbe.droppedChangedCount,
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
