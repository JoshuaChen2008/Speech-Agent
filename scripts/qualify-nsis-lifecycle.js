'use strict'

// @ts-check

/* Deterministic NSIS mechanics gate. It installs the exact candidate into an
   isolated workspace directory and invokes only the uninstaller created in
   that directory. An unrelated sentinel under isolated APPDATA proves only
   that this uninstaller leaves unrelated profile data alone. The application
   is not launched and its real userData path is not observed, so this cannot
   prove application-data preservation or replace the clean-machine I4 journey. */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')

function isWithin (parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative !== '' && relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

function parseArguments (argv, cwd = process.cwd()) {
  const values = { installer: null, artifactsRoot: null, report: null }
  const seen = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    if (!['--installer', '--artifacts-root', '--report'].includes(flag) ||
        seen.has(flag) || index + 1 >= argv.length) {
      throw new Error('invalid NSIS qualification arguments')
    }
    seen.add(flag)
    values[flag === '--artifacts-root' ? 'artifactsRoot' : flag.slice(2)] = String(argv[++index])
  }
  if (!values.installer || !values.artifactsRoot || !values.report) {
    throw new Error('--installer, --artifacts-root and --report are required')
  }
  const workspaceArtifacts = path.join(path.resolve(cwd), '.artifacts')
  const installer = path.resolve(cwd, values.installer)
  const artifactsRoot = path.resolve(cwd, values.artifactsRoot)
  const report = path.resolve(cwd, values.report)
  if (!isWithin(workspaceArtifacts, installer) || !isWithin(workspaceArtifacts, artifactsRoot) ||
      !isWithin(workspaceArtifacts, report) || isWithin(artifactsRoot, installer) ||
      !isWithin(artifactsRoot, report)) {
    throw new Error('NSIS qualification targets must remain in distinct .artifacts paths')
  }
  return { installer, artifactsRoot, report }
}

function sha256File (filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function runExactProcess (executable, args, timeoutMs = 120000, environment = process.env) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new TypeError('NSIS child environment must be an object')
  }
  return new Promise((resolve, reject) => {
    let settled = false
    let timedOut = false
    const child = spawn(executable, args, {
      stdio: 'ignore',
      windowsHide: true,
      shell: false,
      env: environment
    })
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* exact child only */ }
    }, timeoutMs)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (timedOut || signal !== null || code !== 0) {
        reject(new Error('NSIS child did not exit cleanly'))
      } else resolve(code)
    })
  })
}

async function waitUntilAbsent (target, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!fs.existsSync(target)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return !fs.existsSync(target)
}

async function qualifyNsisLifecycle (options) {
  if (process.platform !== 'win32') throw new Error('NSIS qualification requires Windows')
  if (!fs.statSync(options.installer).isFile()) throw new Error('installer is missing')
  if (fs.existsSync(options.artifactsRoot) || fs.existsSync(options.report)) {
    throw new Error('NSIS qualification outputs must not already exist')
  }
  fs.mkdirSync(options.artifactsRoot, { recursive: false })
  const installDirectory = path.join(options.artifactsRoot, 'installed application')
  const roamingAppData = path.join(options.artifactsRoot, 'isolated-profile', 'Roaming')
  const localAppData = path.join(options.artifactsRoot, 'isolated-profile', 'Local')
  const preservationProbeDirectory = path.join(roamingAppData, 'nsis-unrelated-preservation-probe')
  const preservationSentinel = path.join(preservationProbeDirectory, 'sentinel.json')
  fs.mkdirSync(preservationProbeDirectory, { recursive: true })
  fs.mkdirSync(localAppData, { recursive: true })
  fs.writeFileSync(preservationSentinel, '{"kind":"nsis-unrelated-appdata-preservation-probe"}\n', {
    encoding: 'utf8',
    flag: 'wx'
  })
  const preservationSentinelSha256 = sha256File(preservationSentinel)
  const isolatedEnvironment = {
    ...process.env,
    APPDATA: roamingAppData,
    LOCALAPPDATA: localAppData
  }
  const installerSha256 = sha256File(options.installer)

  await runExactProcess(options.installer, ['/S', `/D=${installDirectory}`], 120000, isolatedEnvironment)
  const application = path.join(installDirectory, 'LiveSubtitle.exe')
  const uninstaller = path.join(installDirectory, 'Uninstall LiveSubtitle.exe')
  if (!fs.statSync(application).isFile() || !fs.statSync(uninstaller).isFile()) {
    throw new Error('NSIS install tree is incomplete')
  }
  await runExactProcess(uninstaller, ['/S'], 120000, isolatedEnvironment)
  if (!await waitUntilAbsent(installDirectory)) {
    throw new Error('NSIS uninstaller did not remove the isolated install directory')
  }
  const preservationSentinelUnchanged = fs.statSync(preservationSentinel, { throwIfNoEntry: false })?.isFile() === true &&
    sha256File(preservationSentinel) === preservationSentinelSha256
  if (!preservationSentinelUnchanged) {
    throw new Error('NSIS uninstaller removed or changed the unrelated isolated APPDATA probe')
  }

  const report = {
    schemaVersion: 2,
    kind: 'nsis-lifecycle-qualification',
    generatedAt: new Date().toISOString(),
    result: 'pass',
    gateStatus: 'packaged-ci-qualified',
    artifact: {
      installerSha256,
      target: 'nsis',
      arch: 'x64'
    },
    lifecycle: {
      perUserSilentInstall: true,
      customIsolatedInstallDirectory: true,
      installedApplicationPresent: true,
      generatedUninstallerPresent: true,
      exactUninstallerExitZero: true,
      installDirectoryRemoved: true,
      applicationLaunched: false
    },
    dataPolicy: {
      configuredToPreserveUserData: true,
      isolatedAppDataEnvironment: true,
      preservationProbeKind: 'unrelated-isolated-appdata-sentinel',
      preservationProbeOwnedByApplication: false,
      preservationProbeUnchanged: preservationSentinelUnchanged,
      applicationUserDataPathObserved: false,
      applicationUserDataWriteExercised: false
    },
    limitations: [
      'silent-installer-mechanics-only',
      'application-not-launched',
      'application-userdata-path-not-observed',
      'application-userdata-write-not-exercised',
      'not-clean-machine-i4'
    ]
  }
  await fsp.writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  return report
}

function validateNsisLifecycleReport (report, installerSha256 = null) {
  if (!report || report.schemaVersion !== 2 || report.kind !== 'nsis-lifecycle-qualification' ||
      report.result !== 'pass' || report.gateStatus !== 'packaged-ci-qualified' ||
      !/^[a-f0-9]{64}$/.test(String(report.artifact?.installerSha256 || '')) ||
      (installerSha256 !== null && report.artifact.installerSha256 !== installerSha256) ||
      report.artifact?.target !== 'nsis' || report.artifact?.arch !== 'x64' ||
      report.lifecycle?.perUserSilentInstall !== true ||
      report.lifecycle?.customIsolatedInstallDirectory !== true ||
      report.lifecycle?.installedApplicationPresent !== true ||
      report.lifecycle?.generatedUninstallerPresent !== true ||
      report.lifecycle?.exactUninstallerExitZero !== true ||
      report.lifecycle?.installDirectoryRemoved !== true ||
      report.lifecycle?.applicationLaunched !== false ||
      report.dataPolicy?.configuredToPreserveUserData !== true ||
      report.dataPolicy?.isolatedAppDataEnvironment !== true ||
      report.dataPolicy?.preservationProbeKind !== 'unrelated-isolated-appdata-sentinel' ||
      report.dataPolicy?.preservationProbeOwnedByApplication !== false ||
      report.dataPolicy?.preservationProbeUnchanged !== true ||
      report.dataPolicy?.applicationUserDataPathObserved !== false ||
      report.dataPolicy?.applicationUserDataWriteExercised !== false ||
      !report.limitations?.includes('application-userdata-path-not-observed') ||
      !report.limitations?.includes('application-userdata-write-not-exercised') ||
      !report.limitations?.includes('not-clean-machine-i4')) {
    throw new Error('invalid NSIS lifecycle qualification report')
  }
  const serialized = JSON.stringify(report)
  if (/[A-Za-z]:[\\/]/.test(serialized) || /file:\/\//i.test(serialized) ||
      /\.(?:wav|pcm|mp3|m4a|aac|flac|ogg|opus|webm)(?:$|[?#])/i.test(serialized)) {
    throw new Error('NSIS lifecycle report leaked a local address or audio reference')
  }
  return report
}

if (require.main === module) {
  const options = parseArguments(process.argv.slice(2))
  qualifyNsisLifecycle(options).then((report) => {
    validateNsisLifecycleReport(report)
    process.stdout.write(JSON.stringify({
      result: report.result,
      target: report.artifact.target,
      installed: report.lifecycle.perUserSilentInstall,
      uninstalled: report.lifecycle.installDirectoryRemoved,
      unrelatedAppDataProbePreserved: report.dataPolicy.preservationProbeUnchanged
    }) + '\n')
  }).catch(() => {
    process.stderr.write('NSIS lifecycle qualification failed.\n')
    process.exitCode = 1
  })
}

module.exports = {
  parseArguments,
  qualifyNsisLifecycle,
  runExactProcess,
  validateNsisLifecycleReport,
  waitUntilAbsent
}
