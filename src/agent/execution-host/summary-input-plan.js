'use strict'

const { canonicalize, sha256Canonical } = require('../../runtime/storage-worker/canonical-json')

const RAW_TEXT_LIMIT = 4 * 1024 * 1024
const CANONICAL_LIMIT = 8 * 1024 * 1024
const PROMPT_LIMIT = 256 * 1024
const MAX_SEGMENTS = 50000
const MAX_LEAVES = 256
const MAX_NODES = 384
const INTERMEDIATE_LIMIT = 8 * 1024
const ENVELOPE_RESERVE = 8 * 1024
const SUMMARY_POLICY = Object.freeze({ policyVersion: 'summary-long-input@1', key: 'summaryPlan', version: 2,
  instruction: '完整处理本块，保留决定、否定、修订与待办，引用只限本块来源；返回规定JSON，结果不超过8192 UTF-8字节。' })
const QUESTION_POLICY = Object.freeze({ policyVersion: 'qa-long-input@1', key: 'questionPlan', version: 1,
  instruction: '围绕userPrompt完整读取本块，只回答本块有证据支持的部分，保留否定、较晚修订与待确认事项；信息不足写入unresolved，不得声称本块代表整场会话。字幕引用只限本块来源；返回QaAnswerV1 JSON，结果不超过8192 UTF-8字节。' })
const EXPERIENCE_POLICY = Object.freeze({ policyVersion: 'experience-input@1', key: 'experienceRange', version: 1,
  instruction: '提炼此范围的独立会话经历，保留明确实体、数字、日期、否定、修订和来源。返回ContextIngestV3 range产品，不输出覆盖计数。' })

function fail (code = 'AGENT_BUDGET_EXCEEDED', metrics) {
  const error = new Error(code)
  error.code = code
  if (metrics) error.diagnosticMetrics = metrics
  throw error
}

function bytes (value) { return Buffer.byteLength(value, 'utf8') }
function wireBytes (value) { return bytes(JSON.stringify(value)) }

function sourceIdentity (input) {
  return {
    sessionId: input.sessionId,
    transcriptVersion: input.transcriptVersion,
    inputWatermark: input.inputWatermark,
    inputDigest: input.inputDigest
  }
}

function capacityFailure (policy, actual, limit, unit = 'bytes') {
  fail(policy === QUESTION_POLICY ? 'AGENT_QA_INPUT_LIMIT_EXCEEDED' : 'AGENT_BUDGET_EXCEEDED',
    policy === QUESTION_POLICY ? { actual, limit: Math.max(0, limit), unit } : undefined)
}

function requestPromptLimit (binding, policy = SUMMARY_POLICY) {
  const capabilities = binding?.capabilities
  const budget = binding?.budget
  if (!Number.isSafeInteger(capabilities?.maxInputTokens) ||
      !Number.isSafeInteger(capabilities?.maxOutputTokens) ||
      !Number.isSafeInteger(budget?.maxRequestInputTokens)) fail('AGENT_REQUEST_INVALID')
  // With no registered tokenizer, UTF-8 bytes are a conservative input unit.
  // Leave room for the HTTP/recipe/tool envelope and the model's output.
  const limit = Math.min(PROMPT_LIMIT, capabilities.maxInputTokens, budget.maxRequestInputTokens) - ENVELOPE_RESERVE
  if (limit < 1024) capacityFailure(policy, 1024, limit)
  return limit
}

function promptPayload (input, userPrompt, parts, policy) {
  return {
    userPrompt,
    [policy.key]: {
      version: policy.version,
      stage: 'leaf',
      instruction: policy.instruction,
      source: sourceIdentity(input),
      parts,
      ...(policy === EXPERIENCE_POLICY ? { confirmedMemories: input.confirmedMemories || [] } : {})
    }
  }
}

function serializePrompt (payload, limit, policy) {
  const prompt = canonicalize(payload)
  if (wireBytes(prompt) > limit) capacityFailure(policy, wireBytes(prompt), limit)
  return prompt
}

function mergeGroupSizes (count, fanIn = 4) {
  if (!Number.isSafeInteger(count) || count < 1) fail('AGENT_REQUEST_INVALID')
  if (count === 1) return []
  const sizes = []
  let remaining = count
  while (remaining > 0) {
    if (remaining <= fanIn) { sizes.push(remaining); break }
    if (remaining === fanIn + 1 && fanIn > 2) { sizes.push(fanIn - 1, 2); break }
    sizes.push(fanIn)
    remaining -= fanIn
  }
  return sizes
}

function mergeShape (leafCount, fanIn, policy) {
  const levels = []
  let current = leafCount
  let nodeCount = leafCount
  while (current > 1) {
    const sizes = mergeGroupSizes(current, fanIn)
    levels.push(sizes)
    current = sizes.length
    nodeCount += current
    if (nodeCount > MAX_NODES) capacityFailure(policy, nodeCount, MAX_NODES, 'count')
  }
  return { levels, nodeCount }
}

function assertPlanCoverage (input, plan, policy) {
  let eventIndex = 0
  let offset = 0
  let reconstructed = ''
  for (const leaf of plan.leaves) {
    const payload = JSON.parse(leaf.prompt)[policy.key]
    if (payload.version !== policy.version || payload.stage !== 'leaf' ||
        canonicalize(payload.source) !== canonicalize(sourceIdentity(input)) ||
        !Array.isArray(payload.parts) || payload.parts.length === 0 ||
        leaf.fromEventOrder !== payload.parts[0].eventOrder ||
        leaf.throughEventOrder !== payload.parts.at(-1).eventOrder) fail('AGENT_INTERNAL_FAILURE')
    for (const part of payload.parts) {
      const current = input.events[eventIndex]
      if (!current || part.eventOrder !== current.eventOrder || part.segmentId !== current.segmentId ||
          part.codePointStart !== offset || typeof part.text !== 'string') fail('AGENT_INTERNAL_FAILURE')
      const count = Array.from(part.text).length
      if (part.codePointEnd !== offset + count) fail('AGENT_INTERNAL_FAILURE')
      reconstructed += part.text
      offset = part.codePointEnd
      if (reconstructed === current.text) {
        eventIndex += 1
        offset = 0
        reconstructed = ''
      } else if (!current.text.startsWith(reconstructed)) {
        fail('AGENT_INTERNAL_FAILURE')
      }
    }
  }
  if (eventIndex !== input.events.length || offset !== 0 || reconstructed !== '') fail('AGENT_INTERNAL_FAILURE')
  return true
}

function * planInputSteps (input, userPrompt, binding, policy) {
  if (!input || input.sourceKind !== 'session' || input.transcriptVersion !== 'raw' ||
      !Array.isArray(input.events) || input.events.length === 0 ||
      typeof userPrompt !== 'string' || userPrompt.length === 0 ||
      !/^[0-9a-f]{64}$/.test(input.inputDigest || '')) fail('AGENT_REQUEST_INVALID')
  if (input.events.length > MAX_SEGMENTS) capacityFailure(policy, input.events.length, MAX_SEGMENTS, 'count')
  const canonicalBytes = bytes(canonicalize(input.events))
  if (canonicalBytes > CANONICAL_LIMIT) capacityFailure(policy, canonicalBytes, CANONICAL_LIMIT)
  let work = 0
  let rawTextBytes = 0
  const promptLimit = requestPromptLimit(binding, policy)
  const baseBytes = wireBytes(canonicalize(promptPayload(input, userPrompt, [], policy)))
  if (baseBytes + 1024 >= promptLimit) capacityFailure(policy, baseBytes + 1024, promptLimit)
  const leaves = []
  let parts = []
  let partBytes = baseBytes
  let partStart = 0
  let priorEventOrder = 0

  const flush = () => {
    if (parts.length === 0) return
    const prompt = serializePrompt(promptPayload(input, userPrompt, parts, policy), promptLimit, policy)
    const first = parts[0]
    const last = parts[parts.length - 1]
    leaves.push({
      prompt,
      digest: sha256Canonical(prompt),
      fromEventOrder: first.eventOrder,
      throughEventOrder: last.eventOrder,
      startCodePoint: first.codePointStart,
      endCodePoint: last.codePointEnd,
      partCount: parts.length
    })
    if (leaves.length > MAX_LEAVES) capacityFailure(policy, leaves.length, MAX_LEAVES, 'count')
    parts = []
    partBytes = baseBytes
  }

  const add = (part) => {
    const size = (wireBytes(canonicalize(part)) - 2) + (parts.length > 0 ? 1 : 0)
    if (partBytes + size > promptLimit || (policy === EXPERIENCE_POLICY && parts.length >= 500)) flush()
    if (partBytes + size > promptLimit) capacityFailure(policy, partBytes + size, promptLimit)
    parts.push(part)
    partBytes += size
  }

  for (const event of input.events) {
    if (!Number.isSafeInteger(event?.eventOrder) || event.eventOrder < 1 ||
        event.eventOrder <= priorEventOrder || typeof event.segmentId !== 'string' ||
        typeof event.text !== 'string') fail('AGENT_REQUEST_INVALID')
    if (++work % 128 === 0) yield
    priorEventOrder = event.eventOrder
    rawTextBytes += bytes(event.text)
    if (rawTextBytes > RAW_TEXT_LIMIT) capacityFailure(policy, rawTextBytes, RAW_TEXT_LIMIT)
    // Iterate Unicode code points, so a split never separates a surrogate pair.
    let text = ''
    let offset = 0
    let escapedBytes = 0
    for (const codePoint of event.text) {
      if (++work % 4096 === 0) yield
      const nextBytes = wireBytes(JSON.stringify(codePoint).slice(1, -1)) - 2
      if (escapedBytes + nextBytes + 1024 > promptLimit - baseBytes && text.length > 0) {
        add({ eventOrder: event.eventOrder, segmentId: event.segmentId,
          codePointStart: partStart, codePointEnd: offset, text })
        text = ''
        escapedBytes = 0
        partStart = offset
      }
      text += codePoint
      escapedBytes += nextBytes
      offset += 1
    }
    if (text.length > 0 || event.text.length === 0) add({ eventOrder: event.eventOrder, segmentId: event.segmentId,
      codePointStart: partStart, codePointEnd: offset, text })
    partStart = 0
  }
  if (rawTextBytes === 0 || priorEventOrder !== input.inputWatermark) fail('AGENT_INPUT_EMPTY')
  flush()
  const fanIn = Math.min(4, Math.floor((promptLimit - 4096 - wireBytes(userPrompt)) / (2 * INTERMEDIATE_LIMIT)))
  if (policy !== EXPERIENCE_POLICY && leaves.length > 1 && fanIn < 2) capacityFailure(policy, 4096 + wireBytes(userPrompt) + 4 * INTERMEDIATE_LIMIT, promptLimit)
  const { levels, nodeCount } = policy === EXPERIENCE_POLICY ? { levels: [], nodeCount: leaves.length } : mergeShape(leaves.length, fanIn, policy)

  const bindingDigest = sha256Canonical(binding)
  const planDigest = sha256Canonical({
    policyVersion: policy.policyVersion, inputDigest: input.inputDigest,
    bindingDigest, promptDigest: sha256Canonical(userPrompt),
    leaves: leaves.map(({ digest, fromEventOrder, throughEventOrder, startCodePoint, endCodePoint, partCount }) =>
      ({ digest, fromEventOrder, throughEventOrder, startCodePoint, endCodePoint, partCount })),
    levels
  })
  const plan = {
    policyVersion: policy.policyVersion, inputDigest: input.inputDigest,
    bindingDigest, planDigest, promptLimit, userPrompt, leaves, levels, nodeCount,
    segmentCount: input.events.length, rawTextBytes, canonicalBytes
  }
  assertPlanCoverage(input, plan, policy)
  return plan
}

function planSummaryInput (input, userPrompt, binding) {
  const steps = planInputSteps(input, userPrompt, binding, SUMMARY_POLICY)
  let step
  do { step = steps.next() } while (!step.done)
  return step.value
}
async function planSummaryInputAsync (input, userPrompt, binding, signal) {
  return planInputAsync(input, userPrompt, binding, signal, SUMMARY_POLICY)
}
async function planQuestionInputAsync (input, userPrompt, binding, signal) {
  return planInputAsync(input, userPrompt, binding, signal, QUESTION_POLICY)
}
async function planExperienceInputAsync (input, binding, signal) {
  return planInputAsync(input, '整理本范围的会话经历，保留可追溯的事件来源。', binding, signal, EXPERIENCE_POLICY)
}
async function planInputAsync (input, userPrompt, binding, signal, policy) {
  const steps = planInputSteps(input, userPrompt, binding, policy)
  for (;;) {
    if (signal?.aborted) fail('AGENT_CANCELLED')
    const step = steps.next()
    if (step.done) return step.value
    await new Promise(resolve => setImmediate(resolve))
  }
}
function assertSummaryPlanCoverage (input, plan) { return assertPlanCoverage(input, plan, SUMMARY_POLICY) }
function assertQuestionPlanCoverage (input, plan) { return assertPlanCoverage(input, plan, QUESTION_POLICY) }
module.exports = { planSummaryInputAsync, planQuestionInputAsync, planExperienceInputAsync, INTERMEDIATE_LIMIT, assertSummaryPlanCoverage,
  assertQuestionPlanCoverage, mergeGroupSizes, planSummaryInput, requestPromptLimit }
