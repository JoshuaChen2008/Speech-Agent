'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { parseStrictEvidenceJson } = require('./strict-evidence-json')
const { readAndValidateCaptionLayoutReport } = require('./verify-caption-layout-report')
const { readAndValidatePackagedRunBindingReport } = require('./verify-packaged-run-binding')
const { validatePackageLayoutReport } = require('./verify-package-layout')
const { validateNsisLifecycleReport } = require('./qualify-nsis-lifecycle')

const SCHEMA = 'ci-qualification-index@v1'
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const REVISION_PATTERN = /^[a-f0-9]{40}$/
const RUN_ID_PATTERN = /^[1-9][0-9]*$/
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const EVENT_NAMES = Object.freeze(['push', 'pull_request', 'workflow_dispatch'])

const FILE_FLAGS = Object.freeze([
  '--report',
  '--caption-layout-report',
  '--packaged-binding-report',
  '--release-layout-report',
  '--nsis-lifecycle-report',
  '--installer',
  '--package-lock',
  '--workflow-file'
])

function exactKeys (value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} keys must be exactly [${wanted.join(', ')}]`)
  }
}

function strictGeneratedAt (value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TypeError('generatedAt must be a canonical UTC timestamp')
  }
  const time = Date.parse(value)
  if (!Number.isSafeInteger(time) || new Date(time).toISOString() !== value) {
    throw new TypeError('generatedAt must be a real canonical UTC timestamp')
  }
}

function sha256File (filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(path.resolve(filePath))).digest('hex')
}

function strictReport (filePath, label) {
  const resolved = path.resolve(filePath)
  return parseStrictEvidenceJson(fs.readFileSync(resolved), `${label} ${path.basename(resolved)}`)
}

function safeIdentity (value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new TypeError(`${label} is invalid`)
  }
}

function validateCiQualificationIndex (report) {
  exactKeys(report, [
    'schema', 'generatedAt', 'result', 'gateStatus',
    'source', 'run', 'evidence', 'boundaries'
  ], 'CI qualification index')

  if (report.schema !== SCHEMA) throw new Error(`schema must be ${SCHEMA}`)
  strictGeneratedAt(report.generatedAt)
  if (report.result !== 'pass' || report.gateStatus !== 'deterministic-ci-qualified') {
    throw new Error('CI qualification index must be pass/deterministic-ci-qualified')
  }

  exactKeys(report.source, [
    'actualRevision', 'expectedRevision', 'exactRevisionMatched',
    'trackedWorktreeClean', 'packageLockSha256', 'workflowSha256'
  ], 'source')
  safeIdentity(report.source.actualRevision, REVISION_PATTERN, 'source.actualRevision')
  safeIdentity(report.source.expectedRevision, REVISION_PATTERN, 'source.expectedRevision')
  if (report.source.actualRevision !== report.source.expectedRevision ||
      report.source.exactRevisionMatched !== true) {
    throw new Error('source revision does not exactly match the expected revision')
  }
  if (report.source.trackedWorktreeClean !== true) {
    throw new Error('tracked worktree must be clean before CI qualification is indexed')
  }
  safeIdentity(report.source.packageLockSha256, SHA256_PATTERN, 'source.packageLockSha256')
  safeIdentity(report.source.workflowSha256, SHA256_PATTERN, 'source.workflowSha256')

  exactKeys(report.run, [
    'repository', 'workflow', 'job', 'event', 'runId', 'runAttempt'
  ], 'run')
  safeIdentity(report.run.repository, REPOSITORY_PATTERN, 'run.repository')
  for (const key of ['workflow', 'job']) {
    if (typeof report.run[key] !== 'string' || !/^[A-Za-z0-9_. -]{1,128}$/.test(report.run[key])) {
      throw new TypeError(`run.${key} is invalid`)
    }
  }
  if (!EVENT_NAMES.includes(report.run.event)) throw new Error('run.event is invalid')
  safeIdentity(report.run.runId, RUN_ID_PATTERN, 'run.runId')
  if (!Number.isSafeInteger(report.run.runAttempt) || report.run.runAttempt < 1) {
    throw new TypeError('run.runAttempt must be a positive integer')
  }

  exactKeys(report.evidence, [
    'captionLayoutReportSha256', 'packagedRunBindingSha256',
    'releaseLayoutReportSha256', 'nsisLifecycleReportSha256', 'installerSha256'
  ], 'evidence')
  for (const [key, value] of Object.entries(report.evidence)) {
    safeIdentity(value, SHA256_PATTERN, `evidence.${key}`)
  }

  exactKeys(report.boundaries, [
    'remoteArtifactOriginRequiresGitHubContext', 'provesCleanMachine',
    'provesDwm', 'provesPhysicalAudio', 'provesSigning'
  ], 'boundaries')
  if (report.boundaries.remoteArtifactOriginRequiresGitHubContext !== true) {
    throw new Error('boundaries.remoteArtifactOriginRequiresGitHubContext must be true')
  }
  for (const key of ['provesCleanMachine', 'provesDwm', 'provesPhysicalAudio', 'provesSigning']) {
    if (report.boundaries[key] !== false) throw new Error(`boundaries.${key} must be false`)
  }

  const serialized = JSON.stringify(report)
  if (/[A-Za-z]:[\\/]/.test(serialized) || /file:\/\//i.test(serialized) ||
      /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)(?:$|[?#"\\/])/i.test(serialized)) {
    throw new Error('CI qualification index leaked a local address or audio reference')
  }
  return report
}

function readAndValidateCiQualificationIndex (reportPath) {
  const resolved = path.resolve(reportPath)
  return validateCiQualificationIndex(parseStrictEvidenceJson(
    fs.readFileSync(resolved),
    `CI qualification index ${path.basename(resolved)}`
  ))
}

function parseFileArguments (argv) {
  const values = {}
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!FILE_FLAGS.includes(flag) || seen.has(flag) || typeof value !== 'string') {
      throw new Error('invalid CI qualification verifier arguments')
    }
    seen.add(flag)
    values[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value
  }
  if (seen.size !== FILE_FLAGS.length) {
    throw new Error(`CI qualification verifier requires ${FILE_FLAGS.join(', ')}`)
  }
  return values
}

function verifyCiQualificationIndexFiles (options) {
  exactKeys(options, [
    'report', 'captionLayoutReport', 'packagedBindingReport', 'releaseLayoutReport',
    'nsisLifecycleReport', 'installer', 'packageLock', 'workflowFile'
  ], 'CI qualification evidence paths')

  const index = readAndValidateCiQualificationIndex(options.report)
  const captionLayout = readAndValidateCaptionLayoutReport(options.captionLayoutReport)
  const packagedBinding = readAndValidatePackagedRunBindingReport(options.packagedBindingReport)
  const releaseLayout = validatePackageLayoutReport(
    strictReport(options.releaseLayoutReport, 'release layout report'),
    'release'
  )
  const nsisLifecycle = validateNsisLifecycleReport(
    strictReport(options.nsisLifecycleReport, 'NSIS lifecycle report'),
    index.evidence.installerSha256
  )

  const expectedDigests = {
    captionLayoutReportSha256: sha256File(options.captionLayoutReport),
    packagedRunBindingSha256: sha256File(options.packagedBindingReport),
    releaseLayoutReportSha256: sha256File(options.releaseLayoutReport),
    nsisLifecycleReportSha256: sha256File(options.nsisLifecycleReport),
    installerSha256: sha256File(options.installer)
  }
  for (const [key, digest] of Object.entries(expectedDigests)) {
    if (index.evidence[key] !== digest) throw new Error(`evidence.${key} does not match its file`)
  }
  if (index.source.packageLockSha256 !== sha256File(options.packageLock) ||
      index.source.workflowSha256 !== sha256File(options.workflowFile)) {
    throw new Error('source lockfile/workflow digest does not match its file')
  }
  if (releaseLayout.artifact.installerSha256 !== index.evidence.installerSha256 ||
      releaseLayout.evidenceBinding.bindingReportSha256 !== index.evidence.packagedRunBindingSha256 ||
      releaseLayout.evidenceBinding.runId !== packagedBinding.run.runId ||
      nsisLifecycle.artifact.installerSha256 !== index.evidence.installerSha256) {
    throw new Error('CI qualification cross-report binding is inconsistent')
  }
  if (captionLayout.boundaries.audioCapture !== false || captionLayout.gateStatus !== 'partial') {
    throw new Error('caption layout evidence overclaims its non-audio boundary')
  }
  return index
}

if (require.main === module) {
  const options = parseFileArguments(process.argv.slice(2))
  const report = verifyCiQualificationIndexFiles(options)
  process.stdout.write(JSON.stringify({
    result: report.result,
    testedRevision: report.source.actualRevision,
    runId: report.run.runId,
    runAttempt: report.run.runAttempt
  }) + '\n')
}

module.exports = {
  EVENT_NAMES,
  FILE_FLAGS,
  REVISION_PATTERN,
  SCHEMA,
  parseFileArguments,
  readAndValidateCiQualificationIndex,
  sha256File,
  validateCiQualificationIndex,
  verifyCiQualificationIndexFiles
}
