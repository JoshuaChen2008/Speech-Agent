'use strict'

// @ts-check

const {
  assertBoolean,
  assertNextAction,
  assertSchemaVersion,
  assertString,
  fail
} = require('./shared')

function assertCommandResult (value, path = 'CommandResult') {
  assertSchemaVersion(value, path)
  assertBoolean(value.ok, `${path}.ok`)
  assertString(value.code, `${path}.code`, { nonEmpty: true, pattern: /^[A-Z][A-Z0-9_]*$/ })
  assertNextAction(value.nextAction, `${path}.nextAction`)

  if (value.ok) {
    if (value.code !== 'OK') fail(`${path}.code`, 'must be OK for a successful result')
    if (value.message !== null) fail(`${path}.message`, 'must be null for a successful result')
    if (value.recoverable !== null) fail(`${path}.recoverable`, 'must be null for a successful result')
    if (value.nextAction !== null) fail(`${path}.nextAction`, 'must be null for a successful result')
  } else {
    if (value.code === 'OK') fail(`${path}.code`, 'must not be OK for a failed result')
    assertString(value.message, `${path}.message`, { nonEmpty: true })
    assertBoolean(value.recoverable, `${path}.recoverable`)
  }

  return value
}

function isCommandResult (value) {
  try {
    assertCommandResult(value)
    return true
  } catch {
    return false
  }
}

module.exports = {
  assertCommandResult,
  isCommandResult
}
