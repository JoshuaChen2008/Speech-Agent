'use strict'

// @ts-check

const { getRecipe } = require('../contracts/recipes')

const TOOL_ERROR_CODES = new Set([
  'TOOL_ARGS_INVALID', 'TOOL_SCOPE_DENIED', 'TOOL_NOT_AVAILABLE_FOR_RECIPE',
  'TOOL_BUDGET_EXCEEDED', 'TOOL_TIMEOUT', 'TOOL_CANCELLED', 'TOOL_INTERNAL_FAILURE'
])

function executionError (code) {
  const error = new Error(code)
  error.code = code
  return error
}

function shouldStopAfterTurn ({ maxTurns, turn, toolCalls = 0, maxToolCalls = Number.MAX_SAFE_INTEGER, budgetExceeded = false } = {}) {
  return budgetExceeded === true ||
    (Number.isSafeInteger(maxToolCalls) && toolCalls >= maxToolCalls) ||
    (Number.isSafeInteger(maxTurns) && Number.isSafeInteger(turn) && turn >= maxTurns)
}

function assertPrompt (value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 16000 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw executionError('AGENT_REQUEST_INVALID')
  }
  return value
}

class AgentLoopExecutor {
  constructor (options = {}) {
    if (options.adapter !== undefined && (!options.adapter || typeof options.adapter.run !== 'function')) {
      throw new TypeError('agent loop adapter is required')
    }
    this.adapter = options.adapter || null
    this.onToolCall = typeof options.onToolCall === 'function' ? options.onToolCall : () => {}
  }

  async resolveAdapter () {
    if (this.adapter) return this.adapter
    const { PiAgentAdapter } = require('../../agent-core/pi-agent-adapter')
    this.adapter = new PiAgentAdapter()
    return this.adapter
  }

  async agentLoop (input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw executionError('AGENT_REQUEST_INVALID')
    const allowedKeys = new Set(['recipeId', 'recipeVersion', 'prompt', 'resolvedModel', 'tools', 'signal', 'timeoutMs', 'budget', 'usageReporting'])
    if (Object.keys(input).some((key) => !allowedKeys.has(key))) throw executionError('AGENT_REQUEST_INVALID')
    let recipe
    try { recipe = getRecipe(input.recipeId, input.recipeVersion) } catch { throw executionError('AGENT_REQUEST_INVALID') }
    assertPrompt(input.prompt)
    if (!input.resolvedModel || typeof input.resolvedModel !== 'object' || Array.isArray(input.resolvedModel)) {
      throw executionError('AGENT_REQUEST_INVALID')
    }
    const tools = input.tools === undefined ? [] : input.tools
    if (!Array.isArray(tools) || tools.some((tool) => !tool || typeof tool !== 'object' ||
      typeof tool.name !== 'string' || typeof tool.execute !== 'function')) {
      throw executionError('AGENT_REQUEST_INVALID')
    }
    const toolNames = new Set()
    const wrappedTools = tools.map((tool) => {
      if (toolNames.has(tool.name)) throw executionError('AGENT_REQUEST_INVALID')
      toolNames.add(tool.name)
      if (!recipe.toolGrants.includes(tool.name)) throw executionError('TOOL_NOT_AVAILABLE_FOR_RECIPE')
      return {
        ...tool,
        execute: async (...args) => {
          if (input.signal?.aborted) throw executionError('AGENT_CANCELLED')
          let result
          try { result = await tool.execute(...args) } catch (error) {
            if (error?.code && TOOL_ERROR_CODES.has(error.code)) throw error
            throw error
          }
          try { this.onToolCall(Object.freeze({ toolName: tool.name })) } catch { /* observer isolation */ }
          return result
        }
      }
    })
    if (recipe.toolGrants.length === 0 && wrappedTools.length !== 0) throw executionError('TOOL_NOT_AVAILABLE_FOR_RECIPE')
    if (input.signal?.aborted) throw executionError('AGENT_CANCELLED')
    const budget = input.budget && typeof input.budget === 'object' ? input.budget : {}
    const adapter = await this.resolveAdapter()
    let result
    try {
      result = await adapter.run({
        resolvedModel: input.resolvedModel,
        recipe,
        systemPrompt: '',
        prompt: input.prompt,
        tools: wrappedTools,
        maxTurns: recipe.maxTurns,
        timeoutMs: Number.isSafeInteger(input.timeoutMs) && input.timeoutMs > 0 ? input.timeoutMs : budget.maxWallClockMs,
        signal: input.signal,
        shouldStopAfterTurn: ({ turn, toolCalls = 0, budgetExceeded = false } = {}) => shouldStopAfterTurn({
          maxTurns: recipe.maxTurns,
          turn,
          toolCalls,
          maxToolCalls: Number.isSafeInteger(budget.maxToolCalls) ? budget.maxToolCalls : Number.MAX_SAFE_INTEGER,
          budgetExceeded
        })
      })
    } catch (error) {
      if (input.signal?.aborted && error?.code !== 'AGENT_CANCELLED') throw executionError('AGENT_CANCELLED')
      throw error
    }
    if (!result || typeof result !== 'object' || Array.isArray(result) || typeof result.text !== 'string') {
      throw executionError('AGENT_OUTPUT_INVALID')
    }
    return {
      recipeId: recipe.recipeId,
      recipeVersion: recipe.recipeVersion,
      maxTurns: recipe.maxTurns,
      toolGrants: [...recipe.toolGrants],
      text: result.text,
      usage: result.usage === undefined ? null : result.usage
    }
  }
}

module.exports = { AgentLoopExecutor, shouldStopAfterTurn }
