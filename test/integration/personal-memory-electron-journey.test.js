'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const electron = require('electron')
const project = path.resolve(__dirname, '../..')
const packagedDirectory = process.env.PERSONAL_MEMORY_PACKAGE_DIR ? path.resolve(process.env.PERSONAL_MEMORY_PACKAGE_DIR) : null
function phase (directory, name) {
  return new Promise((resolve, reject) => {
    const executable = packagedDirectory ? path.join(packagedDirectory, 'LiveSubtitlePackagedSmoke.exe') : electron
    const args = ['--disable-gpu', '--disable-gpu-compositing', '--disable-software-rasterizer', '--in-process-gpu', '--password-store=basic']
    if (!packagedDirectory) args.push(path.join(project, 'scripts/fixtures/personal-memory-electron-journey.js'))
    const child = spawn(executable, args, { cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MEMORY_FILES_USER_DATA: directory, MEMORY_FILES_PHASE: name } })
    let stdout = ''; let stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('memory files Electron deadline')) }, 45000)
    child.stdout.on('data', chunk => { stdout += chunk.toString() }); child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.once('error', reject)
    child.once('exit', (code, signal) => { clearTimeout(timer); if (code !== 0 || signal) return reject(new Error(stderr.slice(-2500))); const line = stdout.split(/\r?\n/).find(line => line.startsWith('{"schemaVersion":1,"kind":"personal-memory-electron-journey"')); if (!line) return reject(new Error('memory files report missing')); const report = JSON.parse(line); if (!report.result) return reject(new Error(line + '\n' + stderr.slice(-2000))); resolve(report) })
  })
}
test('SEM-F41/J21/J28-FILES/DB7: production Electron settings clicks write, edit, confirm, choose, export and restore MD memory', { skip: process.platform !== 'win32', timeout: 100000 }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-memory-electron-'))
  try {
    for (const name of ['write', 'restart']) {
      const report = await phase(directory, name)
      assert.equal(report.result, true, JSON.stringify(report)); assert.equal(report.storageUtilityObserved, true)
      assert.equal(/合成正文|[A-Z]:[\\/]/.test(JSON.stringify(report)), false)
      if (packagedDirectory) {
        const evidence = { ...report, packageVariant: 'memory-files-test',
          asarSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(packagedDirectory, 'resources/app.asar'))).digest('hex'),
          executableSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(packagedDirectory, 'LiveSubtitlePackagedSmoke.exe'))).digest('hex') }
        fs.mkdirSync(path.join(project, '.artifacts'), { recursive: true })
        fs.writeFileSync(path.join(project, `.artifacts/memory-packaged-${name}.json`), JSON.stringify(evidence) + '\n')
      }
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
})
