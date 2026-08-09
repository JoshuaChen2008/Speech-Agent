'use strict'

const { AgentCoreError } = require('./errors')

function referenceOutput (value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'bullets,title' ||
      typeof value.title !== 'string' || value.title.length < 1 || value.title.length > 240 ||
      !Array.isArray(value.bullets) || value.bullets.length < 1 || value.bullets.length > 12 ||
      value.bullets.some((item) => typeof item !== 'string' || item.length < 1 || item.length > 500)) {
    throw new AgentCoreError('AGENT_OUTPUT_INVALID')
  }
  return Object.freeze({ title: value.title, bullets: Object.freeze([...value.bullets]) })
}

function parseReferenceOutput (text) {
  if (typeof text !== 'string' || text.length > 20000) throw new AgentCoreError('AGENT_OUTPUT_INVALID')
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  try { return referenceOutput(JSON.parse(fenced ? fenced[1] : text)) } catch (error) {
    if (error instanceof AgentCoreError) throw error
    throw new AgentCoreError('AGENT_OUTPUT_INVALID')
  }
}

module.exports = { parseReferenceOutput, referenceOutput }
