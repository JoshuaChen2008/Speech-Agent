'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')

const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

test('SEM-F31/J22: production main routes the toolbar Agent action to a reusable focused Agent Bar window', () => {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'main.js'), 'utf8')
  assert.match(source, /action === 'agent'\) openAgentWindow\(\)/)
  assert.match(source, /preloadPath\('agent'\)/)
  assert.match(source, /showAuxiliaryWindow\(agentWin, 'agent'\)/)
  assert.match(source, /bindAuxiliaryWindow\(agentWin, 'agent'\)/)
  assert.match(source, /bindForegroundWindow\(agentWin, 'agent'\)/)
  assert.match(source, /ipcMain\.on\(CHANNELS\.AGENT_CLOSE[\s\S]*win\.close\(\)/)
})

test('SEM-F38/J29: open Agent Bar receives config changes alongside summary routing feedback', () => {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, 'src', 'main.js'), 'utf8')
  assert.match(source, /ipcMain\.handle\(CHANNELS\.AGENT_OPEN/)
  assert.match(source, /for \(const win of \[captionWin, toolbarWin, settingsWin, historyWin, agentWin\]\) send\(win, CHANNELS\.CONFIG_CHANGED, value\)/)
  assert.match(source, /正在打开会话总结/)
  assert.match(source, /打开时间较长，可重试/)
  assert.match(source, /暂时无法打开会话总结，请重试/)
  assert.match(source, /ipcMain\.on\(CHANNELS\.HISTORY_SUMMARY[\s\S]*openAgentWindow\(\{ sessionId: reference \}\)/)
  assert.match(source, /AGENT_SCOPE_REQUESTED/)
})
