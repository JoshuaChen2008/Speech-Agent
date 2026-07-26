'use strict'

// @ts-check

const DEV_MODEL_ENV = 'LIVE_SUBTITLE_DEV_MODEL'
const DEV_MODEL_VALUE = 'x-asr-480ms'

/**
 * Development-only opt-in: lets the B1 fake adapter expose the balanced
 * product profile so application-state work can be exercised without any
 * model. It never loads a real model. The approved real model (Gate 0B
 * re-judgment, 2026-07-27) is resolved separately by
 * main/services/model-resolver.js and takes effect only when this dev
 * switch is NOT set.
 */
function resolveRuntimeOptions (environment = process.env) {
  const requested = environment[DEV_MODEL_ENV]
  if (requested === undefined || requested === '') {
    return Object.freeze({ modelOverride: null, warning: null })
  }
  if (requested !== DEV_MODEL_VALUE) {
    return Object.freeze({
      modelOverride: null,
      warning: `${DEV_MODEL_ENV} ignored: expected ${DEV_MODEL_VALUE}`
    })
  }
  return Object.freeze({
    modelOverride: Object.freeze({
      id: DEV_MODEL_VALUE,
      profile: 'balanced',
      developmentOnly: true
    }),
    warning: 'X-ASR 480ms fake-runtime mapping is enabled for development only; no real model is loaded and the approved real model path is bypassed.'
  })
}

module.exports = {
  DEV_MODEL_ENV,
  DEV_MODEL_VALUE,
  resolveRuntimeOptions
}
