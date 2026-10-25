'use strict'

// Only registered categories may cross the diagnostic boundary. Never derive
// these strings from provider text, object keys, exception messages or paths.
const REASONS = Object.freeze(['unknown', 'json', 'schema', 'type', 'empty', 'length', 'control_character',
  'source_reference', 'memory_reference', 'coverage', 'output_size', 'response_protocol', 'transport_size'])
const FIELDS = Object.freeze(['output', 'overview', 'answer', 'conclusion.text', 'todo.text', 'todo.ownerHint',
  'todo.dueHint', 'risk.text', 'claim.text', 'sourceRefs', 'memoryRefs', 'unresolved item', 'coverage', 'response', 'topic.title', 'topic.text'])

function assertOutputValidation (value) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).sort().join(',') !== 'actual,field,limit,reason' ||
      !REASONS.includes(value.reason) || !FIELDS.includes(value.field) ||
      (value.actual !== null && (!Number.isSafeInteger(value.actual) || value.actual < 0)) ||
      (value.limit !== null && (!Number.isSafeInteger(value.limit) || value.limit < 0)) ||
      (value.actual === null) !== (value.limit === null) ||
      (value.actual !== null && !['length', 'output_size', 'transport_size'].includes(value.reason))) {
    throw new TypeError('invalid output validation diagnostic')
  }
  return value
}

function outputInvalid (reason = 'unknown', field = 'output', actual = null, limit = null) {
  const error = new Error('AGENT_OUTPUT_INVALID')
  error.code = 'AGENT_OUTPUT_INVALID'
  error.retryable = false
  error.outputValidation = Object.freeze(assertOutputValidation({ reason, field: FIELDS.includes(field) ? field : 'output', actual, limit }))
  return error
}

function outputValidationFor (error) {
  try { return { ...assertOutputValidation(error?.outputValidation) } } catch {
    return { reason: 'unknown', field: 'output', actual: null, limit: null }
  }
}

module.exports = { REASONS, FIELDS, assertOutputValidation, outputInvalid, outputValidationFor }
