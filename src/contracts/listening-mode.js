'use strict'

// @ts-check

/* 产品监听模式的唯一语义来源。支持 mic / loopback 两种单路模式，
   但一个已配置会话必须且只能选择其中一路。 */

const AUDIO_SOURCE_IDS = Object.freeze(['mic', 'loopback'])
const ONBOARDING_PRESETS = Object.freeze(['meeting', 'dictation'])
const SOURCE_BY_PRESET = Object.freeze({
  meeting: 'loopback',
  dictation: 'mic'
})

function sourceFlagsForPreset (preset) {
  if (!ONBOARDING_PRESETS.includes(preset)) {
    throw new TypeError(`unknown onboarding preset: ${String(preset)}`)
  }
  const sourceId = SOURCE_BY_PRESET[preset]
  return { mic: sourceId === 'mic', loopback: sourceId === 'loopback' }
}

function assertListeningConfiguration (configuration, label = 'configuration') {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    throw new TypeError(`${label} is required`)
  }
  if (typeof configuration.onboardingCompleted !== 'boolean') {
    throw new TypeError(`${label}.onboardingCompleted must be a boolean`)
  }
  if (configuration.onboardingPreset !== null &&
      !ONBOARDING_PRESETS.includes(configuration.onboardingPreset)) {
    throw new TypeError(`${label}.onboardingPreset is invalid`)
  }
  if (typeof configuration.mic !== 'boolean' || typeof configuration.loopback !== 'boolean') {
    throw new TypeError(`${label} capture flags must be booleans`)
  }

  if (!configuration.onboardingCompleted) {
    if (configuration.onboardingPreset !== null || configuration.mic || configuration.loopback) {
      throw new TypeError(`${label} must select no source before onboarding`)
    }
  } else {
    if (configuration.onboardingPreset === null) {
      throw new TypeError(`${label} onboarding fields are inconsistent`)
    }
    const expected = sourceFlagsForPreset(configuration.onboardingPreset)
    if (configuration.mic !== expected.mic || configuration.loopback !== expected.loopback) {
      throw new TypeError(`${label} must select exactly one source matching its preset`)
    }
  }

  return configuration
}

function selectedSourceIds (configuration) {
  assertListeningConfiguration(configuration)
  if (!configuration.onboardingCompleted) return []
  return [SOURCE_BY_PRESET[configuration.onboardingPreset]]
}

function assertSingleSourceIds (sourceIds, label = 'sourceIds') {
  if (!Array.isArray(sourceIds) || sourceIds.length !== 1) {
    throw new TypeError(`${label} must contain exactly one sourceId`)
  }
  if (!AUDIO_SOURCE_IDS.includes(sourceIds[0])) {
    throw new TypeError(`unknown sourceId: ${String(sourceIds[0])}`)
  }
  return sourceIds
}

module.exports = {
  AUDIO_SOURCE_IDS,
  ONBOARDING_PRESETS,
  SOURCE_BY_PRESET,
  assertListeningConfiguration,
  assertSingleSourceIds,
  selectedSourceIds,
  sourceFlagsForPreset
}
