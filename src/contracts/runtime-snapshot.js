'use strict'

// @ts-check

const { PROFILES, assertCapabilities } = require('./capabilities')
const {
  assertArray,
  assertBoolean,
  assertEnum,
  assertFiniteNumber,
  assertInteger,
  assertNextAction,
  assertNullableString,
  assertRecord,
  assertSchemaVersion,
  assertString,
  fail
} = require('./shared')

const RUNTIME_PHASES = Object.freeze([
  'unavailable',
  'idle',
  'starting',
  'listening',
  'paused',
  'stopping',
  'recovering',
  'error'
])
const SOURCE_STATES = Object.freeze([
  'unavailable',
  'inactive',
  'starting',
  'active',
  'paused',
  'recovering',
  'error'
])
const MODEL_STATES = Object.freeze(['missing', 'downloading', 'verifying', 'ready', 'error'])
const ERROR_SCOPES = Object.freeze(['audio', 'model', 'worker', 'storage', 'translation', 'system'])

function assertSource (source, path) {
  assertRecord(source, path)
  assertString(source.id, `${path}.id`, { nonEmpty: true })
  assertString(source.label, `${path}.label`, { nonEmpty: true })
  assertEnum(source.state, SOURCE_STATES, `${path}.state`)
  assertFiniteNumber(source.level, `${path}.level`, { min: 0, max: 1 })
  if (source.state !== 'active' && source.level !== 0) {
    fail(`${path}.level`, 'must be 0 unless the source is active')
  }
}

function assertModel (model, path) {
  assertRecord(model, path)
  assertEnum(model.state, MODEL_STATES, `${path}.state`)
  if (model.profile !== null) assertEnum(model.profile, PROFILES, `${path}.profile`)
  if (model.progress !== null) assertFiniteNumber(model.progress, `${path}.progress`, { min: 0, max: 1 })

  if (model.state === 'ready') {
    if (model.profile === null) fail(`${path}.profile`, 'is required when the model is ready')
    if (model.progress !== 1) fail(`${path}.progress`, 'must be 1 when the model is ready')
  }
  if (model.state === 'missing' && (model.profile !== null || model.progress !== null)) {
    fail(path, 'a missing model cannot expose a profile or progress')
  }
  if ((model.state === 'downloading' || model.state === 'verifying') && model.progress === null) {
    fail(`${path}.progress`, `is required while ${model.state}`)
  }
}

function assertRuntimeError (error, path) {
  if (error === null) return
  assertRecord(error, path)
  assertEnum(error.scope, ERROR_SCOPES, `${path}.scope`)
  assertString(error.code, `${path}.code`, { nonEmpty: true, pattern: /^[A-Z][A-Z0-9_]*$/ })
  assertString(error.message, `${path}.message`, { nonEmpty: true })
  assertBoolean(error.recoverable, `${path}.recoverable`)
  assertNextAction(error.nextAction, `${path}.nextAction`)
}

function assertPhaseInvariants (snapshot, path) {
  const capabilities = snapshot.capabilities
  const sourceStates = snapshot.sources.map((source) => source.state)
  const controlFields = ['canStart', 'canPause', 'canResume', 'canStop', 'canRetry']

  const requireControls = (expected) => {
    for (const field of controlFields) {
      const wanted = expected.includes(field)
      if (capabilities[field] !== wanted) {
        fail(`${path}.capabilities.${field}`, `must be ${wanted} while phase is ${snapshot.phase}`)
      }
    }
  }
  const rejectSourceStates = (states) => {
    const index = sourceStates.findIndex((state) => states.includes(state))
    if (index !== -1) {
      fail(`${path}.sources[${index}].state`, `cannot be ${sourceStates[index]} while phase is ${snapshot.phase}`)
    }
  }
  const requireAnySourceState = (states) => {
    if (!sourceStates.some((state) => states.includes(state))) {
      fail(`${path}.sources`, `must contain a source in state ${states.join(' or ')} while phase is ${snapshot.phase}`)
    }
  }

  switch (snapshot.phase) {
    case 'unavailable':
      requireControls([])
      rejectSourceStates(['starting', 'active', 'paused', 'recovering'])
      break
    case 'idle':
      requireControls(['canStart'])
      rejectSourceStates(['starting', 'active', 'paused', 'recovering'])
      break
    case 'starting':
      requireControls([])
      requireAnySourceState(['starting'])
      rejectSourceStates(['paused', 'recovering', 'error'])
      break
    case 'listening':
      requireControls(['canPause', 'canStop'])
      requireAnySourceState(['active'])
      rejectSourceStates(['starting', 'paused', 'recovering', 'error'])
      break
    case 'paused':
      requireControls(['canResume', 'canStop'])
      requireAnySourceState(['paused'])
      rejectSourceStates(['starting', 'active', 'recovering'])
      break
    case 'stopping':
      requireControls([])
      rejectSourceStates(['starting', 'active', 'recovering'])
      break
    case 'recovering':
      requireControls([])
      requireAnySourceState(['recovering', 'error'])
      rejectSourceStates(['starting', 'paused'])
      break
    case 'error':
      requireControls([
        ...(snapshot.sessionId === null ? [] : ['canStop']),
        ...(snapshot.lastError.recoverable ? ['canRetry'] : [])
      ])
      break
  }
}

function assertRuntimeSnapshot (value, path = 'RuntimeSnapshot') {
  assertSchemaVersion(value, path)
  assertInteger(value.revision, `${path}.revision`, { min: 0 })
  assertNullableString(value.sessionId, `${path}.sessionId`, { nonEmpty: true })
  assertEnum(value.phase, RUNTIME_PHASES, `${path}.phase`)
  assertCapabilities(value.capabilities, `${path}.capabilities`)

  assertArray(value.sources, `${path}.sources`)
  const sourceIds = new Set()
  value.sources.forEach((source, index) => {
    const sourcePath = `${path}.sources[${index}]`
    assertSource(source, sourcePath)
    if (sourceIds.has(source.id)) fail(`${sourcePath}.id`, 'must be unique')
    sourceIds.add(source.id)
  })
  for (const id of value.capabilities.availableSourceIds) {
    if (!sourceIds.has(id)) fail(`${path}.capabilities.availableSourceIds`, `references unknown source ${JSON.stringify(id)}`)
  }

  assertModel(value.model, `${path}.model`)
  assertRuntimeError(value.lastError, `${path}.lastError`)

  if ((value.phase === 'unavailable' || value.phase === 'idle') && value.sessionId !== null) {
    fail(`${path}.sessionId`, `must be null while phase is ${value.phase}`)
  }
  if (['starting', 'listening', 'paused', 'stopping', 'recovering'].includes(value.phase) && value.sessionId === null) {
    fail(`${path}.sessionId`, `is required while phase is ${value.phase}`)
  }
  if (value.phase === 'error' && value.lastError === null) {
    fail(`${path}.lastError`, 'is required while phase is error')
  }
  if (value.phase !== 'error' && value.phase !== 'recovering' && value.lastError !== null) {
    fail(`${path}.lastError`, `must be null while phase is ${value.phase}`)
  }
  if (value.capabilities.canStart && value.model.state !== 'ready') {
    fail(`${path}.capabilities.canStart`, 'cannot be true unless the model is ready')
  }
  if (value.capabilities.canStop && value.sessionId === null) {
    fail(`${path}.capabilities.canStop`, 'cannot be true without an active session')
  }

  assertPhaseInvariants(value, path)

  return value
}

function isRuntimeSnapshot (value) {
  try {
    assertRuntimeSnapshot(value)
    return true
  } catch {
    return false
  }
}

module.exports = {
  ERROR_SCOPES,
  MODEL_STATES,
  RUNTIME_PHASES,
  SOURCE_STATES,
  assertRuntimeSnapshot,
  isRuntimeSnapshot
}
