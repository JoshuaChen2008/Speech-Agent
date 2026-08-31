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
    readSessionInput: (source) => storage.readPersonalContextSessionInput(source),
    readToolContext: (request) => storage.readPersonalContextToolContext(request),
    commitSessionIngest: (request) => storage.commitPersonalContextSessionIngest(request)
  })
}

module.exports = { createPersonalContextExecutionAdapter, createPersonalContextModule }
