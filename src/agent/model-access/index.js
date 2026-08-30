'use strict'

function createModelAccess (options = {}) {
  const storage = options.storage
  if (!storage || typeof storage.modelAccessCatalog !== 'function' ||
      typeof storage.modelAccessConfigure !== 'function' || typeof storage.modelAccessBind !== 'function') {
    throw new TypeError('model-access storage adapter is required')
  }
  return Object.freeze({
    catalog: () => storage.modelAccessCatalog(),
    configure: (command) => storage.modelAccessConfigure(command),
    bind: (runRequest) => storage.modelAccessBind(runRequest)
  })
}

module.exports = { createModelAccess }
