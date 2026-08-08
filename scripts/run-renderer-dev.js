'use strict'

const path = require('node:path')
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const ORIGIN = 'http://127.0.0.1:5173'
const viteCli = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
const supervisor = path.join(ROOT, 'scripts', 'run-supervised-electron.js')

let viteChild = null
let electronChild = null
let closing = false

function stopChild (child) {
  if (child && child.exitCode === null && child.signalCode === null) child.kill()
}

function closeChildren () {
  if (closing) return
  closing = true
  stopChild(electronChild)
  stopChild(viteChild)
}

async function waitForVite () {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if (viteChild && viteChild.exitCode !== null) throw new Error('Vite exited before becoming ready')
    try {
      const response = await fetch(`${ORIGIN}/caption/index.html`, {
        signal: AbortSignal.timeout(750)
      })
      if (response.ok) return
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('Vite did not become ready within 15 seconds')
}

async function main () {
  viteChild = spawn(process.execPath, [viteCli, '--host', '127.0.0.1', '--port', '5173'], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true
  })
  await waitForVite()

  electronChild = spawn(process.execPath, [supervisor, '--entry', '.'], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, LIVE_SUBTITLE_RENDERER_URL: ORIGIN }
  })

  const exitCode = await new Promise((resolve, reject) => {
    electronChild.once('error', reject)
    electronChild.once('exit', (code, signal) => {
      if (signal) reject(new Error(`Electron supervisor exited by signal ${signal}`))
      else resolve(code === null ? 1 : code)
    })
    viteChild.once('exit', (code) => {
      if (!closing) reject(new Error(`Vite exited while Electron was running (${code ?? 1})`))
    })
  })
  closeChildren()
  process.exitCode = exitCode
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    closeChildren()
    process.exitCode = 130
  })
}

main().catch((error) => {
  closeChildren()
  console.error(`[renderer.dev] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
