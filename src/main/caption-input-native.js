'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ADDON_RELATIVE_PATH = path.join('src', 'native', 'caption-input', 'caption_input_native.node')
const PRODUCTION_API = Object.freeze(['attach', 'isAttached', 'detach'])
const DIAGNOSTIC_API = Object.freeze([
  'getStats',
  'normalizeMouseActivate',
  'inspectWindow',
  'probeMouseActivate'
])

function addonPath ({ isPackaged = false, resourcesPath = process.resourcesPath, projectRoot = null } = {}) {
  if (isPackaged) return path.join(resourcesPath, 'app.asar.unpacked', ADDON_RELATIVE_PATH)
  const root = projectRoot || path.resolve(__dirname, '..', '..')
  return path.join(root, ADDON_RELATIVE_PATH)
}

function validateProductionAddon (addon) {
  if (!addon || typeof addon !== 'object' ||
      PRODUCTION_API.some((name) => typeof addon[name] !== 'function')) {
    throw new TypeError('caption input native addon API is invalid')
  }
  return addon
}

function validateDiagnosticAddon (addon) {
  validateProductionAddon(addon)
  if (DIAGNOSTIC_API.some((name) => typeof addon[name] !== 'function')) {
    throw new TypeError('caption input native diagnostic API is invalid')
  }
  return addon
}

function validateAddon (addon) {
  return validateProductionAddon(addon)
}

function loadCaptionInputNative ({
  platform = process.platform,
  isPackaged = false,
  resourcesPath = process.resourcesPath,
  projectRoot = null,
  requireAddon = require
} = {}) {
  if (platform !== 'win32') return null
  const target = addonPath({ isPackaged, resourcesPath, projectRoot })
  if (!fs.existsSync(target)) {
    const error = new Error('caption input native addon is unavailable')
    error.code = 'CAPTION_NATIVE_INPUT_UNAVAILABLE'
    throw error
  }
  try {
    return validateProductionAddon(requireAddon(target))
  } catch (error) {
    if (error && error.code === 'CAPTION_NATIVE_INPUT_UNAVAILABLE') throw error
    const wrapped = new Error('caption input native addon failed to load')
    wrapped.code = 'CAPTION_NATIVE_INPUT_LOAD_FAILED'
    wrapped.cause = error
    throw wrapped
  }
}

function makeBinding (addon, handle, raw) {
  return Object.freeze({
    isAttached: () => addon.isAttached(raw) === true,
    dispose: () => addon.detach(raw),
    matches: (candidate) => Buffer.isBuffer(candidate) && candidate.equals(handle)
  })
}

function createBinding (addon, hwnd, { correct = true } = {}) {
  validateProductionAddon(addon)
  if (!Buffer.isBuffer(hwnd) || hwnd.length === 0) {
    throw new TypeError('caption native HWND handle is invalid')
  }
  if (typeof correct !== 'boolean') throw new TypeError('caption native correction mode is invalid')
  const handle = Buffer.from(hwnd)
  const raw = addon.attach(handle, correct)
  return makeBinding(addon, handle, raw)
}

function createDiagnosticBinding (addon, hwnd, options = {}) {
  validateDiagnosticAddon(addon)
  if (!Buffer.isBuffer(hwnd) || hwnd.length === 0) {
    throw new TypeError('caption native HWND handle is invalid')
  }
  const correct = options.correct === undefined ? true : options.correct
  if (typeof correct !== 'boolean') throw new TypeError('caption native correction mode is invalid')
  const handle = Buffer.from(hwnd)
  const raw = addon.attach(handle, correct)
  const binding = makeBinding(addon, handle, raw)
  return Object.freeze({
    ...binding,
    inspect: () => addon.inspectWindow(handle),
    stats: () => addon.getStats(raw),
    probeMouseActivate: (hitTest, mouseMessage) =>
      addon.probeMouseActivate(raw, hitTest, mouseMessage)
  })
}

module.exports = {
  ADDON_RELATIVE_PATH,
  addonPath,
  createBinding,
  createDiagnosticBinding,
  loadCaptionInputNative,
  validateAddon,
  validateDiagnosticAddon,
  validateProductionAddon
}
