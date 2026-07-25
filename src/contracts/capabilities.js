'use strict'

// @ts-check

const {
  LANGUAGE_TAG_PATTERN,
  assertArray,
  assertBoolean,
  assertEnum,
  assertNextAction,
  assertRecord,
  assertSchemaVersion,
  assertString,
  assertUniqueStrings,
  deepFreeze,
  fail
} = require('./shared')

const PROFILES = Object.freeze(['fast', 'balanced', 'accurate'])
const CAPABILITY_IDS = Object.freeze(['start', 'pause', 'resume', 'stop', 'retry', 'refine', 'translate'])
const CAPABILITY_FIELDS = Object.freeze({
  start: 'canStart',
  pause: 'canPause',
  resume: 'canResume',
  stop: 'canStop',
  retry: 'canRetry',
  refine: 'canRefine',
  translate: 'canTranslate'
})

function assertCapabilities (value, path = 'Capabilities') {
  assertSchemaVersion(value, path)

  for (const field of Object.values(CAPABILITY_FIELDS)) {
    assertBoolean(value[field], `${path}.${field}`)
  }

  assertUniqueStrings(value.availableProfiles, `${path}.availableProfiles`, { allowed: PROFILES })
  assertUniqueStrings(value.availableSourceIds, `${path}.availableSourceIds`)
  assertUniqueStrings(value.translationTargets, `${path}.translationTargets`, { pattern: LANGUAGE_TAG_PATTERN })

  if (value.canStart && (value.availableProfiles.length === 0 || value.availableSourceIds.length === 0)) {
    fail(`${path}.canStart`, 'cannot be true without a profile and an audio source')
  }
  if (value.canTranslate && value.translationTargets.length === 0) {
    fail(`${path}.canTranslate`, 'cannot be true without a translation target')
  }

  assertArray(value.limitations, `${path}.limitations`)
  const limited = new Set()
  value.limitations.forEach((limitation, index) => {
    const itemPath = `${path}.limitations[${index}]`
    assertRecord(limitation, itemPath)
    assertEnum(limitation.capability, CAPABILITY_IDS, `${itemPath}.capability`)
    assertString(limitation.code, `${itemPath}.code`, { nonEmpty: true, pattern: /^[A-Z][A-Z0-9_]*$/ })
    assertString(limitation.message, `${itemPath}.message`, { nonEmpty: true })
    assertNextAction(limitation.nextAction, `${itemPath}.nextAction`)
    if (limited.has(limitation.capability)) fail(`${itemPath}.capability`, 'must be unique')
    limited.add(limitation.capability)

    const field = CAPABILITY_FIELDS[limitation.capability]
    if (value[field]) fail(itemPath, `${field} must be false while a limitation is present`)
  })

  return value
}

function isCapabilities (value) {
  try {
    assertCapabilities(value)
    return true
  } catch {
    return false
  }
}

module.exports = {
  CAPABILITY_IDS,
  CAPABILITY_FIELDS,
  PROFILES,
  assertCapabilities,
  isCapabilities
}
