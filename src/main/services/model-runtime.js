'use strict'

// @ts-check

const path = require('node:path')
const {
  resolveApprovedRealtimeModel,
  resolveApprovedRefinementModel,
  resolveSileroVadModel
} = require('./model-resolver')
const { RealtimeRuntimeAdapter } = require('../../runtime/realtime-runtime-adapter')

const RUNTIME_TRANSITION_TIMEOUT_MS = 30000
const EXTERNAL_MODEL_DEVELOPMENT_FLAG = 'LIVE_SUBTITLE_ALLOW_EXTERNAL_MODELS'

function allowsExternalModelResources (env = process.env, options = {}) {
  return options.packaged !== true && env && env[EXTERNAL_MODEL_DEVELOPMENT_FLAG] === '1'
}

function resolverOptions (options, includeUserData) {
  const resolved = {
    allowExternal: options.allowExternal === true,
    env: options.env || process.env
  }
  if (options.repoRoot !== undefined) resolved.repoRoot = options.repoRoot
  if (includeUserData) resolved.userDataDir = options.userDataDir
  return resolved
}

/**
 * Development/env resources can satisfy ModelManager's read-only external
 * readiness seam. Product userData is deliberately excluded: installed
 * resources are accepted only through ModelManager's marker audit.
 */
function isExternalArtifactReady (artifactId, options = {}) {
  const external = resolverOptions({ ...options, allowExternal: true }, false)
  if (artifactId === 'x-asr-160ms') return resolveApprovedRealtimeModel(external) !== null
  if (artifactId === 'x-asr-offline') return resolveApprovedRefinementModel(external) !== null
  if (artifactId === 'silero-vad') return resolveSileroVadModel(external) !== null
  return false
}

/**
 * Build the core local subtitle runtime. Realtime ASR plus VAD alone make the
 * subtitle system startable; offline refinement is an independently supplied
 * optional capability and never blocks the core runtime.
 */
function createApprovedRuntimeDefinition (options = {}) {
  if (typeof options.userDataDir !== 'string' || !path.isAbsolute(options.userDataDir)) {
    throw new TypeError('absolute userDataDir is required')
  }
  const candidateOptions = resolverOptions(options, true)
  const realtime = resolveApprovedRealtimeModel(candidateOptions)
  const refinement = resolveApprovedRefinementModel(candidateOptions)
  const vad = resolveSileroVadModel(candidateOptions)
  if (!realtime || !vad) return null

  const Adapter = options.Adapter || RealtimeRuntimeAdapter
  if (typeof Adapter !== 'function') throw new TypeError('Adapter must be a constructor')
  const adapterFactory = () => new Adapter({
    profileMap: { [realtime.profile]: realtime.id },
    recognizer: {
      kind: realtime.kind,
      modelDir: realtime.modelDir,
      numThreads: realtime.numThreads,
      modelType: realtime.modelType
    },
    vad,
    refinement: refinement
      ? {
          kind: refinement.kind,
          modelDir: refinement.modelDir,
          numThreads: refinement.numThreads
        }
      : null,
    registerAudioHostWebContents: options.registerAudioHostWebContents,
    onAudioHostRenderProcessGone: options.onAudioHostRenderProcessGone,
    onAudioHostPreloadError: options.onAudioHostPreloadError,
    onAudioHostUnresponsive: options.onAudioHostUnresponsive,
    onRealtimeUtilityFatal: options.onRealtimeUtilityFatal,
    onRefineUtilityFatal: options.onRefineUtilityFatal
  })

  return Object.freeze({
    adapterFactory,
    runtimeOptions: Object.freeze({
      modelOverride: Object.freeze({
        id: realtime.id,
        profile: realtime.profile,
        developmentOnly: false
      }),
      refinementAvailable: refinement !== null
    }),
    transitionTimeoutMs: RUNTIME_TRANSITION_TIMEOUT_MS
  })
}

function activateApprovedRuntime (options = {}) {
  if (!options.coordinator || typeof options.coordinator.replaceRuntime !== 'function') {
    throw new TypeError('replaceable coordinator is required')
  }
  const definition = createApprovedRuntimeDefinition(options)
  if (!definition) {
    const error = new Error('installed model bundle is incomplete')
    error.code = 'MODEL_RUNTIME_UNAVAILABLE'
    throw error
  }
  return options.coordinator.replaceRuntime(definition)
}

module.exports = {
  EXTERNAL_MODEL_DEVELOPMENT_FLAG,
  RUNTIME_TRANSITION_TIMEOUT_MS,
  activateApprovedRuntime,
  allowsExternalModelResources,
  createApprovedRuntimeDefinition,
  isExternalArtifactReady
}
