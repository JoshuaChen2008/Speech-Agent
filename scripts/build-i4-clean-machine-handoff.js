'use strict'

// @ts-check

const fs = require('node:fs')
const path = require('node:path')

const { readTrackedLayoutEvidence } = require('./verify-i4-nonaudio-nsis-report')
const {
  EXPECTED_LEGACY_FIXTURE_SHA256,
  EXPECTED_LIMITATIONS,
  readAndValidateI4Handoff,
  sha256Bytes
} = require('./verify-i4-clean-machine-handoff')

const ROOT = path.resolve(__dirname, '..')
const ARTIFACT_ROOT = path.join(ROOT, '.artifacts') + path.sep
const PAYLOAD_SOURCES = Object.freeze([
  ['evidence/b5-packaged-layout-results.json', 'b5-layout', 'layout'],
  ['fixtures/i4-nonaudio-legacy-session.jsonl', 'legacy-fixture', path.join(ROOT, 'scripts', 'fixtures', 'i4-nonaudio-legacy-session.jsonl')],
  ['runners/qualify-i4-audio-child.ps1', 'audio-runner', path.join(ROOT, 'scripts', 'qualify-i4-audio-child.ps1')],
  ['runners/qualify-i4-nonaudio-nsis.ps1', 'non-audio-runner', path.join(ROOT, 'scripts', 'qualify-i4-nonaudio-nsis.ps1')],
  ['verifiers/verify-i4-clean-machine-handoff.ps1', 'handoff-verifier', path.join(ROOT, 'scripts', 'verify-i4-clean-machine-handoff.ps1')]
])

function parseArguments (argv) {
  const values = { installer: null, layout: null, output: null }
  const flags = { '--installer': 'installer', '--layout': 'layout', '--output': 'output' }
  const seen = new Set()
  if (argv.length !== 6) throw new Error('I4 handoff requires --installer --layout --output')
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!flags[flag] || seen.has(flag) || !value || value.startsWith('--')) {
      throw new Error('invalid I4 handoff arguments')
    }
    seen.add(flag)
    values[flags[flag]] = value
  }
  const output = path.resolve(ROOT, values.output)
  if (!output.toLowerCase().startsWith(ARTIFACT_ROOT.toLowerCase()) ||
      output.toLowerCase() === ARTIFACT_ROOT.slice(0, -1).toLowerCase()) {
    throw new Error('I4 handoff output must be a child of .artifacts')
  }
  return {
    installer: path.resolve(ROOT, values.installer),
    layout: path.resolve(ROOT, values.layout),
    output
  }
}

function buildI4CleanMachineHandoff ({ installer, layout, output, generatedAt = new Date().toISOString() }) {
  const resolvedOutput = path.resolve(output)
  if (!resolvedOutput.toLowerCase().startsWith(ARTIFACT_ROOT.toLowerCase()) ||
      resolvedOutput.toLowerCase() === ARTIFACT_ROOT.slice(0, -1).toLowerCase()) {
    throw new Error('I4 handoff output must stay under .artifacts')
  }
  if (fs.existsSync(resolvedOutput)) throw new Error('I4 handoff output already exists')
  const installerBytes = fs.readFileSync(path.resolve(installer))
  const layoutBytes = fs.readFileSync(path.resolve(layout))
  const layoutEvidence = readTrackedLayoutEvidence(layout)
  const installerSha256 = sha256Bytes(installerBytes)
  if (installerSha256 !== layoutEvidence.layout.artifact.installerSha256) {
    throw new Error('installer differs from the exact B5 layout candidate')
  }

  const installerName = path.basename(path.resolve(installer))
  if (!/^Live-Subtitle-[0-9A-Za-z._-]+-x64\.exe$/.test(installerName)) {
    throw new Error('installer file name is not the expected versioned x64 NSIS artifact')
  }
  const sources = [
    [`installer/${installerName}`, 'installer', installerBytes],
    ...PAYLOAD_SOURCES.map(([relativePath, role, source]) => [
      relativePath,
      role,
      source === 'layout' ? layoutBytes : fs.readFileSync(source)
    ])
  ]
  const files = sources.map(([relativePath, role, bytes]) => ({
    relativePath,
    role,
    bytes: bytes.length,
    sha256: sha256Bytes(bytes)
  })).sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  const layoutArtifact = layoutEvidence.layout.artifact
  const fixtureEntry = files.find((entry) =>
    entry.relativePath === 'fixtures/i4-nonaudio-legacy-session.jsonl')
  if (!fixtureEntry || fixtureEntry.sha256 !== EXPECTED_LEGACY_FIXTURE_SHA256) {
    throw new Error('I4 handoff legacy fixture differs from the fixed synthetic fixture')
  }
  const manifest = {
    schemaVersion: 1,
    kind: 'i4-clean-machine-handoff',
    generatedAt,
    result: 'pass',
    artifact: {
      b5LayoutEvidenceSha256: layoutEvidence.sha256,
      installerSha256,
      productPayloadVersion: layoutArtifact.productPayloadVersion,
      productPayloadFileCount: layoutArtifact.productPayloadFileCount,
      productPayloadSha256: layoutArtifact.productPayloadSha256,
      exactCandidateBound: true
    },
    files,
    constraints: {
      entryCount: files.length,
      extraEntryCount: 0,
      repositoryTreeIncluded: false,
      nodeRuntimeIncluded: false
    },
    privacy: {
      capturedAudioFileCount: 0,
      capturedOrReportTranscriptTextIncluded: false,
      containsDeviceName: false,
      containsAbsolutePath: false,
      fixedSyntheticLegacyFixtureIncluded: true,
      fixedSyntheticLegacyFixtureSha256: fixtureEntry.sha256
    },
    limitations: [...EXPECTED_LIMITATIONS]
  }

  fs.mkdirSync(resolvedOutput, { recursive: false })
  for (const [relativePath, , bytes] of sources) {
    const target = path.join(resolvedOutput, ...relativePath.split('/'))
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes, { flag: 'wx' })
  }
  fs.writeFileSync(
    path.join(resolvedOutput, 'handoff-manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
    { encoding: 'utf8', flag: 'wx' }
  )
  return readAndValidateI4Handoff(resolvedOutput)
}

if (require.main === module) {
  const options = parseArguments(process.argv.slice(2))
  const evidence = buildI4CleanMachineHandoff(options)
  process.stdout.write(JSON.stringify({
    result: evidence.manifest.result,
    manifestSha256: evidence.sha256,
    output: path.relative(ROOT, options.output).split(path.sep).join('/')
  }) + '\n')
}

module.exports = { PAYLOAD_SOURCES, buildI4CleanMachineHandoff, parseArguments }
