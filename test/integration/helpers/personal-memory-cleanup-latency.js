'use strict'

// Keep the production journey intact; delay only an asynchronous OS cleanup.
const fs = require('node:fs')
const { isMainThread } = require('node:worker_threads')

if (!isMainThread) {
  const promises = require('node:fs/promises')
  const remove = promises.rm
  promises.rm = async function (target, ...args) {
    if (String(target).endsWith('.old') && !fs.existsSync(target)) {
      process.stderr.write('MEMORY_FILES_CLEANUP_DELAYED\n')
      await new Promise(resolve => setTimeout(resolve, 800))
    }
    return remove.call(this, target, ...args)
  }
} else {
  const threads = require('node:worker_threads')
  const Worker = threads.Worker
  threads.Worker = class extends Worker {
    constructor (file, options = {}) {
      super(file, { ...options, execArgv: [...(options.execArgv || process.execArgv), '--require', __filename] })
    }
  }
  require('../../../scripts/fixtures/personal-memory-electron-journey')
}
