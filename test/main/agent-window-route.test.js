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
  assert.match(source, /agentWin\.show\(\)\s*;\s*agentWin\.focus\(\)/)
  assert.match(source, /ipcMain\.on\(CHANNELS\.AGENT_CLOSE[\s\S]*win\.close\(\)/)
})
