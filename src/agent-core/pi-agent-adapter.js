'use strict'

const { AgentCoreError } = require('./errors')

function publicEvent (event) {
  if (['agent_start', 'agent_end', 'turn_start', 'turn_end'].includes(event.type)) return { type: event.type }
  if (event.type.startsWith('tool_execution_')) return { type: event.type, toolName: event.toolName, isError: event.isError === true }
  if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
    return { type: 'text_delta', delta: event.assistantMessageEvent.delta }
  }
  return null
}

function assistantText (messages) {
  const assistant = [...messages].reverse().find((message) => message.role === 'assistant')
  if (!assistant) throw new AgentCoreError('AGENT_OUTPUT_INVALID')
  return assistant.content.filter((part) => part.type === 'text').map((part) => part.text).join('')
}

class PiAgentAdapter {
  async run ({ resolvedModel, systemPrompt, prompt, tools = [], maxTurns = 2, timeoutMs = 30000, signal, onEvent = () => {} }) {
    const { Agent } = await import('@earendil-works/pi-agent-core')
    let turns = 0
    const agent = new Agent({
      streamFn: resolvedModel.streamFn,
      getApiKey: () => resolvedModel.apiKey,
      initialState: { model: resolvedModel.model, systemPrompt, thinkingLevel: 'off', tools, messages: [] },
      toolExecution: 'sequential',
      shouldStopAfterTurn: () => ++turns >= maxTurns
    })
    const unsubscribe = agent.subscribe((event) => {
      const projected = publicEvent(event)
      if (projected) onEvent(projected)
    })
    const abort = () => agent.abort()
    signal?.addEventListener('abort', abort, { once: true })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; abort() }, timeoutMs)
    try {
      await agent.prompt(prompt)
      await agent.waitForIdle()
      if (signal?.aborted) throw new AgentCoreError('AGENT_CANCELLED')
      if (timedOut) throw new AgentCoreError('AGENT_PROVIDER_TIMEOUT', { retryable: true })
      if (agent.state.errorMessage) throw new AgentCoreError('AGENT_PROVIDER_UNAVAILABLE', { retryable: true })
      return { text: assistantText(agent.state.messages) }
    } catch (error) {
      if (signal?.aborted) throw new AgentCoreError('AGENT_CANCELLED')
      if (timedOut) throw new AgentCoreError('AGENT_PROVIDER_TIMEOUT', { retryable: true })
      if (error instanceof AgentCoreError) throw error
      const message = String(error?.message || '')
      if (/401|403|api.?key|auth/i.test(message)) throw new AgentCoreError('AGENT_PROVIDER_AUTH_FAILED')
      if (/408|timeout/i.test(message)) throw new AgentCoreError('AGENT_PROVIDER_TIMEOUT', { retryable: true })
      if (/429|rate.?limit/i.test(message)) throw new AgentCoreError('AGENT_PROVIDER_RATE_LIMITED', { retryable: true })
      throw new AgentCoreError('AGENT_PROVIDER_UNAVAILABLE', { retryable: true })
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      unsubscribe()
    }
  }
}

module.exports = { PiAgentAdapter, assistantText, publicEvent }
