'use strict'

const { AgentCoreError } = require('./errors')

const MANIFEST_KEYS = Object.freeze(['id', 'version', 'apiVersion', 'kind', 'activationEvents', 'requires', 'permissions', 'contributes', 'failurePolicy', 'timeoutMs'])
const ALLOWED_PERMISSIONS = Object.freeze(['transcript.read', 'model.invoke', 'artifact.write'])

const BUILTIN_PLUGINS = Object.freeze([
  Object.freeze({
    id: 'fixture-context', version: '1.0.0', apiVersion: '1', kind: 'context-provider',
    activationEvents: Object.freeze(['onUserRequest']), requires: Object.freeze([]),
    permissions: Object.freeze(['transcript.read']), contributes: Object.freeze(['context:fixture-transcript']),
    failurePolicy: 'isolate', timeoutMs: 5000
  }),
  Object.freeze({
    id: 'reference-structured-output', version: '1.0.0', apiVersion: '1', kind: 'artifact-generator',
    activationEvents: Object.freeze(['onUserRequest']), requires: Object.freeze(['fixture-context']),
    permissions: Object.freeze(['transcript.read', 'model.invoke', 'artifact.write']),
    contributes: Object.freeze(['artifact:reference-output']), failurePolicy: 'isolate', timeoutMs: 30000
  })
])

const RECIPES = Object.freeze({
  'reference-output-v1': Object.freeze({
    id: 'reference-output-v1', pluginId: 'reference-structured-output', artifactKind: 'reference-output',
    version: '1', maxTurns: 2, timeoutMs: 30000,
    permissions: Object.freeze(['transcript.read', 'model.invoke', 'artifact.write']),
    allowedTools: Object.freeze(['read_selected_transcript'])
  })
})

function validateManifest (manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      Object.keys(manifest).sort().join(',') !== [...MANIFEST_KEYS].sort().join(',') ||
      typeof manifest.id !== 'string' || typeof manifest.version !== 'string' || manifest.apiVersion !== '1' ||
      !['context-provider', 'artifact-generator'].includes(manifest.kind) || manifest.failurePolicy !== 'isolate' ||
      !Number.isSafeInteger(manifest.timeoutMs) || manifest.timeoutMs < 1 || manifest.timeoutMs > 30000) {
    throw new AgentCoreError('AGENT_PLUGIN_INVALID')
  }
  for (const key of ['activationEvents', 'requires', 'permissions', 'contributes']) {
    if (!Array.isArray(manifest[key]) || new Set(manifest[key]).size !== manifest[key].length ||
        manifest[key].some((item) => typeof item !== 'string' || item.length < 1)) throw new AgentCoreError('AGENT_PLUGIN_INVALID')
  }
  if (manifest.activationEvents.some((event) => event !== 'onUserRequest') ||
      manifest.permissions.some((permission) => !ALLOWED_PERMISSIONS.includes(permission))) throw new AgentCoreError('AGENT_PLUGIN_INVALID')
  return manifest
}

function validateDependencies (registry) {
  const visiting = new Set(); const visited = new Set()
  const visit = (id) => {
    if (visiting.has(id)) throw new AgentCoreError('AGENT_PLUGIN_INVALID')
    if (visited.has(id)) return
    const manifest = registry.get(id)
    if (!manifest) throw new AgentCoreError('AGENT_PLUGIN_INVALID')
    visiting.add(id)
    for (const dependency of manifest.requires) visit(dependency)
    visiting.delete(id); visited.add(id)
  }
  for (const id of registry.keys()) visit(id)
}

class AgentPluginHost {
  constructor () {
    if (arguments.length !== 0) throw new AgentCoreError('AGENT_PLUGIN_INVALID')
    this.registry = new Map(BUILTIN_PLUGINS.map((manifest) => [manifest.id, validateManifest(manifest)]))
    validateDependencies(this.registry)
  }

  getRecipe (recipeId) {
    const recipe = RECIPES[recipeId]
    if (!recipe) throw new AgentCoreError('AGENT_RECIPE_INVALID')
    return recipe
  }

  assertPermission (recipeId, permission) {
    const recipe = this.getRecipe(recipeId)
    const manifest = this.registry.get(recipe.pluginId)
    if (!recipe.permissions.includes(permission) || !manifest.permissions.includes(permission)) throw new AgentCoreError('AGENT_PERMISSION_DENIED')
  }

  assertTool (recipeId, toolName) {
    if (!this.getRecipe(recipeId).allowedTools.includes(toolName)) throw new AgentCoreError('AGENT_PERMISSION_DENIED')
  }

  listPlugins () {
    return [...this.registry.values()].map((manifest) => ({
      ...manifest,
      activationEvents: [...manifest.activationEvents], requires: [...manifest.requires],
      permissions: [...manifest.permissions], contributes: [...manifest.contributes]
    }))
  }
}

module.exports = { AgentPluginHost, ALLOWED_PERMISSIONS, BUILTIN_PLUGINS, MANIFEST_KEYS, RECIPES, validateDependencies, validateManifest }
