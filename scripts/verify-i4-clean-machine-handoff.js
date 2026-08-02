'use strict'

// @ts-check

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const { parseStrictEvidenceJson } = require('./strict-evidence-json')

const EXPECTED_FIXED_FILES = Object.freeze({
  'evidence/b5-packaged-layout-results.json': 'b5-layout',
  'fixtures/i4-nonaudio-legacy-session.jsonl': 'legacy-fixture',
  'runners/qualify-i4-audio-child.ps1': 'audio-runner',
  'runners/qualify-i4-nonaudio-nsis.ps1': 'non-audio-runner',
  'verifiers/verify-i4-clean-machine-handoff.ps1': 'handoff-verifier'
})
const EXPECTED_LIMITATIONS = Object.freeze([
  'unsigned-installer',
  'fixed-synthetic-legacy-fixture-included',
  'clean-machine-execution-not-yet-run'
])
const EXPECTED_LEGACY_FIXTURE_SHA256 = '7877d33c271546b2e3171814abb0b86b1bf8593ff2a7b96e138d17893a4ea348'
const SHA256_PATTERN = /^[a-f0-9]{64}$/
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

function exactKeys (value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`)
  }
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has unexpected keys`)
  }
  return value
}

function sha256Bytes (bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function requireSha256 (value, label) {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`)
  }
}

function validateI4HandoffManifest (manifest, fileEvidence) {
  exactKeys(fileEvidence, ['files'], 'handoff file evidence')
  exactKeys(manifest, [
    'artifact', 'constraints', 'files', 'generatedAt', 'kind', 'limitations',
    'privacy', 'result', 'schemaVersion'
  ], 'I4 handoff manifest')
  if (manifest.schemaVersion !== 1 || manifest.kind !== 'i4-clean-machine-handoff' ||
      manifest.result !== 'pass' || typeof manifest.generatedAt !== 'string' ||
      !UTC_PATTERN.test(manifest.generatedAt) ||
      new Date(Date.parse(manifest.generatedAt)).toISOString() !== manifest.generatedAt) {
    throw new Error('invalid I4 handoff manifest envelope')
  }

  exactKeys(manifest.artifact, [
    'b5LayoutEvidenceSha256', 'exactCandidateBound', 'installerSha256',
    'productPayloadFileCount', 'productPayloadSha256', 'productPayloadVersion'
  ], 'artifact')
  for (const key of ['b5LayoutEvidenceSha256', 'installerSha256', 'productPayloadSha256']) {
    requireSha256(manifest.artifact[key], `artifact.${key}`)
  }
  if (manifest.artifact.exactCandidateBound !== true ||
      typeof manifest.artifact.productPayloadVersion !== 'string' ||
      !Number.isSafeInteger(manifest.artifact.productPayloadFileCount) ||
      manifest.artifact.productPayloadFileCount < 1) {
    throw new Error('invalid I4 handoff artifact binding')
  }

  exactKeys(manifest.constraints, [
    'entryCount', 'extraEntryCount', 'nodeRuntimeIncluded', 'repositoryTreeIncluded'
  ], 'constraints')
  if (manifest.constraints.entryCount !== 6 || manifest.constraints.extraEntryCount !== 0 ||
      manifest.constraints.nodeRuntimeIncluded !== false ||
      manifest.constraints.repositoryTreeIncluded !== false) {
    throw new Error('I4 handoff constraints are not closed')
  }

  exactKeys(manifest.privacy, [
    'capturedAudioFileCount', 'capturedOrReportTranscriptTextIncluded',
    'containsAbsolutePath', 'containsDeviceName', 'fixedSyntheticLegacyFixtureIncluded',
    'fixedSyntheticLegacyFixtureSha256'
  ], 'privacy')
  requireSha256(manifest.privacy.fixedSyntheticLegacyFixtureSha256,
    'privacy.fixedSyntheticLegacyFixtureSha256')
  if (manifest.privacy.capturedAudioFileCount !== 0 ||
      manifest.privacy.capturedOrReportTranscriptTextIncluded !== false ||
      manifest.privacy.containsAbsolutePath !== false || manifest.privacy.containsDeviceName !== false ||
      manifest.privacy.fixedSyntheticLegacyFixtureIncluded !== true ||
      manifest.privacy.fixedSyntheticLegacyFixtureSha256 !== EXPECTED_LEGACY_FIXTURE_SHA256) {
    throw new Error('I4 handoff violates the SEM-F14 privacy boundary')
  }
  if (JSON.stringify(manifest.limitations) !== JSON.stringify(EXPECTED_LIMITATIONS)) {
    throw new Error('I4 handoff limitations are incomplete')
  }
  if (!Array.isArray(manifest.files) || manifest.files.length !== 6) {
    throw new Error('I4 handoff must bind exactly six payload files')
  }

  const expectedRoles = { ...EXPECTED_FIXED_FILES }
  const installerEntries = manifest.files.filter((entry) => entry.role === 'installer')
  if (installerEntries.length !== 1 ||
      !/^installer\/Live-Subtitle-[0-9A-Za-z._-]+-x64\.exe$/.test(installerEntries[0].relativePath)) {
    throw new Error('I4 handoff must contain one versioned x64 installer')
  }
  expectedRoles[installerEntries[0].relativePath] = 'installer'
  const seen = new Set()
  for (const entry of manifest.files) {
    exactKeys(entry, ['bytes', 'relativePath', 'role', 'sha256'], 'files entry')
    if (typeof entry.relativePath !== 'string' || !/^[a-z0-9][a-z0-9._/-]*$/i.test(entry.relativePath) ||
        entry.relativePath.includes('..') || entry.relativePath.includes('\\') ||
        seen.has(entry.relativePath) || expectedRoles[entry.relativePath] !== entry.role ||
        !Number.isSafeInteger(entry.bytes) || entry.bytes < 1) {
      throw new Error('I4 handoff file entry is unsafe or unexpected')
    }
    requireSha256(entry.sha256, `files.${entry.relativePath}.sha256`)
    seen.add(entry.relativePath)
  }
  if (seen.size !== Object.keys(expectedRoles).length ||
      Object.keys(expectedRoles).some((relativePath) => !seen.has(relativePath))) {
    throw new Error('I4 handoff file allowlist is incomplete')
  }

  exactKeys(fileEvidence.files, [...seen, 'handoff-manifest.json'], 'handoff directory files')
  for (const entry of manifest.files) {
    const evidence = fileEvidence.files[entry.relativePath]
    exactKeys(evidence,
      entry.relativePath === 'evidence/b5-packaged-layout-results.json'
        ? ['bytes', 'json', 'sha256']
        : ['bytes', 'sha256'],
      `file evidence ${entry.relativePath}`)
    if (evidence.bytes !== entry.bytes || evidence.sha256 !== entry.sha256) {
      throw new Error(`I4 handoff file differs from manifest: ${entry.relativePath}`)
    }
  }
  const layout = fileEvidence.files['evidence/b5-packaged-layout-results.json'].json
  const fixture = fileEvidence.files['fixtures/i4-nonaudio-legacy-session.jsonl']
  if (!layout || layout.artifact.installerSha256 !== manifest.artifact.installerSha256 ||
      installerEntries[0].sha256 !== manifest.artifact.installerSha256 ||
      fileEvidence.files['evidence/b5-packaged-layout-results.json'].sha256 !==
        manifest.artifact.b5LayoutEvidenceSha256 ||
      fixture.sha256 !== EXPECTED_LEGACY_FIXTURE_SHA256 ||
      fixture.sha256 !== manifest.privacy.fixedSyntheticLegacyFixtureSha256 ||
      layout.artifact.productPayloadVersion !== manifest.artifact.productPayloadVersion ||
      layout.artifact.productPayloadFileCount !== manifest.artifact.productPayloadFileCount ||
      layout.artifact.productPayloadSha256 !== manifest.artifact.productPayloadSha256) {
    throw new Error('I4 handoff candidate differs from its B5 layout')
  }
  return manifest
}

function collectHandoffFileEvidence (bundleRoot) {
  const root = path.resolve(bundleRoot)
  const files = {}
  function walk (directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name)
      const stats = fs.lstatSync(fullPath)
      if (stats.isSymbolicLink()) throw new Error('I4 handoff cannot contain symbolic links')
      if (entry.isDirectory()) {
        walk(fullPath)
      } else if (entry.isFile()) {
        const relativePath = path.relative(root, fullPath).split(path.sep).join('/')
        const bytes = fs.readFileSync(fullPath)
        files[relativePath] = { bytes: bytes.length, sha256: sha256Bytes(bytes) }
        if (relativePath === 'evidence/b5-packaged-layout-results.json') {
          files[relativePath].json = parseStrictEvidenceJson(bytes, 'handoff B5 layout')
        }
      } else {
        throw new Error('I4 handoff can contain only files and directories')
      }
    }
  }
  walk(root)
  const forbidden = Object.keys(files).some((relativePath) =>
    /(^|\/)(?:\.git|node_modules)(?:\/|$)/i.test(relativePath) ||
    /(^|\/)(?:node|npm|npx)(?:\.exe|\.cmd)?$/i.test(relativePath) ||
    /(^|\/)(?:AGENTS\.md|CONTEXT\.md|package(?:-lock)?\.json)$/i.test(relativePath))
  if (forbidden) throw new Error('I4 handoff contains a repository or Node runtime entry')
  return { files }
}

function readAndValidateI4Handoff (bundleRoot) {
  const root = path.resolve(bundleRoot)
  const fileEvidence = collectHandoffFileEvidence(root)
  const manifestBytes = fs.readFileSync(path.join(root, 'handoff-manifest.json'))
  const manifest = parseStrictEvidenceJson(manifestBytes, 'I4 handoff manifest')
  validateI4HandoffManifest(manifest, fileEvidence)
  return Object.freeze({ manifest, sha256: sha256Bytes(manifestBytes) })
}

if (require.main === module) {
  const [bundleRoot] = process.argv.slice(2)
  if (!bundleRoot || process.argv.length !== 3) {
    throw new Error('usage: node scripts/verify-i4-clean-machine-handoff.js <bundle-root>')
  }
  const evidence = readAndValidateI4Handoff(bundleRoot)
  process.stdout.write(JSON.stringify({
    result: evidence.manifest.result,
    manifestSha256: evidence.sha256,
    entryCount: evidence.manifest.constraints.entryCount
  }) + '\n')
}

module.exports = {
  EXPECTED_FIXED_FILES,
  EXPECTED_LEGACY_FIXTURE_SHA256,
  EXPECTED_LIMITATIONS,
  collectHandoffFileEvidence,
  readAndValidateI4Handoff,
  sha256Bytes,
  validateI4HandoffManifest
}
