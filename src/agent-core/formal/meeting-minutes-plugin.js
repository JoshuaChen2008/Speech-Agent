'use strict'

const { AgentCoreError } = require('../errors')
const {
  canonicalBytes,
  meetingMinutesArtifact,
  throwIfAborted
} = require('./contracts')

function eventOrdersForSegments (segments) {
  return new Set(segments.map((segment) => segment.eventOrder))
}

function checkedArtifact (value, validEventOrders, maxResultBytes) {
  const artifact = meetingMinutesArtifact(value, {
    validEventOrders,
    /* 首版字幕快照没有说话人身份事实，因此不能接受模型归因负责人。 */
    identityEvidenceAvailable: false
  })
  if (canonicalBytes(artifact, 'AGENT_OUTPUT_INVALID') > maxResultBytes) {
    throw new AgentCoreError('AGENT_OUTPUT_INVALID')
  }
  return artifact
}

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

class MeetingMinutesPlugin {
  async generate ({ job, plan, limits, invokeModel, signal }) {
    assertMergeBudget(plan.inputRef, plan.chunks.length, limits)
    const allEventOrders = new Set(plan.chunks.flatMap((chunk) =>
      chunk.segments.map((segment) => segment.eventOrder)
    ))
    const candidates = []
    for (const chunk of plan.chunks) {
      throwIfAborted(signal)
      const input = {
        chunkIndex: chunk.chunkIndex,
        chunkCount: chunk.chunkCount,
        inputRef: plan.inputRef,
        segments: chunk.segments
      }
      if (canonicalBytes(input) > limits.maxChunkInputBytes) {
        throw new AgentCoreError('AGENT_REQUEST_INVALID')
      }
      const output = await invokeModel('meeting-minutes.chunk', input, signal)
      throwIfAborted(signal)
      candidates.push(checkedArtifact(
        output,
        eventOrdersForSegments(chunk.segments),
        limits.maxResultBytes
      ))
    }

    let level = 0
    let current = candidates
    while (current.length > 1) {
      const next = []
      for (let index = 0; index < current.length;) {
        const remaining = current.length - index
        if (remaining === 1) {
          next.push(current[index])
          index += 1
          continue
        }
        const batch = largestMergeBatch(
          plan.inputRef,
          level,
          current,
          index,
          limits.maxChunkInputBytes
        )
        if (batch.length < 2) throw new AgentCoreError('AGENT_REQUEST_INVALID')
        const input = mergeInput(plan.inputRef, level, batch)
        throwIfAborted(signal)
        const output = await invokeModel('meeting-minutes.merge', input, signal)
        throwIfAborted(signal)
        next.push(checkedArtifact(output, allEventOrders, limits.maxResultBytes))
        index += batch.length
      }
      current = next
      level += 1
    }
    if (current.length !== 1) throw new AgentCoreError('AGENT_INTERNAL_FAILURE')
    return checkedArtifact(current[0], allEventOrders, limits.maxResultBytes)
  }
}

module.exports = { MeetingMinutesPlugin, assertMergeBudget, largestMergeBatch, mergeInput }
