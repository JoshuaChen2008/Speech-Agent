'use strict'

/*
 * Deterministic J25 product journey.  The production main/preload/renderers
 * remain the system under test; only the provider network seam is controlled
 * by a loopback HTTP responder.  The report deliberately contains no prompt,
 * provider payload, credential, transcript text, or filesystem path.
 */

const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

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

    const nav = await waitFor(() => document.querySelector('[data-pane="agentModel"]'), 'agent model navigation')
    nav.click()
    const agentToggle = await waitFor(() => document.querySelector('input[aria-label="启用 Agent 系统"]'), 'Agent system toggle')
    setChecked(agentToggle, true)
    await waitFor(() => document.querySelector('input[aria-label="启用 Agent 系统"]')?.checked === true, 'Agent system enabled')
    const card = await waitFor(() => document.querySelector('[data-profile-id="deepseek"]'), 'deepseek profile')
    clickText(card, '修改档案')
    await waitFor(() => card.querySelector('input[aria-label="服务器地址"]'), 'connection editor')
    setInput(card.querySelector('input[aria-label="服务器地址"]'), 'https://127.0.0.1:${port}')
    clickText(card, '保存修改')
    await waitFor(() => [...card.querySelectorAll('button')].some((item) => item.textContent === '修改档案'), 'connection saved')

    clickText(card, '添加 model')
    const modelId = await waitFor(() => card.querySelector('input[aria-label="model ID"]'), 'model form')
    setInput(modelId, 'j25-local-model')
    setInput(card.querySelector('input[aria-label="最大输入 token"]'), '64000')
    setInput(card.querySelector('input[aria-label="最大输出 token"]'), '4096')
    for (const label of ['工具调用', '结构化输出', '流式输出', '用量上报']) {
      const group = await waitFor(() => card.querySelector('[aria-label="' + label + '"]'), label + ' capability group')
      clickText(group, '支持')
      await waitFor(() => card.querySelector('[aria-label="' + label + '"] button[aria-pressed="true"]'), label + ' capability selected')
    }
    await waitFor(() => [...card.querySelectorAll('button')].some((item) => item.textContent === '保存 model' && !item.disabled), 'model form valid')
    clickText(card, '保存 model')
    await waitFor(() => card.querySelector('[data-model-id="j25-local-model"]'), 'model saved')

    const credential = card.querySelector('input[type="password"]')
    setInput(credential, 'j25-local-provider-secret')
    clickText(card, '设置新凭据')
    await waitFor(() => credential.value === '', 'credential cleared')

    const purpose = document.querySelector('[data-purpose="default"] select')
    await waitFor(() => purpose && [...purpose.options].some((option) => option.value === 'deepseek::j25-local-model'), 'purpose target')
    select(purpose, 'deepseek::j25-local-model')
    await waitFor(() => document.querySelector('[data-purpose="default"]').textContent.includes('普通请求：配置充分'), 'purpose assigned')
    const defaultReady = document.querySelector('[data-purpose="default"]').textContent.includes('普通请求：配置充分')

    const contextNav = await waitFor(() => document.querySelector('[data-pane="agentContext"]'), 'personal context navigation')
    contextNav.click()
    const remember = await waitFor(() => document.querySelector('textarea[aria-label="记住个人记忆"]'), 'remember form')
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
    nav.click()
    await waitFor(() => document.querySelector('[data-pane="agentModel"]'), 'model pane after context management')
    contextNav.click()
    await waitFor(() => document.querySelector('textarea[aria-label="记住个人记忆"]'), 'context pane after context management')

    return {
      profileConnection: card.textContent.includes('https://127.0.0.1:${port}'),
      modelVisible: card.querySelector('[data-model-id="j25-local-model"]') !== null,
      credentialCleared: credential.value === '',
      defaultReady,
      agentEnabled: agentToggle.checked === true,
      memoryManaged: memoryId !== null && memoryLabel.length > 0 && memoryRow() === null &&
        document.querySelector('[data-memory-id="' + memoryId + '"]') === null
    }
  })()`)
}

async function runAgentBar (toolbar) {
  await toolbar.webContents.executeJavaScript("window.shell.action('agent'); true")
  const agent = await waitFor(() => windowFor('/agent/index.html'), 'Agent Bar window')
  await waitFor(async () => agent.webContents.executeJavaScript("document.readyState === 'complete'"), 'Agent Bar renderer')
  await waitFor(async () => agent.webContents.executeJavaScript("Boolean(document.querySelector('.scope-card'))"), 'terminal scope')
  await waitFor(async () => agent.webContents.executeJavaScript("document.querySelector('.eligibility')?.textContent === '可以运行'"), 'provider eligibility')
  const result = await agent.webContents.executeJavaScript(`(async () => {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const headers = { contract_id: 'speech-agent.agent-run.ui', contract_version: '1.0.0' }
    const scopes = await window.agentApi.getScopes({ ...headers, limit: 50, cursor: null })
    const scope = scopes.scopes?.[0]?.scope || scopes.default_scope
    const submitted = await window.agentApi.submit({
      ...headers,
      scope,
      prompt: '请回答这场会的重点',
      client_idempotency_key: 'client.j25.formal.settings'
    })
    let detail = null
    for (let i = 0; i < 240; i += 1) {
      detail = await window.agentApi.getInteraction({ ...headers, interaction_id: submitted.result.interaction_id })
      if (detail.ok === true && ['succeeded', 'failed', 'cancelled'].includes(detail.result.state)) break
      await sleep(50)
    }
    const history = await window.agentApi.getHistory({ ...headers, limit: 50, cursor: null })
    const signal = detail?.ok === true && detail.result.state === 'succeeded' && detail.result.result_digest
      ? await window.agentApi.recordSignal({
          ...headers,
          interaction_id: submitted.result.interaction_id,
          signal_kind: 'accept',
          payload: null,
          result_digest: detail.result.result_digest,
          signal_idempotency_key: 'signal.j25.formal.accept'
        })
      : null
    const signalReplay = signal?.ok === true
      ? await window.agentApi.recordSignal({
          ...headers,
          interaction_id: submitted.result.interaction_id,
          signal_kind: 'accept',
          payload: null,
          result_digest: detail.result.result_digest,
          signal_idempotency_key: 'signal.j25.formal.accept'
        })
      : null
    return {
      succeeded: detail?.ok === true && detail.result.state === 'succeeded',
      historyVisible: history?.ok === true && history.result.items.some((item) => item.interaction_id === submitted.result.interaction_id),
      modelVisible: detail?.result?.model?.model_id === 'j25-local-model',
      signalAccepted: signal?.ok === true && signal.result?.accepted === true,
      signalReplayed: signalReplay?.ok === true && signalReplay.result?.replayed === true
    }
  })()`)
  await agent.webContents.reload()
  await waitFor(async () => agent.webContents.executeJavaScript("document.readyState === 'complete'"), 'reloaded Agent Bar renderer')
  await waitFor(async () => agent.webContents.executeJavaScript("Boolean(document.querySelector('.history-card'))"), 'history renderer')
  const ui = await agent.webContents.executeJavaScript(`(() => {
    const visible = document.body.textContent
    return {
      historyVisible: document.querySelector('.history-card') !== null,
      modelVisible: visible.includes('j25-local-model'),
      promptAbsent: !visible.includes('请回答这场会的重点'),
      credentialAbsent: !visible.includes('j25-local-provider-secret')
    }
  })()`)
  return { ...result, ...ui }
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
    const runResult = await runAgentBar(toolbar)
    const report = {
      schemaVersion: 1,
      result: settingsResult.profileConnection && settingsResult.modelVisible && settingsResult.credentialCleared &&
        settingsResult.defaultReady && settingsResult.agentEnabled && settingsResult.memoryManaged &&
        runResult.succeeded && runResult.historyVisible && runResult.modelVisible && runResult.signalAccepted &&
        runResult.signalReplayed && runResult.promptAbsent && runResult.credentialAbsent && provider.state.requestCount === 1 &&
        provider.state.credentialObserved && provider.state.credentialExact && provider.state.modelIds.length === 1 && provider.state.modelIds[0] === 'j25-local-model',
      settingsPath: 'formal-settings-renderer-preload',
      runPath: 'formal-agent-bar-renderer-preload-main',
      historyPath: 'formal-agent-history-renderer-preload-main',
      providerRequestCount: provider.state.requestCount,
      providerCredentialObserved: provider.state.credentialObserved,
      providerCredentialExact: provider.state.credentialExact,
      modelIdentityObserved: runResult.modelVisible,
      agentEnabled: settingsResult.agentEnabled,
      personalContextManaged: settingsResult.memoryManaged,
      interactionSignalAccepted: runResult.signalAccepted,
      interactionSignalReplayed: runResult.signalReplayed,
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
