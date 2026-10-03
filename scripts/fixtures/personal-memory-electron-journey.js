'use strict'
// Production main, renderer, preload, utility process, SQLite and file actor.
// Only OS directory/save dialogs are replaced with isolated test locations.
const fs = require('node:fs')
const path = require('node:path')
const { app, BrowserWindow, dialog, utilityProcess, clipboard } = require('electron')
const { renderFile } = require('../../src/agent/personal-context/memory-file-format')
const project = path.resolve(__dirname, '../..')
const directory = path.resolve(process.env.MEMORY_FILES_USER_DATA || '')
if (!process.env.MEMORY_FILES_USER_DATA || directory === project || directory === path.parse(directory).root) throw new Error('isolated userData required')
app.setPath('userData', directory)
const root = path.join(directory, 'personal-memory/notes'); fs.mkdirSync(root, { recursive: true })
const custom = path.join(directory, 'chosen-notes'); fs.mkdirSync(custom, { recursive: true })
const exportPath = path.join(directory, 'governance.json')
let saveTarget = exportPath; let copied = ''
clipboard.writeText = value => { copied = value }
let storageChildren = 0; let picked = 0
let embeddingRequests = 0
let fixtureStage = 'startup'
const originalFetch = globalThis.fetch
globalThis.fetch = async (url, options) => {
  if (url !== 'https://embedding.example/v1/embeddings') return originalFetch(url, options)
  embeddingRequests++
  if (options.redirect !== 'manual' || options.headers.authorization !== 'Bearer isolated-vector-key') throw new Error('provider boundary invalid')
  return new Response(JSON.stringify({ model: 'synthetic-vector', data: JSON.parse(options.body).input.map((_text, index) => ({ index, embedding: [1, 0] })) }))
}
const fork = utilityProcess.fork.bind(utilityProcess)
utilityProcess.fork = (file, ...args) => { if (file.replaceAll('\\', '/').endsWith('/storage-worker/storage-worker.js')) storageChildren++; return fork(file, ...args) }
dialog.showOpenDialog = async (_win, options) => { picked++; return { canceled: false, filePaths: [options.properties.includes('openDirectory') ? custom : exportPath] } }
dialog.showSaveDialog = async () => ({ canceled: false, filePath: saveTarget })
const delay = () => new Promise(resolve => setTimeout(resolve, 40))
async function until (probe, label) {
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) { if (await probe()) return; await delay() }
  throw new Error(label)
}
async function main () {
  require('../../src/main')
  await app.whenReady()
  if (process.env.MEMORY_FILES_PHASE === 'restart') {
    let toolbar
    await until(() => { toolbar = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().replaceAll('\\', '/').includes('/toolbar/index.html')); return Boolean(toolbar) }, 'toolbar unavailable')
    await until(() => toolbar.webContents.executeJavaScript(`Boolean(window.shell)`), 'toolbar preload unavailable')
    await toolbar.webContents.executeJavaScript(`window.shell.action('settings')`)
  }
  let settings
  await until(() => { settings = BrowserWindow.getAllWindows().find(w => w.webContents.getURL().replaceAll('\\', '/').includes('/settings/settings.html')); return Boolean(settings) }, 'settings unavailable')
  const evaluate = source => settings.webContents.executeJavaScript(source)
  await until(() => evaluate(`Boolean(document.querySelector('[data-pane="agentContext"]'))`), 'renderer unavailable')
  await evaluate(`(() => { if (!document.querySelector('#onboarding').hidden) document.querySelector('[data-preset="meeting"]').click(); document.querySelector('.nav-item[data-pane="agentContext"]').click() })()`)
  await until(() => evaluate(`Boolean(document.querySelector('.memory-file-pane')) && Boolean(document.querySelector('textarea[aria-label="记住个人记忆"]'))`), 'memory pane unavailable')
  const files = command => evaluate(`window.shell.personalMemoryFiles(${JSON.stringify({ contractId: 'speech-agent.personal-memory.files', contractVersion: '1.0.0', command })})`)
  const click = (label, container = 'document') => evaluate(`(() => { const e = [...${container}.querySelectorAll('button')].find(b => b.textContent === ${JSON.stringify(label)}); if (!e || e.disabled) throw Error('button unavailable'); e.click() })()`)
  const text = async (label, value) => evaluate(`(() => { const e = document.querySelector('textarea[aria-label=${JSON.stringify(label)}]'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('input',{bubbles:true})) })()`)
  const report = { schemaVersion: 1, kind: 'personal-memory-electron-journey', phase: process.env.MEMORY_FILES_PHASE || 'write', storageUtilityObserved: false, embeddingAvailable: (await files({ type: 'status' })).result.embedding !== null }
  if (process.env.MEMORY_FILES_PHASE === 'restart') {
    const listing = await files({ type: 'list', after: null })
    report.rootRestored = (await files({ type: 'status' })).result.root.displayName === 'chosen-notes'
    report.confirmationRestored = listing.result.items.some(row => row.state === 'ready' && row.entry.display_text === '外部修订合成正文')
    report.mcpDisabledAfterRestart = !(await files({ type: 'mcpStatus' })).result.running
    report.result = report.rootRestored && report.confirmationRestored && report.mcpDisabledAfterRestart
  } else {
    await text('记住个人记忆', 'Electron 合成记忆正文'); await click('记住')
    let listing
    await until(async () => { listing = await files({ type: 'list', after: null }); return listing.ok && listing.result.items.some(row => row.entry?.display_text === 'Electron 合成记忆正文') }, 'remember did not write file')
    const file = listing.result.items.find(row => row.entry?.display_text === 'Electron 合成记忆正文')
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(path.join(directory, 'data/speech-agent.sqlite3'), { readOnly: true })
    const pointer = JSON.parse(db.prepare('SELECT content_json FROM personal_context_items WHERE memory_id=?').get(file.memoryId).content_json); db.close()
    report.markdownAuthority = pointer.storage === 'markdown' && !JSON.stringify(pointer).includes('合成记忆正文')
    await until(() => evaluate(`Boolean(document.querySelector('[data-memory-id="${file.memoryId}"]'))`), 'memory management row unavailable')
    await click('修改', `document.querySelector('[data-memory-id="${file.memoryId}"]')`)
    await text('修改个人记忆', '应用内修改合成正文'); await click('保存修改', `document.querySelector('[data-memory-id="${file.memoryId}"]')`)
    fixtureStage = 'read-in-app-edit'
    await until(() => evaluate(`(() => { const row = document.querySelector('[data-memory-id="${file.memoryId}"]'); return row?.getAttribute('aria-busy') === 'false' && !row.querySelector('textarea[aria-label="修改个人记忆"]') && row.textContent.includes('应用内修改合成正文') })()`), 'in-app save receipt unavailable')
    await until(() => Promise.resolve(fs.readFileSync(path.join(root, file.name), 'utf8').includes('应用内修改合成正文')), 'in-app write unavailable')
    report.inAppEdit = true
    fixtureStage = 'external-edit'
    fs.writeFileSync(path.join(root, file.name), renderFile(file.memoryId, { display_text: '外部修订合成正文', kind: 'project_fact', scope: { kind: 'global', reference: null } }))
    fixtureStage = 'confirm-external-edit'
    await click('刷新文件')
    await until(() => evaluate(`document.querySelector('.memory-file-pane').textContent.includes('外部修改待确认')`), 'external edit not pending')
    report.externalEditPending = true
    await click('核对并确认', `document.querySelector('.memory-file-pane')`)
    await until(() => evaluate(`Boolean(document.querySelector('[aria-label="确认记忆文件修改"]'))`), 'review missing')
    await click('确认本次修改')
    await until(async () => (await files({ type: 'list', after: null })).result.items.some(row => row.state === 'ready' && row.entry?.display_text === '外部修订合成正文'), 'confirmation not committed')
    report.explicitConfirmation = true
    fixtureStage = 'copy-root'
    fs.copyFileSync(path.join(root, file.name), path.join(custom, file.name))
    fixtureStage = 'choose-root'
    await click('选择记忆目录')
    await until(async () => (await files({ type: 'status' })).result.root.displayName === 'chosen-notes', 'chosen root missing')
    report.customRoot = picked === 1
    await until(() => evaluate(`document.querySelector('.memory-file-pane')?.getAttribute('aria-busy') === 'false'`), 'root action pending')
    await click('导出来源与撤销记录')
    fixtureStage = 'read-governance-export'
    await until(() => fs.existsSync(exportPath), 'governance export missing')
    const governance = JSON.parse(fs.readFileSync(exportPath, 'utf8'))
    report.governancePrivate = governance.schemaVersion === 1 && !/合成正文|[A-Z]:[\\/]|credential/i.test(JSON.stringify(governance))
    report.noEmbeddingBeforeConsent = embeddingRequests === 0
    await evaluate(`document.querySelector('.nav-item[data-pane="agentModel"]').click()`)
    await until(() => evaluate(`Boolean(document.querySelector('input[aria-label="启用 AI 助手"]'))`), 'agent toggle unavailable')
    await evaluate(`document.querySelector('input[aria-label="启用 AI 助手"]').click()`)
    await until(() => evaluate(`document.querySelector('input[aria-label="启用 AI 助手"]')?.checked === true && !document.querySelector('input[aria-label="启用 AI 助手"]').disabled`), 'agent toggle pending')
    await evaluate(`document.querySelector('.nav-item[data-pane="agentContext"]').click()`)
    await until(() => evaluate(`Boolean(document.querySelector('.memory-file-pane'))`), 'memory pane remount missing')
    await click('读取可选记忆')
    await until(() => evaluate(`Boolean([...document.querySelectorAll('.memory-file-control')].find(e => e.textContent.includes('外部修订合成正文')))`), 'sharing selection missing')
    await evaluate(`([...document.querySelectorAll('.memory-file-control')].find(e => e.textContent.includes('外部修订合成正文'))).querySelector('input').click()`)
    await click('预览选中内容（1）')
    await until(() => evaluate(`Boolean(document.querySelector('[aria-label="个人记忆内容预览"]'))`), 'sharing preview missing')
    await click('复制内容')
    await until(() => copied.includes('外部修订合成正文'), 'sharing copy missing')
    report.contentCopied = true
    saveTarget = path.join(directory, 'selected-memory.md')
    await until(() => evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent === '导出内容' && !b.disabled)`), 'sharing copy pending')
    await click('导出内容')
    fixtureStage = 'read-content-export'
    await until(() => fs.existsSync(saveTarget), 'sharing export missing')
    report.contentExported = fs.readFileSync(saveTarget, 'utf8') === copied
    fixtureStage = 'sharing-and-embedding'
    await until(() => evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent === '授权选中内容并开启 MCP' && !b.disabled)`), 'sharing export pending')
    await click('授权选中内容并开启 MCP')
    await until(() => evaluate(`[...document.querySelectorAll('button')].some(b => b.textContent === '复制 MCP 连接配置' && !b.disabled)`), 'sharing start pending')
    await click('复制 MCP 连接配置')
    await until(() => copied.startsWith('{'), 'sharing configuration missing')
    const connection = JSON.parse(copied).mcpServers['speech-agent-memory']
    const headers = { ...connection.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }
    const rpc = (method, params, id) => originalFetch(connection.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method, params, ...(id === undefined ? {} : { id }) }) })
    const initialized = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } }, 1)
    headers['mcp-session-id'] = initialized.headers.get('mcp-session-id'); await initialized.json()
    await rpc('notifications/initialized', {})
    const read = await (await rpc('tools/call', { name: 'read_memory', arguments: { memoryId: file.memoryId } }, 2)).json()
    report.mcpReadAuthorized = !read.result.isError && JSON.parse(read.result.content[0].text).items[0].text === '外部修订合成正文'
    await click('停止共享')
    await until(async () => !(await files({ type: 'mcpStatus' })).result.running, 'sharing stop pending')
    report.mcpStopped = true
    report.sharingWithoutModelCalls = embeddingRequests === 0
    await evaluate(`(() => {
      const set = (label, value) => { const e = document.querySelector('input[aria-label="'+label+'"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,value); e.dispatchEvent(new Event('input',{bubbles:true})) }
      set('语义搜索模型 HTTPS 服务地址','https://embedding.example'); set('语义搜索模型 ID','synthetic-vector');
    })()`)
    await evaluate(`(() => { const labels = [...document.querySelectorAll('.memory-file-pane label')]; labels.find(e => e.textContent.includes('我允许将上述')).querySelector('input').click() })()`)
    await evaluate(`(() => { const labels = [...document.querySelectorAll('.memory-file-pane label')]; labels.find(e => e.textContent.includes('启用语义搜索')).querySelector('input').click() })()`)
    await click('保存语义搜索设置')
    await until(async () => (await files({ type: 'status' })).result.embedding.enabled === true, 'embedding configuration missing')
    await until(() => evaluate(`document.querySelector('.memory-file-pane')?.getAttribute('aria-busy') === 'false'`), 'configuration pending')
    await evaluate(`(() => { const e = document.querySelector('input[aria-label="语义搜索模型 API 密钥"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'isolated-vector-key'); e.dispatchEvent(new Event('input',{bubbles:true})) })()`)
    await click('保存 API 密钥', `document.querySelector('.memory-file-pane')`)
    await until(async () => (await files({ type: 'status' })).result.index.vectors === 1, 'cloud index not published')
    report.embeddingConfiguredThroughRenderer = embeddingRequests > 0
    report.credentialInputCleared = await evaluate(`document.querySelector('input[aria-label="语义搜索模型 API 密钥"]').value === ''`)
    report.result = report.markdownAuthority && report.inAppEdit && report.externalEditPending && report.explicitConfirmation && report.customRoot && report.governancePrivate && report.noEmbeddingBeforeConsent && report.embeddingConfiguredThroughRenderer && report.credentialInputCleared
    report.result = report.result && report.contentCopied && report.contentExported && report.mcpReadAuthorized && report.mcpStopped && report.sharingWithoutModelCalls
  }
  report.storageUtilityObserved = storageChildren > 0
  report.result = report.result && report.storageUtilityObserved && report.embeddingAvailable
  process.stdout.write(JSON.stringify(report) + '\n')
  app.quit()
}
void main().catch(e => { const code = ['EBUSY', 'ENOENT', 'EPERM', 'EACCES'].includes(e.code) ? e.code : 'FIXTURE_FAILED'; process.stderr.write(`MEMORY_FILES_ELECTRON_JOURNEY_FAILED: ${fixtureStage}: ${code}\n`); app.exit(1) })
