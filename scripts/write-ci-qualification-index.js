'use strict'

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const {
  EVENT_NAMES,
  REVISION_PATTERN,
  sha256File,
  validateCiQualificationIndex,
  verifyCiQualificationIndexFiles
} = require('./verify-ci-qualification-index')

const ROOT = path.resolve(__dirname, '..')
const ARGUMENTS = Object.freeze([
  '--expected-revision', '--run-id', '--run-attempt', '--event-name',
  '--repository', '--workflow-name', '--job-name', '--report',
  '--caption-layout-report', '--packaged-binding-report', '--release-layout-report',
  '--nsis-lifecycle-report', '--installer', '--package-lock', '--workflow-file'
])

function camelCaseFlag (flag) {
  return flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
}

function parseArguments (argv) {
  const values = {}
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!ARGUMENTS.includes(flag) || seen.has(flag) || typeof value !== 'string') {
      throw new Error('invalid CI qualification writer arguments')
    }
    seen.add(flag)
    values[camelCaseFlag(flag)] = value
  }
  if (seen.size !== ARGUMENTS.length) {
    throw new Error(`CI qualification writer requires ${ARGUMENTS.join(', ')}`)
  }
  values.runAttempt = Number(values.runAttempt)
  return values
}

function readGitFacts (cwd = ROOT) {
  const actualRevision = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true
  }).trim().toLowerCase()
  const trackedStatus = execFileSync('git', [
    'status', '--porcelain=v1', '--untracked-files=no'
  ], {
    cwd,
    encoding: 'utf8',
    windowsHide: true
  }).trim()
  return { actualRevision, trackedWorktreeClean: trackedStatus === '' }
}

function createCiQualificationIndex (options, gitFacts, generatedAt = new Date().toISOString()) {
  if (!REVISION_PATTERN.test(String(options.expectedRevision || '').toLowerCase())) {
    throw new TypeError('expected revision must be a 40-character Git object ID')
  }
  if (!REVISION_PATTERN.test(String(gitFacts.actualRevision || '')) ||
      gitFacts.actualRevision !== options.expectedRevision.toLowerCase()) {
    throw new Error('actual checkout revision does not match expected GITHUB_SHA')
  }
  if (gitFacts.trackedWorktreeClean !== true) {
    throw new Error('tracked worktree changed during CI qualification')
  }
  if (!EVENT_NAMES.includes(options.eventName)) throw new Error('unsupported GitHub event')

  return validateCiQualificationIndex({
    schema: 'ci-qualification-index@v1',
    generatedAt,
    result: 'pass',
    gateStatus: 'deterministic-ci-qualified',
    source: {
      actualRevision: gitFacts.actualRevision,
      expectedRevision: options.expectedRevision.toLowerCase(),
      exactRevisionMatched: true,
      trackedWorktreeClean: true,
      packageLockSha256: sha256File(options.packageLock),
      workflowSha256: sha256File(options.workflowFile)
    },
    run: {
      repository: options.repository,
      workflow: options.workflowName,
      job: options.jobName,
      event: options.eventName,
      runId: options.runId,
      runAttempt: options.runAttempt
    },
    evidence: {
      captionLayoutReportSha256: sha256File(options.captionLayoutReport),
      packagedRunBindingSha256: sha256File(options.packagedBindingReport),
      releaseLayoutReportSha256: sha256File(options.releaseLayoutReport),
      nsisLifecycleReportSha256: sha256File(options.nsisLifecycleReport),
      installerSha256: sha256File(options.installer)
    },
    boundaries: {
      remoteArtifactOriginRequiresGitHubContext: true,
      provesCleanMachine: false,
      provesDwm: false,
      provesPhysicalAudio: false,
      provesSigning: false
    }
  })
}

function writeCiQualificationIndex (options, gitFacts = readGitFacts()) {
  const report = createCiQualificationIndex(options, gitFacts)
  const target = path.resolve(options.report)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (fs.existsSync(target)) throw new Error('refusing to overwrite an existing CI qualification index')

  const staging = `${target}.staging-${process.pid}`
  try {
    fs.writeFileSync(staging, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
    const verified = verifyCiQualificationIndexFiles({
      report: staging,
      captionLayoutReport: options.captionLayoutReport,
      packagedBindingReport: options.packagedBindingReport,
      releaseLayoutReport: options.releaseLayoutReport,
      nsisLifecycleReport: options.nsisLifecycleReport,
      installer: options.installer,
      packageLock: options.packageLock,
      workflowFile: options.workflowFile
    })
    fs.renameSync(staging, target)
    return verified
  } catch (error) {
    try { fs.rmSync(staging, { force: true }) } catch {}
    throw error
  }
}

if (require.main === module) {
  const options = parseArguments(process.argv.slice(2))
  const report = writeCiQualificationIndex(options)
  process.stdout.write(JSON.stringify({
    result: report.result,
    testedRevision: report.source.actualRevision,
    runId: report.run.runId,
    runAttempt: report.run.runAttempt
  }) + '\n')
}

module.exports = {
  ARGUMENTS,
  createCiQualificationIndex,
  parseArguments,
  readGitFacts,
  writeCiQualificationIndex
}
