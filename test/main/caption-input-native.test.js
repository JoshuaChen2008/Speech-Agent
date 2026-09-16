'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const {
  ADDON_RELATIVE_PATH,
  addonPath,
  createBinding,
  createDiagnosticBinding,
  loadCaptionInputNative,
  validateAddon,
  validateDiagnosticAddon,
  validateProductionAddon
} = require('../../src/main/caption-input-native')

test('caption native addon path uses the unpacked packaged location', () => {
  assert.equal(
    addonPath({ isPackaged: true, resourcesPath: 'C:\\resources' }),
    path.join('C:\\resources', 'app.asar.unpacked', ADDON_RELATIVE_PATH)
  )
})

test('caption native loader fails closed when the Windows addon is absent', () => {
  assert.throws(
    () => loadCaptionInputNative({ platform: 'win32', projectRoot: path.join('Z:', 'missing') }),
    (error) => error.code === 'CAPTION_NATIVE_INPUT_UNAVAILABLE'
  )
})

test('caption native loader skips the Windows addon off platform', () => {
  assert.equal(loadCaptionInputNative({ platform: 'linux' }), null)
})

test('caption native production binding excludes diagnostic operations', () => {
  const calls = []
  const addon = {
    attach: (hwnd, correct) => { calls.push(['attach', hwnd, correct]); return 'binding' },
    isAttached: (raw) => raw === 'binding',
    detach: (raw) => { calls.push(['detach', raw]) },
    getStats: () => ({ correctedCount: 0 }),
    normalizeMouseActivate: () => 3,
    inspectWindow: (hwnd) => ({ sameProcess: true, sameThread: true, hwnd })
  }
  const binding = createBinding(addon, Buffer.alloc(8), { correct: false })
  assert.equal(binding.isAttached(), true)
  assert.equal(calls[0][2], false)
  assert.equal('inspect' in binding, false)
  assert.equal('stats' in binding, false)
  assert.equal('probeMouseActivate' in binding, false)
  binding.dispose()
  assert.deepEqual(calls.map(([name]) => name), ['attach', 'detach'])
  assert.throws(() => validateAddon({}), /API is invalid/)
  const productionOnly = {
    attach: () => 'binding',
    isAttached: () => true,
    detach: () => {}
  }
  assert.equal(validateProductionAddon(productionOnly), productionOnly)
  assert.throws(() => validateDiagnosticAddon(productionOnly), /diagnostic API is invalid/)
  const productionBinding = createBinding(productionOnly, Buffer.alloc(8))
  assert.equal('inspect' in productionBinding, false)
  productionBinding.dispose()
})

test('caption native diagnostic binding is explicit and retains the same production lifecycle', () => {
  const calls = []
  const addon = {
    attach: (hwnd) => { calls.push(['attach', hwnd]); return `binding-${calls.length}` },
    isAttached: () => true,
    detach: (raw) => { calls.push(['detach', raw]) },
    getStats: () => ({ correctedCount: 0 }),
    normalizeMouseActivate: () => 3,
    inspectWindow: () => ({ sameProcess: true, sameThread: true }),
    probeMouseActivate: () => 3
  }
  const binding = createDiagnosticBinding(addon, Buffer.alloc(8))
  assert.equal(binding.inspect().sameThread, true)
  assert.equal(binding.stats().correctedCount, 0)
  assert.equal(binding.probeMouseActivate(1, 513), 3)
  binding.dispose()
  assert.deepEqual(calls.map(([name]) => name), ['attach', 'detach'])
})

test('caption native addon normalizes only the swallowed client left-button activation', () => {
  if (process.platform !== 'win32') return
  const addon = loadCaptionInputNative({ platform: 'win32', projectRoot: path.resolve(__dirname, '../..') })
  assert.throws(() => addon.attach(Buffer.alloc(4)), /invalid HWND/)
  assert.throws(() => addon.inspectWindow(Buffer.alloc(4)), /invalid HWND/)
  assert.equal(addon.normalizeMouseActivate(4, 1, 513), 3)
  assert.equal(addon.normalizeMouseActivate(4, 1, 514), 4)
  assert.equal(addon.normalizeMouseActivate(4, 2, 513), 4)
  assert.equal(addon.normalizeMouseActivate(3, 1, 513), 3)
})
