'use strict'

const { canonicalize, sha256Canonical } = require('../../runtime/storage-worker/canonical-json')

const INVALID = 'AGENT_OUTPUT_INVALID'
const REQUEST_INVALID = 'AGENT_REQUEST_INVALID'

const RECIPE_IDS = Object.freeze([
  'intent.route',
  'context.ingest.session',
  'context.ingest.interaction',
  'qa.answer',
  'extract.items',
  'summary.minutes',
  'report.analysis',
  'plan.proposal',
  'text.enhance',
  'text.rewrite',
  'text.translate'
])

const RECIPE_DEFINITIONS = [
  ['intent.route', ['selection', 'session', 'date_range', 'project'], 'default', 1, [], 'IntentRouteV1', 'interaction', null],
  ['context.ingest.session', ['session'], 'information_extraction', 3, ['search_context'], 'ContextIngestV1', 'context', null],
  ['context.ingest.interaction', ['interaction'], 'information_extraction', 3, ['search_context'], 'ContextIngestV1', 'context', null],
  ['qa.answer', ['selection', 'session', 'date_range', 'project'], 'default', 3, ['search_context'], 'QaAnswerV1', 'interaction', null],
  ['extract.items', ['selection', 'session'], 'information_extraction', 3, ['search_context'], 'ExtractItemsV1', 'interaction', null],
  ['summary.minutes', ['session'], 'summary', 3, ['search_context'], 'SummaryMinutesV1', 'artifact', 'meeting-minutes'],
  ['report.analysis', ['selection', 'session', 'date_range', 'project'], 'analysis_planning', 6, ['search_context', 'read_sources'], 'ReportAnalysisV1', 'artifact', 'analysis-report'],
  ['plan.proposal', ['selection', 'session', 'date_range', 'project'], 'analysis_planning', 6, ['search_context', 'read_sources'], 'PlanProposalV1', 'artifact', 'planning-proposal'],
  ['text.enhance', ['session'], 'summary', 3, ['search_context'], 'TextEnhanceV1', 'artifact', 'enhanced-transcript'],
  ['text.rewrite', ['selection'], 'default', 1, [], 'TextRewriteV1', 'interaction', null],
  ['text.translate', ['selection', 'session'], 'default', 1, [], 'TextTranslateV1', 'interaction', null]
]

function freezeDefinition ([recipeId, inputScopes, modelPurpose, maxTurns, toolGrants, outputSchemaId, persistence, artifactType]) {
  return Object.freeze({
    recipeId,
    recipeVersion: '1',
    inputScopes: Object.freeze([...inputScopes]),
    modelPurpose,
    maxTurns,
    toolGrants: Object.freeze([...toolGrants]),
    outputSchemaId,
    persistence,
    artifactType,
    failurePolicy: 'isolate'
  })
}

const RECIPE_CATALOG = Object.freeze(RECIPE_DEFINITIONS.map(freezeDefinition))
const RECIPE_BY_ID = new Map(RECIPE_CATALOG.map((recipe) => [recipe.recipeId, recipe]))

function codedError (code, message) {
  const error = new TypeError(`${code}: ${message}`)
  error.code = code
  return error
}

function fail (message) { throw codedError(INVALID, message) }
function requestFail (message) { throw codedError(REQUEST_INVALID, message) }

function plainObject (value, label = 'value') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(`${label} must be a plain object`)
  }
}

function exact (value, keys, label = 'value') {
  plainObject(value, label)
  const expected = [...keys].sort()
  const actual = Object.keys(value).sort()
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    fail(`${label} has non-exact keys`)
  }
}

function exactRequest (value, keys, label = 'request') {
  try { exact(value, keys, label) } catch (error) {
    throw codedError(REQUEST_INVALID, error.message)
  }
}

function stringValue (value, maximum, label) {
  if (typeof value !== 'string' || value.length === 0 || Array.from(value).length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} exceeds its bound`)
  }
  return value
}

function nullableString (value, maximum, label) {
  if (value !== null) stringValue(value, maximum, label)
  return value
}

function integer (value, minimum, label) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${label} is invalid`)
  return value
}

function finiteRatio (value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) fail(`${label} is invalid`)
  return value
}

function enumValue (value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label} is not registered`)
  return value
}

function boundedArray (value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum || Object.keys(value).length !== value.length) fail(`${label} is invalid`)
  return value
}

function noDuplicate (values, label) {
  if (new Set(values).size !== values.length) fail(`${label} contains duplicate identities`)
}

function checkCanonicalBytes (value, label, maximum = 65536) {
  try {
    if (Buffer.byteLength(canonicalize(value), 'utf8') > maximum) fail(`${label} exceeds its byte bound`)
  } catch (error) {
    if (error.code === INVALID) throw error
    fail(`${label} is not canonical JSON`)
  }
  return value
}

function assertSourceRef (value) {
  exact(value, ['sessionId', 'transcriptVersion', 'fromEventOrder', 'throughEventOrder'], 'SourceRefV1')
  stringValue(value.sessionId, 160, 'SourceRefV1.sessionId')
  enumValue(value.transcriptVersion, ['raw', 'refined'], 'SourceRefV1.transcriptVersion')
  integer(value.fromEventOrder, 0, 'SourceRefV1.fromEventOrder')
  integer(value.throughEventOrder, value.fromEventOrder, 'SourceRefV1.throughEventOrder')
  return value
}

function assertMemoryRef (value) {
  exact(value, ['memoryId', 'revisionId'], 'MemoryRefV1')
  stringValue(value.memoryId, 160, 'MemoryRefV1.memoryId')
  stringValue(value.revisionId, 160, 'MemoryRefV1.revisionId')
  return value
}

const SIGNAL_KINDS = Object.freeze(['prompt', 'edit', 'accept', 'reject', 'remember', 'forget'])

function assertInteractionSignalRef (value) {
  exact(value, ['interactionId', 'signalKind'], 'InteractionSignalRefV1')
  stringValue(value.interactionId, 160, 'InteractionSignalRefV1.interactionId')
  enumValue(value.signalKind, SIGNAL_KINDS, 'InteractionSignalRefV1.signalKind')
  return value
}

function root (value, keys) {
  exact(value, ['schemaVersion', ...keys])
  if (value.schemaVersion !== 1) fail('schemaVersion is invalid')
  return value
}

function refs (value, maximum, label, validator) {
  boundedArray(value, maximum, label)
  value.forEach((item) => validator(item))
  return value
}

function assertIntentRoute (value) {
  exact(value, ['recipeId', 'confidence'])
  enumValue(value.recipeId, RECIPE_IDS.filter((id) => id !== 'intent.route'), 'recipeId')
  finiteRatio(value.confidence, 'confidence')
  return value
}

const EXPERIENCE_KINDS = ['decision', 'conclusion', 'todo', 'risk', 'topic', 'event']
const MEMORY_KINDS = ['decision', 'conclusion', 'todo', 'term', 'preference', 'project_fact', 'experience']
const CONFIDENCE = ['low', 'medium', 'high']
const SALIENCE = ['low', 'medium', 'high']

function assertIngest (value, evidenceValidator) {
  root(value, ['experiences', 'memoryCandidates'])
  boundedArray(value.experiences, 64, 'experiences')
  boundedArray(value.memoryCandidates, 128, 'memoryCandidates')
  value.experiences.forEach((item) => {
    exact(item, ['kind', 'text', 'evidence', 'confidence'], 'experience')
    enumValue(item.kind, EXPERIENCE_KINDS, 'experience.kind')
    stringValue(item.text, 300, 'experience.text')
    evidenceValidator(item.evidence)
    enumValue(item.confidence, CONFIDENCE, 'experience.confidence')
  })
  value.memoryCandidates.forEach((item) => {
    exact(item, ['scopeKind', 'scopeKeyProposal', 'kind', 'content', 'confidence', 'salience', 'evidence'], 'memoryCandidate')
    enumValue(item.scopeKind, ['global', 'session', 'topic', 'project'], 'memoryCandidate.scopeKind')
    nullableString(item.scopeKeyProposal, 64, 'memoryCandidate.scopeKeyProposal')
    enumValue(item.kind, MEMORY_KINDS, 'memoryCandidate.kind')
    stringValue(item.content, 512, 'memoryCandidate.content')
    enumValue(item.confidence, CONFIDENCE, 'memoryCandidate.confidence')
    enumValue(item.salience, SALIENCE, 'memoryCandidate.salience')
    evidenceValidator(item.evidence)
    if (Object.prototype.hasOwnProperty.call(item, 'semanticKey')) fail('semanticKey is storage-owned')
  })
  return checkCanonicalBytes(value, 'ingest output')
}

function assertQaAnswer (value) {
  root(value, ['answer', 'sourceRefs', 'memoryRefs', 'unresolved'])
  stringValue(value.answer, 4000, 'answer')
  refs(value.sourceRefs, 16, 'sourceRefs', assertSourceRef)
  refs(value.memoryRefs, 16, 'memoryRefs', assertMemoryRef)
  boundedArray(value.unresolved, 5, 'unresolved').forEach((item) => stringValue(item, 300, 'unresolved item'))
  return checkCanonicalBytes(value, 'qa answer')
}

function assertExtractItems (value) {
  root(value, ['items'])
  boundedArray(value.items, 100, 'items')
  value.items.forEach((item) => {
    exact(item, ['kind', 'text', 'sourceRefs', 'confidence'], 'item')
    enumValue(item.kind, ['decision', 'todo', 'risk', 'term', 'entity', 'question'], 'item.kind')
    stringValue(item.text, 300, 'item.text')
    refs(item.sourceRefs, 4, 'item.sourceRefs', assertSourceRef)
    enumValue(item.confidence, CONFIDENCE, 'item.confidence')
  })
  return checkCanonicalBytes(value, 'extract output')
}

function assertSummaryMinutes (value) {
  root(value, ['overview', 'conclusions', 'todos', 'risks'])
  stringValue(value.overview, 2000, 'overview')
  boundedArray(value.conclusions, 30, 'conclusions').forEach((item) => {
    exact(item, ['text', 'sourceRefs'], 'conclusion')
    stringValue(item.text, 300, 'conclusion.text')
    refs(item.sourceRefs, 4, 'conclusion.sourceRefs', assertSourceRef)
  })
  boundedArray(value.todos, 50, 'todos').forEach((item) => {
    exact(item, ['text', 'ownerHint', 'dueHint', 'sourceRefs'], 'todo')
    stringValue(item.text, 300, 'todo.text')
    nullableString(item.ownerHint, 64, 'todo.ownerHint')
    nullableString(item.dueHint, 64, 'todo.dueHint')
    refs(item.sourceRefs, 4, 'todo.sourceRefs', assertSourceRef)
  })
  boundedArray(value.risks, 30, 'risks').forEach((item) => {
    exact(item, ['text', 'sourceRefs'], 'risk')
    stringValue(item.text, 300, 'risk.text')
    refs(item.sourceRefs, 4, 'risk.sourceRefs', assertSourceRef)
  })
  return checkCanonicalBytes(value, 'minutes output')
}

function assertReportAnalysis (value) {
  root(value, ['title', 'summary', 'findings', 'timeline', 'assumptions', 'gaps'])
  stringValue(value.title, 120, 'title')
  stringValue(value.summary, 2000, 'summary')
  boundedArray(value.findings, 30, 'findings').forEach((item) => {
    exact(item, ['text', 'evidence'], 'finding')
    stringValue(item.text, 600, 'finding.text')
    boundedArray(item.evidence, 8, 'finding.evidence').forEach((ref) => {
      try { assertSourceRef(ref) } catch { assertMemoryRef(ref) }
    })
  })
  boundedArray(value.timeline, 60, 'timeline').forEach((item) => {
    exact(item, ['label', 'ref', 'text'], 'timeline item')
    stringValue(item.label, 64, 'timeline.label')
    assertSourceRef(item.ref)
    stringValue(item.text, 300, 'timeline.text')
  })
  boundedArray(value.assumptions, 10, 'assumptions').forEach((item) => stringValue(item, 300, 'assumption'))
  boundedArray(value.gaps, 10, 'gaps').forEach((item) => stringValue(item, 300, 'gap'))
  return checkCanonicalBytes(value, 'analysis output')
}

function assertPlanProposal (value) {
  root(value, ['objective', 'facts', 'assumptions', 'plan', 'alternatives', 'openQuestions'])
  stringValue(value.objective, 300, 'objective')
  boundedArray(value.facts, 20, 'facts').forEach((item) => {
    exact(item, ['text', 'ref'], 'fact')
    stringValue(item.text, 300, 'fact.text')
    try { assertSourceRef(item.ref) } catch { assertMemoryRef(item.ref) }
  })
  boundedArray(value.assumptions, 10, 'assumptions').forEach((item) => stringValue(item, 300, 'assumption'))
  boundedArray(value.plan, 40, 'plan').forEach((item, index) => {
    exact(item, ['step', 'text', 'whenHint', 'dependsOn'], 'plan step')
    if (item.step !== index + 1) fail('plan steps must be continuous')
    stringValue(item.text, 300, 'plan.text')
    nullableString(item.whenHint, 64, 'plan.whenHint')
    boundedArray(item.dependsOn, 4, 'plan.dependsOn').forEach((dependency) => {
      integer(dependency, 1, 'plan dependency')
      if (dependency >= item.step) fail('plan dependency must point backwards')
    })
    noDuplicate(item.dependsOn, 'plan.dependsOn')
  })
  boundedArray(value.alternatives, 5, 'alternatives').forEach((item) => {
    exact(item, ['text', 'tradeoff'], 'alternative')
    stringValue(item.text, 300, 'alternative.text')
    stringValue(item.tradeoff, 300, 'alternative.tradeoff')
  })
  boundedArray(value.openQuestions, 10, 'openQuestions').forEach((item) => stringValue(item, 300, 'open question'))
  return checkCanonicalBytes(value, 'plan output')
}

function assertTextEnhance (value) {
  root(value, ['segments', 'notes'])
  boundedArray(value.segments, Number.MAX_SAFE_INTEGER, 'segments')
  const ids = value.segments.map((item) => {
    exact(item, ['segmentId', 'enhancedText'], 'enhanced segment')
    stringValue(item.segmentId, 160, 'segmentId')
    stringValue(item.enhancedText, 2000, 'enhancedText')
    return item.segmentId
  })
  noDuplicate(ids, 'segments')
  nullableString(value.notes, 500, 'notes')
  return checkCanonicalBytes(value, 'enhance output')
}

function assertTextRewrite (value) {
  root(value, ['style', 'text', 'sourceRefs'])
  enumValue(value.style, ['concise', 'formal', 'casual', 'bulleted'], 'style')
  stringValue(value.text, 4000, 'text')
  refs(value.sourceRefs, 8, 'sourceRefs', assertSourceRef)
  return checkCanonicalBytes(value, 'rewrite output')
}

function canonicalBcp47 (value) {
  stringValue(value, 35, 'targetLanguage')
  try {
    const locale = new Intl.Locale(value)
    if (locale.toString() !== value) fail('targetLanguage is not canonical BCP-47')
  } catch { fail('targetLanguage is not canonical BCP-47') }
}

function assertTextTranslate (value) {
  root(value, ['targetLanguage', 'basedOnRevision', 'segments'])
  canonicalBcp47(value.targetLanguage)
  stringValue(value.basedOnRevision, 160, 'basedOnRevision')
  boundedArray(value.segments, Number.MAX_SAFE_INTEGER, 'segments')
  const ids = value.segments.map((item) => {
    exact(item, ['segmentId', 'translatedText'], 'translated segment')
    stringValue(item.segmentId, 160, 'segmentId')
    stringValue(item.translatedText, 2000, 'translatedText')
    return item.segmentId
  })
  noDuplicate(ids, 'segments')
  return checkCanonicalBytes(value, 'translate output')
}

const OUTPUT_VALIDATORS = Object.freeze({
  IntentRouteV1: assertIntentRoute,
  ContextIngestV1: (value) => assertIngest(value, assertSourceRef),
  QaAnswerV1: assertQaAnswer,
  ExtractItemsV1: assertExtractItems,
  SummaryMinutesV1: assertSummaryMinutes,
  ReportAnalysisV1: assertReportAnalysis,
  PlanProposalV1: assertPlanProposal,
  TextEnhanceV1: assertTextEnhance,
  TextRewriteV1: assertTextRewrite,
  TextTranslateV1: assertTextTranslate
})

function getRecipe (recipeId, recipeVersion = '1') {
  const recipe = RECIPE_BY_ID.get(recipeId)
  if (!recipe || recipe.recipeVersion !== recipeVersion) requestFail('recipe identity is not registered')
  return recipe
}

function assertRecipeRequest (value) {
  exactRequest(value, ['recipeId', 'recipeVersion'])
  if (typeof value.recipeId !== 'string' || typeof value.recipeVersion !== 'string') requestFail('recipe identity is invalid')
  return getRecipe(value.recipeId, value.recipeVersion)
}

function validateRecipeOutput (recipeId, recipeVersion, value) {
  const recipe = getRecipe(recipeId, recipeVersion)
  const validator = OUTPUT_VALIDATORS[recipe.outputSchemaId]
  if (typeof validator !== 'function') requestFail('recipe output validator is missing')
  try {
    if (recipeId === 'context.ingest.interaction') return assertIngest(value, assertInteractionSignalRef)
    return validator(value)
  } catch (error) {
    if (error.code === INVALID) throw error
    throw codedError(INVALID, error.message)
  }
}

function comparisonGroupId (recipeId, recipeVersion, scopeDigest, inputDigest) {
  getRecipe(recipeId, recipeVersion)
  for (const [label, value] of [['scopeDigest', scopeDigest], ['inputDigest', inputDigest]]) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) requestFail(`${label} is invalid`)
  }
  return sha256Canonical([recipeId, recipeVersion, scopeDigest, inputDigest])
}

module.exports = Object.freeze({
  RECIPE_IDS,
  RECIPE_CATALOG,
  OUTPUT_VALIDATORS,
  SIGNAL_KINDS,
  assertInteractionSignalRef,
  assertMemoryRef,
  assertRecipeRequest,
  assertSourceRef,
  comparisonGroupId,
  getRecipe,
  validateRecipeOutput
})
