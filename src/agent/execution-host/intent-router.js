'use strict'

// @ts-check

const { getRecipe, RECIPE_IDS, validateRecipeOutput } = require('../contracts/recipes')

const TARGET_RECIPE_IDS = Object.freeze(RECIPE_IDS.filter((recipeId) => recipeId !== 'intent.route'))
const FALLBACK_ERROR_CODES = new Set([
  'AGENT_OUTPUT_INVALID', 'AGENT_BUDGET_EXCEEDED', 'AGENT_WORKER_EXITED', 'AGENT_INTERNAL_FAILURE'
])

function requestError (code, message) {
  const error = new TypeError(`${code}: ${message}`)
  error.code = code
  return error
}

function record (value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw requestError('AGENT_REQUEST_INVALID', `${label} must be an object`)
  }
}

function exact (value, keys, label) {
  record(value, label)
  const expected = [...keys].sort()
  const actual = Object.keys(value).sort()
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw requestError('AGENT_REQUEST_INVALID', `${label} has non-exact keys`)
  }
}

function identifier (value, label) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw requestError('AGENT_REQUEST_INVALID', `${label} is invalid`)
  }
  return value
}

function validateInput (input) {
  exact(input, ['scope', 'prompt'], 'route input')
  exact(input.scope, ['kind', 'reference'], 'route scope')
  if (!['selection', 'session', 'date_range', 'project'].includes(input.scope.kind)) {
    throw requestError('AGENT_REQUEST_INVALID', 'route scope kind is invalid')
  }
  identifier(input.scope.reference, 'route scope reference')
  if (typeof input.prompt !== 'string' || input.prompt.length < 1 || input.prompt.length > 16000 ||
      /[\u0000-\u001f\u007f]/u.test(input.prompt)) {
    throw requestError('AGENT_REQUEST_INVALID', 'route prompt is invalid')
  }
  return {
    scope: { kind: input.scope.kind, reference: input.scope.reference },
    prompt: input.prompt
  }
}

function normalizedPrompt (prompt) {
  return prompt.normalize('NFKC').toLocaleLowerCase('und').replace(/\s+/gu, ' ').trim()
}

const RULES = Object.freeze([
  Object.freeze({ recipeId: 'text.translate', scopes: ['selection', 'session'], patterns: [
    /翻译/u, /译成/u, /英文/u, /中文/u, /日文/u, /韩文/u, /translate/u, /translation/u
  ] }),
  Object.freeze({ recipeId: 'text.rewrite', scopes: ['selection'], patterns: [
    /改写/u, /重写/u, /润色/u, /改得正式/u, /rewrite/u, /rephrase/u, /formal/u, /casual/u, /bulleted/u
  ] }),
  Object.freeze({ recipeId: 'text.enhance', scopes: ['session'], patterns: [
    /增强/u, /优化表达/u, /提升表达/u, /enhance/u, /polish/u
  ] }),
  Object.freeze({ recipeId: 'extract.items', scopes: ['selection', 'session'], patterns: [
    /提取/u, /待办/u, /行动项/u, /风险/u, /事项/u, /extract/u, /todo/u, /action item/u
  ] }),
  Object.freeze({ recipeId: 'summary.minutes', scopes: ['session'], patterns: [
    /纪要/u, /会议总结/u, /会议摘要/u, /总结/u, /摘要/u, /minutes/u, /summary/u
  ] }),
  Object.freeze({ recipeId: 'report.analysis', scopes: ['selection', 'session', 'date_range', 'project'], patterns: [
    /分析/u, /洞察/u, /分析报告/u, /analysis/u, /report/u, /insight/u
  ] }),
  Object.freeze({ recipeId: 'plan.proposal', scopes: ['selection', 'session', 'date_range', 'project'], patterns: [
    /计划/u, /规划/u, /方案/u, /建议/u, /路线图/u, /plan/u, /roadmap/u, /proposal/u
  ] })
])

function deterministicRoute (input) {
  const { scope, prompt } = validateInput(input)
  const text = normalizedPrompt(prompt)
  for (const rule of RULES) {
    if (rule.scopes.includes(scope.kind) && rule.patterns.some((pattern) => pattern.test(text))) {
      return { recipeId: rule.recipeId, routingMode: 'rules' }
    }
  }
  return { recipeId: 'qa.answer', routingMode: 'rules' }
}

function routeTarget (result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null
  try {
    validateRecipeOutput('intent.route', '1', result)
    return TARGET_RECIPE_IDS.includes(result.recipeId) ? result.recipeId : null
  } catch {
    return null
  }
}

function isRouteFallback ({ eligibility, error, result } = {}) {
  if (eligibility !== 'ready') return true
  if (error?.code && (error.code.startsWith('AGENT_PROVIDER_') || FALLBACK_ERROR_CODES.has(error.code))) return true
  if (error) return false
  return routeTarget(result) === null
}

function assertTargetRecipe (recipeId) {
  try { getRecipe(recipeId, '1') } catch { throw requestError('AGENT_REQUEST_INVALID', 'route target is not registered') }
  if (!TARGET_RECIPE_IDS.includes(recipeId)) throw requestError('AGENT_REQUEST_INVALID', 'route target is not registered')
  return recipeId
}

module.exports = {
  FALLBACK_ERROR_CODES: Object.freeze([...FALLBACK_ERROR_CODES]),
  RULES,
  TARGET_RECIPE_IDS,
  assertTargetRecipe,
  deterministicRoute,
  isRouteFallback,
  routeTarget,
  validateInput
}
