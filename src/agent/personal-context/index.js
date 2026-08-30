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

module.exports = { createPersonalContextModule }
