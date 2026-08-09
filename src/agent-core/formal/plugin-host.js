'use strict'

const { AgentCoreError } = require('../errors')
const {
  claimedJob,
  exactObject,
  providerLimits,
  sameInputReference,
  throwIfAborted,
  transcriptSnapshot
} = require('./contracts')
const { MeetingMinutesPlugin } = require('./meeting-minutes-plugin')

const MANIFEST_KEYS = Object.freeze([
  'id', 'version', 'apiVersion', 'kind', 'activationEvents', 'requires',
  'permissions', 'contributes', 'failurePolicy', 'timeoutMs'
])
const ALLOWED_PERMISSIONS = Object.freeze(['transcript.read', 'model.invoke', 'artifact.write'])

const FORMAL_PLUGINS = Object.freeze([
  Object.freeze({
    id: 'transcript-context', version: '1.0.0', apiVersion: '1', kind: 'context-provider',
    activationEvents: Object.freeze(['onMeetingStopped', 'onUserRequest']),
    requires: Object.freeze([]), permissions: Object.freeze(['transcript.read']),
    contributes: Object.freeze(['context:transcript']), failurePolicy: 'isolate', timeoutMs: 5000
  }),
  Object.freeze({
    id: 'meeting-minutes', version: '1.0.0', apiVersion: '1', kind: 'artifact-generator',
    activationEvents: Object.freeze(['onMeetingStopped', 'onUserRequest']),
    requires: Object.freeze(['transcript-context']),
    permissions: Object.freeze(['transcript.read', 'model.invoke', 'artifact.write']),
    contributes: Object.freeze(['artifact:meeting-minutes']), failurePolicy: 'isolate', timeoutMs: 120000
  })
])

const FORMAL_RECIPES = Object.freeze({
  'meeting-minutes@1': Object.freeze({
    id: 'meeting-minutes@1', taskKind: 'meeting-minutes', pluginId: 'meeting-minutes',
    contextPluginId: 'transcript-context', artifactKind: 'meeting-minutes'
  })
})

function validateManifest (manifest) {
  exactObject(manifest, MANIFEST_KEYS, 'AGENT_PLUGIN_INVALID')
  if (typeof manifest.id !== 'string' || typeof manifest.version !== 'string' || manifest.apiVersion !== '1' ||
      !['context-provider', 'artifact-generator'].includes(manifest.kind) || manifest.failurePolicy !== 'isolate' ||
      !Number.isSafeInteger(manifest.timeoutMs) || manifest.timeoutMs < 1 || manifest.timeoutMs > 120000) {
    throw new AgentCoreError('AGENT_PLUGIN_INVALID')
  }
  for (const key of ['activationEvents', 'requires', 'permissions', 'contributes']) {
    if (!Array.isArray(manifest[key]) || new Set(manifest[key]).size !== manifest[key].length ||
        manifest[key].some((entry) => typeof entry !== 'string' || entry.length < 1)) {
      throw new AgentCoreError('AGENT_PLUGIN_INVALID')
    }
  }
  if (manifest.activationEvents.some((event) => !['onMeetingStopped', 'onUserRequest'].includes(event)) ||
      manifest.permissions.some((permission) => !ALLOWED_PERMISSIONS.includes(permission))) {
    throw new AgentCoreError('AGENT_PLUGIN_INVALID')
  }
  return manifest
}

function validateDependencies (registry) {
  const visiting = new Set()
  const visited = new Set()
  const visit = (id) => {
    if (visiting.has(id)) throw new AgentCoreError('AGENT_PLUGIN_INVALID')
    if (visited.has(id)) return
    const manifest = registry.get(id)
    if (!manifest) throw new AgentCoreError('AGENT_PLUGIN_INVALID')
    visiting.add(id)
    for (const required of manifest.requires) visit(required)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of registry.keys()) visit(id)
}

class AgentPluginHost {
  constructor ({ transcriptReader, inputPlanner, modelGateway, disabledPluginIds = [], timeoutMs } = {}) {
    if (!transcriptReader || typeof transcriptReader.readSnapshot !== 'function' ||
        !inputPlanner || typeof inputPlanner.plan !== 'function' ||
        !modelGateway || typeof modelGateway.getLimits !== 'function' || typeof modelGateway.execute !== 'function' ||
        !Array.isArray(disabledPluginIds) || new Set(disabledPluginIds).size !== disabledPluginIds.length ||
        disabledPluginIds.some((id) => !FORMAL_PLUGINS.some((manifest) => manifest.id === id))) {
      throw new AgentCoreError('AGENT_PLUGIN_INVALID')
    }
    this.transcriptReader = transcriptReader
    this.inputPlanner = inputPlanner
    this.modelGateway = modelGateway
    this.registry = new Map(FORMAL_PLUGINS
      .filter((manifest) => !disabledPluginIds.includes(manifest.id))
      .map((manifest) => [manifest.id, validateManifest(manifest)]))
    validateDependencies(this.registry)
    const manifestTimeout = FORMAL_PLUGINS.find((manifest) => manifest.id === 'meeting-minutes').timeoutMs
    this.timeoutMs = timeoutMs === undefined ? manifestTimeout : timeoutMs
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > manifestTimeout) {
      throw new AgentCoreError('AGENT_PLUGIN_INVALID')
    }
    this.minutes = new MeetingMinutesPlugin()
    this.activeExecutions = new Set()
  }

  listPlugins () {
    return [...this.registry.values()].map((manifest) => ({
      ...manifest,
      activationEvents: [...manifest.activationEvents],
      requires: [...manifest.requires],
      permissions: [...manifest.permissions],
      contributes: [...manifest.contributes]
    }))
  }

  availableTaskKinds () {
    return this.registry.has('meeting-minutes') && this.registry.has('transcript-context')
      ? ['meeting-minutes']
      : []
  }

  unload (pluginId) {
    if (!this.registry.has(pluginId)) throw new AgentCoreError('AGENT_PLUGIN_INVALID')
    this.registry.delete(pluginId)
    for (const execution of this.activeExecutions) {
      if (execution.pluginIds.has(pluginId)) {
        execution.invalidated = true
        execution.controller.abort()
      }
    }
  }

  getRecipe (recipeVersion) {
    const recipe = FORMAL_RECIPES[recipeVersion]
    if (!recipe) throw new AgentCoreError('AGENT_RECIPE_INVALID')
    return recipe
  }

  assertPermission (recipe, permission) {
    const manifest = this.registry.get(recipe.pluginId)
    if (!manifest || !manifest.permissions.includes(permission)) {
      throw new AgentCoreError('AGENT_PERMISSION_DENIED')
    }
  }

  assertRecipeAvailable (recipe) {
    if (!this.registry.has(recipe.pluginId) || !this.registry.has(recipe.contextPluginId)) {
      throw new AgentCoreError('AGENT_PLUGIN_INVALID')
    }
  }

  assertJobAvailable (rawJob) {
    const job = claimedJob(rawJob)
    const recipe = this.getRecipe(job.recipeVersion)
    if (recipe.taskKind !== job.taskKind || !this.availableTaskKinds().includes(job.taskKind)) {
      throw new AgentCoreError('AGENT_PLUGIN_INVALID')
    }
    this.assertRecipeAvailable(recipe)
    return job
  }

  async executeJob (rawJob, options = {}) {
    const job = this.assertJobAvailable(rawJob)
    const recipe = this.getRecipe(job.recipeVersion)
    this.assertPermission(recipe, 'transcript.read')
    this.assertPermission(recipe, 'model.invoke')
    this.assertPermission(recipe, 'artifact.write')

    const controller = new AbortController()
    let timedOut = false
    const externalAbort = () => controller.abort()
    options.signal?.addEventListener('abort', externalAbort, { once: true })
    if (options.signal?.aborted) controller.abort()
    const execution = {
      controller,
      invalidated: false,
      pluginIds: new Set([recipe.pluginId, recipe.contextPluginId])
    }
    this.activeExecutions.add(execution)
    const assertActive = () => {
      if (execution.invalidated) throw new AgentCoreError('AGENT_PLUGIN_INVALID')
      this.assertRecipeAvailable(recipe)
      throwIfAborted(controller.signal)
    }
    let rejectAbort
    const aborted = new Promise((resolve, reject) => { rejectAbort = reject })
    const onAbort = () => rejectAbort(new AgentCoreError(
      execution.invalidated ? 'AGENT_PLUGIN_INVALID' : timedOut ? 'AGENT_INTERNAL_FAILURE' : 'AGENT_CANCELLED'
    ))
    controller.signal.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => { timedOut = true; controller.abort() }, this.timeoutMs)

    const execute = async () => {
      assertActive()
      const snapshot = transcriptSnapshot(await this.transcriptReader.readSnapshot(job.inputRef))
      assertActive()
      if (!sameInputReference(snapshot.inputRef, job.inputRef)) throw new AgentCoreError('AGENT_INPUT_CHANGED')
      const limits = providerLimits(await this.modelGateway.getLimits({
        runId: job.runId,
        providerId: job.providerId,
        providerKind: job.providerKind,
        model: job.model,
        recipeVersion: job.recipeVersion
      }))
      assertActive()
      const plan = this.inputPlanner.plan(snapshot, limits)
      const invokeModel = async (operation, input, signal) => {
        if (!['meeting-minutes.chunk', 'meeting-minutes.merge'].includes(operation)) {
          throw new AgentCoreError('AGENT_PERMISSION_DENIED')
        }
        assertActive()
        this.assertPermission(recipe, 'model.invoke')
        const result = await this.modelGateway.execute({
          runId: job.runId,
          providerId: job.providerId,
          providerKind: job.providerKind,
          model: job.model,
          recipeVersion: job.recipeVersion,
          operation,
          input
        }, signal)
        assertActive()
        return result
      }
      const artifact = await this.minutes.generate({ job, plan, limits, invokeModel, signal: controller.signal })
      assertActive()
      return artifact
    }

    try {
      return await Promise.race([execute(), aborted])
    } finally {
      clearTimeout(timer)
      this.activeExecutions.delete(execution)
      controller.signal.removeEventListener('abort', onAbort)
      options.signal?.removeEventListener('abort', externalAbort)
      if (typeof this.modelGateway.release === 'function') this.modelGateway.release(job.runId)
    }
  }
}

module.exports = {
  ALLOWED_PERMISSIONS,
  AgentPluginHost,
  FORMAL_PLUGINS,
  FORMAL_RECIPES,
  MANIFEST_KEYS,
  validateDependencies,
  validateManifest
}
