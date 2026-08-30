'use strict'

// S4 keeps every ten-axis value and its pure enforcement contract here. This
// module performs no model, tool, storage, filesystem, process, or network I/O.

const { getRecipe, RECIPE_CATALOG } = require('./recipes')

const BUDGET_AXES = Object.freeze([
  'maxTurns',
  'maxRequestInputTokens',
  'maxCumulativeInputTokens',
  'maxCumulativeOutputTokens',
  'maxWallClockMs',
  'maxToolCalls',
  'toolTimeoutMs',
  'maxParallelTools',
  'maxToolResultBytes',
  'maxSourceTextBytes'
])

const LIMITS = Object.freeze({
  maxCumulativeInputTokens: 120000,
  maxCumulativeOutputTokens: 8000,
  interactiveWallClockMs: 60000,
  automaticWallClockMs: 180000,
  maxToolCalls: 12,
  toolTimeoutMs: 5000,
  maxParallelTools: 1,
  maxToolResultBytes: 256 * 1024,
  maxSourceTextBytes: 128 * 1024
})

const TOOL_PAYLOAD_LIMITS = Object.freeze({
  maxArgsBytes: 8 * 1024,
  maxResultBytes: 64 * 1024
})

const BUDGET_AXIS_STATES = Object.freeze(['within', 'exhausted', 'not_evaluated'])
const BUDGET_EXCEEDED_ERROR_CODE = 'AGENT_BUDGET_EXCEEDED'

function budgetError (message) {
  const error = new TypeError(`AGENT_REQUEST_INVALID: ${message}`)
  error.code = 'AGENT_REQUEST_INVALID'
  return error
}

function exactObject (value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw budgetError(`${label} must be an object`)
  }
  const expected = [...keys].sort()
  const actual = Object.keys(value).sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw budgetError(`${label} must contain exact keys`)
  }
}

function nonNegativeInteger (value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw budgetError(`${label} is invalid`)
  return value
}

function positiveInteger (value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw budgetError(`${label} is invalid`)
  return value
}

function sameArray (left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function assertRegisteredToolGrantCombination (maxTurns, toolGrants) {
  if (![1, 3, 6].includes(maxTurns)) throw new TypeError('maxTurns is invalid')
  if (!Array.isArray(toolGrants) || toolGrants.some((tool) => !['search_context', 'read_sources'].includes(tool)) ||
      new Set(toolGrants).size !== toolGrants.length) {
    throw new TypeError('tool grants are invalid')
  }
  if (!RECIPE_CATALOG.some((recipe) => recipe.maxTurns === maxTurns && sameArray(recipe.toolGrants, toolGrants))) {
    throw new TypeError('maxTurns and tool grants are not registered together')
  }
  return toolGrants
}

function deriveBudget (capabilities, maxTurns, toolGrants, requestedBy) {
  if (!capabilities || !Number.isSafeInteger(capabilities.maxInputTokens) || capabilities.maxInputTokens < 1 ||
      !Number.isSafeInteger(capabilities.maxOutputTokens) || capabilities.maxOutputTokens < 1) {
    throw new TypeError('model capabilities are required')
  }
  assertRegisteredToolGrantCombination(maxTurns, toolGrants)
  if (!['automatic', 'user'].includes(requestedBy)) throw new TypeError('requestedBy is invalid')
  return Object.freeze({
    maxTurns,
    maxRequestInputTokens: Math.min(capabilities.maxInputTokens, LIMITS.maxCumulativeInputTokens),
    maxCumulativeInputTokens: LIMITS.maxCumulativeInputTokens,
    maxCumulativeOutputTokens: Math.min(capabilities.maxOutputTokens, LIMITS.maxCumulativeOutputTokens),
    maxWallClockMs: requestedBy === 'automatic' ? LIMITS.automaticWallClockMs : LIMITS.interactiveWallClockMs,
    maxToolCalls: LIMITS.maxToolCalls,
    toolTimeoutMs: LIMITS.toolTimeoutMs,
    maxParallelTools: LIMITS.maxParallelTools,
    maxToolResultBytes: LIMITS.maxToolResultBytes,
    maxSourceTextBytes: LIMITS.maxSourceTextBytes
  })
}

function deriveRecipeBudget (capabilities, recipeId, recipeVersion, requestedBy) {
  const recipe = getRecipe(recipeId, recipeVersion)
  return deriveBudget(capabilities, recipe.maxTurns, recipe.toolGrants, requestedBy)
}

function assertBudgetSnapshot (budget, label = 'budget') {
  exactObject(budget, BUDGET_AXES, label)
  if (![1, 3, 6].includes(budget.maxTurns)) throw budgetError(`${label}.maxTurns is invalid`)
  positiveInteger(budget.maxRequestInputTokens, `${label}.maxRequestInputTokens`)
  if (budget.maxRequestInputTokens > LIMITS.maxCumulativeInputTokens) throw budgetError(`${label}.maxRequestInputTokens exceeds policy`)
  if (budget.maxCumulativeInputTokens !== LIMITS.maxCumulativeInputTokens) throw budgetError(`${label}.maxCumulativeInputTokens diverges from policy`)
  positiveInteger(budget.maxCumulativeOutputTokens, `${label}.maxCumulativeOutputTokens`)
  if (budget.maxCumulativeOutputTokens > LIMITS.maxCumulativeOutputTokens) throw budgetError(`${label}.maxCumulativeOutputTokens exceeds policy`)
  if (![LIMITS.interactiveWallClockMs, LIMITS.automaticWallClockMs].includes(budget.maxWallClockMs)) throw budgetError(`${label}.maxWallClockMs diverges from policy`)
  if (budget.maxToolCalls !== LIMITS.maxToolCalls) throw budgetError(`${label}.maxToolCalls diverges from policy`)
  if (budget.toolTimeoutMs !== LIMITS.toolTimeoutMs) throw budgetError(`${label}.toolTimeoutMs diverges from policy`)
  if (budget.maxParallelTools !== LIMITS.maxParallelTools) throw budgetError(`${label}.maxParallelTools diverges from policy`)
  if (budget.maxToolResultBytes !== LIMITS.maxToolResultBytes) throw budgetError(`${label}.maxToolResultBytes diverges from policy`)
  if (budget.maxSourceTextBytes !== LIMITS.maxSourceTextBytes || budget.maxSourceTextBytes >= budget.maxToolResultBytes) {
    throw budgetError(`${label}.maxSourceTextBytes diverges from policy`)
  }
  return budget
}

function assertRecipeBudgetSnapshot (recipeId, recipeVersion, toolGrants, budget) {
  const recipe = getRecipe(recipeId, recipeVersion)
  if (!Array.isArray(toolGrants) || !sameArray(toolGrants, recipe.toolGrants)) {
    throw budgetError('tool grants do not match the registered recipe')
  }
  assertBudgetSnapshot(budget)
  if (budget.maxTurns !== recipe.maxTurns) throw budgetError('maxTurns does not match the registered recipe')
  return budget
}

function assertBudgetObservation (observation, label = 'observation') {
  exactObject(observation, [
    'turnCount',
    'requestInputTokens',
    'cumulativeBilledInputTokens',
    'cumulativeBilledOutputTokens',
    'wallClockMs',
    'toolCallCount',
    'activeToolCalls',
    'activeToolElapsedMs',
    'cumulativeToolResultBytes',
    'cumulativeSourceTextBytes'
  ], label)
  nonNegativeInteger(observation.turnCount, `${label}.turnCount`)
  nonNegativeInteger(observation.requestInputTokens, `${label}.requestInputTokens`)
  if ((observation.cumulativeBilledInputTokens === null) !== (observation.cumulativeBilledOutputTokens === null)) {
    throw budgetError(`${label}.billed token axes must both be known or unknown`)
  }
  if (observation.cumulativeBilledInputTokens !== null) {
    nonNegativeInteger(observation.cumulativeBilledInputTokens, `${label}.cumulativeBilledInputTokens`)
    nonNegativeInteger(observation.cumulativeBilledOutputTokens, `${label}.cumulativeBilledOutputTokens`)
  }
  nonNegativeInteger(observation.wallClockMs, `${label}.wallClockMs`)
  nonNegativeInteger(observation.toolCallCount, `${label}.toolCallCount`)
  nonNegativeInteger(observation.activeToolCalls, `${label}.activeToolCalls`)
  nonNegativeInteger(observation.activeToolElapsedMs, `${label}.activeToolElapsedMs`)
  nonNegativeInteger(observation.cumulativeToolResultBytes, `${label}.cumulativeToolResultBytes`)
  nonNegativeInteger(observation.cumulativeSourceTextBytes, `${label}.cumulativeSourceTextBytes`)
  return observation
}

function evaluateBudgetAxes (budget, observation) {
  assertBudgetSnapshot(budget)
  assertBudgetObservation(observation)
  const axisStates = {
    maxTurns: observation.turnCount >= budget.maxTurns ? 'exhausted' : 'within',
    maxRequestInputTokens: observation.requestInputTokens >= budget.maxRequestInputTokens ? 'exhausted' : 'within',
    maxCumulativeInputTokens: observation.cumulativeBilledInputTokens === null
      ? 'not_evaluated'
      : observation.cumulativeBilledInputTokens >= budget.maxCumulativeInputTokens ? 'exhausted' : 'within',
    maxCumulativeOutputTokens: observation.cumulativeBilledOutputTokens === null
      ? 'not_evaluated'
      : observation.cumulativeBilledOutputTokens >= budget.maxCumulativeOutputTokens ? 'exhausted' : 'within',
    maxWallClockMs: observation.wallClockMs >= budget.maxWallClockMs ? 'exhausted' : 'within',
    maxToolCalls: observation.toolCallCount >= budget.maxToolCalls ? 'exhausted' : 'within',
    toolTimeoutMs: observation.activeToolElapsedMs >= budget.toolTimeoutMs ? 'exhausted' : 'within',
    maxParallelTools: observation.activeToolCalls > budget.maxParallelTools ? 'exhausted' : 'within',
    maxToolResultBytes: observation.cumulativeToolResultBytes >= budget.maxToolResultBytes ? 'exhausted' : 'within',
    maxSourceTextBytes: observation.cumulativeSourceTextBytes >= budget.maxSourceTextBytes ? 'exhausted' : 'within'
  }
  const exhaustedAxes = BUDGET_AXES.filter((axis) => axisStates[axis] === 'exhausted')
  return Object.freeze({
    exhausted: exhaustedAxes.length > 0,
    taskErrorCode: exhaustedAxes.length > 0 ? BUDGET_EXCEEDED_ERROR_CODE : null,
    exhaustedAxes: Object.freeze(exhaustedAxes),
    axisStates: Object.freeze(axisStates)
  })
}

module.exports = Object.freeze({
  BUDGET_AXES,
  BUDGET_AXIS_STATES,
  BUDGET_EXCEEDED_ERROR_CODE,
  LIMITS,
  TOOL_PAYLOAD_LIMITS,
  assertBudgetObservation,
  assertBudgetSnapshot,
  assertRecipeBudgetSnapshot,
  deriveBudget,
  deriveRecipeBudget,
  evaluateBudgetAxes
})
