'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const ROOT = path.resolve(__dirname, '..')
const OUTPUT = path.join(ROOT, 'src/native/memory-file/memory_file_native.node')
function run ({ check = process.argv.includes('--check') } = {}) {
  if (process.platform !== 'win32') return
  if (check) {
    if (!fs.statSync(OUTPUT, { throwIfNoEntry: false })?.isFile()) throw new Error('MEMORY_FILE_NATIVE_UNAVAILABLE')
    return
  }
  const directory = path.join(ROOT, 'native/memory-file')
  const result = spawnSync(process.execPath, [path.join(ROOT, 'node_modules/node-gyp/bin/node-gyp.js'), 'rebuild', '--directory', directory], { cwd: ROOT, stdio: 'inherit', windowsHide: true })
  if (result.error || result.status !== 0) throw new Error('MEMORY_FILE_NATIVE_BUILD_FAILED')
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
  fs.copyFileSync(path.join(directory, 'build/Release/memory_file_native.node'), OUTPUT)
}
if (require.main === module) run()
module.exports = { run, OUTPUT }
