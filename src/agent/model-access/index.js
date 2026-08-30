'use strict'

const { ModelAccessRuntime } = require('./runtime')

async function createModelAccess (options = {}) {
  const runtime = new ModelAccessRuntime(options)
  await runtime.initialize()
  return Object.freeze({
    catalog: runtime.catalog.bind(runtime),
    configure: runtime.configure.bind(runtime),
    bind: runtime.bind.bind(runtime)
  })
}

module.exports = { createModelAccess }
