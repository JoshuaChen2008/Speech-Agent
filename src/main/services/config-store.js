'use strict'

// @ts-check

const fs = require('node:fs')
const path = require('node:path')
const {
  ONBOARDING_PRESETS,
  assertListeningConfiguration,
  sourceFlagsForPreset
} = require('../../contracts')

const CONFIG_SCHEMA_VERSION = 1

const DEFAULT_CONFIG = Object.freeze({
  schemaVersion: CONFIG_SCHEMA_VERSION,
  onboardingCompleted: false,
  onboardingPreset: null,
  fontSize: 30,
  opacity: 0.86,
  toolbarOpacity: 0.82,
  barColor: null,
  // null = 跟随 tokens.css 的默认白（与主题无关，见 tokens.css §3）
  captionTextColor: null,
  radius: 10,
  captionWidth: 920,
  captionHeight: 190,
  theme: 'auto',
  bilingual: true,
  maxLines: 4,
  // Global, source-independent choice read once when a future session starts.
  refinementEnabled: false,
  // Gate 0D: fresh installs select neither source until the user chooses a preset.
  mic: false,
  loopback: false,
  latency: 480
})

const FIELD_RULES = Object.freeze({
  schemaVersion: (value) => Number.isInteger(value) && value === CONFIG_SCHEMA_VERSION,
  onboardingCompleted: (value) => typeof value === 'boolean',
  onboardingPreset: (value) => value === null || ONBOARDING_PRESETS.includes(value),
  fontSize: (value) => [24, 30, 38].includes(value),
  opacity: (value) => isFiniteRange(value, 0, 1),
  toolbarOpacity: (value) => isFiniteRange(value, 0, 1),
  barColor: (value) => value === null || (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)),
  captionTextColor: (value) => value === null || (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)),
  radius: (value) => isIntegerRange(value, 6, 16),
  captionWidth: (value) => isIntegerRange(value, 480, 1600),
  captionHeight: (value) => isIntegerRange(value, 140, 420),
  theme: (value) => ['light', 'auto', 'dark'].includes(value),
  bilingual: (value) => typeof value === 'boolean',
  maxLines: (value) => isIntegerRange(value, 1, 6),
  refinementEnabled: (value) => typeof value === 'boolean',
  mic: (value) => typeof value === 'boolean',
  loopback: (value) => typeof value === 'boolean',
  latency: (value) => [160, 480, 960].includes(value)
})

function isFiniteRange (value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
}

function isIntegerRange (value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max
}

function cloneConfig (value) {
  return { ...value }
}

function assertRecord (value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
}

function assertField (key, value, label = 'config') {
  const rule = FIELD_RULES[key]
  if (!rule) throw new TypeError(`${label}.${key} is not allowed`)
  if (!rule(value)) throw new TypeError(`${label}.${key} has an invalid value`)
}

/** Validate a renderer/application patch without silently accepting unknown keys. */
function validateConfigPatch (patch, label = 'config patch') {
  assertRecord(patch, label)
  for (const [key, value] of Object.entries(patch)) assertField(key, value, label)
  return patch
}

/**
 * Load legacy flat configs field-by-field. Invalid and unknown persisted values
 * fail closed to the current default instead of poisoning BrowserWindow options.
 */
function migrateConfig (input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return cloneConfig(DEFAULT_CONFIG)
  }

  const migrated = cloneConfig(DEFAULT_CONFIG)
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    if (key === 'schemaVersion' || !Object.hasOwn(input, key)) continue
    const value = input[key]
    if (FIELD_RULES[key](value)) migrated[key] = value
  }

  // Only a current-schema, internally consistent completed choice may retain
  // capture sources. Legacy, incomplete, and partially corrupted configs all
  // fail closed: the user must choose again before either source is enabled.
  const hasCompletedPreset =
    input.schemaVersion === CONFIG_SCHEMA_VERSION &&
    migrated.onboardingCompleted === true &&
    ONBOARDING_PRESETS.includes(migrated.onboardingPreset)
  if (!hasCompletedPreset) {
    migrated.onboardingCompleted = false
    migrated.onboardingPreset = null
    migrated.mic = false
    migrated.loopback = false
  } else {
    /* preset 是持久化选择的权威表达。旧版本允许两个独立开关，加载时将
       当前 schema 的有效 preset 归一化成单路 XOR，避免脏配置继续双路。 */
    Object.assign(migrated, sourceFlagsForPreset(migrated.onboardingPreset))
  }

  return migrated
}

class ConfigStore {
  constructor (filePath, options = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new TypeError('filePath must be a non-empty string')
    }
    this.filePath = filePath
    this.fs = options.fs || fs
    this.state = cloneConfig(DEFAULT_CONFIG)
  }

  load () {
    try {
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'))
      this.state = migrateConfig(parsed)
    } catch {
      this.state = cloneConfig(DEFAULT_CONFIG)
    }
    return this.get()
  }

  get () {
    return cloneConfig(this.state)
  }

  update (patch) {
    validateConfigPatch(patch)
    const next = { ...this.state, ...patch, schemaVersion: CONFIG_SCHEMA_VERSION }
    assertListeningConfiguration(next, 'config patch')
    this.persist(next)
    this.state = next
    return this.get()
  }

  applyPreset (preset) {
    if (!ONBOARDING_PRESETS.includes(preset)) {
      throw new TypeError(`unknown onboarding preset: ${String(preset)}`)
    }
    return this.update({
      onboardingCompleted: true,
      onboardingPreset: preset,
      ...sourceFlagsForPreset(preset)
    })
  }

  /**
   * Enabling refinement is deliberately separate from downloading its model.
   * A missing or invalid resource never causes a network request here and the
   * persisted preference remains false until the caller has proved readiness.
   */
  setRefinementPreference (enabled, refinementReady) {
    if (typeof enabled !== 'boolean') throw new TypeError('refinement preference must be a boolean')
    if (enabled && refinementReady !== true) {
      if (this.state.refinementEnabled) this.update({ refinementEnabled: false })
      return Object.freeze({
        accepted: false,
        reason: 'REFINEMENT_MODEL_NOT_READY',
        value: this.get()
      })
    }
    return Object.freeze({
      accepted: true,
      reason: null,
      value: this.update({ refinementEnabled: enabled })
    })
  }

  /** Apply the one allowed automatic correction: app startup readiness audit. */
  reconcileRefinementReadiness (refinementReady) {
    if (typeof refinementReady !== 'boolean') throw new TypeError('refinement readiness must be a boolean')
    if (refinementReady || !this.state.refinementEnabled) {
      return Object.freeze({ changed: false, value: this.get() })
    }
    return Object.freeze({ changed: true, value: this.update({ refinementEnabled: false }) })
  }

  persist (value) {
    const directory = path.dirname(this.filePath)
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
    this.fs.mkdirSync(directory, { recursive: true })
    try {
      this.fs.writeFileSync(temporary, JSON.stringify(value, null, 2), 'utf8')
      this.fs.renameSync(temporary, this.filePath)
    } catch (error) {
      try { this.fs.rmSync(temporary, { force: true }) } catch { /* best effort */ }
      throw error
    }
  }
}

module.exports = {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG,
  ONBOARDING_PRESETS,
  ConfigStore,
  migrateConfig,
  validateConfigPatch
}
