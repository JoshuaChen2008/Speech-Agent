'use strict'

/*
 * J27 starts at the actual product entry.  Electron is the only substituted
 * external boundary: its unresolved ready promise leaves the normal startup
 * callbacks dormant while Node resolves every synchronous product dependency.
 * No product module is replaced or preloaded by this test.
 */

const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')
const test = require('node:test')

const ROOT = path.resolve(__dirname, '../..')
const MAIN_ENTRY = path.join(ROOT, 'src', 'main.js')
const LEGACY_AGENT_PREFIXES = Object.freeze([
  'src/agent-core/',
  'src/agent-mvp/',
  'src/agent-provider/',
  'src/agent-runtime/'
])
const LEGACY_COUNTERFACTUAL_ENTRIES = Object.freeze([
  { prefix: 'src/agent-core/', entry: path.join(ROOT, 'src', 'agent-core', 'contracts.js') },
  { prefix: 'src/agent-mvp/', entry: path.join(ROOT, 'src', 'agent-mvp', 'protocol.js') },
  { prefix: 'src/agent-provider/', entry: path.join(ROOT, 'src', 'agent-provider', 'provider-bootstrap.js') },
  { prefix: 'src/agent-runtime/', entry: path.join(ROOT, 'src', 'agent-runtime', 'formal-agent-runtime.js') }
])

function createDormantElectron () {
  const noop = () => {}
  const dormantReady = new Promise(() => {})
  return {
    app: {
      isPackaged: false,
      getPath: () => path.join(ROOT, '.test-user-data'),
      on: noop,
      once: noop,
      quit: noop,
      requestSingleInstanceLock: () => true,
      setAppUserModelId: noop,
      whenReady: () => dormantReady
    },
    BrowserWindow: class BrowserWindow {},
    dialog: { showSaveDialog: async () => ({ canceled: true }) },
    globalShortcut: { register: () => true, unregisterAll: noop },
    ipcMain: { handle: noop, on: noop },
    nativeTheme: { on: noop, shouldUseDarkColors: false },
    powerMonitor: { on: noop, removeListener: noop },
    safeStorage: { isEncryptionAvailable: () => false },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }) }
  }
}

function sourceRelativePath (resolved) {
  if (typeof resolved !== 'string' || !path.isAbsolute(resolved)) return null
  const relative = path.relative(ROOT, resolved).replace(/\\/g, '/')
  return relative.startsWith('..') ? null : relative
}

function isLegacyAgentPath (relative) {
  return relative !== null && LEGACY_AGENT_PREFIXES.some((prefix) => relative.startsWith(prefix))
}

function loadWithTrace (entry, electron) {
  const originalLoad = Module._load
  const trace = new Set()
  Module._load = function tracedLoad (request, parent, isMain) {
    if (request === 'electron') return electron
    const resolved = Module._resolveFilename(request, parent, isMain)
    const relative = sourceRelativePath(resolved)
    if (relative) trace.add(relative)
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    delete require.cache[require.resolve(entry)]
    require(entry)
    return trace
  } finally {
    Module._load = originalLoad
    delete require.cache[require.resolve(entry)]
  }
}

test('SEM-F29/J27: actual product entry require graph excludes every legacy Agent tree', () => {
  const trace = loadWithTrace(MAIN_ENTRY, createDormantElectron())
  const legacyEntries = [...trace].filter(isLegacyAgentPath)

  assert.deepEqual(legacyEntries, [],
    'the product entry must not synchronously reach any historical Agent implementation')

  for (const { prefix, entry } of LEGACY_COUNTERFACTUAL_ENTRIES) {
    const counterfactualTrace = loadWithTrace(entry, createDormantElectron())
    assert.equal([...counterfactualTrace].some((relative) => relative.startsWith(prefix)), true,
      `the tracker must reject a counterfactual manual require from ${prefix}`)
  }
})
