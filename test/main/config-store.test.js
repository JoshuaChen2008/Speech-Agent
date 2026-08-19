'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')

const {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_CONFIG,
  ConfigStore,
  migrateConfig,
  validateConfigPatch
} = require('../../src/main/services/config-store')
const {
  DEV_MODEL_ENV,
  DEV_MODEL_VALUE,
  resolveRuntimeOptions
} = require('../../src/main/runtime-options')

function makeStore (t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'live-subtitle-config-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return {
    file: path.join(directory, 'config.json'),
    store: new ConfigStore(path.join(directory, 'config.json'))
  }
}

test('fresh config requires an explicit Gate 0D preset', (t) => {
  const { store } = makeStore(t)
  assert.deepEqual(store.load(), DEFAULT_CONFIG)
  assert.equal(store.get().onboardingCompleted, false)
  assert.equal(store.get().onboardingPreset, null)
  assert.equal(store.get().mic, false)
  assert.equal(store.get().loopback, false)
  assert.equal(store.get().refinementEnabled, false)
})

test('meeting and dictation presets select concrete, non-hidden sources', (t) => {
  const { store } = makeStore(t)
  store.load()

  assert.deepEqual(
    store.applyPreset('meeting'),
    { ...DEFAULT_CONFIG, onboardingCompleted: true, onboardingPreset: 'meeting', loopback: true }
  )
  assert.deepEqual(
    store.applyPreset('dictation'),
    { ...DEFAULT_CONFIG, onboardingCompleted: true, onboardingPreset: 'dictation', mic: true }
  )
  assert.throws(() => store.applyPreset('automatic'), /unknown onboarding preset/)
})

test('config updates reject unknown keys, invalid window bounds, and inconsistent onboarding', (t) => {
  const { store } = makeStore(t)
  store.load()

  for (const patch of [
    { arbitrary: true },
    { schemaVersion: CONFIG_SCHEMA_VERSION },
    { agentEnabled: true },
    { providerId: 'deepseek' }
  ]) {
    assert.throws(() => validateConfigPatch(patch), /not allowed/)
  }
  assert.throws(() => store.update({ captionWidth: 'wide' }), /invalid value/)
  assert.throws(() => store.update({ captionHeight: Number.NaN }), /invalid value/)
  assert.throws(() => store.update({ onboardingCompleted: true }), /inconsistent/)
  store.applyPreset('meeting')
  assert.throws(() => store.update({ mic: true }), /exactly one/)
  assert.throws(() => store.update({ loopback: false }), /exactly one/)
  assert.throws(() => store.update({ onboardingPreset: 'dictation' }), /exactly one/)
  assert.equal(store.get().onboardingPreset, 'meeting')
  assert.equal(store.get().mic, false)
  assert.equal(store.get().loopback, true)
})

test('persisted config is atomically replaceable and reloadable', (t) => {
  const { file, store } = makeStore(t)
  store.load()
  store.applyPreset('meeting')
  store.update({ opacity: 0.5, captionWidth: 1200 })

  const reloaded = new ConfigStore(file)
  assert.deepEqual(reloaded.load(), store.get())
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion, CONFIG_SCHEMA_VERSION)
  assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(), ['config.json'])
})

test('SEM-F22 / J19 normalizes the unmarked mixed-DPI risk geometry exactly once', (t) => {
  const { file, store } = makeStore(t)
  fs.writeFileSync(file, JSON.stringify({
    ...DEFAULT_CONFIG,
    captionWidth: 1373,
    captionHeight: 168
  }))

  const loaded = store.load()
  assert.equal(loaded.captionWidth, DEFAULT_CONFIG.captionWidth)
  assert.equal(loaded.captionHeight, DEFAULT_CONFIG.captionHeight)
  assert.equal(Object.hasOwn(loaded, 'windowGeometryRevision'), false)

  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(persisted.captionWidth, DEFAULT_CONFIG.captionWidth)
  assert.equal(persisted.captionHeight, DEFAULT_CONFIG.captionHeight)
  assert.equal(persisted.windowGeometryRevision, 1)
})

test('SEM-F22 / J19 preserves non-risk legacy geometry while recording its revision', (t) => {
  const { file, store } = makeStore(t)
  fs.writeFileSync(file, JSON.stringify({
    ...DEFAULT_CONFIG,
    captionWidth: 1373,
    captionHeight: 190
  }))

  assert.equal(store.load().captionWidth, 1373)
  assert.equal(store.get().captionHeight, 190)
  const persisted = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(persisted.captionWidth, 1373)
  assert.equal(persisted.captionHeight, 190)
  assert.equal(persisted.windowGeometryRevision, 1)
})

test('SEM-F22 / J19 preserves explicitly revised risk geometry without exposing the internal marker', (t) => {
  const { file, store } = makeStore(t)
  fs.writeFileSync(file, JSON.stringify({
    ...DEFAULT_CONFIG,
    captionWidth: 1373,
    captionHeight: 168,
    windowGeometryRevision: 1
  }))

  const loaded = store.load()
  assert.equal(loaded.captionWidth, 1373)
  assert.equal(loaded.captionHeight, 168)
  assert.equal(Object.hasOwn(loaded, 'windowGeometryRevision'), false)
  assert.throws(
    () => store.update({ windowGeometryRevision: 2 }),
    /windowGeometryRevision is not allowed/
  )
})

test('global refinement preference is default-off, requires a ready model to enable, and startup reconciliation closes stale enabled state', (t) => {
  const { file, store } = makeStore(t)
  store.load()

  assert.deepEqual(store.setRefinementPreference(true, false), {
    accepted: false,
    reason: 'REFINEMENT_MODEL_NOT_READY',
    value: { ...DEFAULT_CONFIG }
  })
  assert.equal(store.get().refinementEnabled, false)

  assert.deepEqual(store.setRefinementPreference(true, true), {
    accepted: true,
    reason: null,
    value: { ...DEFAULT_CONFIG, refinementEnabled: true }
  })
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).refinementEnabled, true)

  assert.deepEqual(store.reconcileRefinementReadiness(false), {
    changed: true,
    value: { ...DEFAULT_CONFIG, refinementEnabled: false }
  })
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).refinementEnabled, false)
})

test('legacy migration preserves appearance but closes sources until Gate 0D', () => {
  const migrated = migrateConfig({
    fontSize: 38,
    mic: true,
    loopback: false,
    captionWidth: 'not-a-number',
    injected: 'ignored'
  })
  assert.equal(migrated.fontSize, 38)
  assert.equal(migrated.captionWidth, DEFAULT_CONFIG.captionWidth)
  assert.equal(migrated.mic, false)
  assert.equal(migrated.loopback, false)
  assert.equal(migrated.onboardingCompleted, false)
  assert.equal(migrated.onboardingPreset, null)
  assert.equal(Object.hasOwn(migrated, 'injected'), false)
})

test('current-schema onboarding corruption also fails closed', () => {
  for (const input of [
    {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      onboardingCompleted: true,
      onboardingPreset: null,
      mic: true,
      loopback: true
    },
    {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      onboardingCompleted: false,
      onboardingPreset: null,
      mic: true,
      loopback: false
    },
    {
      schemaVersion: CONFIG_SCHEMA_VERSION,
      onboardingCompleted: false,
      onboardingPreset: 'meeting',
      mic: false,
      loopback: true
    }
  ]) {
    const migrated = migrateConfig(input)
    assert.equal(migrated.onboardingCompleted, false)
    assert.equal(migrated.onboardingPreset, null)
    assert.equal(migrated.mic, false)
    assert.equal(migrated.loopback, false)
  }
})

test('SEM-F26/SEM-F28 / J24-B23 preserves v1 subtitle settings and isolates invalid v2 Agent settings', () => {
  const migratedV1 = migrateConfig({
    schemaVersion: 1,
    onboardingCompleted: true,
    onboardingPreset: 'meeting',
    fontSize: 38,
    refinementEnabled: true,
    mic: true,
    loopback: false,
    agentEnabled: true,
    automaticProcessingSince: 10,
    memoryEnabled: true,
    memoryProcessingSince: 10,
    cloudDisclosureAccepted: true,
    agentSettingsRevision: 4
  })
  assert.equal(migratedV1.fontSize, 38)
  assert.equal(migratedV1.refinementEnabled, true)
  assert.equal(migratedV1.mic, false)
  assert.equal(migratedV1.loopback, true)
  assert.deepEqual({
    agentEnabled: migratedV1.agentEnabled,
    automaticProcessingSince: migratedV1.automaticProcessingSince,
    memoryEnabled: migratedV1.memoryEnabled,
    memoryProcessingSince: migratedV1.memoryProcessingSince,
    cloudDisclosureAccepted: migratedV1.cloudDisclosureAccepted,
    agentSettingsRevision: migratedV1.agentSettingsRevision
  }, {
    agentEnabled: false,
    automaticProcessingSince: null,
    memoryEnabled: true,
    memoryProcessingSince: null,
    cloudDisclosureAccepted: false,
    agentSettingsRevision: 0
  })

  const validV2 = migrateConfig({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    onboardingCompleted: true,
    onboardingPreset: 'dictation',
    mic: false,
    loopback: false,
    agentEnabled: true,
    automaticProcessingSince: 20,
    memoryEnabled: false,
    memoryProcessingSince: null,
    cloudDisclosureAccepted: true,
    agentSettingsRevision: 7
  })
  assert.equal(validV2.mic, true)
  assert.equal(validV2.loopback, false)
  assert.equal(validV2.agentEnabled, true)
  assert.equal(validV2.automaticProcessingSince, 20)
  assert.equal(validV2.memoryEnabled, false)
  assert.equal(validV2.memoryProcessingSince, null)
  assert.equal(validV2.cloudDisclosureAccepted, true)
  assert.equal(validV2.agentSettingsRevision, 7)

  const invalidV2 = migrateConfig({
    ...validV2,
    fontSize: 24,
    memoryEnabled: true,
    memoryProcessingSince: null
  })
  assert.equal(invalidV2.fontSize, 24)
  assert.equal(invalidV2.onboardingPreset, 'dictation')
  assert.equal(invalidV2.mic, true)
  assert.equal(invalidV2.loopback, false)
  assert.equal(invalidV2.agentEnabled, false)
  assert.equal(invalidV2.automaticProcessingSince, null)
  assert.equal(invalidV2.memoryEnabled, true)
  assert.equal(invalidV2.memoryProcessingSince, null)
  assert.equal(invalidV2.cloudDisclosureAccepted, false)
  assert.equal(invalidV2.agentSettingsRevision, 0)
})

test('Gate 0B fails closed unless the exact development override is present', () => {
  assert.equal(resolveRuntimeOptions({}).modelOverride, null)
  assert.equal(resolveRuntimeOptions({ [DEV_MODEL_ENV]: 'balanced' }).modelOverride, null)

  const enabled = resolveRuntimeOptions({ [DEV_MODEL_ENV]: DEV_MODEL_VALUE })
  assert.deepEqual(enabled.modelOverride, {
    id: DEV_MODEL_VALUE,
    profile: 'balanced',
    developmentOnly: true
  })
  assert.match(enabled.warning, /development only/i)
  assert.equal(resolveRuntimeOptions(
    { [DEV_MODEL_ENV]: DEV_MODEL_VALUE },
    { packaged: true }
  ).modelOverride, null)
})
