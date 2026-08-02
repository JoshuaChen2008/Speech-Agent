'use strict'

/* Records only that the operator completed the external device or sleep/wake
 * action requested by the live runner. Product fault, capture release,
 * no-auto-reacquire, Retry, caption, SQLite and transport evidence are all
 * observed independently by the Electron runner. */

const fs = require('node:fs')
const path = require('node:path')
const {
  RECOVERY_SCENARIOS,
  parseRecoveryOperatorCompletion,
  recoveryOperatorCompletion
} = require('./i2-interaction-protocol')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const ARTIFACT_ROOT = path.join(PROJECT_ROOT, '.artifacts') + path.sep

function parseArguments (argv) {
  if (argv.length !== 4 || argv[0] !== '--scenario' || argv[2] !== '--completion') {
    throw new Error('usage: node scripts/complete-i2-recovery-action.js --scenario <device-removal-retry|sleep-wake-retry> --completion .artifacts/<run>/completion.json')
  }
  if (!RECOVERY_SCENARIOS.includes(argv[1])) throw new Error('recovery completion scenario is invalid')
  const resolved = path.resolve(PROJECT_ROOT, argv[3])
  if (!resolved.toLowerCase().startsWith(ARTIFACT_ROOT.toLowerCase())) {
    throw new Error('completion must stay under .artifacts')
  }
  return { scenario: argv[1], completion: resolved }
}

function writeCompletion ({ scenario, completion }) {
  const value = recoveryOperatorCompletion({ scenario })
  parseRecoveryOperatorCompletion(Buffer.from(JSON.stringify(value)), scenario)
  if (fs.existsSync(completion)) throw new Error('completion already exists; refusing to overwrite it')
  fs.mkdirSync(path.dirname(completion), { recursive: true })
  fs.writeFileSync(completion, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  return value
}

if (require.main === module) {
  const options = parseArguments(process.argv.slice(2))
  writeCompletion(options)
  process.stdout.write(`I2 ${options.scenario} operator action completion recorded.\n`)
}

module.exports = { parseArguments, writeCompletion }
