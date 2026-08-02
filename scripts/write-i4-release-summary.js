'use strict'

// @ts-check

const fs = require('node:fs')
const path = require('node:path')

const {
  buildI4ReleaseSummary,
  readI4ReleaseChildren,
  validateI4ReleaseSummary
} = require('./verify-i4-release-summary')

const ROOT = path.resolve(__dirname, '..')
const ARTIFACT_ROOT = path.join(ROOT, '.artifacts') + path.sep

function parseArguments (argv) {
  const options = {
    layout: null,
    nonAudio: null,
    loopback: null,
    mic: null,
    output: null
  }
  const flags = {
    '--layout': 'layout',
    '--non-audio': 'nonAudio',
    '--loopback': 'loopback',
    '--mic': 'mic',
    '--output': 'output'
  }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flags[flag] || seen.has(flag) || !value || value.startsWith('--')) {
      throw new Error('invalid I4 release summary arguments')
    }
    seen.add(flag)
    options[flags[flag]] = value
  }
  if (Object.values(options).some((value) => typeof value !== 'string' || value.length === 0)) {
    throw new Error('I4 release summary requires --layout --non-audio --loopback --mic --output')
  }
  const output = path.resolve(ROOT, options.output)
  if (!output.toLowerCase().startsWith(ARTIFACT_ROOT.toLowerCase())) {
    throw new Error('I4 release summary output must stay under .artifacts')
  }
  return { ...options, output }
}

function writeI4ReleaseSummary (options) {
  if (fs.existsSync(options.output)) throw new Error('I4 release summary output already exists')
  const children = readI4ReleaseChildren({
    layoutPath: options.layout,
    nonAudioReportPath: options.nonAudio,
    loopbackReportPath: options.loopback,
    micReportPath: options.mic
  })
  const summary = buildI4ReleaseSummary({ generatedAt: new Date().toISOString(), children })
  validateI4ReleaseSummary(summary, children)
  fs.mkdirSync(path.dirname(options.output), { recursive: true })
  fs.writeFileSync(options.output, JSON.stringify(summary, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  return summary
}

if (require.main === module) {
  const options = parseArguments(process.argv.slice(2))
  const summary = writeI4ReleaseSummary(options)
  process.stdout.write(JSON.stringify({ result: summary.result, gateStatus: summary.gateStatus }) + '\n')
}

module.exports = { parseArguments, writeI4ReleaseSummary }
