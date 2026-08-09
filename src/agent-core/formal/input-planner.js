'use strict'

const { AgentCoreError } = require('../errors')
const {
  canonicalBytes,
  providerLimits,
  transcriptSnapshot
} = require('./contracts')

function fragment (item, codePoints, fromCodePoint, throughCodePoint) {
  return {
    eventOrder: item.eventOrder,
    t0Ms: item.t0Ms,
    t1Ms: item.t1Ms,
    fromCodePoint,
    throughCodePoint,
    text: codePoints.slice(fromCodePoint, throughCodePoint).join('')
  }
}

function chunkEnvelope (inputRef, segments) {
  return {
    chunkIndex: Number.MAX_SAFE_INTEGER,
    chunkCount: Number.MAX_SAFE_INTEGER,
    inputRef,
    segments
  }
}

function fits (inputRef, segments, limit) {
  return canonicalBytes(chunkEnvelope(inputRef, segments)) <= limit
}

function largestFittingEnd (inputRef, item, codePoints, fromCodePoint, limit) {
  let low = fromCodePoint + 1
  let high = codePoints.length
  let best = fromCodePoint
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (fits(inputRef, [fragment(item, codePoints, fromCodePoint, middle)], limit)) {
      best = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

function assertCoverage (snapshot, chunks) {
  const pieces = new Map(snapshot.items.map((item) => [item.eventOrder, []]))
  for (const chunk of chunks) {
    for (const part of chunk.segments) pieces.get(part.eventOrder)?.push(part)
  }
  for (const item of snapshot.items) {
    const expected = Array.from(item.text)
    const actual = pieces.get(item.eventOrder)
    if (!actual || actual.length < 1) throw new AgentCoreError('AGENT_INTERNAL_FAILURE')
    let cursor = 0
    const rebuilt = []
    for (const part of actual) {
      if (part.fromCodePoint !== cursor || part.throughCodePoint <= part.fromCodePoint) {
        throw new AgentCoreError('AGENT_INTERNAL_FAILURE')
      }
      rebuilt.push(...Array.from(part.text))
      cursor = part.throughCodePoint
    }
    if (cursor !== expected.length || rebuilt.length !== expected.length ||
        rebuilt.some((value, index) => value !== expected[index])) {
      throw new AgentCoreError('AGENT_INTERNAL_FAILURE')
    }
  }
}

class AgentInputPlanner {
  plan (value, rawLimits) {
    const snapshot = transcriptSnapshot(value)
    const limits = providerLimits(rawLimits)
    const chunks = []
    let current = []
    const flush = () => {
      if (current.length > 0) chunks.push({ segments: current })
      current = []
    }

    for (const item of snapshot.items) {
      const codePoints = Array.from(item.text)
      const whole = fragment(item, codePoints, 0, codePoints.length)
      if (fits(snapshot.inputRef, [...current, whole], limits.maxChunkInputBytes)) {
        current.push(whole)
        continue
      }
      flush()
      if (fits(snapshot.inputRef, [whole], limits.maxChunkInputBytes)) {
        current.push(whole)
        continue
      }
      let fromCodePoint = 0
      while (fromCodePoint < codePoints.length) {
        const throughCodePoint = largestFittingEnd(
          snapshot.inputRef,
          item,
          codePoints,
          fromCodePoint,
          limits.maxChunkInputBytes
        )
        if (throughCodePoint === fromCodePoint) throw new AgentCoreError('AGENT_REQUEST_INVALID')
        current.push(fragment(item, codePoints, fromCodePoint, throughCodePoint))
        fromCodePoint = throughCodePoint
        if (fromCodePoint < codePoints.length) flush()
      }
    }
    flush()
    if (chunks.length < 1) throw new AgentCoreError('AGENT_INTERNAL_FAILURE')
    const planned = chunks.map((chunk, index) => ({
      chunkIndex: index,
      chunkCount: chunks.length,
      segments: chunk.segments
    }))
    assertCoverage(snapshot, planned)
    return {
      mode: planned.length === 1 ? 'single' : 'chunked',
      inputRef: snapshot.inputRef,
      chunks: planned
    }
  }
}

module.exports = { AgentInputPlanner, assertCoverage, chunkEnvelope }
