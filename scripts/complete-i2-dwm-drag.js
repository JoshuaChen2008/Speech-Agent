'use strict'

/* The helper records one explicitly reviewed scale/theme observation. It reads
 * the runner-owned progress binding, asks about every closed checklist item,
 * and writes only the bounded attestation. It never receives window geometry,
 * device labels, caption text, audio, or local paths in the JSON payload. */

const fs = require('node:fs')
const path = require('node:path')
const readline = require('node:readline/promises')
const {
  DWM_OBSERVATION_CHECKLIST,
  DWM_OBSERVATION_IDS,
  dwmOperatorCompletion,
  parseOperatorCompletion,
  validateDwmProgress
} = require('./i2-interaction-protocol')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const ARTIFACT_ROOT = path.join(PROJECT_ROOT, '.artifacts') + path.sep

function artifactPath (value, flag) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${flag} requires a path`)
  const resolved = path.resolve(PROJECT_ROOT, value)
  if (!resolved.startsWith(ARTIFACT_ROOT)) throw new Error(`${flag.slice(2)} must stay under .artifacts`)
  return resolved
}

function completionPath (value) {
  return artifactPath(value, '--completion')
}

function parseArguments (argv) {
  if (argv.length !== 4 || argv[0] !== '--progress' || argv[2] !== '--completion') {
    throw new Error('usage: node scripts/complete-i2-dwm-drag.js --progress .artifacts/<run>/progress.json --completion .artifacts/<run>/completion.json')
  }
  const progress = artifactPath(argv[1], '--progress')
  const completion = completionPath(argv[3])
  if (progress.toLowerCase() === completion.toLowerCase()) throw new Error('progress and completion paths must be distinct')
  return { progress, completion }
}

function completionFromProgress ({ progress, confirmations, crossScaleObserved = false }) {
  validateDwmProgress(progress)
  if (progress.schemaVersion !== 5 || progress.state !== 'awaiting-operator-completion' ||
      progress.operatorCompletionObserved !== false) {
    throw new Error('DWM completion requires schema-v5 awaiting-operator-completion progress')
  }
  return dwmOperatorCompletion({
    confirmations,
    runBindingSha256: progress.runBindingSha256,
    productPayloadVersion: progress.productPayloadVersion,
    productPayloadFileCount: progress.productPayloadFileCount,
    productPayloadSha256: progress.productPayloadSha256,
    combination: progress.combination,
    crossScaleObserved
  })
}

function operatorPromptForObservation (id) {
  if (!DWM_OBSERVATION_IDS.includes(id)) throw new Error(`unknown DWM observation ID: ${id}`)
  const instruction = DWM_OBSERVATION_CHECKLIST[id]
  if (typeof instruction !== 'string' || instruction.length === 0) {
    throw new Error(`missing operator checklist for DWM observation: ${id}`)
  }
  return `Confirm ${id}: ${instruction} [type yes]: `
}

function writeCompletion ({ completion, progress, confirmations, crossScaleObserved = false }) {
  const value = completionFromProgress({ progress, confirmations, crossScaleObserved })
  parseOperatorCompletion(Buffer.from(JSON.stringify(value)))
  if (fs.existsSync(completion)) throw new Error('completion already exists; refusing to overwrite it')
  fs.mkdirSync(path.dirname(completion), { recursive: true })
  fs.writeFileSync(completion, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  return value
}

async function runInteractive (options) {
  const progress = validateDwmProgress(parseStrictEvidenceJson(
    fs.readFileSync(options.progress),
    'DWM progress hand-off'
  ))
  const prompt = readline.createInterface({ input: process.stdin, output: process.stdout })
  const confirmations = []
  try {
    for (const id of DWM_OBSERVATION_IDS) {
      const answer = (await prompt.question(operatorPromptForObservation(id))).trim().toLowerCase()
      if (answer !== 'yes') throw new Error(`observation was not confirmed: ${id}`)
      confirmations.push(id)
    }
    const crossScaleAnswer = (await prompt.question(
      'Confirm a different-scale display move and repeated critical hit matrix [yes/no]: '
    )).trim().toLowerCase()
    if (!['yes', 'no'].includes(crossScaleAnswer)) throw new Error('cross-scale answer must be yes or no')
    return writeCompletion({
      completion: options.completion,
      progress,
      confirmations,
      crossScaleObserved: crossScaleAnswer === 'yes'
    })
  } finally {
    prompt.close()
  }
}

if (require.main === module) {
  void runInteractive(parseArguments(process.argv.slice(2))).then(() => {
    process.stdout.write('DWM scale/theme observation recorded.\n')
  })
}

module.exports = {
  completionFromProgress,
  completionPath,
  operatorPromptForObservation,
  parseArguments,
  runInteractive,
  writeCompletion
}
