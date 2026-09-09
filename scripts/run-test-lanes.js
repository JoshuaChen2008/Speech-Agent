'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const LANE_DIRECTORIES = Object.freeze({
  core: Object.freeze(['contracts', 'main', 'runtime', 'storage', 'ui']),
  integration: Object.freeze(['integration']),
  evidence: Object.freeze(['gate-0b', 'gate-0c', 'validation'])
})
const TEST_ARGS = Object.freeze(['--test', '--experimental-test-isolation=none'])

function selectFiles (files, root = ROOT) {
  if (!files.length) throw new Error('Specify at least one test file; use npm test for the full suite.')
  const allowed = Object.values(LANE_DIRECTORIES).flat()
  const selected = files.map((file) => {
    const absolute = path.resolve(root, file)
    const relative = path.relative(root, absolute).replaceAll('\\', '/')
    if (!relative.startsWith('test/') || !allowed.includes(relative.split('/')[1]) ||
        !relative.endsWith('.test.js') || !fs.statSync(absolute).isFile()) {
      throw new Error('Select existing .test.js files inside the declared test lanes.')
    }
    // A symlink must not turn an allowed test path into an outside file.
    if (fs.realpathSync(absolute) !== path.join(fs.realpathSync(root), ...relative.split('/'))) {
      throw new Error('Symlinked test paths are not supported.')
    }
    return relative
  })
  return [...new Set(selected)]
}

function laneFiles (lane, root = ROOT) {
  return selectFiles(LANE_DIRECTORIES[lane].flatMap((directory) => {
    const base = path.join(root, 'test', directory)
    return fs.readdirSync(base, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.test.js'))
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
  }).sort(), root)
}

function runFiles (files, { root = ROOT, stdio = 'inherit' } = {}) {
  const result = spawnSync(process.execPath, [...TEST_ARGS, ...selectFiles(files, root)], {
    cwd: root,
    stdio,
    windowsHide: true
  })
  if (result.error) throw result.error
  return result.status === null ? 1 : result.status
}

function runAll (options = {}) {
  for (const lane of Object.keys(LANE_DIRECTORIES)) {
    const status = runFiles(laneFiles(lane, options.root), options)
    if (status !== 0) return status
  }
  return 0
}

function main (args) {
  if (args[0] === 'all' && args.length === 1) return runAll()
  if (args[0] === 'focus') return runFiles(args.slice(1))
  throw new Error('Usage: run-test-lanes.js all | focus test/<lane>/<file>.test.js ...')
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { LANE_DIRECTORIES, TEST_ARGS, selectFiles, laneFiles, runFiles, runAll }
