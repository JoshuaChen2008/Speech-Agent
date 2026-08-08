'use strict'

// @ts-check

const fs = require('node:fs')
const path = require('node:path')
const {
  parseDwmMatrix,
  validateDwmMatrixCompanions
} = require('./i2-dwm-drag-matrix')

const PROJECT_ROOT = path.resolve(__dirname, '..')

function resolvePath (value, flag) {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${flag} requires a path`)
  return path.resolve(PROJECT_ROOT, value)
}

function parseArguments (argv) {
  if (argv.length < 1) throw new Error('DWM matrix path is required')
  const values = {
    matrix: resolvePath(argv[0], 'matrix'),
    j17Report: null,
    reports: [],
    completions: []
  }
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!['--j17-report', '--report', '--completion'].includes(flag) || value === undefined) {
      throw new Error('usage: node scripts/verify-i2-dwm-drag-matrix.js <matrix.json> --j17-report <report.json> (--report <report.json> --completion <completion.json>) x12')
    }
    if (flag === '--j17-report') {
      if (values.j17Report !== null) throw new Error('--j17-report must be provided once')
      values.j17Report = resolvePath(value, flag)
    } else if (flag === '--report') values.reports.push(resolvePath(value, flag))
    else values.completions.push(resolvePath(value, flag))
  }
  if (!values.j17Report || values.reports.length !== 12 || values.completions.length !== 12) {
    throw new Error('DWM matrix verification requires one J17 report and exactly twelve report/completion pairs')
  }
  const inputPaths = [values.matrix, values.j17Report, ...values.reports, ...values.completions]
  for (const input of inputPaths) {
    if (!fs.statSync(input, { throwIfNoEntry: false })?.isFile()) throw new Error('DWM matrix verification input is missing')
  }
  return values
}

function verifyDwmMatrixFiles (options) {
  const matrix = parseDwmMatrix(fs.readFileSync(options.matrix))
  return validateDwmMatrixCompanions(matrix, {
    j17Bytes: fs.readFileSync(options.j17Report),
    pairs: options.reports.map((report, index) => ({
      reportBytes: fs.readFileSync(report),
      completionBytes: fs.readFileSync(options.completions[index])
    }))
  })
}

if (require.main === module) {
  const matrix = verifyDwmMatrixFiles(parseArguments(process.argv.slice(2)))
  process.stdout.write(`I2 DWM matrix validated (${matrix.coverage.combinationCount} combinations).\n`)
}

module.exports = {
  parseArguments,
  verifyDwmMatrixFiles
}
