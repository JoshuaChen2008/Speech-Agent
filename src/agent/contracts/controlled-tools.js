'use strict'

// S4 contract only: these validators define the two controlled read-only tool
// shapes. They intentionally do not implement a tool adapter or any I/O seam.

const { canonicalize, sha256Canonical } = require('../../runtime/storage-worker/canonical-json')
const { assertMemoryRef, assertSourceRef, getRecipe } = require('./recipes')
const { LIMITS, TOOL_PAYLOAD_LIMITS } = require('./budget-axes')

const TOOL_ERROR_CODES = Object.freeze([
  'TOOL_ARGS_INVALID',
  'TOOL_SCOPE_DENIED',
  'TOOL_NOT_AVAILABLE_FOR_RECIPE',
  'TOOL_BUDGET_EXCEEDED',
  'TOOL_TIMEOUT',
  'TOOL_CANCELLED',
  'TOOL_INTERNAL_FAILURE'
])

const TOOL_NAMES = Object.freeze(['search_context', 'read_sources'])
const TOOL_STATUSES = Object.freeze(['started', 'succeeded', 'failed', 'cancelled'])
const MEMORY_KINDS = Object.freeze([
  'decision',
  'conclusion',
  'todo',
  'term',
  'preference',
  'project_fact',
  'experience'
])

const TOOL_DEFINITIONS = Object.freeze([
  Object.freeze({
    name: 'search_context',
    schemaVersion: 1,
    argsSchema: 'SearchContextArgsV1',
    resultSchema: 'SearchContextResultV1',
    maxResultBytes: TOOL_PAYLOAD_LIMITS.maxResultBytes
  }),
  Object.freeze({
    name: 'read_sources',
    schemaVersion: 1,
    argsSchema: 'ReadSourcesArgsV1',
    resultSchema: 'ReadSourcesResultV1',
    maxResultBytes: TOOL_PAYLOAD_LIMITS.maxResultBytes
  })
])

const TOOL_BY_NAME = new Map(TOOL_DEFINITIONS.map((definition) => [definition.name, definition]))
const ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,159}$/

function toolError (code, message) {
  const error = new TypeError(`${code}: ${message}`)
  error.code = code
  return error
}

function fail (code, path, message) {
  throw toolError(code, `${path}: ${message}`)
}

function assertRecord (value, path, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code, path, 'must be a plain object')
  }
}

function assertExactObject (value, keys, path, code) {
  assertRecord(value, path, code)
  const expected = [...keys].sort()
  const actual = Object.keys(value).sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(code, path, 'must contain exact keys')
  }
}

function assertArray (value, path, code, minimum = 0, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum || Object.keys(value).length !== value.length) {
    fail(code, path, 'has an invalid length')
  }
}

function assertText (value, path, code, maximum) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim() ||
      /[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value, 'utf8') > maximum) {
    fail(code, path, 'has an invalid value')
  }
  return value
}

function assertInteger (value, path, code, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(code, path, 'must be a safe integer')
  return value
}

function assertIdentifier (value, path, code) {
  assertText(value, path, code, 160)
  if (!ID_PATTERN.test(value)) fail(code, path, 'has an invalid identifier')
  return value
}

function assertEnum (value, allowed, path, code) {
  if (!allowed.includes(value)) fail(code, path, 'is not registered')
  return value
}

function canonicalBytes (value, path, code) {
  try {
    return Buffer.byteLength(canonicalize(value), 'utf8')
  } catch {
    fail(code, path, 'is not canonical JSON')
  }
}

function assertCanonicalBytes (value, maximum, path, code) {
  const bytes = canonicalBytes(value, path, code)
  if (bytes > maximum) fail(code, path, `must be <= ${maximum} canonical UTF-8 bytes`)
  return bytes
}

function assertSourceReference (value, path, code) {
  try {
    assertSourceRef(value)
  } catch {
    fail(code, path, 'is not SourceRefV1')
  }
  return value
}

function assertMemoryReference (value, path, code) {
  try {
    assertMemoryRef(value)
  } catch {
    fail(code, path, 'is not MemoryRefV1')
  }
  return value
}

function referenceKey (value) {
  return canonicalize(value)
}

function assertUniqueReferences (references, path, code, validator) {
  const seen = new Set()
  references.forEach((reference, index) => {
    validator(reference, `${path}[${index}]`, code)
    const key = referenceKey(reference)
    if (seen.has(key)) fail(code, `${path}[${index}]`, 'must be unique')
    seen.add(key)
  })
  return references
}

function getToolDefinition (toolName) {
  const definition = TOOL_BY_NAME.get(toolName)
  if (!definition) throw toolError('TOOL_NOT_AVAILABLE_FOR_RECIPE', 'tool name is not registered')
  return definition
}

function assertSearchContextArgs (args, code = 'TOOL_ARGS_INVALID') {
  assertExactObject(args, ['schemaVersion', 'aliasKeys'], 'SearchContextArgsV1', code)
  if (args.schemaVersion !== 1) fail(code, 'SearchContextArgsV1.schemaVersion', 'must equal 1')
  assertArray(args.aliasKeys, 'SearchContextArgsV1.aliasKeys', code, 1, 64)
  const seen = new Set()
  args.aliasKeys.forEach((aliasKey, index) => {
    assertText(aliasKey, `SearchContextArgsV1.aliasKeys[${index}]`, code, 128)
    if (seen.has(aliasKey)) fail(code, `SearchContextArgsV1.aliasKeys[${index}]`, 'must be unique')
    seen.add(aliasKey)
  })
  assertCanonicalBytes(args, TOOL_PAYLOAD_LIMITS.maxArgsBytes, 'SearchContextArgsV1', 'TOOL_BUDGET_EXCEEDED')
  return args
}

function assertReadSourcesArgs (args, code = 'TOOL_ARGS_INVALID') {
  assertExactObject(args, ['schemaVersion', 'sourceRefs'], 'ReadSourcesArgsV1', code)
  if (args.schemaVersion !== 1) fail(code, 'ReadSourcesArgsV1.schemaVersion', 'must equal 1')
  assertArray(args.sourceRefs, 'ReadSourcesArgsV1.sourceRefs', code, 1, 8)
  assertUniqueReferences(args.sourceRefs, 'ReadSourcesArgsV1.sourceRefs', code, assertSourceReference)
  assertCanonicalBytes(args, TOOL_PAYLOAD_LIMITS.maxArgsBytes, 'ReadSourcesArgsV1', 'TOOL_BUDGET_EXCEEDED')
  return args
}

function assertToolArgs (toolName, args) {
  getToolDefinition(toolName)
  return toolName === 'search_context'
    ? assertSearchContextArgs(args)
    : assertReadSourcesArgs(args)
}

function assertRecordedRejectedArgs (toolName, args) {
  getToolDefinition(toolName)
  if (toolName === 'search_context') {
    assertExactObject(args, ['schemaVersion', 'aliasKeys'], 'RejectedSearchContextArgsV1', 'TOOL_ARGS_INVALID')
    if (args.schemaVersion !== 1) fail('TOOL_ARGS_INVALID', 'RejectedSearchContextArgsV1.schemaVersion', 'must equal 1')
    assertArray(args.aliasKeys, 'RejectedSearchContextArgsV1.aliasKeys', 'TOOL_ARGS_INVALID', 0, 64)
    args.aliasKeys.forEach((aliasKey, index) => assertText(aliasKey, `RejectedSearchContextArgsV1.aliasKeys[${index}]`, 'TOOL_ARGS_INVALID', 128))
  } else {
    assertExactObject(args, ['schemaVersion', 'sourceRefs'], 'RejectedReadSourcesArgsV1', 'TOOL_ARGS_INVALID')
    if (args.schemaVersion !== 1) fail('TOOL_ARGS_INVALID', 'RejectedReadSourcesArgsV1.schemaVersion', 'must equal 1')
    assertArray(args.sourceRefs, 'RejectedReadSourcesArgsV1.sourceRefs', 'TOOL_ARGS_INVALID', 0, 8)
    assertUniqueReferences(args.sourceRefs, 'RejectedReadSourcesArgsV1.sourceRefs', 'TOOL_ARGS_INVALID', assertSourceReference)
  }
  assertCanonicalBytes(args, TOOL_PAYLOAD_LIMITS.maxArgsBytes, 'rejected tool args', 'TOOL_ARGS_INVALID')
  return args
}

function assertSearchContextResult (args, result, code = 'TOOL_INTERNAL_FAILURE') {
  assertExactObject(result, ['schemaVersion', 'matches', 'unmatchedAliasKeys'], 'SearchContextResultV1', code)
  if (result.schemaVersion !== 1) fail(code, 'SearchContextResultV1.schemaVersion', 'must equal 1')
  assertArray(result.matches, 'SearchContextResultV1.matches', code, 0, args.aliasKeys.length)
  assertArray(result.unmatchedAliasKeys, 'SearchContextResultV1.unmatchedAliasKeys', code, 0, args.aliasKeys.length)
  const requested = new Set(args.aliasKeys)
  const covered = new Set()
  result.matches.forEach((match, matchIndex) => {
    const matchPath = `SearchContextResultV1.matches[${matchIndex}]`
    assertExactObject(match, ['aliasKey', 'entries'], matchPath, code)
    assertText(match.aliasKey, `${matchPath}.aliasKey`, code, 128)
    if (!requested.has(match.aliasKey) || covered.has(match.aliasKey)) fail(code, `${matchPath}.aliasKey`, 'must cover one requested key')
    covered.add(match.aliasKey)
    assertArray(match.entries, `${matchPath}.entries`, code, 1, 16)
    match.entries.forEach((entry, entryIndex) => {
      const entryPath = `${matchPath}.entries[${entryIndex}]`
      assertExactObject(entry, ['memoryRef', 'kind', 'displayText', 'sourceRefs'], entryPath, code)
      assertMemoryReference(entry.memoryRef, `${entryPath}.memoryRef`, code)
      assertEnum(entry.kind, MEMORY_KINDS, `${entryPath}.kind`, code)
      assertText(entry.displayText, `${entryPath}.displayText`, code, 4096)
      assertArray(entry.sourceRefs, `${entryPath}.sourceRefs`, code, 0, 8)
      assertUniqueReferences(entry.sourceRefs, `${entryPath}.sourceRefs`, code, assertSourceReference)
    })
  })
  result.unmatchedAliasKeys.forEach((aliasKey, index) => {
    assertText(aliasKey, `SearchContextResultV1.unmatchedAliasKeys[${index}]`, code, 128)
    if (!requested.has(aliasKey) || covered.has(aliasKey)) fail(code, `SearchContextResultV1.unmatchedAliasKeys[${index}]`, 'must cover one unmatched requested key')
    covered.add(aliasKey)
  })
  if (covered.size !== requested.size) fail(code, 'SearchContextResultV1', 'must account for every requested alias key')
  return result
}

function assertReadSourcesResult (args, result, code = 'TOOL_INTERNAL_FAILURE') {
  assertExactObject(result, ['schemaVersion', 'sources'], 'ReadSourcesResultV1', code)
  if (result.schemaVersion !== 1) fail(code, 'ReadSourcesResultV1.schemaVersion', 'must equal 1')
  assertArray(result.sources, 'ReadSourcesResultV1.sources', code, args.sourceRefs.length, args.sourceRefs.length)
  result.sources.forEach((source, index) => {
    const path = `ReadSourcesResultV1.sources[${index}]`
    assertExactObject(source, ['sourceRef', 'text'], path, code)
    assertSourceReference(source.sourceRef, `${path}.sourceRef`, code)
    if (referenceKey(source.sourceRef) !== referenceKey(args.sourceRefs[index])) {
      fail(code, `${path}.sourceRef`, 'must preserve requested source reference order')
    }
    assertText(source.text, `${path}.text`, code, TOOL_PAYLOAD_LIMITS.maxResultBytes)
  })
  return result
}

function assertToolResult (toolName, args, result) {
  const definition = getToolDefinition(toolName)
  assertToolArgs(toolName, args)
  const validated = toolName === 'search_context'
    ? assertSearchContextResult(args, result)
    : assertReadSourcesResult(args, result)
  assertCanonicalBytes(validated, definition.maxResultBytes, `${definition.resultSchema}`, 'TOOL_BUDGET_EXCEEDED')
  return validated
}

function collectResultSourceRefs (toolName, result) {
  if (toolName === 'read_sources') return result.sources.map((source) => source.sourceRef)
  return result.matches.flatMap((match) => match.entries.flatMap((entry) => entry.sourceRefs))
}

function collectResultMemoryRefs (toolName, result) {
  if (toolName !== 'search_context') return []
  return result.matches.flatMap((match) => match.entries.map((entry) => entry.memoryRef))
}

function uniqueReferences (references) {
  const seen = new Set()
  return references.filter((reference) => {
    const key = referenceKey(reference)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function deriveToolResultMetadata (toolName, args, result) {
  const validated = assertToolResult(toolName, args, result)
  const sourceRefs = uniqueReferences(collectResultSourceRefs(toolName, validated))
  const sourceTextBytes = toolName === 'read_sources'
    ? validated.sources.reduce((total, source) => total + Buffer.byteLength(source.text, 'utf8'), 0)
    : 0
  return Object.freeze({
    resultBytes: canonicalBytes(validated, 'tool result', 'TOOL_INTERNAL_FAILURE'),
    resultDigest: sha256Canonical(validated),
    sourceRefs: Object.freeze(sourceRefs),
    sourceTextBytes,
    sourceReferenceCount: sourceRefs.length
  })
}

function assertToolScope (toolName, args, result, scope) {
  const code = 'TOOL_SCOPE_DENIED'
  assertToolArgs(toolName, args)
  assertExactObject(scope, ['registeredAliasKeys', 'memoryRefs', 'sourceRefs'], 'ToolScopeV1', code)
  assertArray(scope.registeredAliasKeys, 'ToolScopeV1.registeredAliasKeys', code, 0, 128)
  const allowedAliases = new Set()
  scope.registeredAliasKeys.forEach((aliasKey, index) => {
    assertText(aliasKey, `ToolScopeV1.registeredAliasKeys[${index}]`, code, 128)
    if (allowedAliases.has(aliasKey)) fail(code, `ToolScopeV1.registeredAliasKeys[${index}]`, 'must be unique')
    allowedAliases.add(aliasKey)
  })
  assertArray(scope.memoryRefs, 'ToolScopeV1.memoryRefs', code, 0, 128)
  assertUniqueReferences(scope.memoryRefs, 'ToolScopeV1.memoryRefs', code, assertMemoryReference)
  assertArray(scope.sourceRefs, 'ToolScopeV1.sourceRefs', code, 0, 128)
  assertUniqueReferences(scope.sourceRefs, 'ToolScopeV1.sourceRefs', code, assertSourceReference)
  const allowedMemory = new Set(scope.memoryRefs.map(referenceKey))
  const allowedSource = new Set(scope.sourceRefs.map(referenceKey))
  const sourceRefs = toolName === 'read_sources' ? args.sourceRefs : []
  sourceRefs.forEach((reference, index) => {
    if (!allowedSource.has(referenceKey(reference))) fail(code, `tool args sourceRefs[${index}]`, 'is outside the frozen scope')
  })
  if (result !== null) {
    const metadata = deriveToolResultMetadata(toolName, args, result)
    if (toolName === 'search_context') {
      result.matches.forEach((match, index) => {
        if (!allowedAliases.has(match.aliasKey)) {
          fail(code, `tool result matches[${index}].aliasKey`, 'is not an exact registered alias')
        }
      })
    }
    metadata.sourceRefs.forEach((reference, index) => {
      if (!allowedSource.has(referenceKey(reference))) fail(code, `tool result sourceRefs[${index}]`, 'is outside the frozen scope')
    })
    collectResultMemoryRefs(toolName, result).forEach((reference, index) => {
      if (!allowedMemory.has(referenceKey(reference))) fail(code, `tool result memoryRefs[${index}]`, 'is outside the frozen scope')
    })
  }
  return scope
}

function assertRecipeToolAuthorization (recipeId, recipeVersion, toolName) {
  getToolDefinition(toolName)
  let recipe
  try {
    recipe = getRecipe(recipeId, recipeVersion)
  } catch {
    throw toolError('TOOL_NOT_AVAILABLE_FOR_RECIPE', 'recipe identity is not registered')
  }
  if (!recipe.toolGrants.includes(toolName)) {
    throw toolError('TOOL_NOT_AVAILABLE_FOR_RECIPE', 'tool is not granted to this recipe')
  }
  return recipe
}

function assertDigest (value, expected, path, code) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value) || value !== expected) {
    fail(code, path, 'does not match canonical content')
  }
  return value
}

function assertCounts (value, path, code) {
  assertExactObject(value, ['resultBytes', 'sourceTextBytes', 'sourceReferenceCount'], path, code)
  assertInteger(value.resultBytes, `${path}.resultBytes`, code)
  assertInteger(value.sourceTextBytes, `${path}.sourceTextBytes`, code)
  assertInteger(value.sourceReferenceCount, `${path}.sourceReferenceCount`, code)
  return value
}

function assertZeroAuditMetadata (record) {
  if (record.sourceRefs.length !== 0 || record.counts.resultBytes !== 0 || record.counts.sourceTextBytes !== 0 || record.counts.sourceReferenceCount !== 0) {
    fail('TOOL_INTERNAL_FAILURE', 'ToolCallRecordV1', 'failed or cancelled calls cannot retain result audit metadata')
  }
}

function assertToolCallRecord (record) {
  const recordCode = 'TOOL_INTERNAL_FAILURE'
  assertExactObject(record, [
    'callId', 'attempt', 'callOrder', 'toolName', 'schemaVersion', 'startedOffsetMs', 'endedOffsetMs',
    'status', 'errorCode', 'args', 'argsDigest', 'result', 'resultDigest', 'sourceRefs', 'counts'
  ], 'ToolCallRecordV1', recordCode)
  assertIdentifier(record.callId, 'ToolCallRecordV1.callId', recordCode)
  assertInteger(record.attempt, 'ToolCallRecordV1.attempt', recordCode, 1)
  assertInteger(record.callOrder, 'ToolCallRecordV1.callOrder', recordCode, 1)
  getToolDefinition(record.toolName)
  if (record.schemaVersion !== 1) fail(recordCode, 'ToolCallRecordV1.schemaVersion', 'must equal 1')
  assertInteger(record.startedOffsetMs, 'ToolCallRecordV1.startedOffsetMs', recordCode)
  assertEnum(record.status, TOOL_STATUSES, 'ToolCallRecordV1.status', recordCode)
  assertCanonicalBytes(record.args, TOOL_PAYLOAD_LIMITS.maxArgsBytes, 'ToolCallRecordV1.args', 'TOOL_BUDGET_EXCEEDED')
  assertDigest(record.argsDigest, sha256Canonical(record.args), 'ToolCallRecordV1.argsDigest', 'TOOL_ARGS_INVALID')
  assertArray(record.sourceRefs, 'ToolCallRecordV1.sourceRefs', recordCode, 0, 8)
  assertUniqueReferences(record.sourceRefs, 'ToolCallRecordV1.sourceRefs', recordCode, assertSourceReference)
  assertCounts(record.counts, 'ToolCallRecordV1.counts', recordCode)
  if (record.status === 'started') {
    assertToolArgs(record.toolName, record.args)
    if (record.endedOffsetMs !== null || record.errorCode !== null || record.result !== null || record.resultDigest !== null) {
      fail(recordCode, 'ToolCallRecordV1', 'started calls cannot have terminal fields')
    }
    assertZeroAuditMetadata(record)
    return record
  }
  assertInteger(record.endedOffsetMs, 'ToolCallRecordV1.endedOffsetMs', recordCode)
  if (record.endedOffsetMs < record.startedOffsetMs) fail(recordCode, 'ToolCallRecordV1.endedOffsetMs', 'must not precede start')
  if (record.status === 'succeeded') {
    if (record.errorCode !== null || record.result === null) fail(recordCode, 'ToolCallRecordV1', 'successful calls require only a result')
    const metadata = deriveToolResultMetadata(record.toolName, record.args, record.result)
    assertDigest(record.resultDigest, metadata.resultDigest, 'ToolCallRecordV1.resultDigest', recordCode)
    if (record.sourceRefs.length !== metadata.sourceRefs.length || record.sourceRefs.some((reference, index) => referenceKey(reference) !== referenceKey(metadata.sourceRefs[index]))) {
      fail(recordCode, 'ToolCallRecordV1.sourceRefs', 'must equal result source references')
    }
    if (record.counts.resultBytes !== metadata.resultBytes || record.counts.sourceTextBytes !== metadata.sourceTextBytes ||
        record.counts.sourceReferenceCount !== metadata.sourceReferenceCount) {
      fail(recordCode, 'ToolCallRecordV1.counts', 'must equal result metadata')
    }
    return record
  }
  if (!TOOL_ERROR_CODES.includes(record.errorCode) || record.result !== null || record.resultDigest !== null) {
    fail(recordCode, 'ToolCallRecordV1', 'failed or cancelled calls require one registered error and no result')
  }
  if (record.status === 'cancelled') {
    if (record.errorCode !== 'TOOL_CANCELLED') fail(recordCode, 'ToolCallRecordV1.errorCode', 'must be TOOL_CANCELLED')
  } else if (record.errorCode === 'TOOL_CANCELLED') {
    fail(recordCode, 'ToolCallRecordV1.errorCode', 'TOOL_CANCELLED requires cancelled status')
  }
  if (record.errorCode === 'TOOL_ARGS_INVALID') assertRecordedRejectedArgs(record.toolName, record.args)
  else assertToolArgs(record.toolName, record.args)
  assertZeroAuditMetadata(record)
  return record
}

function assertToolCallSequence (records) {
  assertArray(records, 'ToolCallSequenceV1', 'TOOL_INTERNAL_FAILURE', 0, LIMITS.maxToolCalls)
  let prior = null
  let group = []
  const completedGroups = []
  records.forEach((record, index) => {
    assertToolCallRecord(record)
    if (prior === null) {
      if (record.attempt !== 1 || record.callOrder !== 1) fail('TOOL_INTERNAL_FAILURE', `ToolCallSequenceV1[${index}]`, 'must start at (1, 1)')
    } else if (record.attempt === prior.attempt) {
      if (record.callOrder !== prior.callOrder + 1) fail('TOOL_INTERNAL_FAILURE', `ToolCallSequenceV1[${index}]`, 'callOrder must be contiguous')
    } else {
      if (record.attempt !== prior.attempt + 1 || record.callOrder !== 1 ||
          prior.status === 'started' || prior.status === 'cancelled') {
        fail('TOOL_INTERNAL_FAILURE', `ToolCallSequenceV1[${index}]`, 'retry must start a new completed attempt at callOrder 1')
      }
      completedGroups.push(group)
      group = []
    }
    group.push(record)
    prior = record
  })
  if (group.length > 0) completedGroups.push(group)
  completedGroups.forEach((attempt) => {
    const sameFailureCounts = new Map()
    let consecutiveFailures = 0
    attempt.forEach((record, index) => {
      if (record.status === 'failed') {
        consecutiveFailures += 1
        const key = `${record.toolName}\u0000${record.errorCode}`
        const sameFailureCount = (sameFailureCounts.get(key) || 0) + 1
        sameFailureCounts.set(key, sameFailureCount)
        if ((consecutiveFailures >= 2 || sameFailureCount >= 2) && index !== attempt.length - 1) {
          fail('TOOL_INTERNAL_FAILURE', 'ToolCallSequenceV1', 'failure closure must end the current attempt')
        }
      } else {
        consecutiveFailures = 0
      }
      if ((record.status === 'cancelled' || record.status === 'started') && index !== attempt.length - 1) {
        fail('TOOL_INTERNAL_FAILURE', 'ToolCallSequenceV1', 'cancelled or started calls must end the current attempt')
      }
    })
  })
  return records
}

function assertToolCallsForRecipe (recipeId, recipeVersion, records, scope = null) {
  assertToolCallSequence(records)
  records.forEach((record) => {
    assertRecipeToolAuthorization(recipeId, recipeVersion, record.toolName)
    if (scope !== null && record.status === 'succeeded') assertToolScope(record.toolName, record.args, record.result, scope)
  })
  return records
}

module.exports = Object.freeze({
  MEMORY_KINDS,
  TOOL_DEFINITIONS,
  TOOL_ERROR_CODES,
  TOOL_NAMES,
  TOOL_STATUSES,
  assertRecipeToolAuthorization,
  assertToolArgs,
  assertToolCallRecord,
  assertToolCallSequence,
  assertToolCallsForRecipe,
  assertToolResult,
  assertToolScope,
  deriveToolResultMetadata,
  getToolDefinition
})
