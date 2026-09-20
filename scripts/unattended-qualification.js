'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { computeProductPayloadIdentity } = require('../src/main/services/product-payload-identity')
const { readI3ShortStimulus, resolveAuditedModels } = require('./i3-live-audio-soak')
const { qualificationScriptsSha256 } = require('./unattended-qualification-identity')
const { validateUnattendedSummary, verifyI2SeriesV7, verifyI3QualificationV2 } = require('./verify-unattended-qualification')
const { readAndValidateI3NonAudioReport } = require('./verify-i3-nonaudio-report')

const ROOT = path.resolve(__dirname, '..')
const DEFAULT_MODEL_ROOT = '.artifacts/model-install-live-20260731-3/user-data'
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

function sha256File (file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function parseArguments (argv) {
  const options = { modelUserData: DEFAULT_MODEL_ROOT, output: null, preflightOnly: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--preflight-only') options.preflightOnly = true
    else if (arg === '--output' || arg === '--model-user-data') {
      if (!argv[index + 1]) throw new Error(`${arg} requires a value`)
      options[arg === '--output' ? 'output' : 'modelUserData'] = argv[++index]
    } else throw new Error(`unknown argument: ${arg}`)
  }
  if (!options.output) throw new Error('--output is required')
  for (const key of ['output', 'modelUserData']) {
    const resolved = path.resolve(ROOT, options[key])
    const relative = path.relative(ROOT, resolved)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`${key} must remain inside the project workspace`)
    options[key] = resolved
  }
  return options
}

function stage (id, status, code, artifactSha256 = null) {
  return { id, status, code, artifactSha256 }
}

function preflight (options) {
  if (!fs.existsSync(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'))) {
    return stage('preflight', 'blocked', 'electron-missing')
  }
  try { resolveAuditedModels(options.modelUserData) } catch { return stage('preflight', 'blocked', 'model-bundle-missing') }
  try { readI3ShortStimulus() } catch { return stage('preflight', 'blocked', 'controlled-stimulus-missing') }
  return stage('preflight', 'pass', 'ok')
}

function runChild (command, args, timeoutMs) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, TZ: 'UTC' },
    timeout: timeoutMs,
    windowsHide: true
  })
  if (result.error?.code === 'ETIMEDOUT') return { status: 'failed', code: 'stage-timeout' }
  if (result.error || result.status !== 0) return { status: 'failed', code: 'child-nonzero' }
  return { status: 'pass', code: 'ok' }
}

function removeStageArtifact (target) {
  if (!target || !fs.existsSync(target)) return
  fs.rmSync(target, { recursive: fs.lstatSync(target).isDirectory(), force: true })
}

function runVerifiedStage ({ id, command, args, report, cleanup = report, verify = null, timeoutMs = DEFAULT_TIMEOUT_MS, runner = runChild }) {
  if (timeoutMs <= 0) return stage(id, 'failed', 'stage-timeout')
  const outcome = runner(command, args, timeoutMs)
  if (outcome.status !== 'pass') {
    removeStageArtifact(cleanup)
    return stage(id, outcome.status, outcome.code)
  }
  if (!fs.existsSync(report)) {
    removeStageArtifact(cleanup)
    return stage(id, 'failed', 'report-missing')
  }
  try {
    if (verify) verify(report)
  } catch {
    removeStageArtifact(cleanup)
    return stage(id, 'failed', 'report-rejected')
  }
  return stage(id, 'pass', 'ok', sha256File(report))
}

function overallResult (stages) {
  if (stages.every((entry) => entry.status === 'pass')) return 'pass'
  return stages.some((entry) => entry.status === 'failed') ? 'failed' : 'blocked'
}

function buildSummary (stages, now = new Date()) {
  const summary = {
    schemaVersion: 1,
    kind: 'unattended-qualification',
    generatedAt: now.toISOString(),
    result: overallResult(stages),
    candidate: {
      productPayloadSha256: computeProductPayloadIdentity().sha256,
      qualificationScriptsSha256: qualificationScriptsSha256(),
      runnerSha256: sha256File(__filename),
      verifierSha256: sha256File(path.join(__dirname, 'verify-unattended-qualification.js'))
    },
    stages,
    privacy: {
      capturedAudioPersisted: false,
      containsAbsolutePath: false,
      containsCredentials: false,
      containsDeviceName: false,
      containsTranscriptText: false
    },
    remainingBoundaries: [
      'mic', 'device-removal', 'sleep-wake', 'native-pointer-display-matrix', 'two-hour-i3', 'i4', 'clean-machine-release'
    ]
  }
  return validateUnattendedSummary(summary)
}

function run (options, runner = runChild) {
  if (fs.existsSync(options.output)) throw new Error('output must be a fresh directory')
  fs.mkdirSync(options.output, { recursive: false })
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS
  const remainingTimeout = (cap) => Math.max(0, Math.min(cap, deadline - Date.now()))
  const stages = [preflight(options)]
  if (options.preflightOnly) {
    stages.push(stage('deterministic', 'skipped', 'preflight-only'))
    stages.push(stage('i3-qualification', 'skipped', 'preflight-only'))
    stages.push(stage('i2-series', 'skipped', 'preflight-only'))
  } else {
    const nonaudio = path.join(options.output, 'i3-nonaudio.json')
    const deterministic = runVerifiedStage({
      id: 'deterministic', command: process.execPath,
      args: [path.join(__dirname, 'i3-nonaudio-soak.js'), '--segments', '3600', '--batch-size', '100', '--report', nonaudio],
      report: nonaudio, verify: readAndValidateI3NonAudioReport, timeoutMs: remainingTimeout(10 * 60 * 1000), runner
    })
    stages.push(deterministic)
    const audioReady = stages[0].status === 'pass' && deterministic.status === 'pass'
    if (!audioReady) {
      stages.push(stage('i3-qualification', 'skipped', 'dependency-not-passed'))
      stages.push(stage('i2-series', 'skipped', 'dependency-not-passed'))
    } else {
      const i3Report = path.join(options.output, 'i3-qualification.json')
      const i3 = runVerifiedStage({
        id: 'i3-qualification', command: 'powershell.exe',
        args: ['-NoProfile', '-File', path.join(__dirname, 'run-i3-live-audio-soak.ps1'), '-Source', 'loopback', '-Mode', 'qualification', '-TimeoutMinutes', '10', '-ModelUserData', options.modelUserData, '-Report', i3Report],
        report: i3Report, verify: verifyI3QualificationV2, timeoutMs: remainingTimeout(12 * 60 * 1000), runner
      })
      stages.push(i3)
      if (i3.status !== 'pass') stages.push(stage('i2-series', 'skipped', 'dependency-not-passed'))
      else {
        const i2Directory = path.join(options.output, 'i2-series')
        const i2Report = path.join(i2Directory, 'loopback-series.json')
        stages.push(runVerifiedStage({
          id: 'i2-series', command: 'powershell.exe',
          args: ['-NoProfile', '-File', path.join(__dirname, 'run-i2-live-series.ps1'), '-Source', 'loopback', '-RunCount', '5', '-ModelUserData', options.modelUserData, '-OutputDirectory', i2Directory],
          report: i2Report, cleanup: i2Directory, verify: verifyI2SeriesV7, timeoutMs: remainingTimeout(15 * 60 * 1000), runner
        }))
      }
    }
  }
  const summary = buildSummary(stages)
  const summaryFile = path.join(options.output, 'summary.json')
  fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  return { summary, summaryFile }
}

if (require.main === module) {
  const { summaryFile, summary } = run(parseArguments(process.argv.slice(2)))
  process.stdout.write(`${summary.result}: ${path.relative(ROOT, summaryFile).replace(/\\/g, '/')}\n`)
  process.exitCode = summary.result === 'failed' ? 1 : 0
}

module.exports = { buildSummary, overallResult, parseArguments, preflight, removeStageArtifact, run, runChild, runVerifiedStage, stage }
