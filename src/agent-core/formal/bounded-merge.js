'use strict'

const { AgentCoreError } = require('../errors')
const { canonicalBytes } = require('./contracts')

function mergeInput (inputRef, level, candidates) {
  return { inputRef, level, candidates }
}

function largestMergeBatch (inputRef, level, candidates, from, maxInputBytes) {
  let through = from
  while (through < candidates.length) {
    const next = candidates.slice(from, through + 1)
    if (canonicalBytes(mergeInput(inputRef, level, next)) > maxInputBytes) break
    through += 1
  }
  return candidates.slice(from, through)
}

function assertMergeBudget (inputRef, chunkCount, limits) {
  if (chunkCount < 2) return
  const emptyEnvelopeBytes = canonicalBytes(mergeInput(inputRef, Number.MAX_SAFE_INTEGER, []))
  const conservativePairBytes = emptyEnvelopeBytes + (2 * limits.maxResultBytes) + 1
  if (conservativePairBytes > limits.maxChunkInputBytes) {
    throw new AgentCoreError('AGENT_REQUEST_INVALID')
  }
}

module.exports = { assertMergeBudget, largestMergeBatch, mergeInput }
