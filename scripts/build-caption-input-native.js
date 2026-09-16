'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const NATIVE_ROOT = path.join(ROOT, 'native', 'caption-input')
const OUTPUT = path.join(ROOT, 'src', 'native', 'caption-input', 'caption_input_native.node')

function run ({ check = process.argv.includes('--check') } = {}) {
  if (process.platform !== 'win32') {
    process.stdout.write(`caption input native addon ${check ? 'check' : 'build'} skipped on non-Windows.\n`)
    return
  }
  if (check) {
    if (!fs.statSync(OUTPUT, { throwIfNoEntry: false })?.isFile()) {
      throw new Error('caption input native addon is missing; run npm run build:native first')
    }
    process.stdout.write('caption input native addon is present.\n')
    return
  }
  const nodeGyp = path.join(ROOT, 'node_modules', 'node-gyp', 'bin', 'node-gyp.js')
  const result = spawnSync(process.execPath, [nodeGyp, 'rebuild', '--directory', NATIVE_ROOT], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`caption input native build failed with exit code ${result.status}`)
  const built = path.join(NATIVE_ROOT, 'build', 'Release', 'caption_input_native.node')
  if (!fs.statSync(built, { throwIfNoEntry: false })?.isFile()) {
    throw new Error('caption input native build produced no addon')
  }
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true })
  fs.copyFileSync(built, OUTPUT)
  process.stdout.write('caption input native addon built.\n')
}

if (require.main === module) run()

module.exports = { run, OUTPUT }
