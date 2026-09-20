'use strict'

const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { computeProductPayloadIdentity } = require('../src/main/services/product-payload-identity')
const { parseStrictEvidenceJson } = require('./strict-evidence-json')
const { readAndValidateI3NonAudioReport } = require('./verify-i3-nonaudio-report')
const { readAndValidateI3LiveAudioQualificationReport } = require('./verify-i3-live-audio-report')
const { summarizeI2LiveSeries } = require('./summarize-i2-live-series')
const { qualificationScriptsSha256 } = require('./unattended-qualification-identity')

const STAGE_IDS = Object.freeze(['preflight', 'deterministic', 'i3-qualification', 'i2-series'])
const STATUSES = new Set(['pass', 'blocked', 'failed', 'skipped'])
const SHA256 = /^[a-f0-9]{64}$/
const CODES = new Set([
  'ok', 'preflight-only', 'dependency-not-passed', 'electron-missing', 'model-bundle-missing',
  'controlled-stimulus-missing', 'child-nonzero', 'stage-timeout', 'report-missing', 'report-rejected'
])

function sha256File (file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function requireUnattendedSchema (report, expected, label) {
  assert.equal(report.schemaVersion, expected, `${label} must use schema ${expected}`)
  return report
}

function verifyI3QualificationV2 (file) {
  return requireUnattendedSchema(readAndValidateI3LiveAudioQualificationReport(file), 2, 'I3 qualification')
}

function verifyI2SeriesV7 (summaryPath) {
  const seriesDirectory = path.dirname(summaryPath)
  const inputs = [1, 2, 3, 4, 5].map((run) => fs.readFileSync(path.join(seriesDirectory, `loopback-${run}.json`)))
  const exitEvidenceInputs = [1, 2, 3, 4, 5].map((run) => fs.readFileSync(path.join(seriesDirectory, `loopback-${run}.exit.json`)))
  const rebuilt = summarizeI2LiveSeries(inputs, exitEvidenceInputs, 'loopback', 5)
  requireUnattendedSchema(rebuilt, 7, 'I2 series')
  inputs.forEach((bytes, index) => requireUnattendedSchema(parseStrictEvidenceJson(bytes, `I2 child ${index + 1}`), 6, `I2 child ${index + 1}`))
  assert.deepEqual(parseStrictEvidenceJson(fs.readFileSync(summaryPath), 'I2 unattended series summary'), rebuilt)
  return rebuilt
}

function scanOutputDirectory (directory) {
  const allowedDirectories = /^(?:i2-series|i2-series\/loopback-[1-5]-logs)$/
  const allowedFiles = /^(?:summary\.json|i3-nonaudio\.json|i3-qualification\.json|i2-series\/loopback-series\.json|i2-series\/loopback-[1-5](?:\.exit)?\.json|i2-series\/loopback-[1-5]-logs\/i2-live-caption-smoke-\d{8}-\d{6}-\d{3}\.(?:stdout|stderr)\.log)$/
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name)
      const relative = path.relative(directory, target).replace(/\\/g, '/')
      const stats = fs.lstatSync(target)
      assert.equal(stats.isSymbolicLink(), false, `qualification output contains a symbolic link: ${relative}`)
      assert.doesNotMatch(relative, /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)$/i, `qualification output contains audio: ${relative}`)
      if (entry.isDirectory()) {
        assert.match(relative, allowedDirectories, `qualification output contains an unknown directory: ${relative}`)
        visit(target)
      } else {
        assert.ok(entry.isFile(), `qualification output contains an unsupported entry: ${relative}`)
        assert.match(relative, allowedFiles, `qualification output contains an unknown file: ${relative}`)
      }
    }
  }
  visit(directory)
}

function exactKeys (value, keys, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`)
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} has unexpected keys`)
}

function assertSafe (value, key = 'summary') {
  if (typeof value === 'string') {
    assert.doesNotMatch(value, /(?:[A-Za-z]:[\\/]|^\\\\|file:\/\/|\/(?:Users|home|tmp|var|etc|mnt)\/)/i, `${key} contains an absolute path`)
    assert.doesNotMatch(value, /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)(?:$|[?#\s])/i, `${key} references audio`)
    return
  }
  if (Array.isArray(value)) return value.forEach((item, index) => assertSafe(item, `${key}[${index}]`))
  if (!value || typeof value !== 'object') return
  for (const [nestedKey, nested] of Object.entries(value)) {
    assert.doesNotMatch(nestedKey, /^(?:absolutePath|filePath|deviceName|transcript|transcriptText|captionText|audioFile|audioFilePath|pcm|credential|clockOffset|monotonicTimestamp)$/i, `${key}.${nestedKey} is forbidden`)
    assertSafe(nested, `${key}.${nestedKey}`)
  }
}

function validateUnattendedSummary (summary) {
  exactKeys(summary, ['schemaVersion', 'kind', 'generatedAt', 'result', 'candidate', 'stages', 'privacy', 'remainingBoundaries'], 'summary')
  assert.equal(summary.schemaVersion, 1)
  assert.equal(summary.kind, 'unattended-qualification')
  assert.match(summary.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  assert.ok(STATUSES.has(summary.result) && summary.result !== 'skipped')
  exactKeys(summary.candidate, ['productPayloadSha256', 'qualificationScriptsSha256', 'runnerSha256', 'verifierSha256'], 'candidate')
  for (const value of Object.values(summary.candidate)) assert.match(value, SHA256)
  assert.ok(Array.isArray(summary.stages) && summary.stages.length === STAGE_IDS.length)
  summary.stages.forEach((stage, index) => {
    exactKeys(stage, ['id', 'status', 'code', 'artifactSha256'], `stages[${index}]`)
    assert.equal(stage.id, STAGE_IDS[index])
    assert.ok(STATUSES.has(stage.status))
    assert.ok(CODES.has(stage.code))
    if (stage.artifactSha256 !== null) assert.match(stage.artifactSha256, SHA256)
    if (stage.status === 'pass' && stage.id !== 'preflight') assert.match(stage.artifactSha256, SHA256)
    if (stage.status !== 'pass') assert.equal(stage.artifactSha256, null)
    const codesByStatus = {
      pass: ['ok'],
      blocked: ['electron-missing', 'model-bundle-missing', 'controlled-stimulus-missing'],
      failed: ['child-nonzero', 'stage-timeout', 'report-missing', 'report-rejected'],
      skipped: ['preflight-only', 'dependency-not-passed']
    }
    assert.ok(codesByStatus[stage.status].includes(stage.code), `${stage.id} code does not match status`)
  })
  const [preflightStage, deterministicStage, i3Stage, i2Stage] = summary.stages
  assert.ok(['pass', 'blocked'].includes(preflightStage.status), 'preflight stage has an impossible status')
  const preflightOnly = [deterministicStage, i3Stage, i2Stage].every((entry) => entry.status === 'skipped' && entry.code === 'preflight-only')
  if (!preflightOnly) {
    assert.ok(['pass', 'failed'].includes(deterministicStage.status), 'deterministic stage must run outside preflight-only mode')
    const audioDependenciesPassed = preflightStage.status === 'pass' && deterministicStage.status === 'pass'
    if (!audioDependenciesPassed) {
      assert.deepEqual([i3Stage.status, i3Stage.code, i2Stage.status, i2Stage.code],
        ['skipped', 'dependency-not-passed', 'skipped', 'dependency-not-passed'])
    } else if (i3Stage.status !== 'pass') {
      assert.equal(i3Stage.status, 'failed', 'I3 stage has an impossible status after its dependencies pass')
      assert.deepEqual([i2Stage.status, i2Stage.code], ['skipped', 'dependency-not-passed'])
    } else {
      assert.ok(['pass', 'failed'].includes(i2Stage.status), 'I2 stage must run after I3 passes')
    }
  }
  exactKeys(summary.privacy, ['capturedAudioPersisted', 'containsAbsolutePath', 'containsCredentials', 'containsDeviceName', 'containsTranscriptText'], 'privacy')
  assert.deepEqual(summary.privacy, {
    capturedAudioPersisted: false,
    containsAbsolutePath: false,
    containsCredentials: false,
    containsDeviceName: false,
    containsTranscriptText: false
  })
  assert.deepEqual(summary.remainingBoundaries, [
    'mic', 'device-removal', 'sleep-wake', 'native-pointer-display-matrix', 'two-hour-i3', 'i4', 'clean-machine-release'
  ])
  assertSafe(summary)
  const statuses = summary.stages.map((stage) => stage.status)
  const expected = statuses.every((status) => status === 'pass')
    ? 'pass'
    : statuses.includes('failed') ? 'failed' : 'blocked'
  assert.equal(summary.result, expected)
  return summary
}

function readAndValidateUnattendedSummary (file) {
  const resolved = path.resolve(file)
  const summary = validateUnattendedSummary(parseStrictEvidenceJson(fs.readFileSync(resolved), 'unattended qualification summary'))
  assert.deepEqual(summary.candidate, {
    productPayloadSha256: computeProductPayloadIdentity().sha256,
    qualificationScriptsSha256: qualificationScriptsSha256(),
    runnerSha256: sha256File(path.join(__dirname, 'unattended-qualification.js')),
    verifierSha256: sha256File(__filename)
  }, 'unattended qualification candidate identity is stale')
  const directory = path.dirname(resolved)
  scanOutputDirectory(directory)
  const expectedStageArtifacts = {
    deterministic: path.join(directory, 'i3-nonaudio.json'),
    'i3-qualification': path.join(directory, 'i3-qualification.json'),
    'i2-series': path.join(directory, 'i2-series')
  }
  for (const [stageId, artifact] of Object.entries(expectedStageArtifacts)) {
    const passed = summary.stages.find((stage) => stage.id === stageId).status === 'pass'
    assert.equal(fs.existsSync(artifact), passed, `${stageId} artifact presence does not match stage status`)
  }
  const verifyArtifact = (stageId, relativeName, verifier) => {
    const entry = summary.stages.find((stage) => stage.id === stageId)
    if (entry.status !== 'pass') return
    const artifact = path.join(directory, relativeName)
    assert.ok(fs.existsSync(artifact), `${stageId} artifact is missing`)
    assert.equal(sha256File(artifact), entry.artifactSha256, `${stageId} artifact digest drifted`)
    verifier(artifact)
  }
  verifyArtifact('deterministic', 'i3-nonaudio.json', readAndValidateI3NonAudioReport)
  verifyArtifact('i3-qualification', 'i3-qualification.json', verifyI3QualificationV2)
  const i2 = summary.stages.find((stage) => stage.id === 'i2-series')
  if (i2.status === 'pass') {
    const summaryPath = path.join(directory, 'i2-series', 'loopback-series.json')
    assert.equal(sha256File(summaryPath), i2.artifactSha256, 'i2-series artifact digest drifted')
    verifyI2SeriesV7(summaryPath)
  }
  return summary
}

if (require.main === module) {
  if (process.argv.length !== 3) throw new Error('usage: node scripts/verify-unattended-qualification.js <summary.json>')
  const summary = readAndValidateUnattendedSummary(process.argv[2])
  process.stdout.write(`${summary.result}\n`)
}

module.exports = {
  CODES,
  STAGE_IDS,
  readAndValidateUnattendedSummary,
  requireUnattendedSchema,
  scanOutputDirectory,
  validateUnattendedSummary,
  verifyI2SeriesV7,
  verifyI3QualificationV2
}
