'use strict'

const { canonicalize } = require('../canonical-json')
const { AgentCoreError } = require('../errors')

const RETRYABLE_ERROR_CODES = Object.freeze([
  'AGENT_PROVIDER_RATE_LIMITED',
  'AGENT_PROVIDER_TIMEOUT',
  'AGENT_PROVIDER_UNAVAILABLE',
  'AGENT_WORKER_EXITED'
])

const TERMINAL_ERROR_CODES = Object.freeze([
  'AGENT_PROVIDER_AUTH_FAILED',
  'AGENT_OUTPUT_INVALID',
  'AGENT_PERMISSION_DENIED',
  'AGENT_REQUEST_INVALID',
  'AGENT_INTERNAL_FAILURE'
])

const TASK_RECIPE_VERSIONS = Object.freeze({
  'meeting-minutes': 'meeting-minutes@1',
  'memory-extraction': 'memory-extraction@1',
  'enhanced-transcript': 'enhanced-transcript@1'
})

function exactObject (value, keys, code = 'AGENT_REQUEST_INVALID') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentCoreError(code)
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new AgentCoreError(code)
  }
  return value
}

function boundedString (value, min = 1, max = 160, code = 'AGENT_REQUEST_INVALID') {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw new AgentCoreError(code)
  return value
}

function inputReference (value) {
  exactObject(value, ['sessionId', 'inputWatermark', 'transcriptVersion', 'inputDigest'])
  const sessionId = boundedString(value.sessionId)
  if (!Number.isSafeInteger(value.inputWatermark) || value.inputWatermark < 1 ||
      !['original', 'refined'].includes(value.transcriptVersion) ||
      typeof value.inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.inputDigest)) {
    throw new AgentCoreError('AGENT_REQUEST_INVALID')
  }
  return {
    sessionId,
    inputWatermark: value.inputWatermark,
    transcriptVersion: value.transcriptVersion,
    inputDigest: value.inputDigest
  }
}

function sameInputReference (left, right) {
  return left.sessionId === right.sessionId &&
    left.inputWatermark === right.inputWatermark &&
    left.transcriptVersion === right.transcriptVersion &&
    left.inputDigest === right.inputDigest
}

function transcriptSnapshot (value) {
  exactObject(value, ['inputRef', 'items'])
  const inputRef = inputReference(value.inputRef)
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 100000) {
    throw new AgentCoreError('AGENT_REQUEST_INVALID')
  }
  let priorOrder = 0
  const items = value.items.map((item) => {
    exactObject(item, ['segmentId', 'sourceId', 'eventOrder', 't0Ms', 't1Ms', 'text'])
    if (!Number.isSafeInteger(item.eventOrder) || item.eventOrder <= priorOrder ||
        !Number.isSafeInteger(item.t0Ms) || !Number.isSafeInteger(item.t1Ms) || item.t1Ms < item.t0Ms ||
        typeof item.text !== 'string' || item.text.length < 1 || Buffer.byteLength(item.text, 'utf8') > 16 * 1024 * 1024) {
      throw new AgentCoreError('AGENT_REQUEST_INVALID')
    }
    priorOrder = item.eventOrder
    return {
      segmentId: boundedString(item.segmentId),
      sourceId: boundedString(item.sourceId),
      eventOrder: item.eventOrder,
      t0Ms: item.t0Ms,
      t1Ms: item.t1Ms,
      text: item.text
    }
  })
  return { inputRef, items }
}

const CLAIMED_JOB_KEYS = Object.freeze([
  'jobId', 'runId', 'taskKind', 'state', 'sessionId', 'inputRef', 'recipeVersion',
  'providerId', 'providerKind', 'model', 'attemptCount', 'maxAttempts', 'nextAttemptAt',
  'lease', 'cancelRequestedAt', 'errorCode', 'requestedBy', 'createdAt', 'updatedAt'
])

function claimedJob (value) {
  exactObject(value, CLAIMED_JOB_KEYS)
  const ref = inputReference(value.inputRef)
  exactObject(value.lease, ['owner', 'expiresAt'], 'AGENT_JOB_STATE_CONFLICT')
  if (value.state !== 'running' || !Object.hasOwn(TASK_RECIPE_VERSIONS, value.taskKind) ||
      value.recipeVersion !== TASK_RECIPE_VERSIONS[value.taskKind] || value.sessionId !== ref.sessionId ||
      !['cloud', 'local'].includes(value.providerKind) ||
      !Number.isSafeInteger(value.attemptCount) || value.attemptCount < 1 ||
      !Number.isSafeInteger(value.maxAttempts) || value.maxAttempts < value.attemptCount ||
      !Number.isSafeInteger(value.lease.expiresAt) || value.lease.expiresAt < 0) {
    throw new AgentCoreError('AGENT_REQUEST_INVALID')
  }
  for (const field of ['jobId', 'runId', 'providerId', 'model']) boundedString(value[field])
  boundedString(value.lease.owner, 1, 160, 'AGENT_JOB_STATE_CONFLICT')
  return { ...value, inputRef: ref, lease: { ...value.lease } }
}

function providerLimits (value) {
  exactObject(value, ['maxChunkInputBytes', 'maxResultBytes'])
  if (!Number.isSafeInteger(value.maxChunkInputBytes) || value.maxChunkInputBytes < 256 ||
      value.maxChunkInputBytes > 16 * 1024 * 1024 ||
      !Number.isSafeInteger(value.maxResultBytes) || value.maxResultBytes < 128 ||
      value.maxResultBytes > 1024 * 1024) {
    throw new AgentCoreError('AGENT_REQUEST_INVALID')
  }
  return { ...value }
}

function evidenceRange (value, validEventOrders) {
  exactObject(value, ['fromEventOrder', 'throughEventOrder'], 'AGENT_OUTPUT_INVALID')
  if (!Number.isSafeInteger(value.fromEventOrder) || !Number.isSafeInteger(value.throughEventOrder) ||
      value.fromEventOrder < 1 || value.throughEventOrder < value.fromEventOrder ||
      !validEventOrders.has(value.fromEventOrder) || !validEventOrders.has(value.throughEventOrder)) {
    throw new AgentCoreError('AGENT_OUTPUT_INVALID')
  }
  return { fromEventOrder: value.fromEventOrder, throughEventOrder: value.throughEventOrder }
}

function evidenceItem (value, validEventOrders, actionItem, identityEvidenceAvailable) {
  exactObject(
    value,
    actionItem ? ['text', 'owner', 'due', 'evidence'] : ['text', 'evidence'],
    'AGENT_OUTPUT_INVALID'
  )
  const text = boundedString(value.text, 1, 4000, 'AGENT_OUTPUT_INVALID')
  if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 64) {
    throw new AgentCoreError('AGENT_OUTPUT_INVALID')
  }
  const result = { text, evidence: value.evidence.map((range) => evidenceRange(range, validEventOrders)) }
  if (actionItem) {
    if (value.owner !== null) {
      boundedString(value.owner, 1, 400, 'AGENT_OUTPUT_INVALID')
      if (!identityEvidenceAvailable) throw new AgentCoreError('AGENT_OUTPUT_INVALID')
    }
    if (value.due !== null) boundedString(value.due, 1, 400, 'AGENT_OUTPUT_INVALID')
    result.owner = value.owner
    result.due = value.due
  }
  return result
}

function meetingMinutesArtifact (value, options = {}) {
  exactObject(value, ['type', 'content'], 'AGENT_OUTPUT_INVALID')
  exactObject(value.content, ['overview', 'conclusions', 'actionItems', 'risks'], 'AGENT_OUTPUT_INVALID')
  if (value.type !== 'meeting-minutes' || typeof value.content.overview !== 'string' ||
      value.content.overview.length > 20000) throw new AgentCoreError('AGENT_OUTPUT_INVALID')
  const validEventOrders = options.validEventOrders instanceof Set
    ? options.validEventOrders
    : new Set(options.validEventOrders || [])
  if (validEventOrders.size < 1) throw new AgentCoreError('AGENT_OUTPUT_INVALID')
  for (const key of ['conclusions', 'actionItems', 'risks']) {
    if (!Array.isArray(value.content[key]) || value.content[key].length > 500) {
      throw new AgentCoreError('AGENT_OUTPUT_INVALID')
    }
  }
  const identityEvidenceAvailable = options.identityEvidenceAvailable === true
  return {
    type: 'meeting-minutes',
    content: {
      overview: value.content.overview,
      conclusions: value.content.conclusions.map((item) => evidenceItem(item, validEventOrders, false, identityEvidenceAvailable)),
      actionItems: value.content.actionItems.map((item) => evidenceItem(item, validEventOrders, true, identityEvidenceAvailable)),
      risks: value.content.risks.map((item) => evidenceItem(item, validEventOrders, false, identityEvidenceAvailable))
    }
  }
}

function enhancedTranscriptArtifact (value, options = {}) {
  exactObject(value, ['type', 'content'], 'AGENT_OUTPUT_INVALID')
  exactObject(value.content, ['paragraphs'], 'AGENT_OUTPUT_INVALID')
  if (value.type !== 'enhanced-transcript' || !Array.isArray(value.content.paragraphs) ||
      value.content.paragraphs.length < 1 || value.content.paragraphs.length > 1000) {
    throw new AgentCoreError('AGENT_OUTPUT_INVALID')
  }
  const validEventOrders = options.validEventOrders instanceof Set
    ? options.validEventOrders
    : new Set(options.validEventOrders || [])
  if (validEventOrders.size < 1) throw new AgentCoreError('AGENT_OUTPUT_INVALID')
  return {
    type: 'enhanced-transcript',
    content: {
      paragraphs: value.content.paragraphs.map((item) =>
        evidenceItem(item, validEventOrders, false, false)
      )
    }
  }
}

const MEMORY_KINDS = Object.freeze([
  'decision', 'conclusion', 'action-item', 'term', 'preference', 'project-fact', 'experience'
])
const MEMORY_SCOPE_KINDS = Object.freeze(['global', 'session', 'topic', 'project'])
const MEMORY_BANDS = Object.freeze(['low', 'medium', 'high'])
const MEMORY_DORMANT_REASONS = Object.freeze([
  'agent_disabled',
  'memory_disabled',
  'provider_not_configured',
  'cloud_disclosure_required',
  'credential_unavailable',
  'local_model_not_ready'
])

function memoryQuery (value) {
  exactObject(value, ['scopeRefs', 'kinds', 'semanticKeys', 'maxItems', 'maxSerializedBytes'])
  if (!Array.isArray(value.scopeRefs) || value.scopeRefs.length < 1 || value.scopeRefs.length > 16 ||
      !Array.isArray(value.kinds) || value.kinds.length < 1 || value.kinds.length > MEMORY_KINDS.length ||
      !Array.isArray(value.semanticKeys) || value.semanticKeys.length > 64 ||
      !Number.isSafeInteger(value.maxItems) || value.maxItems < 1 || value.maxItems > 20 ||
      !Number.isSafeInteger(value.maxSerializedBytes) ||
      value.maxSerializedBytes < 256 || value.maxSerializedBytes > 65536) {
    throw new AgentCoreError('AGENT_REQUEST_INVALID')
  }
  const scopeRefs = value.scopeRefs.map((scope) => {
    exactObject(scope, ['kind', 'canonicalKey'])
    if (!MEMORY_SCOPE_KINDS.includes(scope.kind)) throw new AgentCoreError('AGENT_REQUEST_INVALID')
    return { kind: scope.kind, canonicalKey: boundedString(scope.canonicalKey, 1, 240) }
  })
  if (new Set(scopeRefs.map((scope) => `${scope.kind}\u0000${scope.canonicalKey}`)).size !== scopeRefs.length ||
      value.kinds.some((kind) => !MEMORY_KINDS.includes(kind)) ||
      new Set(value.kinds).size !== value.kinds.length) {
    throw new AgentCoreError('AGENT_REQUEST_INVALID')
  }
  const semanticKeys = value.semanticKeys.map((key) => boundedString(key, 1, 240))
  if (new Set(semanticKeys).size !== semanticKeys.length) throw new AgentCoreError('AGENT_REQUEST_INVALID')
  return {
    scopeRefs,
    kinds: [...value.kinds],
    semanticKeys,
    maxItems: value.maxItems,
    maxSerializedBytes: value.maxSerializedBytes
  }
}

function memoryProjection (value, rawQuery) {
  const query = memoryQuery(rawQuery)
  exactObject(value, [
    'availability', 'reason', 'items', 'itemCount', 'serializedBytes', 'hasMore'
  ])
  if (!['ready', 'dormant'].includes(value.availability) ||
      typeof value.hasMore !== 'boolean' ||
      !Number.isSafeInteger(value.itemCount) || value.itemCount < 0 || value.itemCount > query.maxItems ||
      !Number.isSafeInteger(value.serializedBytes) || value.serializedBytes < 0 ||
      value.serializedBytes > query.maxSerializedBytes || !Array.isArray(value.items) ||
      value.items.length !== value.itemCount) {
    throw new AgentCoreError('AGENT_REQUEST_INVALID')
  }
  if (value.availability === 'dormant') {
    if (!MEMORY_DORMANT_REASONS.includes(value.reason) || value.items.length !== 0 ||
        value.serializedBytes !== 0 || value.hasMore) {
      throw new AgentCoreError('AGENT_REQUEST_INVALID')
    }
    return { ...value, items: [] }
  }
  if (value.reason !== null) throw new AgentCoreError('AGENT_REQUEST_INVALID')
  const seen = new Set()
  const requestedScopes = new Set(query.scopeRefs.map((scope) => `${scope.kind}\u0000${scope.canonicalKey}`))
  const items = value.items.map((item) => {
    exactObject(item, [
      'memoryId', 'scope', 'kind', 'semanticKey', 'content', 'origin',
      'confidenceBand', 'salienceBand', 'revisionId', 'updatedAt',
      'evidenceCount', 'evidence'
    ])
    exactObject(item.scope, ['kind', 'canonicalKey', 'label'])
    if (!MEMORY_SCOPE_KINDS.includes(item.scope.kind) || !MEMORY_KINDS.includes(item.kind) ||
        !requestedScopes.has(`${item.scope.kind}\u0000${item.scope.canonicalKey}`) ||
        !query.kinds.includes(item.kind) ||
        (query.semanticKeys.length > 0 && !query.semanticKeys.includes(item.semanticKey)) ||
        !['explicit', 'automatic'].includes(item.origin) ||
        !MEMORY_BANDS.includes(item.confidenceBand) || !MEMORY_BANDS.includes(item.salienceBand) ||
        !item.content || typeof item.content !== 'object' || Array.isArray(item.content) ||
        !Number.isSafeInteger(item.updatedAt) || item.updatedAt < 0 ||
        !Number.isSafeInteger(item.evidenceCount) || item.evidenceCount < 0 ||
        !Array.isArray(item.evidence) || item.evidence.length > 8 ||
        item.evidence.length > item.evidenceCount) {
      throw new AgentCoreError('AGENT_REQUEST_INVALID')
    }
    const memoryId = boundedString(item.memoryId)
    if (seen.has(memoryId)) throw new AgentCoreError('AGENT_REQUEST_INVALID')
    seen.add(memoryId)
    boundedString(item.scope.canonicalKey, 1, 240)
    boundedString(item.scope.label, 1, 400)
    boundedString(item.semanticKey, 1, 240)
    boundedString(item.revisionId)
    const evidence = item.evidence.map((source) => {
      exactObject(source, [
        'sessionId', 'transcriptVersion', 'inputWatermark', 'fromEventOrder',
        'throughEventOrder', 'inputDigest'
      ])
      if (!['original', 'refined'].includes(source.transcriptVersion) ||
          !Number.isSafeInteger(source.inputWatermark) || source.inputWatermark < 1 ||
          !Number.isSafeInteger(source.fromEventOrder) || source.fromEventOrder < 1 ||
          !Number.isSafeInteger(source.throughEventOrder) ||
          source.throughEventOrder < source.fromEventOrder ||
          source.throughEventOrder > source.inputWatermark ||
          typeof source.inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(source.inputDigest)) {
        throw new AgentCoreError('AGENT_REQUEST_INVALID')
      }
      boundedString(source.sessionId)
      return { ...source }
    })
    try {
      if (Buffer.byteLength(canonicalize(item.content), 'utf8') > 16384) {
        throw new Error('memory content too large')
      }
    } catch {
      throw new AgentCoreError('AGENT_REQUEST_INVALID')
    }
    return {
      ...item,
      scope: { ...item.scope },
      content: structuredClone(item.content),
      evidence
    }
  })
  const serializedBytes = items.reduce((total, item) => total + canonicalBytes(item), 0)
  if (serializedBytes !== value.serializedBytes) throw new AgentCoreError('AGENT_REQUEST_INVALID')
  return { ...value, items }
}

function memoryCandidate (value, options = {}) {
  exactObject(value, [
    'kind', 'semanticKey', 'scope', 'origin', 'content', 'evidence', 'confidenceBand', 'salienceBand'
  ], 'AGENT_OUTPUT_INVALID')
  exactObject(value.scope, ['kind', 'canonicalKey', 'label'], 'AGENT_OUTPUT_INVALID')
  if (!MEMORY_KINDS.includes(value.kind) || !MEMORY_SCOPE_KINDS.includes(value.scope.kind) ||
      !['explicit', 'automatic'].includes(value.origin) ||
      !MEMORY_BANDS.includes(value.confidenceBand) || !MEMORY_BANDS.includes(value.salienceBand) ||
      !value.content || typeof value.content !== 'object' || Array.isArray(value.content)) {
    throw new AgentCoreError('AGENT_OUTPUT_INVALID')
  }
  const validEventOrders = options.validEventOrders instanceof Set
    ? options.validEventOrders
    : new Set(options.validEventOrders || [])
  const sessionId = boundedString(options.sessionId, 1, 160, 'AGENT_OUTPUT_INVALID')
  const semanticKey = boundedString(value.semanticKey, 1, 240, 'AGENT_OUTPUT_INVALID')
  const canonicalKey = boundedString(value.scope.canonicalKey, 1, 240, 'AGENT_OUTPUT_INVALID')
  const label = boundedString(value.scope.label, 1, 400, 'AGENT_OUTPUT_INVALID')
  if (value.scope.kind === 'session' && canonicalKey !== sessionId) {
    throw new AgentCoreError('AGENT_OUTPUT_INVALID')
  }
  let content
  try {
    const serialized = canonicalize(value.content)
    if (Buffer.byteLength(serialized, 'utf8') > 16384) throw new Error('content too large')
    content = JSON.parse(serialized)
  } catch {
    throw new AgentCoreError('AGENT_OUTPUT_INVALID')
  }
  if (!Array.isArray(value.evidence) || value.evidence.length < 1 || value.evidence.length > 64) {
    throw new AgentCoreError('AGENT_OUTPUT_INVALID')
  }
  return {
    kind: value.kind,
    semanticKey,
    scope: { kind: value.scope.kind, canonicalKey, label },
    origin: value.origin,
    content,
    evidence: value.evidence.map((range) => evidenceRange(range, validEventOrders)),
    confidenceBand: value.confidenceBand,
    salienceBand: value.salienceBand
  }
}

function memoryExtractionOutput (value, options = {}) {
  exactObject(value, ['type', 'candidates'], 'AGENT_OUTPUT_INVALID')
  if (value.type !== 'memory-candidates' || !Array.isArray(value.candidates) || value.candidates.length > 200) {
    throw new AgentCoreError('AGENT_OUTPUT_INVALID')
  }
  return {
    type: 'memory-candidates',
    candidates: value.candidates.map((candidate) => memoryCandidate(candidate, options))
  }
}

function canonicalBytes (value, code = 'AGENT_REQUEST_INVALID') {
  try {
    return Buffer.byteLength(canonicalize(value), 'utf8')
  } catch {
    throw new AgentCoreError(code)
  }
}

function throwIfAborted (signal) {
  if (signal?.aborted) throw new AgentCoreError('AGENT_CANCELLED')
}

function runtimeError (error) {
  if (error instanceof AgentCoreError) return error
  const code = typeof error?.code === 'string' ? error.code : ''
  if (RETRYABLE_ERROR_CODES.includes(code)) return new AgentCoreError(code, { retryable: true })
  if (TERMINAL_ERROR_CODES.includes(code) || ['AGENT_INPUT_CHANGED', 'AGENT_JOB_STATE_CONFLICT'].includes(code)) {
    return new AgentCoreError(code)
  }
  return new AgentCoreError('AGENT_INTERNAL_FAILURE')
}

module.exports = {
  CLAIMED_JOB_KEYS,
  MEMORY_BANDS,
  MEMORY_KINDS,
  MEMORY_SCOPE_KINDS,
  RETRYABLE_ERROR_CODES,
  TASK_RECIPE_VERSIONS,
  TERMINAL_ERROR_CODES,
  boundedString,
  canonicalBytes,
  claimedJob,
  exactObject,
  enhancedTranscriptArtifact,
  inputReference,
  memoryCandidate,
  memoryExtractionOutput,
  memoryProjection,
  memoryQuery,
  meetingMinutesArtifact,
  providerLimits,
  runtimeError,
  sameInputReference,
  throwIfAborted,
  transcriptSnapshot
}
