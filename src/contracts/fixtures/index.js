'use strict'

const { deepFreeze } = require('../shared')

const fixtures = {
  runtime: {
    unavailable: require('./runtime/unavailable.json'),
    idle: require('./runtime/idle.json'),
    starting: require('./runtime/starting.json'),
    listening: require('./runtime/listening.json'),
    paused: require('./runtime/paused.json'),
    resumed: require('./runtime/resumed.json'),
    stopping: require('./runtime/stopping.json'),
    recovering: require('./runtime/recovering.json'),
    error: require('./runtime/error.json')
  },
  captions: {
    partial: require('./captions/partial.json'),
    final: require('./captions/final.json'),
    refined: require('./captions/refined.json'),
    translated: require('./captions/translated.json')
  },
  commands: {
    startOk: require('./commands/start-ok.json'),
    modelNotReady: require('./commands/model-not-ready.json'),
    commandBusy: require('./commands/command-busy.json'),
    translationUnavailable: require('./commands/translation-unavailable.json')
  },
  capabilities: {
    full: require('./capabilities/full.json'),
    fallbackProfile: require('./capabilities/fallback-profile.json'),
    unavailable: require('./capabilities/unavailable.json')
  }
}

module.exports = deepFreeze(fixtures)
