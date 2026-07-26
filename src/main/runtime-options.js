'use strict'

// @ts-check

const DEV_MODEL_ENV = 'LIVE_SUBTITLE_DEV_MODEL'
const DEV_MODEL_VALUE = 'x-asr-480ms'

/**
 * Gate 0B remains failed. This opt-in only lets the B1 fake adapter expose the
 * balanced product profile so application-state work can be exercised.
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
    warning: 'X-ASR 480ms is enabled for development only; Gate 0B is still not passed.'
  })
}

module.exports = {
  DEV_MODEL_ENV,
  DEV_MODEL_VALUE,
  resolveRuntimeOptions
}
