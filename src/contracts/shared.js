'use strict'

// @ts-check

const SCHEMA_VERSION = 1
const LANGUAGE_TAG_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/

const NEXT_ACTIONS = Object.freeze([
  'retry',
  'open-settings',
  'open-model-manager',
  'request-permission'
])

function fail (path, message) {
  throw new TypeError(`${path}: ${message}`)
}

function assertRecord (value, path) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(path, 'must be an object')
  }
}

function assertSchemaVersion (value, path) {
  assertRecord(value, path)
  if (value.schemaVersion !== SCHEMA_VERSION) {
    fail(`${path}.schemaVersion`, `must equal ${SCHEMA_VERSION}`)
  }
}

function assertBoolean (value, path) {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean')
}

function assertString (value, path, options = {}) {
  if (typeof value !== 'string') fail(path, 'must be a string')
  if (options.nonEmpty && value.trim().length === 0) fail(path, 'must not be empty')
  if (options.pattern && !options.pattern.test(value)) fail(path, 'has an invalid format')
}

function assertNullableString (value, path, options = {}) {
  if (value !== null) assertString(value, path, options)
}

function assertFiniteNumber (value, path, options = {}) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(path, 'must be a finite number')
  }
  if (options.min !== undefined && value < options.min) fail(path, `must be >= ${options.min}`)
  if (options.max !== undefined && value > options.max) fail(path, `must be <= ${options.max}`)
}

function assertInteger (value, path, options = {}) {
  if (!Number.isInteger(value)) fail(path, 'must be an integer')
  if (options.min !== undefined && value < options.min) fail(path, `must be >= ${options.min}`)
}

function assertEnum (value, allowed, path) {
  if (!allowed.includes(value)) {
    fail(path, `must be one of: ${allowed.join(', ')}`)
  }
}

function assertArray (value, path) {
  if (!Array.isArray(value)) fail(path, 'must be an array')
}

function assertUniqueStrings (value, path, options = {}) {
  assertArray(value, path)
  const seen = new Set()
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`
    assertString(item, itemPath, { nonEmpty: true, pattern: options.pattern })
    if (options.allowed) assertEnum(item, options.allowed, itemPath)
    if (seen.has(item)) fail(itemPath, `duplicates ${JSON.stringify(item)}`)
    seen.add(item)
  })
}

function assertNextAction (value, path) {
  if (value !== null) assertEnum(value, NEXT_ACTIONS, path)
}

function deepFreeze (value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

module.exports = {
  LANGUAGE_TAG_PATTERN,
  NEXT_ACTIONS,
  SCHEMA_VERSION,
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
  assertUniqueStrings,
  deepFreeze,
  fail
}
