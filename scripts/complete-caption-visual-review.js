'use strict'

/*
 * External operator hand-off for the visible, non-audio J15a DWM review.
 * Running this command is the explicit attestation that all six frozen visual
 * checks were observed for the exact theme/background/scale combination.
 */

const fs = require('node:fs')
const path = require('node:path')

const {
  buildOperatorCompletion,
  parseCompletionArguments,
  parseOperatorCompletion
} = require('./caption-visual-review-protocol')

function writeCompletion (options) {
  const completion = buildOperatorCompletion({
    scalePercent: options.scalePercent,
    theme: options.theme,
    background: options.background
  })
  parseOperatorCompletion(Buffer.from(JSON.stringify(completion)), completion.combination)
  if (fs.existsSync(options.completion)) throw new Error('completion already exists; refusing to overwrite it')
  if (!fs.statSync(path.dirname(options.completion), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('completion parent directory must already exist; start the visual runner first')
  }
  fs.writeFileSync(options.completion, JSON.stringify(completion, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'wx'
  })
  return completion
}

if (require.main === module) {
  const options = parseCompletionArguments(process.argv.slice(2))
  writeCompletion(options)
  process.stdout.write('Caption visual review operator completion recorded.\n')
}

module.exports = { writeCompletion }
