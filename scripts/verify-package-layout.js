'use strict'

// @ts-check

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawnSync } = require('node:child_process')
const asar = require('@electron/asar')
const {
  IDENTITY_VERSION,
  hashProductPayloadEntries
} = require('../src/main/services/product-payload-identity')
const {
  RUN_ID_PATTERN,
  readAndValidatePackagedRunBindingReport
} = require('./verify-packaged-run-binding')

const REQUIRED_ASAR_ENTRIES = Object.freeze([
  '/package.json',
  '/src/main.js',
  '/src/preload/caption.js',
  '/src/preload/toolbar.js',
  '/src/preload/settings.js',
  '/src/preload/history.js',
  '/src/preload/shared.js',
  '/src/caption/index.html',
  '/src/caption/caption.ts',
  '/src/caption/caption.css',
  '/src/toolbar/index.html',
  '/src/toolbar/toolbar.ts',
  '/src/toolbar/toolbar.css',
  '/src/settings/settings.html',
  '/src/settings/settings-view.tsx',
  '/src/settings/settings.css',
  '/src/history/index.html',
  '/src/history/history-view.tsx',
  '/src/history/history.css',
  '/src/runtime/audio-host/preload.js',
  '/src/runtime/audio-host/host.html',
  '/src/runtime/audio-host/host.js',
  '/src/runtime/audio-host/frame-flow.js',
  '/src/runtime/audio-host/capture-worklet.mjs',
  '/src/runtime/audio-host/streaming-resampler.mjs',
  '/src/runtime/audio-host/frame-assembler.mjs',
  '/src/runtime/realtime-worker/realtime-worker.js',
  '/src/runtime/refine-worker/refine-worker.js',
  '/src/runtime/storage-worker/storage-worker.js'
])
const REQUIRED_NATIVE_FILES = Object.freeze([
  'sherpa-onnx.node',
  'onnxruntime.dll',
  'onnxruntime_providers_shared.dll',
  'sherpa-onnx-c-api.dll',
  'sherpa-onnx-cxx-api.dll'
])
const SMOKE_SCRIPTS = Object.freeze([
  '/scripts/product-shell-smoke.js',
  '/scripts/model-ui-fixture-support.js',
  '/scripts/packaged-native-load-probe.js'
])
const SUPPORTED_ELECTRON_VERSIONS = new Set(['43.2.0', '43.3.0'])

function parseArguments (argv) {
  const values = {
    packageDir: null,
    variant: null,
    report: null,
    installer: null,
    qualificationBinding: null
  }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!['--package-dir', '--variant', '--report', '--installer', '--qualification-binding'].includes(flag) ||
        seen.has(flag) || index + 1 >= argv.length) {
      throw new Error('invalid package layout arguments')
    }
    seen.add(flag)
    const value = String(argv[++index])
    if (flag === '--package-dir') values.packageDir = value
    if (flag === '--variant') values.variant = value
    if (flag === '--report') values.report = value
    if (flag === '--installer') values.installer = value
    if (flag === '--qualification-binding') values.qualificationBinding = value
  }
  if (!values.packageDir || !values.report || !['release', 'smoke'].includes(values.variant)) {
    throw new Error('--package-dir, --variant release|smoke and --report are required')
  }
  if (values.variant === 'release' && !values.qualificationBinding) {
    throw new Error('release layout requires --qualification-binding')
  }
  if (values.variant === 'smoke' && values.qualificationBinding) {
    throw new Error('smoke layout cannot claim a release qualification binding')
  }
  return values
}

function sha256File (filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function hasExactKeys (value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index])
}

function peMachine (filePath) {
  const descriptor = fs.openSync(filePath, 'r')
  try {
    const dos = Buffer.alloc(64)
    if (fs.readSync(descriptor, dos, 0, dos.length, 0) !== dos.length || dos.toString('ascii', 0, 2) !== 'MZ') {
      throw new Error('packaged executable has no DOS header')
    }
    const peOffset = dos.readUInt32LE(0x3c)
    const header = Buffer.alloc(6)
    if (fs.readSync(descriptor, header, 0, header.length, peOffset) !== header.length ||
        header.toString('ascii', 0, 4) !== 'PE\u0000\u0000') {
      throw new Error('packaged executable has no PE header')
    }
    return header.readUInt16LE(4) === 0x8664 ? 'x64' : 'other'
  } finally {
    fs.closeSync(descriptor)
  }
}

function authenticodeStatus (filePath) {
  if (process.platform !== 'win32') return 'not-assessed'
  const systemRoot = process.env.SystemRoot || 'C:\\Windows'
  const powershell = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  )
  const result = spawnSync(powershell, [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    '(Get-AuthenticodeSignature -LiteralPath $env:B5_INSTALLER_PATH).Status.ToString()'
  ], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, B5_INSTALLER_PATH: filePath }
  })
  if (result.status !== 0) throw new Error('Authenticode inspection failed')
  const value = String(result.stdout || '').trim()
  if (value === 'Valid') return 'valid'
  if (value === 'NotSigned') return 'not-signed'
  return 'invalid'
}

function isTopLevelForbidden (entry, variant) {
  const normalized = entry.replace(/\\/g, '/')
  if (/^\/(?:models|model|test|docs|\.artifacts)(?:\/|$)/i.test(normalized)) return true
  if (/^\/src\/(?:agent-core|agent-mvp)(?:\/|$)/i.test(normalized)) return true
  if (/^\/node_modules\/@earendil-works\/(?:pi-agent-core|pi-ai)(?:\/|$)/i.test(normalized)) return true
  if (variant === 'release' && /^\/scripts(?:\/|$)/i.test(normalized)) return true
  if (variant === 'smoke' && /^\/scripts\//i.test(normalized) && !SMOKE_SCRIPTS.includes(normalized)) return true
  return false
}

function diskEntriesUnder (root) {
  const found = []
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name)
      const relative = path.relative(root, target).replace(/\\/g, '/')
      found.push(relative)
      if (entry.isDirectory()) visit(target)
    }
  }
  visit(root)
  return found
}

function inspectPackageLayout (options) {
  const packageDir = path.resolve(options.packageDir)
  const asarPath = path.join(packageDir, 'resources', 'app.asar')
  if (!fs.statSync(packageDir).isDirectory() || !fs.statSync(asarPath).isFile()) {
    throw new Error('packaged app.asar is missing')
  }
  const entries = asar.listPackage(asarPath).map((entry) => entry.replace(/\\/g, '/'))
  const productPayload = hashProductPayloadEntries(entries
    .filter((entry) => entry.startsWith('/src/'))
    .filter((entry) => !asar.statFile(asarPath, entry.slice(1).replace(/\//g, path.sep)).files)
    .map((entry) => ({
      name: entry.slice(1),
      bytes: asar.extractFile(asarPath, entry.slice(1).replace(/\//g, path.sep))
    })))
  const packagedMetadata = JSON.parse(asar.extractFile(asarPath, 'package.json').toString('utf8'))
  const expectedMain = options.variant === 'release'
    ? 'src/main.js'
    : 'scripts/product-shell-smoke.js'
  if (packagedMetadata.main !== expectedMain || packagedMetadata.version !== '0.1.0') {
    throw new Error('packaged metadata has the wrong main entry or version')
  }
  const expected = options.variant === 'smoke'
    ? [...REQUIRED_ASAR_ENTRIES, ...SMOKE_SCRIPTS]
    : [...REQUIRED_ASAR_ENTRIES]
  if (expected.some((entry) => !entries.includes(entry))) {
    throw new Error('packaged app.asar is missing a required product entry')
  }
  if (entries.some((entry) => isTopLevelForbidden(entry, options.variant))) {
    throw new Error('packaged app.asar contains a forbidden development tree')
  }
  if (entries.some((entry) => /\.(?:onnx|wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)$/i.test(entry))) {
    throw new Error('packaged app.asar contains a model tensor or audio payload')
  }
  const diskEntries = diskEntriesUnder(packageDir)
  if (diskEntries.some((entry) =>
    /^(?:resources\/)?(?:models?|test|docs|\.artifacts)(?:\/|$)/i.test(entry) ||
    /\.(?:onnx|wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)$/i.test(entry))) {
    throw new Error('packaged directory contains an external model, development tree or audio payload')
  }

  const nativePrefix = '/node_modules/sherpa-onnx-win-x64/'
  const nativeRoot = path.join(
    packageDir,
    'resources',
    'app.asar.unpacked',
    'node_modules',
    'sherpa-onnx-win-x64'
  )
  for (const name of REQUIRED_NATIVE_FILES) {
    const entry = `${nativePrefix}${name}`
    const archiveEntry = path.join('node_modules', 'sherpa-onnx-win-x64', name)
    if (!entries.includes(entry) || asar.statFile(asarPath, archiveEntry).unpacked !== true ||
        !fs.statSync(path.join(nativeRoot, name)).isFile()) {
      throw new Error('a required native binary is not unpacked beside the addon')
    }
  }

  let installerSha256 = null
  let signingStatus = 'not-assessed'
  if (options.installer) {
    const installer = path.resolve(options.installer)
    if (!fs.statSync(installer).isFile()) throw new Error('NSIS installer is missing')
    installerSha256 = sha256File(installer)
    signingStatus = authenticodeStatus(installer)
  }
  if (options.variant === 'release' && installerSha256 === null) {
    throw new Error('release layout qualification requires the exact NSIS installer')
  }
  let evidenceBinding = null
  if (options.variant === 'release') {
    const bindingPath = path.resolve(options.qualificationBinding)
    const binding = readAndValidatePackagedRunBindingReport(bindingPath)
    if (binding.run.productPayloadVersion !== productPayload.version ||
        binding.run.productPayloadFileCount !== productPayload.fileCount ||
        binding.run.productPayloadSha256 !== productPayload.sha256) {
      throw new Error('release product payload differs from the exercised packaged runtime')
    }
    evidenceBinding = {
      runId: binding.run.runId,
      bindingReportSha256: sha256File(bindingPath),
      testExecutableSha256: binding.run.testExecutableSha256,
      freshProductReportSha256: binding.fresh.productReportSha256,
      freshExitReportSha256: binding.fresh.exitReportSha256,
      restartProductReportSha256: binding.restart.productReportSha256,
      restartExitReportSha256: binding.restart.exitReportSha256
    }
  }
  const appExecutable = path.join(
    packageDir,
    options.variant === 'release' ? 'LiveSubtitle.exe' : 'LiveSubtitlePackagedSmoke.exe'
  )
  if (!fs.statSync(appExecutable).isFile() || peMachine(appExecutable) !== 'x64') {
    throw new Error('packaged application executable is not x64')
  }

  return {
    schemaVersion: 2,
    kind: 'packaged-layout-qualification',
    generatedAt: new Date().toISOString(),
    result: 'pass',
    gateStatus: 'packaged-ci-qualified',
    artifact: {
      variant: options.variant,
      arch: 'x64',
      appVersion: packagedMetadata.version,
      electronVersion: require('electron/package.json').version,
      builderVersion: require('electron-builder/package.json').version,
      sherpaWrapperVersion: JSON.parse(asar.extractFile(
        asarPath,
        path.join('node_modules', 'sherpa-onnx-node', 'package.json')
      ).toString('utf8')).version,
      sherpaPlatformVersion: JSON.parse(asar.extractFile(
        asarPath,
        path.join('node_modules', 'sherpa-onnx-win-x64', 'package.json')
      ).toString('utf8')).version,
      mainEntry: packagedMetadata.main,
      appExecutableX64: true,
      appAsarPresent: true,
      appExecutableSha256: sha256File(appExecutable),
      appAsarSha256: sha256File(asarPath),
      asarEntryCount: entries.length,
      productPayloadVersion: productPayload.version,
      productPayloadFileCount: productPayload.fileCount,
      productPayloadSha256: productPayload.sha256,
      installerPresent: installerSha256 !== null,
      installerSha256,
      signingStatus
    },
    layout: {
      requiredProductEntryCount: REQUIRED_ASAR_ENTRIES.length,
      requiredProductEntriesPresent: true,
      forbiddenDevelopmentTreesAbsent: true,
      modelTensorsBundled: false,
      audioPayloadsBundled: false
    },
    native: {
      requiredBinaryCount: REQUIRED_NATIVE_FILES.length,
      unpackedBinaryCount: REQUIRED_NATIVE_FILES.length,
      allMarkedUnpacked: true
    },
    evidenceBinding,
    limitations: options.variant === 'release'
      ? [signingStatus === 'valid' ? 'signing-valid-not-smartscreen-qualified' : 'unsigned-installer', 'not-installed-clean-machine-i4']
      : ['test-only-main-entry', 'win-unpacked-not-nsis-installed', 'not-clean-machine-i4']
  }
}

function validatePackageLayoutReport (report, expectedVariant) {
  if (!report || report.schemaVersion !== 2 || report.kind !== 'packaged-layout-qualification' ||
      report.result !== 'pass' || report.gateStatus !== 'packaged-ci-qualified' ||
      report.artifact?.variant !== expectedVariant || report.artifact?.arch !== 'x64' ||
      report.artifact?.appVersion !== '0.1.0' ||
      !SUPPORTED_ELECTRON_VERSIONS.has(report.artifact?.electronVersion) ||
      report.artifact?.builderVersion !== '26.15.3' ||
      report.artifact?.sherpaWrapperVersion !== '1.13.4' ||
      report.artifact?.sherpaPlatformVersion !== '1.13.4' ||
      report.artifact?.mainEntry !== (expectedVariant === 'release' ? 'src/main.js' : 'scripts/product-shell-smoke.js') ||
      report.artifact?.appExecutableX64 !== true ||
      report.artifact?.appAsarPresent !== true ||
      !/^[a-f0-9]{64}$/.test(String(report.artifact?.appExecutableSha256 || '')) ||
      !/^[a-f0-9]{64}$/.test(String(report.artifact?.appAsarSha256 || '')) ||
      !Number.isSafeInteger(report.artifact?.asarEntryCount) || report.artifact.asarEntryCount < 1 ||
      report.artifact?.productPayloadVersion !== IDENTITY_VERSION ||
      !Number.isSafeInteger(report.artifact?.productPayloadFileCount) ||
      report.artifact.productPayloadFileCount < 1 ||
      !/^[a-f0-9]{64}$/.test(String(report.artifact?.productPayloadSha256 || '')) ||
      report.layout?.requiredProductEntryCount !== REQUIRED_ASAR_ENTRIES.length ||
      report.layout?.requiredProductEntriesPresent !== true ||
      report.layout?.forbiddenDevelopmentTreesAbsent !== true ||
      report.layout?.modelTensorsBundled !== false || report.layout?.audioPayloadsBundled !== false ||
      report.native?.requiredBinaryCount !== REQUIRED_NATIVE_FILES.length ||
      report.native?.unpackedBinaryCount !== REQUIRED_NATIVE_FILES.length ||
      report.native?.allMarkedUnpacked !== true) {
    throw new Error('invalid packaged layout qualification report')
  }
  if (expectedVariant === 'release') {
    if (report.artifact.installerPresent !== true ||
        !/^[a-f0-9]{64}$/.test(String(report.artifact.installerSha256 || '')) ||
        !['valid', 'not-signed'].includes(report.artifact.signingStatus) ||
        !hasExactKeys(report.evidenceBinding, [
          'runId', 'bindingReportSha256', 'testExecutableSha256',
          'freshProductReportSha256', 'freshExitReportSha256',
          'restartProductReportSha256', 'restartExitReportSha256'
        ]) ||
        !RUN_ID_PATTERN.test(String(report.evidenceBinding.runId || '')) ||
        ['bindingReportSha256', 'testExecutableSha256', 'freshProductReportSha256',
          'freshExitReportSha256', 'restartProductReportSha256', 'restartExitReportSha256']
          .some((key) => !/^[a-f0-9]{64}$/.test(String(report.evidenceBinding[key] || ''))) ||
        !report.limitations?.includes('not-installed-clean-machine-i4')) {
      throw new Error('release layout report is not bound to an installer or overclaims I4')
    }
  } else if (report.artifact.installerPresent !== false || report.artifact.installerSha256 !== null ||
      report.artifact.signingStatus !== 'not-assessed' ||
      report.evidenceBinding !== null ||
      !report.limitations?.includes('test-only-main-entry')) {
    throw new Error('smoke layout report overclaims the release package')
  }
  const serialized = JSON.stringify(report)
  if (/[A-Za-z]:[\\/]/.test(serialized) || /file:\/\//i.test(serialized) ||
      /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)(?:$|[?#])/i.test(serialized)) {
    throw new Error('packaged layout report leaked a local address or audio reference')
  }
  return report
}

function writeReport (reportPath, report) {
  const target = path.resolve(reportPath)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
}

if (require.main === module) {
  const options = parseArguments(process.argv.slice(2))
  const report = validatePackageLayoutReport(inspectPackageLayout(options), options.variant)
  writeReport(options.report, report)
  process.stdout.write(JSON.stringify({
    result: report.result,
    variant: report.artifact.variant,
    entries: report.artifact.asarEntryCount,
    nativeBinaries: report.native.unpackedBinaryCount,
    installerPresent: report.artifact.installerPresent
  }) + '\n')
}

module.exports = {
  REQUIRED_ASAR_ENTRIES,
  REQUIRED_NATIVE_FILES,
  SMOKE_SCRIPTS,
  inspectPackageLayout,
  parseArguments,
  validatePackageLayoutReport
}
