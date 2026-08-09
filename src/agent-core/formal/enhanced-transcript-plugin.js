'use strict'

const { AgentCoreError } = require('../errors')
const { assertMergeBudget, largestMergeBatch, mergeInput } = require('./bounded-merge')
const {
  canonicalBytes,
  enhancedTranscriptArtifact,
  throwIfAborted
} = require('./contracts')

function eventOrdersForSegments (segments) {
  return new Set(segments.map((segment) => segment.eventOrder))
}

function assertEvidenceCoverage (artifact, eventOrders) {
  const ranges = artifact.content.paragraphs.flatMap((paragraph) => paragraph.evidence)
  for (const eventOrder of eventOrders) {
    if (!ranges.some((range) => range.fromEventOrder <= eventOrder && range.throughEventOrder >= eventOrder)) {
      throw new AgentCoreError('AGENT_OUTPUT_INVALID')
    }
  }
}

function eventOrdersForArtifacts (artifacts, allEventOrders) {
  const ranges = artifacts.flatMap((artifact) => artifact.content.paragraphs)
    .flatMap((paragraph) => paragraph.evidence)
  return new Set([...allEventOrders].filter((eventOrder) =>
    ranges.some((range) => range.fromEventOrder <= eventOrder && range.throughEventOrder >= eventOrder)
  ))
}

function checkedArtifact (value, validEventOrders, maxResultBytes) {
  const artifact = enhancedTranscriptArtifact(value, { validEventOrders })
  if (canonicalBytes(artifact, 'AGENT_OUTPUT_INVALID') > maxResultBytes) {
    throw new AgentCoreError('AGENT_OUTPUT_INVALID')
  }
  assertEvidenceCoverage(artifact, validEventOrders)
  return artifact
}

class EnhancedTranscriptPlugin {
  async generate ({ plan, limits, invokeModel, signal }) {
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
      const output = await invokeModel('enhanced-transcript.chunk', input, signal)
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
        if (current.length - index === 1) {
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
        const output = await invokeModel(
          'enhanced-transcript.merge',
          mergeInput(plan.inputRef, level, batch),
          signal
        )
        throwIfAborted(signal)
        next.push(checkedArtifact(
          output,
          eventOrdersForArtifacts(batch, allEventOrders),
          limits.maxResultBytes
        ))
        index += batch.length
      }
      current = next
      level += 1
    }
    if (current.length !== 1) throw new AgentCoreError('AGENT_INTERNAL_FAILURE')
    return checkedArtifact(current[0], allEventOrders, limits.maxResultBytes)
  }
}

module.exports = {
  EnhancedTranscriptPlugin,
  assertEvidenceCoverage,
  checkedArtifact,
  eventOrdersForArtifacts
}
