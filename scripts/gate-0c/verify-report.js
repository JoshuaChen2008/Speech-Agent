'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const {
  analyzeSamples,
  evaluateCaptureChecks,
  evaluateGate0CDecision,
  formatPasses,
  parsePcm16Wav,
  sha256
} = require('./audio-utils')

function parseArguments (argv) {
  const options = { workDir: null, report: null }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    if (argv[index] === '--work-dir' || argv[index] === '--artifact-dir') { options.workDir = value; index += 1 } else if (argv[index] === '--report') { options.report = value; index += 1 } else throw new Error(`Unknown argument: ${argv[index]}`)
  }
  if (!options.report) throw new Error('--report is required')
  return options
}

function main () {
  const options = parseArguments(process.argv.slice(2))
  const report = JSON.parse(fs.readFileSync(path.resolve(options.report), 'utf8'))
  if (report.schemaVersion === 2) {
    for (const sourceId of ['loopback', 'mic', 'mic-probe']) {
      const diagnostic = report.diagnostics?.[sourceId]
      assert.ok(diagnostic, `missing ${sourceId} diagnostic`)
      assert.equal(diagnostic.buffer.channels, 1)
      assert.equal(diagnostic.buffer.sampleRate, 16000)
      assert.equal(diagnostic.buffer.sampleCount, diagnostic.pipeline.sampleCount)
      assert.equal(diagnostic.checks.bufferPass, true)
      assert.equal(diagnostic.checks.pass, true)
      assert.equal(Object.hasOwn(diagnostic, 'artifact'), false)
    }
    const evaluated = evaluateGate0CDecision({
      capture: report.capture,
      diagnostics: report.diagnostics,
      displayRequests: report.displayRequests,
      visibility: report.window.visibility
    })
    assert.equal(report.result, evaluated.result)
    for (const key of Object.keys(evaluated).filter((key) => key !== 'result')) assert.equal(report.decision[key], evaluated[key], `decision.${key} mismatch`)
    assert.equal(evaluated.result, 'pass')
    assert.equal(report.privacy.rawAudioPersisted, false)
    assert.doesNotMatch(JSON.stringify(report), /[A-Za-z]:\\\\|Joshua|A1Project|Speech-Agent2\.0/i)
    process.stdout.write('Gate 0C metrics-only report is internally consistent.\n')
    return
  }

  if (!options.workDir) throw new Error('--work-dir is required for legacy schemaVersion 1 reports')
  const artifactDir = path.resolve(options.workDir)
  for (const sourceId of ['loopback', 'mic', 'mic-probe']) {
    const expected = report.artifacts[sourceId]
    assert.ok(expected, `missing ${sourceId} evidence`)
    assert.equal(path.basename(expected.artifact.file), expected.artifact.file, 'artifact file must be path-free')
    const wav = fs.readFileSync(path.join(artifactDir, expected.artifact.file))
    assert.equal(wav.length, expected.artifact.bytes)
    assert.equal(sha256(wav), expected.artifact.sha256)
    const parsed = parsePcm16Wav(wav)
    const format = Object.fromEntries(Object.keys(expected.format).map((key) => [key, parsed[key]]))
    assert.deepEqual(format, expected.format)
    assert.equal(formatPasses(format), true)
    const analysis = analyzeSamples(
      parsed.samples,
      parsed.sampleRate,
      report.testSignal.frequencyHz,
      expected.pipeline.frameSamples,
      {
        startSeconds: report.testSignal.startDelayMs / 1000,
        durationSeconds: report.testSignal.durationMs / 1000
      }
    )
    assert.deepEqual(analysis, expected.analysis)
    const checks = evaluateCaptureChecks(sourceId, analysis, expected.pipeline, expected.inputPreClampOverRangeCount)
    checks.formatPass = true
    checks.pass = checks.pass && checks.formatPass
    assert.deepEqual(checks, expected.checks)
  }
  assert.notEqual(report.artifacts.loopback.artifact.sha256, report.artifacts.mic.artifact.sha256)
  assert.notEqual(report.artifacts.mic.artifact.sha256, report.artifacts['mic-probe'].artifact.sha256)
  assert.notEqual(report.artifacts.loopback.artifact.sha256, report.artifacts['mic-probe'].artifact.sha256)
  assert.equal(report.capture.mic.selection, 'physical-preferred')
  assert.equal(report.capture.micProbe.selection, 'virtual-cable')
  assert.equal(report.capture.micProbe.capture.playback.output.selected, 'virtual-cable')
  const evaluated = evaluateGate0CDecision({
    capture: report.capture,
    artifacts: report.artifacts,
    displayRequests: report.displayRequests,
    visibility: report.window.visibility
  })
  assert.equal(report.result, evaluated.result)
  for (const key of Object.keys(evaluated).filter((key) => key !== 'result')) assert.equal(report.decision[key], evaluated[key], `decision.${key} mismatch`)
  assert.equal(evaluated.result, 'pass')
  assert.doesNotMatch(JSON.stringify(report), /[A-Za-z]:\\\\|Joshua|A1Project|Speech-Agent2\.0/i)
  process.stdout.write('Legacy Gate 0C artifacts and report match.\n')
}

try {
  main()
} catch (error) {
  console.error(error?.stack || error)
  process.exitCode = 1
}
