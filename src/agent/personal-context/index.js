'use strict'

const { assertManageRequest } = require('../contracts/agent-context-ui')

function createPersonalContextModule (options = {}) {
  const storage = options.storage
  if (!storage ||
      typeof storage.personalContextIngest !== 'function' ||
      typeof storage.personalContextResolve !== 'function' ||
      typeof storage.personalContextManage !== 'function') {
    throw new TypeError('storage personal-context adapter is required')
  }
  return Object.freeze({
    ingest: (source) => storage.personalContextIngest(source),
    resolve: (request) => storage.personalContextResolve(request),
    manage: (request) => {
      assertManageRequest(request)
      return storage.personalContextManage(request.command)
    }
  })
}

function createPersonalContextExecutionAdapter (options = {}) {
  const storage = options.storage
  if (!storage ||
      typeof storage.preparePersonalContextSessionIngest !== 'function' ||
      typeof storage.readPersonalContextSessionInput !== 'function' ||
      typeof storage.readPersonalContextToolContext !== 'function' ||
      typeof storage.commitPersonalContextSessionIngest !== 'function') {
    throw new TypeError('storage personal-context execution adapter is required')
  }
  return Object.freeze({
    prepareSessionIngest: (request) => storage.preparePersonalContextSessionIngest(request),
    prepareInteractionIngest: typeof storage.preparePersonalContextInteractionIngest === 'function'
      ? (request) => storage.preparePersonalContextInteractionIngest(request)
      : undefined,
    resolve: typeof storage.personalContextResolve === 'function'
      ? (request) => storage.personalContextResolve(request)
      : undefined,
    readSessionInput: (source, signal) => storage.readPersonalContextSessionInput(source, signal),
    readInteractionInput: typeof storage.readPersonalContextInteractionInput === 'function'
      ? (source, ephemeral) => storage.readPersonalContextInteractionInput(source, ephemeral)
      : undefined,
    readToolContext: (request, signal) => storage.readPersonalContextToolContext(request, signal),
    commitSessionIngest: (request) => storage.commitPersonalContextSessionIngest(request),
    commitInteractionIngest: typeof storage.commitPersonalContextInteractionIngest === 'function'
      ? (request) => storage.commitPersonalContextInteractionIngest(request)
      : undefined
  })
}

module.exports = { createPersonalContextExecutionAdapter, createPersonalContextModule }
