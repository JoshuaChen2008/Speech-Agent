'use strict'

const { canonicalize } = require('../../runtime/storage-worker/canonical-json')
const { getRecipe } = require('../contracts/recipes')
const {
  assertToolArgs,
  assertToolResult,
  assertToolScope
} = require('../contracts/controlled-tools')

function toolError (code) {
  const error = new Error(code)
  error.code = code
  return error
}

function exactObject (value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw toolError('TOOL_INTERNAL_FAILURE')
  }
  const expected = [...keys].sort()
  const actual = Object.keys(value).sort()
  if (expected.length !== actual.length || expected.some((key, index) => key !== actual[index])) {
    throw toolError('TOOL_INTERNAL_FAILURE')
  }
  return value
}

function referenceKey (reference) {
  return canonicalize(reference)
}

function assertContext (context) {
  exactObject(context, ['scope', 'entries', 'sources'], 'FrozenToolContextV1')
  const scope = context.scope
  exactObject(scope, ['registeredAliasKeys', 'memoryRefs', 'sourceRefs'], 'FrozenToolContextV1.scope')
  if (!Array.isArray(context.entries) || !Array.isArray(context.sources)) throw toolError('TOOL_INTERNAL_FAILURE')
  const aliases = new Set(scope.registeredAliasKeys)
  const memoryKeys = new Set(scope.memoryRefs.map(referenceKey))
  const sourceKeys = new Set(scope.sourceRefs.map(referenceKey))
  const sourceByKey = new Map()

  for (const source of context.sources) {
    exactObject(source, ['sourceRef', 'text'], 'FrozenToolContextV1.sources[]')
    const key = referenceKey(source.sourceRef)
    if (!sourceKeys.has(key) || sourceByKey.has(key)) throw toolError('TOOL_SCOPE_DENIED')
    sourceByKey.set(key, source)
  }
  if (sourceByKey.size !== sourceKeys.size) throw toolError('TOOL_INTERNAL_FAILURE')

  for (const entry of context.entries) {
    exactObject(entry, ['aliasKey', 'memoryRef', 'kind', 'displayText', 'sourceRefs'], 'FrozenToolContextV1.entries[]')
    if (!aliases.has(entry.aliasKey) || !memoryKeys.has(referenceKey(entry.memoryRef)) || !Array.isArray(entry.sourceRefs)) {
      throw toolError('TOOL_SCOPE_DENIED')
    }
    for (const sourceRef of entry.sourceRefs) {
      if (!sourceKeys.has(referenceKey(sourceRef))) throw toolError('TOOL_SCOPE_DENIED')
    }
  }
  return { scope, sourceByKey }
}

class ControlledToolRuntime {
  constructor (options = {}) {
    const snapshot = structuredClone(options.context)
    const context = assertContext(snapshot)
    this.scope = Object.freeze({
      registeredAliasKeys: Object.freeze([...context.scope.registeredAliasKeys]),
      memoryRefs: Object.freeze(context.scope.memoryRefs.map((reference) => ({ ...reference }))),
      sourceRefs: Object.freeze(context.scope.sourceRefs.map((reference) => ({ ...reference })))
    })
    this.entries = Object.freeze(snapshot.entries.map((entry) => Object.freeze({
      ...entry,
      memoryRef: Object.freeze({ ...entry.memoryRef }),
      sourceRefs: Object.freeze(entry.sourceRefs.map((reference) => Object.freeze({ ...reference })))
    })))
    this.sourceByKey = context.sourceByKey
    this.signal = options.signal || null
  }

  assertActive () {
    if (this.signal?.aborted) throw toolError('TOOL_CANCELLED')
  }

  async searchContext (args) {
    this.assertActive()
    assertToolArgs('search_context', args)
    const matches = []
    const unmatchedAliasKeys = []
    for (const aliasKey of args.aliasKeys) {
      const entries = this.entries
        .filter((entry) => entry.aliasKey === aliasKey)
        .map((entry) => ({
          memoryRef: entry.memoryRef,
          kind: entry.kind,
          displayText: entry.displayText,
          sourceRefs: [...entry.sourceRefs]
        }))
      if (entries.length === 0) unmatchedAliasKeys.push(aliasKey)
      else matches.push({ aliasKey, entries })
    }
    const result = { schemaVersion: 1, matches, unmatchedAliasKeys }
    assertToolScope('search_context', args, result, this.scope)
    return assertToolResult('search_context', args, result)
  }

  async readSources (args) {
    this.assertActive()
    assertToolArgs('read_sources', args)
    const sources = args.sourceRefs.map((sourceRef) => {
      const source = this.sourceByKey.get(referenceKey(sourceRef))
      if (!source) throw toolError('TOOL_SCOPE_DENIED')
      return { sourceRef, text: source.text }
    })
    const result = { schemaVersion: 1, sources }
    assertToolScope('read_sources', args, result, this.scope)
    return assertToolResult('read_sources', args, result)
  }

  toolsForRecipe (recipeId, recipeVersion) {
    const recipe = getRecipe(recipeId, recipeVersion)
    return recipe.toolGrants.map((name) => ({
      name,
      execute: name === 'search_context'
        ? (args) => this.searchContext(args)
        : (args) => this.readSources(args)
    }))
  }
}

function createControlledToolRuntime (options) {
  return new ControlledToolRuntime(options)
}

module.exports = Object.freeze({ ControlledToolRuntime, createControlledToolRuntime })
