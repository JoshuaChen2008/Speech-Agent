'use strict'

// @ts-check

const fs = require('node:fs')
const path = require('node:path')
const { buildDwmMatrix } = require('./i2-dwm-drag-matrix')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const ARTIFACT_ROOT = path.join(PROJECT_ROOT, '.artifacts') + path.sep

function resolvePath (value, flag) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${flag} requires a path`)
  return path.resolve(PROJECT_ROOT, value)
}

function outputPath (value) {
  const resolved = resolvePath(value, '--output')
  if (!resolved.startsWith(ARTIFACT_ROOT)) throw new Error('DWM matrix output must stay under .artifacts')
  return resolved
}

function parseArguments (argv) {
  const values = { output: null, j17Report: null, reports: [], completions: [] }
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!['--output', '--j17-report', '--report', '--completion'].includes(flag) || value === undefined) {
      throw new Error('usage: node scripts/build-i2-dwm-drag-matrix.js --output <matrix.json> --j17-report <report.json> (--report <report.json> --completion <completion.json>) x12')
    }
    if (flag === '--output') {
      if (values.output !== null) throw new Error('--output must be provided once')
      values.output = outputPath(value)
    } else if (flag === '--j17-report') {
      if (values.j17Report !== null) throw new Error('--j17-report must be provided once')
      values.j17Report = resolvePath(value, flag)
    } else if (flag === '--report') values.reports.push(resolvePath(value, flag))
    else values.completions.push(resolvePath(value, flag))
  }
  if (!values.output || !values.j17Report || values.reports.length !== 12 || values.completions.length !== 12) {
    throw new Error('DWM matrix requires one output, one J17 report and exactly twelve report/completion pairs')
  }
  if (fs.existsSync(values.output)) throw new Error('DWM matrix output already exists; refusing to overwrite it')
  const inputPaths = [values.j17Report, ...values.reports, ...values.completions]
  for (const input of inputPaths) {
    if (!fs.statSync(input, { throwIfNoEntry: false })?.isFile()) throw new Error('DWM matrix input is missing')
  }
  if (new Set(inputPaths.map((entry) => entry.toLowerCase())).size !== inputPaths.length) {
    throw new Error('DWM matrix inputs must be distinct files')
  }
  return values
}

function readMatrixInputs (options) {
  return {
    j17Bytes: fs.readFileSync(options.j17Report),
    pairs: options.reports.map((report, index) => ({
      reportBytes: fs.readFileSync(report),
      completionBytes: fs.readFileSync(options.completions[index])
    }))
  }
}

function writeDwmMatrix (options) {
  const matrix = buildDwmMatrix(readMatrixInputs(options))
  fs.mkdirSync(path.dirname(options.output), { recursive: true })
  fs.writeFileSync(options.output, JSON.stringify(matrix, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
  return matrix
}

if (require.main === module) {
  const matrix = writeDwmMatrix(parseArguments(process.argv.slice(2)))
  process.stdout.write(`I2 DWM matrix recorded (${matrix.coverage.combinationCount} combinations).\n`)
}

module.exports = {
  outputPath,
  parseArguments,
  readMatrixInputs,
  writeDwmMatrix
}
