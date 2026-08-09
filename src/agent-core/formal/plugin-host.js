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
const { EnhancedTranscriptPlugin } = require('./enhanced-transcript-plugin')
const { MeetingMinutesPlugin } = require('./meeting-minutes-plugin')
const { MemoryExtractionPlugin } = require('./memory-extraction-plugin')

const MANIFEST_KEYS = Object.freeze([
  'id', 'version', 'apiVersion', 'kind', 'activationEvents', 'requires',
  'permissions', 'contributes', 'failurePolicy', 'timeoutMs'
])
const ALLOWED_PERMISSIONS = Object.freeze([
  'transcript.read', 'model.invoke', 'artifact.write', 'memory.candidate.write'
])

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
  }),
  Object.freeze({
    id: 'enhanced-transcript', version: '1.0.0', apiVersion: '1', kind: 'artifact-generator',
    activationEvents: Object.freeze(['onMeetingStopped', 'onUserRequest']),
    requires: Object.freeze(['transcript-context']),
    permissions: Object.freeze(['transcript.read', 'model.invoke', 'artifact.write']),
    contributes: Object.freeze(['artifact:enhanced-transcript']), failurePolicy: 'isolate', timeoutMs: 120000
  }),
  Object.freeze({
    id: 'memory-consolidation', version: '1.0.0', apiVersion: '1', kind: 'memory-processor',
    activationEvents: Object.freeze(['onMeetingStopped', 'onUserRequest']),
    requires: Object.freeze([]), permissions: Object.freeze(['memory.candidate.write']),
    contributes: Object.freeze(['memory:consolidation']), failurePolicy: 'isolate', timeoutMs: 120000
  }),
  Object.freeze({
    id: 'memory-extraction', version: '1.0.0', apiVersion: '1', kind: 'memory-processor',
    activationEvents: Object.freeze(['onMeetingStopped', 'onUserRequest']),
    requires: Object.freeze(['transcript-context', 'memory-consolidation']),
    permissions: Object.freeze(['transcript.read', 'model.invoke', 'memory.candidate.write']),
    contributes: Object.freeze(['memory:candidates']), failurePolicy: 'isolate', timeoutMs: 120000
  })
])

const FORMAL_RECIPES = Object.freeze({
  'meeting-minutes@1': Object.freeze({
    id: 'meeting-minutes@1', taskKind: 'meeting-minutes', pluginId: 'meeting-minutes',
    contextPluginId: 'transcript-context', resultKind: 'artifact', writerPermission: 'artifact.write',
    operations: Object.freeze(['meeting-minutes.chunk', 'meeting-minutes.merge'])
  }),
  'memory-extraction@1': Object.freeze({
    id: 'memory-extraction@1', taskKind: 'memory-extraction', pluginId: 'memory-extraction',
    contextPluginId: 'transcript-context', resultKind: 'memory-candidates',
    writerPermission: 'memory.candidate.write', operations: Object.freeze(['memory-extraction.chunk'])
  }),
  'enhanced-transcript@1': Object.freeze({
    id: 'enhanced-transcript@1', taskKind: 'enhanced-transcript', pluginId: 'enhanced-transcript',
    contextPluginId: 'transcript-context', resultKind: 'artifact', writerPermission: 'artifact.write',
    operations: Object.freeze(['enhanced-transcript.chunk', 'enhanced-transcript.merge'])
  })
})

function validateManifest (manifest) {
  exactObject(manifest, MANIFEST_KEYS, 'AGENT_PLUGIN_INVALID')
  if (typeof manifest.id !== 'string' || typeof manifest.version !== 'string' || manifest.apiVersion !== '1' ||
      !['context-provider', 'artifact-generator', 'memory-processor'].includes(manifest.kind) ||
      manifest.failurePolicy !== 'isolate' ||
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
      .map((manifest) => [manifest.id, validateManifest(manifest)]))
    validateDependencies(this.registry)
    for (const pluginId of disabledPluginIds) this.registry.delete(pluginId)
    const manifestTimeout = Math.max(...FORMAL_PLUGINS.map((manifest) => manifest.timeoutMs))
    this.timeoutMs = timeoutMs === undefined ? manifestTimeout : timeoutMs
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > manifestTimeout) {
      throw new AgentCoreError('AGENT_PLUGIN_INVALID')
    }
    this.minutes = new MeetingMinutesPlugin()
    this.enhancedTranscript = new EnhancedTranscriptPlugin()
    this.memoryExtraction = new MemoryExtractionPlugin()
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
    return Object.values(FORMAL_RECIPES)
      .filter((recipe) => {
        try {
          this.assertRecipeAvailable(recipe)
          return true
        } catch {
          return false
        }
      })
      .map((recipe) => recipe.taskKind)
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
    const pluginIds = new Set()
    const visit = (pluginId) => {
      if (pluginIds.has(pluginId)) return
      const manifest = this.registry.get(pluginId)
      if (!manifest) throw new AgentCoreError('AGENT_PLUGIN_INVALID')
      pluginIds.add(pluginId)
      for (const required of manifest.requires) visit(required)
    }
    visit(recipe.pluginId)
    if (!pluginIds.has(recipe.contextPluginId)) throw new AgentCoreError('AGENT_PLUGIN_INVALID')
    return pluginIds
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
    this.assertPermission(recipe, recipe.writerPermission)

    const controller = new AbortController()
    let timedOut = false
    const externalAbort = () => controller.abort()
    options.signal?.addEventListener('abort', externalAbort, { once: true })
    if (options.signal?.aborted) controller.abort()
    const execution = {
      controller,
      invalidated: false,
      pluginIds: this.assertRecipeAvailable(recipe)
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
        if (!recipe.operations.includes(operation)) {
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
      let value
      if (job.taskKind === 'meeting-minutes') {
        value = await this.minutes.generate({ job, plan, limits, invokeModel, signal: controller.signal })
      } else if (job.taskKind === 'enhanced-transcript') {
        value = await this.enhancedTranscript.generate({ job, plan, limits, invokeModel, signal: controller.signal })
      } else if (job.taskKind === 'memory-extraction') {
        value = await this.memoryExtraction.extract({ job, plan, limits, invokeModel, signal: controller.signal })
      } else {
        throw new AgentCoreError('AGENT_PLUGIN_INVALID')
      }
      assertActive()
      return { kind: recipe.resultKind, value }
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
