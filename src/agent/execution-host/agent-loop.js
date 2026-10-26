'use strict'

const { canonicalize } = require('../../runtime/storage-worker/canonical-json')
const { getRecipe, validateRecipeOutput, assertSummaryTopicIndex } = require('../contracts/recipes')
const { outputDirectiveFor, summaryStageDirective } = require('../contracts/recipe-output-directives')
const { outputInvalid } = require('../contracts/output-validation')
const { deriveRecipeRequestCapacity, usesModelWindowCapacity } = require('../contracts/budget-axes')
const { runLoopExchange, checkSignal } = require('./pi-loop-runtime')

function executionError (code) { return Object.assign(new Error(code), { code }) }

function shouldStopAfterTurn ({ maxTurns, turn, toolCalls = 0, maxToolCalls = Number.MAX_SAFE_INTEGER, budgetExceeded = false } = {}) {
  return budgetExceeded === true || toolCalls >= maxToolCalls || turn >= maxTurns
}

function validatedRequestCapacity (recipe, value, resolvedModel, summaryStage) {
  const windowed = usesModelWindowCapacity(recipe.recipeId, recipe.recipeVersion)
  if (value === undefined) {
    if (windowed) throw executionError('AGENT_REQUEST_INVALID')
    return undefined
  }
  if (!windowed || !value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'promptByteLimit,requestOutputTokens' ||
      !Number.isSafeInteger(value.requestOutputTokens) || value.requestOutputTokens < 1 ||
      !Number.isSafeInteger(value.promptByteLimit) || value.promptByteLimit < 0) throw executionError('AGENT_REQUEST_INVALID')
  if (recipe.recipeId === 'qa.answer' || recipe.recipeId === 'summary.minutes' && recipe.recipeVersion === '3') {
    const expected = deriveRecipeRequestCapacity({ ...recipe, capabilities: resolvedModel?.capabilities, budget: resolvedModel?.budget, binding: resolvedModel, summaryStage })
    if (canonicalize(expected) !== canonicalize(value)) throw executionError('AGENT_REQUEST_INVALID')
  }
  return value
}

class AgentLoopExecutor {
  constructor (options = {}) {
    if (!options.adapter || typeof options.adapter.exchange !== 'function') throw new TypeError('agent loop exchange is required')
    this.adapter = options.adapter
    this.onToolCall = typeof options.onToolCall === 'function' ? options.onToolCall : () => {}
  }

  async agentLoop (input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw executionError('AGENT_REQUEST_INVALID')
    const allowed = new Set(['recipeId', 'recipeVersion', 'prompt', 'resolvedModel', 'tools', 'signal', 'timeoutMs', 'budget',
      'usageReporting', 'onProgress', 'beforeRequest', 'requestCapacity', 'getRunUsage', 'onRequestUsage', 'retryPolicyVersion', 'summaryStage'])
    if (Object.keys(input).some(key => !allowed.has(key))) throw executionError('AGENT_REQUEST_INVALID')
    let recipe
    try { recipe = getRecipe(input.recipeId, input.recipeVersion) } catch { throw executionError('AGENT_REQUEST_INVALID') }
    const binding = input.resolvedModel
    if (!binding || typeof binding !== 'object' || Array.isArray(binding) ||
        (this.adapter.binding && canonicalize(binding) !== canonicalize(this.adapter.binding)) ||
        (binding.recipeId && (binding.recipeId !== recipe.recipeId || binding.recipeVersion !== recipe.recipeVersion))) throw executionError('AGENT_REQUEST_INVALID')
    const resolvedModel = JSON.parse(canonicalize(binding))
    const quality = recipe.recipeId === 'summary.minutes' && recipe.recipeVersion === '3'
    if (quality ? !['organizing_topics', 'drafting_minutes', 'verifying_sources'].includes(input.summaryStage) : input.summaryStage !== undefined) throw executionError('AGENT_REQUEST_INVALID')
    const requestCapacity = validatedRequestCapacity(recipe, input.requestCapacity, resolvedModel, input.summaryStage)
    if (typeof input.prompt !== 'string' || !input.prompt || /[\u0000-\u001f\u007f]/u.test(input.prompt) ||
        (usesModelWindowCapacity(recipe.recipeId, recipe.recipeVersion)
          ? Buffer.byteLength(input.prompt, 'utf8') > (quality ? 917504 : 256 * 1024) : input.prompt.length > 16000)) throw executionError('AGENT_REQUEST_INVALID')
    const tools = input.tools || []
    if (!Array.isArray(tools) || tools.some(tool => !tool || typeof tool.name !== 'string' || typeof tool.execute !== 'function') ||
        new Set(tools.map(tool => tool.name)).size !== tools.length) throw executionError('AGENT_REQUEST_INVALID')
    if (tools.some(tool => !recipe.toolGrants.includes(tool.name))) throw executionError('TOOL_NOT_AVAILABLE_FOR_RECIPE')
    for (const name of ['beforeRequest', 'getRunUsage', 'onRequestUsage']) {
      if (input[name] !== undefined && typeof input[name] !== 'function') throw executionError('AGENT_REQUEST_INVALID')
    }
    if (typeof input.beforeRequest !== 'function') throw executionError('AGENT_RUN_UNAVAILABLE')
    const budget = input.budget || resolvedModel.budget || {}
    if (resolvedModel.budget && canonicalize(budget) !== canonicalize(resolvedModel.budget)) throw executionError('AGENT_REQUEST_INVALID')
    const result = await runLoopExchange({
      exchange: this.adapter.exchange.bind(this.adapter), resolvedModel, recipe,
      requestStrategy: this.adapter.requestStrategy || 'openai-compatible@1',
      systemPrompt: (quality ? summaryStageDirective(input.summaryStage) : outputDirectiveFor(recipe)).systemPrompt, prompt: input.prompt,
      summaryStage: input.summaryStage,
      requestCapacity, tools: tools.map(tool => ({ ...tool, execute: async (...args) => {
        checkSignal(input.signal)
        const result = await tool.execute(...args)
        try { this.onToolCall(Object.freeze({ toolName: tool.name })) } catch {}
        return result
      } })),
      maxTurns: recipe.maxTurns, timeoutMs: input.timeoutMs || budget.maxWallClockMs,
      signal: input.signal, beforeRequest: input.beforeRequest, getRunUsage: input.getRunUsage,
      onRequestUsage: input.onRequestUsage, retryPolicyVersion: input.retryPolicyVersion,
      shouldStopAfterTurn: ({ turn, toolCalls }) => shouldStopAfterTurn({ maxTurns: recipe.maxTurns,
        turn, toolCalls, maxToolCalls: budget.maxToolCalls ?? Number.MAX_SAFE_INTEGER }),
      onProgress: event => {
        if (!['request_started', 'response_received', 'request_failed', 'retry_wait'].includes(event.type)) return
        const progress = event.type === 'retry_wait' ? { type: event.type, turn: event.turn, phase: 'retry_wait',
          requestAttempt: event.requestAttempt, nextAttempt: event.nextAttempt, reason: event.reason, waitMs: event.waitMs }
          : { type: event.type, turn: event.turn }
        try { Promise.resolve(input.onProgress?.(Object.freeze(progress))).catch(() => {}) } catch {}
      }
    })
    checkSignal(input.signal)
    let output
    try { output = JSON.parse(result.text) } catch { throw outputInvalid('json', 'output') }
    if (quality && input.summaryStage === 'organizing_topics') assertSummaryTopicIndex(output)
    else validateRecipeOutput(recipe.recipeId, recipe.recipeVersion, output)
    return { recipeId: recipe.recipeId, recipeVersion: recipe.recipeVersion, maxTurns: recipe.maxTurns,
      toolGrants: [...recipe.toolGrants], text: result.text, usage: result.usage }
  }
}

module.exports = { AgentLoopExecutor, shouldStopAfterTurn }
