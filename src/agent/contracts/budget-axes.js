'use strict'

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

function deriveBudget (capabilities, executionForm, requestedBy) {
  if (!capabilities || !Number.isSafeInteger(capabilities.maxInputTokens) || capabilities.maxInputTokens < 1 ||
      !Number.isSafeInteger(capabilities.maxOutputTokens) || capabilities.maxOutputTokens < 1) {
    throw new TypeError('model capabilities are required')
  }
  if (!['single_shot', 'agent_loop'].includes(executionForm)) throw new TypeError('execution form is invalid')
  if (!['automatic', 'user'].includes(requestedBy)) throw new TypeError('requestedBy is invalid')
  return Object.freeze({
    maxTurns: executionForm === 'agent_loop' ? 6 : 1,
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

module.exports = { BUDGET_AXES, LIMITS, deriveBudget }
