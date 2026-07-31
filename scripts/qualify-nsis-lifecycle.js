'use strict'

// @ts-check

/* Deterministic NSIS mechanics gate. It installs the exact candidate into an
   isolated workspace directory and invokes only the uninstaller created in
   that directory. It does not launch the application or touch userData, so
   it cannot replace the clean-machine I4 journey. */

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

function runExactProcess (executable, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    let settled = false
    let timedOut = false
    const child = spawn(executable, args, {
      stdio: 'ignore',
      windowsHide: true,
      shell: false
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
  const installerSha256 = sha256File(options.installer)

  await runExactProcess(options.installer, ['/S', `/D=${installDirectory}`])
  const application = path.join(installDirectory, 'LiveSubtitle.exe')
  const uninstaller = path.join(installDirectory, 'Uninstall LiveSubtitle.exe')
  if (!fs.statSync(application).isFile() || !fs.statSync(uninstaller).isFile()) {
    throw new Error('NSIS install tree is incomplete')
  }
  await runExactProcess(uninstaller, ['/S'])
  if (!await waitUntilAbsent(installDirectory)) {
    throw new Error('NSIS uninstaller did not remove the isolated install directory')
  }

  const report = {
    schemaVersion: 1,
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
      userDataTouchedByQualification: false,
      userDataPreservationRuntimeVerified: false
    },
    limitations: [
      'silent-installer-mechanics-only',
      'application-not-launched',
      'not-clean-machine-i4'
    ]
  }
  await fsp.writeFile(options.report, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' })
  return report
}

function validateNsisLifecycleReport (report, installerSha256 = null) {
  if (!report || report.schemaVersion !== 1 || report.kind !== 'nsis-lifecycle-qualification' ||
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
      report.dataPolicy?.userDataTouchedByQualification !== false ||
      report.dataPolicy?.userDataPreservationRuntimeVerified !== false ||
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
      userDataTouched: report.dataPolicy.userDataTouchedByQualification
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
