'use strict'

/* Write the bounded manual-observation hand-off only after an operator has
 * actually dragged the visible DWM harness.  This utility has no Electron,
 * audio, network, shell, or arbitrary-file capability. */

const fs = require('node:fs')
const path = require('node:path')
const { parseOperatorCompletion } = require('./i2-interaction-protocol')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const ARTIFACT_ROOT = path.join(PROJECT_ROOT, '.artifacts') + path.sep

function completionPath (value) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error('--completion requires a path')
  const resolved = path.resolve(PROJECT_ROOT, value)
  if (!resolved.startsWith(ARTIFACT_ROOT)) throw new Error('completion must stay under .artifacts')
  return resolved
}

function writeCompletion (filePath) {
  const completion = {
    schemaVersion: 1,
    kind: 'i2-dwm-drag-operator-completion',
    scenario: 'dwm-drag',
    observed: true
  }
  parseOperatorCompletion(Buffer.from(JSON.stringify(completion)))
  if (fs.existsSync(filePath)) throw new Error('completion already exists; refusing to overwrite it')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(completion, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  return completion
}

if (require.main === module) {
  const argv = process.argv.slice(2)
  if (argv.length !== 2 || argv[0] !== '--completion') {
    throw new Error('usage: node scripts/complete-i2-dwm-drag.js --completion .artifacts/<run>/completion.json')
  }
  writeCompletion(completionPath(argv[1]))
  process.stdout.write('DWM drag operator completion recorded.\n')
}

module.exports = { completionPath, writeCompletion }
