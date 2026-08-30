'use strict'

function deepFreeze (value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value)) deepFreeze(child)
  return value
}

const fixtures = {
  readSourcesSucceeded: require('./v1.0.0/read-sources-succeeded.json'),
  retryPreserved: require('./v1.0.0/retry-preserved.json'),
  runningCall: require('./v1.0.0/running-call.json'),
  searchContextSucceeded: require('./v1.0.0/search-context-succeeded.json'),
  toolArgsInvalid: require('./v1.0.0/tool-args-invalid.json'),
  toolBudgetExceeded: require('./v1.0.0/tool-budget-exceeded.json'),
  toolCancelled: require('./v1.0.0/tool-cancelled.json'),
  toolNotAvailable: require('./v1.0.0/tool-not-available.json'),
  toolScopeDenied: require('./v1.0.0/tool-scope-denied.json'),
  toolTimeout: require('./v1.0.0/tool-timeout.json')
}

module.exports = deepFreeze(fixtures)
