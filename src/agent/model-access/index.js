'use strict'

const { ModelAccessRuntime } = require('./runtime')

async function createModelAccess (options = {}) {
  const runtime = new ModelAccessRuntime(options)
  await runtime.initialize()
  const facade = {
    catalog: runtime.catalog.bind(runtime),
    configure: runtime.configure.bind(runtime),
    bind: runtime.bind.bind(runtime),
    createLoopAdapter: runtime.createLoopAdapter.bind(runtime)
  }
  Object.defineProperties(facade, {
    embeddingAccess: { get: () => runtime.embeddingAccess || null, enumerable: false },
    attachEmbeddingAccess: { value: access => {
      if (runtime.embeddingAccess || !access || ['catalog', 'configure', 'bind', 'run', 'cancel', 'close'].some(key => typeof access[key] !== 'function')) throw new TypeError('embedding access interface is invalid')
      runtime.embeddingAccess = access
    }, enumerable: false },
    presetCatalog: { value: runtime.presetCatalog.bind(runtime), enumerable: false },
    testSavedModel: { value: runtime.testSavedModel.bind(runtime), enumerable: false },
    cancelSavedModel: { value: runtime.cancelSavedModel.bind(runtime), enumerable: false },
    cancelAllModelTests: { value: runtime.cancelAllModelTests.bind(runtime), enumerable: false },
    close: { value: runtime.close.bind(runtime), enumerable: false }
  })
  return Object.freeze(facade)
}

module.exports = { createModelAccess }
