'use strict'

const { canonicalize, sha256Canonical } = require('../../runtime/storage-worker/canonical-json')

const INVALID = 'AGENT_OUTPUT_INVALID'
const REQUEST_INVALID = 'AGENT_REQUEST_INVALID'

const RECIPE_IDS = Object.freeze([
  'intent.route',
  'context.ingest.session',
  'context.ingest.interaction',
  'context.synthesize',
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
  ['context.ingest.session', ['session'], 'information_extraction', 3, [], 'ContextIngestV1', 'context', null],
  ['context.ingest.interaction', ['interaction'], 'information_extraction', 3, [], 'ContextIngestV1', 'context', null],
  ['context.ingest.session', ['session'], 'information_extraction', 3, [], 'ContextIngestV2', 'context', null, '2'],
  ['context.ingest.session', ['session'], 'information_extraction', 3, [], 'ContextIngestV3', 'context', null, '3'],
  ['context.ingest.interaction', ['interaction'], 'information_extraction', 3, [], 'ContextIngestV2', 'context', null, '2'],
  ['context.synthesize', ['global', 'project', 'topic'], 'summary', 3, [], 'ContextSynthesisV1', 'context', null],
  ['context.synthesize', ['global', 'project', 'topic'], 'summary', 3, [], 'ContextSynthesisV1', 'context', null, '2'],
  ['qa.answer', ['selection', 'session', 'date_range', 'project'], 'default', 3, ['search_context'], 'QaAnswerV1', 'interaction', null],
  ['qa.answer', ['selection', 'session', 'date_range', 'project'], 'default', 3, ['search_context'], 'QaAnswerV1', 'interaction', null, '2'],
  ['qa.answer', ['session'], 'default', 3, ['search_context'], 'QaAnswerV1', 'interaction', null, '3'],
  ['qa.answer', ['session', 'date_range', 'project'], 'default', 3, ['search_context'], 'QaAnswerV2', 'interaction', null, '4'],
  ['qa.answer', ['session', 'date_range', 'project'], 'default', 3, ['search_context'], 'QaAnswerV2', 'interaction', null, '5'],
  ['extract.items', ['selection', 'session'], 'information_extraction', 3, ['search_context'], 'ExtractItemsV1', 'interaction', null],
  ['summary.minutes', ['session'], 'summary', 3, ['search_context'], 'SummaryMinutesV1', 'artifact', 'meeting-minutes'],
  ['summary.minutes', ['session'], 'summary', 3, ['search_context'], 'SummaryMinutesV1', 'artifact', 'meeting-minutes', '2'],
  ['report.analysis', ['selection', 'session', 'date_range', 'project'], 'analysis_planning', 6, ['search_context', 'read_sources'], 'ReportAnalysisV1', 'artifact', 'analysis-report'],
  ['plan.proposal', ['selection', 'session', 'date_range', 'project'], 'analysis_planning', 6, ['search_context', 'read_sources'], 'PlanProposalV1', 'artifact', 'planning-proposal'],
  ['text.enhance', ['session'], 'summary', 3, ['search_context'], 'TextEnhanceV1', 'artifact', 'enhanced-transcript'],
  ['text.rewrite', ['selection'], 'default', 1, [], 'TextRewriteV1', 'interaction', null],
  ['text.translate', ['selection', 'session'], 'default', 1, [], 'TextTranslateV1', 'interaction', null]
]

function freezeDefinition ([recipeId, inputScopes, modelPurpose, maxTurns, toolGrants, outputSchemaId, persistence, artifactType, recipeVersion = '1']) {
  return Object.freeze({
    recipeId,
    recipeVersion,
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
const RECIPE_BY_IDENTITY = new Map(RECIPE_CATALOG.map((recipe) => [`${recipe.recipeId}\u0000${recipe.recipeVersion}`, recipe]))

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
  enumValue(value.recipeId, RECIPE_IDS.filter((id) => !['intent.route', 'context.synthesize'].includes(id)), 'recipeId')
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

function assertIngestV2 (value, sourceKind) {
  exact(value, ['schemaVersion', 'questionSummary', 'experiences', 'memoryCandidates', 'associations'], 'ContextIngestV2')
  if (value.schemaVersion !== 2) fail('ContextIngestV2.schemaVersion is invalid')
  nullableString(value.questionSummary, 512, 'questionSummary')
  if (value.questionSummary !== null && Buffer.byteLength(value.questionSummary, 'utf8') > 2048) fail('questionSummary exceeds its byte bound')
  if (sourceKind === 'session' && value.questionSummary !== null) fail('a session cannot have a question summary')
  const memoryCandidates = boundedArray(value.memoryCandidates, 128, 'memoryCandidates').map((item) => {
    exact(item, ['scopeKind', 'scopeKeyProposal', 'kind', 'content', 'confidence', 'salience', 'evidence', 'attribution', 'entityKeys', 'userEvidence'], 'memoryCandidate')
    enumValue(item.attribution, sourceKind === 'session' ? ['session_context'] : [
      'self_statement', 'long_term_requirement', 'repeated_pattern', 'temporary_requirement',
      'hypothetical', 'quoted', 'third_party', 'question', 'accepted_content'
    ], 'memoryCandidate.attribution')
    boundedArray(item.entityKeys, 8, 'memoryCandidate.entityKeys').forEach((key) => stringValue(key, 64, 'entityKey'))
    noDuplicate(item.entityKeys, 'entityKeys')
    if (item.userEvidence !== null) {
      if (sourceKind !== 'interaction') fail('session candidates cannot cite user text')
      exact(item.userEvidence, ['fromCodePoint', 'throughCodePoint'], 'userEvidence')
      integer(item.userEvidence.fromCodePoint, 0, 'userEvidence.fromCodePoint')
      integer(item.userEvidence.throughCodePoint, item.userEvidence.fromCodePoint + 1, 'userEvidence.throughCodePoint')
      if (item.userEvidence.throughCodePoint - item.userEvidence.fromCodePoint > 512) fail('userEvidence exceeds its bound')
    } else if (sourceKind === 'interaction' && ['self_statement', 'long_term_requirement', 'repeated_pattern'].includes(item.attribution)) {
      fail('personal candidates require user evidence')
    }
    if (sourceKind === 'session' && !['session', 'project'].includes(item.scopeKind)) fail('session candidates must stay in session or project scope')
    const { attribution, entityKeys, userEvidence, ...legacy } = item
    return legacy
  })
  assertIngest({ schemaVersion: 1, experiences: value.experiences, memoryCandidates },
    sourceKind === 'interaction' ? assertInteractionSignalRef : assertSourceRef)
  boundedArray(value.associations, 32, 'associations').forEach((item) => {
    if (sourceKind !== 'session') fail('interaction ingest cannot create session associations')
    exact(item, ['memoryRef', 'matchKeys', 'relation', 'evidence'], 'association')
    assertMemoryRef(item.memoryRef)
    const keys = boundedArray(item.matchKeys, 8, 'association.matchKeys')
    if (keys.length === 0) fail('association requires a structured match key')
    keys.forEach((key) => stringValue(key, 64, 'matchKey'))
    noDuplicate(keys, 'matchKeys')
    stringValue(item.relation, 300, 'association.relation')
    assertSourceRef(item.evidence)
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

// A range is an independently published experience product. Only the host
// creates the final coverage receipt; model range output never advances it.
function assertIngestV3 (value) {
  plainObject(value, 'ContextIngestV3')
  if (value.schemaVersion !== 3) fail('ContextIngestV3.schemaVersion is invalid')
  if (value.stage === 'range') {
    exact(value, ['schemaVersion', 'stage', 'content'], 'ContextIngestV3')
    assertIngestV2(value.content, 'session')
  } else if (value.stage === 'receipt') {
    exact(value, ['schemaVersion', 'stage', 'rangeCount', 'completedRanges', 'experienceCount', 'inputDigest'], 'ContextIngestV3')
    integer(value.rangeCount, 1, 'rangeCount')
    integer(value.completedRanges, 0, 'completedRanges')
    integer(value.experienceCount, 0, 'experienceCount')
    if (value.rangeCount > 256 || value.completedRanges !== value.rangeCount || value.experienceCount > 16384 ||
        !/^[a-f0-9]{64}$/.test(value.inputDigest)) fail('invalid coverage receipt')
  } else fail('ContextIngestV3.stage is invalid')
  return checkCanonicalBytes(value, 'ingest range output')
}

function assertQaAnswerV2 (value) {
  exact(value, ['schemaVersion', 'answer', 'claims', 'sourceRefs', 'memoryRefs', 'unresolved', 'coverage'], 'QaAnswerV2')
  if (value.schemaVersion !== 2) fail('QaAnswerV2.schemaVersion is invalid')
  assertQaAnswer({ schemaVersion: 1, answer: value.answer, sourceRefs: value.sourceRefs, memoryRefs: value.memoryRefs, unresolved: value.unresolved })
  boundedArray(value.claims, 30, 'claims').forEach(claim => {
    exact(claim, ['text', 'sourceRefs', 'memoryRefs'], 'claim')
    stringValue(claim.text, 600, 'claim.text')
    refs(claim.sourceRefs, 4, 'claim.sourceRefs', assertSourceRef)
    refs(claim.memoryRefs, 4, 'claim.memoryRefs', assertMemoryRef)
    if (claim.sourceRefs.length + claim.memoryRefs.length === 0) fail('claims require evidence')
    if (claim.sourceRefs.some(ref => !value.sourceRefs.some(root => canonicalize(root) === canonicalize(ref))) ||
        claim.memoryRefs.some(ref => !value.memoryRefs.some(root => canonicalize(root) === canonicalize(ref)))) fail('claim evidence is absent from root references')
  })
  if (value.claims.length === 0 && value.unresolved.length === 0) fail('an answer without supported claims must disclose missing evidence')
  if (value.coverage !== null) {
    const cover = value.coverage
    exact(cover, ['mode', 'scopeSessionCount', 'visitedSessionCount', 'omittedSessionCount', 'experienceRangeCount', 'experienceCompletedRangeCount', 'sourceTextComplete', 'summaryComplete'], 'coverage')
    enumValue(cover.mode, ['retrieval', 'full_scan', 'global'], 'coverage.mode')
    for (const key of ['scopeSessionCount', 'visitedSessionCount', 'omittedSessionCount']) integer(cover[key], 0, `coverage.${key}`)
    if (cover.scopeSessionCount < 1 || cover.visitedSessionCount + cover.omittedSessionCount !== cover.scopeSessionCount) fail('invalid session coverage')
    for (const key of ['experienceRangeCount', 'experienceCompletedRangeCount']) if (cover[key] !== null) integer(cover[key], 0, `coverage.${key}`)
    if ((cover.experienceRangeCount === null) !== (cover.experienceCompletedRangeCount === null) ||
        (cover.experienceRangeCount !== null && cover.experienceCompletedRangeCount > cover.experienceRangeCount) ||
        typeof cover.sourceTextComplete !== 'boolean' || typeof cover.summaryComplete !== 'boolean') fail('invalid range coverage')
  }
  return checkCanonicalBytes(value, 'retrieval answer')
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

function assertSynthesis (value) {
  root(value, ['sections'])
  boundedArray(value.sections, 12, 'sections')
  for (const section of value.sections) {
    exact(section, ['category', 'title', 'text', 'memoryRefs', 'episodeRefs'], 'section')
    enumValue(section.category, ['facts', 'changes', 'candidates', 'conflicts'], 'category')
    stringValue(section.title, 64, 'title'); stringValue(section.text, 600, 'text')
    refs(section.memoryRefs, 8, 'memoryRefs', assertMemoryRef)
    refs(section.episodeRefs, 8, 'episodeRefs', (ref) => {
      exact(ref, ['episodeId', 'inputDigest'], 'episodeRef')
      stringValue(ref.episodeId, 160, 'episodeId')
      if (typeof ref.inputDigest !== 'string' || !/^[a-f0-9]{64}$/.test(ref.inputDigest)) fail('episode inputDigest is invalid')
    })
    if (section.memoryRefs.length + section.episodeRefs.length === 0 || (section.category === 'facts' && section.memoryRefs.length === 0)) fail('section lacks its required evidence')
  }
  return checkCanonicalBytes(value, 'synthesis output', 16384)
}

const OUTPUT_VALIDATORS = Object.freeze({
  IntentRouteV1: assertIntentRoute,
  ContextIngestV1: (value) => assertIngest(value, assertSourceRef),
  ContextIngestV2: (value) => assertIngestV2(value, 'session'),
  ContextIngestV3: assertIngestV3,
  ContextSynthesisV1: assertSynthesis,
  QaAnswerV1: assertQaAnswer,
  QaAnswerV2: assertQaAnswerV2,
  ExtractItemsV1: assertExtractItems,
  SummaryMinutesV1: assertSummaryMinutes,
  ReportAnalysisV1: assertReportAnalysis,
  PlanProposalV1: assertPlanProposal,
  TextEnhanceV1: assertTextEnhance,
  TextRewriteV1: assertTextRewrite,
  TextTranslateV1: assertTextTranslate
})

function getRecipe (recipeId, recipeVersion = '1') {
  const recipe = RECIPE_BY_IDENTITY.get(`${recipeId}\u0000${recipeVersion}`)
  if (!recipe) requestFail('recipe identity is not registered')
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
    if (recipeId === 'context.ingest.interaction') {
      return recipeVersion === '2' ? assertIngestV2(value, 'interaction') : assertIngest(value, assertInteractionSignalRef)
    }
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
